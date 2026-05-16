# SRS App: Supabase 同期エンジン設計ドラフト

`app.js` を Supabase 同期対応に拡張するための設計メモ。実コードは別ターンで投入する（このターンではドラフトのみ）。

---

## 1. 全体構成

```
┌──────────────────────────┐         ┌──────────────────────────┐
│ ブラウザ (iPhone / iPad   │         │ PC スクリプト             │
│   / PC のブラウザアプリ)  │         │ (refresh_today /         │
│                          │         │  import_md / apply_      │
│ - localStorage キャッシュ │         │  proposal / evolve)      │
│ - pendingPushes キュー    │         │ - SERVICE_ROLE_KEY 使用  │
│ - supabase-js (anon key) │         │ - 直接 supabase-js で    │
│ - Magic Link 認証         │         │   upsert / select        │
└────────────┬─────────────┘         └────────────┬─────────────┘
             │                                    │
             │       Postgres + Realtime          │
             │  ┌─────────────────────────────┐   │
             └─►│        Supabase             │◄──┘
                │  cards / review_history /   │
                │  mistakes / checkins /      │
                │  imported_sources /         │
                │  today_events               │
                └─────────────────────────────┘
```

- **権威**: Supabase の各テーブル（行ごとの `updated_at` が最新版の真実）
- **キャッシュ**: 各ブラウザの localStorage（オフライン動作のため）
- **同期方向**:
  - ブラウザ → Supabase: レビュー結果・ミス入力・チェックイン
  - PC スクリプト → Supabase: カード追加/更新・カレンダー更新
  - Supabase → 全デバイス: Realtime push + 起動時 pull

---

## 2. 認証

### 採用: Magic Link (Email OTP)

- アカウント作成不要、メールアドレスだけでログイン
- iOS/Android の Safari でも素直に動く
- 既存のパスワードレス UX と相性が良い

### フロー

1. 初回起動: 画面に「メールアドレスを入力」入力欄を表示
2. `supabase.auth.signInWithOtp({ email })` 呼出 → メール送信
3. ユーザがメール内リンクをタップ → アプリに戻る
4. `supabase.auth.onAuthStateChange` で SIGNED_IN を検知 → 同期開始
5. セッションは localStorage に persistSession（supabase-js のデフォルト）

### 将来オプション

- Apple Sign-In（iOS の指紋/Face ID で即ログイン）
- Google Sign-In（PC ブラウザ）
- どちらも Supabase Auth の Provider 設定で有効化するだけ

---

## 3. ライブラリ読み込み

ESM CDN から直接 import（ビルド不要・PWA フレンドリー）:

```html
<script type="module">
  import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
  // app.js が createClient を使える状態にする
  window.__supabaseClient = createClient(
    'https://<PROJECT_REF>.supabase.co',
    '<SUPABASE_ANON_KEY>'
  );
</script>
```

`app.js` 側は `window.__supabaseClient` を参照する。

---

## 4. ローカルキャッシュ

既存実装の **localStorage を維持**（IndexedDB への移行は別件）。

ストレージキー（既存 + 追加）:

| key | 用途 | 既存/新規 |
|---|---|---|
| `srs:cards` | カード全件キャッシュ | 既存 |
| `srs:mistakes` | ミス全件キャッシュ | 既存 |
| `srs:checkins` | チェックイン履歴 | 既存 |
| `srs:today_events` | カレンダー予定 | 既存 |
| `srs:sync:last_pull_at` | 最終 pull 時刻 (ISO) | 新規 |
| `srs:sync:pending` | push 待ちキュー (配列) | 新規 |
| `srs:sync:device_id` | デバイス識別 (UUID) | 新規 |

---

## 5. 同期エンジン

### 5-1. 起動時 `pull()`

```js
async function pull() {
  const lastPull = localStorage.getItem('srs:sync:last_pull_at') ?? '1970-01-01';
  const sb = window.__supabaseClient;

  // 各テーブルを updated_at > lastPull で取得
  const [cards, mistakes, checkins, today] = await Promise.all([
    sb.from('cards').select('*').gt('updated_at', lastPull),
    sb.from('mistakes').select('*').gt('updated_at', lastPull),
    sb.from('checkins').select('*').gt('updated_at', lastPull),
    sb.from('today_events').select('*').gt('updated_at', lastPull),
  ]);

  // ローカルとマージ（per-row last-write-wins, updated_at で比較）
  mergeIntoLocal('srs:cards', cards.data, 'id');
  mergeIntoLocal('srs:mistakes', mistakes.data, 'id');
  mergeIntoLocal('srs:checkins', checkins.data, 'date');
  mergeIntoLocal('srs:today_events', today.data, 'date');

  localStorage.setItem('srs:sync:last_pull_at', new Date().toISOString());
}

function mergeIntoLocal(key, remoteRows, pkField) {
  if (!remoteRows?.length) return;
  const local = JSON.parse(localStorage.getItem(key) ?? '[]');
  const byPk = new Map(local.map(r => [r[pkField], r]));
  for (const remote of remoteRows) {
    const existing = byPk.get(remote[pkField]);
    if (!existing || (remote.updated_at > (existing.updated_at ?? ''))) {
      byPk.set(remote[pkField], remote);
    }
  }
  localStorage.setItem(key, JSON.stringify([...byPk.values()]));
}
```

