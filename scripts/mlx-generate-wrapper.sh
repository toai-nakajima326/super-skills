#!/bin/bash
# MLX Generate Server wrapper — vllm-mlx (replaces custom mlx-generate-server.py)
# OpenAI-compatible API on port 3162 with continuous batching + Qwen3 reasoning parser

set -euo pipefail

export PATH="/Users/mitsuru_nakajima/.pyenv/versions/3.13.2/bin:$PATH"

MODEL="${MLX_GENERATE_MODEL:-mlx-community/Qwen3-8B-4bit}"
PORT="${MLX_GENERATE_PORT:-3162}"
HOST="127.0.0.1"

echo "[mlx-generate-wrapper] Starting vllm-mlx: model=${MODEL} port=${PORT}"
exec python3 -m vllm_mlx.server \
  --model "${MODEL}" \
  --port "${PORT}" \
  --host "${HOST}" \
  --reasoning-parser qwen3 \
  --max-tokens 500 \
  --continuous-batching
