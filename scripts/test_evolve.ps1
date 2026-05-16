[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$Model = "claude-opus-4-7"
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$appRoot   = Resolve-Path (Join-Path $scriptDir '..')
$cardsPath = Join-Path $appRoot 'cards.json'
$testState = Join-Path $appRoot 'state.test.json'

Write-Host "[test] Building sample state.json from cards.json..."
$cards = Get-Content -Path $cardsPath -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not $cards -or $cards.Count -lt 2) {
    Write-Error "cards.json に十分なカードがありません。"
    exit 1
}

# 先頭 2 枚に偽の review_history を付与
$now = (Get-Date).ToString('o')
$cards[0] | Add-Member -NotePropertyName review_history -NotePropertyValue @(
    [pscustomobject]@{
        at = $now
        rating = 'Hard'
        card_review = 'もっと深掘り'
        comment = '判例の射程まで聞きたい'
    }
) -Force

$cards[1] | Add-Member -NotePropertyName review_history -NotePropertyValue @(
    [pscustomobject]@{
        at = $now
        rating = 'Again'
        card_review = '分割すべき'
        comment = '定義と趣旨で 2 枚に分けたい'
    }
) -Force

$mistakes = @(
    [pscustomobject]@{
        id  = 'mistake_test_001'
        at  = $now
        text = 'パブリック・フォーラム論を答案で薄くしか書けなかった'
        tags = @('憲法', '表現の自由')
        source = $null
        hit_card_ids = @('card_026', 'card_027')
        status = 'open'
    }
)

$state = [pscustomobject]@{
    cards = $cards
    mistakes = $mistakes
    meta = [pscustomobject]@{
        created_at = $now
        last_updated = $now
        schema_version = 1
    }
}

$state | ConvertTo-Json -Depth 12 | Out-File -FilePath $testState -Encoding UTF8

Write-Host "[test] state.test.json written: $testState"
Write-Host "[test] Invoking evolve.ps1..."

$evolve = Join-Path $scriptDir 'evolve.ps1'
& pwsh -File $evolve -StateFile $testState -Model $Model

if ($LASTEXITCODE -ne 0) {
    Write-Error "evolve.ps1 が失敗しました (exit code: $LASTEXITCODE)"
    exit 1
}

# 最新の proposal を読み込んで冒頭 50 行を表示
$proposalsDir = Join-Path $appRoot 'proposals'
$latest = Get-ChildItem -Path $proposalsDir -Filter '*.md' | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $latest) {
    Write-Error "proposals/*.md が見つかりません。"
    exit 1
}

Write-Host ""
Write-Host "========== Proposal head (first 50 lines) =========="
Get-Content -Path $latest.FullName -Encoding UTF8 -TotalCount 50
Write-Host "========== end =========="
Write-Host ""
Write-Host "[test] Generated: $($latest.FullName)"
