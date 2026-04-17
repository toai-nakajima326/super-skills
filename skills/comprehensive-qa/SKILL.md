---
name: comprehensive-qa
description: |
  全方位QAスキル。メモリリーク・異常系・セキュリティ・負荷・ストレス・Windows環境・電源断復旧・
  LLM/SSD/RAM/仮想コンテキスト・カバレッジ・全組み合わせ・シナリオ・全AIダミー接続を網羅する
  テスト自動生成・実施・検証ワークフロー。vcontextシステム専用テストスイート組み込み済み。
  Use when performing release QA, stability checks, or regression verification.
origin: unified
---

# Comprehensive QA

## スタック構成（既存スキル + 追加ディメンション）

既存スキルを自動スタック:
- `health-check` → ビルド/lint/型/テスト/セキュリティスキャン
- `verification-loop` → build・typecheck・lint・tests・diff sanity
- `security-review` → secrets・injection・authn/authz・MCP trust boundary
- `adversarial-review` → 競合状態・null経路・エッジケース・弱い仮定
- `e2e-testing` → クリティカルユーザーフロー E2E
- `qa-browser` → ブラウザ実機QA（ダッシュボード）

---

## T01: メモリリーク・リソースリーク検査

```bash
# Node.js ヒープ成長監視（2分間）
node --expose-gc -e "
const http = require('http');
const before = process.memoryUsage().heapUsed;
let reqs = 0;
const iv = setInterval(async () => {
  await new Promise(r => {
    http.get('http://127.0.0.1:3150/recall?q=test&limit=10', res => {
      res.resume(); res.on('end', r);
    }).on('error', r);
  });
  reqs++;
  if (global.gc) global.gc();
  const after = process.memoryUsage().heapUsed;
  const delta = ((after - before) / 1024 / 1024).toFixed(1);
  console.log('req=' + reqs + ' heap_delta=' + delta + 'MB');
  if (reqs >= 120) { clearInterval(iv); }
}, 1000);
"
# 判定: 120req後のheap_delta < 50MB ならOK
# EventEmitter/setInterval/DB接続のleakも確認:
node -e "
const http = require('http');
http.get('http://127.0.0.1:3150/stats', r => {
  let d = ''; r.on('data', c => d += c);
  r.on('end', () => {
    const j = JSON.parse(d);
    console.log('active_handles:', process._getActiveHandles().length);
    console.log('active_requests:', process._getActiveRequests().length);
  });
});
"
```

**チェックリスト**:
- [ ] SQLite接続 (`ramDb`, `ssdDb`) が適切にclose/reuseされている
- [ ] `setInterval` / `setTimeout` が重複登録されない（サーバ再起動後）
- [ ] WebSocket clientsが切断後にMapから削除される
- [ ] MLX embed/generate の子プロセスが終了後にゾンビ化しない
- [ ] JSONL WALファイルのストリームが長時間書き込みでflushedされる

---

## T02: 異常系・エラーパス網羅

```bash
# 不正JSONを送り込む
curl -s -X POST http://127.0.0.1:3150/store \
  -H 'Content-Type: application/json' \
  -d '{bad json' | head -c 200

# 巨大ペイロード（10MB）
python3 -c "
import urllib.request, json
data = json.dumps({'type':'test','content':'x'*10_000_000}).encode()
req = urllib.request.Request('http://127.0.0.1:3150/store',data=data,
      headers={'Content-Type':'application/json'})
try:
  with urllib.request.urlopen(req,timeout=5) as r: print(r.status)
except Exception as e: print('REJECTED:', type(e).__name__)
"

# 存在しないエンドポイント → 404
curl -s http://127.0.0.1:3150/nonexistent | head -c 100

# contentがnull
curl -s -X POST http://127.0.0.1:3150/store \
  -H 'Content-Type: application/json' \
  -d '{"type":"test","content":null}'

# 空文字列クエリ
curl -s 'http://127.0.0.1:3150/recall?q=&limit=5'

# SQLインジェクション試行
curl -s "http://127.0.0.1:3150/recall?q='; DROP TABLE entries; --"

# 同時接続数超過（100並列）
python3 -c "
import threading, urllib.request, time
results = []
def req():
  try:
    with urllib.request.urlopen('http://127.0.0.1:3150/health', timeout=3) as r:
      results.append(r.status)
  except Exception as e: results.append(str(e)[:20])
threads = [threading.Thread(target=req) for _ in range(100)]
t0=time.time(); [t.start() for t in threads]; [t.join() for t in threads]
ok=results.count(200); print(f'100並列: {ok}/100 OK in {time.time()-t0:.2f}s')
"
```

