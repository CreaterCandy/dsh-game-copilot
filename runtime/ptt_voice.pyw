#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""游戏副驾 · Push-to-Talk 守护（按住说话、松开出结果）。

与旧 hotkey_ask.pyw 的区别：
  * 热键全部从 runtime\config.json 读，可随时改，不写死在代码里。
  * 语音用"按住说话、松开出结果"：轮询按键状态（GetAsyncKeyState），
    按下即开始录音、松开即停止并转写；说多长录多长。
  * 一次性热键（问画面/念剪贴板/退出）仍用 RegisterHotKey，避免轮询全部按键。

实现要点：
  * 用 win32gui 消息循环驱动，PTT 用定时器每 40ms 检查一次按键状态。
  * 录音在独立线程用 sounddevice.InputStream，主线程不阻塞。
  * ASR 模型在首次 PTT 时懒加载并常驻进程，之后转写秒级。
  * 转写出的文字交给 ask.py 的函数：截图 -> 可配置的模型端点 -> 统一 TTS 播报。

启动：双击 start_copilot.cmd（已改为启动本文件），或
      pythonw runtime\ptt_voice.pyw
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import wave
from pathlib import Path

# HuggingFace 国内镜像：模型下载走镜像，直连会超时。
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import win32api
import win32con
import win32gui

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
OUT_DIR = ROOT / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tts"))

# 配置名 -> 虚拟键码。未列出的键给提示，不静默失败。
VK = {
    "oem_3": 0xC0, "capslock": 0x14,
    "xbutton1": 0x03, "xbutton2": 0x04,
    "space": 0x20, "tab": 0x09, "enter": 0x0D,
    "ctrl": 0x11, "alt": 0x12, "shift": 0x10,
    **{c: ord(c.upper()) for c in "abcdefghijklmnopqrstuvwxyz"},
    **{str(n): ord(str(n)) for n in range(10)},
}
MOD_FLAG = {"ctrl": win32con.MOD_CONTROL, "alt": win32con.MOD_ALT, "shift": win32con.MOD_SHIFT}


def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    # 一份配置：设置页改的 hotkeys / tts / memory / shot 落在插件那份
    # (%DSH_HOME%\dsh-game-copilot.json)，本地 config.json 只留机器级参数
    # （录音设备、音效路径、ASR 下载位置）。读插件配置走 memory_store 的 mtime 缓存。
    try:
        import memory_store

        plugin = memory_store.plugin_config()
    except Exception:
        plugin = {}
    for key in ("hotkeys", "tts", "memory", "shot"):
        value = plugin.get(key)
        if isinstance(value, dict):
            cfg[key] = value
    return cfg


CFG = load_config()


def normalize_hotkeys(cfg: dict) -> dict:
    """把设置页的新格式热键转成 hk_vk() 吃的 {modifiers, key}。

    新格式（插件配置 %DSH_HOME%\\dsh-game-copilot.json）：
        hotkeys.ptt = "capslock"
        hotkeys.extra.askScreen = {enabled:true, key:"ctrl+alt+q"}
    旧格式（早期 config.json）：
        hotkeys.ptt_voice = {modifiers:[], key:"capslock"}
    两种都认；新增 enabled=false 时该热键不注册。
    """
    hk = cfg.get("hotkeys") or {}
    if isinstance(hk.get("ptt_voice"), dict):
        return hk  # 老配置原样走，零行为变化

    def parse(spec, default="", enabled=True) -> dict:
        parts = [p.strip().lower() for p in str(spec or default).split("+") if p.strip()]
        mods = [p for p in parts if p in ("ctrl", "alt", "shift")]
        keys = [p for p in parts if p not in mods]
        return {"modifiers": mods, "key": keys[-1] if keys else default, "enabled": enabled}

    mapping = {
        "askScreen": "ask_screen",
        "speakClipboard": "speak_clipboard",
        "exit": "exit",
    }
    extra = hk.get("extra") or {}
    out = {"ptt_voice": parse(hk.get("ptt"), "capslock")}
    for new_name, old_name in mapping.items():
        value = extra.get(new_name)
        if isinstance(value, dict):
            out[old_name] = parse(value.get("key"), hk.get(old_name, {}).get("key", ""), value.get("enabled", True))
        else:
            out[old_name] = parse(value or hk.get(old_name, {}).get("key", ""))
    return out


