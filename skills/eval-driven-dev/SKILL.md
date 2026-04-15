---
name: eval-driven-dev
description: "Use when building or testing AI-powered applications. Applies evaluator-optimizer pipelines, golden dataset creation, and self-critique loops to close the 'evaluation gap' between pre-deployment test results and real-world LLM behavior."
origin: web-discovery
---

## Rules

1. **Evaluation gap**: pre-deployment test results do not reliably predict real-world LLM performance. Never claim a feature is done without eval coverage.
2. **Golden datasets over assertions**: for LLM outputs, a static golden dataset of input→expected_output pairs is more reliable than code assertions.
3. **Evaluate the evaluator**: every evaluator (LLM-as-judge, rubric, heuristic) must itself be validated against human labels before it is trusted.
4. **Separate concerns**: generation and evaluation must run in separate contexts — never let the generator evaluate its own output in the same LLM call.
5. **Regression gates**: evals are CI gates. A passing eval suite is required before shipping any prompt or model change.

## Workflow — Golden Dataset Creation

1. Identify the task the LLM must perform (e.g., summarize, classify, extract, generate)
2. Collect 20–50 representative real inputs that cover edge cases and failure modes
3. For each input, write the expected output (or a rubric describing acceptable outputs)
4. Store as `evals/golden/<task-name>.jsonl` — one JSON object per line: `{"input": ..., "expected": ...}`
5. Validate the dataset: remove duplicates, ensure edge case coverage, get a second human review
6. Baseline: run the current model/prompt against the dataset; record pass rate as the baseline score

## Workflow — Evaluator-Optimizer Pipeline

```
Input → Generator (LLM) → Draft Output
                              ↓
                         Evaluator (separate LLM call or heuristic)
                              ↓ score + critique
                         Optimizer (refine prompt or output if below threshold)
                              ↓ (loop max N times)
                         Final Output
```

1. **Generator**: produces the draft using the current prompt
2. **Evaluator**: a separate LLM call (or deterministic heuristic) that scores and critiques the draft
   - Use a rubric: enumerate specific criteria each weighted 0–1
   - Score each criterion independently; sum for final score
3. **Optimizer**: if score < threshold, feed the critique back to the generator: "Your draft scored X on criteria Y. Revise."
4. **Termination**: stop when score ≥ threshold OR max iterations (usually 3) reached
5. Log every iteration's score for debugging

## Workflow — Self-Critique Loop (simpler variant)

For single-step generation where a full pipeline is overkill:

1. Generate initial output
2. Append: *"Review your output above. Is it correct, complete, and consistent with the requirements? List any issues."*
3. If issues found, ask the model to fix them
4. Apply once — self-critique past 2 iterations has diminishing returns

## Evals as CI Gates

Add an eval step to your CI pipeline:

```yaml
# Example CI step
- name: Run evals
  run: npx run-evals --dataset evals/golden/ --threshold 0.85
  fail-on: score < 0.85
```

- Gate on **pass rate**, not individual failures (some variance is expected)
- Track pass rate over time to detect prompt regression
- Alert on >5% drop between releases

## When to Use Each Approach

| Scenario | Approach |
|----------|----------|
| LLM output quality for a feature | Golden dataset + evaluator-optimizer |
| Quick one-off generation | Self-critique loop (1 pass) |
| Prompt regression during refactor | CI eval gate on golden dataset |
| New model/prompt evaluation | Baseline comparison on golden dataset |
| Production monitoring | Sample real outputs, label, compare to baseline |

## Gotchas

- LLM-as-judge is biased toward outputs that look like the judge's own style. Use rubrics with specific, measurable criteria to reduce this.
- Golden datasets go stale. Review and update when requirements change or the model changes.
- Self-critique loops can produce confident-sounding wrong outputs. Always run a deterministic check (e.g., format validation, schema check) alongside LLM eval.
- Never use the same LLM call for both generation and evaluation — the model cannot reliably critique itself in one pass.
