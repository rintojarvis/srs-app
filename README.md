# SRS暗記アプリ v1

ブラウザだけで動く忘却曲線（FSRS-5）ベースの暗記カードアプリ。法学（憲法 表現の自由②各論）の予習課題から自動生成された30枚のカードを内蔵。

## 起動方法（PowerShell / bash 共通）

```
cd C:\Users\rinto\projects\ai-tools-staging\srs-app
python -m http.server 8765
```

その後ブラウザで http://localhost:8765/ を開く。

## 仕組み

- アルゴリズム: FSRS-5（`ts-fsrs@4` を esm.sh 経由でロード、ビルド不要）
- カード本体: `cards.json`（初回起動時に取得）
- 状態保存: `localStorage` の `srs-app-state-v1` キー（復習履歴ごと永続化）
- 評価入力: Again / Hard / Good / Easy の4択（PC ではキー `1〜4` でも操作可）
- カード自体への評価: 「このまま / 不要・削除 / もっと深掘り / 分割すべき / 表現を直して / 論点ズレてる」6ボタン＋自由テキスト。`review_history` に追記される。

## 主要ファイル

| ファイル | 内容 |
|---|---|
| `index.html` | UI レイアウト |
| `style.css`  | スタイル（ライト／ダーク両対応、モバイル可） |
| `app.js`     | ES Module、FSRS 統合と状態管理 |
| `cards.json` | 初期カード30枚（憲法・表現の自由②） |

## キーボードショートカット

- `Space` / `Enter`: 答えを表示
- `1` / `2` / `3` / `4`: Again / Hard / Good / Easy

## エクスポート・インポート

- フッターの `エクスポート`: 現在の状態を JSON でダウンロード
- フッターの `インポート`: JSON ファイルで上書き復元
- フッターの `リセット`: `localStorage` を消して `cards.json` を再読込

## 既知の制限

- iOS の PWA は数週間放置で localStorage / IndexedDB が消える場合あり。重要時は定期的にエクスポート推奨
- クラウド同期は未実装（v1 はローカルのみ）
- Web Push 通知・ロック機能は未実装
- AI 自動進化ループ（カード評価ログから Claude が改善案生成）は未実装
- Service Worker / オフライン対応・PWA manifest は未実装（ローカル http.server 前提）
