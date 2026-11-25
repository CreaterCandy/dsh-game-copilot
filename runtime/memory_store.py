#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""memory_store.py —— 问答记忆：全量日志 + 默认不读 + 按需检索。

设计：
  * 全量留存，不限制轮数（每天一个 jsonl，历史全在盘上）；
  * 默认**不**往 prompt 里塞历史（省 token、省 prefill 延迟）；
  * 只有出现"那 / 这个 / 刚才 / 继续"这类指代，或玩家明说"翻记录"时，
    才去日志里捞最近相关的几条，限量注入（默认 3 条 / 1500 字）。

为什么"全量留存"和"限量注入"要分开：
  日志可以无限长，但 prompt 不能——本地 9B 的上下文有限，云端也按 token 计费计延迟。
  所以存储不设限，注入必须设限。

文件结构：
  runtime\memory\
    index.md                 轻索引，一行一条（时间 | 问题 | 答案首句），可整份读
    session-2026-11-24.jsonl 全量原文，一行一条 JSON

单独跑：
  python memory_store.py --stats          # 有多少条、占多大
  python memory_store.py --recent 10      # 最近 10 条
  python memory_store.py --search 铁矿    # 关键词检索
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MEM_DIR = ROOT / "memory"
INDEX_FILE = MEM_DIR / "index.md"

# ---- DSH 插件配置（设置页改的那份）----
# 记忆模式、TTS 参数这些都搬进了 DSH 设置页（落盘 %DSH_HOME%\dsh-game-pet.json）。
# 读它要按 mtime 缓存：每次按键都 stat 一次只要 0.1ms，但重复 json.loads 没必要。
PLUGIN_CFG_PATH = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh")) / "dsh-game-pet.json"
_PLUGIN_CACHE: dict = {"mtime": None, "data": {}}


def plugin_config() -> dict:
    """读插件配置；文件没变就用缓存。读不到就当空（全部走本地 config.json）。"""
    try:
        mtime = PLUGIN_CFG_PATH.stat().st_mtime
    except OSError:
        _PLUGIN_CACHE["mtime"] = None
        _PLUGIN_CACHE["data"] = {}
        return {}
    if _PLUGIN_CACHE["mtime"] != mtime:
        try:
            raw = PLUGIN_CFG_PATH.read_text(encoding="utf-8").lstrip("\ufeff")
            data = json.loads(raw)
            _PLUGIN_CACHE["data"] = data if isinstance(data, dict) else {}
        except Exception as e:
            print(f"[插件配置] 读不了 {PLUGIN_CFG_PATH}：{e!r}", file=sys.stderr)
            _PLUGIN_CACHE["data"] = {}
        _PLUGIN_CACHE["mtime"] = mtime
    return _PLUGIN_CACHE["data"]


def memory_mode() -> str:
    """设置页选的记忆模式：off / auto（默认，像追问才翻）/ always。"""
    mode = plugin_config().get("memoryMode")
    return mode if mode in ("off", "auto", "always") else "auto"

# 出现这些词，说明这句话可能依赖上文
_PRONOUN_HINTS = (
    "那", "这个", "那个", "刚才", "刚刚", "上面", "前面", "继续", "接着",
    "还有呢", "再算", "它", "这几种", "上面说", "你说的",
)
# 玩家明说要翻旧账
_EXPLICIT_HINTS = ("翻记录", "翻一下", "之前问", "上次问", "历史", "前几天", "昨天", "上周", "查一下记录")


def _today_file(offset_days: int = 0) -> Path:
    day = date.today() - timedelta(days=offset_days)
    return MEM_DIR / f"session-{day.isoformat()}.jsonl"


def needs_recall(question: str) -> bool:
    """这句话需不需要翻历史。规则很轻，命中就跑检索，没命中零开销。"""
    q = (question or "").strip()
    if not q:
        return False
    if any(k in q for k in _EXPLICIT_HINTS):
        return True
    if any(k in q for k in _PRONOUN_HINTS):
        return True
    # 极短的问题通常是追问（"再来一个""为什么"），没有上文答不准
    if len(q) <= 6:
        return True
    return False


def _bigrams(text: str) -> set[str]:
    s = re.sub(r"[^\u4e00-\u9fa5A-Za-z0-9]", "", text or "")
    if len(s) < 2:
        return {s} if s else set()
    return {s[i : i + 2] for i in range(len(s) - 1)}


def _load_recent(limit: int) -> list[dict]:
    """读今天 + 昨天的日志，倒序合并（新在前）。读不到就当没有。"""
    rows: list[dict] = []
    for offset in (0, 1):
        path = _today_file(offset)
        if not path.exists():
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(item, dict) and item.get("q"):
                        rows.append(item)
        except OSError:
            continue
    rows.sort(key=lambda r: r.get("ts", ""), reverse=True)
    return rows[:limit]