HK = normalize_hotkeys(CFG)
REC = CFG["recording"]
ASR = CFG["asr"]
FB = CFG.get("feedback", {})
SAMPLE_RATE = int(REC.get("sample_rate", 16000))

# ---- DSH 插件配置（设置页「桌宠参谋」改的那份）----
# 为什么要读它：语音播报/音色/语速/音量/记忆模式这些开关现在统一在 DSH 设置页里改，
# 落盘到 %DSH_HOME%\dsh-game-copilot.json。读取实现放在 memory_store（按 mtime 缓存），
# 这里只做薄封装——好处是**改完下一句话就生效**，不用像以前那样重启播报进程。
import memory_store as _mem  # noqa: E402  （上面已把 ROOT 插进 sys.path）


def plugin_cfg() -> dict:
    """读插件配置（按 mtime 缓存，没变不重读）。"""
    return _mem.plugin_config()


def plugin_tts() -> dict:
    """插件配置里的 tts 段（没有就是一空字典，全部走本地 config.json）。"""
    tts = plugin_cfg().get("tts")
    return tts if isinstance(tts, dict) else {}


def plugin_memory_mode() -> str:
    """记忆模式：off / auto（默认，像追问才翻）/ always。"""
    return _mem.memory_mode()


def apply_plugin_tts(router) -> dict:
    """把设置页的 TTS 设置套到 router 上，返回那份设置。

    `apply_runtime` 内部会比对，值没变就不重建后端——所以这里可以每轮都调。
    """
    p = plugin_tts()
    try:
        router.apply_runtime(
            backend=p.get("backend") or None,
            voice=p.get("voice") or None,
            speed=p.get("speed"),
            volume=p.get("volume"),
        )
    except Exception as e:  # 设置写错不该让整轮问答失败
        print(f"[TTS] 套用设置页参数失败，沿用本地配置：{e!r}", file=sys.stderr)
    return p

# 热键 id
ID_PTT = 0  # PTT 不用 RegisterHotKey，占位便于统一输出
ID_ASK, ID_SPEAK, ID_EXIT = 1, 2, 3


def hk_vk(spec: dict) -> tuple[int, int]:
    """把 {modifiers, key} 转成 (修饰键 win32 位标志, 主键 vk)。"""
    mods = 0
    for m in spec.get("modifiers", []):
        mods |= MOD_FLAG.get(m.lower(), 0)
    key = spec["key"].lower()
    if key not in VK:
        raise ValueError(f"config.json 里的按键 '{spec['key']}' 不认识，见 _可用按键")
    return mods, VK[key]


def key_down(vk: int) -> bool:
    """GetAsyncKeyState 最高位为 1 表示当前按下。"""
    return win32api.GetAsyncKeyState(vk) & 0x8000 != 0


# ---- 一次性热键：注册 ----
_, ASK_VK = hk_vk(HK["ask_screen"])
_, SPEAK_VK = hk_vk(HK["speak_clipboard"])
_, EXIT_VK = hk_vk(HK["exit"])
ASK_MODS, _ = hk_vk(HK["ask_screen"])
SPEAK_MODS, _ = hk_vk(HK["speak_clipboard"])
EXIT_MODS, _ = hk_vk(HK["exit"])

