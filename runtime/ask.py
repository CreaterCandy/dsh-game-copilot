#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""游戏内 AI 助理一键问答：截图 -> 本地视觉模型 -> TTS 播报。

用法：
  ask.py "矿机为什么停了"
  ask.py --clipboard
  ask.py --no-shot "只按文字回答"

设计：只负责编排；TTS 一律走 runtime/tts/tts_interface.py 的 get_tts()。
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TTS_DIR = ROOT / "tts"
sys.path.insert(0, str(TTS_DIR))

OUT_DIR = ROOT / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)

SYSTEM_PROMPT = (
    "你是玩家电脑上的游戏助理。先用截图认出正在玩哪款游戏，再按那款游戏的玩法作答；"
    "没认出来就按画面里的实际局势答，别硬套别的游戏。"
    "用中文口语回答，把结论说成完整的句子，不要只回答一个数字、一个词或几个字。"
    "算数题：按用户给的数字算准，只回答一句结论句，不要复述题目条件、不要写推导过程。"
    "例如问『这堆矿能造几个炉子』，只回答『这些矿可以造8个炉子』。"
    "不要只回答『8』，也不要把『每分钟产120个煤』这类已知条件念出来。"
    "其余问题：给一条最有用的可执行建议，一句话说完，要贴当前这款游戏。"
    "不要描述界面、不要复述 UI、不要编造看不清的数字。"
    "重要：回答是念给玩家听的，纯文字口语，绝对不要用 Markdown 格式——"
    "不要星号、井号、反引号、方括号等任何特殊符号，只用普通中文和标点。"
)


# 这些是助理自己/宿主/常见工具窗口，不该当成"正在玩的游戏"去截。
# 只按标题排除，命中就跳过；其余任何可见大窗口都算游戏（不写死具体游戏名）。
NON_GAME_HINTS = (
    "dsh-game-copilot", "dsh-game-pet", "game pet", "桌宠", "助理", "deepseek harness",
    "settings", "设置", "workbuddy", "codebuddy", "powershell", "cmd",
    "explorer", "资源管理器", "terminal", "visual studio", "cursor",
)


def find_game_window() -> tuple[int, tuple[int, int, int, int]] | None:
    """找当前前台的可见窗口作为"正在玩的游戏"（不写死具体游戏名）。

    优先取前台窗口——按住说话键时玩家正在交互的就是它；前台不合适时
    退回"面积最大的非排除窗口"。返回 (hwnd, rect)，最小化/太小返回 None。
    """
    try:
        import win32gui
    except Exception:
        return None

    def usable(hwnd: int, rect: tuple[int, int, int, int]) -> bool:
        left, top, right, bottom = rect
        # -32000 是 Windows 最小化窗口的哨兵坐标；这种窗口抓不到内容。
        if min(left, top, right, bottom) < -20000:
            return False
        # 太小的基本是托盘/启动器/小窗，不是游戏画面。
        return (right - left) >= 400 and (bottom - top) >= 300

    def is_non_game(hwnd: int) -> bool:
        try:
            low = win32gui.GetWindowText(hwnd).lower()
        except Exception:
            return False
        return any(hint in low for hint in NON_GAME_HINTS)

    # ① 前台窗口最准：玩家按键时正在交互的就是它。
    try:
        fg = win32gui.GetForegroundWindow()
        if fg and win32gui.IsWindowVisible(fg) and not is_non_game(fg):
            rect = win32gui.GetWindowRect(fg)
            if usable(fg, rect):
                return fg, rect
    except Exception:
        pass

    # ② 前台不合适（桌宠/设置页抢了焦点）：退回面积最大的非排除窗口。
    found: list[tuple[int, tuple[int, int, int, int]]] = []

    def visit(hwnd: int, _: object) -> None:
        if not win32gui.IsWindowVisible(hwnd) or is_non_game(hwnd):
            return
        rect = win32gui.GetWindowRect(hwnd)
        if usable(hwnd, rect):
            found.append((hwnd, rect))

    win32gui.EnumWindows(visit, None)
    if not found:
        return None
    return max(
        found, key=lambda item: max(0, item[1][2] - item[1][0]) * max(0, item[1][3] - item[1][1])
    )


