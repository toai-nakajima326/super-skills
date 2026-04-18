# LoCoMo Evaluation Harness for AIOS vcontext

**Date**: 2026-04-18
**Author**: agent (locomo-harness task)
**Status**: initial design + working subset implementation
**Scope**: wire the Snap Research LoCoMo benchmark into AIOS so vcontext memory
quality can be measured reproducibly, and so self-evolve can gate regressions.

---

## 1. LoCoMo dataset summary

Verified by direct download of `data/locomo10.json` from
`https://github.com/snap-research/locomo` (commit main, 2026-04-18, 2.7 MB).

- **10 conversations** (the public release is subsampled from 50 for closed-LLM
  cost reasons — see upstream README).
- **1,986 QA pairs total** across the 10 conversations.
- Each conversation is a JSON object with keys
  `sample_id, conversation, observation, session_summary, event_summary, qa`.
- `conversation` holds up to ~35 sessions per sample. Example sample[0] has
  19 sessions, with speakers Caroline / Melanie and 18+ turns per session.
  Keys follow the pattern:
  - `speaker_a`, `speaker_b`
  - `session_N_date_time` (str)
  - `session_N` → list of turns; each turn is
    `{speaker, dia_id ("D<N>:<k>"), text, (optional) img_url/blip_caption}`
- Each QA entry is
  `{question, answer|adversarial_answer, evidence: [dia_id...], category}`.
  - `answer` is a string for cats 1-4, **None for adversarial (cat 5)** and
    replaced by `adversarial_answer` ("expected model refusal").
  - `category` 1-5 — observed distribution in full dataset:
    - 1: 282 (single-hop factual)
    - 2: 321 (multi-hop / temporal)
    - 3: 96 (open-ended / commonsense — *inferred*, paper distinguishes these)
    - 4: 841 (general QA, plurality)
    - 5: 446 (**adversarial** — must NOT confabulate)
  - *Inferred*: category numbering above follows the paper conventions; the
    dataset file itself carries only the integer. For harness purposes we
    treat cat 5 separately (abstention scoring) and the rest as standard QA.

## 2. Metric (informed guess, confirmable later)

