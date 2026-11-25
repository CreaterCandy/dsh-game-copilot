#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
是什么：游戏内 AI 助理的 TTS 统一接口骨架（可切换后端 + 降级链）
给谁  ：本项目维护者与使用者（Windows）
怎么用 ：见下方「快速开始」；详细说明看同目录 README.md。
when  ：2026-11-23
================================================================================

设计目标：
  * TTS 这一环做成灵活接口，三个方案都能切换：
      - offline_xiaoxiao  微软晓晓离线包（SAPI5 + NaturalVoiceSAPIAdapter）★ 第一步落地
      - edge_tts          微软晓晓在线（免费、音色备份）
      - qwen3_tts         本地 TTS（接口预留，暂不启用）
      - sapi_fallback     系统自带慧慧（最后兜底）
  * 第一步落地先用 offline_xiaoxiao 跑通；调用方只认 tts.synthesize(text, out_path)，
    不关心背后是哪个后端，切换只改 config.json，不动业务代码。

这份文件是「骨架」：离线晓晓、Edge、系统兜底是真实现，能直接跑；
本地 TTS 留的是接口占位（is_available 恒 False + synthesize 抛引导异常），
等以后换 Ampere+ 卡或要玩克隆时再填，调用方无需改动。

--------------------------------------------------------------------------------
快速开始（装好 Python 后）：
    pip install pywin32 edge-tts

    # 1) 体检：列出每个后端当前是否可用
    python tts_interface.py --check

    # 2) 念一句话（默认按 config.json 选后端，auto = 自动降级）
    python tts_interface.py "这里是攻略提示，前方的宝藏在右手边第二个山洞。" -o runtime/reply.wav

    # 3) 显式切到某个后端
    python tts_interface.py "你好" --backend edge_tts -o runtime/reply.wav

    # 4) 在助理代码里调用（只认这一个函数）
    from tts_interface import get_tts
    tts = get_tts()                      # 默认读 config.json
    tts.synthesize("矿机缺煤，把传送带接上就行。", r"runtime/reply.wav")

注意：离线晓晓要先按落地文档装好 NaturalVoiceSAPIAdapter + 晓晓 MSIX，
      Windows 语音列表里出现 Microsoft Xiaoxiao (Natural) 才会 available。