# ── 要不要截屏 ────────────────────────────────────────────────────────────
# 截屏 + 9B 识图是每句话最大的固定开销（实测 ≈1.0 s，早先估的 1.8–2.1 s 偏高）。
# 但"漏截"的代价远比"多截"大：模型看不到画面时不会说"我看不到"，
# 而是就地编一个听起来合理的答案（实测问"你看我屏幕上现在该干什么"，
# 无图时它答"先看已完成的阶段能不能领奖励"，跟画面毫无关系）。
# 所以默认走 smart —— 反向判断：只有"一看就是纯文字题"才跳过，其余一律截。
SHOT_HINTS = (
    "画面", "屏幕", "这里", "这儿",
    "看到", "看见", "眼前", "界面", "这张", "地上", "手上",
)
# 纯文字题的标志：算数、定义、原理、翻译这类看了屏幕也没用。
# 命中这些（且没命中上面的画面词）就跳过截图。
TEXT_ONLY_HINTS = (
    "等于", "多少", "几加", "除以", "乘以", "怎么算", "换算", "算一下",
    "是什么", "什么意思", "区别", "翻译", "怎么拼", "定义", "公式", "原理",
)
# auto（旧行为）：只认"要看画面"的信号词，容易漏，留作可选项。
# "这个/那个" 单独出现太容易误伤（"这个游戏怎么玩"根本不用看屏幕），
# 只有后面跟着"看得见的东西"时才算信号；跟这些词就走纯文字。
SOFT_HINTS = ("这个", "那个")
SOFT_EXCLUDE = ("游戏", "问题", "任务", "事情", "功能", "时候", "版本", "设置", "玩法", "意思")


def need_shot(text: str, mode: str = "smart") -> bool:
    """这句话要不要配图。

    smart（默认）：命中画面词 → 截；像纯文字题 → 跳过；拿不准 → 截（宁可多花 1 秒，
                   也不让模型瞎编）。
    auto         ：只认"要看画面"的信号词，其余跳过（省得最多，但会漏）。
    always/never ：强制全截 / 强制不截。
    """
    mode = (mode or "smart").strip().lower()
    if mode == "always":
        return True
    if mode == "never":
        return False
    said = str(text or "")
    if any(hint in said for hint in SHOT_HINTS):
        return True

    if mode == "auto":
        for hint in SOFT_HINTS:
            start = said.find(hint)
            while start != -1:
                tail = said[start + len(hint) :]
                if not any(tail.startswith(word) for word in SOFT_EXCLUDE):
                    return True
                start = said.find(hint, start + len(hint))
        return False

    # smart：反向判据 —— 明确像纯文字题才跳过，剩下的一律截
    if any(hint in said for hint in TEXT_ONLY_HINTS):
        return False
    return True


# ── 截哪块屏 ──────────────────────────────────────────────────────────────
# 两台显示器：主屏 (0,0)-(2560,1440)、副屏 (2560,0)-(4480,1080)。
# "all" 是把两块拼一起（4480 宽），缩到 1600 之后每块只剩 900 多像素宽，
# 细节全丢，VLM 只会挑其中一块描述——这就是"看着像截了副屏"的由来。
CAPTURE_TARGETS = ("auto", "primary", "secondary", "all")


def list_monitors() -> list[dict]:
    """列出显示器（mss 顺序，下标 1 起；0 是虚拟全屏）。"""
    import mss

    with mss.MSS() as sct:
        out = []
        for index, mon in enumerate(sct.monitors):
            out.append({"index": index, **mon})
        return out