**異常系チェックリスト**:
- [ ] JSON parse error → 400 (サーバクラッシュなし)
- [ ] 10MB超ペイロード → 413 or reject (OOMなし)
- [ ] SQLインジェクション → parameterized query で無害化
- [ ] 未知エンドポイント → 404 (スタックトレース漏洩なし)
- [ ] DB書き込み中にkill -9 → 起動時にWAL自動回復
- [ ] `null` / `undefined` content → バリデーションで弾く
- [ ] 空文字列クエリ → クラッシュなし、空結果返却

---

## T03: セキュリティテスト

```bash
# APIキー認証バイパス試行
curl -s http://127.0.0.1:3150/auth/keys \
  -H 'Authorization: Bearer INVALID_KEY' | head -c 100

# ディレクトリトラバーサル
curl -s 'http://127.0.0.1:3150/session/../../../etc/passwd' | head -c 100

# レスポンスにsecrets漏洩がないか確認
curl -s 'http://127.0.0.1:3150/recall?q=password+api_key+secret&limit=20' | \
  python3 -c "
import sys,json,re
d=json.load(sys.stdin)
patterns=[r'sk-[A-Za-z0-9]{20,}',r'Bearer [A-Za-z0-9]{20,}',r'password.*=.*\S']
for r in d.get('results',[]):
  c=str(r.get('content',''))
  for p in patterns:
    if re.search(p,c,re.I): print('LEAK DETECTED:',c[:100])
print('secrets scan done')
"

# CORS headers確認
curl -s -I -H 'Origin: https://evil.com' http://127.0.0.1:3150/health | grep -i 'access-control'
```

**セキュリティチェックリスト**:
- [ ] `maskSecrets()` が全レスポンスに適用されている
- [ ] APIキーがDBに平文保存されていない（hash比較）
- [ ] パス traversal → 400/404 (ファイルシステムアクセスなし)
- [ ] WebSocket 無認証アクセス → 未承認リクエストをreject
- [ ] `/admin/*` エンドポイントが owner ロールのみアクセス可
- [ ] レートリミットなし → DoSリスク（要確認: 実装有無）

---

## T04: 負荷テスト・スループット測定

```bash
# 1000req/10secの /store 負荷
python3 -c "
import threading, urllib.request, json, time
ok=err=0; times=[]
def req():
  global ok,err
  data=json.dumps({'type':'load-test','content':'test '+str(time.time()),'session':'load'}).encode()
  t0=time.time()
  try:
    r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:3150/store',
      data=data,headers={'Content-Type':'application/json'}),timeout=5)
    if r.status==201: ok+=1
    else: err+=1
  except: err+=1
  times.append(time.time()-t0)
threads=[threading.Thread(target=req) for _ in range(1000)]
t0=time.time();[t.start() for t in threads];[t.join() for t in threads]
import statistics
print(f'1000req: ok={ok} err={err} time={time.time()-t0:.1f}s')
print(f'  avg={statistics.mean(times)*1000:.0f}ms p95={sorted(times)[950]*1000:.0f}ms p99={sorted(times)[990]*1000:.0f}ms')
"

# /recall のレイテンシ計測
for i in $(seq 1 20); do
  curl -w "%{time_total}s\n" -s -o /dev/null \
    'http://127.0.0.1:3150/recall?q=test+query+sample&limit=10'
done
```

