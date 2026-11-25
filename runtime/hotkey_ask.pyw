#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""后台热键守护：Ctrl+Alt+Q 一键问画面并念出来；Ctrl+Alt+W 念剪贴板文字。

用 pythonw 启动，无控制台窗口。退出：Ctrl+Alt+Shift+Q。
依赖：pywin32（已在 runtime/venv 中）。
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

import win32api
import win32con
import win32gui

ROOT = Path(__file__).resolve().parent
PY = ROOT / "venv" / "Scripts" / "pythonw.exe"
ASK = ROOT / "ask.py"
SPEAK = ROOT / "speak_clipboard.py"

HOTKEY_ASK = 1
HOTKEY_SPEAK = 2
HOTKEY_EXIT = 3
_last_run = 0.0

win32api.RegisterHotKey(
    0, HOTKEY_ASK, win32con.MOD_CONTROL | win32con.MOD_ALT, ord("Q")
)
win32api.RegisterHotKey(
    0, HOTKEY_SPEAK, win32con.MOD_CONTROL | win32con.MOD_ALT, ord("W")
)
win32api.RegisterHotKey(
    0,
    HOTKEY_EXIT,
    win32con.MOD_CONTROL | win32con.MOD_ALT | win32con.MOD_SHIFT,
    ord("Q"),
)


def run(script: Path, args: list[str]) -> None:
    global _last_run
    now = time.monotonic()
    if now - _last_run < 1.5:
        return
    _last_run = now
    subprocess.Popen(
        [str(PY), str(script), *args],
        cwd=str(ROOT),
        creationflags=win32con.CREATE_NO_WINDOW,
    )


def message_loop() -> None:
    while True:
        msg = win32gui.GetMessage(None, 0, 0)
        if msg is None:
            break
        hwnd, message, wparam, _ = msg
        if message != win32con.WM_HOTKEY:
            win32gui.TranslateMessage(msg)
            win32gui.DispatchMessage(msg)
            continue
        if wparam == HOTKEY_ASK:
            run(ASK, [])
        elif wparam == HOTKEY_SPEAK:
            run(SPEAK, [])
        elif wparam == HOTKEY_EXIT:
            break


if __name__ == "__main__":
    try:
        message_loop()
    finally:
        for hk in (HOTKEY_ASK, HOTKEY_SPEAK, HOTKEY_EXIT):
            win32api.UnregisterHotKey(0, hk)
