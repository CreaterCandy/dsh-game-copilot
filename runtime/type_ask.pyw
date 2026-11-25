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

外观：兜底窗也画成圆角气泡（Canvas + transparentcolor 裁圆角 + 底部小尖角），配色跟随
设置页选的气泡样式（classic/comic/glass/hud/plain），和小窗气泡输入条一个观感。
Enter 发送、Esc 取消是默认操作，界面不再用小字重复说明。

注意：Windows 下输入框要拿到键盘焦点，全屏独占游戏会短暂退出全屏——这是系统限制，
和微软 Gaming Copilot 的打字输入一样。不方便的话用 Ctrl+Alt+W 剪贴板问答（全程不切窗）。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PY = ROOT / "venv" / "Scripts" / "pythonw.exe"

# 与小窗 overlay.html 五套气泡同款配色（半透明用不透明近似，tkinter 无 per-widget alpha）
# edge=None 表示无描边；tail 是底部小尖角的颜色，一般同 bg
THEMES = {
    "classic": dict(bg="#16161b", fg="#f4f4f6", edge=None, r=13, tail="#16161b"),
    "comic": dict(bg="#fffdf3", fg="#221a10", edge="#221a10", r=14, tail="#fffdf3", hard=True),
    "glass": dict(bg="#232330", fg="#ffffff", edge="#8a8a9a", r=16, tail="#232330"),
    "hud": dict(bg="#061218", fg="#b9ffe9", edge="#40ffd6", r=5, tail="#061218", mono=True),
    "plain": dict(bg="#101014", fg="#ffffff", edge=None, r=6, tail="#101014"),
}


def load_bubble_prefs() -> tuple[str, int]:
    """读设置页的气泡样式和字号；读不到就用默认经典款，绝不让兜底窗起不来。"""
    try:
        sys.path.insert(0, str(ROOT))
        import memory_store

        cfg = memory_store.plugin_config() or {}
        style = str(cfg.get("bubbleStyle") or "classic")
        size = cfg.get("bubbleFontSize")
        size = int(size) if isinstance(size, (int, float)) else 13
        return style, max(11, min(20, size))
    except Exception:
        return "classic", 13


def main() -> int:
    import tkinter as tk

    style, font_size = load_bubble_prefs()
    theme = THEMES.get(style, THEMES["classic"])
    bg, fg, edge, radius = theme["bg"], theme["fg"], theme["edge"], theme["r"]

    root = tk.Tk()
    root.overrideredirect(True)  # 无系统边框，自己画气泡
    root.attributes("-topmost", True)
    root.resizable(False, False)

    w, h = 380, 62
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    # 屏幕上方居中，避开右下角的桌宠本体
    root.geometry(f"{w}x{h}+{(sw - w) // 2}+{max(40, sh // 6)}")

    # 透明色裁圆角：canvas 角落是这个色 → 变透明，露出桌面；内容不用这个色就不受影响
    key = "#010203"
    try:
        root.attributes("-transparentcolor", key)
    except tk.TclError:
        pass  # 非 Windows 不支持，最多是方角，功能不受影响

    cv = tk.Canvas(root, width=w, height=h, bg=key, highlightthickness=0, bd=0)
    cv.pack(fill="both", expand=True)

    def round_rect(x1, y1, x2, y2, r, **kw):
        """Canvas 画圆角矩形：四角扇形 + 两块矩形拼，同色叠加无缝。"""
        cv.create_arc(x1, y1, x1 + 2 * r, y1 + 2 * r, start=90, extent=90, style="pieslice", **kw)
        cv.create_arc(x2 - 2 * r, y1, x2, y1 + 2 * r, start=0, extent=90, style="pieslice", **kw)
        cv.create_arc(x1, y2 - 2 * r, x1 + 2 * r, y2, start=180, extent=90, style="pieslice", **kw)
        cv.create_arc(x2 - 2 * r, y2 - 2 * r, x2, y2, start=270, extent=90, style="pieslice", **kw)
        cv.create_rectangle(x1 + r, y1, x2 - r, y2, **kw)
        cv.create_rectangle(x1, y1 + r, x2, y2 - r, **kw)

    body_y2 = h - 10  # 底部给小尖角留位置
    # 漫画款：先画硬阴影再画主体，做出描边+错位阴影
    if theme.get("hard"):
        round_rect(5, 5, w - 1, body_y2 + 4, radius, fill=edge)
    # 有描边的样式：外层描边色 + 内层底色（内缩 2px）
    if edge:
        round_rect(3, 3, w - 3, body_y2, radius, fill=edge)
        round_rect(5, 5, w - 5, body_y2 - 2, max(2, radius - 2), fill=bg)
    else:
        round_rect(3, 3, w - 3, body_y2, radius, fill=bg)

    # 底部小尖角，指向下方的小人方向
    tail_cx = 30
    cv.create_polygon(
        [tail_cx - 8, body_y2 - 2, tail_cx + 8, body_y2 - 2, tail_cx, h - 2],
        fill=theme["tail"], outline="",
    )

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

    font = ("Consolas", font_size) if theme.get("mono") else ("Microsoft YaHei UI", font_size)
    entry = tk.Entry(
        cv, textvariable=var, font=font, bd=0, highlightthickness=0,
        relief="flat", bg=bg, fg=fg, insertbackground=fg,
    )
    cv.create_window(tail_cx + 16, body_y2 / 2, window=entry, anchor="w", width=w - tail_cx - 34, height=28)
    entry.focus_set()
    entry.bind("<Return>", send)
    entry.bind("<Escape>", lambda _e: close())

    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
