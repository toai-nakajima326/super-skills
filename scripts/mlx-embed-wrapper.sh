#!/bin/bash
# MLX Embed Server wrapper — launched by launchd (com.vcontext.mlx-embed)
# Runs Qwen3-Embedding via MLX on Apple Silicon GPU, port 3161
# This is the sole embedding provider for vcontext (24/7, no night-window restriction)

set -euo pipefail

export PATH="/Users/mitsuru_nakajima/.pyenv/versions/3.12.0/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_PY="${SCRIPT_DIR}/mlx-embed-server.py"

# Default model: 8B for quality (Qwen3-Embedding-8B, MTEB #1); override with MLX_EMBED_MODEL env var
MODEL="${MLX_EMBED_MODEL:-8B}"
PORT="${MLX_EMBED_PORT:-3161}"
HOST="127.0.0.1"

echo "[mlx-embed-wrapper] Starting MLX embed server: model=${MODEL} port=${PORT}"
exec python3 "${SERVER_PY}" --model "${MODEL}" --port "${PORT}" --host "${HOST}"
