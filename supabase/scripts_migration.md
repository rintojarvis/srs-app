# PC スクリプト Supabase 移行方針メモ

`srs-app/scripts/` 以下の PC 側スクリプトを Supabase 連携に書き換える方針。実コードは別ターン。

---

## 1. 共通基盤

### 1-1. 認証

- **SERVICE_ROLE_KEY を使う**: RLS をバイパスして任意の user_id で書き込みできる
- `.env` ファイルに置く（git ignore 必須）:

```
# srs-app/scripts/.env
SUPABASE_URL=https://<PROJECT_REF>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
SRS_USER_ID=<rinto の auth.users.id（UUID）>
```

### 1-2. ヘルパー

PowerShell から呼びやすい薄いラッパーを 1 ファイル作る:

```
srs-app/scripts/lib/supabase_client.ps1
```

公開関数（案）:
- `Connect-Supabase` — .env を読んでヘッダを構築
- `Invoke-SupabaseRest -Method GET/POST/PATCH -Table cards -Body $obj`
- `Upsert-SupabaseRow -Table cards -Row $obj`（Prefer: resolution=merge-duplicates）
- `Select-SupabaseRows -Table cards -Filter "updated_at=gt.2026-05-15"`

中身は `Invoke-RestMethod` で Supabase REST API（PostgREST）を叩く:

```
https://<PROJECT_REF>.supabase.co/rest/v1/cards
Headers:
  apikey: <SERVICE_ROLE_KEY>
  Authorization: Bearer <SERVICE_ROLE_KEY>
  Content-Type: application/json
  Prefer: return=representation,resolution=merge-duplicates
```

### 1-3. ローカル JSON との関係

移行期は **二重書き** にする:

1. 従来通り `cards.json` 等の JSON にも書く（既存スクリプトとの後方互換）
2. 加えて Supabase にも UPSERT する

切り戻しや障害時の安全網。完全移行後は JSON 側を廃止する。

---

## 2. 各スクリプトの改修

### 2-1. `refresh_today.ps1`

**Before**: Google Calendar API から今日の予定取得 → `today.json` に書込み
**After**:
1. Google Calendar 取得（変更なし）
2. `today.json` に書込み（互換維持）
3. `today_events` テーブルに UPSERT:
   ```
   Upsert-SupabaseRow -Table today_events -Row @{
     date    = '2026-05-17'
     events  = $events
     user_id = $env:SRS_USER_ID
   }
   ```

### 2-2. `import_md.ps1`

**Before**: 予習課題 md を読んで Claude Code CLI でカード生成 → `cards.json` に append
**After**:
1. 既存処理でカード配列を生成（変更なし）
2. `cards.json` に追記（互換維持）
3. 各カードを `cards` テーブルに UPSERT:
   ```
   foreach ($card in $newCards) {
     Upsert-SupabaseRow -Table cards -Row @{
       id           = $card.id
       front        = $card.front
       back         = $card.back
       tags         = $card.tags
       source       = $card.source
       linked_cards = $card.linked_cards
       fsrs         = $card.fsrs
       user_id      = $env:SRS_USER_ID
     }
   }
   ```
4. `imported_sources` にも UPSERT（path を PK 扱い）:
   ```
   Upsert-SupabaseRow -Table imported_sources -Row @{
     path        = $mdPath
     basename    = $basename
     subject     = $subject
     imported_at = (Get-Date).ToString('o')
     card_count  = $newCards.Count
     card_ids    = $newCards.id
     user_id     = $env:SRS_USER_ID
   }
   ```

### 2-3. `apply_proposal.ps1`

**Before**: `proposals/` の JSON を読んで `cards.json` に UPDATE/INSERT/DELETE
**After**:
- INSERT/UPDATE → `Upsert-SupabaseRow -Table cards`
- DELETE → REST API DELETE:
  ```
  Invoke-RestMethod -Method DELETE `
    -Uri "$SUPABASE_URL/rest/v1/cards?id=eq.$cardId"
  ```
- 旧 `cards.json` も同時更新（互換）

### 2-4. `evolve.ps1`

**Before**: `cards.json` / `mistakes.json`（あれば）/ `review_history` を読んで Claude Code CLI に渡す
**After**:
1. Supabase の `cards` / `mistakes` / `review_history` から SELECT:
   ```
   $cards   = Select-SupabaseRows -Table cards   -Filter "user_id=eq.$($env:SRS_USER_ID)"
   $mistakes = Select-SupabaseRows -Table mistakes -Filter "user_id=eq.$($env:SRS_USER_ID)&status=eq.open"
   $reviews  = Select-SupabaseRows -Table review_history -Filter "user_id=eq.$($env:SRS_USER_ID)&at=gt.$since"
   ```
2. プロンプト組み立て（既存ロジック）
3. Claude Code CLI 呼出（`claude -p` で Max 経由・API 課金なし）
4. 生成された proposal を `proposals/` に保存（既存）

**重要**: ここでは Anthropic API ではなく必ず `claude -p` を使う（CLAUDE.md グローバル方針）。

### 2-5. `（新規）export_to_supabase.ps1`

初回マイグレーション用:
- `cards.json` を全件読んで `cards` に bulk UPSERT
- `imported_sources.json` を全件 UPSERT
- `today.json` を `today_events` に UPSERT
- カード内 `review_history[]` を `review_history` テーブルに展開（INSERT only、重複検出は `card_id + at` のユニーク制約をあとから足してもよい）

---

## 3. .env ハンドリング

PowerShell 側で `.env` を読む簡易関数:

```powershell
function Import-DotEnv {
  param([string]$Path = "$PSScriptRoot\.env")
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$') {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
  }
}
```

各スクリプト先頭で `Import-DotEnv` を呼ぶ。

`.gitignore` に `srs-app/scripts/.env` を追加。

---

## 4. エラーハンドリング方針

- ネット不通 / Supabase 5xx → JSON への書込みは成功させ、Supabase 側は次回 retry
- 429（レート制限）→ exponential backoff（1s → 2s → 4s）で 3 回まで再試行
- 認証エラー（401/403）→ 即時 fail、ログに残してユーザー通知

---

## 5. 動作確認手順（次ターンで実施）

1. Supabase プロジェクト作成 + schema.sql + rls.sql 実行
2. テスト用ユーザー（rinto 本人）を Auth で作成 → UUID を `.env` に
3. `export_to_supabase.ps1` で既存 JSON を投入
4. `refresh_today.ps1` を実行 → Supabase の `today_events` を確認
5. ブラウザアプリ（PC）でログイン → カードが見える
6. iPhone Safari でログイン → 同じカードが見える
7. iPhone でレビュー → PC のブラウザに Realtime で反映