def _register_oneshot_hotkeys() -> None:
    """注册三个一次性热键；**被占用时明确告知并退出**，不再静默闪退。

    2026-11-24 踩坑：旧实例还占着热键时，这里抛
        pywintypes.error: (1409, 'RegisterHotKey', '热键已注册。')
    而 pythonw 没有控制台 → 用户双击 start_copilot.cmd 只看到黑框一闪，
    完全不知道"没启动成功"，还会误以为改了配置却不生效。
    所以这里既写日志，也弹一个短提示框，把"怎么处理"直接说清楚。
    """
    try:
        # enabled=false 的热键整条不注册（设置页三个附加热键各有开关）
        if HK.get("ask_screen", {}).get("enabled", True):
            win32gui.RegisterHotKey(0, ID_ASK, ASK_MODS, ASK_VK)
        if HK.get("speak_clipboard", {}).get("enabled", True):
            win32gui.RegisterHotKey(0, ID_SPEAK, SPEAK_MODS, SPEAK_VK)
        if HK.get("exit", {}).get("enabled", True):
            win32gui.RegisterHotKey(0, ID_EXIT, EXIT_MODS, EXIT_VK)
        return
    except Exception as e:  # noqa: BLE001
        if getattr(e, "winerror", None) != 1409:
            raise
        msg = (
            "AI 副驾启动失败：热键已被占用。\n\n"
            "最常见的情况是旧实例还在后台跑着（它占着 Caps Lock 等热键），\n"
            "所以新实例起不来，改了配置也不会生效。也可能是别的软件占了同一组热键。\n\n"
            "处理办法（任选一种）：\n"
            "  1) 按 Ctrl+Alt+Shift+Q 退出旧实例，再双击 start_copilot.cmd\n"
            "  2) 任务管理器结束 pythonw.exe，再双击 start_copilot.cmd"
        )
        print(msg, file=sys.stderr)
        try:
            log_event("hotkey_conflict", msg="另一个实例已占用热键，本次启动取消")
        except Exception:
            pass
        try:
            win32gui.MessageBox(0, msg, "AI 副驾 · 已在运行", 0x00000030)  # MB_ICONWARNING
        except Exception:
            pass
        raise SystemExit(1)


# 注意：注册动作放在 __main__ 里调用（见文件末尾）。
# 一是不想在 import 时就抢热键（体检/单测会误占），
# 二是 log_event 定义在下面，放顶层调用它时还不存在。

# PTT 修饰键 + 主键
PTT_MODS, PTT_VK = hk_vk(HK["ptt_voice"])
PTT_MOD_KEYS = [MOD_FLAG[m.lower()] for m in HK["ptt_voice"].get("modifiers", [])]


def ptt_down() -> bool:
    """PTT 键（含修饰键）是否正被按住。单键时只查主键。"""
    if win32con.MOD_CONTROL in PTT_MOD_KEYS and not key_down(win32con.VK_CONTROL):
        return False
    if win32con.MOD_ALT in PTT_MOD_KEYS and not key_down(win32con.VK_MENU):
        return False
    if win32con.MOD_SHIFT in PTT_MOD_KEYS and not key_down(win32con.VK_SHIFT):
        return False
    return key_down(PTT_VK)


# ---- Caps Lock 副作用修复：按住说话会翻转大小写锁定，松开后恢复原状 ----
_caps_before = None  # 按下 PTT 前的 Caps Lock 锁定状态


def caps_lock_state() -> bool:
    """Caps Lock 当前是否锁定为大写（toggle 状态，非物理按下状态）。"""
    return bool(win32api.GetKeyState(0x14) & 1)


def restore_caps_lock() -> None:
    """若 PTT 键是 Caps Lock，松开后把大小写状态翻回按下前的样子。"""
    global _caps_before
    if PTT_VK != 0x14 or _caps_before is None:
        return
    try:
        if caps_lock_state() != _caps_before:
            win32api.keybd_event(0x14, 0, 0, 0)
            win32api.keybd_event(0x14, 0, win32con.KEYEVENTF_KEYUP, 0)
    except Exception as e:
        log_event("caps_restore_error", error=repr(e))
    finally:
        _caps_before = None


# ---- 麦克风选择：按名字匹配 + 实测可用性，避免写死索引 ----
_input_device_idx = None  # 缓存解析结果
_mic_resolved = False