def recall(question: str, limit: int = 3, max_chars: int = 1500, force: bool = False) -> list[dict]:
    """按需检索：返回最多 limit 条、总字数不超过 max_chars 的历史，按时间正序。

    不需要翻历史时返回空列表（零成本）。
    force=True 跳过"这句话像不像追问"的判断，直接按相关度捞——
    设置页把记忆模式设成"总是带上"时用这个。
    """
    if limit <= 0 or (not force and not needs_recall(question)):
        return []

    entries = _load_recent(max(limit * 6, 20))
    if not entries:
        return []

    q_grams = _bigrams(question)
    scored = []
    for idx, item in enumerate(entries):
        grams = _bigrams(f"{item.get('q', '')}{item.get('a', '')}")
        overlap = len(q_grams & grams)
        scored.append((overlap, -idx, item))
    # 先按相关度、再按新近
    scored.sort(key=lambda t: (t[0], t[1]), reverse=True)

    picked: list[dict] = []
    total = 0
    for _, _, item in scored:
        cost = len(item.get("q", "")) + len(item.get("a", ""))
        if picked and total + cost > max_chars:
            break
        picked.append({"q": item.get("q", ""), "a": item.get("a", ""), "ts": item.get("ts", "")})
        total += cost
        if len(picked) >= limit:
            break

    picked.sort(key=lambda x: x.get("ts", ""))
    return picked


def append_turn(
    question: str,
    answer: str,
    screen: str = "",
    model: str = "",
    meta: dict | None = None,
) -> None:
    """记一轮问答：写 jsonl（全量）+ 追加 index.md（轻索引）。写失败不影响主流程。"""
    q = (question or "").strip()
    a = (answer or "").strip()
    if not q:
        return

    MEM_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now()
    record = {
        "ts": now.isoformat(timespec="seconds"),
        "q": q,
        "a": a,
        "screen": (screen or "").strip()[:300],
        "model": model or "",
    }
    if meta:
        record.update({k: v for k, v in meta.items() if v is not None})

    try:
        with open(_today_file(0), "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        return

    # 索引只留一眼能扫完的信息，方便整份读进 prompt 当"目录"
    head_a = re.sub(r"\s+", " ", a)[:40]
    line = f"- {now.strftime('%m-%d %H:%M')} | 问：{q[:50]} | 答：{head_a}\n"
    try:
        if not INDEX_FILE.exists():
            INDEX_FILE.write_text("# 问答索引（一行一条，按时间顺序）\n\n", encoding="utf-8")
        with open(INDEX_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass


def search_history(keyword: str, days: int = 7, limit: int = 8) -> list[dict]:
    """关键词检索（"翻记录"用）：扫最近 days 天的 jsonl，命中问题或答案就留。"""
    kw = (keyword or "").strip()
    if not kw:
        return []
    found: list[dict] = []
    for offset in range(days):
        path = _today_file(offset)
        if not path.exists():
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if kw in f"{item.get('q', '')}{item.get('a', '')}":
                        found.append(item)
        except OSError:
            continue
    found.sort(key=lambda r: r.get("ts", ""), reverse=True)
    return found[:limit]


def stats() -> dict:
    """有多少条、占多大——排查"日志是不是涨爆了"用。"""
    files = sorted(MEM_DIR.glob("session-*.jsonl")) if MEM_DIR.exists() else []
    total_bytes = sum(p.stat().st_size for p in files)
    total_rows = 0
    for p in files:
        try:
            with open(p, "r", encoding="utf-8") as f:
                total_rows += sum(1 for line in f if line.strip())
        except OSError:
            continue
    return {"days": len(files), "rows": total_rows, "bytes": total_bytes, "dir": str(MEM_DIR)}


def archive_old(days: int = 90) -> int:
    """超过 days 天的日志压成 .gz，避免目录越滚越大。返回处理了几个文件。"""
    import gzip

    if not MEM_DIR.exists():
        return 0
    cutoff = date.today() - timedelta(days=days)
    count = 0
    for path in MEM_DIR.glob("session-*.jsonl"):
        m = re.match(r"session-(\d{4}-\d{2}-\d{2})\.jsonl$", path.name)
        if not m:
            continue
        try:
            day = date.fromisoformat(m.group(1))
        except ValueError:
            continue
        if day >= cutoff:
            continue
        try:
            with open(path, "rb") as src, gzip.open(f"{path}.gz", "wb") as dst:
                dst.write(src.read())
            path.unlink()
            count += 1
        except OSError:
            continue
    return count


if __name__ == "__main__":
    argv = sys.argv[1:]
    if not argv:
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
    elif argv[0] == "--stats":
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
    elif argv[0] == "--recent":
        n = int(argv[1]) if len(argv) > 1 else 10
        for item in _load_recent(n)[::-1]:
            print(f"[{item.get('ts','')}] 问：{item.get('q','')}\n{' ' * 21}答：{item.get('a','')}")
    elif argv[0] == "--search" and len(argv) > 1:
        for item in search_history(argv[1]):
            print(f"[{item.get('ts','')}] 问：{item.get('q','')}\n{' ' * 21}答：{item.get('a','')}")
    elif argv[0] == "--recall":
        question = " ".join(argv[1:]) or "那要几台"
        print(f"问题：{question}")
        print(f"需要翻历史：{needs_recall(question)}")
        for item in recall(question):
            print(f"  - {item['q']} → {item['a'][:60]}")
    else:
        print(__doc__)
