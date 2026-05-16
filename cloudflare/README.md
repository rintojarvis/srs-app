# SRS App Sync (Cloudflare D1 + Workers)

SRS 暗記アプリのクラウド同期基盤。Cloudflare D1（SQLite）をストレージに、Workers を HTTP エンドポイントとして使う最小構成。

## 構成

- `wrangler.toml` — Workers + D1 バインディング設定
- `schema.sql` — D1 のスキーマ（cards / mistakes / checkins / review_history）
- `worker.js` — Workers エントリポイント（pull / push / health）
- `README.md` — このファイル

## API

すべて `Authorization: Bearer <SYNC_SECRET>` ヘッダが必要。

| Method | Path | 説明 |
|---|---|---|
| GET  | `/sync/pull?since=<ms>` | `updated_at > since` のレコードを全テーブルから返す |
| POST | `/sync/push`            | JSON ボディの各レコードを `INSERT OR REPLACE` で upsert |
| GET  | `/health`               | サーバ生存確認 |

push の JSON ボディ形:
```json
{
  "cards":          [{ "id": "...", "front": "...", "back": "...", "tags": [], "source": "...", "linked_cards": [], "fsrs": {}, "updated_at": 1715800000000 }],
  "mistakes":       [{ "id": "...", "at": "...", "text": "...", "tags": [], "source": "...", "hit_card_ids": [], "status": "open", "updated_at": 0 }],
  "checkins":       [{ "date": "2026-05-15", "subjects": [], "topic": "...", "progress": "...", "sources": [], "at": "...", "updated_at": 0 }],
  "review_history": [{ "card_id": "...", "at": "...", "rating": "good", "card_review": "...", "comment": "...", "updated_at": 0 }]
}
```

`updated_at` は **unix epoch ミリ秒**。クライアントが採番する（衝突時は後勝ち=新しい `updated_at` が勝つように）。

## デプロイ手順

### 前提
- Cloudflare アカウント（無料で可）
- Node.js + npm（Wrangler 用）

### 1. Wrangler セットアップ
```powershell
npm install -g wrangler
wrangler login
```

### 2. D1 データベース作成
```powershell
wrangler d1 create srs-app
```
表示された `database_id` を `wrangler.toml` の `TODO_AFTER_WRANGLER_D1_CREATE` に貼る。

### 3. スキーマ適用
```powershell
wrangler d1 execute srs-app --file=./schema.sql --remote
```

### 4. シークレット設定（同期キー）
適当な長いランダム文字列を生成してメモる（PWA 側にも同じ値を入れる）。
```powershell
$secret = -join ((1..32) | ForEach-Object { [char](Get-Random -Min 33 -Max 127) })
$secret  # メモる
$secret | wrangler secret put SYNC_SECRET
```

### 5. デプロイ
```powershell
wrangler deploy
```
表示される URL（`https://srs-app-sync.<your-subdomain>.workers.dev`）をメモる。

### 6. 動作確認
```powershell
$url = "https://srs-app-sync.<your-subdomain>.workers.dev"
Invoke-RestMethod "$url/health" -Headers @{ Authorization = "Bearer $secret" }
# -> ok: True, server_time: ...
```

### 7. PWA 側設定
Web アプリの設定タブで「同期 URL」と「同期キー」を入力（実装は次フェーズ）:
- 同期 URL: `https://srs-app-sync.<your-subdomain>.workers.dev`
- 同期キー: 上で生成した `$secret`

## 想定コスト

- D1 無料枠: 5 GB ストレージ / 25M reads/月 / 50K writes/月
- Workers 無料枠: 100K リクエスト/日
- 個人利用なら永久無料圏内

## 同期方式メモ

- pull は last-write-wins。クライアントは最後に成功した pull の `server_time` を保存し、次回 `since` に渡す
- push も last-write-wins。同 ID のレコードは `INSERT OR REPLACE` で上書き
- 削除は将来対応（tombstone カラム or `deleted_at` 追加）。現状は upsert のみ
