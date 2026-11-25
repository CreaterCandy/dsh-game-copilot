#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Ctrl+Alt+W：把剪贴板文字用当前 TTS 后端念出来。"""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tts"))


def read_clipboard() -> str:
    import win32clipboard

    win32clipboard.OpenClipboard()
    try:
        text = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
    finally:
        win32clipboard.CloseClipboard()
    return str(text).strip()


def main() -> int:
    text = read_clipboard()
    if not text:
        return 0

    from tts_interface import get_tts

    out = str(ROOT / "out" / "clipboard_reply.wav")
    audio = get_tts().synthesize(text[:1000], out)

    import winsound

    winsound.PlaySound(audio, winsound.SND_FILENAME)
    time.sleep(0.1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