================================================================================
"""

from __future__ import annotations

import abc
import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Callable, List, Optional

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"


def _ensure_wav(path: str) -> str:
    """把后端返回的路径归一成 winsound 能播的 WAV，并返回真实文件路径。

    edge-tts 原生产出 MP3；没装 imageio-ffmpeg 时 EdgeBackend.synthesize()
    会把 ".wav" 请求降级返回 ".edge.mp3"。以前调用方只认请求的 .wav 路径，
    winsound.PlaySound 找不到文件就只响一声 Windows 提示音——听不到人声。
    这里统一以 synthesize() 的返回值为准，必要时转码，绝不拿不存在的路径去播。
    """
    p = Path(path)
    if p.suffix.lower() == ".wav":
        return path
    if p.suffix.lower() not in (".mp3", ".edge.mp3"):
        return path  # 未知格式原样返回，由调用方报错
    try:
        import subprocess

        import imageio_ffmpeg

        wav = str(p.with_suffix(".wav"))
        subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(p), wav],
            check=True,
            # pythonw 无控制台，不带这个 flag 转码时会闪黑框
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return wav
    except Exception as e:
        raise RuntimeError(
            f"Edge 产出的是 MP3（{p.name}），winsound 只能播 WAV。"
            "请在 runtime/venv 里 pip install imageio-ffmpeg 后重试。"
            f"原始错误：{e}"
        ) from e


def clean_for_speech(text: str) -> str:
    """把给 VLM 的 Markdown/代码符号清掉，避免 TTS 把 '*' 念成'星号'。

    只处理"会被念出声"的标记符号，保留中文标点与正常文字。所有后端共用。
    """
    if not text:
        return text
    s = text
    # 行首的标题井号：# 标题 / ## 标题 -> 标题
    s = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", s)
    # 加粗/斜体标记：**x** / *x* / __x__ -> x
    s = s.replace("**", "").replace("__", "")
    s = re.sub(r"(?<!\w)\*(?!\s)|(?<!\s)\*(?!\w)", "", s)  # 成对或散落的单星号
    # 行内代码反引号：`x` -> x
    s = s.replace("`", "")
    # Markdown 链接 [文字](url) -> 文字；图片 ![alt](url) -> alt
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    # 列表符号：行首 "- " / "* " / "+ " / "1. " -> 去掉（句子中间的不动）
    s = re.sub(r"(?m)^\s*[-*+]\s+", "", s)
    s = re.sub(r"(?m)^\s*\d+\.\s+", "", s)
    # 水平分割线 --- / *** -> 去掉整行
    s = re.sub(r"(?m)^\s*(?:-{3,}|\*{3,})\s*$", "", s)
    # 收敛换行：连续空行 -> 句号停顿；单个换行 -> 逗号停顿，避免 TTS 生硬断句
    s = re.sub(r"\n\s*\n+", "。", s)
    s = re.sub(r"(?<!。)\n(?!。)", "，", s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"。{2,}", "。", s)
    s = re.sub(r"，{2,}", "，", s)
    s = re.sub(r"。，|，。", "。", s)
    s = re.sub(r"([：、；])，", r"\1", s)  # 冒号/顿号/分号后不重复加逗号
    return s.strip()


# 句末停顿符：这些位置切开，TTS 听起来自然，也适合"念一句就播一句"
_SENT_END = "。！？!?；;"
_COMMA = "，,、：:"


def split_sentences(text: str, first_max: int = 24, max_len: int = 60) -> List[str]:
    """把回答切成适合"边合成边播"的短句。

    为什么切：整句合成必须等全文出来才能开口（2026-11-24 实测离线晓晓整句 4.07s，
    切成 3 句后第一句 1.05s 就能开口，总时长几乎不变 3.96s）。

    规则：
      - 先按句末标点切；
      - 第一句超过 first_max 字时在逗号处再切一刀（首字延迟只取决于第一句）；
      - 其余句子超过 max_len 字时按逗号续切，避免单句太长播起来卡。
    """
    text = (text or "").strip()
    if not text:
        return []

    rough: List[str] = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in _SENT_END:
            if buf.strip():
                rough.append(buf.strip())
            buf = ""
    if buf.strip():
        rough.append(buf.strip())

    out: List[str] = []
    for i, seg in enumerate(rough):
        limit = first_max if i == 0 else max_len
        out.extend(_split_long(seg, limit))
    return [s for s in out if s.strip()]


def _split_long(seg: str, limit: int) -> List[str]:
    """单句过长时按逗号切；逗号位置不合适就原样返回（宁可长一点，不要切坏语义）。"""
    if len(seg) <= limit:
        return [seg]
    parts: List[str] = []
    buf = ""
    for ch in seg:
        buf += ch
        if ch in _COMMA and len(buf) >= max(limit * 0.6, 6):
            parts.append(buf)
            buf = ""
    if buf:
        parts.append(buf)
    return parts or [seg]


# ---------------------------------------------------------------------------
# 统一接口
# ---------------------------------------------------------------------------
class TTSBackend(abc.ABC):
    """所有 TTS 后端都要实现这三个方法。助理代码只依赖这个抽象。"""

    name: str = "base"

    @abc.abstractmethod
    def synthesize(self, text: str, out_path: str) -> str:
        """把 text 合成语音写入 out_path，返回实际输出路径。"""
        raise NotImplementedError

    @abc.abstractmethod
    def is_available(self) -> bool:
        """当前这个后端能不能用（依赖装没装、语音包在不在、网通不通）。"""
        raise NotImplementedError

    def warmup(self) -> None:
        """预热。轻量/在线后端是空实现；常驻大模型可在这里加载。"""
        return None


# ---------------------------------------------------------------------------
# 后端 1（★ 第一步落地）：微软晓晓离线包，走 SAPI5
# ---------------------------------------------------------------------------
class OfflineXiaoxiaoBackend(TTSBackend):
    """
    依赖：pip install pywin32
    前提：已装 NaturalVoiceSAPIAdapter v0.2.9（见落地文档第二节），
          Windows「文本转语音」设置里能看到对应的 Natural 音色。
    音色名用模糊匹配（Xiaoyi / 晓伊 都行），不写死全名——不同版本显示字样会变。
    """

    name = "offline_xiaoxiao"

    # hint 写中文也能认（config 里写"晓伊"比写 Xiaoyi 直观）
    ALIASES = {
        "晓晓": "xiaoxiao", "晓伊": "xiaoyi", "晓北": "xiaobei", "晓妮": "xiaoni",
        "云健": "yunjian", "云希": "yunxi", "云霞": "yunxia", "云扬": "yunyang",
        "慧慧": "huihui", "娜娜": "nana",
    }

    def __init__(
        self,
        voice_hint: str = "Xiaoxiao",
        speed: int = 0,
        offline_fallback_hint: str = "Xiaoxiao",
        volume: int = 100,
    ):
        raw = (voice_hint or "").strip()
        self.voice_hint = self.ALIASES.get(raw, raw).lower()
        # 主音色是在线桥接时（如晓伊），网络抖动会让整句合成失败。
        # 与其让路由器降级到"慧慧"那种 2010 年导航仪音色，不如换本机真离线音色顶一句。
        # 若系统里装了晓晓 HD 一类自然人声，这里优先沿用。
        self.offline_fallback_hint = (offline_fallback_hint or "").strip()
        # SAPI5 的 Rate 是**整数级** -10..10。2026-11-24 本机实测（在线桥接晓晓，
        # 同一句 6.31s）等效倍率：0=1.00x  1=1.20x  2=1.39x  3=1.59x  ≥5≈2.00x（封顶）。
        # 所以"想快 10–20%"就是 1；想要精确的 +10% 只能换 edge_tts（它吃百分比）。
        self.speed = max(-10, min(10, int(speed)))
        # 音量 0..100。SAPI 在合成阶段就把音量乘进音频波形里，所以 winsound 播出来
        # 也是这个音量（不需要动播放链路）。100 = 原始音量。
        self.volume = _clamp_volume(volume)

    def _new_voice(self):
        import win32com.client  # 延迟导入，--check 在无依赖时也能跑

        voice = win32com.client.Dispatch("SAPI.SpVoice")
        return voice

    def _pick_xiaoxiao(self, voice):
        """按 voice_hint 在 SAPI 语音列表里挑音色，**同名优先真离线**。找不到返回 None。

        不再写死"晓晓"：可按系统已装音色切换，
        所以 hint 是什么就找什么（配置 `backends.offline_xiaoxiao.voice_hint`）。
        类名/后端名仍叫 offline_xiaoxiao，只为兼容旧配置与日志，别被名字骗了。

        匹配分三级，避免"Yunxi 误命中 Yunxia"这种子串事故：
          1. Edge 桥接 token 名精确：Id 里含 `-yunxineural`；
          2. 描述里按整词匹配：`\\byunxi\\b`（yunxia 后面还有字母，不会中）；
          3. 中文提示直接子串（hint 写"晓伊"这种）。
        同分情况按 (在线, 是否中文) 排序：真离线排最前——在线桥接每次都要联网，
        网络抖动会 "Connection closed before all data could be received"。

        返回 (voice_object, description)。
        """
        hint = (self.voice_hint or "").strip().lower()
        if not hint:
            return None

        def score(v, desc: str):
            low = desc.lower()
            try:
                vid = (v.Id or "").lower()
            except Exception:
                vid = ""
            exact = f"-{hint}neural" in vid
            word = bool(re.search(rf"\b{re.escape(hint)}\b", low))
            zh = hint in desc
            if not (exact or word or zh):
                return None
            online = ("online" in low) or ("在线" in desc)
            is_cn = ("zh-cn" in (vid or low)) or ("chinese" in low) or ("中文" in desc)
            # 排序键：先精确、再离线、再中文
            return (0 if exact else 1, 1 if online else 0, 0 if is_cn else 1)

        hits = []
        for v in voice.GetVoices():
            desc = v.GetDescription()
            s = score(v, desc)
            if s is not None:
                hits.append((s, v, desc))
        if not hits:
            return None
        hits.sort(key=lambda x: x[0])
        _, v, desc = hits[0]
        return v, desc

    def probe(self) -> dict:
        """体检用：这个后端到底能用哪个音色、是离线还是在线的。"""
        try:
            voice = self._new_voice()
            picked = self._pick_xiaoxiao(voice)
            if picked is None:
                return {"available": False, "desc": None, "online": None}
            _, desc = picked
            low = desc.lower()
            alt = self._pick_offline(voice, self.offline_fallback_hint)
            return {
                "available": True,
                "desc": desc,
                "online": ("online" in low) or ("在线" in desc),
                "offline_alt": alt[1] if alt else None,
            }
        except Exception as e:
            return {"available": False, "desc": f"检测异常 {e!r}", "online": None}

    def is_available(self) -> bool:
        return bool(self.probe().get("available"))

    def _pick_offline(self, voice, prefer_hint: str = ""):
        """挑一个**真离线**的中文音色：优先 prefer_hint 指定的，其次任意离线中文。

        专门用于"在线音色合成失败"的兜底。判断离线只看描述里有没有 Online / 在线，
        和 _pick_xiaoxiao 的排序口径保持一致。找不到（本机没装任何离线包）返回 None。
        """
        prefer = self.ALIASES.get((prefer_hint or "").strip(), (prefer_hint or "").strip()).lower()
        cands = []
        for v in voice.GetVoices():
            desc = v.GetDescription()
            low = desc.lower()
            vid = (v.Id or "").lower()
            if ("online" in low) or ("在线" in desc):
                continue
            if not (("zh-cn" in vid) or ("chinese" in low) or ("中文" in desc)):
                continue
            hit = 1 if (prefer and (f"-{prefer}neural" in vid or prefer in low)) else 0
            cands.append((hit, v, desc))
        if not cands:
            return None
        cands.sort(key=lambda x: -x[0])
        _, v, desc = cands[0]
        return v, desc

    def _speak_to_file(self, voice, token, text: str, out_path: str) -> None:
        """把 voice 切到 token，把 text 合成到 out_path（SAPI5 SpFileStream）。"""
        import win32com.client

        voice.Voice = token
        voice.Rate = self.speed  # 语速（config 顶层 speed，实测 1 ≈ 1.20x）
        voice.Volume = self.volume  # 0..100，烘进波形，winsound 播出来也生效
        stream = win32com.client.Dispatch("SAPI.SpFileStream")
        stream.Open(out_path, 3)  # 3 = SSFM_CREATEFORWRITE
        try:
            voice.AudioOutputStream = stream
            voice.Speak(text, 0)  # 0 = SVSFDefault，同步等合成完
        finally:
            voice.AudioOutputStream = None
            stream.Close()

    def synthesize(self, text: str, out_path: str) -> str:
        out_path = os.path.abspath(out_path)
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        voice = self._new_voice()
        picked = self._pick_xiaoxiao(voice)
        if picked is None:
            have = "、".join(v.GetDescription() for v in voice.GetVoices() if "Chinese" in v.GetDescription() or "zh-CN" in (v.Id or ""))
            raise RuntimeError(
                f"SAPI5 里找不到语音 hint='{self.voice_hint}'。"
                f"本机现有中文音色：{have or '（一个都没有）'}。"
                "改 tts/config.json 的 backends.offline_xiaoxiao.voice_hint 即可（写英文 token 名，如 Xiaoyi/Yunjian/Yunxi）。"
            )
        try:
            self._speak_to_file(voice, picked[0], text, out_path)
        except Exception as e:
            alt = self._pick_offline(voice, self.offline_fallback_hint)
            if alt is None or alt[1] == picked[1]:
                raise  # 没离线包可换，交给上层降级链（最终是慧慧）
            print(f"[TTS] 音色 {picked[1]} 合成失败（{e}），本句改用离线音色 {alt[1]}",
                  file=sys.stderr)
            self._speak_to_file(self._new_voice(), alt[0], text, out_path)
        return out_path

    def synthesize_direct(self, text: str) -> None:
        """不落文件、直接经 SAPI 写到默认音频设备（更低延迟，适合纯播报）。"""
        voice = self._new_voice()
        picked = self._pick_xiaoxiao(voice)
        if picked is not None:
            voice.Voice = picked[0]
        voice.Rate = self.speed  # 同上：语速，0 为原速
        voice.Volume = self.volume
        voice.Speak(text, 0)


# ---------------------------------------------------------------------------
# 后端 2：Edge TTS（微软晓晓在线，免费，音色与手机同款）
# ---------------------------------------------------------------------------
def _clamp_rate(value, default: int = 0) -> int:
    """把配置里的语速夹到 SAPI5 合法区间 -10..10（非数字回落到 default）。"""
    try:
        return max(-10, min(10, int(float(value))))
    except Exception:
        return default


def _clamp_volume(value, default: int = 100) -> int:
    """音量夹到 SAPI5 的 0..100。

    注意：SAPI 的音量是**烘进音频文件**的（合成时就乘进去），所以 winsound 播放
    照样生效——这点和"播放器音量"不同，不需要改播放链路。
    """
    try:
        return max(0, min(100, int(float(value))))
    except Exception:
        return default


# SAPI token → edge-tts 的完整音色名。
# 设置页只传 token（Xiaoyi），这里推出 edge 那边的全名，保证「主音色」和「降级音色」
# 永远是同一个人。方言音色的命名不规则，所以只能列表写死，不能靠拼字符串。
# ⚠️ 改这张表要同步 client.js 的 TTS_VOICES（那边是下拉框的显示名）。
EDGE_VOICE_BY_TOKEN = {
    "huihui": "zh-CN-HuihuiNeural",
    "xiaoxiao": "zh-CN-XiaoxiaoNeural",
    "xiaoyi": "zh-CN-XiaoyiNeural",
    "yunjian": "zh-CN-YunjianNeural",
    "yunxi": "zh-CN-YunxiNeural",
    "yunxia": "zh-CN-YunxiaNeural",
    "yunyang": "zh-CN-YunyangNeural",
    "xiaobei": "zh-CN-liaoning-XiaobeiNeural",
    "xiaoni": "zh-CN-shaanxi-XiaoniNeural",
}


def edge_voice_for(token: str) -> Optional[str]:
    """SAPI token（Xiaoyi / 晓伊）→ edge-tts 音色全名；认不出返回 None（不改 edge 那侧）。"""
    raw = (token or "").strip()
    hint = OfflineXiaoxiaoBackend.ALIASES.get(raw, raw).lower()
    return EDGE_VOICE_BY_TOKEN.get(hint)


def _norm_rate(value, default: str = "+0%") -> str:
    """把语速规范成 edge-tts 认识的 "+20%" 形式（也接受 20 / "20" / "+20"）。"""
    if value is None:
        return default
    text = str(value).strip()
    if not text:
        return default
    if text.endswith("%"):
        text = text[:-1].strip()
    try:
        num = int(float(text))
    except Exception:
        return default
    return f"{num:+d}%"


class EdgeTTSBackend(TTSBackend):
    """
    依赖：pip install edge-tts
    免费、免注册、0 显存；work 机实测在线晓晓首包约 1522ms，受网络波动影响。
    作为音色备份 / 离线包没装好时的兜底。
    """

    name = "edge_tts"

    def __init__(self, voice: str = "zh-CN-XiaoxiaoNeural", rate: str = "+0%", volume: int = 100):
        self.voice = voice
        # edge-tts 的语速是**百分比**，比 SAPI5 的整数级精确（SAPI 只能 0/1.2/1.39…）。
        self.rate = _norm_rate(rate)
        # edge-tts 的音量也是百分比参数：0 = 静音，100 = 原始。传成 "+0%" 形式。
        self.volume = f"{_clamp_volume(volume) - 100:+d}%"

    def is_available(self) -> bool:
        try:
            import edge_tts  # noqa: F401
            return True
        except Exception:
            return False

    def synthesize(self, text: str, out_path: str) -> str:
        import edge_tts

        out_path = os.path.abspath(out_path)
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)

        async def _run(tmp_path: str):
            communicate = edge_tts.Communicate(text, self.voice, rate=self.rate, volume=self.volume)
            await communicate.save(tmp_path)

        # edge-tts 实际产出 MP3。若调用方要 WAV，先落临时 MP3 再用 ffmpeg 转码，
        # 保证 synthesize() 返回的文件格式与 out_path 后缀一致。
        if Path(out_path).suffix.lower() == ".wav":
            tmp_path = str(Path(out_path).with_suffix(".edge.mp3"))
            asyncio.run(_run(tmp_path))
            try:
                import imageio_ffmpeg
                import subprocess
                ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
                subprocess.run(
                    [ffmpeg, "-y", "-loglevel", "error", "-i", tmp_path, out_path],
                    check=True,
                    # pythonw 无控制台，不带这个 flag 转码时会闪黑框
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                os.remove(tmp_path)
                return out_path
            except Exception:
                # 没有 ffmpeg 时退回：直接返回真实 MP3 路径，调用方用返回值即可。
                return tmp_path

        asyncio.run(_run(out_path))
        return out_path


# ---------------------------------------------------------------------------
# 后端 3（接口预留，暂不启用）：本地 TTS
# ---------------------------------------------------------------------------
class Qwen3TTSBackend(TTSBackend):
    """
    占位实现——接口先留好，调用方不用改，等条件满足再填真身。
    当前环境的两个限制：
      1) FlashAttention-2 对显卡架构有要求，旧卡装不上；
         退路是 PyTorch SDPA（内置）或 xformers。
      2) 本地模型会与游戏和视觉模型争用显存。
    激活条件：硬件与显存满足条件，且不需要与游戏抢资源时。
    激活时把 enabled 设为 true，并在 synthesize 里接对应的本地 TTS 实现 /
    vLLM-Omni 的流式管线（一次性官方 CLI 是 16–19 秒，别用）。
    """

    name = "qwen3_tts"

    def __init__(self, enabled: bool = False, attn: str = "sdpa_or_xformers"):
        self.enabled = enabled
        self.attn = attn

    def is_available(self) -> bool:
        # 未显式开启 → 恒不可用，自动降级链会跳过它。
        return bool(self.enabled)

    def synthesize(self, text: str, out_path: str) -> str:
        raise NotImplementedError(
            "Qwen3-TTS 后端是接口占位，尚未接入。\n"
            "  本机是 Turing sm_75，FA2 装不上（见 v2 选型文档），且 6G 显存会和游戏抢卡。\n"
            "  如确要启用：换 Ampere+ 卡或游戏关掉时，把 config.json 里 enabled 设为 true，\n"
            "  并在本方法里接 faster-qwen3-tts / vLLM-Omni 流式管线（勿用一次性 CLI）。"
        )


# ---------------------------------------------------------------------------
# 后端 4：系统自带慧慧（最后兜底，机械音但绝不出错）
# ---------------------------------------------------------------------------
class SAPIFallbackBackend(TTSBackend):
    """Windows 自带默认语音，pyttsx3 / SAPI5 均可；这里直接用 SAPI5 默认音色。"""

    name = "sapi_fallback"

    def __init__(self, speed: int = 0, volume: int = 100):
        self.speed = max(-10, min(10, int(speed)))
        self.volume = _clamp_volume(volume)

    def is_available(self) -> bool:
        try:
            import win32com.client  # noqa: F401
            return True
        except Exception:
            return False

    def synthesize(self, text: str, out_path: str) -> str:
        import win32com.client

        out_path = os.path.abspath(out_path)
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        voice = win32com.client.Dispatch("SAPI.SpVoice")
        voice.Rate = self.speed
        voice.Volume = self.volume
        stream = win32com.client.Dispatch("SAPI.SpFileStream")
        stream.Open(out_path, 3)
        try:
            voice.AudioOutputStream = stream
            voice.Speak(text, 0)
        finally:
            voice.AudioOutputStream = None
            stream.Close()
        return out_path


# ---------------------------------------------------------------------------
# 路由器：配置驱动切换 + 自动降级
# ---------------------------------------------------------------------------
class TTSRouter:
    """
    对业务暴露的唯一入口。
      - default_backend = "auto"  → 按 auto_order 挑第一个可用的，并自动降级
      - default_backend = "xxx"   → 锁定某个后端；锁定的不可用时抛错（不静默换音色）
    """

    def __init__(self, config: Optional[dict] = None, config_path: Optional[Path] = None):
        if config is None:
            config_path = config_path or CONFIG_PATH
            if config_path.exists():
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
            else:
                config = {}
        self.config = config
        self.default_backend = config.get("default_backend", "auto")
        self.auto_order = config.get(
            "auto_order", ["offline_xiaoxiao", "edge_tts", "sapi_fallback"]
        )
        # 语速总开关：SAPI 系（离线晓晓 / 慧慧兜底）吃整数 Rate，
        # edge_tts 单独在 backends.edge_tts.rate 里吃百分比（两者粒度不同，所以分开配）。
        self.speed = _clamp_rate(config.get("speed", 0))
        # 音量 0..100（100 = 原始）。烘进合成波形，所以播放端无需再管。
        self.volume = _clamp_volume(config.get("volume", 100))
        self._backends = self._build_backends(config.get("backends", {}))

    def _build_backends(self, cfg: dict) -> dict:
        q = cfg.get("qwen3_tts", {})
        edge_cfg = cfg.get("edge_tts", {})
        return {
            "offline_xiaoxiao": OfflineXiaoxiaoBackend(
                voice_hint=cfg.get("offline_xiaoxiao", {}).get("voice_hint", "Xiaoxiao"),
                speed=self.speed,
                offline_fallback_hint=cfg.get("offline_xiaoxiao", {}).get(
                    "offline_fallback_hint", "Xiaoxiao"
                ),
                volume=self.volume,
            ),
            "edge_tts": EdgeTTSBackend(
                voice=edge_cfg.get("voice", "zh-CN-XiaoxiaoNeural"),
                rate=edge_cfg.get("rate", "+0%"),
                volume=self.volume,
            ),
            "qwen3_tts": Qwen3TTSBackend(
                enabled=bool(q.get("enabled", False)),
                attn=q.get("attn", "sdpa_or_xformers"),
            ),
            "sapi_fallback": SAPIFallbackBackend(speed=self.speed, volume=self.volume),
        }

    def set_speed(self, value, edge_rate=None) -> None:
        """运行时改语速（试听/UI 用），只改内存不动磁盘配置。

        value     : SAPI 系整数 -10..10（0=原速，1≈1.20x）
        edge_rate : 可选，"20%"/20/"+20%" 都认，只对 edge_tts 生效
        """
        self.speed = _clamp_rate(value)
        self.config["speed"] = self.speed
        if edge_rate is not None:
            self.config.setdefault("backends", {}).setdefault("edge_tts", {})["rate"] = _norm_rate(
                edge_rate
            )
        self._backends = self._build_backends(self.config.get("backends", {}))

    def apply_runtime(
        self,
        backend: Optional[str] = None,
        voice: Optional[str] = None,
        speed=None,
        volume=None,
    ) -> bool:
        """把设置页改的值套进内存（**免重启**），返回"是否真的变了"。

        为什么要有这个：`get_tts()` 是全局单例、配置只在启动时读一次，
        所以以前改 tts/config.json 必须重启播报进程。现在设置页把值写在
        `%DSH_HOME%\\dsh-game-copilot.json` 的 tts 段，ptt_voice 每次合成前调这个方法，
        改完下一句话就生效。

        voice 写 SAPI token 名（Xiaoyi / 晓伊 / Yunxi…），edge 那边的完整名
        （zh-CN-XiaoyiNeural）由这里按同一张表推出来——两边永远指同一个人，
        不会出现"主音色晓伊、降级后变云希"的错位。
        """
        changed = False

        if backend and backend != self.default_backend:
            self.default_backend = str(backend)
            self.config["default_backend"] = self.default_backend
            changed = True

        if speed is not None:
            value = _clamp_rate(speed, self.speed)
            if value != self.speed:
                self.speed = value
                self.config["speed"] = value
                changed = True

        if volume is not None:
            value = _clamp_volume(volume, self.volume)
            if value != self.volume:
                self.volume = value
                self.config["volume"] = value
                changed = True

        if voice:
            raw = str(voice).strip()
            hint = OfflineXiaoxiaoBackend.ALIASES.get(raw, raw)
            if hint.lower() != str(self.config.get("backends", {}).get("offline_xiaoxiao", {}).get("voice_hint", "")).lower():
                backends = self.config.setdefault("backends", {})
                backends.setdefault("offline_xiaoxiao", {})["voice_hint"] = hint
                edge_name = edge_voice_for(hint)
                if edge_name:
                    backends.setdefault("edge_tts", {})["voice"] = edge_name
                changed = True

        if changed:
            self._backends = self._build_backends(self.config.get("backends", {}))
        return changed

    def get_backend(self, name: Optional[str] = None) -> TTSBackend:
        """解析出真正要用的后端。name=None 时用配置默认值。"""
        target = name or self.default_backend
        if target == "auto":
            for candidate in self.auto_order:
                backend = self._backends.get(candidate)
                if backend is not None and backend.is_available():
                    return backend
            raise RuntimeError(
                "auto 模式下没有任何可用 TTS 后端。请先装离线晓晓（见落地文档），"
                "或 pip install edge-tts。"
            )
        backend = self._backends.get(target)
        if backend is None:
            raise ValueError(f"未知 TTS 后端：{target}。可选：{list(self._backends)}")
        return backend

    def synthesize(self, text: str, out_path: str, backend: Optional[str] = None) -> str:
        """
        主入口：文字 → 语音文件。
        auto 模式下若选中的后端合成失败（如 Edge 断网），自动降级到下一个可用后端。
        所有文本先经 clean_for_speech 去掉 Markdown 符号，避免 TTS 念出"星号"。
        """
        text = clean_for_speech(text)
        if not text:
            text = "。"

        if backend is None and self.default_backend == "auto":
            last_err = None
            for candidate in self.auto_order:
                b = self._backends.get(candidate)
                if b is None or not b.is_available():
                    continue
                try:
                    return _ensure_wav(b.synthesize(text, out_path))
                except Exception as e:  # 降级：换下一个后端
                    last_err = e
            raise RuntimeError(f"auto 降级链全部失败，最后一次错误：{last_err}")
        return _ensure_wav(self.get_backend(backend).synthesize(text, out_path))

    def speak_streaming(
        self,
        text: str,
        backend: Optional[str] = None,
        out_dir: Optional[str] = None,
        first_max: int = 24,
        max_len: int = 60,
        on_first: Optional[Callable[[int], None]] = None,
    ) -> dict:
        """切句 → 后台逐句合成 → 顺序播放。首字延迟压到"第一句合成完"。

        和 synthesize() 的区别：synthesize 是"全文合成完再播"（整句 4 秒才开口），
        这里第一句合成完立即出声，后面的句子边播边合成。

        实测（2026-11-24，离线晓晓/在线桥接）：
          整句 4.07s 才开口 → 分句后 1.05s 开口，总时长 3.96s（几乎不变）。
        edge_tts 例外：它每次合成都重新握手，分句会让总时长从 2.6s 涨到 5.1s，
        所以 edge_tts 保持整句，不参与切句。

        返回 {backend, sentences, first_ms, total_ms, errors[], fallback_whole?}
        """
        import queue as _queue
        import tempfile
        import threading
        import time as _time

        text = clean_for_speech(text)
        if not text:
            text = "。"

        be = self.get_backend(backend)
        if be.name == "edge_tts":
            sentences = [text]
        else:
            sentences = split_sentences(text, first_max=first_max, max_len=max_len) or [text]

        seg_dir = Path(out_dir) if out_dir else Path(tempfile.gettempdir()) / "copilot_tts_seg"
        seg_dir.mkdir(parents=True, exist_ok=True)

        stats: dict = {
            "backend": be.name,
            "sentences": len(sentences),
            "first_ms": None,
            "total_ms": None,
            "errors": [],
        }

        q: "_queue.Queue" = _queue.Queue()
        t0 = _time.perf_counter()

        def _worker() -> None:
            for idx, seg in enumerate(sentences):
                path = str(seg_dir / f"seg_{os.getpid()}_{idx}.wav")
                try:
                    # ★ 必须用 synthesize() 的返回值：edge_tts 在无 ffmpeg 时
                    # 实际产出的是 .edge.mp3。以前拿请求的 .wav 去播 → 只有系统提示音。
                    real_path = _ensure_wav(be.synthesize(seg, path))
                    q.put((idx, real_path, None))
                except Exception as e:  # 单句失败不拖垮整段，记下来继续下一句
                    q.put((idx, None, repr(e)))
            q.put((-1, None, None))

        threading.Thread(target=_worker, daemon=True).start()

        import winsound

        played = 0
        while True:
            idx, path, err = q.get()
            if idx < 0:
                break
            if err:
                stats["errors"].append(err)
                continue
            if not path or not Path(path).is_file():
                stats["errors"].append(f"第 {idx + 1} 句音频不存在：{path}")
                continue
            if stats["first_ms"] is None:
                stats["first_ms"] = int((_time.perf_counter() - t0) * 1000)
                if on_first is not None:
                    try:
                        on_first(stats["first_ms"])
                    except Exception:
                        pass
            # 同步播放：播完才返回，天然作为"念一句、合成下一句"的节拍器
            winsound.PlaySound(path, winsound.SND_FILENAME)
            played += 1

        if played == 0:
            # 全部句子都失败 → 先整句再试一次；还不行就用系统语音兜底，
            # 绝不能让玩家只听到一声 Windows 提示音。
            whole = str(seg_dir / "fallback_whole.wav")
            try:
                play_path = _ensure_wav(be.synthesize(text, whole))
            except Exception:
                whole = str(seg_dir / f"fallback_sapi_{os.getpid()}.wav")
                play_path = self.get_backend("sapi_fallback").synthesize(text, whole)
                stats["fallback_backend"] = "sapi_fallback"
            winsound.PlaySound(play_path, winsound.SND_FILENAME)
            stats["fallback_whole"] = True

        stats["total_ms"] = int((_time.perf_counter() - t0) * 1000)
        return stats

    @staticmethod
    def _token_from_voice(v) -> Optional[str]:
        """从 SAPI token 里提出稳定的 voice_hint（Xiaoxiao / Huihui / ...）。

        两种离线音色的 Id 格式（2026-11-24 本机实测）：
          讲述人离线包：...\\MicrosoftWindows.Voice.zh-CN.XiaoxiaoHD.1
          系统老式语音：...\\TTS_MS_ZH-CN_HUIHUI_11.0
        在线桥接（Edge-zh-CN-XiaoyiNeural）不进这里，调用方已先过滤。
        """
        vid = (getattr(v, "Id", "") or "").lower()
        desc = (v.GetDescription() or "").lower()
        m = re.search(r"microsoftwindows\.voice\.zh-cn\.([a-z]+?)(?:hd)?\.\d+", vid)
        if m:
            return m.group(1).capitalize()
        m = re.search(r"tts_ms_zh-cn_([a-z]+)_", vid)
        if m:
            return m.group(1).capitalize()
        for zh, en in OfflineXiaoxiaoBackend.ALIASES.items():
            if en in desc or zh in desc:
                return en.capitalize()
        return None

    def list_native_voices(self) -> List[dict]:
        """列出本机**所有真离线中文音色**，给设置页的二次菜单用。

        不限"晓晓"：用户自己装了多少个离线包，这里就列多少个。
        名字带 Online / 在线的是 Edge 桥接，断网会失败，一律排除。
        """
        try:
            import win32com.client

            voice = win32com.client.Dispatch("SAPI.SpVoice")
        except Exception:
            return []
        out: List[dict] = []
        seen = set()
        for v in voice.GetVoices():
            desc = v.GetDescription() or ""
            low = desc.lower()
            vid = (getattr(v, "Id", "") or "").lower()
            if "online" in low or "在线" in desc:
                continue
            if not (("chinese" in low) or ("zh-cn" in vid) or ("中文" in desc)):
                continue
            token = self._token_from_voice(v)
            if not token or token.lower() in seen:
                continue
            seen.add(token.lower())
            out.append({"token": token, "desc": desc})
        return out

    def probe_json(self) -> dict:
        """结构化体检（--check --json），给设置页判断「本地自然人声」能不能用。

        和 check() 的纯文本不同，这里多算一个 `native_ready`：
        只有 SAPI 里存在**真离线**中文音色才算这档可用。名字带 Online 的
        Edge 桥接不算——它能被 is_available() 选中，但断网照样合成失败，
        把它当"离线档可用"展示给用户是骗人。
        """
        natives = self.list_native_voices()
        out: dict = {
            "default_backend": self.default_backend,
            "auto_order": list(self.auto_order),
            "native_voices": natives,
            "backends": {},
            "chosen": None,
        }
        for name, b in self._backends.items():
            item: dict = {
                "available": False,
                "online": None,
                "desc": None,
                "offline_alt": None,
            }
            try:
                item["available"] = bool(b.is_available())
                if name == "offline_xiaoxiao" and hasattr(b, "probe"):
                    p = b.probe()
                    item["available"] = bool(p.get("available"))
                    item["online"] = p.get("online")
                    item["desc"] = p.get("desc")
                    item["offline_alt"] = p.get("offline_alt")
            except Exception as e:
                item["error"] = repr(e)
            if name == "offline_xiaoxiao":
                # 以实际列到的离线音色为准，不看"在线桥接 + 某个兜底"那种假可用
                item["native_ready"] = bool(natives)
            out["backends"][name] = item
        try:
            out["chosen"] = self.get_backend().name
        except Exception:
            pass
        return out

    def check(self) -> None:
        """体检：列出每个后端的可用状态，方便落地时确认环境。"""
        print(f"默认后端: {self.default_backend}")
        print(f"降级顺序: {' -> '.join(self.auto_order)}")
        print("-" * 56)
        for name, b in self._backends.items():
            ok = False
            detail = ""
            try:
                ok = b.is_available()
                if name == "offline_xiaoxiao" and hasattr(b, "probe"):
                    p = b.probe()
                    desc = p.get("desc") or ""
                    if desc:
                        if p.get("online"):
                            detail = f"  [在线桥接·依赖网络] {desc}"
                            if p.get("offline_alt"):
                                detail += f"\n{'':22s}↳ 失败时顶替：{p['offline_alt']}（本机离线）"
                        else:
                            detail = f"  [真离线] {desc}"
            except Exception as e:
                ok = False
                print(f"  [{name}] 检测异常: {e}")
            mark = "available" if ok else "NOT available"
            print(f"  {name:<20} {mark}{detail}")
        print("-" * 56)
        chosen = None
        try:
            chosen = self.get_backend().name
        except Exception as e:
            print(f"当前无法选出可用后端: {e}")
        if chosen:
            print(f"实际会用: {chosen}")


# 模块级便捷函数：助理代码里 from tts_interface import get_tts 即可
_default_router: Optional[TTSRouter] = None


def get_tts(config_path: Optional[Path] = None) -> TTSRouter:
    """拿到全局路由器（懒加载配置）。业务侧只认它返回的 .synthesize()。"""
    global _default_router
    if _default_router is None:
        _default_router = TTSRouter(config_path=config_path)
    return _default_router


def list_all_voices(show_all: bool = False) -> None:
    """列出 SAPI 里的语音并标注"离线/在线"——用来判断晓晓到底装的是哪个版本。

    背景：NaturalVoiceSAPIAdapter 会把 Edge 的在线语音桥接成 SAPI，名字带 "Online"，
    看着像装好了、实际每次都要联网（网络抖动就 "Connection closed"）。
    真离线包的名字不带 Online。
    """
    try:
        import win32com.client
    except ImportError:
        print("需要 pywin32：pip install pywin32")
        return

    voice = win32com.client.Dispatch("SAPI.SpVoice")
    rows = []
    for v in voice.GetVoices():
        desc = v.GetDescription()
        low = desc.lower()
        online = ("online" in low) or ("在线" in desc)
        is_cn = any(k in low for k in ("chinese", "zh-cn")) or ("中文" in desc) or ("晓晓" in desc)
        rows.append((not is_cn, online, desc))

    cn_rows = [r for r in rows if not r[0]]
    print(f"共 {len(rows)} 个语音（其中中文 {len(cn_rows)} 个）")
    print("-" * 76)
    for _, online, desc in sorted(cn_rows or rows):
        tag = "[在线·依赖网络]" if online else "[真离线]"
        print(f"  {tag:<16} {desc}")
    if show_all:
        print("-" * 76)
        print("其余语音：")
        for _, online, desc in rows:
            if desc not in [r[2] for r in cn_rows]:
                print(f"  {'[在线]' if online else '[离线]':<10} {desc}")

    has_offline_cn = any((not online) and ("xiaoxiao" in d.lower()) for _, online, d in rows)
    print("-" * 76)
    if has_offline_cn:
        print("结论：已装真离线晓晓，auto 会自动优先用它。")
    else:
        print("结论：没有真离线晓晓（只有在线桥接版）。")
        print("      装法：设置 → 辅助功能 → 讲述人 → 添加自然语音 → 中文(简体) → 晓晓")
        print("      装完再跑一次 --check，应显示 [真离线]")


def _cli(argv: List[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="游戏助理 TTS 接口（可切换后端）")
    parser.add_argument("text", nargs="?", help="要念的文字")
    parser.add_argument("-o", "--out", default=str(HERE / "reply.wav"), help="输出音频路径")
    parser.add_argument("--backend", default=None, help="显式指定后端；不填按 config.json")
    parser.add_argument("--check", action="store_true", help="只体检，列出各后端可用状态")
    parser.add_argument("--json", action="store_true", help="配合 --check：输出结构化 JSON 给设置页")
    parser.add_argument("--voices", action="store_true", help="列出系统语音，标注离线/在线")
    parser.add_argument("--speak", action="store_true", help="分句流式播放（边合成边出声）")
    parser.add_argument(
        "--speed", type=int, default=None, help="临时改语速（SAPI 整数 -10..10，0 原速，1≈1.2x）"
    )
    parser.add_argument(
        "--volume", type=int, default=None, help="临时改音量（0..100，100 原音量）"
    )
    parser.add_argument(
        "--voice", default=None, help="临时改音色（SAPI token，如 Xiaoyi / 云希）"
    )
    args = parser.parse_args(argv)

    router = get_tts()
    if args.speed is not None or args.volume is not None or args.voice:
        router.apply_runtime(voice=args.voice, speed=args.speed, volume=args.volume)
        print(
            f"[本次设置] 语速 {router.speed} / 音量 {router.volume} / "
            f"音色 {router.get_backend('offline_xiaoxiao').voice_hint}"
            "（只影响这一次，不写配置文件）"
        )
    if args.check:
        if args.json:
            print(json.dumps(router.probe_json(), ensure_ascii=False))
        else:
            router.check()
        return 0
    if args.voices:
        list_all_voices()
        return 0
    if not args.text:
        parser.error("要给一句话，或用 --check / --voices")
    if args.speak:
        stats = router.speak_streaming(args.text, backend=args.backend)
        print(f"[{stats['backend']}] 首字 {stats['first_ms']}ms，{stats['sentences']} 句，总计 {stats['total_ms']}ms")
        return 0
    out = router.synthesize(args.text, args.out, backend=args.backend)
    used = router.get_backend(args.backend).name if args.backend else "auto(见实际)"
    print(f"[{used}] 已生成: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
