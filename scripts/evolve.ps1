[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$StateFile,

    [Parameter(Mandatory = $false)]
    [string]$Model = "claude-opus-4-7",

    [Parameter(Mandatory = $false)]
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'

# ─── パス解決 ─────────────────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$appRoot   = Resolve-Path (Join-Path $scriptDir '..')

if (-not $StateFile) {
    $StateFile = Join-Path $appRoot 'state.json'
}
if (-not (Test-Path $StateFile)) {
    Write-Error "state.json が見つかりません: $StateFile`nWeb アプリの [エクスポート] で取得した JSON を保存してください。"
    exit 1
}

if (-not $OutDir) {
    $OutDir = Join-Path $appRoot 'proposals'
}
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

# ─── state.json 読み込み ─────────────────────────────
Write-Host "Loading state from: $StateFile"
$stateText = Get-Content -Path $StateFile -Raw -Encoding UTF8
try {
    $state = $stateText | ConvertFrom-Json
} catch {
    Write-Error "state.json のパースに失敗: $($_.Exception.Message)"
    exit 1
}

if (-not $state.cards) {
    Write-Error "state.cards が空または存在しません。"
    exit 1
}

# ─── 候補抽出 ─────────────────────────────────────────
$cardsWithFeedback = @()
foreach ($card in $state.cards) {
    if (-not $card.review_history) { continue }
    $hasFeedback = $false
    foreach ($r in $card.review_history) {
        $cr = if ($r.PSObject.Properties['card_review']) { $r.card_review } else { $null }
        $cm = if ($r.PSObject.Properties['comment']) { $r.comment } else { $null }
        if (($cr -and $cr -ne 'このまま') -or ($cm -and $cm -ne '')) {
            $hasFeedback = $true
            break
        }
    }
    if ($hasFeedback) { $cardsWithFeedback += $card }
}

$openMistakes = @()
if ($state.PSObject.Properties['mistakes'] -and $state.mistakes) {
    foreach ($m in $state.mistakes) {
        $status = if ($m.PSObject.Properties['status']) { $m.status } else { 'open' }
        if ($status -eq 'open') { $openMistakes += $m }
    }
}

Write-Host ("Feedback cards: {0} / open mistakes: {1}" -f $cardsWithFeedback.Count, $openMistakes.Count)

if ($cardsWithFeedback.Count -eq 0 -and $openMistakes.Count -eq 0) {
    Write-Host "進化候補なし。何も生成せず終了します。"
    exit 0
}

# ─── プロンプト構築 ───────────────────────────────────
$sb = New-Object System.Text.StringBuilder

[void]$sb.AppendLine("以下は SRS 暗記カードアプリのユーザーフィードバックです。各カードに対するユーザーの評価ボタンとコメント、および演習で間違えた論点を踏まえて、改善案を提示してください。")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("【出力フォーマット（厳守・必ずこの順で全セクション出すこと。対象がない場合は『該当なし』と書く）】")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## 削除候補")
[void]$sb.AppendLine("- card_XXX: 理由")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## 分割候補")
[void]$sb.AppendLine("- card_XXX → 2枚に分割案")
[void]$sb.AppendLine("  - 新カード A: front / back")
[void]$sb.AppendLine("  - 新カード B: front / back")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## 書き換え候補")
[void]$sb.AppendLine("- card_XXX:")
[void]$sb.AppendLine("  - 旧: front / back")
[void]$sb.AppendLine("  - 新: front / back")
[void]$sb.AppendLine("  - 理由")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## 深掘り（関連カード追加）")
[void]$sb.AppendLine("- 元カード: card_XXX")
[void]$sb.AppendLine("  - 新規カード案:")
[void]$sb.AppendLine("    - front: ...")
[void]$sb.AppendLine("    - back: ...")
[void]$sb.AppendLine("    - tags: [...]")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## 演習フィードバックへの対応")
[void]$sb.AppendLine("- mistake_XXX (本文): 既存カード ヒット数 N")
[void]$sb.AppendLine("  - ヒットあり: 該当カードを優先キューに（記録のみ・実行は別スクリプト）")
[void]$sb.AppendLine("  - ヒットなし: 新規カード案")
[void]$sb.AppendLine("    - front / back / tags")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("---")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("【カード一覧とフィードバック】")
[void]$sb.AppendLine("")

foreach ($card in $cardsWithFeedback) {
    [void]$sb.AppendLine(("### {0}" -f $card.id))
    [void]$sb.AppendLine(("- front: {0}" -f $card.front))
    [void]$sb.AppendLine(("- back: {0}" -f $card.back))
    if ($card.tags) {
        [void]$sb.AppendLine(("- tags: {0}" -f ($card.tags -join ', ')))
    }
    if ($card.source) {
        [void]$sb.AppendLine(("- source: {0}" -f $card.source))
    }
    [void]$sb.AppendLine("- review_history:")
    foreach ($r in $card.review_history) {
        $cr  = if ($r.PSObject.Properties['card_review']) { $r.card_review } else { $null }
        $cm  = if ($r.PSObject.Properties['comment']) { $r.comment } else { $null }
        $rt  = if ($r.PSObject.Properties['rating']) { $r.rating } else { '' }
        $at  = if ($r.PSObject.Properties['at']) { $r.at } else { '' }
        [void]$sb.AppendLine(("  - at={0} rating={1} card_review={2} comment={3}" -f $at, $rt, ($cr ?? '(なし)'), ($cm ?? '(なし)')))
    }
    [void]$sb.AppendLine("")
}

[void]$sb.AppendLine("【演習フィードバック（status=open）】")
[void]$sb.AppendLine("")
foreach ($m in $openMistakes) {
    $tagsStr = if ($m.tags) { $m.tags -join ', ' } else { '' }
    $src     = if ($m.source) { $m.source } else { '(なし)' }
    $hits    = if ($m.hit_card_ids) { $m.hit_card_ids.Count } else { 0 }
    $hitList = if ($m.hit_card_ids) { $m.hit_card_ids -join ', ' } else { '' }
    [void]$sb.AppendLine(("### {0}" -f $m.id))
    [void]$sb.AppendLine(("- text: {0}" -f $m.text))
    [void]$sb.AppendLine(("- tags: {0}" -f $tagsStr))
    [void]$sb.AppendLine(("- source: {0}" -f $src))
    [void]$sb.AppendLine(("- hit_card_ids ({0}): {1}" -f $hits, $hitList))
    [void]$sb.AppendLine("")
}

$promptText = $sb.ToString()

# ─── claude -p 呼び出し ───────────────────────────────
Write-Host "Calling claude -p (model: $Model)..."

# stdin で長文を渡す。生成物には自己チェックブロック・タイトル更新ナレーション等を一切含めない。
$systemPrompt = @'
あなたは SRS 暗記カードアプリの進化提案を生成する純粋なテキスト生成器として動作する。出力は指示されたフォーマット（## 削除候補 / ## 分割候補 / ## 書き換え候補 / ## 深掘り / ## 演習フィードバックへの対応 の5セクション）のみで構成し、以下を一切含めないこと:
- 自己チェックブロック（「━━━ 🔍 自己チェック ━━━」等を含む装飾区切り）
- 「タイトル更新」「Master Jarvis」「Worker」「Coordinator」「Jarvis」等の AI システム関連用語
- 前置きナレーション（「分析に入ります」「以下が提案です」など）
- 末尾の総括コメント
- pass / NG といった内部判定の表示

出力は Markdown のセクション見出しから即始め、最後のセクションが終わったら追加コメントなしで終了する。各セクションは複数行で読みやすく整形する（1行に圧縮しない）。
'@

$proposalText = $promptText | claude -p --model $Model --append-system-prompt $systemPrompt
if ($LASTEXITCODE -ne 0) {
    Write-Error "claude -p の呼び出しに失敗 (exit code: $LASTEXITCODE)"
    exit 1
}

if (-not $proposalText -or $proposalText.Trim().Length -eq 0) {
    Write-Error "claude -p の出力が空でした。"
    exit 1
}

# 念のため、出力に自己チェックブロックが混入した場合は除去
$proposalText = [regex]::Replace(
    $proposalText,
    '━+\s*🔍?\s*\*?\*?自己チェック.*$',
    '',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
).TrimEnd() + "`n"

# ─── 出力 ─────────────────────────────────────────────
$ts = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$outPath = Join-Path $OutDir ("{0}.md" -f $ts)

$header = @"
# SRS 進化提案 - $ts

- 対象 state: $StateFile
- フィードバック付きカード: $($cardsWithFeedback.Count) 件
- 未消化の演習ミス (open): $($openMistakes.Count) 件
- model: $Model

---

"@

($header + $proposalText) | Out-File -FilePath $outPath -Encoding UTF8 -NoNewline

Write-Host ""
Write-Host "Proposal written to: $outPath"
