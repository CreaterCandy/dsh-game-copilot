#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""随机 4 位数字探针图 —— 用来判断一个端点到底能不能看图。

为什么不用一张固定测试图：
    有些模型会把训练见过的固定图"背"出来，测不准。每次现生成 4 位数字，
    回复里含这 4 位数才算真看到了。

只用标准库（zlib/struct），不依赖 Pillow：发行版少一个 pip 包。
数字是 5x7 点阵放大 2 倍，64x64 白底黑字 —— 实测 1x1 的 PNG 有些端点直接 400。

用法：
    python probe_digits.py --json                     # {"code":"4821","png":"<base64>"}
    python probe_digits.py --check 4821 "我看到 4821"  # {"ok":true,"code":"4821"}
"""

from __future__ import annotations

import argparse
import base64
import json
import random
import struct
import sys
import zlib

WIDTH = HEIGHT = 64
SCALE = 2

FONT = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
}


def make_code() -> str:
    return "".join(random.SystemRandom().choice("0123456789") for _ in range(4))


def png_bytes(code: str) -> bytes:
    """画一张 64x64 灰度 PNG：白底，4 位黑字居中。"""
    rows = [[255] * WIDTH for _ in range(HEIGHT)]
    glyph_w, glyph_h = 5 * SCALE, 7 * SCALE
    gap = SCALE
    total_w = 4 * glyph_w + 3 * gap
    x0 = (WIDTH - total_w) // 2
    y0 = (HEIGHT - glyph_h) // 2

    for index, digit in enumerate(code[:4]):
        bitmap = FONT.get(digit, FONT["0"])
        dx = x0 + index * (glyph_w + gap)
        for gy, line in enumerate(bitmap):
            for gx, bit in enumerate(line):
                if bit != "1":
                    continue
                for sy in range(SCALE):
                    row = rows[y0 + gy * SCALE + sy]
                    for sx in range(SCALE):
                        row[dx + gx * SCALE + sx] = 0

    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 0, 0, 0, 0)  # 8bit grayscale
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def contains_code(text: str, code: str) -> bool:
    """回复里出现这 4 位数字就算看到了。容忍空格/连字符分隔。"""
    compact = "".join(ch for ch in str(text) if ch.isdigit())
    return code in compact


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="生成一张新探针图，输出 code 与 base64 PNG")
    ap.add_argument("--check", nargs=2, metavar=("CODE", "TEXT"), help="判定回复里有没有那 4 位数")
    args = ap.parse_args()

    if args.check:
        code, text = args.check
        print(json.dumps({"ok": contains_code(text, code), "code": code}, ensure_ascii=False))
        return

    code = make_code()
    print(
        json.dumps(
            {"code": code, "png": base64.b64encode(png_bytes(code)).decode("ascii")},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # 探针失败不能把插件带崩
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
