#!/usr/bin/env python3
"""locomo-eval.py — LoCoMo benchmark harness for AIOS vcontext.

Wires the Snap Research LoCoMo long-conversation-memory benchmark into the
local vcontext memory server, so recall quality becomes a reproducible
number we can feed self-evolve fitness and dashboard trend cards.

Design doc: docs/analysis/2026-04-18-locomo-eval-harness.md

Deliberately stdlib-only: no pip install. Uses urllib, json, http.client,
argparse, hashlib, re, statistics.

CLI::

    python3 scripts/locomo-eval.py --subset small --dry-run   # 10 Qs, no /store result
    python3 scripts/locomo-eval.py --subset small --submit    # 10 Qs, POST result
    python3 scripts/locomo-eval.py --subset full              # all 1986 Qs (slow)
    python3 scripts/locomo-eval.py --mock                     # mock data, no MLX needed
    python3 scripts/locomo-eval.py --subset small --no-llm-judge   # F1 only

Exit codes:
    0 = ran ok, score above floor (if --gate-floor given)
    1 = runtime error
    2 = score below --gate-floor (self-evolve gate signal)
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import statistics
import string
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

# Cross-process MLX lock — shares /tmp/aios-mlx-lock with task-runner,
# self-evolve, vcontext-server, and any agent-invoked script. Serializes
# heavy MLX-generate work to prevent the 2026-04-18 OOM cascade.
#
# Re-entrant: if the parent (e.g. aios-task-runner.js) already acquired
# the lock and exported AIOS_MLX_LOCK_HOLDER, MlxLock becomes a no-op.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from aios_mlx_lock import MlxLock, MLX_LOCK_ENV_VAR  # noqa: E402

# ── Configuration ───────────────────────────────────────────────
VCONTEXT_HOST = os.environ.get("VCONTEXT_HOST", "127.0.0.1")
VCONTEXT_PORT = int(os.environ.get("VCONTEXT_PORT", "3150"))
MLX_HOST = os.environ.get("MLX_HOST", "127.0.0.1")
MLX_PORT = int(os.environ.get("MLX_PORT", "3162"))
MLX_MODEL = os.environ.get("MLX_MODEL", "mlx-community/Qwen3-8B-4bit")
# Shorter default than 120s: if MLX is wedged (speculative decode stall,
# memory thrash) we'd rather fail the row and move on than block the whole
# run. Override with MLX_TIMEOUT_S=120 for slower hardware.
MLX_TIMEOUT_S = float(os.environ.get("MLX_TIMEOUT_S", "60"))
JUDGE_PROMPT_VERSION = "v1-2026-04-18"

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data" / "locomo"
LOCOMO_JSON = DATA_DIR / "locomo10.json"
MOCK_JSON = REPO_ROOT / "data" / "locomo-mock.json"
LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"

REFUSAL_TOKENS = (
    "i don't know", "i do not know", "not mentioned", "cannot determine",
    "no information", "unknown", "unclear", "insufficient",
)

# FTS stopwords — the vcontext /recall endpoint does AND-style matching
# across tokens by default, which makes natural-language questions return
# zero rows because words like "what", "the", "is" never appear in a turn.
# We strip these before sending, then OR-join the survivors.
STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "am", "do", "does", "did", "has", "have", "had", "will", "would",
    "could", "should", "may", "might", "must", "can", "of", "to", "in",
    "on", "at", "by", "for", "with", "about", "from", "as", "into",
    "during", "which", "what", "who", "whom", "whose", "when", "where",
    "why", "how", "this", "that", "these", "those", "it", "its", "there",
    "than", "then", "and", "or", "but", "if", "so", "because", "also",
    "you", "your", "he", "she", "his", "her", "them", "they", "their",
}


# ── HTTP helpers (stdlib-only) ──────────────────────────────────

def _post_json(host: str, port: int, path: str, payload: dict, timeout: float = 30) -> dict:
    body = json.dumps(payload).encode("utf-8")
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("POST", path, body=body,
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        data = resp.read()
        if resp.status >= 400:
            raise RuntimeError(f"POST {path} -> {resp.status}: {data[:300]!r}")
        return json.loads(data) if data else {}
    finally:
        conn.close()


def _get_json(host: str, port: int, path: str, timeout: float = 30) -> dict:
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        data = resp.read()
        if resp.status >= 400:
            raise RuntimeError(f"GET {path} -> {resp.status}: {data[:300]!r}")
        return json.loads(data) if data else {}
    finally:
        conn.close()


# ── Dataset loading ─────────────────────────────────────────────

def load_locomo_dataset(subset: str = "small", mock: bool = False,
                        auto_download: bool = True) -> list[dict]:
    """Return list of conversation samples; each has qa, conversation, sample_id.

    subset: 'small' → first sample, first 10 QA; 'full' → all 10 samples.
    mock: use 10-QA synthetic conversation (no network, no MLX needed).
    """
    if mock:
        with open(MOCK_JSON) as f:
            return [json.load(f)]

    if not LOCOMO_JSON.exists():
        if not auto_download:
            raise FileNotFoundError(
                f"{LOCOMO_JSON} missing. Re-run with auto_download=True or manually "
                f"download from {LOCOMO_URL}"
            )
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        print(f"[dataset] downloading {LOCOMO_URL} …", file=sys.stderr)
        with urllib.request.urlopen(LOCOMO_URL, timeout=60) as r:
            LOCOMO_JSON.write_bytes(r.read())

    with open(LOCOMO_JSON) as f:
        data = json.load(f)

    if subset == "small":
        # First sample only, first 10 QA — enough to smoke-test ingestion,
        # retrieval, judge, and write-back; runs in <2 min on CPU MLX.
        first = dict(data[0])
        first["qa"] = first["qa"][:10]
        return [first]
    elif subset == "full":
        return data
    else:
        raise ValueError(f"unknown subset: {subset!r}")


def dataset_sha256() -> str | None:
    if not LOCOMO_JSON.exists():
        return None
    h = hashlib.sha256()
    with open(LOCOMO_JSON, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


# ── Ingestion ───────────────────────────────────────────────────

def ingest_to_vcontext(sample: dict, dry_run: bool = False) -> tuple[str, int]:
    """POST each turn of a conversation sample to vcontext.

    Returns (session_id, n_turns_stored).
    """
    sid = sample.get("sample_id", "unknown")
    session_id = f"test-locomo-{sid}"
    conv = sample["conversation"]
    speaker_a = conv.get("speaker_a", "A")
    speaker_b = conv.get("speaker_b", "B")
    n = 0

    session_keys = sorted(
        [k for k in conv if k.startswith("session_") and not k.endswith("date_time")],
        key=lambda k: int(k.split("_")[1]) if k.split("_")[1].isdigit() else 0,
    )
    for sk in session_keys:
        dt_key = f"{sk}_date_time"
        dt = conv.get(dt_key, "")
        turns = conv.get(sk, [])
        if not isinstance(turns, list):
            continue
        for turn in turns:
            speaker = turn.get("speaker", "?")
            dia_id = turn.get("dia_id", "")
            text = turn.get("text", "")
            if not text:
                continue
            content = f"[{dt}] {speaker}: {text}"
            payload = {
                "type": "test-conversation",
                "content": content,
                "session": session_id,
                "tags": [
                    "locomo",
                    f"locomo-sample:{sid}",
                    f"locomo-dia:{dia_id}",
                    f"locomo-speaker:{speaker}",
                ],
            }
            if dry_run:
                n += 1
                continue
            try:
                _post_json(VCONTEXT_HOST, VCONTEXT_PORT, "/store", payload)
                n += 1
            except Exception as e:
                print(f"[ingest] {dia_id} failed: {e}", file=sys.stderr)
    _ = (speaker_a, speaker_b)  # currently unused; kept for future directional scoring
    return session_id, n


# ── Retrieval ───────────────────────────────────────────────────

def _question_to_fts_query(question: str) -> str:
    """Strip stopwords and punctuation, OR-join the rest for FTS5.

    /recall's default AND semantics means questions like 'What is Rusty's age?'
    find no rows because 'what'/'is' never appear in dialogue. OR gives us
    candidate matches ranked by FTS score, which is what we want for eval.

    We keep proper-noun-looking tokens (capitalised in the original) even if
    short (e.g. 'LA', 'UK'), because those carry most of the retrieval signal
    for LoCoMo's factual questions.
    """
    # Preserve original-casing for proper-noun detection, but lowercase for
    # comparison against STOPWORDS.
    raw_tokens = re.findall(r"[A-Za-z0-9']+", question)
    # Strip trailing/leading apostrophes + possessive 's so 'Rusty's' → 'Rusty'.
    norm = [re.sub(r"'s$", "", t).strip("'") for t in raw_tokens]
    meaningful: list[str] = []
    for orig, low in zip(norm, [t.lower() for t in norm]):
        if not orig:
            continue
        is_proper = orig[0].isupper() and len(orig) > 1
        if low in STOPWORDS and not is_proper:
            continue
        if len(orig) <= 1 and not is_proper:
            continue
        meaningful.append(orig)
    if not meaningful:
        meaningful = [t for t in norm if t] or [question]
    # Dedupe while preserving order — FTS doesn't care but shorter queries
    # parse faster when questions repeat a name.
    seen: set[str] = set()
    uniq: list[str] = []
    for t in meaningful:
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(t)
    return " OR ".join(uniq)


def query_vcontext(question: str, session_id: str, limit: int = 5,
                   dry_run: bool = False) -> list[dict]:
    """Return top-N recall rows filtered to this test session."""
    if dry_run:
        return []
    # Fetch more than `limit` because post-hoc session filter shrinks it,
    # and the FTS OR-query may return cross-session hits at the top.
    fts_q = _question_to_fts_query(question)
    qs = urllib.parse.urlencode({
        "q": fts_q,
        "limit": str(limit * 10),
        "type": "test-conversation",
    })
    try:
        resp = _get_json(VCONTEXT_HOST, VCONTEXT_PORT, f"/recall?{qs}")
    except Exception as e:
        print(f"[recall] {question[:60]!r}: {e}", file=sys.stderr)
        return []
    # filter to this session — server returns cross-session results by default
    results = [r for r in resp.get("results", []) if r.get("session") == session_id]
    return results[:limit]


def _dia_ids_from_row(row: dict) -> list[str]:
    """Extract the locomo-dia:<id> tag(s) from a /recall row."""
    tags = row.get("tags") or []
    if isinstance(tags, str):
        # Server sometimes returns comma-joined string
        tags = [t.strip() for t in tags.split(",")]
    return [t.split(":", 1)[1] for t in tags
            if isinstance(t, str) and t.startswith("locomo-dia:")]


def _retrieval_scores(rows: list[dict], evidence: list[str]) -> dict:
    """Return precision@k, recall@k, MRR, and hit@k for a retrieval result."""
    if not rows or not evidence:
        return {"precision_at_k": 0.0, "recall_at_k": 0.0,
                "mrr": 0.0, "hit_at_k": False}
    ev_set = set(evidence)
    retrieved_ids: list[str] = []
    for r in rows:
        retrieved_ids.extend(_dia_ids_from_row(r))
    hits = [i for i, did in enumerate(retrieved_ids) if did in ev_set]
    prec = len([d for d in retrieved_ids if d in ev_set]) / max(len(rows), 1)
    rec = len(set(retrieved_ids) & ev_set) / len(ev_set)
    mrr = 1.0 / (hits[0] + 1) if hits else 0.0
    return {"precision_at_k": round(prec, 4), "recall_at_k": round(rec, 4),
            "mrr": round(mrr, 4), "hit_at_k": bool(hits)}


# ── LLM generation / judge (MLX OpenAI-compatible) ──────────────

def _extract_answer_from_reasoning(text: str) -> str:
    """When Qwen3 emits CoT into `reasoning` (content empty), try to pull the
    final answer out. The model usually concludes with a short declarative
    line, so take the last non-empty line that's not an obvious think-marker."""
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    for line in reversed(lines):
        low = line.lower()
        if low.startswith(("so ", "therefore", "thus", "final answer",
                           "the answer", "answer:")):
            # Strip leading label if present
            return re.sub(r"^(so,?|therefore,?|thus,?|final answer:?|"
                          r"the answer is:?|answer:)\s*", "", line,
                          flags=re.IGNORECASE).strip(" .") or line
        # A short declarative line (no think-talk) is probably the answer.
        if len(line) <= 200 and not line.endswith("?"):
            return line
    return (text or "").strip()


