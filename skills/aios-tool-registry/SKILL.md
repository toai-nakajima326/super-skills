---
name: aios-tool-registry
description: |
  MCPサーバーやカスタム関数をAIOS BaseTool形式で統一登録するワークフロー。
  vcontextのtool-registryへの登録・検索・ライフサイクル管理を標準化する。
  Use when adding new tools to the AIOS system or auditing registered tools.
origin: unified
---

# AIOS Tool Registry

## コンセプト

AIOSのToolManagerパターンをvcontextベースで実装する。
ツールは `get_tool_call_format()` + `run(params)` の2メソッドを持つ単位として定義。

## ツール定義形式

```python
# tools/<author>/<tool_name>/tool.py
class MyTool:
    name = "author/tool_name"
    description = "何をするツールか"
    
    def get_tool_call_format(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "input": {"type": "string", "description": "入力"}
                    },
                    "required": ["input"]
                }
            }
        }
    
    def run(self, params: dict) -> str:
        return str(params.get("input", ""))
```

## vcontextへの登録

```bash
# ツールをvcontextのtool-registryに登録
node -e "
const http = require('http');
const tool = {
  name: 'author/tool_name',
  description: 'ツールの説明',
  schema: {
    type: 'function',
    function: {
      name: 'tool_name',
      description: 'ツールの説明',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input']
      }
    }
  },
  endpoint: 'http://127.0.0.1:<port>/tools/tool_name',
  mcp_server: 'optional_mcp_server_name',
  registered_at: new Date().toISOString()
};
const payload = JSON.stringify({
  type: 'tool-registry',
  content: JSON.stringify(tool),
  tags: ['tool-registry', 'tool:' + tool.name],
  session: 'system'
});
const opts = { host: '127.0.0.1', port: 3150, path: '/store', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }};
const req = http.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(r.statusCode, d.slice(0,100))); });
req.write(payload); req.end();
"
```

## 登録済みツール一覧

```bash
# tool-registryエントリをすべて取得
curl -s 'http://127.0.0.1:3150/recall?q=tool-registry&limit=50' | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
tools = [r for r in d['results'] if r.get('type') == 'tool-registry']
print(f'登録済みツール: {len(tools)}件')
for t in tools:
  try:
    c = json.loads(t['content'])
    print(f'  {c[\"name\"]} — {c[\"description\"][:50]}')
  except: pass
"
```

## MCP統合パターン

```bash
# 既存MCPサーバーのツールをtool-registryに一括登録
# ~/.claude/settings.json の mcpServers から自動生成
node -e "
const fs = require('fs');
const http = require('http');
const settings = JSON.parse(fs.readFileSync(process.env.HOME + '/.claude/settings.json'));
const mcpServers = settings.mcpServers || {};
Object.entries(mcpServers).forEach(([name, config]) => {
  const payload = JSON.stringify({
    type: 'tool-registry',
    content: JSON.stringify({ name, mcp_server: name, command: config.command, args: config.args }),
    tags: ['tool-registry', 'mcp-server:' + name],
    session: 'system'
  });
  const opts = { host: '127.0.0.1', port: 3150, path: '/store', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }};
  http.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log('registered:', name, r.statusCode)); }).end(payload);
});
"
```

## Workflow

1. 新ツールを `tools/<author>/<name>/tool.py` に実装
2. `get_tool_call_format()` でOpenAI互換スキーマを定義
3. vcontext tool-registryに登録
4. aios-schedulerがツール呼び出し時にregistryから検索
5. 不要になったらvcontextから削除（type=tool-registry, name=X）

## Gotchas

- ツール名は `author/name` 形式で一意にする
- `run()` は常に文字列を返す（エラー時も `{"error": "..."}` 形式で）
- MCPサーバー経由のツールはendpointではなくmcp_serverフィールドを使う
- 同名ツールの再登録は新エントリを作るので定期的にdedup実行
