#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
game-pet 桌宠参谋  →  统一 TTS 播报  的衔接守护
================================================================================
做什么：盯住 DSH 里 dsh-game-pet 的 /state，一旦桌宠给出新建议，就把文字交给
        tts_interface.get_tts().synthesize() 合成语音并播放。这样 game-pet 负责
        "看着游戏局势想说什么"，TTS 负责"把它念出来"，两者解耦。

为什么需要它：game-pet 本身只把建议写在气泡里 + 播动画，**不会出声**。要让它
              开口，就得有人读 /state。这就是那个人。

关键设计（踩过的坑都写在这）：
  1. 端口每次重启都会变（本机实测 64155-57 → 49336-38），所以**自动发现**：
     扫 40000-65535 里 DSH 进程占用的监听端口，逐个试 /dsh-game-pet-7341/state，
     返回 200 的就是。发现后缓存，定时复核，端口变了会自动重新发现。
  2. 只在 presence.playing == true（在玩白名单游戏）时才念，桌宠对 DSH 窗口
     自己说的话不会念出来。
  3. advice.counter 是单调递增的毫秒时间戳，用它判新：<= last_counter 的一律跳过，
     避免同一句重复念（轮询会反复读到同一条）。
  4. 生成在 voices_tmp/，播放完立刻删，不留垃圾。
  5. TTS 后端切换（offline_xiaoxiao / edge_tts）对本脚本透明——只认 get_tts()。

用法：
  python pet_voice_bridge.py            # 前台跑，Ctrl+C 停
  python pet_voice_bridge.py --once     # 只检查一次当前是否有新建议（调试）
  python pet_voice_bridge.py --dry-run  # 只打印会念什么，不真的合成播放

启动：双击 start_pet_voice.cmd（后台无窗口版用 pythonw）
================================================================================
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time

# pythonw 没有控制台，它起动控制台程序（netstat / tasklist / powershell）时，
# Windows 会默认给子进程新开一个控制台窗口——全屏游戏里就是"黑框闪一下"。
# 所有子进程调用必须带这个 flag（2026-11-24 实测：端口缓存 120 秒过期后闪一次）。
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tts"))

ROUTE = "/dsh-game-pet-7341/state"
TMPDIR = ROOT / "voices_tmp"
LOG = ROOT / "pet_bridge_log.jsonl"

POLL_SEC = 1.0
RECHECK_PORT_SEC = 30


def log(msg: str, **kw) -> None:
    import json
    import datetime
    rec = {"ts": datetime.datetime.now().isoformat(timespec="seconds"), "msg": msg, **kw}
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass
    print(f"[{rec['ts']}] {msg}", flush=True)


def _dsh_listen_ports(pids: set[int] | None = None) -> list[int]:
    """列出 LISTENING TCP 端口候选（DSH 端口都在 40000+）。

    给了 pids 就只留这些进程占的端口——实测冷扫从 4809ms 降到几百毫秒（2026-11-24）。
    netstat 最后一列就是 pid，按它过滤比 HTTP 逐个试探靠谱得多。
    **必须传整棵进程树的 pid**：DSH 是 Electron，同名进程有 5 个（实测），
    监听口可能挂在任意一个子进程上（63130 挂在 42268 而不是主进程 1412）。
    不解析中文：只碰端口号与 pid 两列纯数字，errors="replace" 兜住 GBK 乱码。
    """
    ports: set[int] = set()
    unknown = bool(pids) and -1 in pids  # -1 = 进程表查不出来，退化成不过滤
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True, text=True, timeout=8,
            encoding="utf-8", errors="replace", creationflags=_NO_WINDOW,
        ).stdout
        for line in out.splitlines():
            if "LISTENING" not in line:
                continue
            cols = line.split()
            if len(cols) < 5:
                continue
            try:
                port = int(cols[1].rsplit(":", 1)[-1])
                owner = int(cols[4])
            except (ValueError, IndexError):
                continue
            if not 40000 <= port <= 65535:  # DSH 动态端口区间，顺带过滤掉系统低端口
                continue
            if unknown or not pids or owner in pids:
                ports.add(port)
    except Exception as e:
        log("netstat 取端口失败", err=str(e))
    return sorted(ports)


