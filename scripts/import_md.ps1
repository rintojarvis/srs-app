[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $false)]
    [string]$Subject = '',

    [Parameter(Mandatory = $false)]
    [string]$Tags = '',

    [Parameter(Mandatory = $false)]
    [string]$Model = 'claude-opus-4-7'
)

$ErrorActionPreference = 'Stop'

# ─── パス解決 ─────────────────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$appRoot   = Resolve-Path (Join-Path $scriptDir '..')
$cardsPath = Join-Path $appRoot 'cards.json'
$importedSourcesFile = Join-Path $appRoot 'imported_sources.json'

if (-not (Test-Path $Path)) {
    Write-Error "MD ファイルが見つかりません: $Path"
    exit 1
}
if (-not (Test-Path $cardsPath)) {
    Write-Error "cards.json が見つかりません: $cardsPath"
    exit 1
}

# ─── 既存 cards.json 読み込み ─────────────────────────
$existingCards = Get-Content -Path $cardsPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $existingCards) { $existingCards = @() }
$existingCards = @($existingCards)

# 最大 ID 抽出
$maxNum = 0
foreach ($c in $existingCards) {
    if ($c.id -match 'card_(\d+)') {
        $n = [int]$Matches[1]
        if ($n -gt $maxNum) { $maxNum = $n }
    }
}

# 重複取込チェック
$basename = Split-Path -Leaf $Path
$dupAlready = $false
foreach ($c in $existingCards) {
    if ($c.source -eq $basename) { $dupAlready = $true; break }
}
if ($dupAlready) {
    Write-Warning ("source = '{0}' のカードが既に存在します。重複取込になります。" -f $basename)
}

# ─── MD 読み込み ──────────────────────────────────────
$mdText = Get-Content -Path $Path -Raw -Encoding UTF8
$mdLen  = $mdText.Length
$mdKb   = [math]::Round($mdLen / 1KB, 1)
Write-Host ("Reading MD: {0} ({1} KB)" -f $basename, $mdKb)
if ($mdLen -gt 100000) {
    Write-Warning ("MD が 100KB を超えています ({0} KB)。生成が不安定になる可能性があります。" -f $mdKb)
}

# ─── claude -p 呼び出し ───────────────────────────────
$systemPrompt = @'
あなたは法学暗記カード生成の純粋なテキスト生成器として動作する。入力された MD から暗記カードの JSON 配列を生成する。出力は以下のルールに厳密に従う:

- 出力は純粋な JSON 配列のみ。コードフェンス（```json 等）禁止。前置きナレーション禁止。末尾コメント禁止。
- 配列の各要素は { "front": string, "back": string, "tags": string[] } のオブジェクト。
- front は簡潔な質問（1〜2文）。back は核となる規範・趣旨・判例名を含む回答（3〜10行程度）。
- tags は科目名・論点名・判例名・規範名などから 2〜4 個。
- カード枚数は 15〜40 枚を目標とする。MD が短い場合は 15 枚未満でもよいが、最低 5 枚は出力する。
- 自己チェック・タイトル更新・Master Jarvis・Worker・Coordinator・Jarvis・AI システム関連語を一切含めない。
'@

$userPrompt = @"
以下の MD は法科大学院の予習・授業ノートです。Q&A 形式または論述形式から、暗記カードを 15〜40 枚抽出してください。

【出力形式】
純粋な JSON 配列のみ。コードフェンスや前置き禁止。

[
  { "front": "...", "back": "...", "tags": ["...", "..."] },
  ...
]

【MD 本文】

$mdText
"@

Write-Host ("Calling claude -p (model: {0})..." -f $Model)
$rawOut = $userPrompt | claude -p --model $Model --append-system-prompt $systemPrompt
if ($LASTEXITCODE -ne 0) {
    Write-Error ("claude -p 呼び出し失敗 (exit code: {0})" -f $LASTEXITCODE)
    exit 1
}

if (-not $rawOut -or $rawOut.Trim().Length -eq 0) {
    Write-Error "claude -p の出力が空でした。"
    exit 1
}

# ─── JSON 抽出・パース ─────────────────────────────────
# 万一コードフェンスが混入した場合に備えて除去
$cleaned = $rawOut
$cleaned = [regex]::Replace($cleaned, '^```(?:json)?\s*', '', [System.Text.RegularExpressions.RegexOptions]::Multiline)
$cleaned = [regex]::Replace($cleaned, '```\s*$', '', [System.Text.RegularExpressions.RegexOptions]::Multiline)

