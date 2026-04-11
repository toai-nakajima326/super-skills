# Virtual Context — リモートPC接続手順

## 概要

別のPCからVirtual Contextサーバーに接続し、記憶を共有する方法。

## Step 1: ホストPCでAPIキーを発行

ホストPC（サーバーが動いているPC）で:

```bash
curl -s -X POST http://localhost:3150/auth/create-key \
  -H 'Content-Type: application/json' \
  -d '{"userId":"tanaka@remote-macbook","name":"田中のMacBook"}'
```

レスポンスにAPIキーが返る:
```json
{
  "apiKey": "vctx_abc123...",
  "userId": "tanaka@remote-macbook",
  "name": "田中のMacBook"
}
```

## Step 2: ホストPCのファイアウォール設定

ポート3150をLAN内で開放:
```bash
# macOSの場合（一時的）
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/local/bin/node
```

またはシステム設定 → ファイアウォール で Node.js の接続を許可。

## Step 3: リモートPCの環境変数を設定

リモートPCの `~/.zshrc` または `~/.bashrc` に追加:

```bash
# Virtual Context リモート接続
export VCONTEXT_URL="http://192.168.x.x:3150"  # ホストPCのIP
export VCONTEXT_API_KEY="vctx_abc123..."         # 発行されたキー
```

## Step 4: リモートPCでテスト

```bash
# 接続確認
curl -s -H "Authorization: Bearer $VCONTEXT_API_KEY" "$VCONTEXT_URL/auth/whoami"

# 保存テスト
curl -s -X POST "$VCONTEXT_URL/store" \
  -H "Authorization: Bearer $VCONTEXT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"type":"decision","content":"リモートPCから接続テスト","namespace":"shared"}'

# 検索テスト（全ユーザーの記憶が見える）
curl -s "$VCONTEXT_URL/recent?n=5" -H "Authorization: Bearer $VCONTEXT_API_KEY"

# 自分のデータだけ見る
curl -s "$VCONTEXT_URL/recent?n=5&my=true" -H "Authorization: Bearer $VCONTEXT_API_KEY"
```

## Step 5: Claude Code / Codex で使う

リモートPCの `~/.claude/skills/virtual-context/SKILL.md` の中で
`localhost:3150` を `$VCONTEXT_URL` に変更するか、
環境変数 `VCONTEXT_URL` を設定すれば自動で接続先が変わる。

## データの分離

| パラメータ | 用途 | 例 |
|-----------|------|-----|
| `namespace` | プロジェクト単位 | `?namespace=chatai` |
| `user` | ユーザー単位 | `?user=tanaka@remote-macbook` |
| `my=true` | 自分のデータだけ | `?my=true` |
| (省略) | 全員・全プロジェクト | 全データ横断 |

## APIキー管理

```bash
# キー一覧（ホストPCのみ）
cat ~/skills/data/vcontext-api-keys.json

# キーを無効化するには → JSONから該当キーを削除
```

## セキュリティ注意

- APIキーはLAN内でのみ使用を想定
- インターネット公開する場合はHTTPS + reverse proxyが必須
- クラウド版ではさらにJWT等の強い認証を推奨
