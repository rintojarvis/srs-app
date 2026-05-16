[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$Date,

    [Parameter(Mandatory = $false)]
    [string]$Model = 'claude-haiku-4-5-20251001',

    [Parameter(Mandatory = $false)]
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'

# ─── パス解決 ─────────────────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$appRoot   = Resolve-Path (Join-Path $scriptDir '..')

if (-not $OutFile) {
    $OutFile = Join-Path $appRoot 'today.json'
}

# ─── 日付処理 ─────────────────────────────────────────
if (-not $Date) {
    $Date = (Get-Date).ToString('yyyy-MM-dd')
}

if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
    Write-Error "Date は yyyy-MM-dd 形式で指定してください: $Date"
    exit 1
}

# Asia/Tokyo (UTC+09:00) で 00:00:00 〜 23:59:59 を組み立て
$start = "{0}T00:00:00+09:00" -f $Date
$end   = "{0}T23:59:59+09:00" -f $Date

Write-Host ("Fetching Google Calendar events for {0} (Asia/Tokyo)..." -f $Date)

# ─── プロンプト構築 ───────────────────────────────────
$systemPrompt = @'
あなたは Google カレンダー MCP ツールを呼び出して、指定された日付の予定を JSON で返す純粋なデータ取得器として動作する。出力は以下のルールに厳密に従う:

- 出力は純粋な JSON オブジェクトのみ。コードフェンス（```json 等）禁止。前置きナレーション禁止。末尾コメント禁止。
- 出力は { "date": string, "events": [...], "updated_at": string } の形式を持つオブジェクト。
- 自己チェック・タイトル更新・Master Jarvis・Worker・Coordinator・Jarvis・AI システム関連語を一切含めない。
- 「確認しますか？」「実行します」等のナレーションは一切含めない。
- MCP ツール呼び出し後、結果から必要なフィールドだけを抽出して JSON で返す。
'@

$userPrompt = @"
Google カレンダー MCP ツール (mcp__claude_ai_Google_Calendar__list_events) を使って、$Date (Asia/Tokyo) の予定を取得してください。
list_events を timeMin=$start timeMax=$end timeZone=Asia/Tokyo で呼び出してください。

結果を以下の JSON 形式だけで返してください（コードフェンス・前置き・後置き禁止、純粋な JSON のみ）:

{
  "date": "$Date",
  "events": [
    { "summary": "...", "start": "ISO datetime or date", "end": "ISO datetime or date", "location": "..." }
  ],
  "updated_at": "<実行時刻 ISO>"
}

ルール:
- 終日予定は start/end に date のみ（例: "2026-05-16"）を入れて構いません。時刻指定予定は ISO datetime（例: "2026-05-16T10:00:00+09:00"）を入れてください。
- location が無ければ "" を入れてください。summary が無ければ "(無題)" を入れてください。
- イベント 0 件なら events: [] を返してください。
- updated_at は今この瞬間の ISO 8601 時刻（タイムゾーン付き）を入れてください。
- 出力は JSON オブジェクト 1 個のみ。それ以外のテキスト一切禁止。
"@

# ─── claude -p 呼び出し ───────────────────────────────
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
# コードフェンスが混入した場合に備えて除去
$cleaned = $rawOut
$cleaned = [regex]::Replace($cleaned, '^```(?:json)?\s*', '', [System.Text.RegularExpressions.RegexOptions]::Multiline)
$cleaned = [regex]::Replace($cleaned, '```\s*$', '', [System.Text.RegularExpressions.RegexOptions]::Multiline)

# 最初の { から最後の } までを抽出（前後ナレーション保険）
$first = $cleaned.IndexOf('{')
$last  = $cleaned.LastIndexOf('}')
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

if (-not $parsed) {
    Write-Error "パース結果が空でした。today.json は更新しません。"
    exit 1
}

# ─── バリデーション + 正規化 ──────────────────────────
$eventsOut = @()
$eventsRaw = if ($parsed.PSObject.Properties['events']) { @($parsed.events) } else { @() }
foreach ($e in $eventsRaw) {
    if (-not $e) { continue }
    $summary  = if ($e.PSObject.Properties['summary']  -and $e.summary)  { [string]$e.summary  } else { '(無題)' }
    $evStart  = if ($e.PSObject.Properties['start']    -and $e.start)    { [string]$e.start    } else { '' }
    $evEnd    = if ($e.PSObject.Properties['end']      -and $e.end)      { [string]$e.end      } else { '' }
    $location = if ($e.PSObject.Properties['location'] -and $e.location) { [string]$e.location } else { '' }

    $eventsOut += [pscustomobject][ordered]@{
        summary  = $summary
        start    = $evStart
        end      = $evEnd
        location = $location
    }
}

$updatedAt = (Get-Date).ToString('o')

$output = [ordered]@{
    date       = $Date
    events     = @($eventsOut)
    updated_at = $updatedAt
}

# ─── 出力 ─────────────────────────────────────────────
@($output) | ForEach-Object { $_ } | ConvertTo-Json -Depth 6 | Out-File -FilePath $OutFile -Encoding UTF8

Write-Host ""
Write-Host ("今日の予定 {0} 件を today.json に保存しました" -f $eventsOut.Count)
