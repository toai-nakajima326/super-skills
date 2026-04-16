#!/bin/bash
# MLX Generate Server wrapper — launched by launchd (com.vcontext.mlx-generate)
# Custom server with clear_cache() every 5 calls + 6GB Metal cache limit
# OpenAI-compatible API on port 3162

set -euo pipefail

export PATH="/Users/mitsuru_nakajima/.pyenv/versions/3.13.2/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_PY="${SCRIPT_DIR}/mlx-generate-server.py"

MODEL="${MLX_GENERATE_MODEL:-mlx-community/Qwen3-8B-4bit}"
PORT="${MLX_GENERATE_PORT:-3162}"
HOST="127.0.0.1"

echo "[mlx-generate-wrapper] Starting MLX generate server: model=${MODEL} port=${PORT}"
exec python3 "${SERVER_PY}" --model "${MODEL}" --port "${PORT}" --host "${HOST}" --cache-clear-interval 5
