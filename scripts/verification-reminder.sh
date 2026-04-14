#!/bin/bash
# verification-reminder.sh — PostToolUse hook for Edit|Write on source files
# Reminds Claude to run verification-loop after code changes

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_response.filePath // ""' 2>/dev/null)

if echo "$FILE" | grep -qE '\.(ts|tsx|js|jsx)$'; then
  cat <<'HOOK_JSON'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Stop hook feedback:\nCode was edited but no dev server is running. If the change is observable in a browser preview (per <when_to_verify>), call preview_start and follow <verification_workflow>. If not, end your turn without mentioning this check — do not announce that you're skipping."}}
HOOK_JSON
fi
