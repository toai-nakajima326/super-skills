#!/usr/bin/env python3
"""Convert BGE-small-en-v1.5 to CoreML.

Strategy: Build a raw PyTorch model from pretrained weights, avoiding
transformers' forward() tracing issues with v5.x. We replicate the
BERT-small architecture manually for clean JIT tracing.
"""

import os
import math
import torch
import torch.nn as nn
import numpy as np
import coremltools as ct
from transformers import AutoTokenizer, AutoConfig, AutoModel

MODEL_NAME = "BAAI/bge-small-en-v1.5"
OUTPUT_PATH = "/Volumes/VContext/bge-small-coreml.mlpackage"
SEQ_LEN = 128


class BertEmbeddings(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.word_embeddings = nn.Embedding(config.vocab_size, config.hidden_size, padding_idx=config.pad_token_id)
        self.position_embeddings = nn.Embedding(config.max_position_embeddings, config.hidden_size)
        self.token_type_embeddings = nn.Embedding(config.type_vocab_size, config.hidden_size)
        self.LayerNorm = nn.LayerNorm(config.hidden_size, eps=config.layer_norm_eps)
        self.dropout = nn.Dropout(config.hidden_dropout_prob)

    def forward(self, input_ids, token_type_ids):
        seq_length = input_ids.size(1)
        position_ids = torch.arange(seq_length, device=input_ids.device).unsqueeze(0)
        embeddings = self.word_embeddings(input_ids) + self.position_embeddings(position_ids) + self.token_type_embeddings(token_type_ids)
        return self.dropout(self.LayerNorm(embeddings))


class BertSelfAttention(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.num_attention_heads = config.num_attention_heads
        self.attention_head_size = config.hidden_size // config.num_attention_heads
        self.all_head_size = self.num_attention_heads * self.attention_head_size
        self.query = nn.Linear(config.hidden_size, self.all_head_size)
        self.key = nn.Linear(config.hidden_size, self.all_head_size)
        self.value = nn.Linear(config.hidden_size, self.all_head_size)
        self.dropout = nn.Dropout(config.attention_probs_dropout_prob)

    def transpose_for_scores(self, x):
        new_shape = x.size()[:-1] + (self.num_attention_heads, self.attention_head_size)
        x = x.view(new_shape)
        return x.permute(0, 2, 1, 3)

    def forward(self, hidden_states, attention_mask):
        q = self.transpose_for_scores(self.query(hidden_states))
        k = self.transpose_for_scores(self.key(hidden_states))
        v = self.transpose_for_scores(self.value(hidden_states))
        scores = torch.matmul(q, k.transpose(-1, -2)) / math.sqrt(self.attention_head_size)
        scores = scores + attention_mask
        attn_probs = self.dropout(torch.softmax(scores, dim=-1))
        context = torch.matmul(attn_probs, v)
        context = context.permute(0, 2, 1, 3).contiguous()
        context = context.view(context.size(0), context.size(1), self.all_head_size)
        return context


class BertLayer(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.attention = BertSelfAttention(config)
        self.attn_output = nn.Linear(config.hidden_size, config.hidden_size)
        self.attn_ln = nn.LayerNorm(config.hidden_size, eps=config.layer_norm_eps)
        self.intermediate = nn.Linear(config.hidden_size, config.intermediate_size)
        self.output_dense = nn.Linear(config.intermediate_size, config.hidden_size)
        self.output_ln = nn.LayerNorm(config.hidden_size, eps=config.layer_norm_eps)
        self.dropout = nn.Dropout(config.hidden_dropout_prob)

    def forward(self, hidden_states, attention_mask):
        attn_output = self.attention(hidden_states, attention_mask)
        attn_output = self.dropout(self.attn_output(attn_output))
        hidden_states = self.attn_ln(attn_output + hidden_states)
        intermediate = torch.nn.functional.gelu(self.intermediate(hidden_states))
        layer_output = self.dropout(self.output_dense(intermediate))
        hidden_states = self.output_ln(layer_output + hidden_states)
        return hidden_states


class BGESmallModel(nn.Module):
    """Minimal BERT for embedding: embeddings + encoder layers + CLS pooling + L2 norm."""
    def __init__(self, config):
        super().__init__()
        self.embeddings = BertEmbeddings(config)
        self.layers = nn.ModuleList([BertLayer(config) for _ in range(config.num_hidden_layers)])

    def forward(self, input_ids, attention_mask, token_type_ids):
        # Expand attention mask: (batch, seq) -> (batch, 1, 1, seq)
        extended_mask = attention_mask.unsqueeze(1).unsqueeze(2).float()
        extended_mask = (1.0 - extended_mask) * -10000.0

        hidden = self.embeddings(input_ids, token_type_ids)
        for layer in self.layers:
            hidden = layer(hidden, extended_mask)

        # CLS pooling + L2 normalize
        cls = hidden[:, 0, :]
        norm = torch.norm(cls, p=2, dim=1, keepdim=True)
        return cls / norm.clamp(min=1e-12)


def copy_weights(our_model, hf_model):
    """Copy weights from HuggingFace BERT to our minimal BERT."""
    sd_hf = hf_model.state_dict()
    sd_ours = our_model.state_dict()

    mapping = {}
    # Embeddings
    for name in ["word_embeddings.weight", "position_embeddings.weight",
                 "token_type_embeddings.weight", "LayerNorm.weight", "LayerNorm.bias"]:
        mapping[f"embeddings.{name}"] = f"embeddings.{name}"

    # Layers
    for i in range(len(our_model.layers)):
        pfx_hf = f"encoder.layer.{i}"
        pfx_ours = f"layers.{i}"
        # Self-attention Q/K/V
        for proj in ["query", "key", "value"]:
            for p in ["weight", "bias"]:
                mapping[f"{pfx_ours}.attention.{proj}.{p}"] = f"{pfx_hf}.attention.self.{proj}.{p}"
        # Attention output
        mapping[f"{pfx_ours}.attn_output.weight"] = f"{pfx_hf}.attention.output.dense.weight"
        mapping[f"{pfx_ours}.attn_output.bias"] = f"{pfx_hf}.attention.output.dense.bias"
        mapping[f"{pfx_ours}.attn_ln.weight"] = f"{pfx_hf}.attention.output.LayerNorm.weight"
        mapping[f"{pfx_ours}.attn_ln.bias"] = f"{pfx_hf}.attention.output.LayerNorm.bias"
        # FFN
        mapping[f"{pfx_ours}.intermediate.weight"] = f"{pfx_hf}.intermediate.dense.weight"
        mapping[f"{pfx_ours}.intermediate.bias"] = f"{pfx_hf}.intermediate.dense.bias"
        mapping[f"{pfx_ours}.output_dense.weight"] = f"{pfx_hf}.output.dense.weight"
        mapping[f"{pfx_ours}.output_dense.bias"] = f"{pfx_hf}.output.dense.bias"
        mapping[f"{pfx_ours}.output_ln.weight"] = f"{pfx_hf}.output.LayerNorm.weight"
        mapping[f"{pfx_ours}.output_ln.bias"] = f"{pfx_hf}.output.LayerNorm.bias"

    new_sd = {}
    for our_key, hf_key in mapping.items():
        if hf_key in sd_hf:
            new_sd[our_key] = sd_hf[hf_key]
        else:
            print(f"  WARNING: missing {hf_key}")

    our_model.load_state_dict(new_sd, strict=True)
    print(f"  Copied {len(new_sd)} parameter tensors")


def main():
    print(f"[1/5] Loading HuggingFace model: {MODEL_NAME}")
    config = AutoConfig.from_pretrained(MODEL_NAME)
    hf_model = AutoModel.from_pretrained(MODEL_NAME)
    hf_model.eval()
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

    print(f"[2/5] Building minimal BERT and copying weights")
    print(f"  Config: hidden={config.hidden_size}, layers={config.num_hidden_layers}, heads={config.num_attention_heads}")
    our_model = BGESmallModel(config)
    copy_weights(our_model, hf_model)
    our_model.eval()

    # Verify output matches
    test_text = "neural engine embedding test"
    inputs = tokenizer(test_text, return_tensors="pt", padding="max_length", max_length=SEQ_LEN, truncation=True)
    with torch.no_grad():
        hf_out = hf_model(**inputs)
        hf_cls = hf_out.last_hidden_state[:, 0, :]
        hf_norm = torch.norm(hf_cls, p=2, dim=1, keepdim=True)
        hf_emb = (hf_cls / hf_norm.clamp(min=1e-12)).squeeze()

        our_emb = our_model(inputs["input_ids"], inputs["attention_mask"], inputs["token_type_ids"]).squeeze()

    cos_sim = torch.nn.functional.cosine_similarity(hf_emb.unsqueeze(0), our_emb.unsqueeze(0)).item()
    print(f"  Weight copy verification — cosine similarity: {cos_sim:.6f}")
    assert cos_sim > 0.999, f"Weight copy failed: cosine similarity = {cos_sim}"

    print(f"[3/5] Tracing model (seq_len={SEQ_LEN})")
    dummy_ids = torch.randint(0, config.vocab_size, (1, SEQ_LEN))
    dummy_mask = torch.ones(1, SEQ_LEN, dtype=torch.long)
    dummy_type = torch.zeros(1, SEQ_LEN, dtype=torch.long)

    with torch.no_grad():
        traced = torch.jit.trace(our_model, (dummy_ids, dummy_mask, dummy_type))

    print("[4/5] Converting to CoreML (compute_units=ALL for NPU)")
    mlmodel = ct.convert(
        traced,
        inputs=[
            ct.TensorType(name="input_ids", shape=(1, SEQ_LEN), dtype=np.int32),
            ct.TensorType(name="attention_mask", shape=(1, SEQ_LEN), dtype=np.int32),
            ct.TensorType(name="token_type_ids", shape=(1, SEQ_LEN), dtype=np.int32),
        ],
        outputs=[
            ct.TensorType(name="embedding"),
        ],
        compute_units=ct.ComputeUnit.ALL,
        minimum_deployment_target=ct.target.macOS13,
    )

    print(f"[5/5] Saving to {OUTPUT_PATH}")
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    mlmodel.save(OUTPUT_PATH)

    from pathlib import Path
    size = sum(f.stat().st_size for f in Path(OUTPUT_PATH).rglob("*") if f.is_file())
    print(f"\n--- Results ---")
    print(f"Model saved: {OUTPUT_PATH}")
    print(f"Size: {size / 1e6:.1f} MB")
    print(f"Embedding dim: 384")
    print(f"Sequence length: {SEQ_LEN}")
    print(f"Weight fidelity: cosine similarity = {cos_sim:.6f}")
    print("Conversion complete!")

if __name__ == "__main__":
    main()
