"""
skill_gap_detector.py — AIOS hook for detecting skill gaps
Place at: aios/hooks/modules/skill_gap_detector.py

Fires when an agent encounters a missing tool/skill, registering a
skill-suggestion in vcontext for the next self-evolve cycle to pick up.
"""

import json
import datetime
import requests

VCONTEXT_URL = "http://127.0.0.1:3150"
MIN_CONFIDENCE = 0.6


def on_tool_not_found(agent, tool_name: str, context: dict):
    """Called when an agent requests a tool that doesn't exist."""
    _register_suggestion(
        name=tool_name,
        reason=f"Agent '{getattr(agent, 'name', '?')}' required tool '{tool_name}' but it was not found",
        context=context,
        confidence=0.7,
    )


def on_task_failed_with_missing_skill(agent, task: str, error: str):
    """Called when a task fails due to a missing capability."""
    analysis = _analyze_gap(task, error)
    if analysis and analysis.get("confidence", 0) >= MIN_CONFIDENCE:
        _register_suggestion(
            name=analysis["suggested_skill"],
            reason=analysis["reasoning"],
            context={"task": task, "error": error},
            confidence=analysis["confidence"],
        )


def on_skill_used(agent, skill_name: str, result: dict):
    """Track every skill usage — feeds into fitness.adoption_rate."""
    payload = {
        "type": "skill-usage",
        "content": json.dumps({
            "skill": skill_name,
            "agent": getattr(agent, "name", "unknown"),
            "success": result.get("success", True),
            "session_id": getattr(agent, "session_id", "unknown"),
            "timestamp": datetime.datetime.utcnow().isoformat(),
        }),
        "tags": ["skill-usage", f"skill:{skill_name}"],
        "session": getattr(agent, "session_id", "system"),
    }
    _silent_post(payload)


# ── Internal helpers ────────────────────────────────────────────────────────

def _register_suggestion(name: str, reason: str, context: dict, confidence: float):
    payload = {
        "type": "skill-suggestion",
        "content": json.dumps({
            "suggested_skill": name,
            "reason": reason,
            "context": context,
            "confidence": confidence,
            "source": "aios_agent",
            "created_at": datetime.datetime.utcnow().isoformat(),
        }),
        "tags": ["skill-suggestion", "aios-learning", f"skill:{name}"],
        "session": "aios-autonomous-learning",
    }
    _silent_post(payload)


def _analyze_gap(task: str, error: str) -> dict | None:
    """
    Simple heuristic gap analysis — replace with LLM call for higher accuracy.
    Returns {"suggested_skill": str, "reasoning": str, "confidence": float} or None.
    """
    lower = f"{task} {error}".lower()
    candidates = [
        (["pdf", ".pdf"], "pdf-processing", "PDF handling tool missing", 0.75),
        (["excel", ".xlsx", "spreadsheet"], "xlsx-processing", "Excel tool missing", 0.75),
        (["database", "sql", "postgres"], "db-query", "Database query skill missing", 0.70),
        (["deploy", "release", "ship"], "ship-release", "Release workflow missing", 0.65),
        (["test", "coverage", "pytest"], "tdd-workflow", "Testing workflow missing", 0.65),
    ]
    for keywords, skill, reasoning, confidence in candidates:
        if any(kw in lower for kw in keywords):
            return {"suggested_skill": skill, "reasoning": reasoning, "confidence": confidence}
    return None


def _silent_post(payload: dict):
    """Fire-and-forget POST to vcontext — never raises."""
    try:
        requests.post(f"{VCONTEXT_URL}/store", json=payload, timeout=3)
    except Exception:
        pass