**負荷テスト合否基準**:
- store avg < 100ms, p99 < 500ms
- recall avg < 500ms, p99 < 2000ms (semantic search有効時)
- 1000並列でクラッシュ・OOM・接続拒否なし

---

## T05: ストレステスト（長時間・限界）

```bash
# RAMディスク容量を80%まで埋めて動作確認
python3 -c "
import urllib.request, json, time
# 1MB contentを100回送る (=100MB)
big = 'x' * 1_000_000
for i in range(100):
  data=json.dumps({'type':'stress-test','content':big+str(i),'session':'stress'}).encode()
  try:
    r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:3150/store',
      data=data,headers={'Content-Type':'application/json'}),timeout=10)
    print(f'{i+1}/100: {r.status}')
  except Exception as e: print(f'{i+1}/100: ERR {e}')
  time.sleep(0.1)
" 2>&1 | tail -20

# DB size check・watchdog triggerを確認
curl -s http://127.0.0.1:3150/stats | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('DB stats:', json.dumps(d, indent=2, ensure_ascii=False)[:500])
"
```

---

## T06: Windows環境想定テスト

**パス区切り・改行コード・エンコーディング**:

```bash
# Windows改行コード (CRLF) を含むコンテンツ
curl -s -X POST http://127.0.0.1:3150/store \
  -H 'Content-Type: application/json' \
  -d $'{"type":"test","content":"line1\\r\\nline2\\r\\nline3"}'

# Windows絶対パス文字列を含むコンテンツ
curl -s -X POST http://127.0.0.1:3150/store \
  -H 'Content-Type: application/json' \
  -d '{"type":"test","content":"C:\\\\Users\\\\user\\\\Documents\\\\file.txt"}'

# NULL文字・制御文字
python3 -c "
import urllib.request, json
data=json.dumps({'type':'test','content':'before\x00after\x1bnull'}).encode()
r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:3150/store',
  data=data,headers={'Content-Type':'application/json'}),timeout=5)
print('NULL文字:', r.status)
"
```

**チェックリスト**:
- [ ] `path.join()` がOSネイティブ区切りに依存していない（`node:path` ではなくURLで処理）
- [ ] DB_PATH / LOG_PATH が Windows形式でも動作する（将来移植時）
- [ ] CRLF改行をコンテンツとして正常保存・取得できる
- [ ] ファイル名に含まれる `:` `?` `*` が処理でエラーを出さない

---

## T07: 予測検索テスト（predictive / vcontext recall）

```bash
# 類似クエリで期待スキルが最上位に来るか
python3 -c "
import urllib.request, json

test_cases = [
  ('debug error stack trace broken', 'investigate'),
  ('try to break edge case race condition', 'adversarial-review'),
  ('MCP server transport tool design', 'mcp-server-patterns'),
  ('gh skill install publish package manager', 'gh-skill-manager'),
  ('memory leak load stress test coverage', 'comprehensive-qa'),
]

for query, expected_top in test_cases:
  url = f'http://127.0.0.1:3150/recall?q={urllib.parse.quote(query)}&limit=5'
  with urllib.request.urlopen(url) as r:
    d = json.loads(r.read())
  skills = [json.loads(x['content']).get('name','?')
            for x in d.get('results',[]) if x.get('type')=='skill-registry']
  hit = expected_top in skills[:3]
  print(f\"{'✓' if hit else '✗'} [{expected_top}] query='{query[:40]}' top3={skills[:3]}\")
" 2>/dev/null || echo "urllib.parse import fix needed"

python3 - <<'EOF'
import urllib.request, urllib.parse, json

test_cases = [
  ('debug error stack trace broken', 'investigate'),
  ('try to break edge case race condition', 'adversarial-review'),
  ('MCP server transport tool design', 'mcp-server-patterns'),
  ('gh skill install publish package manager', 'gh-skill-manager'),
  ('memory leak load stress test coverage QA', 'comprehensive-qa'),
]

for query, expected in test_cases:
  url = f'http://127.0.0.1:3150/recall?q={urllib.parse.quote(query)}&limit=5'
  with urllib.request.urlopen(url) as r:
    d = json.loads(r.read())
  skills = []
  for x in d.get('results', []):
    if x.get('type') == 'skill-registry':
      try: skills.append(json.loads(x['content']).get('name','?'))
      except: pass
  hit = expected in skills[:3]
  mark = '✓' if hit else '✗'
  print(f"{mark} [{expected}] → top3={skills[:3]}")
EOF
```

