---
name: aios-skill-bridge
description: |
  ~/skills/skills/ のSKILL.mdをAIOSのBaseTool/BaseAgentとして公開する
  ブリッジ実装ワークフロー。vcontextのskill-registryをAIOS LLM Kernelから
  呼び出せるToolとして登録し、スキルをエージェントフックで自動ロードする。
  Use when connecting the ~/skills/ system to an AIOS project, exposing
  skills as AIOS tools, or loading skills inside an AIOS agent.
origin: unified
---

# AIOS Skill Bridge

## アーキテクチャ

```
~/skills/skills/<name>/SKILL.md
        ↓  vcontext登録(skill-creator)
vcontext skill-registry (type='skill-registry')
        ↓  SkillsTool(BaseTool) が recall
AIOS LLM Kernel → useCore() で呼び出し
        ↓
Agent がスキルワークフローを実行
```

## SkillsTool 実装

```python
# aios/tools/skills_tool.py
import requests
from cerebrum.tool.base import BaseTool

class SkillsTool(BaseTool):
    """~/skills/ のスキルをAIOSツールとして公開"""

    def __init__(self):
        self.vcontext_url = "http://127.0.0.1:3150"

    @property
    def name(self) -> str:
        return "skills_tool"

    @property
    def description(self) -> str:
        return "Search and retrieve workflow skills from the local skill registry"

    def get_tool_call_format(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": "skills_tool",
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Describe what you want to do"
                        },
                        "limit": {
                            "type": "integer",
                            "default": 3,
                            "description": "Max skills to return"
                        }
                    },
                    "required": ["query"]
                }
            }
        }

    def run(self, params: dict) -> dict:
        query = params.get("query", "")
        limit = params.get("limit", 3)

        # vcontextからスキルを意味検索
        r = requests.get(f"{self.vcontext_url}/recall", params={
            "q": query,
            "limit": limit,
            "type": "skill-registry"
        })
        results = r.json().get("results", [])

        skills = []
        for entry in results:
            try:
                import json
                skill = json.loads(entry["content"])
                # SKILL.mdの内容も読み込む
                skill_path = f"/Users/mitsuru_nakajima/skills/skills/{skill['name']}/SKILL.md"
                try:
                    with open(skill_path) as f:
                        skill["workflow"] = f.read()
                except FileNotFoundError:
                    pass
                skills.append(skill)
            except Exception:
                continue

        return {
            "status": "success",
            "skills_found": len(skills),
            "skills": skills
        }
```

## AIOS エージェントフックへの統合

```python
# aios/hooks/modules/skills_loader.py
# このファイルをAIOSのhookエントリポイントとして配置

from aios.tools.skills_tool import SkillsTool

def on_agent_start(agent, context):
    """エージェント起動時にスキルツールを自動登録"""
    if not hasattr(agent, '_skills_tool'):
        agent._skills_tool = SkillsTool()
        # エージェントのツールリストに追加
        if hasattr(agent, 'tools'):
            agent.tools.append(agent._skills_tool)

def get_tools():
    """AIOS tool registryに登録するツール一覧"""
    return [SkillsTool()]
```

## AIOS設定への追加

```yaml
# aios/config/config.yaml
tools:
  - module: "aios.tools.skills_tool"
    class: "SkillsTool"
    enabled: true

hooks:
  on_agent_start:
    - module: "aios.hooks.modules.skills_loader"
      function: "on_agent_start"
```

## スキルをAIOSエージェントから呼び出す

```python
# エージェント内での使用例
from cerebrum.client import Cerebrum

with Cerebrum() as client:
    result = client.call_tool(
        "skills_tool",
        {"query": "メモリリークのテストをしたい", "limit": 2}
    )
    
    # 取得したスキルのワークフローをLLMに渡す
    for skill in result["skills"]:
        print(f"スキル: {skill['name']}")
        print(f"ワークフロー: {skill.get('workflow', '')[:200]}")
```

## インストール確認

```bash
# SkillsToolが正常に動作するかテスト
python3 -c "
from aios.tools.skills_tool import SkillsTool
tool = SkillsTool()
result = tool.run({'query': 'memory leak test', 'limit': 2})
print(f'スキル検索結果: {result[\"skills_found\"]}件')
for s in result['skills']:
    print(f'  - {s[\"name\"]}: {s[\"description\"][:60]}')
"

# AIOS起動時にスキルが読み込まれるか確認
python3 -c "
import requests
r = requests.get('http://127.0.0.1:3150/recall', params={'q': 'aios', 'limit': 10, 'type': 'skill-registry'})
skills = [s for s in r.json().get('results', [])]
print(f'登録済みAIOSスキル: {len(skills)}件')
"
```

## Workflow

1. `aios/tools/skills_tool.py` を作成（上記コードをコピー）
2. `aios/hooks/modules/skills_loader.py` を作成
3. `aios/config/config.yaml` にtool/hookを追加
4. `python3 -c "from aios.tools.skills_tool import SkillsTool; ..."` で動作確認
5. AIOSエージェントから `client.call_tool("skills_tool", {...})` で呼び出し

## Gotchas

- vcontextが127.0.0.1:3150で稼働中であること必須 — `launchctl start com.vcontext.server`
- SKILL.mdのパスはハードコードを避けて `SKILLS_ROOT` env varを使う
- skill-registryに登録されていないスキルは意味検索でヒットしない
- AIOSのhooksディレクトリは `aios/hooks/modules/` — 他の場所に置くと読み込まれない
- `get_tool_call_format()` のschemaはOpenAI function-call形式必須