### 5-2. ローカル書込み → push キュー追加

ユーザがレビューを評価したとき:

```js
function recordReview(cardId, rating) {
  const card = findCard(cardId);
  // 1) FSRS 更新（既存ロジック）
  applyFsrs(card, rating);
  card.updated_at = new Date().toISOString();
  saveCardsLocal();

  // 2) review_history に append（ローカル + push キュー）
  const event = {
    card_id: cardId,
    at: new Date().toISOString(),
    rating,
    device: getDeviceLabel(),
  };
  enqueuePush('review_history', 'insert', event);

  // 3) card 本体の fsrs / updated_at も push
  enqueuePush('cards', 'upsert', {
    id: card.id, fsrs: card.fsrs, updated_at: card.updated_at,
  });
}

function enqueuePush(table, op, row) {
  const q = JSON.parse(localStorage.getItem('srs:sync:pending') ?? '[]');
  q.push({ table, op, row, enqueued_at: Date.now() });
  localStorage.setItem('srs:sync:pending', JSON.stringify(q));
  triggerFlush();
}
```

### 5-3. flush（push キュー消化）

トリガー条件:
- `enqueuePush` 直後（即時）
- `online` イベント（オフライン復帰）
- 30 秒おき（保険）
- `visibilitychange` で visible になったとき

```js
let flushing = false;
async function flush() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const q = JSON.parse(localStorage.getItem('srs:sync:pending') ?? '[]');
    while (q.length) {
      const { table, op, row } = q[0];
      const sb = window.__supabaseClient;
      let res;
      if (op === 'insert')      res = await sb.from(table).insert(row);
      else if (op === 'upsert') res = await sb.from(table).upsert(row);
      else if (op === 'update') res = await sb.from(table).update(row).eq('id', row.id);
      if (res.error) break;       // 失敗時は残しておく（次回再試行）
      q.shift();
      localStorage.setItem('srs:sync:pending', JSON.stringify(q));
    }
  } finally {
    flushing = false;
  }
}
```

### 5-4. Realtime 受信

```js
function subscribeRealtime() {
  const sb = window.__supabaseClient;
  ['cards', 'mistakes', 'checkins', 'today_events'].forEach(table => {
    sb.channel(`rt:${table}`)
      .on('postgres_changes',
          { event: '*', schema: 'public', table },
          payload => applyRemoteChange(table, payload))
      .subscribe();
  });
}

function applyRemoteChange(table, payload) {
  // payload.new を見て、ローカルの updated_at と比較
  // 新しければローカルに反映し、必要なら UI を再描画
}
```

review_history は append-only なので Realtime 受信は任意（PC 側だけで読めれば足りる）。

### 5-5. 衝突解決

- per-row **last-write-wins**（`updated_at` で比較）
- 例外: `review_history` は append-only なので衝突しない
- `cards.fsrs` のように同時編集が起きうるフィールドは、現実的に「同じカードを 2 デバイスで同時にレビュー」というケースが稀なので LWW で許容

---

## 6. オフライン対応

- 既存の SW (Service Worker) が静的アセットをキャッシュ済 → アプリ起動は維持
- 同期エンジンは `navigator.onLine === false` のとき push を skip し pending に貯める
- `online` イベントで自動 flush
- 起動時に pull 失敗（ネット不可）→ ローカルキャッシュだけで動かす（既存と同じ挙動）

---

## 7. 初回ログイン後の挙動

1. Magic Link で SIGNED_IN
2. ローカルキャッシュが空 → Supabase から全件 pull（lastPull = '1970-01-01'）
3. 既存ローカルキャッシュがある（旧アプリから移行）→ ローカルを「正」として Supabase に upsert（マイグレーション用の一回限りフラグ）
4. 以降は通常の差分同期に入る

---

## 8. app.js への追加箇所（ざっくり）

| 追加ブロック | 場所 |
|---|---|
| supabase-js import | `<head>` の `<script type="module">` |
| 認証 UI（メール入力欄） | アプリトップに 1 セクション追加 |
| `pull()` / `flush()` / `enqueuePush()` / `subscribeRealtime()` | `app.js` 末尾に新セクション |
| 既存のレビュー/ミス/チェックイン書込み箇所 | `enqueuePush(...)` を 1 行追加するだけ |
| `online` / `visibilitychange` / 30s タイマー | 起動時に `addEventListener` |

既存 UI は触らない（あくまでオプトインで同期レイヤを追加）。

---

## 9. 残課題（後続ターン）

- service_role キーを使う PC スクリプトのラッパー（`scripts_migration.md` 参照）
- 初回マイグレーション用の「ローカル→クラウド upsert all」ボタン
- review_history がローカルに溜まりすぎた場合の上限処理（古いものは Supabase に push 済なら破棄）
- カードの大量削除に対する Realtime 受信側のハンドリング
