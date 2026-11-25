#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""游戏助理 · 语音输入：按住热键说话 -> 本地 ASR 转写 -> 复用 ask.py 的截图问答+TTS 播报。

两种用法：
  1) 被 hotkey_ask.pyw 调用（推荐）：
       voice_ask.py --record-secs 6        # 录 6 秒后转写并问答
       voice_ask.py --until-key            # 按住 Ctrl+Alt+V 说话，松开即转写（守护进程控制）
  2) 直接对已有 wav 转写：
       voice_ask.py --wav runtime\out\voice.wav

设计：
  * ASR 本地 CPU（faster-whisper small / int8），不占显存、离线可用；音频不出机器。
  * 转写出的文字直接交给 ask.py（同一个 Python 进程里调函数），复用它唯一的
    get_tts().synthesize 入口与"只抓游戏窗口"的截图逻辑。
  * 模型默认从 HF 镜像下载，缓存固定到 runtime\models，不落 C 盘。
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"
OUT_DIR = ROOT / "out"
MODEL_DIR.mkdir(parents=True, exist_ok=True)
OUT_DIR.mkdir(parents=True, exist_ok=True)

# HuggingFace 国内镜像；直连超时，必须走镜像下载模型。
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

MODEL_SIZE = "small"          # small 中文够用；large 在 CPU 上太慢
COMPUTE_TYPE = "int8"         # CPU 量化，内存占用小
LANGUAGE = "zh"
SAMPLE_RATE = 16000


def record_wav(path: str, seconds: float) -> str:
    """用 sounddevice 录一段单声道 16k PCM 并写成 WAV。"""
    import numpy as np
    import sounddevice as sd

    print(f"录音 {seconds:.0f} 秒，请说话……", file=sys.stderr)
    audio = sd.rec(
        int(seconds * SAMPLE_RATE),
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="int16",
    )
    sd.wait()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(audio.tobytes())
    print("录音完成", file=sys.stderr)
    return path


_MODEL = None


def _local_model_dir():
    """本地已下载的模型目录；没有就返回 None。"""
    try:
        hits = [p.parent for p in MODEL_DIR.rglob("model.bin")]
    except OSError:
        return None
    if not hits:
        return None
    for h in hits:
        if MODEL_SIZE in str(h):
            return h
    return hits[0]


def get_model():
    """加载并常驻 ASR 模型（进程内只加载一次）。

    本地已有模型就直接按目录加载，完全不碰网络。原因：huggingface_hub 的
    snapshot_download 即使缓存完整也会先发一次联网校验，代理异常（502/超时）
    会抛 ProxyError 把加载打断——明明装着 464MB 模型，却因为没网用不了，
    正好和"离线可用"相反。
    """
    global _MODEL
    if _MODEL is None:
        from faster_whisper import WhisperModel

        local = _local_model_dir()
        if local is not None:
            print(f"加载 ASR 模型 {local}（{COMPUTE_TYPE}, CPU，本地离线）……", file=sys.stderr)
            try:
                _MODEL = WhisperModel(
                    str(local),
                    device="cpu",
                    compute_type=COMPUTE_TYPE,
                )
                return _MODEL
            except Exception as exc:  # 缓存残缺时退回联网路径
                print(f"本地模型加载失败（{exc}），改为联网加载……", file=sys.stderr)

        # 只有本地没有模型时才允许联网，走国内镜像
        print(f"加载 ASR 模型 {MODEL_SIZE}（{COMPUTE_TYPE}, CPU），首次会下载……", file=sys.stderr)
        _MODEL = WhisperModel(
            MODEL_SIZE,
            device="cpu",
            compute_type=COMPUTE_TYPE,
            download_root=str(MODEL_DIR),
        )
    return _MODEL


def transcribe(wav_path: str) -> str:
    segments, info = get_model().transcribe(
        wav_path,
        language=LANGUAGE,
        beam_size=5,
        vad_filter=True,                 # 静音段跳过，避免把环境噪音转成文字
        vad_parameters={"min_silence_duration_ms": 300},
    )
    text = "".join(seg.text for seg in segments).strip()
    return text


def ask_with_game_screenshot(question: str, backend: str | None = None) -> str:
    """复用 ask.py：抓当前游戏窗口 -> VLM/插件 -> 统一 TTS -> 播放，并返回回答。"""
    sys.path.insert(0, str(ROOT))
    import ask

    jpeg = ask.capture_jpeg(prefer_game=True)
    answer = ask.ask_vlm(question, jpeg)

    from tts_interface import get_tts

    out = str(OUT_DIR / "reply_voice.wav")
    used = get_tts().synthesize(answer, out, backend=backend)
    ask.play_wav(used)
    return answer


def main() -> int:
    parser = argparse.ArgumentParser(description="语音输入 -> 本地转写 -> 截图问答 -> TTS 播报")
    parser.add_argument("--wav", help="直接转写已有 wav，不再录音")
    parser.add_argument("--record-secs", type=float, default=6.0, help="录音秒数（默认 6）")
    parser.add_argument("--no-ask", action="store_true", help="只转写并打印文字，不接 VLM/TTS（调试用）")
    parser.add_argument("--backend", default=None, help="显式 TTS 后端")
    args = parser.parse_args()

    t0 = time.perf_counter()

    if args.wav:
        wav = args.wav
    else:
        wav = str(OUT_DIR / "voice_input.wav")
        record_wav(wav, args.record_secs)

    text = transcribe(wav)
    t_asr = time.perf_counter()

    if not text:
        print("（未识别到语音）", file=sys.stderr)
        return 1

    print(f"识别：{text}", file=sys.stderr)
    print(text)  # stdout 供守护进程/调用方拿到纯文字

    if args.no_ask:
        print(f"ASR 耗时 {t_asr - t0:.2f}s", file=sys.stderr)
        return 0

    answer = ask_with_game_screenshot(text, backend=args.backend)
    print(f"回答：{answer}", file=sys.stderr)
    print(f"总耗时 {time.perf_counter() - t0:.2f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