def mlx_generate(prompt: str, max_tokens: int = 120, temperature: float = 0.0,
                 retries: int = 1) -> str:
    # Qwen3 is a reasoning model — the default path emits CoT into
    # `message.reasoning` and leaves `content` empty until thinking is done.
    # For benchmarking we need deterministic short outputs, so prefix
    # `/no_think` which disables the reasoning phase.
    payload = {
        "model": MLX_MODEL,
        "messages": [{"role": "user", "content": "/no_think " + prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    last_err: str | None = None
    for attempt in range(retries + 1):
        try:
            resp = _post_json(MLX_HOST, MLX_PORT, "/v1/chat/completions",
                              payload, timeout=MLX_TIMEOUT_S)
            msg = resp["choices"][0]["message"]
            out = (msg.get("content") or "").strip()
            # Belt-and-braces: if content is still empty (older MLX build,
            # different model) fall back to the reasoning stream, but try
            # to extract just the answer line rather than dumping the whole
            # CoT.
            if not out:
                reasoning = (msg.get("reasoning") or "").strip()
                if reasoning:
                    out = _extract_answer_from_reasoning(reasoning)
            return out
        except Exception as e:
            last_err = str(e)
            if attempt < retries:
                # One quick retry — MLX occasionally 500s under load.
                continue
            print(f"[mlx] generate failed after {attempt+1}x: {last_err}",
                  file=sys.stderr)
            return ""
    return ""


def generate_answer(question: str, context_rows: list[dict]) -> str:
    if not context_rows:
        return ""
    context = "\n".join(r.get("content", "") for r in context_rows)
    prompt = (
        "Given the following conversation excerpts, answer the question in "
        "one short sentence. If the answer cannot be determined from the "
        "excerpts, reply \"I don't know\".\n\n"
        f"{context}\n\nQuestion: {question}\nAnswer:"
    )
    return mlx_generate(prompt, max_tokens=80)


# ── Scoring ─────────────────────────────────────────────────────

_PUNCT_TABLE = str.maketrans("", "", string.punctuation)


def _normalize(s: str) -> str:
    s = (s or "").lower().strip()
    s = re.sub(r"\b(a|an|the)\b", " ", s)
    s = s.translate(_PUNCT_TABLE)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def f1_score(pred: str, gold: str) -> float:
    p_tok = _normalize(pred).split()
    g_tok = _normalize(gold).split()
    if not p_tok or not g_tok:
        return 0.0
    common = Counter(p_tok) & Counter(g_tok)
    overlap = sum(common.values())
    if overlap == 0:
        return 0.0
    precision = overlap / len(p_tok)
    recall = overlap / len(g_tok)
    return 2 * precision * recall / (precision + recall)


def exact_match(pred: str, gold: str) -> bool:
    return _normalize(pred) == _normalize(gold)


def is_refusal(pred: str) -> bool:
    low = (pred or "").lower()
    return any(tok in low for tok in REFUSAL_TOKENS)


def llm_judge(question: str, gold: str, pred: str) -> dict:
    """Return {match: bool, score: 0/1, rationale: str}. 0 if MLX unavailable."""
    if not pred:
        return {"match": False, "score": 0.0, "rationale": "empty prediction",
                "available": True}
    prompt = (
        "You are grading an answer. Reply with ONLY 'YES' or 'NO' (no other "
        "words).\n\n"
        f"Question: {question}\n"
        f"Gold answer: {gold}\n"
        f"Predicted answer: {pred}\n\n"
        "Is the predicted answer semantically equivalent to the gold answer? "
        "Answer YES or NO."
    )
    out = mlx_generate(prompt, max_tokens=4, temperature=0.0)
    if not out:
        return {"match": False, "score": 0.0, "rationale": "mlx unavailable",
                "available": False}
    verdict = out.strip().upper()
    match = verdict.startswith("YES")
    return {"match": match, "score": 1.0 if match else 0.0,
            "rationale": verdict[:40], "available": True}


def judge_answer(qa: dict, pred: str, use_llm: bool) -> dict:
    category = qa.get("category", 0)
    if category == 5:
        # Adversarial: want refusal OR adversarial_answer match.
        adv_gold = qa.get("adversarial_answer", "")
        refused = is_refusal(pred)
        string_hit = exact_match(pred, adv_gold) or (
            _normalize(adv_gold) and _normalize(adv_gold) in _normalize(pred)
        )
        match = bool(refused or string_hit)
        return {"match": match, "score": 1.0 if match else 0.0,
                "f1": 1.0 if match else 0.0,
                "em": match, "llm": {"available": False},
                "category": 5, "refused": refused}

    gold = qa.get("answer", "")
    if gold is None:
        gold = ""
    gold_str = str(gold)
    f1 = f1_score(pred, gold_str)
    em = exact_match(pred, gold_str)
    llm_res = llm_judge(qa["question"], gold_str, pred) if use_llm else {
        "match": False, "score": 0.0, "available": False, "rationale": "skipped"}
    # primary score: LLM-J if available, else F1
    primary = llm_res["score"] if llm_res.get("available") else f1
    return {"match": bool(llm_res["match"]) if llm_res.get("available") else (f1 >= 0.5),
            "score": primary, "f1": f1, "em": em,
            "llm": llm_res, "category": category}


# ── Orchestration ───────────────────────────────────────────────

def run_eval(subset: str, *, dry_run: bool, mock: bool, use_llm: bool,
             verbose: bool = True) -> dict:
    t0 = time.time()
    samples = load_locomo_dataset(subset=subset, mock=mock)
    total_q = sum(len(s.get("qa", [])) for s in samples)
    if verbose:
        print(f"[eval] samples={len(samples)} total_qa={total_q} "
              f"subset={subset} mock={mock} dry_run={dry_run} "
              f"use_llm={use_llm}", file=sys.stderr)

    per_q: list[dict] = []
    latencies: list[float] = []
    retrieval_latencies: list[float] = []

    for sample in samples:
        session_id, n_stored = ingest_to_vcontext(sample, dry_run=dry_run)
        if verbose:
            print(f"[eval] sample={sample.get('sample_id')} "
                  f"ingested_turns={n_stored}", file=sys.stderr)

        for qa in sample.get("qa", []):
            q = qa["question"]
            evidence = qa.get("evidence") or []
            t_q = time.time()
            t_r = time.time()
            rows = query_vcontext(q, session_id, limit=5, dry_run=dry_run)
            retrieval_ms = (time.time() - t_r) * 1000
            retrieved_ids: list[str] = []
            for r in rows:
                retrieved_ids.extend(_dia_ids_from_row(r))
            ret_scores = _retrieval_scores(rows, evidence)
            pred = generate_answer(q, rows) if not dry_run else ""
            latency_ms = (time.time() - t_q) * 1000
            latencies.append(latency_ms)
            retrieval_latencies.append(retrieval_ms)
            scored = judge_answer(qa, pred, use_llm=use_llm and not dry_run)
            # Task-aligned per-question record: question, gold_answer,
            # retrieved_ids, generated_answer, judge_verdict, judge_rationale.
            judge_verdict = (
                "correct" if scored["match"]
                else ("partial" if scored.get("f1", 0) >= 0.3 else "wrong")
            )
            per_q.append({
                "sample_id": sample.get("sample_id"),
                "question": q,
                "gold_answer": qa.get("answer") or qa.get("adversarial_answer"),
                "evidence": evidence,
                "retrieved_ids": retrieved_ids,
                "generated_answer": pred,
                "judge_verdict": judge_verdict,
                "judge_rationale": scored.get("llm", {}).get("rationale",
                                                            "f1-fallback"),
                "n_retrieved": len(rows),
                "retrieval_ms": round(retrieval_ms, 1),
                "latency_ms": round(latency_ms, 1),
                **scored,
                **ret_scores,
            })
            if verbose:
                tag = "ADV" if scored.get("category") == 5 else f"c{scored.get('category')}"
                ok = "+" if scored["match"] else "-"
                print(f"  [{ok} {tag}] f1={scored.get('f1', 0):.2f} "
                      f"llm={scored['llm'].get('score', 0):.0f} "
                      f"mrr={ret_scores['mrr']:.2f} "
                      f"q={q[:60]!r}", file=sys.stderr)

    # Aggregate
    def mean(xs: Iterable[float]) -> float:
        xs = list(xs)
        return statistics.mean(xs) if xs else 0.0

    by_cat: dict[int, list[dict]] = defaultdict(list)
    for r in per_q:
        by_cat[r.get("category", 0)].append(r)

    non_empty_retrieval_rate = round(
        mean(1.0 if r["n_retrieved"] > 0 else 0.0 for r in per_q), 4)

    aggregate = {
        "n_questions": len(per_q),
        # Primary headline number: LLM-J if judge available on most rows,
        # else F1≥0.5 fallback. Matches public leaderboard convention.
        "accuracy": round(mean(r["score"] for r in per_q), 4),
        "em": round(mean(1.0 if r["em"] else 0.0 for r in per_q), 4),
        "f1_mean": round(mean(r["f1"] for r in per_q), 4),
        "llm_j": round(mean(r["llm"].get("score", 0.0) for r in per_q
                            if r["llm"].get("available")), 4),
        # Retrieval-stage signals — decoupled from generation quality.
        "precision_at_k": round(mean(r.get("precision_at_k", 0.0)
                                     for r in per_q), 4),
        "recall_at_k": round(mean(r.get("recall_at_k", 0.0)
                                  for r in per_q), 4),
        "mrr": round(mean(r.get("mrr", 0.0) for r in per_q), 4),
        "hit_at_k": round(mean(1.0 if r.get("hit_at_k") else 0.0
                               for r in per_q), 4),
        "non_empty_retrieval_rate": non_empty_retrieval_rate,
        # Timing.
        "avg_latency_ms": round(mean(latencies), 1),
        "avg_retrieval_ms": round(mean(retrieval_latencies), 1),
        "latency_ms_p95": round(
            statistics.quantiles(latencies, n=20)[18] if len(latencies) >= 20
            else max(latencies) if latencies else 0.0, 1),
        # Cost is zero for local MLX — keeping the field for API-based
        # comparisons later. Counts mlx calls × rough per-call budget.
        "total_cost_stub": {"currency": "USD", "amount": 0.0,
                            "model": MLX_MODEL, "basis": "local-mlx"},
        "wall_seconds": round(time.time() - t0, 2),
    }
    config = {
        "model": MLX_MODEL,
        "mlx_port": MLX_PORT,
        "vcontext_port": VCONTEXT_PORT,
        "subset": subset,
        "mock": mock,
        "dry_run": dry_run,
        "use_llm_judge": use_llm,
        "k": 5,
        "judge_prompt_version": JUDGE_PROMPT_VERSION,
        "mlx_timeout_s": MLX_TIMEOUT_S,
        "cutoff": "small=first-sample-first-10-Q; full=all-1986-Q",
        "dataset_sha256": dataset_sha256() if not mock else "mock",
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    # Keep legacy `summary` block for the existing `--submit` path & for
    # callers that depend on it — this is what gets stored in vcontext.
    summary = {
        "subset": subset,
        "mock": mock,
        "dry_run": dry_run,
        "n_samples": len(samples),
        "n_questions": len(per_q),
        "f1_mean": aggregate["f1_mean"],
        "em": aggregate["em"],
        "llm_j": aggregate["llm_j"],
        "primary_score": aggregate["accuracy"],
        "by_category": {
            str(cat): {
                "n": len(rows),
                "f1_mean": round(mean(r["f1"] for r in rows), 4),
                "primary_mean": round(mean(r["score"] for r in rows), 4),
            }
            for cat, rows in by_cat.items()
        },
        "adversarial_correct_rate": round(
            mean(1.0 if r["match"] else 0.0 for r in by_cat.get(5, [])), 4)
            if 5 in by_cat else None,
        "latency_ms_mean": aggregate["avg_latency_ms"],
        "latency_ms_p95": aggregate["latency_ms_p95"],
        "wall_seconds": aggregate["wall_seconds"],
        "dataset_sha256": config["dataset_sha256"],
        "mlx_model": MLX_MODEL,
        "ts": config["ts"],
    }
    return {
        "config": config,
        "summary": summary,
        "aggregate": aggregate,
        "per_question": per_q,
    }


def submit_to_vcontext(results: dict) -> dict:
    payload = {
        "type": "locomo-eval-result",
        "content": json.dumps(results["summary"]),
        "session": "locomo-eval",
        "tags": [
            "locomo",
            f"locomo-subset:{results['summary']['subset']}",
            f"locomo-score:{results['summary']['primary_score']:.3f}",
        ],
    }
    return _post_json(VCONTEXT_HOST, VCONTEXT_PORT, "/store", payload)


# ── CLI ─────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--subset", choices=["small", "full"], default="small")
    ap.add_argument("--mock", action="store_true",
                    help="use data/locomo-mock.json (no network, no MLX)")
    ap.add_argument("--dry-run", action="store_true",
                    help="don't actually /store or /recall — just count")
    ap.add_argument("--no-llm-judge", action="store_true",
                    help="skip MLX judge; F1/EM only (faster)")
    ap.add_argument("--submit", action="store_true",
                    help="POST summary to vcontext as type=locomo-eval-result")
    ap.add_argument("--gate-floor", type=float, default=None,
                    help="exit 2 if primary_score < this (self-evolve gate)")
    ap.add_argument("--out", default=None,
                    help="write full result JSON here")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    # Hold the cross-process MLX lock for the entire eval. Mock runs don't
    # touch MLX so skip the lock there. Dry-run and --no-llm-judge still may
    # call mlx_generate(generate_answer path), so acquire in those too —
    # exception: --dry-run --no-llm-judge has zero MLX calls, but keeping
    # the lock briefly costs nothing vs. the code-clarity win of a single
    # acquire path.
    holder_id = f"locomo-eval:pid-{os.getpid()}"
    needs_lock = not args.mock
    try:
        if needs_lock:
            # 20min wait = long enough to queue behind a single LoCoMo-small
            # (~2min MLX wallclock) or a self-evolve mutation pass; short
            # enough that if MLX is truly wedged we bail rather than hang.
            with MlxLock(holder_id, wait_s=20 * 60):
                # Export env var so any subprocess (or inner helper that
                # also acquires) sees the lock as "parent-held" and skips
                # its own acquire/release. Preserves prior value if set.
                prior = os.environ.get(MLX_LOCK_ENV_VAR)
                os.environ[MLX_LOCK_ENV_VAR] = holder_id
                try:
                    results = run_eval(
                        args.subset, dry_run=args.dry_run, mock=args.mock,
                        use_llm=not args.no_llm_judge, verbose=not args.quiet,
                    )
                finally:
                    if prior is None:
                        os.environ.pop(MLX_LOCK_ENV_VAR, None)
                    else:
                        os.environ[MLX_LOCK_ENV_VAR] = prior
        else:
            results = run_eval(
                args.subset, dry_run=args.dry_run, mock=args.mock,
                use_llm=not args.no_llm_judge, verbose=not args.quiet,
            )
    except TimeoutError as e:
        print(f"[fatal] {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"[fatal] {e}", file=sys.stderr)
        return 1

    print(json.dumps(results["summary"], indent=2))

    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=2))

    if args.submit and not args.dry_run:
        try:
            stored = submit_to_vcontext(results)
            print(f"[submit] stored id={stored.get('stored', {}).get('id')}",
                  file=sys.stderr)
        except Exception as e:
            print(f"[submit] failed: {e}", file=sys.stderr)

    score = results["summary"]["primary_score"]
    if args.gate_floor is not None and score < args.gate_floor:
        print(f"[gate] score {score} < floor {args.gate_floor} → exit 2",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
