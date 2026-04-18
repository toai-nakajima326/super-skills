"""
skill_query_trigger.py — AIOS hook for triggering skill-query-generator
Place at: aios/hooks/modules/skill_query_trigger.py

Called at end of each AIOS session or when skill-gap density exceeds threshold.
Runs skill-query-generator.cjs which feeds discovery-query entries into vcontext
for the next self-evolve cycle to consume.
"""

import subprocess
import json
import datetime
import requests
import os
from pathlib import Path

VCONTEXT_URL = "http://127.0.0.1:3150"
SKILLS_ROOT = Path.home() / "skills"
GENERATOR_SCRIPT = SKILLS_ROOT / "scripts" / "skill-query-generator.cjs"

# セッションあたりのギャップ数がこれを超えたらクエリ生成をトリガー
GAP_THRESHOLD = 3


def on_session_end(agent, session_stats: dict):
    """
    Called when an AIOS session ends.
    If significant skill gaps were detected, trigger query generation.
    """
    gap_count = session_stats.get("skill_gaps_detected", 0)
    if gap_count >= GAP_THRESHOLD:
        _run_query_generator(
            reason=f"session_end: {gap_count} skill gaps detected in session '{getattr(agent, 'session_id', '?')}'"
        )


def on_knowledge_gap_detected(agent, topic: str, context: dict):
    """
    Called when an agent explicitly detects a knowledge gap (not just missing tool).
    Immediately triggers query generation for the relevant topic.
    """
    _register_gap(topic, context)
    # ギャップが蓄積されているか確認してからトリガー
    gaps = _count_recent_gaps()
    if gaps >= GAP_THRESHOLD:
        _run_query_generator(reason=f"knowledge_gap: {topic}")


def get_discovery_queries(cycle_id: str = None) -> list[dict]:
    """
    Fetch dynamically generated discovery queries from vcontext.
    Used by AIOS search/research agents to expand their search scope.

    Returns list of {"query": str, "lang": "ja|en", "rationale": str}
    """
    if cycle_id is None:
        # 現在の週次サイクルID (YYYY-WW)
        now = datetime.datetime.utcnow()
        week = (now - datetime.datetime(now.year, 1, 1)).days // 7 + 1
        cycle_id = f"{now.year}-{week:02d}"

    try:
        resp = requests.get(
            f"{VCONTEXT_URL}/recall",
            params={"type": "discovery-query", "tag": f"cycle:{cycle_id}", "limit": 20},
            timeout=5,
        )
        data = resp.json()
        queries = []
        for r in data.get("results", []):
            try:
                c = json.loads(r["content"])
                queries.append({
                    "query": c["query"],
                    "lang": c.get("lang", "en"),
                    "rationale": c.get("rationale", ""),
                })
            except Exception:
                pass
        return queries
    except Exception:
        return []


# ── Internal helpers ────────────────────────────────────────────────────────

def _run_query_generator(reason: str = ""):
    """Fire skill-query-generator.cjs as a subprocess (non-blocking)."""
    if not GENERATOR_SCRIPT.exists():
        return
    try:
        node = _find_node()
        subprocess.Popen(
            [node, str(GENERATOR_SCRIPT)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=str(SKILLS_ROOT),
        )
        _log(f"triggered skill-query-generator: {reason}")
    except Exception as e:
        _log(f"failed to trigger skill-query-generator: {e}")


def _find_node() -> str:
    """Find node executable, preferring nvm-managed v25."""
    nvm_node = Path.home() / ".nvm/versions/node/v25.9.0/bin/node"
    if nvm_node.exists():
        return str(nvm_node)
    return "node"


def _register_gap(topic: str, context: dict):
    """Register a knowledge gap in vcontext."""
    payload = {
        "type": "skill-gap",
        "content": json.dumps({
            "gap": topic,
            "context": context,
            "created_at": datetime.datetime.utcnow().isoformat(),
            "source": "skill_query_trigger",
        }),
        "tags": ["skill-gap", "aios-learning"],
        "session": "aios-autonomous-learning",
    }
    try:
        requests.post(f"{VCONTEXT_URL}/store", json=payload, timeout=3)
    except Exception:
        pass


def _count_recent_gaps() -> int:
    """Count skill-gap entries in the last hour."""
    try:
        resp = requests.get(
            f"{VCONTEXT_URL}/recall",
            params={"type": "skill-gap", "limit": 50},
            timeout=3,
        )
        data = resp.json()
        cutoff = datetime.datetime.utcnow() - datetime.timedelta(hours=1)
        count = 0
        for r in data.get("results", []):
            try:
                c = json.loads(r["content"])
                ts = datetime.datetime.fromisoformat(c.get("created_at", "2000-01-01"))
                if ts > cutoff:
                    count += 1
            except Exception:
                pass
        return count
    except Exception:
        return 0


def _log(msg: str):
    print(f"[skill_query_trigger] {msg}")
