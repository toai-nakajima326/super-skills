---
name: aios-autonomous-learning
description: |
  self-evolveサイクルとAIOSエージェントを繋ぐ自律学習ループ。
  AIOSエージェントがスキルギャップを検出→vcontextにskill-suggestion登録→
  self-evolveが拾いpending-patch生成→承認後にAIOSへ自動反映→
  使用実績をfitness scoreにフィードバックする完全なループを実装する。
  Use when connecting the skill evolution system to AIOS agents for autonomous
  learning, skill gap detection, or feedback-driven skill improvement.
origin: unified
---

# AIOS Autonomous Learning

## 自律学習ループ全体像

```
┌─────────────────────────────────────────────────────────┐
│                    AIOS Agents                          │
│  タスク実行中にスキルギャップを検出                         │
│  → vcontext に skill-suggestion を登録                   │
└──────────────────────┬──────────────────────────────────┘
                       ↓  (Phase a Stream 5)
┌─────────────────────────────────────────────────────────┐
│                  self-evolve Cycle                       │
│  skill-suggestion を収集 → fitness スコアリング            │
│  → top-K を pending-patch として登録                      │
└──────────────────────┬──────────────────────────────────┘
                       ↓  (approve/auto-approve)
┌─────────────────────────────────────────────────────────┐
│              aios-learning-bridge.js                     │
│  pending-patch を監視 → 承認済みを SKILL.md に適用         │
│  → validate → vcontext skill-registry を更新             │
└──────────────────────┬──────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│                  AIOS Skill Pool                         │
│  SkillsTool(BaseTool) が新スキルを自動検出                  │
│  → エージェントが次回から使用可能                           │
└──────────────────────┬──────────────────────────────────┘
                       ↓  (usage tracking)
┌─────────────────────────────────────────────────────────┐
│              Fitness Feedback Loop                       │
│  skill-usage → adoption_rate → fitness スコア向上         │
│  → 次サイクルのスキル選定精度が上がる                        │
└─────────────────────────────────────────────────────────┘
```

## Stream 1: スキルギャップ検出（AIOSエージェント側）

```python
# aios/hooks/modules/skill_gap_detector.py
import requests
import json

VCONTEXT_URL = "http://127.0.0.1:3150"

def on_tool_not_found(agent, tool_name: str, context: dict):
    """
    エージェントが必要なツール/スキルを見つけられなかった時に呼ばれる
    """
    _register_skill_suggestion(
        name=tool_name,
        reason=f"Agent '{agent.name}' required tool '{tool_name}' but it was not found",
        context=context,
        confidence=0.7
    )

def on_task_failed_with_missing_skill(agent, task: str, error: str):
    """
    タスク失敗時にスキルギャップとして登録
    """
    # LLMでギャップを分析
    gap_analysis = _analyze_gap(agent, task, error)
    if gap_analysis.get('confidence', 0) >= 0.6:
        _register_skill_suggestion(
            name=gap_analysis['suggested_skill'],
            reason=gap_analysis['reasoning'],
            context={'task': task, 'error': error},
            confidence=gap_analysis['confidence']
        )

def _register_skill_suggestion(name: str, reason: str, context: dict, confidence: float):
    """
    vcontext に skill-suggestion として登録
    → self-evolve の Phase (a) Stream 5 が次サイクルで拾う
    """
    payload = {
        "type": "skill-suggestion",
        "content": json.dumps({
            "suggested_skill": name,
            "reason": reason,
            "context": context,
            "confidence": confidence,
            "source": "aios_agent",
            "created_at": __import__('datetime').datetime.utcnow().isoformat()
        }),
        "tags": ["skill-suggestion", "aios-learning", f"skill:{name}"],
        "session": "aios-autonomous-learning"
    }
    try:
        requests.post(f"{VCONTEXT_URL}/store", json=payload, timeout=3)
    except Exception:
        pass  # 記録失敗はサイレントに無視
```

## Stream 2: skill-usage トラッキング（fitness フィードバック）

```python
# aios/hooks/modules/skill_usage_tracker.py
def on_skill_used(agent, skill_name: str, result: dict):
    """
    スキルが使われるたびに vcontext に記録
    → self-evolve の fitness.adoption_rate 計算に使われる
    """
    payload = {
        "type": "skill-usage",
        "content": json.dumps({
            "skill": skill_name,
            "agent": agent.name,
            "success": result.get('success', True),
            "session_id": agent.session_id,
            "timestamp": __import__('datetime').datetime.utcnow().isoformat()
        }),
        "tags": ["skill-usage", f"skill:{skill_name}"],
        "session": agent.session_id
    }
    requests.post("http://127.0.0.1:3150/store", json=payload, timeout=3)
```

## Stream 3: pending-patch 自動適用ブリッジ

