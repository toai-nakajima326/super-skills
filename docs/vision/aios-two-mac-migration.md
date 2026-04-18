# AIOS Two-Mac Migration Plan

**Date**: 2026-04-18
**Author decision**: 主 Mac を AIOS 専用サーバ化、MBA M3 を日常作業機へ切替

## 1. ハードウェア構成

| 役割 | 機種 | Chip | RAM | SSD | 状態 |
|------|------|------|-----|-----|------|
| **AIOS server** | 主 Mac | **M3 Pro** | 36 GB | 460 GB (72 GB free, 85% used) | 今日まで dual-use |
| **Workstation** | MBA | M3 base (8C CPU/10C GPU 推定) | 24 GB | 500 GB | 待機中 |

## 2. 最終目標 (post-migration)

```
                ┌─────────────────────────────────────┐
                │   MBA M3 24GB (workstation)         │
                │   • Claude Code / Codex / Cursor    │
                │   • 日常開発 (VS Code, git, Safari) │
                │   • Slack / Zoom / メール           │
                │   • バッテリー駆動可、持ち歩き可    │
                └────────────────┬────────────────────┘
                                 │ WiFi 6 / Ethernet
                                 │ (Hooks: JSON POST, <1KB/event)
                                 │ vcontext-hooks.js が queue 経由で async
                                 ▼
         ┌──────────────────────────────────────────────────┐
         │   主 Mac M3 Pro 36GB (AIOS 24/7 サーバ)          │
         │                                                  │
         │   • vcontext-server (LAN bind 0.0.0.0:3150)      │
         │   • MLX embed + generate (port 3161, 3162)       │
         │   • RAM disk 18GB (/Volumes/VContext)            │
         │   • 全 background loops (embed/discovery/L1-3)   │
         │   • article-scanner 毎日 06:00 JST               │
         │   • self-evolve 週次 日曜 07:00                  │
         │   • Dashboard (LAN 公開、MBA からブラウズ可)     │
         │   • Langfuse (将来、docker on :9091)             │
         │                                                  │
         │   never-sleep + 常時電源 + ヘッドレス or 小型モニタ │
         └──────────────────────────────────────────────────┘
```

## 3. 5フェーズ移行計画

### Phase 0 — 準備 (1-2時間、今日中推奨)

- [x] 本設計ドキュメント作成
- [ ] Time Machine バックアップ (主 Mac 全体、安全網)
- [ ] 主 Mac の仕事データ一覧化 (`~/shopForTEST`, `~/RelationBy*`, その他)
- [ ] MBA の OS バージョン確認 (Sequoia 15.x 推奨)
- [ ] MBA の SSD 空き容量確認 (500GB 中、移行分 + 既存で収まるか)

### Phase 1 — 主 Mac を AIOS サーバ化 (1-2時間)

**ネットワーク設定**:
```bash
# vcontext を LAN 公開 (環境変数で切替)
echo "VCONTEXT_BIND=0.0.0.0" >> ~/skills/data/vcontext.env
# launchctl kickstart -k gui/$(id -u)/com.vcontext.server で反映
```

**スリープ防止**:
```bash
sudo pmset -a sleep 0
sudo pmset -a disksleep 0
sudo pmset -a displaysleep 15  # 画面だけ消える (消費電力節約)
sudo pmset -a powernap 0       # AIOS が起きてるので不要
sudo pmset -a tcpkeepalive 1   # LAN から叩かれて起きる
```

**Screen Sharing 有効化**:
- システム設定 → 一般 → 共有 → 画面共有 ON
- 「VNC クライアントが画面を操作」有効
- MBA から `vnc://主macのIP` でアクセス可能に

**Firewall 調整**:
- `pfctl` or アプリケーションファイアウォール設定で
  - port 3150 (vcontext) LAN 内許可
  - port 3161 (MLX embed) LAN 内許可 (MBA 側で呼ぶ必要があれば)
  - port 3162 (MLX generate) LAN 内許可

**検証**:
- 主 Mac: `curl -s http://localhost:3150/health`
- 主 Mac: `curl -s http://<lan-ip>:3150/health` ← LAN IP で通るか
- MBA (同 LAN 内): `curl -s http://<main-mac-ip>:3150/health` ← 外からもOK

### Phase 2 — MBA セットアップ (2-3時間)

**基本ツール**:
```bash
# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# nvm + Node 25
brew install nvm
nvm install 25
nvm use 25

# その他 (必要に応じ)
brew install git gh jq sqlite
```

**Claude Code / Codex / Cursor インストール**:
- 各公式サイトからダウンロード
- サインイン

**skills リポジトリ clone (MBA 側)**:
```bash
cd ~
git clone https://github.com/toai-nakajima326/super-skills.git skills
cd skills
npm install
```

**vcontext を主 Mac に向ける**:
```bash
# MBA 側の設定ファイル
cat > ~/skills/data/vcontext-client.env <<EOF
VCONTEXT_URL=http://<main-mac-ip>:3150
VCONTEXT_API_KEY=<main-mac から export された key>
EOF

# Hook 設定 (Claude Code 用の ~/.claude/settings.json 等に反映)
bash ~/skills/scripts/vcontext-hooks.js install-all
```

