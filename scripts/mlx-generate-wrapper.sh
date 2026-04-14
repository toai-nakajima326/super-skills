#!/bin/bash
# MLX Generate Server wrapper — launched by launchd (com.vcontext.mlx-generate)
# Runs Qwen3-8B via MLX for text generation (summarization, skill creation)
# OpenAI-compatible API on port 3162

set -euo pipefail

export PATH="/Users/mitsuru_nakajima/.pyenv/versions/3.12.0/bin:$PATH"

MODEL="${MLX_GENERATE_MODEL:-mlx-community/Qwen3-8B-4bit}"
PORT="${MLX_GENERATE_PORT:-3162}"
HOST="127.0.0.1"

echo "[mlx-generate-wrapper] Starting MLX generate server: model=${MODEL} port=${PORT}"
exec python3 -m mlx_lm server \
  --model "${MODEL}" \
  --port "${PORT}" \
  --host "${HOST}" \
  --max-tokens 2048