def pick_monitor(sct, monitor="auto") -> tuple[dict, str]:
    """按名字挑一块屏，返回 (region, 说明)。挑不到就退回主屏。"""
    want = str(monitor or "auto").strip().lower()
    monitors = sct.monitors
    if want == "all":
        return monitors[0], "all"
    if want in ("primary", "secondary", "window"):
        primaries = [m for m in monitors[1:] if m.get("is_primary")]
        others = [m for m in monitors[1:] if not m.get("is_primary")]
        if want == "primary" and primaries:
            return primaries[0], "primary"
        if want == "secondary" and others:
            return others[0], "secondary"
        # 只有一块屏时 secondary 退回主屏
        return (primaries[0] if primaries else monitors[1]), "primary"
    if want.isdigit():
        idx = int(want)
        if 1 <= idx < len(monitors):
            return monitors[idx], f"#{idx}"
    # auto / 认不出：主屏
    primaries = [m for m in monitors[1:] if m.get("is_primary")]
    return (primaries[0] if primaries else monitors[1]), "primary"


def capture_jpeg(
    max_width: int = 1600,
    prefer_game: bool = True,
    monitor: str = "auto",
    info: dict | None = None,
) -> bytes:
    """截一张 JPEG。

    monitor: auto（有游戏截游戏，没有截主屏）/ primary / secondary / all / "1".."n"
    info:    传一个 dict 进来，会填入实际截的区域，便于日志核对
    """
    import mss
    from PIL import Image

    with mss.MSS() as sct:
        region = None
        source = ""
        if prefer_game:
            target = find_game_window()
            if target is not None:
                left, top, right, bottom = target[1]
                virtual = sct.monitors[0]
                left = max(left, virtual["left"])
                top = max(top, virtual["top"])
                right = min(right, virtual["left"] + virtual["width"])
                bottom = min(bottom, virtual["top"] + virtual["height"])
                if right > left and bottom > top:
                    region = {
                        "left": left,
                        "top": top,
                        "width": right - left,
                        "height": bottom - top,
                    }
                    source = "game"
            if region is None and str(monitor or "auto").lower() != "auto":
                print(
                    "提示：未找到可见的游戏窗口，按 monitor 设置截图。",
                    file=sys.stderr,
                )
        if region is None:
            region, source = pick_monitor(sct, monitor)
        raw = sct.grab(region)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

    orig = f"{img.width}x{img.height}"
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    if info is not None:
        info.update(
            {
                "source": source,
                "monitor": str(monitor or "auto"),
                "left": region["left"],
                "top": region["top"],
                "orig": orig,
                "width": img.width,
                "height": img.height,
                "bytes": len(buf.getvalue()),
            }
        )
    return buf.getvalue()



def read_clipboard() -> str:
    import win32clipboard

    win32clipboard.OpenClipboard()
    try:
        data = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
    finally:
        win32clipboard.CloseClipboard()
    return str(data).strip()


LAST_REASONING = ""   # 最近一次 VLM 调用的思考链（reasoning_content），供日志诊断
LAST_USAGE: dict = {}  # 最近一次 token 用量


def ask_api() -> dict:
    """本地直连兜底用的端点 —— 从插件配置读，全项目只有那一份配置。

    优先作答槽 askApi，没填就用识图槽 visionApi；两者都没有就返回空，
    调用方会给出明确报错，而不是偷偷打某个硬编码地址。
    """
    try:
        import memory_store

        cfg = memory_store.plugin_config()
    except Exception:
        return {}
    for key in ("askApi", "visionApi"):
        api = cfg.get(key) or {}
        if api.get("enabled", True) and api.get("baseURL") and api.get("model"):
            return {
                "url": str(api["baseURL"]).rstrip("/") + "/chat/completions",
                "model": str(api["model"]),
                "key": str(api.get("apiKey") or ""),
                "format": str(api.get("format") or "openai"),
            }
    return {}


