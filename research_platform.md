# iPhone 向け SRS（暗記）アプリ 実装プラットフォーム調査

調査日: 2026-05-15
対象: 法科大学院生（rinto）の個人利用、iPhone メイン、手元に Mac なし／DELL 16 Plus（Windows 11）、1〜2 週の自由時間あり

---

## 1. 各実装手段の概要

### A. PWA（Progressive Web App）
HTML/CSS/JS で書いた Web アプリを iPhone Safari で開き「ホーム画面に追加」してネイティブ風に使う方式。サービスワーカーでオフライン動作可。Windows だけで完結し、Mac も Apple Developer 登録も不要。iOS 16.4 以降は Web Push にも対応したが、バックグラウンド処理・ストレージ容量・ストレージ自動消去（数週間放置で消える）・OS フックの欠如など制約が多い。EU 圏ではホーム画面 PWA が一部無効化されている経緯あり。

### B. ネイティブ iOS アプリ（Swift / SwiftUI）
Xcode（= Mac 必須）で書く正攻法。Family Controls / Managed Settings / Device Activity / Screen Time / Shortcuts といった iOS の核 API にフルアクセスでき、本物の操作ロック（後述）に唯一手が届く方式。ただし開発機（Mac mini 等）と、無償 Apple ID で 7 日署名 or 有償 Apple Developer Program（USD 99/年）でデバイス署名 1 年が必要。

### C. ハイブリッド（React Native / Capacitor / Flutter）
Web 技術＋ネイティブブリッジ。最終ビルドは結局 Xcode（Mac）が要る。Screen Time API のような特殊な権限は、結局自前のネイティブモジュールを書くので「ハイブリッドで楽になる」という前提が崩れがち。SRS の UI だけなら効率はよい。

### D. ノーコード／ローコード（Apple Shortcuts、Scriptable）
Scriptable は iOS 上で動く JavaScript IDE（無料）。Notes/Reminders/Calendar/Files/通知などのネイティブブリッジを叩ける。Shortcuts と組み合わせれば「ホーム画面アイコン → カード表示 → 評価入力 → 次回出題日更新」程度の SRS は実現可。UI は素朴で、独自の操作ロックは作れない（Shortcuts オートメーションでアプリ起動時に介入する程度）。

### E. Web アプリ＋Safari でアクセス（サーバホスト）
PC かレンタルサーバ（Cloudflare Pages / Vercel / 自宅 Tailscale 経由）に置いた Web アプリに Safari から都度アクセスする方式。実装が一番ラクで、PC/iPhone で同じデータを共有しやすい。ただしオフライン弱く（PWA 化しないなら通信必須）、iPhone 側との連携は最も浅い。

---

## 2. 比較表

| 観点 | A: PWA | B: ネイティブ iOS | C: ハイブリッド | D: Shortcuts/Scriptable | E: Web+Safari |
|---|---|---|---|---|---|
| 開発工数 | **小〜中**（Win だけで OK） | 大（Mac 必須・Swift 学習） | 中〜大（Mac 必須） | **極小**（即作れる） | 小〜中 |
| 配布難易度 | **最小**（URL を Safari で開く→ホーム追加） | 中〜大（無償なら 7 日毎再署名、有償 99 USD/年） | 中〜大（同上） | 極小（Scriptable App をインストールしてスクリプトを置くだけ） | 最小（URL を開くだけ） |
| 操作ロック実現度 | × ほぼ不可（Guided Access 手動のみ） | ◎ Family Controls + Device Activity で**本物の OS レベル制限** | △ ネイティブ拡張を自作すれば B 相当、しなければ A 相当 | × アプリ単体ロックは不可。Shortcuts オートメーションで弱い介入のみ | × 不可 |
| オフライン動作 | △ サービスワーカー＋IndexedDB／約 50MB／**数週放置で自動消去**／BackgroundSync 非対応 | ◎ ローカル DB 自由・容量も実質端末容量 | ◎（B と同様） | ◎ ローカルファイル参照可 | × オンライン前提 |
| iOS API 連携 | △ Web Push 程度 | ◎ Screen Time / Shortcuts / WidgetKit / 通知全部 | ○ プラグイン経由 | ○ Files・Notes・通知・位置等ブリッジあり | × |
| 法令／規約上の落とし穴 | EU では一部制限の前例あり | App Store 公開なら審査、Family Controls 配布権限の取得は 2026 年も承認遅延報告あり | 同上 | 個人スクリプトなので問題なし | なし |

---

## 3. 「未回答だと操作ロック」機能の実現性（重要）

iOS で「カード回答するまで他アプリを使わせない」を**本気で OS に強制させる**には、選択肢が非常に限られる。