# 最初の [ から最後の ] までを抽出（前後にナレーションが混じった保険）
$first = $cleaned.IndexOf('[')
$last  = $cleaned.LastIndexOf(']')
if ($first -ge 0 -and $last -gt $first) {
    $cleaned = $cleaned.Substring($first, $last - $first + 1)
}

$parsed = $null
try {
    $parsed = $cleaned | ConvertFrom-Json
} catch {
    Write-Error ("JSON パース失敗: {0}`n--- raw output head ---`n{1}" -f $_.Exception.Message, $rawOut.Substring(0, [Math]::Min(800, $rawOut.Length)))
    exit 1
}

if (-not $parsed -or @($parsed).Count -eq 0) {
    Write-Error "パース結果が空配列でした。cards.json は更新しません。"
    exit 1
}

# ─── ID 採番 + メタ付与 ───────────────────────────────
$importedAt = (Get-Date).ToString('o')
$tagList = @()
if ($Tags) {
    $tagList = $Tags -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

$newCards = @()
$newIds   = @()
$idx = 0
foreach ($p in @($parsed)) {
    $idx++
    $maxNum++
    $newId = ('card_{0:D3}' -f $maxNum)
    $newIds += $newId

    $front = if ($p.front) { [string]$p.front } else { '' }
    $back  = if ($p.back)  { [string]$p.back  } else { '' }

    # tags: AI が生成した tags + 引数で指定された tags を結合（重複排除）
    $genTags = @()
    if ($p.tags) {
        foreach ($t in @($p.tags)) {
            if ($t) { $genTags += [string]$t }
        }
    }
    $allTags = @($genTags) + @($tagList)
    if ($Subject) { $allTags = @($Subject) + $allTags }
    $allTags = $allTags | Where-Object { $_ -and $_.Trim().Length -gt 0 } | Select-Object -Unique

    if (-not $front -or -not $back) {
        Write-Warning ("空の front/back を含むカードをスキップ: index={0}" -f $idx)
        $maxNum--  # ID を巻き戻す
        continue
    }

    $card = [ordered]@{
        id            = $newId
        front         = $front
        back          = $back
        tags          = @($allTags)
        source        = $basename
        linked_cards  = @()
        fsrs          = [ordered]@{
            due            = (Get-Date).ToString('yyyy-MM-dd')
            stability      = 0
            difficulty     = 0
            elapsed_days   = 0
            scheduled_days = 0
            reps           = 0
            lapses         = 0
            state          = 0
            last_review    = $null
        }
        review_history = @()
    }
    $newCards += [pscustomobject]$card
}

if ($newCards.Count -eq 0) {
    Write-Error "有効なカードが 0 枚でした。cards.json は更新しません。"
    exit 1
}

# ─── バックアップ → 書き込み ──────────────────────────
$backupDir = Join-Path $appRoot 'backups'
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupPath = Join-Path $backupDir ("cards.json.bak.{0}" -f $ts)
Copy-Item -Path $cardsPath -Destination $backupPath -Force
Write-Host ("Backup written: {0}" -f $backupPath)

$mergedCards = @($existingCards) + @($newCards)
@($mergedCards) | ConvertTo-Json -Depth 12 -AsArray | Out-File -FilePath $cardsPath -Encoding UTF8

# ─── imported_sources.json 更新 ──────────────────────
$importedEntries = @()
if (Test-Path $importedSourcesFile) {
    try {
        $raw = Get-Content -Path $importedSourcesFile -Raw -Encoding UTF8
        if ($raw -and $raw.Trim().Length -gt 0) {
            $loaded = $raw | ConvertFrom-Json
            if ($loaded) { $importedEntries = @($loaded) }
        }
    } catch {
        Write-Warning ("imported_sources.json パース失敗・再構築します: {0}" -f $_.Exception.Message)
        $importedEntries = @()
    }
}

# 同一 path のエントリがあれば差し替え
$importedEntries = @($importedEntries | Where-Object { $_.path -ne $Path })

$srcFi = Get-Item $Path
$importedEntries += [pscustomobject]@{
    path          = $Path
    basename      = $basename
    subject       = $Subject
    last_modified = $srcFi.LastWriteTime.ToString('o')
    imported_at   = $importedAt
    card_count    = $newCards.Count
    card_ids      = @($newIds)
}

@($importedEntries) | ConvertTo-Json -Depth 8 -AsArray | Out-File -FilePath $importedSourcesFile -Encoding UTF8

# ─── 結果報告 ─────────────────────────────────────────
$firstId = $newIds[0]
$lastId  = $newIds[-1]
Write-Host ""
Write-Host ("{0} 枚を {1}〜{2} として追加。imported_sources.json 更新。" -f $newCards.Count, $firstId, $lastId)