def resolve_input_device():
    """返回可用于 16kHz 单声道录音的设备索引；None 表示用系统默认。

    配置 recording.device_name 是名字子串（如你的耳机名）。候选逐个实测能否
    以 SAMPLE_RATE 打开，跳过不支持该采样率的后端（如某些 WASAPI 实例）。
    """
    global _input_device_idx, _mic_resolved
    if _mic_resolved:
        return _input_device_idx
    _mic_resolved = True

    name_spec = REC.get("device_name")
    if not name_spec:
        log_event("mic_selected", device="system-default", reason="no device_name configured")
        return None

    import sounddevice as sd

    needle = str(name_spec).lower()
    candidates = [
        i for i, d in enumerate(sd.query_devices())
        if d.get("max_input_channels", 0) > 0 and needle in d["name"].lower()
    ]
    if not candidates:
        log_event("mic_selected", device="system-default",
                  reason=f"no device matching '{name_spec}'")
        return None

    for idx in candidates:
        try:
            probe = sd.InputStream(
                device=idx, samplerate=SAMPLE_RATE, channels=1, dtype="int16"
            )
            probe.close()
            dname = sd.query_devices()[idx]["name"]
            _input_device_idx = idx
            log_event("mic_selected", device=dname, index=idx)
            return idx
        except Exception:
            continue

    log_event("mic_selected", device="system-default",
              reason=f"matched '{name_spec}' but none supports {SAMPLE_RATE}Hz")
    return None