def _dsh_pids() -> set[int] | None:
    """DSH 所有进程的 pid 集合；**None = 确定没开**，`{-1}` = 查不出来（别过滤）。

    为什么要有这一步：DSH 没开时，光靠"枚举高端口逐个 HTTP 试探"要 10 秒以上
    （一堆别的服务占着端口，每个都要等到超时）。按键链路对延迟极敏感，
    所以先用进程表快速否决；拿到 pid 还能让端口筛选只探 DSH 自己的口。
    要收**全部同名进程**：Electron 主进程、渲染、utility 都叫这个名，
    只取第一个会漏掉真正监听的那个（踩过）。
    CSV 用 split('","') 切，避开进程名里的空格；只需 ASCII 名和数字 pid，不碰中文。
    """
    try:
        out = subprocess.run(
            ["tasklist", "/NH", "/FO", "CSV", "/FI", "IMAGENAME eq DeepSeek Harness.exe"],
            capture_output=True, text=True, timeout=3,
            encoding="utf-8", errors="replace", creationflags=_NO_WINDOW,
        ).stdout
        pids: set[int] = set()
        for line in out.splitlines():
            cells = [c.strip().strip('"') for c in line.split('","')]
            if len(cells) >= 2 and cells[0].lower().endswith("deepseek harness.exe"):
                try:
                    pids.add(int(cells[1]))
                except ValueError:
                    continue
        return pids or None  # 进程表里一条都没有 → 确实没开
    except Exception:
        return {-1}  # 查不出来就别拦着，走正常端口探测


# 找到过的端口记一下：插件每次重启才换端口，短时间内不用重扫
_PORT_CACHE: dict = {"port": None, "at": 0.0}
_PORT_CACHE_TTL = 120.0


def _probe(port: int, timeout: float = 0.4) -> bool:
    """这个端口是不是 game-pet（响应里同时有 advice / presence 两片）。"""
    import json
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{ROUTE}", timeout=timeout) as r:
            if r.status != 200:
                return False
            body = json.loads(r.read().decode("utf-8"))
            sec = body.get("sections", {})
            # 不能要求 advice 一定在：它是"产生过建议之后"才写入的一片。
            # 刚装好/自动看关着/还没提问时只有 presence+pet，旧判据会漏掉真插件，
            # 表现为"DSH 开着却一直找不到端口"，按键链路白等后回退本地。
            return "presence" in sec and ("advice" in sec or "pet" in sec)
    except Exception:
        return False


def discover_port() -> int | None:
    """找到 game-pet 端口就返回；带小重试。

    踩过的坑（2026-11-24）：忙时（上一轮 TTS 正在播、系统负载高）单次 HTTP
    探测用 0.4s 超时会偶发失败。旧代码失败后直接清缓存返回 None，
    按键链路就以为"DSH 没开"退回本地兜底——本地没配端点时用户完全收不到
    回复，且真实原因被"没填模型端点"掩盖。实测连探 10 次有 1 次是 None。
    现在每轮探测重试 3 次（0.15s 间隔、0.8s 超时），基本消除这种偶发哑火。
    """
    import time as _time

    def probe_retry(port: int) -> bool:
        for attempt in range(3):
            if _probe(port, timeout=0.8):
                return True
            if attempt < 2:
                _time.sleep(0.15)
        return False

    cached = _PORT_CACHE["port"]
    if cached and _time.time() - _PORT_CACHE["at"] <= _PORT_CACHE_TTL:
        if probe_retry(cached):
            return cached
        # 缓存端口连续 3 次都不通，基本可以确定插件换了端口
        _PORT_CACHE["port"] = None

    # 枚举也重试一轮：netstat/tasklist 偶发取不到（进程刚起、系统忙）
    for _round in range(2):
        pids = _dsh_pids()
        if pids is None:  # 进程表里确实没有 DSH，不用再扫
            _PORT_CACHE["port"] = None
            return None
        for p in _dsh_listen_ports(pids):
            if probe_retry(p):
                log("发现 game-pet 端口", port=p)
                _PORT_CACHE["port"] = p
                _PORT_CACHE["at"] = _time.time()
                return p
        if _round == 0:
            _time.sleep(0.25)
    return None


def read_state(port: int) -> dict | None:
    import json
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{ROUTE}", timeout=3) as r:
            if r.status == 200:
                return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None
    return None


