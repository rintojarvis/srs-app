# SRS App: Supabase セットアップ手順

このフォルダには、SRS 暗記アプリを **Supabase 同期対応** にするためのスキーマと統合コードのドラフトが入っている。

実 SQL 実行・キー埋め込み・アプリ書き換えは、Supabase プロジェクトを作成したあとの **別ターン** で行う。

---

## ファイル一覧

| ファイル | 内容 |
|---|---|
| `schema.sql` | テーブル定義（cards / review_history / mistakes / checkins / imported_sources / today_events）+ インデックス + updated_at トリガ |
| `rls.sql` | user_id カラム追加 + RLS 有効化 + 自分のデータのみ R/W ポリシー |
| `migrate_initial.sql` | 既存 JSON データを Supabase に流し込むための INSERT 文プレースホルダ |
| `sync_design.md` | `app.js` への Supabase 同期エンジン組み込み設計（擬似コード入り） |
| `scripts_migration.md` | PC 側スクリプト（refresh_today / import_md / apply_proposal / evolve）の改修方針 |
| `README.md` | このファイル |

---

## セットアップ手順（次ターンで実施）

### 1. Supabase プロジェクト作成

1. [supabase.com](https://supabase.com) にログイン
2. New project
3. プロジェクト名: `srs-rinto`（任意）
4. リージョン: `Northeast Asia (Tokyo)` を推奨（レイテンシ低）
5. Database password を発行・保管（後で psql 直接接続時に使用）

### 2. キー類のメモ

Project Settings > API より:

| 項目 | 用途 | 保管場所 |
|---|---|---|
| `Project URL` | ブラウザ + PC スクリプト両方 | `app.js` / `.env` |
| `anon public key` | ブラウザ用（RLS で守られる） | `app.js` 内に直書き OK |
| `service_role secret key` | PC スクリプト用（RLS bypass） | `.env`（**git ignore**） |
| `Project Ref` | URL の一部 | メモ |

### 3. スキーマ作成

Supabase Dashboard > SQL Editor:

1. `schema.sql` の内容を貼り付け → Run
2. `rls.sql` の内容を貼り付け → Run

エラーが出なければ Database > Tables に 6 テーブルが見える。

### 4. 認証プロバイダ設定

Authentication > Providers:

- **Email**: 有効化 + Magic Link を ON、Confirm email を OFF（オプション）
- （任意）**Apple**: 有効化（iOS デバイスで指紋/Face ID 認証可）
- （任意）**Google**: 有効化（PC ブラウザで 1-tap ログイン可）

Authentication > URL Configuration:

- **Site URL**: 本番デプロイ URL（例 `https://srs.rinto.dev/`）
- **Redirect URLs**: 開発時のローカル URL も追加（`http://localhost:8080/*` 等）

### 5. rinto ユーザー作成

Authentication > Users > Invite user:

- メール: `rinto0210@gmail.com`
- 招待メール経由でログイン → UUID が `auth.users.id` に入る
- この UUID を `.env` の `SRS_USER_ID` にコピー

### 6. 既存データの移行

`scripts_migration.md` の §2-5（`export_to_supabase.ps1` を作成）に従って、既存 `cards.json` / `imported_sources.json` / `today.json` を一括投入する。

### 7. `app.js` 統合

`sync_design.md` の §8（app.js への追加箇所）に従って:

1. `index.html` に supabase-js を import
2. `app.js` 末尾に同期エンジンを追加
3. `SUPABASE_URL` と `SUPABASE_ANON_KEY` を実際の値に置換

### 8. PC スクリプト改修

`scripts_migration.md` に従って `srs-app/scripts/` 配下の各 .ps1 を改修。

### 9. 動作確認

- PC ブラウザでログイン → カードが見える
- iPhone Safari でログイン → 同じカードが見える
- どちらかでレビュー → 他方に Realtime で反映
- オフラインにしてレビュー → オンライン復帰時に同期される

---

## セキュリティ注意点

- **service_role キーは絶対にブラウザに置かない**（RLS をバイパスするため漏洩したら全データが見える）
- service_role は PC スクリプトの `.env` だけ
- `.gitignore` に必ず `srs-app/scripts/.env` を追加する
- ブラウザ側は anon キーのみ（RLS で守られているので公開しても OK）

---

## トラブルシュート

| 症状 | 原因候補 | 対処 |
|---|---|---|
| ブラウザで `permission denied for table cards` | RLS で auth.uid() が未セット | ログインを確認、`onAuthStateChange` を待つ |
| PC スクリプトから insert すると `null value in column "user_id"` | service_role でも default auth.uid() は効かない | row に `user_id: $env:SRS_USER_ID` を明示 |
| Realtime 受信が来ない | Database > Replication で対象テーブルを有効化していない | Replication 設定で `cards` 等を ON |
| Magic Link が届かない | Auth Email テンプレートが未設定 / SPF/DKIM | Supabase Email 設定を確認、または SMTP を独自設定 |

---

## 残課題

- 完全移行後の `cards.json` 廃止タイミング
- review_history の長期保管ポリシー（古いものを別テーブルへ）
- 共有用ビュー（弟と問題集を共有する等）の必要性