# ---- 录音线程 ----
class Recorder:
    def __init__(self) -> None:
        self.frames: list = []
        self.active = False
        self.started = 0.0
        self.lock = threading.Lock()
        self.stream = None
        self.thread = None

    def _cb(self, indata, frame_count, time_info, status):
        if self.active:
            with self.lock:
                self.frames.append(bytes(indata))

    def start(self) -> None:
        import sounddevice as sd

        self.frames = []
        self.started = time.monotonic()
        self.active = True
        dev = resolve_input_device()
        self.stream = sd.InputStream(
            device=dev, samplerate=SAMPLE_RATE, channels=1, dtype="int16", callback=self._cb
        )
        self.stream.start()

    def stop(self) -> tuple[str, float]:
        self.active = False
        dur = time.monotonic() - self.started
        try:
            self.stream.stop()
            self.stream.close()
        except Exception:
            pass
        self.stream = None
        with self.lock:
            data = b"".join(self.frames)
        path = str(OUT_DIR / "ptt_voice.wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(data)
        return path, dur


recorder = Recorder()
_asr_model = None
_busy = False


def _pick_asr_device():
    """按 config 选 ASR 设备：auto=有 N 卡用 cuda 否则 cpu；失败自动降级 cpu。"""
    want = str(ASR.get("device", "auto")).lower()
    ctype = ASR.get("compute_type", "int8")
    if want in ("auto", "cuda", "gpu"):
        try:
            import ctranslate2
            n = ctranslate2.get_cuda_device_count()
            if n > 0:
                return "cuda", ctype
        except Exception:
            pass
        if want in ("cuda", "gpu"):
            print("警告：配置要 cuda 但不可用，降级 cpu", file=sys.stderr)
    return "cpu", ctype


def get_model():
    global _asr_model
    if _asr_model is None:
        from faster_whisper import WhisperModel

        device, ctype = _pick_asr_device()
        print(f"首次使用：加载 ASR 模型 {ASR['model']}（{device}/{ctype}，模型在 D 盘）", file=sys.stderr)
        try:
            _asr_model = WhisperModel(
                ASR["model"], device=device, compute_type=ctype,
                download_root=str(ROOT / "models"),
                # 只读本地模型：模型没备齐时立刻报错（日志可查），
                # 不再静默联网下载——那会让首次按键卡死、反馈音缺失、后续按键被 _busy 吞掉。
                local_files_only=True,
            )
        except Exception as e:
            # CUDA 初始化失败（驱动/显存冲突）时兜底回 CPU
            if device != "cpu":
                print(f"CUDA 加载失败({e!r})，回退 CPU", file=sys.stderr)
                device, ctype = "cpu", "int8"
                _asr_model = WhisperModel(
                    ASR["model"], device=device, compute_type=ctype,
                    download_root=str(ROOT / "models"),
                    local_files_only=True,
                )
            else:
                raise
        log_event("asr_device_selected", device=device, compute_type=ctype)
    return _asr_model


def transcribe(wav_path: str) -> str:
    segments, _ = get_model().transcribe(
        wav_path,
        language=ASR.get("language", "zh"),
        beam_size=int(ASR.get("beam_size", 5)),
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
    )
    return "".join(s.text for s in segments).strip()


_CUE_KEYS = {
    # kind -> 依次尝试的配置键（新键优先，旧键兜底）
    "start": ("press_sound", "start_sound"),
    "stop": ("release_sound", "stop_sound"),
    "complete": ("complete_sound",),
}


def play_cue(kind: str) -> None:
    """异步播按键提示音，不阻塞录音线程。缺文件/出错静默跳过，不影响主流程。

    三段（2026-11-24 换 uisfx 音色）：
      start    按下 → press   短促"咔"
      stop     松开 → release 高→低，与按下配对
      complete 转写出字 → complete 轻微上扬
    winsound 只吃 WAV，所以 uisfx 的 mp3 已统一转成 44.1k 单声道 PCM 放在 sounds/uisfx/。
    """
    if not FB.get("enabled", False):
        return
    path = None
    for key in _CUE_KEYS.get(kind, (f"{kind}_sound",)):
        candidate = FB.get(key)
        if not candidate:
            continue
        # 发行版配置里写相对路径（如 sounds/uisfx/minimal/press.wav），
        # 绝对路径仍按原样用，方便本机调试。
        resolved = candidate if os.path.isabs(candidate) else str(ROOT / candidate.replace('\\', '/'))
        if os.path.exists(resolved):
            path = resolved
            break
    if not path:
        return
    try:
        import winsound
        winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
    except Exception:
        pass


def log_event(kind: str, **kw) -> None:
    rec = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "kind": kind, **kw}
    with open(ROOT / "copilot_log.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def do_voice_turn() -> None:
    """松开 PTT 后：保存录音 -> 转写 -> 截图问答 -> TTS 播报。"""
    global _busy
    if _busy:
        return
    _busy = True
    t0 = time.perf_counter()
    try:
        wav, dur = recorder.stop()
        if dur < float(REC.get("min_secs", 0.4)):
            print("录音太短，丢弃", file=sys.stderr)
            return
        text = transcribe(wav)
        t_asr = time.perf_counter()
        if not text:
            print("未识别到语音", file=sys.stderr)
            log_event("asr_empty", dur=round(dur, 2))
            return
        print(f"识别：{text}", file=sys.stderr)
        play_cue("complete")  # 出字了：轻微上扬，表示"听清了"

        import ask
        import memory_store
        from tts_interface import get_tts

        # 截屏与否按问题判断："1+1 等于几"不需要看画面，省下约 1 秒的识图开销
        shot_mode = str((CFG.get("shot") or {}).get("mode") or "smart")
        want_shot = ask.need_shot(text, shot_mode)
        # 截哪块屏跟设置页「截图范围」走（auto/primary/secondary/window/all），和自动开口同一份配置
        capture_target = str(plugin_cfg().get("captureTarget") or "auto")
        shot_info: dict = {}
        jpeg = (
            ask.capture_jpeg(prefer_game=True, monitor=capture_target, info=shot_info)
            if want_shot
            else None
        )
        log_event(
            "shot",
            on=want_shot,
            mode=shot_mode,
            target=capture_target,
            source=shot_info.get("source"),
            orig=shot_info.get("orig"),
        )
        # 记忆：模式在设置页选（off / auto / always），本地 config.json 的 memory 段只管条数与字数
        mem_cfg = CFG.get("memory") or {}
        mem_mode = plugin_memory_mode()
        if mem_mode == "off":
            history = []
        else:
            history = memory_store.recall(
                text,
                limit=int(mem_cfg.get("limit", 3)),
                max_chars=int(mem_cfg.get("chars", 1500)),
                force=(mem_mode == "always"),
            )
        # 主线：交给 DSH 桌宠插件出答案（气泡 + 动画 + 模型由它管）；失败才本地直连兜底
        route = "plugin"
        meta: dict = {}
        try:
            answer, meta = ask.ask_via_plugin(text, jpeg, history=history)
        except Exception as e:
            plugin_err = repr(e)
            route = "local"
            meta = {"error": plugin_err}
            try:
                answer = ask.ask_vlm(text, jpeg)
            except Exception as local_e:
                # 两条路都断了：把插件的原始失败一起报出来，别只留"没填模型端点"——
                # 那会掩盖"DSH 端口没探到"这类真凶，排查时白绕一圈（2026-11-24 踩过）。
                raise RuntimeError(
                    f"插件问答失败：{plugin_err}；本地兜底也失败：{local_e!r}"
                ) from e
        t_vlm = time.perf_counter()

        # 语音设置以设置页为准（音色/语速/音量/引擎），改完下一句就生效，不用重启
        tts = get_tts()
        plug = apply_plugin_tts(tts)
        backend = plug.get("backend") or CFG.get("tts", {}).get("backend") or None
        if plug.get("enabled") is False:
            # 关掉播报：气泡照常显示，只是不出声（想安静看字的场景）
            tts_stats = {"backend": "off", "sentences": 0, "first_ms": None, "total_ms": 0, "errors": []}
            print("[TTS] 设置页里播报是关的，只显示气泡", file=sys.stderr)
        elif plug.get("streaming", True):
            # 分句流式：第一句合成完就开口，后面的边播边合成。
            # 整句合成要等全文（实测离线晓晓 4s 才开口），分句后约 1s。
            tts_stats = tts.speak_streaming(
                answer,
                backend=backend,
                out_dir=str(OUT_DIR / "tts_seg"),
                max_len=int(plug.get("maxChars") or 60),
            )
        else:
            # 关掉分句流式：整句合成后一次播完（音色连贯，但开口更慢）
            import winsound

            path = str(OUT_DIR / "tts_whole.wav")
            t_w = time.perf_counter()
            # 用返回的实际路径：edge_tts 可能落 MP3 再转 WAV，文件名未必是入参那个
            path = tts.synthesize(answer, path, backend=backend)
            tts_stats = {
                "backend": tts.get_backend(backend).name,
                "sentences": 1,
                "first_ms": int((time.perf_counter() - t_w) * 1000),
                "total_ms": int((time.perf_counter() - t_w) * 1000),
                "errors": [],
            }
            winsound.PlaySound(path, winsound.SND_FILENAME)
        t_tts = time.perf_counter()

        log_event(
            "voice_turn",
            question=text, answer=answer,
            reasoning=ask.LAST_REASONING,  # 思考链全文，诊断答错用
            usage=ask.LAST_USAGE,
            route=route,
            ask_mode=meta.get("mode"),
            ask_by=meta.get("answeredBy"),
            ask_ms=meta.get("elapsed_ms"),
            ask_error=meta.get("error"),
            memory_used=len(history),
            memory_mode=mem_mode,
            rec_s=round(dur, 2),
            asr_s=round(t_asr - t0, 2),
            vlm_s=round(t_vlm - t_asr, 2),
            tts_s=round(t_tts - t_vlm, 2),
            tts_backend=tts_stats.get("backend"),
            tts_first_ms=tts_stats.get("first_ms"),
            tts_total_ms=tts_stats.get("total_ms"),
            tts_segments=tts_stats.get("sentences"),
            tts_errors=tts_stats.get("errors") or None,
            total_s=round(time.perf_counter() - t0, 2),
        )
        # 记忆落盘：全量日志 + 索引（写失败不影响本次回答）
        try:
            memory_store.append_turn(
                text,
                answer,
                screen=str(meta.get("screen") or ""),
                model=str(meta.get("mode") or route),
                meta={"route": route, "limit": mem_cfg.get("limit", 3)},
            )
        except Exception as e:
            print(f"记忆写入失败（不影响回答）：{e!r}", file=sys.stderr)
        print(f"回答：{answer}", file=sys.stderr)
        print(
            f"[模型] 路由 {route} / 实际作答 {meta.get('answeredBy') or '-'} "
            f"/ 模式 {meta.get('mode') or '-'} / {meta.get('elapsed_ms') or 0}ms",
            file=sys.stderr,
        )
    except Exception as e:
        log_event("error", error=repr(e))
        print(f"出错：{e!r}", file=sys.stderr)
    finally:
        _busy = False


def run_one_shot(script: str, args: list[str]) -> None:
    """一次性热键：起独立进程跑，避免阻塞 PTT 轮询。"""
    import subprocess

    subprocess.Popen(
        [sys.executable, str(ROOT / script), *args],
        cwd=str(ROOT), creationflags=win32con.CREATE_NO_WINDOW,
    )


_last_oneshot = 0.0


def pump_ptt(ptt_active: bool, ptt_pressed_at: float) -> tuple[bool, float]:
    """检查一次 PTT 按键状态：按下开始录、松开触发转写。返回更新后的状态。"""
    if _busy:
        return ptt_active, ptt_pressed_at
    down = ptt_down()
    now = time.monotonic()
    global _caps_before
    if down and not ptt_active:
        if PTT_VK == 0x14:
            _caps_before = caps_lock_state()  # 记住按下前的大小写状态
        play_cue("start")  # 滴：开始听
        recorder.start()
        return True, now
    if down and ptt_active:
        if now - ptt_pressed_at >= float(REC.get("max_secs", 30)):
            restore_caps_lock()  # 超时自动断也要恢复大小写
            play_cue("stop")  # 咚：收到，处理中
            threading.Thread(target=do_voice_turn, daemon=True).start()
            return False, ptt_pressed_at
        return True, ptt_pressed_at
    if not down and ptt_active:
        restore_caps_lock()  # 松开后恢复大小写，不影响之后打字
        play_cue("stop")  # 咚：收到，处理中
        threading.Thread(target=do_voice_turn, daemon=True).start()
        return False, ptt_pressed_at
    return ptt_active, ptt_pressed_at


def pump_messages() -> bool:
    """处理所有待处理消息；返回 False 表示收到退出热键。"""
    global _last_oneshot
    while True:
        got, msg = win32gui.PeekMessage(0, 0, 0, win32con.PM_REMOVE)
        if not got:
            return True
        hwnd, message, wparam, _ = msg
        if message == win32con.WM_HOTKEY:
            now = time.monotonic()
            if now - _last_oneshot >= 1.5:
                _last_oneshot = now
                if wparam == ID_ASK:
                    run_one_shot("ask.py", [])
                elif wparam == ID_SPEAK:
                    run_one_shot("speak_clipboard.py", [])
                elif wparam == ID_EXIT:
                    return False
            continue
        win32gui.TranslateMessage(msg)
        win32gui.DispatchMessage(msg)


def message_loop() -> None:
    """非阻塞消息泵：PeekMessage 处理一次性热键，其余时间轮询 PTT 按键。"""
    ptt_active = False
    ptt_pressed_at = 0.0

    try:
        while True:
            if not pump_messages():
                return
            ptt_active, ptt_pressed_at = pump_ptt(ptt_active, ptt_pressed_at)
            time.sleep(0.04)
    finally:
        for hk in (ID_ASK, ID_SPEAK, ID_EXIT):
            try:
                win32gui.UnregisterHotKey(0, hk)
            except Exception:
                pass
        log_event("daemon_stopped")


if __name__ == "__main__":
    _register_oneshot_hotkeys()  # 先抢热键：被占用会弹框说明，而不是静默死掉
    log_event(
        "daemon_started",
        ptt=f"{'+'.join(HK['ptt_voice'].get('modifiers', [])) or ''}+{HK['ptt_voice']['key']}",
        model=ASR["model"],
    )
    message_loop()
