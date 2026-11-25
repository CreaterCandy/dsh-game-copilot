#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""Ctrl+Alt+T 打字提问的**兜底输入框**：回车把问题交给 ask.py 走同一条问答链路。

正常情况下，热键守护会先请桌宠小窗在小人头顶弹一条气泡式输入条（见 overlay.html
的 #askbar），那里临时把小窗切成可聚焦，视觉和回答气泡完全一致，输入完立刻收回去。
本脚本只在小窗没开 / Electron 缺失 / 插件没连上时由守护回退调用，保证热键永远有反馈。

为什么兜底还要独立 tkinter 窗口：
  * 平时的小窗是 `focusable: false` 的透明穿透窗，收不到键盘（只有输入条弹出那一瞬才会临时可聚焦）；
  * 独立窗口只在按热键时出现，输入完立刻销毁，平时不占焦点、不挡游戏；
  * 键盘事件本地处理，不经过 DSH / 模型端点，文字只在回车后随问题一起送出去。

行为：
  * Enter / 点「问」→ 把文字作为 ask.py 的位置参数启动（截图判断 + 作答 + 气泡/TTS）；
  * Esc / 点「取消」→ 什么都不做，直接关窗；
  * 空问题不发送；窗口置顶但很小，不抢全屏游戏以外的注意力。

注意：Windows 下输入框要拿到键盘焦点，全屏独占游戏会短暂退出全屏——这是系统限制，
和微软 Gaming Copilot 的打字输入一样。不方便的话用 Ctrl+Alt+W 剪贴板问答（全程不切窗）。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PY = ROOT / "venv" / "Scripts" / "pythonw.exe"


def main() -> int:
    import tkinter as tk

    root = tk.Tk()
    root.title("打字提问")
    root.attributes("-topmost", True)
    root.resizable(False, False)
    # 出现在屏幕上方居中，避开右下角的桌宠本体
    w, h = 460, 92
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"{w}x{h}+{(sw - w) // 2}+{max(40, sh // 6)}")

    var = tk.StringVar()
    done = {"sent": False}

    def close() -> None:
        root.destroy()

    def send(_event=None) -> None:
        question = var.get().strip()
        if not question or done["sent"]:
            return
        done["sent"] = True
        python_exe = str(PY) if PY.exists() else sys.executable
        try:
            subprocess.Popen(
                [python_exe, str(ROOT / "ask.py"), question],
                cwd=str(ROOT),
                creationflags=0x00000008,  # CREATE_NO_WINDOW
            )
        finally:
            close()

    entry = tk.Entry(root, textvariable=var, font=("Microsoft YaHei UI", 11))
    entry.pack(side="top", fill="x", padx=12, pady=(12, 6))
    entry.focus_set()
    entry.bind("<Return>", send)
    entry.bind("<Escape>", lambda _e: close())

    bar = tk.Frame(root)
    bar.pack(side="top", fill="x", padx=12, pady=(0, 10))
    tk.Button(bar, text="取消", command=close, width=6).pack(side="right")
    tk.Button(bar, text="问", command=send, width=6).pack(side="right", padx=(0, 6))

    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