```javascript
// scripts/aios-learning-bridge.js
// LaunchAgent または BullMQ ジョブとして定期実行
// pending-patch を監視し、条件付きで自動承認・適用

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILLS_ROOT = `${process.env.HOME}/skills/skills`;
const VCONTEXT = 'http://127.0.0.1:3150';

// 自動承認条件（安全基準）
const AUTO_APPROVE_CONDITIONS = {
  min_fitness: 0.85,           // fitness 0.85以上
  sources_required: 2,         // 独立ソース2件以上
  not_safety_skill: true,      // guard/freeze/careful は除外
  max_lines_added: 300,        // 300行以内
};

const SAFETY_SKILLS = ['guard', 'freeze', 'careful', 'checkpoint',
                        'supervisor-worker', 'quality-gate'];

async function runBridge() {
  // 1. 未処理の pending-patch を取得
  const patches = await recall('type=pending-patch&limit=20');
  const unprocessed = patches.filter(p => {
    try {
      const c = JSON.parse(p.content);
      return !c.processed;
    } catch { return false; }
  });

  console.log(`[bridge] ${unprocessed.length} pending patches`);

  for (const patch of unprocessed) {
    const content = JSON.parse(patch.content);
    const skillName = content.target_path?.split('/')[1];

    // 安全スキルは自動承認しない
    if (SAFETY_SKILLS.includes(skillName)) {
      console.log(`[bridge] SKIP safety skill: ${skillName}`);
      continue;
    }

    // fitness チェック
    if (content.fitness < AUTO_APPROVE_CONDITIONS.min_fitness) {
      console.log(`[bridge] SKIP low fitness ${content.fitness}: ${skillName}`);
      continue;
    }

    // 適用
    await applyPatch(skillName, content);
  }
}

async function applyPatch(skillName, content) {
  const skillDir = path.join(SKILLS_ROOT, skillName);
  const skillFile = path.join(skillDir, 'SKILL.md');

  // 既存スキルの上書きは慎重に
  if (fs.existsSync(skillFile)) {
    console.log(`[bridge] UPDATE existing skill: ${skillName}`);
  } else {
    console.log(`[bridge] CREATE new skill: ${skillName}`);
    fs.mkdirSync(skillDir, { recursive: true });
  }

  // SKILL.md を書き込み
  fs.writeFileSync(skillFile, content.proposed_content);

  // バリデーション
  try {
    execFileSync('node', ['scripts/validate-skills.js'], {
      cwd: `${process.env.HOME}/skills`, stdio: 'pipe'
    });
  } catch (err) {
    // バリデーション失敗 → ロールバック
    console.error(`[bridge] VALIDATION FAILED for ${skillName}, rolling back`);
    fs.unlinkSync(skillFile);
    await markPatched(content, 'validation_failed');
    return;
  }

  // vcontext skill-registry に登録
  await registerSkill(skillName, content.proposed_content);

  // git commit
  execFileSync('git', ['add', `skills/${skillName}/SKILL.md`],
    { cwd: `${process.env.HOME}/skills` });
  execFileSync('git', ['commit', '-m',
    `feat: auto-apply pending-patch ${skillName} (fitness=${content.fitness})`],
    { cwd: `${process.env.HOME}/skills` });

  // 処理済みマーク
  await markPatched(content, 'applied');
  console.log(`[bridge] ✓ Applied: ${skillName}`);
}

// ... recall / registerSkill / markPatched ヘルパー
```

## aios/config/config.yaml への追加

```yaml
# AIOS自律学習フック
hooks:
  on_tool_not_found:
    - module: "aios.hooks.modules.skill_gap_detector"
      function: "on_tool_not_found"
  on_task_failed:
    - module: "aios.hooks.modules.skill_gap_detector"
      function: "on_task_failed_with_missing_skill"
  on_skill_used:
    - module: "aios.hooks.modules.skill_usage_tracker"
      function: "on_skill_used"

# 自律学習ブリッジ設定
autonomous_learning:
  enabled: true
  bridge_script: "~/skills/scripts/aios-learning-bridge.js"
  auto_approve_threshold: 0.85
  run_interval_minutes: 60
```

## Workflow

1. AIOSエージェントが `on_tool_not_found` / `on_task_failed` でギャップを検出
2. `skill_gap_detector.py` が `skill-suggestion` を vcontext に登録
3. 週次 self-evolve サイクルが `skill-suggestion` を Stream 5 で収集
4. fitness スコアリング → top-K を pending-patch として vcontext に保存
5. `aios-learning-bridge.js` が定期実行 → fitness ≥ 0.85 を自動適用
6. 新スキルが `~/skills/skills/` に追加 → `SkillsTool` が自動検出
7. `skill-usage` トラッキングで adoption_rate が蓄積 → 次サイクルの精度向上

## Gotchas

- safety skills (guard/freeze/careful等) は絶対に自動適用しない
- `on_task_failed` の confidence < 0.6 はノイズが多い — 閾値を守る
- bridge の自動適用は fitness 0.85 以上のみ — 低品質スキルの蔓延を防ぐ
- skill-usage の記録失敗はサイレント無視 — トラッキングが本処理をブロックしない
- vcontext が落ちている時の skill-suggestion は失われる — watchdog 必須