**AIOS サーバは MBA で起動しない** (重要):
- `launchctl bootout` で MBA 側 `com.vcontext.server` を無効化
- MBA は client only

### Phase 3 — データ移行 (半日)

**主 Mac → MBA へ移動**:

| データ | 容量目安 | 方法 |
|--------|---------|------|
| `~/shopForTEST` | 44 GB | TB ケーブル or AirDrop (時間かかる) or `rsync` over SSH |
| `~/RelationByKiro` | 18 GB | 同上 |
| `~/RelationByClaude` | 16 GB | 同上 |
| `~/flask_workspace` | 5.6 GB | 同上 |
| `~/Codex` | 3.5 GB | 同上 |
| `~/Documents/*.md, *.pdf` 等 | 1 GB 前後 | iCloud 同期 or 手動 |
| `~/Downloads/*` (必要なもの) | ~1 GB | 手動 |

**推奨**: Thunderbolt 3/4 ケーブルで直結 → `rsync -av --progress source/ dest/`
速度: 20+ Gbps、100GB を数分で完了。

**主 Mac に残すべきもの**:
- `~/skills/` (AIOS 本体)
- `~/Library/` (システム設定)
- その他 AIOS 関連 (`~/.claude/` の hook 設定等)

### Phase 4 — MBA を実運用 (1週間試用)

**初日**:
- MBA を仕事で使い始める
- Claude Code で何かタスク → hook が主 Mac に届くか確認
- Dashboard を MBA Safari から `http://<main-mac-ip>:3150/dashboard` で開ける確認

**1週間観察**:
- MBA 24GB で仕事の負荷に耐えるか
- hook のレイテンシ体感 (WiFi 5-20ms, 直結 <1ms)
- 主 Mac のヘッドレス運用に問題ないか
- AIOS データ流入が途切れないか

### Phase 5 — 最適化 (オプション、1ヶ月後)

- 主 Mac の RAM disk 18GB → 25-30GB に拡張 (仕事アプリと競合しないので余裕)
- 主 Mac の `~/shopForTEST` 等古いプロジェクト完全削除
- Langfuse (Pillar 3) docker 起動
- self-evolve を observation → 実 mutation モードに
- (必要なら) 外付け SSD を主 Mac に追加 (古い archive / Time Machine 用)

## 4. 新しいリスクと対策

| リスク | 影響 | 対策 |
|--------|------|------|
| **主 Mac 死亡時に AIOS 喪失** | 高 | Time Machine 定期バックアップ (外付け HDD/SSD 別筐体) |
| **LAN 不通時 hook ロス** | 中 | vcontext-hooks.js の `/tmp/vcontext-queue.jsonl` 既存 drain 機構で queue → 接続復帰時 replay |
| **MBA 持ち出し時 offline** | 中 | 同上 — queue に貯まる、帰宅後に自動 drain |
| **MBA 24GB 不足** | 低 | Chrome/Slack/VS Code 同時で 15GB くらい。通常問題なし。不足時は MBA を 32/36GB モデルに買替え検討 |
| **主 Mac 電源断 (停電等)** | 高 | pre-outage.sh 既存、UPS 別途購入検討 |
| **セキュリティ (LAN 公開)** | 中 | X-Vcontext-Admin header + API key + CSRF + 内部 LAN のみ 既にあり |

## 5. 運用ルール

1. **主 Mac は動かさない** — 電源 ON、モニタ不要、たまに SSH/VNC で状態確認
2. **MBA で仕事する** — Claude Code / IDE / ブラウザ全部ここ
3. **Dashboard は MBA から** — `http://<main-mac-ip>:3150/dashboard`
4. **管理コマンドは SSH 越し or VNC** — MBA の terminal から主 Mac に入る
5. **Time Machine は外付け HDD** — 別筐体、別物理場所推奨

## 6. 廃案になった案

- ❌ 外付け SSD 単体購入 (単純な disk 対策、AIOS 成長に寄与しない)
- ❌ Mac mini 64GB 購入 (¥400k、既存機材で代替可能)
- ❌ MBA を MLX 専用サーバ化 (ファンレスの熱問題、役割逆転の方がクリーン)

## 7. 本プランが合致する戦略軸

- **Pillar 5: 開放基盤** — vcontext が LAN-accessible になる = MCP memory 化への踏み台
- **Pillar 3: 観測性** — ヘッドレス運用で観測が必須に → Langfuse 導入動機強化
- **セキュリティ原則** — vcontext の auth は LAN 公開前提で既に堅牢、このタイミングで再確認

## 8. 実行スケジュール案

| 日 | 作業 | 所要 |
|----|------|------|
| **今日 (残り)** | Time Machine + 一覧化 | 30-60分 |
| **明日** | Phase 1 + Phase 2 前半 | 2-3時間 |
| **明後日** | Phase 2 後半 + Phase 3 データ移行 | 半日 |
| **4日目〜** | Phase 4 試用 | 1週間 |
| **2週目〜** | Phase 5 最適化 | 随時 |

急がば回れ、週末にじっくりが安全。

---

*Generated: 2026-04-18, as companion to docs/vision/aios-5-pillars.md*
