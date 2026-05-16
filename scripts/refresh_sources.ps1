[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$Root = "C:\Users\rinto\マイドライブ\1 学習院大学法科大学院",

    [Parameter(Mandatory = $false)]
    [int]$Days = 14,

    [Parameter(Mandatory = $false)]
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$appRoot   = Resolve-Path (Join-Path $scriptDir '..')

if (-not $OutFile) {
    $OutFile = Join-Path $appRoot 'sources.json'
}

$importedSourcesFile = Join-Path $appRoot 'imported_sources.json'

if (-not (Test-Path $Root)) {
    Write-Error "Root が見つかりません: $Root"
    exit 1
}

# ─── 既存の imported_sources.json を読み込む ─────────────
$importedEntries = @()
if (Test-Path $importedSourcesFile) {
    try {
        $raw = Get-Content -Path $importedSourcesFile -Raw -Encoding UTF8
        if ($raw -and $raw.Trim().Length -gt 0) {
            $loaded = $raw | ConvertFrom-Json
            if ($loaded) { $importedEntries = @($loaded) }
        }
    } catch {
        Write-Warning ("imported_sources.json のパース失敗: {0}" -f $_.Exception.Message)
    }
}

# path → entry の辞書
$importedByPath = @{}
foreach ($e in $importedEntries) {
    if ($e.path) { $importedByPath[$e.path] = $e }
}

# ─── 科目推定 ─────────────────────────────────────────
# 9 科目: 憲法 / 民法 / 刑法 / 商法 / 民事訴訟法 / 刑事訴訟法 / 行政法 / 倒産法 / 法学入門
function Guess-Subject {
    param([string]$Path)
    $segments = $Path -split '[\\/]'
    foreach ($seg in $segments) {
        if ($seg -match '憲法') { return '憲法' }
        if ($seg -match '民法' -and $seg -notmatch '民事') { return '民法' }
        if ($seg -match '民事訴訟') { return '民事訴訟法' }
        if ($seg -match '刑法' -and $seg -notmatch '刑事') { return '刑法' }
        if ($seg -match '刑事訴訟') { return '刑事訴訟法' }
        if ($seg -match '行政法') { return '行政法' }
        if ($seg -match '商法|会社法') { return '商法' }
        if ($seg -match '倒産|破産|民事再生') { return '倒産法' }
        if ($seg -match '法学入門演習') { return '法学入門' }
        if ($seg -match '法学入門講義|法学入門') { return '法学入門' }
    }
    return ''
}

# ─── スキャン ─────────────────────────────────────────
Write-Host ("Scanning: {0}" -f $Root)
$cutoff = (Get-Date).AddDays(-$Days)

$exclude = '(_backup|archive|_temp)'

$files = Get-ChildItem -Path $Root -Recurse -Filter '*.md' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $cutoff -and $_.FullName -notmatch $exclude }

$entries = @()
foreach ($f in $files) {
    $entry = [ordered]@{
        path          = $f.FullName
        basename      = $f.Name
        subject_guess = Guess-Subject -Path $f.FullName
        last_modified = $f.LastWriteTime.ToString('o')
        size_kb       = [math]::Round($f.Length / 1KB, 1)
        imported      = $false
    }

    if ($importedByPath.ContainsKey($f.FullName)) {
        $prior = $importedByPath[$f.FullName]
        # last_modified が一致するなら imported
        if ($prior.last_modified -eq $entry.last_modified) {
            $entry.imported = $true
        }
    }

    $entries += [pscustomobject]$entry
}

$entries = $entries | Sort-Object { [datetime]$_.last_modified } -Descending

@($entries) | ConvertTo-Json -Depth 6 -AsArray | Out-File -FilePath $OutFile -Encoding UTF8

$unimported = ($entries | Where-Object { -not $_.imported }).Count
Write-Host ("{0} 件のソース候補、未取込 {1} 件 -> {2}" -f $entries.Count, $unimported, $OutFile)
