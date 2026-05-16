[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$TestMd = "C:\Users\rinto\マイドライブ\1 学習院大学法科大学院\1 憲法入門１（月1）\予習課題_第3回_表現の自由①総論_改訂版.md",

    [Parameter(Mandatory = $false)]
    [string]$Model = 'claude-opus-4-7'
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$appRoot   = Resolve-Path (Join-Path $scriptDir '..')
$cardsPath = Join-Path $appRoot 'cards.json'
$sourcesJson = Join-Path $appRoot 'sources.json'
$importedSourcesFile = Join-Path $appRoot 'imported_sources.json'

# ─── Step 1: refresh_sources.ps1 ──────────────────────
Write-Host "==== Step 1: refresh_sources.ps1 ====" -ForegroundColor Cyan
& pwsh -NoProfile -File (Join-Path $scriptDir 'refresh_sources.ps1')
if ($LASTEXITCODE -ne 0) {
    Write-Error "refresh_sources.ps1 が失敗しました"
    exit 1
}

# ─── Step 2: sources.json の中身を表示 ────────────────
Write-Host ""
Write-Host "==== Step 2: sources.json head ====" -ForegroundColor Cyan
if (-not (Test-Path $sourcesJson)) {
    Write-Error "sources.json が生成されていません: $sourcesJson"
    exit 1
}
$sources = Get-Content -Path $sourcesJson -Raw -Encoding UTF8 | ConvertFrom-Json
$sources = @($sources)
Write-Host ("Total sources: {0}" -f $sources.Count)
$top = $sources | Select-Object -First 3
foreach ($s in $top) {
    Write-Host ("  - [{0}] {1}  ({2} KB)  imported={3}" -f $s.subject_guess, $s.basename, $s.size_kb, $s.imported)
}

# ─── Step 3: 別 MD を import_md.ps1 で取込 ───────────
Write-Host ""
Write-Host "==== Step 3: import_md.ps1 ====" -ForegroundColor Cyan
if (-not (Test-Path $TestMd)) {
    Write-Error "テスト用 MD が見つかりません: $TestMd"
    exit 1
}

$cardsBefore = (Get-Content -Path $cardsPath -Raw -Encoding UTF8 | ConvertFrom-Json)
$beforeCount = @($cardsBefore).Count
Write-Host ("Cards before: {0}" -f $beforeCount)

& pwsh -NoProfile -File (Join-Path $scriptDir 'import_md.ps1') -Path $TestMd -Subject '憲法' -Model $Model
if ($LASTEXITCODE -ne 0) {
    Write-Error "import_md.ps1 が失敗しました"
    exit 1
}

# ─── Step 4: cards.json 増加確認 ─────────────────────
Write-Host ""
Write-Host "==== Step 4: cards.json delta ====" -ForegroundColor Cyan
$cardsAfter = (Get-Content -Path $cardsPath -Raw -Encoding UTF8 | ConvertFrom-Json)
$afterCount = @($cardsAfter).Count
$delta = $afterCount - $beforeCount
Write-Host ("Cards after: {0} (delta: +{1})" -f $afterCount, $delta)

if ($delta -le 0) {
    Write-Error "カード数が増えていません。"
    exit 1
}

# 新規カードの先頭 1 件を表示
$lastCard = $cardsAfter[-1]
Write-Host ""
Write-Host "Last card:" -ForegroundColor Yellow
Write-Host ("  id: {0}" -f $lastCard.id)
Write-Host ("  front: {0}" -f $lastCard.front)
$backHead = if ($lastCard.back.Length -gt 120) { $lastCard.back.Substring(0, 120) + '...' } else { $lastCard.back }
Write-Host ("  back: {0}" -f $backHead)
Write-Host ("  tags: {0}" -f (($lastCard.tags) -join ', '))
Write-Host ("  source: {0}" -f $lastCard.source)

# ─── Step 5: imported_sources.json ────────────────────
Write-Host ""
Write-Host "==== Step 5: imported_sources.json ====" -ForegroundColor Cyan
if (-not (Test-Path $importedSourcesFile)) {
    Write-Error "imported_sources.json が生成されていません"
    exit 1
}
$importedRaw = Get-Content -Path $importedSourcesFile -Raw -Encoding UTF8
$imported = $importedRaw | ConvertFrom-Json
$imported = @($imported)
Write-Host ("Total imported sources: {0}" -f $imported.Count)
foreach ($e in $imported) {
    Write-Host ("  - {0} | subject={1} | cards={2} | at={3}" -f $e.basename, $e.subject, $e.card_count, $e.imported_at)
}

Write-Host ""
Write-Host "==== Test passed ====" -ForegroundColor Green
