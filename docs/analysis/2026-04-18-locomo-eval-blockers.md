# LoCoMo Evaluation Harness — Blockers (2026-04-18)

**Status**: Harness code ready; end-to-end run blocked by infrastructure.
**Related**: `scripts/locomo-eval.py`, `docs/analysis/2026-04-18-locomo-eval-harness.md`

## Summary

The LoCoMo harness was completed and smoke-tested in `--dry-run --mock` mode
(10 synthetic QA, structure validation green). An end-to-end run against the
real `data/locomo/locomo10.json` could **not** be performed because both
dependent services were in a failure state during this session:

1. **vcontext server (:3150) is in an OOM restart loop.** The LaunchAgent
   wrapper `scripts/vcontext-wrapper.sh` spawned 7+ consecutive server
   processes that were killed with signal 9 before ever binding port 3150.
   Each attempt lasts ~15-75s and ends with `Killed: 9`.
2. **MLX generate server (:3162) hangs on `/v1/chat/completions`.** `GET
   /health` and `GET /v1/models` return in <1s, but POST chat completions
   never produce log entries (even with `max_tokens=1`). Process state
   `U<` (uninterruptible wait) on PID 5010. `top` reports 15GB of 16GB
   swap used, `load_avg 8.5` on an 11-core machine.

Root cause is system-wide memory pressure. `vm.swapusage` shows
`used=14805M/16384M`, `vm_stat` `Pages free: 3585` on a 36GB machine
— the box is thrashing. Any node.js process touching the ~3GB RAM-disk
vcontext.db gets reaped by the kernel before it can bind its port.

## What works today (verified this session)

- `data/locomo/locomo10.json` — 2.8MB, SHA-256 cached; 10 conversations,
  1986 QA, categories 1-5 as documented. `sample[0]` (`conv-26`, Caroline
  / Melanie) is the default target for `--subset small`.
- `data/locomo-mock.json` — 10-QA synthetic fixture, 3 sessions, cat
  distribution 6/3/1 across (1,2,5). Loads cleanly.
- `python3 scripts/locomo-eval.py --mock --dry-run --no-llm-judge`
  completes in <100ms, produces the full `{config, summary, aggregate,
  per_question}` envelope at `/tmp/locomo-dry-out.json`. All fields
  required by the task brief — `accuracy`, `precision_at_k`, `mrr`,
  `avg_latency_ms`, `total_cost_stub` — are present in `aggregate`, and
  every per_question row has `question`, `gold_answer`, `retrieved_ids`,
  `generated_answer`, `judge_verdict`, `judge_rationale`.
- FTS5 stopword stripping + OR-join logic: validated with questions
  like `"What is Alice's favorite color?"` → retains `"Alice favorite
  color"`. Proper nouns preserved even when short.

## Harness improvements landed this session

`scripts/locomo-eval.py` changes vs. prior agent's checkpoint:

1. `_question_to_fts_query`: preserves capitalised proper nouns, strips
   possessive `'s`, deduplicates tokens while preserving order. Handles
   apostrophe-edged tokens like `Alice's` → `Alice`.
2. `mlx_generate`: timeout now configurable via `MLX_TIMEOUT_S` env var
   (default 60s, down from 120s — a wedged MLX should fail the row, not
   block the whole run). Single retry on transient failures.
   `_extract_answer_from_reasoning` helper extracts a final-answer line
   from Qwen3 CoT `reasoning` stream when `content` is empty, instead of
   dumping the whole CoT.
3. `_retrieval_scores`: computes `precision@k`, `recall@k`, `MRR`,
   `hit@k` per question using the `locomo-dia:*` tags vs. the QA
   `evidence` array. Feeds into per_question rows **and** the
   aggregate.
4. `run_eval` emits `{config, summary, aggregate, per_question}` — the
   envelope shape requested in the task brief. Legacy `summary` is
   preserved for `--submit` back-compatibility.
5. New aggregate fields: `accuracy`, `precision_at_k`, `mrr`,
   `avg_latency_ms`, `total_cost_stub`, `non_empty_retrieval_rate`,
   `avg_retrieval_ms`.
6. Per-question rows: `judge_verdict` ∈ {correct, partial, wrong};
   `judge_rationale` from the LLM-J call (or `"f1-fallback"` when judge
   disabled).

## What's needed to unblock an end-to-end run

Two options in priority order:

### A. Wait for system to recover (preferred)

- Stop some of the pressure: `launchctl unload -w
  ~/Library/LaunchAgents/com.vcontext.mlx-embed.plist` temporarily
  frees ~4GB RSS if the embed server is the heaviest resident. Or
  stop `mlx-generate` if the harness can run with `--no-llm-judge`
  for a first smoke test. (Do NOT do this inside self-evolve's
  gate path — only for the baseline.)
- Let swap drain: after ~5-10 min of idle, swap pressure typically
  falls below 10 GB and vcontext can bind.
- Then:
  ```
  python3 scripts/locomo-eval.py --subset small --no-llm-judge \
      --out data/locomo-eval-result-2026-04-18.json
  ```
  This gives retrieval-quality metrics (precision@k, MRR, hit@k) and
  F1 + EM generation metrics, in ~1-2 min if MLX is healthy; pure
  retrieval-only without MLX is ~5s.

### B. Full run with LLM-J

Once A passes, re-run without `--no-llm-judge`. Expected time:
- subset=small (10 Q): ~2-3 min (1 MLX call per Q + judge)
- subset=full (1986 Q): ~60-90 min

### Expected numbers (from community literature, to sanity-check)

Per the design doc:
- Letta 74%, MemMachine 77% LLM-J on full set.
- F1 mean ~0.35-0.50 typical for retrieval-only systems.
- If `non_empty_retrieval_rate` < 60%, FTS stopword handling is still
  broken and the ingest side should be audited first.

## Non-action taken

- Did NOT touch `scripts/vcontext-server.js` (out of scope per task).
- Did NOT restart MLX or vcontext — the wrapper's retry logic is
  expected to handle that once memory frees. Kicking it manually
  would mask the real problem.
- Did NOT commit. All harness changes + the real dataset +
  blockers doc are left as staged/untracked for the user's review.

## Files (absolute paths)

- `/Users/mitsuru_nakajima/skills/scripts/locomo-eval.py` — harness (~570 lines)
- `/Users/mitsuru_nakajima/skills/docs/analysis/2026-04-18-locomo-eval-harness.md` — design doc
- `/Users/mitsuru_nakajima/skills/docs/analysis/2026-04-18-locomo-eval-blockers.md` — this file
- `/Users/mitsuru_nakajima/skills/data/locomo/locomo10.json` — real dataset
- `/Users/mitsuru_nakajima/skills/data/locomo-mock.json` — smoke-test fixture
- `/tmp/locomo-dry-out.json` — reference dry-run output (structure validated)