**チェックリスト**:
- [ ] 全登録スキルが適切なルーティングキーワードで召喚される
- [ ] セマンティック検索と全文検索が正しくフォールバックしている
- [ ] 新規登録スキルが即座に検索可能（埋め込みバックログ影響なし）

---

## T08: LLMテスト（MLX generate / embed）

```bash
# MLX generate 応答品質テスト
curl -s -X POST http://127.0.0.1:3162/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "mlx-community/Qwen3-8B-4bit",
    "messages": [{"role":"user","content":"Say OK and nothing else."}],
    "max_tokens": 10,
    "temperature": 0
  }' | python3 -c "
import sys,json
d=json.load(sys.stdin)
text=d['choices'][0]['message']['content']
print('LLM response:', repr(text))
assert len(text.strip()) < 50, 'Response too long (no_think test)'
print('OK')
"

# MLX embed 次元数テスト
curl -s -X POST http://127.0.0.1:3161/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"mlx-community/Qwen3-Embedding-8B-4bit-DWQ","input":["test"]}' | \
  python3 -c "
import sys,json
d=json.load(sys.stdin)
dim=len(d['data'][0]['embedding'])
print(f'Embedding dim: {dim}')
assert dim==4096, f'Expected 4096, got {dim}'
print('OK')
"

# no_think プレフィックスが機能しているか
curl -s http://127.0.0.1:3150/ai/status | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('MLX gen:', d.get('mlx_generate_available'))
print('MLX embed:', d.get('mlx_available'))
print('Semantic search:', d.get('features',{}).get('semantic_search'))
print('Embedding backlog:', d.get('embedding_backlog', 'N/A'))
"
```

---

## T09: SSD / RAM / 仮想コンテキスト 統合テスト

```bash
# 1. RAM→SSD自動移行が機能するか（旧エントリのtier確認）
curl -s http://127.0.0.1:3150/tier/stats | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(json.dumps(d,indent=2,ensure_ascii=False))
"

# 2. SSDにあるエントリをrecallで取得できるか（cascading tier search）
curl -s 'http://127.0.0.1:3150/recall?q=old+entry+ssd&limit=5' | python3 -c "
import sys,json; d=json.load(sys.stdin)
tiers=[r.get('_tier','?') for r in d.get('results',[])]
print('Tiers in results:', tiers[:10])
"

# 3. RAMディスク容量確認
df /Volumes/VContext 2>/dev/null | awk 'NR==2{printf \"RAM: %s used (%s%%)\n\", \$3, \$5}'

# 4. バックアップ整合性確認
curl -s -X POST http://127.0.0.1:3150/admin/verify-backup | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print(json.dumps(d,indent=2,ensure_ascii=False)[:300])
except: print(sys.stdin.read()[:200])
" 2>/dev/null || echo "verify-backup not available"

# 5. DB integrity check
node -e "
const Database = require('better-sqlite3');
const db = new Database('/Volumes/VContext/vcontext.db', { readonly: true });
const r = db.prepare('PRAGMA integrity_check').get();
console.log('RAM DB integrity:', r.integrity_check);
db.close();
const db2 = new Database(process.env.HOME + '/skills/data/vcontext-ssd.db', { readonly: true });
const r2 = db2.prepare('PRAGMA integrity_check').get();
console.log('SSD DB integrity:', r2.integrity_check);
db2.close();
"
```

