#!/bin/bash
# pre-commit-gate.sh — PreToolUse hook for git commit
# Blocks commit if source code was changed without running tests

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Only trigger on git commit commands
if echo "$CMD" | grep -qE '^(CHECKER_VERIFIED=1 )?git commit'; then
  # Check if source files were modified
  CWD=$(echo "$INPUT" | jq -r '.cwd // "."' 2>/dev/null)
  HAS_SRC_CHANGES=$(cd "$CWD" 2>/dev/null && git diff --cached --name-only 2>/dev/null | grep -cE '\.(ts|tsx|js|jsx)$' || true)
  HAS_SRC_CHANGES=${HAS_SRC_CHANGES:-0}
  HAS_SRC_CHANGES=$(echo "$HAS_SRC_CHANGES" | tr -d '[:space:]')

  if [ "$HAS_SRC_CHANGES" -gt 0 ] && ! echo "$CMD" | grep -q 'CHECKER_VERIFIED=1'; then
    cat <<'HOOK_JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"\n⚠️  ソースコード変更を検出しました。\n  以下を確認してください:\n  □ チェッカーペアで検証済みか？\n  □ 仕様書の定量値との反映率を確認したか？\n  □ Design.md準拠か？\n\n  確認済みなら CHECKER_VERIFIED=1 git commit ... で再実行"}, "continue": false, "stopReason": "テスト未実行のコミットをブロックしました。CHECKER_VERIFIED=1 を付けて再実行してください。"}
HOOK_JSON
  fi
fi
