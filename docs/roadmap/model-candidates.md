# Model Candidates — future consideration

*Registry of LLM/embedding model candidates evaluated for AIOS. Not a
buy-list — a memory. Keeps the "why not today" reasoning so we don't
re-evaluate from scratch when the host environment changes.*

---

## Qwen3.6-35B-A3B Q4_K_XL

**Evaluated**: 2026-04-20
**Status**: **DEFERRED** — stability first. User explicit: "今後の検討事項にします、まずは安定化を優先"
**Re-evaluate when**: (a) 2nd Mac for federated MLX, or (b) host memory headroom > 25 GB free sustained

### What it is
- Qwen3.6 family (2026-04 release, Alibaba)
- 35B params total, **3B active per forward pass (A3B MoE)**
- 256 K context (vs current Qwen3-8B's 32 K — 8× larger)
- Multimodal (text + vision via `mlx-vlm`)
- MLX-native support on Apple Silicon
- Claims competitive with Claude Sonnet 4.5 on vision benchmarks

### Quant sizes (from unsloth / nowokay blog, 2026-04 actual measurements)
| Quant | File size | 4K ctx RAM | 262K ctx RAM |
|---|---|---|---|
| Q4_K_XL | 24.1 GB | 23.77 GB | **28.66 GB** |
| IQ4_XS  | 17.7 GB | ~18 GB    | ~22 GB       |

### Why valuable for AIOS
- self-evolve proposal quality (35B capacity >> current 8B dense)
- LoCoMo long-context reasoning (256 K ctx unlocks multi-hop)
- skill-discovery pattern recognition
- conversation-skill-miner natural-language understanding
- A3B means 3B compute speed (~40-50 tok/s on Apple Silicon)

### Why NOT today (memory budget)
- Current 36 GB Mac already at the jetsam ceiling (111 kills today)
- Loading 24 GB Q4_K_XL pushes system heavily into swap → certain cascade
- Even IQ4_XS (17.7 GB) leaves marginal headroom with vcontext + mlx-embed + Chrome + Codex

### Path when ready (staged)
1. **Step 1** (first achievable): `IQ4_XS` + existing MLX lazy-load proxy (port 3162/3163). Idle 0 GB, active 18 GB for ~10 min window. Quality ≈ 90 % of Q4_K_XL. **Half-day effort** (download + proxy backend swap).
2. **Step 2**: Federated MLX on a 2nd Mac. Primary Mac keeps vcontext-server + embed; 2nd Mac runs 35B generate.
3. **Step 3**: `Q4_K_XL` full quality via federation.

### Leave-behind
- Do NOT attempt `Q4_K_XL` on the current machine. History shows jetsam
  will kill vcontext the first time the 35B loads.
- If someone tries Step 1 on this machine: be ready to revert the proxy
  backend if free_pages drops below 30,000 during warm-up.

---

*When other models surface (next Qwen release, Llama variants, Mistral
updates), add them here with the same structure. Memory table + "why
not today" + staged path = decision capital we don't lose.*