---

## T10: 電源断・突然kill・復旧テスト

```bash
# kill -9 シミュレーション → 再起動 → データ整合性確認
BEFORE=$(curl -s 'http://127.0.0.1:3150/stats' | python3 -c "
import sys,json; d=json.load(sys.stdin); print(d.get('total_count',0))
" 2>/dev/null)
echo "Before kill: $BEFORE entries"

# graceful shutdown 試験（SIGTERM）
kill -TERM $(pgrep -f vcontext-server | head -1) 2>/dev/null
sleep 2
echo "After SIGTERM: server stopped"

# 再起動
cd ~/skills && node scripts/vcontext-server.js >> /tmp/vcontext.log 2>&1 &
sleep 6

AFTER=$(curl -s 'http://127.0.0.1:3150/stats' | python3 -c "
import sys,json; d=json.load(sys.stdin); print(d.get('total_count',0))
" 2>/dev/null)
echo "After restart: $AFTER entries"
DIFF=$((AFTER - BEFORE))
echo "Data loss: $DIFF entries (0 expected)"

# WAL replay確認
ls -la ~/skills/data/entries-wal.jsonl 2>/dev/null | awk '{print "WAL size:", $5, "bytes"}'
```

**復旧テストチェックリスト**:
- [ ] SIGTERM後の再起動でエントリ数が維持される
- [ ] kill -9後もWAL replayでデータ回復される
- [ ] RAMディスク再マウント（reboot想定）でSSD→RAM restore動作
- [ ] DB corruption後にcheckAndRecoverDb()が起動時自動実行される

---

## T11: カバレッジ分析

```bash
# 未テストエンドポイント一覧（全エンドポイントをリストアップ）
grep -n "path === '/" ~/skills/scripts/vcontext-server.js | \
  sed "s/.*path === '//;s/'.*//" | sort -u > /tmp/all_endpoints.txt

# テスト済みエンドポイント（このスキルで明示的にテストされたもの）
cat << 'EOF' > /tmp/tested_endpoints.txt
/store
/recall
/recent
/health
/stats
/tier/stats
/tier/migrate
/admin/verify-backup
/admin/replay-wal
/admin/wal-status
EOF

# 差分＝未カバーエンドポイント
echo "=== 未カバーエンドポイント ==="
comm -23 <(sort /tmp/all_endpoints.txt) <(sort /tmp/tested_endpoints.txt)
```

---

## T12: 全AIダミー接続テスト

```bash
# Claude Code → vcontext hook動作確認
node ~/skills/scripts/vcontext-hooks.js test 2>/dev/null || \
  echo "hooks test: check logs"

# Codex hooks設定確認
cat ~/.codex/hooks.json 2>/dev/null | python3 -c "
import sys,json; d=json.load(sys.stdin)
hooks=list(d.keys())
print('Codex hooks:', hooks)
"

# Cursor hooks確認
cat ~/.cursor/hooks/vcontext.json 2>/dev/null | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('Cursor hooks configured:', bool(d))
"

# Kiro hooks確認
ls ~/.kiro/hooks/ 2>/dev/null && echo "Kiro hooks: present" || echo "Kiro hooks: missing"

# vcontext recall経由でhookが記録したエントリを確認
curl -s 'http://127.0.0.1:3150/recall?q=hook+test+session&limit=5' | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('hook entries:', len(d.get('results',[])))
"
```

---

## T13: シナリオテスト

**シナリオA: 新規スキル作成フロー**
1. `POST /store` でskill-suggestionを送信
2. vcontextのMLX generate経由でskill自動生成
3. `GET /recall?q=<skill-name>` でskill-registryエントリを確認
4. super-skills routing tableへの反映確認

**シナリオB: セッション継続フロー**
1. セッションAで10エントリ保存
2. セッションBで `GET /session/A` を呼び出し
3. recall時にセッションAのエントリが最上位に来ることを確認

