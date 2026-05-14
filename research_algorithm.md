# SRS（間隔反復）アルゴリズム調査

対象用途: 法学暗記カード約1,000枚 / 「即答できないと操作ロック」型のドリル運用

---

## 1. SM-2（SuperMemo 2 / Anki 旧標準）

- 1987年 Piotr Wozniak 提唱。Anki が長年デフォルトとして採用してきた古典アルゴリズム。
- 各カードに **Ease Factor (EF, 初期値 2.5)** を持たせ、ユーザーの自己評価（0〜5、Anki では Again/Hard/Good/Easy の4段階）に応じて次回間隔と EF を更新する。
- 計算は単純な閉形式: `次回間隔 = 前回間隔 × EF`、Again で EF を 0.2 減らし間隔リセット。
- 強み: 仕様が単純・実装容易・予測可能。コミュニティ実績は世界最大級。
- 弱点: EF が一度下がると戻りにくい「**ease hell**（イーズ地獄）」、ユーザー個人や記憶定着度に応じた動的調整ができない。スケジュールの平均誤差は **±16.2%** と大きい。

## 2. FSRS（Free Spaced Repetition Scheduler）

- 2022年に Jarrett Ye が公開。**Anki 23.10（2023年11月）以降は公式同梱**、24.x 以降は新規ユーザー向けデフォルト。最新は **FSRS-6（2025年末リリース）**、FSRS-5 が広く使用中。
- **DSR モデル**: 各カードに `Difficulty（難度）` `Stability（記憶の安定度）` `Retrievability（想起確率）` の3変数を持たせ、忘却曲線をパラメトリックに表現する。
- ユーザーのレビュー履歴を機械学習で個別フィッティング（17〜21個の重み `w0…w20`）。**Difficulty は平均回帰**するため ease hell が起きない。
- 既定の保持率（retention target）は **90%**。`±5.3%` 精度でこれを達成する。
- 強み: 5億件超のレビューで実証済み、SM-2 比で **20〜30% レビュー数削減**。複数アプリ（Anki / RemNote / 自作実装多数）で採用が広がる。
- 弱点: 初期は学習データが少ないため恩恵が薄い（数百件以上のレビューで真価）。実装はやや複雑（DSR 計算 + パラメータ最適化ルーチン）。

## 3. Leitner system（ライトナーシステム）

- 1972年 Sebastian Leitner 考案の物理的箱方式。通常 5 箱（Box 1〜5）を用意し、正解で次の箱へ昇格、不正解で Box 1 に戻す。
- 各箱に固定間隔（例: 1日 / 3日 / 7日 / 14日 / 30日）を割り当てる。
- 強み: 仕組みが直感的、ペーパー実装可能、新規学習者の心理的ハードルが極低い。
- 弱点: 同じ箱内のカードは **滞在期間に関わらず一律間隔**で扱われ、個別最適化ゼロ。**1,000枚規模になると箱が肥大化し復習効率が急落**（公式コミュニティでも「初学者は 50 枚から」が定番アドバイス）。長期・大量カードには非推奨。

---

## 比較表

| 項目 | SM-2 | FSRS-5/6 | Leitner |
|---|---|---|---|
| 初出年 | 1987 | 2022 | 1972 |
| 学習効果（90%保持時の精度） | ±16.2% | **±5.3%** | 計測不可（一律間隔） |
| 同じ保持率での必要レビュー数 | 基準 | **基準比 -20〜30%** | 基準より多い |
| 個別最適化 | EF のみ（限定的） | **17〜21パラメータを ML 最適化** | なし |
| 実装難易度 | 低（数十行で書ける） | 中〜高（DSR + 最適化） | 極低（配列 + カウンタ） |
| カスタマイズ性 | 中（EF 初期値・間隔倍率） | **高（重み・retention 目標を調整可）** | 低（箱数・間隔のみ） |
| コミュニティ実績 | 世界最大（Anki 旧標準・SuperMemo） | **急成長中（Anki 公式デフォルト）** | 教育界に広く知られるが SRS アプリ採用は少 |
| 大量カード（1000+）耐性 | 良 | **最良** | 不可 |
| 即答型ドリル（pass/fail 二値）との相性 | 可（Again/Good に縮約） | **最良（Again/Good で十分動作）** | 可（昇格/降格そのもの） |

---

## 推奨

**第一候補: FSRS-5（または FSRS-6）を採用し、評価入力は Again / Good の2択に縮約する。**

**理由（要点）:**
- 「即答できないと操作ロック」型は実質 **二値判定（pass/fail）** であり、FSRS の Rating 入力（Again=1 / Good=3）にそのままマッピングできる。Hard/Easy を捨てても DSR モデルは破綻しない。
- 1,000枚規模の法律暗記は **長期保持と毎日の復習負荷削減** が支配的目的。FSRS の 20〜30% レビュー削減が直接効く（1日100枚→70〜80枚）。
- ease hell が起きないので、難問カード（条文趣旨・判例射程など）の復習頻度が永久に高止まりしない。
- 既存実装（`ts-fsrs` / `fsrs-rs` / `py-fsrs` 等）を流用可。フルスクラッチでも DSR 計算式 + 既定パラメータをハードコードすれば 1〜2日で動かせる。

**初期パラメータ案（実装時の出発点）:**
- Retention target: **0.90**（既定）
- 重み `w0…w20`: FSRS-5 既定値をそのまま採用（公式リポジトリ `open-spaced-repetition/ts-fsrs` 等から取得）
- 1日の新規カード: 10〜20 枚
- 1日のレビュー想定: 定常状態で 50〜100 枚（1,000枚保持時）
- 学習データが 1,000 レビュー以上溜まったら、ユーザーごとにパラメータ再最適化を走らせる

**フォールバック:** FSRS の実装コストが高すぎる場合は SM-2 を採用（数十行で実装可、ただし ease hell 対策として EF 下限 1.5・上限 3.0 のクランプ推奨）。Leitner は 1,000枚規模では非推奨。

---

## 参考

- [FSRS-5 vs SM-2: Spaced Repetition Algorithm Comparison（diane.app）](https://www.diane.app/en/guides/fsrs-vs-sm2)
- [How to Use FSRS in Anki: Complete Setup Guide 2026（SlideToAnki）](https://slidetoanki.com/blog/how-to-use-fsrs-anki-guide)
- [A technical explanation of FSRS（Expertium's Blog）](https://expertium.github.io/Algorithm.html)
- [open-spaced-repetition/fsrs4anki tutorial](https://github.com/open-spaced-repetition/fsrs4anki/blob/main/docs/tutorial.md)
- [Leitner system - Wikipedia](https://en.wikipedia.org/wiki/Leitner_system)
- [Anki - Wikipedia](https://en.wikipedia.org/wiki/Anki_(software))
