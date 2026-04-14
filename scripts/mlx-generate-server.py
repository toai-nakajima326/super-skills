#!/usr/bin/env python3
"""MLX Generate Server — OpenAI-compatible text generation with memory management.

Uses mlx-lm for inference, adds mx.metal.clear_cache() every N calls
to prevent GPU memory growth. Drop-in replacement for `mlx_lm.server`.

Port 3162 by default.
"""

import gc
import os
import sys
import time
import uuid
import json
import argparse
import logging
from typing import Optional, List, Dict, Any

import mlx.core as mx
from mlx_lm import load, generate

# Limit Metal GPU cache to 6GB
mx.metal.set_cache_limit(6 * 1024 * 1024 * 1024)

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")

# ── CLI args ──────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="MLX Generate Server")
parser.add_argument("--model", default="mlx-community/Qwen3-8B-4bit", help="Model name")
parser.add_argument("--port", type=int, default=3162, help="Port")
parser.add_argument("--host", default="127.0.0.1", help="Host")
parser.add_argument("--max-tokens", type=int, default=2048, help="Max tokens per generation")
parser.add_argument("--cache-clear-interval", type=int, default=5, help="Clear GPU cache every N calls")
args = parser.parse_args()

# ── Load model ────────────────────────────────────────────────
logger.info(f"Loading model: {args.model}")
t0 = time.time()
model, tokenizer = load(args.model)
logger.info(f"Model loaded in {time.time()-t0:.1f}s")

# ── State ─────────────────────────────────────────────────────
call_count = 0

# ── Generation ────────────────────────────────────────────────
def do_generate(messages: List[Dict], max_tokens: int = 500, temperature: float = 0.3) -> Dict[str, Any]:
    global call_count

    # Build prompt from messages using chat template
    if hasattr(tokenizer, 'apply_chat_template'):
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    else:
        # Fallback: concatenate messages
        prompt = "\n".join(f"{m['role']}: {m['content']}" for m in messages)

    t0 = time.time()
    response = generate(
        model, tokenizer, prompt=prompt,
        max_tokens=min(max_tokens, args.max_tokens),
        verbose=False,
    )
    elapsed = time.time() - t0

    # Count and clear cache periodically
    call_count += 1
    if call_count % args.cache_clear_interval == 0:
        if hasattr(mx, 'metal') and hasattr(mx.metal, 'clear_cache'):
            mx.metal.clear_cache()
        gc.collect()
        logger.info(f"[memory] Cleared cache after {call_count} calls")

    # Parse response — Qwen3 includes <think>...</think> blocks
    content = response
    reasoning = ""
    if "<think>" in response:
        if "</think>" in response:
            # Complete thinking block: extract both
            think_end = response.index("</think>")
            reasoning = response[response.index("<think>")+7:think_end].strip()
            content = response[think_end+8:].strip()
        else:
            # Incomplete thinking (max_tokens hit mid-think): all is reasoning
            reasoning = response.replace("<think>", "").strip()
            content = ""

    # Estimate tokens (rough: 1 token ≈ 4 chars for CJK/English mix)
    prompt_tokens = len(prompt) // 4
    completion_tokens = len(response) // 4

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "model": args.model,
        "created": int(time.time()),
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": content,
                **({"reasoning": reasoning} if reasoning else {}),
            }
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }
    }

# ── HTTP Server (ThreadingMixin for non-blocking health checks) ──
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
import threading

# Lock to serialize generation (MLX is not thread-safe) while allowing health checks
_generate_lock = threading.Lock()

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *a):
        logger.info(f"{self.client_address[0]} - {format % a}")

    def _send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health" or self.path == "/v1/health":
            mem_mb = mx.get_active_memory() / 1e6 if hasattr(mx, 'get_active_memory') else 0
            self._send_json(200, {
                "status": "healthy",
                "model": args.model,
                "calls": call_count,
                "memory_mb": round(mem_mb, 1),
                "cache_clear_interval": args.cache_clear_interval,
            })
        elif self.path == "/v1/models" or self.path == "/models":
            self._send_json(200, {
                "object": "list",
                "data": [{"id": args.model, "object": "model", "created": int(time.time())}]
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/v1/chat/completions":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length))
                messages = body.get("messages", [])
                max_tokens = body.get("max_tokens", 500)
                temperature = body.get("temperature", 0.3)

                with _generate_lock:
                    result = do_generate(messages, max_tokens, temperature)
                self._send_json(200, result)
                logger.info(f"POST /v1/chat/completions - {result['usage']['completion_tokens']} tokens in {result['usage']['prompt_tokens']+result['usage']['completion_tokens']}t")
            except Exception as e:
                logger.error(f"Generate error: {e}", exc_info=True)
                self._send_json(500, {"error": str(e)})
        else:
            self._send_json(404, {"error": "not found"})

if __name__ == "__main__":
    server = ThreadedHTTPServer((args.host, args.port), Handler)
    logger.info(f"MLX Generate Server running at http://{args.host}:{args.port}")
    logger.info(f"Model: {args.model} | Cache clear every {args.cache_clear_interval} calls | Metal cache limit: 6GB")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        server.shutdown()