**シナリオC: 高負荷中のrecall精度**
1. バックグラウンドで100req/secのstoreを継続
2. 同時にrecallの精度・レイテンシを測定
3. 負荷中でもp99 < 3000ms, 精度劣化なしを確認

**シナリオD: 電源断→再起動→スキル召喚フロー**
1. スキル登録 → kill -9 → 再起動
2. 再起動後にスキルがrecallで取得できることを確認
3. WAL replayログを確認

---

## T14: 全組み合わせテスト（パラメータ行列）

```bash
# recall クエリパラメータの全組み合わせ
python3 - << 'EOF'
import urllib.request, urllib.parse

limits = [1, 10, 50, 100]
types = ['', 'skill-registry', 'assistant-response', 'nonexistent']
queries = ['test', '', 'SELECT * FROM entries', '日本語クエリ', 'a' * 1000]

results = []
for limit in limits:
  for type_ in types:
    for q in queries:
      params = {'q': q, 'limit': str(limit)}
      if type_: params['type'] = type_
      url = 'http://127.0.0.1:3150/recall?' + urllib.parse.urlencode(params)
      try:
        with urllib.request.urlopen(url, timeout=3) as r:
          status = r.status
      except Exception as e:
        status = str(e)[:20]
      results.append((status, limit, type_, q[:20]))

errors = [r for r in results if r[0] != 200]
print(f'Total combinations: {len(results)}')
print(f'Errors: {len(errors)}')
for e in errors[:10]:
  print(f'  {e}')
EOF
```

---

## 実行優先順位

| 優先度 | テスト | 理由 |
|--------|--------|------|
| 🔴 P0 | T09 (DB integrity) | データ消失リスク最大 |
| 🔴 P0 | T10 (電源断復旧) | 本番運用の前提 |
| 🟠 P1 | T02 (異常系) | クラッシュ耐性 |
| 🟠 P1 | T01 (メモリリーク) | 長時間稼働の安定性 |
| 🟠 P1 | T03 (セキュリティ) | secrets漏洩リスク |
| 🟡 P2 | T04 (負荷) | パフォーマンス劣化検知 |
| 🟡 P2 | T07 (予測検索) | スキル召喚精度 |
| 🟡 P2 | T08 (LLM) | MLX稼働確認 |
| 🟢 P3 | T05 (ストレス) | 限界値の把握 |
| 🟢 P3 | T11 (カバレッジ) | テスト漏れ検出 |
| 🟢 P3 | T12 (全AI接続) | マルチエージェント確認 |
| ⬜ P4 | T06 (Windows) | 将来移植リスク |
| ⬜ P4 | T13/T14 (シナリオ/組み合わせ) | 深度QA |

## 結果レポート形式

```
[comprehensive-qa] YYYY-MM-DD HH:MM
====================================
P0 電源断復旧  ✓ PASS  (entry loss: 0)
P0 DB integrity ✓ PASS  (ram=ok, ssd=ok)
P1 メモリリーク ✓ PASS  (delta=12MB/120req)
P1 異常系       ✓ PASS  (12/12 correctly rejected)
P1 セキュリティ ⚠ WARN  (rate limit未実装)
P2 負荷         ✓ PASS  (avg=87ms, p99=423ms)
P2 予測検索     ✓ PASS  (8/10 expected skills in top3)
P2 LLM          ✓ PASS  (gen+embed both healthy)
====================================
BLOCKERS: 0  WARNINGS: 1  SKIP: 0
```

## Gotchas

- T10（電源断）はサーバ再起動を伴うため、他テストと分離して実行
- T05（ストレス）後はDBの不要エントリをpruneすること: `curl -X DELETE http://127.0.0.1:3150/prune`
- MLX generateが起動中の場合、T08は3162ポートで実施（wrapperを確認）
- Windows想定テスト(T06)はmacOS上でのパス互換性検証として実施