def play_wav(path: str) -> None:
    """用系统默认播放器播 WAV，跨平台兜底：win32 → powershell → SDL。"""
    try:
        import winsound
        winsound.PlaySound(path, winsound.SND_FILENAME)
        return
    except Exception:
        pass
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(New-Object Media.SoundPlayer '{path}').PlaySync()"],
            timeout=120, creationflags=_NO_WINDOW,
        )
        return
    except Exception:
        pass
    try:
        import pygame
        pygame.mixer.init()
        pygame.mixer.music.load(path)
        pygame.mixer.music.play()
        while pygame.mixer.music.get_busy():
            time.sleep(0.1)
    except Exception as e:
        log("没有可用播放器", err=str(e))


def main() -> int:
    ap = argparse.ArgumentParser(description="game-pet 建议 → TTS 播报桥接")
    ap.add_argument("--once", action="store_true", help="只检查一次，打印当前建议")
    ap.add_argument("--dry-run", action="store_true", help="只打印会念什么，不合成播放")
    args = ap.parse_args()

    from tts_interface import get_tts
    tts = get_tts()
    TMPDIR.mkdir(parents=True, exist_ok=True)

    port = discover_port()
    if port is None:
        log("没找到 game-pet 端口——确认 DSH 已启动且 dsh-game-pet 已加载")
        return 1

    last_counter = 0
    # 启动时把当前 counter 记为已读，避免把历史那句翻出来重念。
    # 但 --once/--dry-run 是调试模式：不吞掉当前这条，方便确认能读到建议。
    st = read_state(port)
    if st:
        # 刚启动还没出过建议时 /state 里根本没有 advice 段（只有 presence/pet），
        # 以前直接下标取会 KeyError 崩掉——播报桥就永远起不来。
        advice = (st.get("sections") or {}).get("advice") or {}
        current_counter = int(advice.get("counter", 0) or 0)
        if args.once or args.dry_run:
            cur_say = ((advice.get("data") or {}).get("say") or "").strip()
            log("当前建议（调试模式，不视为新）", counter=current_counter, say=cur_say[:60])
            last_counter = 0  # 让下面的循环把这条当新的处理
        else:
            last_counter = current_counter
            log("起始 counter", value=last_counter)

    next_port_check = time.time() + RECHECK_PORT_SEC
    log("桥接守护启动", port=port, tts=tts.default_backend)

    while True:
        if time.time() >= next_port_check:
            probe = read_state(port)
            if probe is None:
                log("端口失联，重新发现")
                new = discover_port()
                if new is None:
                    time.sleep(POLL_SEC)
                    continue
                port = new
            next_port_check = time.time() + RECHECK_PORT_SEC

        st = read_state(port)
        if not st:
            time.sleep(POLL_SEC)
            continue
        sec = st.get("sections", {})
        pres = sec.get("presence", {}).get("data", {})
        adv = sec.get("advice", {})
        counter = int(adv.get("counter", 0) or 0)
        data = adv.get("data", {}) or {}
        say = (data.get("say") or "").strip()
        playing = bool(pres.get("playing"))

        if counter > last_counter:
            last_counter = counter
            source = str(data.get("source") or "")
            if source == "ask":
                # 按键问答的回答由 ptt_voice 自己念（那边首字更快、还能带记忆），
                # 这里必须跳过，否则同一句话会被念两遍。
                log("按键问答的回答由按键脚本播报，跳过", say=say[:40])
            elif not playing:
                log("有新建议但没在游戏，跳过", say=say[:40])
            elif not say:
                log("有新建议但 say 为空，跳过")
            elif args.dry_run:
                log("DRY-RUN 会念", say=say)
            else:
                log("新建议，开始播报", say=say, counter=counter)
                wav = str(TMPDIR / f"pet_{counter}.wav")
                try:
                    out = tts.synthesize(say, wav)
                    play_wav(out)
                    log("播报完成", file=out)
                except Exception as e:
                    log("播报失败", err=str(e))
                finally:
                    for p in (wav, wav.replace(".wav", ".edge.mp3")):
                        try:
                            if os.path.exists(p):
                                os.remove(p)
                        except Exception:
                            pass

        if args.once:
            log("单次检查结束", counter=counter, playing=playing)
            return 0
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    sys.exit(main())