| 手段 | できること | 限界 |
|---|---|---|
| **Family Controls / Screen Time API**（B のみ） | 他アプリ・カテゴリをアプリ側からブロック／一定条件で解除。Device Activity でアプリ起動を監視できる。アプリは「ガーディアン承認」で保護され、ユーザーも勝手にアンインストールできない設計 | (1) 配布には Family Controls Distribution Entitlement の Apple 承認が必要で、**2026 年も承認待ち報告が多発**。個人開発で取れる保証なし。(2) ガーディアン未承認の状態だとそもそも API が使えない。(3) **第三者アプリの Screen Time 権限はユーザーが iOS 設定の Face ID 認証 1 回で剥がせる**ため、自分自身に課す「強制ロック」としては突破口が残る |
| **Guided Access（アクセスガイド）** | 1 アプリだけに iPhone を固定。ホームボタン／ジェスチャを無効化。本当に強い | OS の標準機能であり、起動は**手動**。アプリから自動で ON にできない。"未回答ならロック" のトリガーには使えない |
| **Shortcuts のオートメーション**（D） | 特定アプリ起動時に Shortcut を発火させ、SRS アプリへ遷移させる | (1) 「確認」付きトリガーが既定。確認なしにできても、ユーザーは無視できる。(2) アプリの強制終了・ブロックはできない |
| **通知の連打** | 未回答時に繰り返し通知 | 通知は無視されたら終わり。OS をロックする力はない |
| **PWA / Web からの制御** | なし | iOS は Web から OS にロックさせる API を一切公開していない |

### 結論（操作ロックについて）

- **「アプリ側から OS を強制的に止める真のロック」は、個人開発者には現実的に不可能**と考えてよい。Family Controls はそれに最も近いが、(a) Apple の配布権限承認 (b) ガーディアン承認 (c) 設定からの権限剥奪、の 3 段階を超える必要があり、自分自身に対する「逃げ場のないロック」としては成立しない。
- **「やる気がある自分」が「やる気がない自分」を縛る目的なら、Guided Access の手動 ON が一番強い**。アプリ側はそれを補助する作りにする（例：朝の起動時に「Guided Access を ON にしてください」と案内する）。
- ソフトな抑制で十分なら、**Shortcuts オートメーション＋通知連打＋"未回答だとカードが画面いっぱいに復活" の UX 設計**で実用上のロック感は出せる。

---

## 4. rinto への推奨

### 第一推奨: **A. PWA を本体にし、D. Shortcuts/Scriptable を補助に使う**

理由:

1. **手元の機材で完結する**。Mac がない・Apple Developer 99 USD/年を継続する必然性が薄い段階で、Mac 購入や年会費から始めるのは「司法試験までの可処分時間」に対して投資効率が悪い。PWA なら Windows + iPhone だけで成立する。
2. **ネイティブの本命機能（Family Controls）が個人で安定運用できる前提が崩れている**。2026 年も配布承認遅延が報告されており、苦労して B でビルドしても「強制ロック」は完成しない可能性が高い。労力対効果が悪い。
3. **法科大学院の暗記用途は SRS アルゴリズム＋オフライン閲覧＋スマホで一瞬で出てくる UX の 3 つが本質**で、これらは PWA で十分。
4. **「未回答なら通知連打＋ホーム画面アイコンに巨大バッジ＋ロック画面に重大通知」までは PWA でも可**。さらに強くしたいときは Shortcuts オートメーションで「Safari/SNS 起動時に SRS PWA に遷移させる」を組み合わせれば、自分への約束デバイスとして実用的になる。

### 第二推奨（強い操作ロックを真剣に欲しい場合のみ）: **B. ネイティブ iOS + 中古 Mac mini + 有償 Apple Developer**

ただし以下を覚悟する必要がある:

- 中古 Mac mini（M1 以降が望ましい）の入手
- Apple Developer Program 99 USD/年
- Family Controls Distribution Entitlement の申請（承認まで月単位、却下リスクあり）
- Swift/SwiftUI の学習（法科大学院の負荷と並行）

→ **試験までの時間配分を考えると、第二推奨に踏み込むのは「PWA 版を半年運用してロックの弱さが本当にボトルネックだと実証できたとき」だけにする**のが妥当。

### 最初の 1〜2 週間でやることの提案

1. PWA 雛形を作る（IndexedDB に SM-2 もしくは FSRS-4.5 を実装、Web Push 設定、`manifest.json`）
2. ホーム画面追加・オフライン動作・通知の挙動を iPhone で実機確認
3. Shortcuts で「Safari 起動 → SRS PWA を開く」オートメーションを試作
4. 1 週間運用してログを取る（未回答時にどれくらい逃げてしまうか）
5. ロックが本当に足りないと判明した時点で初めて B 案を再評価

---

## 5. 参考情報源

- Apple Developer Documentation: Screen Time Technology Frameworks
- WWDC21 / WWDC22 セッション「Meet the Screen Time API」
- riedel.wtf 「State of the Screen Time API 2024」
- magicbell.com 「PWA iOS Limitations and Safari Support 2026」
- mobiloud.com 「Do Progressive Web Apps Work on iOS? 2026」
- dev.to 「How iOS Sideloading Actually Works in 2025: Dev Certs, AltStore, and the EU Exception」
- Apple Developer Support「Choosing a Membership」
- Scriptable App（scriptable.app）
- MacStories「Scriptable: Automating iOS with JavaScript」