def ask_vlm(question: str, jpeg: bytes | None) -> str:
    import urllib.request
    import urllib.error

    global LAST_REASONING, LAST_USAGE

    api = ask_api()
    if not api:
        raise RuntimeError("还没填模型端点：去设置页「模型与能力」填一个 OpenAI 兼容端点（本地或云端）")
    if api["format"] != "openai":
        raise RuntimeError(f"本地兜底只支持 openai 兼容端点，当前填的是 {api['format']}")

    content: list[dict] = [{"type": "text", "text": question}]
    if jpeg is not None:
        b64 = base64.b64encode(jpeg).decode("ascii")
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})

    body = json.dumps(
        {
            "model": api["model"],
            "temperature": 0.2,
            "max_tokens": 512,  # 推理模式要留足预算给思考链，256 会挤爆导致正文瞎编
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")

    req = urllib.request.Request(
        api["url"],
        data=body,
        headers={
            "Authorization": f"Bearer {api['key']}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    msg = payload["choices"][0]["message"]
    LAST_REASONING = (msg.get("reasoning_content") or "").strip()
    LAST_USAGE = payload.get("usage", {}) or {}
    return (msg.get("content") or "").strip()


def discover_plugin_port() -> int | None:
    """找 DSH 桌宠插件的 HTTP 端口（插件每次启动端口都随机）。"""
    try:
        import pet_voice_bridge as bridge

        return bridge.discover_port()
    except Exception:
        return None


_CAPABILITY_CACHE: dict = {"at": 0.0, "data": {}}


def plugin_capability() -> dict:
    """问插件当前是不是盲答档（60 秒缓存）。

    盲答档必须不截图：作答端看不到图，截了只是白抓一次屏、还把画面发给
    一个不会看它的端点。拿不到插件就当"不是盲答"，保持老行为不哑火。
    """
    now = time.monotonic()
    cached = _CAPABILITY_CACHE["data"]
    if cached and now - _CAPABILITY_CACHE["at"] < 60:
        return cached
    port = discover_plugin_port()
    if not port:
        return {"blind": False}
    try:
        import urllib.request

        url = f"http://127.0.0.1:{port}/dsh-game-copilot-7341/vision/capability"
        with urllib.request.urlopen(url, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        _CAPABILITY_CACHE["at"] = now
        _CAPABILITY_CACHE["data"] = data
        return data
    except Exception:
        return {"blind": False}


def ask_via_plugin(
    question: str,
    jpeg: bytes | None,
    history: list[dict] | None = None,
    model: str | None = None,
    timeout: float = 90.0,
) -> tuple[str, dict]:
    """把「问题 + 截图 + 相关历史」POST 给 DSH 桌宠插件的 /ask。

    插件那边负责选模型、调模型、写 /state 驱动气泡和动画；这里只负责送和收。
    连不上或失败就抛异常，调用方回退到 ask_vlm 本地直连（不能让按键哑火）。

    返回 (回答, 元信息{elapsed, mode, elapsed_ms, animation})
    """
    import urllib.request

    port = discover_plugin_port()
    if not port:
        raise RuntimeError("没找到 DSH 桌宠插件端口（DSH 没开 / 插件没加载）")

    url = f"http://127.0.0.1:{port}/dsh-game-copilot-7341/ask"
    payload: dict = {"question": question, "history": history or []}
    if jpeg:
        payload["image"] = base64.b64encode(jpeg).decode("ascii")
        payload["imageType"] = "image/jpeg"
    if model:
        payload["model"] = model

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"content-type": "application/json"}, method="POST"
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    elapsed = time.perf_counter() - t0

    if not body.get("ok"):
        raise RuntimeError(f"插件问答失败：{body.get('reason')} {body.get('message', '')}".strip())
    answer = str(body.get("answer") or "").strip()
    if not answer:
        raise RuntimeError("插件返回了空回答")
    return answer, {
        "elapsed": elapsed,
        "mode": body.get("mode"),
        "elapsed_ms": body.get("elapsedMs"),
        "animation": body.get("animation"),
        # 这句话到底是哪个模型出的：provider/model=DSH 会话模型，custom:*=自定义端点
        "answeredBy": body.get("answeredBy"),
    }


def play_wav(path: str) -> None:
    import winsound

    winsound.PlaySound(path, winsound.SND_FILENAME)

def wav_seconds(path: str) -> float:
    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description="游戏助理：截图问本地模型并念出来")
    parser.add_argument("question", nargs="?", default="", help="要问的问题")
    parser.add_argument("--clipboard", action="store_true", help="从剪贴板读取问题")
    parser.add_argument("--no-shot", action="store_true", help="不截屏，只按文字问")
    parser.add_argument("--full-screen", action="store_true", help="强制整屏截图，而不是只抓游戏窗口")
    parser.add_argument("--backend", default=None, help="显式指定 TTS 后端，默认按 config.json")
    parser.add_argument("--no-speak", action="store_true", help="只出文字和音频文件，不播放")
    parser.add_argument("--no-plugin", action="store_true", help="不经过 DSH 桌宠插件，直接问本地模型")
    args = parser.parse_args()

    question = args.question.strip()
    if args.clipboard:
        question = read_clipboard()
    if not question:
        question = "看一眼当前画面，只说一条最有用的建议。"

    t0 = time.perf_counter()
    # 盲答档（作答端看不了图、也没配识图端）直接不截图 —— 省一次抓屏，
    # 更重要的是不让画面发到一个根本不会看它的端点。
    capability = plugin_capability() if not args.no_plugin and not args.no_shot else {}
    blind = bool(capability.get("blind"))
    jpeg = None if (args.no_shot or blind) else capture_jpeg(prefer_game=not args.full_screen)
    t_shot = time.perf_counter()

    answer = None
    route = "plugin"
    meta: dict = {}
    history: list[dict] = []
    if not args.no_plugin:
        import memory_store

        # 记忆模式跟设置页保持一致（off / auto / always）
        mode = memory_store.memory_mode()
        history = [] if mode == "off" else memory_store.recall(question, force=(mode == "always"))
        try:
            answer, meta = ask_via_plugin(question, jpeg, history=history)
        except Exception as e:
            meta = {"error": repr(e)}
    if answer is None:
        route = "local"
        answer = ask_vlm(question, jpeg)
    t_vlm = time.perf_counter()

    from tts_interface import get_tts

    tts = get_tts()
    out = str(OUT_DIR / "reply.wav")
    if args.no_speak:
        used = tts.synthesize(answer, out, backend=args.backend)
        tts_stats: dict = {"backend": tts.get_backend(args.backend).name}
    else:
        # 分句流式：第一句合成完就开口，不用等全文
        tts_stats = tts.speak_streaming(answer, backend=args.backend, out_dir=str(OUT_DIR / "tts_seg"))
        used = str(OUT_DIR / "tts_seg")
    t_tts = time.perf_counter()

    record = {
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "question": question,
        "answer": answer,
        "route": route,
        "ask_mode": meta.get("mode"),
        "ask_ms": meta.get("elapsed_ms"),
        "ask_error": meta.get("error"),
        "memory_used": len(history),
        "reasoning": LAST_REASONING,  # 思考链全文，诊断"胡言乱语"用
        "usage": LAST_USAGE,
        "audio": used,
        "latency": {
            "capture_s": round(t_shot - t0, 3),
            "vlm_s": round(t_vlm - t_shot, 3),
            "tts_s": round(t_tts - t_vlm, 3),
            "tts_first_ms": tts_stats.get("first_ms"),
            "total_to_audio_s": round(t_tts - t0, 3),
            "audio_seconds": round(wav_seconds(used), 3) if used.endswith(".wav") else None,
        },
    }
    with open(ROOT / "ask_log.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    if not args.no_plugin:
        try:
            import memory_store

            memory_store.append_turn(question, answer, screen=str(meta.get("screen") or ""), model=str(meta.get("mode") or route))
        except Exception:
            pass

    print(answer)
    print(json.dumps(record["latency"], ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