Upstream paper ("Evaluating Very Long-Term Conversational Memory of LLM
Agents", ACL 2024, Maharana et al.) reports **F1** and **BLEU** for QA, plus
LLM-as-judge binary correctness ("LLM-J"). Community repos (Mem0, Zep,
Memobase, MemMachine) standardise on:

- **F1** over tokens between predicted answer and gold answer (string overlap).
- **LLM-as-judge** — a single-question prompt "is the predicted answer
  semantically equivalent to the gold answer?" → {yes/no}.

We implement both. **LLM-J is the primary score** (matches what the
public leaderboards report, e.g. MemMachine 77%, Letta 74%); F1 is kept as
a cheap deterministic sanity check.

For **category 5 (adversarial)** the target behaviour is to refuse /
say "I don't know" / return the `adversarial_answer`; our harness flags a
prediction as correct iff it contains refusal tokens **or** matches the
adversarial gold.

## 3. AIOS adapter design

```
┌─────────────┐  ingest  ┌──────────┐  recall  ┌──────────────┐  judge  ┌────────┐
│ locomo10.json├────────▶│ vcontext │◀─────────│ locomo-eval.py├────────▶│ score  │
└─────────────┘  /store  └──────────┘  /recall └──────────────┘ exact+J └────────┘
                                                                    │
                                                              /store type=
                                                         locomo-eval-result
```

### 3.1 Ingestion (per conversation sample)

For sample `sample_id=X`:
- session id: `test-locomo-<sample_id>` (e.g. `test-locomo-1`).
- For each session `session_N` and each turn `T`:
  - `POST /store` with
    ```json
    {
      "type": "test-conversation",
      "content": "[<session_N_date_time>] <speaker>: <text>",
      "session": "test-locomo-<sample_id>",
      "tags": ["locomo", "locomo-sample:<sample_id>",
               "locomo-dia:D<N>:<k>"]
    }
    ```
- Rationale: storing turn-by-turn lets `/recall` rank individual utterances.
  The `dia_id` tag preserves the evidence pointer so we can do retrieval-precision
  analysis later (did we surface the *right* turn?).

### 3.2 Query (per QA pair)

- `GET /recall?q=<question>&limit=5&type=test-conversation` — scoped to
  the test-conversation type so we don't pollute the ranking with real
  user data.
- Top-5 turns → concatenated into a context block `C`.
- Answer generation uses MLX generate (Qwen3-8B-4bit, port 3162) with
  prompt:
  ```
  Given the following conversation excerpts, answer the question.
  If the answer cannot be determined, reply "I don't know".

  <context C>

  Question: <q>
  Answer:
  ```

### 3.3 Judging

Two parallel scores per question:

| Method | Cost | Signal |
|--------|------|--------|
| **Exact/F1** | zero (string ops) | token overlap, deterministic |
| **LLM-J** | ~1 MLX call per Q | semantic equivalence |

For cat 5 (adversarial): refusal detector — contains any of
`["i don't know", "not mentioned", "cannot determine", "no information"]`
→ correct; otherwise incorrect unless string matches `adversarial_answer`.

### 3.4 Aggregation

```json
{
  "subset": "small",
  "n_questions": 10,
  "f1_mean": 0.42,
  "em": 0.10,
  "llm_j": 0.70,
  "by_category": { "1": {...}, "2": {...}, ... },
  "adversarial_correct_rate": 0.8,
  "latency_ms_mean": 1250,
  "ts": "2026-04-18T..."
}
```

Written back as `POST /store type=locomo-eval-result` so self-evolve and
the dashboard can read historical scores from vcontext itself.

## 4. Self-evolve integration

Self-evolve's fitness today is
`w1*keyword_hit + w2*token_reduction - w3*error_rate - w4*p95_latency`
(see `docs/analysis/2026-04-18-self-evolve-redesign.md`).

Add a new optional term:

```
fitness += w5 * (locomo_llm_j - locomo_baseline)   # bounded, ±0.3 weight
```

**Rollout plan**:

1. **Phase (d) Validate** in self-evolve — after a candidate is applied,
   run `locomo-eval.py --subset small` (10 Qs, ~30s wall). If
   `llm_j < baseline - 0.05` (5pt drop) → reject the candidate.
2. **Weekly full run** — LaunchAgent (`com.user.aios.locomo-weekly`) invokes
   `--subset full` Sunday 03:00 JST, writes the result entry, surfaces
   it on the vcontext dashboard.
3. **Dashboard card** — new "LoCoMo Score" tile showing last full run +
   trend vs previous 4 weeks.

Default: `gates.locomo_gate_enabled=false`. Flip to true once a baseline
is established (need ≥3 full runs to compute stddev).

## 5. Failure modes + mitigations

- **MLX not loaded** → judge LLM unavailable. Fall back to F1-only scoring
  and flag the result row `llm_j_missing=true`.
- **/recall returns 0 hits** → predicted="" → counts as failed. Logged so
  we can see retrieval-stage vs generation-stage failures separately.
- **Ingestion pollution** — `test-conversation` is a new type; `/prune` and
  `/recall?type=...` filters keep it isolated from real sessions. Cleanup
  helper: `--cleanup` flag DELETEs all `session=test-locomo-*` entries.
  (Not implemented in v1; add before first full run to avoid cluttering the
  2.8 GB DB with ~5k test turns.)
- **Dataset drift** — upstream could update `locomo10.json`. We cache
  under `data/locomo/locomo10.json` and log a SHA-256 in the result
  envelope; alerts on mismatch so scores remain comparable over time.

## 6. Current implementation status (as of commit)

- `scripts/locomo-eval.py` — CLI with `--subset {small,full}`, `--dry-run`,
  `--submit`. Standard library only (urllib, json, hashlib, http.client).
  Exercises `/store`, `/recall`, MLX generate, writes result entry.
- `data/locomo/locomo10.json` — real dataset (2.7 MB, 10 samples, 1986 QA).
- `data/locomo-mock.json` — 10 synthetic QA used when `--mock` is passed,
  for CI-style smoke tests without running MLX.

## 7. Next steps

1. Run a first `--subset full` offline and snapshot the baseline score.
2. Hook into self-evolve Phase (d) (gated by `locomo_gate_enabled`).
3. Wire the new card into `scripts/vcontext-dashboard.html`.
4. LaunchAgent spec for weekly run (separate task — do not add here).
5. Add `--cleanup` flag to drop `session LIKE 'test-locomo-%'` before
   first production full run.

## 8. Results (2026-04-18 first-run attempt)

**Status**: **BLOCKED** — see
[`2026-04-18-locomo-eval-blockers.md`](./2026-04-18-locomo-eval-blockers.md).
Result JSON (placeholder): `data/locomo-eval-result-2026-04-18.json`.

**Summary of findings**: The harness code is finished and a structural
dry-run against `data/locomo-mock.json` (`--mock --dry-run --no-llm-judge`)
completes in <100ms producing the full `{config, summary, aggregate,
per_question}` envelope required by the task. An end-to-end run against
the real LoCoMo `sample[0]` (`conv-26`, 199 QA, first 10 under
`--subset small`) could not be performed because both dependent services
were unhealthy: vcontext (:3150) was in a SIGKILL restart loop
(`/tmp/vcontext-server.log` shows 7+ consecutive OOM kills) and MLX
generate (:3162) was wedged (`U<` process state, requests to
`/v1/chat/completions` never returning; system swap at 15.8G/16G).
Root cause is system-wide memory pressure, not a harness defect. All
harness improvements from this session (FTS proper-noun preservation,
MLX CoT-reasoning fallback, retrieval scoring via dia_id tags,
task-aligned output schema) ship as-is in `scripts/locomo-eval.py` and
are ready for the next healthy-infrastructure window.

---

### Appendix A — verified facts vs inferences

| Claim | Source | Verified? |
|-------|--------|-----------|
| 10 conversations, 1986 QA | downloaded file | YES |
| Speakers, session structure | downloaded file | YES |
| Categories 1-5 integer coded | downloaded file | YES |
| Cat 5 = adversarial, has `adversarial_answer` | downloaded file | YES |
| F1 + LLM-J are canonical metrics | multiple community repos (Mem0, Zep, Memobase) | corroborated |
| Category semantics (1 single-hop, 2 multi-hop…) | paper convention | inferred |
| 50→10 subsample reason | upstream README | YES |

All time-sensitive claims (e.g. dataset version) were verified by direct
fetch at 2026-04-18 against the snap-research/locomo main branch.
