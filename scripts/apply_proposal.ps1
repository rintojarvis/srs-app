[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ProposalPath,

    [Parameter(Mandatory = $false)]
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'

# ─── パス解決 ─────────────────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$appRoot   = Resolve-Path (Join-Path $scriptDir '..')
$cardsPath = Join-Path $appRoot 'cards.json'
$proposalsDir = Join-Path $appRoot 'proposals'
$backupDir = Join-Path $appRoot 'backups'

if (-not (Test-Path $cardsPath)) {
    Write-Error "cards.json が見つかりません: $cardsPath"
    exit 1
}

# ProposalPath 未指定なら proposals/ の最新 MD を自動選択
if (-not $ProposalPath) {
    if (-not (Test-Path $proposalsDir)) {
        Write-Error "proposals/ ディレクトリが見つかりません: $proposalsDir"
        exit 1
    }
    $latest = Get-ChildItem -Path $proposalsDir -Filter '*.md' |
              Where-Object { $_.Name -notlike '*.applied.md' } |
              Sort-Object LastWriteTime -Descending |
              Select-Object -First 1
    if (-not $latest) {
        Write-Error "proposals/ に MD ファイルが見つかりません"
        exit 1
    }
    $ProposalPath = $latest.FullName
    Write-Host "Auto-selected latest proposal: $($latest.Name)"
}

if (-not (Test-Path $ProposalPath)) {
    Write-Error "Proposal MD が見つかりません: $ProposalPath"
    exit 1
}

# ─── MD 読み込み ──────────────────────────────────────
$mdText = Get-Content -Path $ProposalPath -Raw -Encoding UTF8
if (-not $mdText -or $mdText.Trim().Length -eq 0) {
    Write-Host "Proposal MD が空です。適用候補なし。"
    exit 0
}

# ─── パース ───────────────────────────────────────────
# セクションごとに分割。改行が崩れた haiku 生成物にも耐えるよう、最初に行ごとに ## を発見しても、
# 1 行にまとまっている場合は ## をデリミタとして再分割する。

function Split-Sections {
    param([string]$text)

    $sections = @{}
    $sectionNames = @(
        '削除候補',
        '分割候補',
        '書き換え候補',
        '深掘り（関連カード追加）',
        '深掘り',
        '演習フィードバックへの対応'
    )

    # 既知の見出し名にマッチする位置を全て見つける（## の有無を問わず）
    # haiku 生成物では改行が潰れているため、行頭 ## だけで判定しない
    $hits = New-Object System.Collections.ArrayList
    foreach ($sn in $sectionNames) {
        $pattern = '##\s*' + [regex]::Escape($sn)
        foreach ($m in [regex]::Matches($text, $pattern)) {
            [void]$hits.Add([pscustomobject]@{
                Name  = $sn
                Index = $m.Index
                Len   = $m.Length
            })
        }
    }

    if ($hits.Count -eq 0) { return $sections }

    # 開始位置でソート
    $sorted = $hits | Sort-Object Index
    # 同一位置に複数マッチした場合（「深掘り」と「深掘り（関連カード追加）」など）は長い方を優先
    $deduped = New-Object System.Collections.ArrayList
    $lastIdx = -1
    foreach ($h in $sorted) {
        if ($h.Index -eq $lastIdx) {
            # 直前を長い方に置換
            $prev = $deduped[$deduped.Count - 1]
            if ($h.Len -gt $prev.Len) {
                $deduped[$deduped.Count - 1] = $h
            }
        } else {
            [void]$deduped.Add($h)
            $lastIdx = $h.Index
        }
    }

    for ($i = 0; $i -lt $deduped.Count; $i++) {
        $h = $deduped[$i]
        $start = $h.Index + $h.Len
        $end = if ($i + 1 -lt $deduped.Count) { $deduped[$i + 1].Index } else { $text.Length }
        $body = $text.Substring($start, $end - $start)
        # 先頭の余分な改行/空白だけ削除
        $body = $body -replace '^[\r\n]+', ''
        $sections[$h.Name] = $body
    }

    return $sections
}

$sections = Split-Sections -text $mdText

# セクション本文が「該当なし」なら空扱い
function IsEmptySection {
    param([string]$content)
    if (-not $content) { return $true }
    $t = $content.Trim()
    if ($t.Length -eq 0) { return $true }
    if ($t -match '^該当なし\s*$') { return $true }
    return $false
}

# 候補リスト
$candidates = @()

# ── 削除候補 ──
$delSection = $sections['削除候補']
if (-not (IsEmptySection $delSection)) {
    # "- card_XXX: 理由" の行を拾う
    foreach ($m in [regex]::Matches($delSection, '-\s*(card_\d+)\s*[:：]\s*([^\r\n-]*?)(?=\s*-\s*card_|\s*$)')) {
        $candidates += [pscustomobject]@{
            type   = 'delete'
            cardId = $m.Groups[1].Value
            reason = $m.Groups[2].Value.Trim()
        }
    }
    # 単純パターンも試す（行単位）
    if ($candidates.Where({ $_.type -eq 'delete' }).Count -eq 0) {
        foreach ($line in $delSection -split "[\r\n]+") {
            if ($line -match '-\s*(card_\d+)\s*[:：]\s*(.+)$') {
                $candidates += [pscustomobject]@{
                    type   = 'delete'
                    cardId = $Matches[1]
                    reason = $Matches[2].Trim()
                }
            }
        }
    }
}

# ── 分割候補 ──
$splitSection = $sections['分割候補']
if (-not (IsEmptySection $splitSection)) {
    # "card_XXX → 2枚に分割案" を境に分割
    $parts = [regex]::Split($splitSection, '-\s*(card_\d+)\s*→')
    # parts[0] = 先頭ゴミ, parts[1]=cardId, parts[2]=ブロック, parts[3]=cardId, ...
    for ($i = 1; $i -lt $parts.Count; $i += 2) {
        if ($i + 1 -ge $parts.Count) { break }
        $cid = $parts[$i].Trim()
        $blk = $parts[$i + 1]

        # 新カード A / B を抽出
        $newCards = @()
        # "新カード [A-Z]:" のサブブロックを取る
        $subParts = [regex]::Split($blk, '新カード\s*[A-Z]\s*[:：]')
        # subParts[0] = ヘッダ, subParts[1+] = 各新カードブロック
        for ($j = 1; $j -lt $subParts.Count; $j++) {
            $sb = $subParts[$j]
            $front = $null; $back = $null; $tags = @()
            if ($sb -match 'front\s*[:：]\s*([^\r\n]+?)(?=\s*-\s*back|\s*back\s*[:：]|\s*$)') {
                $front = $Matches[1].Trim()
            }
            if ($sb -match 'back\s*[:：]\s*([^\r\n]+?)(?=\s*-\s*tags|\s*tags\s*[:：]|\s*-\s*新カード|\s*$)') {
                $back = $Matches[1].Trim()
            }
            if ($sb -match 'tags\s*[:：]\s*([^\r\n]+?)(?=\s*-\s*新カード|\s*##|\s*$)') {
                $tagStr = $Matches[1].Trim()
                $tags = $tagStr -split '[,、]' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
            }
            if ($front -and $back) {
                $newCards += [pscustomobject]@{ front = $front; back = $back; tags = @($tags) }
            }
        }

        if ($newCards.Count -ge 2) {
            $candidates += [pscustomobject]@{
                type     = 'split'
                cardId   = $cid
                newCards = $newCards
            }
        } else {
            Write-Warning ("分割候補 {0}: 新カードを 2 枚抽出できず（{1} 枚）。スキップ" -f $cid, $newCards.Count)
        }
    }
}

# ── 書き換え候補 ──
$rewriteSection = $sections['書き換え候補']
if (-not (IsEmptySection $rewriteSection)) {
    # "- card_XXX:" を境に分割
    $parts = [regex]::Split($rewriteSection, '-\s*(card_\d+)\s*[:：]')
    for ($i = 1; $i -lt $parts.Count; $i += 2) {
        if ($i + 1 -ge $parts.Count) { break }
        $cid = $parts[$i].Trim()
        $blk = $parts[$i + 1]

        # 旧 / 新 / 理由 を抽出。各セクションは次の「- 新/- 理由/- card_/末尾」までを取る
        $oldText = $null; $newText = $null; $reason = $null
        if ($blk -match '旧\s*[:：]\s*(.+?)(?=\s*-\s*新\s*[:：]|\s*新\s*[:：])') {
            $oldText = $Matches[1].Trim()
        }
        if ($blk -match '新\s*[:：]\s*(.+?)(?=\s*-\s*理由|\s*理由\s*[:：]|\s*-\s*card_|\s*##|$)') {
            $newText = $Matches[1].Trim()
        }
        if ($blk -match '理由\s*[:：]?\s*(.+?)(?=\s*-\s*card_|\s*##|$)') {
            $reason = $Matches[1].Trim()
        }

        if ($newText) {
            $candidates += [pscustomobject]@{
                type    = 'rewrite'
                cardId  = $cid
                oldText = $oldText
                newText = $newText
                reason  = $reason
            }
        } else {
            Write-Warning ("書き換え候補 {0}: 新本文を抽出できず。スキップ" -f $cid)
        }
    }
}

# ── 深掘り（関連カード追加） ──
$deepSection = $sections['深掘り（関連カード追加）']
if (-not $deepSection) { $deepSection = $sections['深掘り'] }
if (-not (IsEmptySection $deepSection)) {
    # "- 元カード: card_XXX" を境に分割
    $parts = [regex]::Split($deepSection, '-\s*元カード\s*[:：]\s*(card_\d+)')
    for ($i = 1; $i -lt $parts.Count; $i += 2) {
        if ($i + 1 -ge $parts.Count) { break }
        $baseCid = $parts[$i].Trim()
        $blk = $parts[$i + 1]

        # 新規カード案: の後の front / back / tags を抽出
        $front = $null; $back = $null; $tags = @()
        if ($blk -match 'front\s*[:：]\s*([^\r\n]+?)(?=\s*-\s*back|\s*back\s*[:：])') {
            $front = $Matches[1].Trim()
        }
        if ($blk -match 'back\s*[:：]\s*([^\r\n]+?)(?=\s*-\s*tags|\s*tags\s*[:：]|\s*-\s*元カード|\s*##|$)') {
            $back = $Matches[1].Trim()
        }
        if ($blk -match 'tags\s*[:：]\s*([^\r\n]+?)(?=\s*-\s*元カード|\s*##|$)') {
            $tagStr = $Matches[1].Trim()
            # 角括弧を除去
            $tagStr = $tagStr -replace '^\[', '' -replace '\]$', ''
            $tags = $tagStr -split '[,、]' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        }

        if ($front -and $back) {
            $candidates += [pscustomobject]@{
                type        = 'deepdive'
                baseCardId  = $baseCid
                front       = $front
                back        = $back
                tags        = @($tags)
            }
        } else {
            Write-Warning ("深掘り (元: {0}): front/back を抽出できず。スキップ" -f $baseCid)
        }
    }
}

# ── 演習フィードバックへの対応 ──
$mistakeSection = $sections['演習フィードバックへの対応']
if (-not (IsEmptySection $mistakeSection)) {
    # "- mistake_XXX (本文): 既存カード ヒット数 N" を境に分割
    $parts = [regex]::Split($mistakeSection, '-\s*(mistake_[\w]+)')
    for ($i = 1; $i -lt $parts.Count; $i += 2) {
        if ($i + 1 -ge $parts.Count) { break }
        $mid = $parts[$i].Trim()
        $blk = $parts[$i + 1]

        # 「ヒットあり」「ヒットなし」「新規カード案」のどちらか
        $hasNew = $false
        $front = $null; $back = $null; $tags = @()

        if ($blk -match 'ヒットあり') {
            # 既存カードに移行のみ、新規カードなし。記録だけ。
            $candidates += [pscustomobject]@{
                type      = 'mistake_hit'
                mistakeId = $mid
                note      = ($blk.Trim() -replace '\s+', ' ').Substring(0, [Math]::Min(200, ($blk.Trim() -replace '\s+', ' ').Length))
            }
            continue
        }

        if ($blk -match 'front\s*[:：]\s*([^\r\n]+?)(?=\s*-\s*back|\s*back\s*[:：])') {
            $front = $Matches[1].Trim(); $hasNew = $true
        }
        if ($blk -match 'back\s*[:：]\s*([^\r\n]+?)(?=\s*-\s*tags|\s*tags\s*[:：]|\s*-\s*mistake_|\s*##|$)') {
            $back = $Matches[1].Trim()
        }
        if ($blk -match 'tags\s*[:：]\s*([^\r\n]+?)(?=\s*-\s*mistake_|\s*##|$)') {
            $tagStr = $Matches[1].Trim()
            $tagStr = $tagStr -replace '^\[', '' -replace '\]$', ''
            $tags = $tagStr -split '[,、]' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        }

        if ($hasNew -and $front -and $back) {
            $candidates += [pscustomobject]@{
                type      = 'mistake_new'
                mistakeId = $mid
                front     = $front
                back      = $back
                tags      = @($tags)
            }
        } else {
            Write-Warning ("演習フィードバック {0}: 新規カードを抽出できず（ヒットあり/なし判定も曖昧）。スキップ" -f $mid)
        }
    }
}

# ─── 候補ゼロなら正常終了 ─────────────────────────────
if ($candidates.Count -eq 0) {
    Write-Host ""
    Write-Host "適用候補なし（パース結果が空、または MD 構造が崩れています）。cards.json は変更しません。"
    exit 0
}

Write-Host ""
Write-Host ("パース完了: {0} 件の候補を抽出しました。" -f $candidates.Count)
Write-Host ""

# ─── cards.json 読み込み ─────────────────────────────
$existingCards = Get-Content -Path $cardsPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $existingCards) { $existingCards = @() }
$existingCards = @($existingCards)
$cardsBefore = $existingCards.Count

# id → index マップ
function Get-CardIndex {
    param($cards, [string]$id)
    for ($i = 0; $i -lt $cards.Count; $i++) {
        if ($cards[$i].id -eq $id) { return $i }
    }
    return -1
}

# 最大 ID
$maxNum = 0
foreach ($c in $existingCards) {
    if ($c.id -match 'card_(\d+)') {
        $n = [int]$Matches[1]
        if ($n -gt $maxNum) { $maxNum = $n }
    }
}

function New-CardObject {
    param(
        [string]$id,
        [string]$front,
        [string]$back,
        [string[]]$tags,
        [string]$source
    )
    return [pscustomobject][ordered]@{
        id            = $id
        front         = $front
        back          = $back
        tags          = @($tags)
        source        = $source
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
}

# ─── バックアップを先に取る ───────────────────────────
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupPath = Join-Path $backupDir ("cards.json.bak.{0}" -f $ts)
Copy-Item -Path $cardsPath -Destination $backupPath -Force
Write-Host ("Backup: {0}" -f $backupPath)
Write-Host ""

# ─── 1 件ずつ確認 → 適用 ─────────────────────────────
$logEntries = @()
$appliedCount = 0
$skippedCount = 0
$abortRest = $false

# 一旦リスト化（削除や追加でループ中の整合性が崩れないように）
$cards = New-Object System.Collections.ArrayList
foreach ($c in $existingCards) { [void]$cards.Add($c) }

for ($i = 0; $i -lt $candidates.Count; $i++) {
    $cand = $candidates[$i]
    $idx = $i + 1
    $total = $candidates.Count

    Write-Host ("─── [{0}/{1}] type={2} ───" -f $idx, $total, $cand.type)

    # サマリ表示
    switch ($cand.type) {
        'delete' {
            $ci = Get-CardIndex -cards $cards -id $cand.cardId
            if ($ci -lt 0) {
                Write-Warning ("  対象カード {0} が cards.json にありません。スキップ" -f $cand.cardId)
                $logEntries += [pscustomobject]@{ status = 'skipped'; reason = 'target not found'; cand = $cand }
                $skippedCount++
                continue
            }
            Write-Host ("  削除対象: {0}" -f $cand.cardId)
            Write-Host ("    front: {0}" -f (($cards[$ci].front -replace "`n", ' ').Substring(0, [Math]::Min(80, $cards[$ci].front.Length))))
            Write-Host ("    理由: {0}" -f $cand.reason)
        }
        'split' {
            Write-Host ("  分割対象: {0} → {1} 枚の新カード" -f $cand.cardId, $cand.newCards.Count)
            foreach ($nc in $cand.newCards) {
                Write-Host ("    front: {0}" -f (($nc.front -replace "`n", ' ').Substring(0, [Math]::Min(80, $nc.front.Length))))
            }
        }
        'rewrite' {
            Write-Host ("  書き換え対象: {0}" -f $cand.cardId)
            $newPreview = ($cand.newText -replace "`n", ' ').Substring(0, [Math]::Min(120, $cand.newText.Length))
            Write-Host ("    新本文 (先頭120字): {0}" -f $newPreview)
            if ($cand.reason) { Write-Host ("    理由: {0}" -f $cand.reason) }
        }
        'deepdive' {
            Write-Host ("  深掘り (元: {0}) → 新規カード追加" -f $cand.baseCardId)
            Write-Host ("    front: {0}" -f (($cand.front -replace "`n", ' ').Substring(0, [Math]::Min(80, $cand.front.Length))))
        }
        'mistake_hit' {
            Write-Host ("  演習フィードバック {0}: 既存カードヒット（記録のみ・新規追加なし）" -f $cand.mistakeId)
        }
        'mistake_new' {
            Write-Host ("  演習フィードバック {0}: 新規カード追加" -f $cand.mistakeId)
            Write-Host ("    front: {0}" -f (($cand.front -replace "`n", ' ').Substring(0, [Math]::Min(80, $cand.front.Length))))
        }
    }

    # 確認
    $answer = 'y'
    if (-not $Yes) {
        $resp = Read-Host "適用しますか? (y/n/q)"
        $answer = $resp.Trim().ToLower()
        if ($answer -eq '') { $answer = 'n' }
    }

    if ($answer -eq 'q') {
        Write-Host "  → 残り全てスキップして終了します。"
        $abortRest = $true
        # 残り全部 skip ログ
        for ($j = $i; $j -lt $candidates.Count; $j++) {
            $logEntries += [pscustomobject]@{ status = 'skipped'; reason = 'user quit'; cand = $candidates[$j] }
            $skippedCount++
        }
        break
    }
    if ($answer -ne 'y') {
        Write-Host "  → スキップ"
        $logEntries += [pscustomobject]@{ status = 'skipped'; reason = 'user said no'; cand = $cand }
        $skippedCount++
        continue
    }

    # 適用
    try {
        switch ($cand.type) {
            'delete' {
                $ci = Get-CardIndex -cards $cards -id $cand.cardId
                if ($ci -ge 0) {
                    $cards.RemoveAt($ci)
                    Write-Host ("  ✓ 削除: {0}" -f $cand.cardId)
                    $logEntries += [pscustomobject]@{ status = 'applied'; action = 'delete'; cand = $cand }
                    $appliedCount++
                } else {
                    Write-Warning ("  対象カードが見つからずスキップ: {0}" -f $cand.cardId)
                    $logEntries += [pscustomobject]@{ status = 'skipped'; reason = 'target gone'; cand = $cand }
                    $skippedCount++
                }
            }
            'split' {
                $ci = Get-CardIndex -cards $cards -id $cand.cardId
                $srcRef = $null
                if ($ci -ge 0) {
                    $srcRef = $cards[$ci].source
                    $cards.RemoveAt($ci)
                } else {
                    Write-Warning ("  分割元 {0} が見つからず、新カードのみ追加します" -f $cand.cardId)
                }
                $newIds = @()
                foreach ($nc in $cand.newCards) {
                    $maxNum++
                    $newId = ('card_{0:D3}' -f $maxNum)
                    $newCard = New-CardObject -id $newId -front $nc.front -back $nc.back -tags $nc.tags -source $srcRef
                    [void]$cards.Add($newCard)
                    $newIds += $newId
                }
                Write-Host ("  ✓ 分割: {0} → {1}" -f $cand.cardId, ($newIds -join ', '))
                $logEntries += [pscustomobject]@{ status = 'applied'; action = 'split'; cand = $cand; newIds = $newIds }
                $appliedCount++
            }
            'rewrite' {
                $ci = Get-CardIndex -cards $cards -id $cand.cardId
                if ($ci -lt 0) {
                    Write-Warning ("  対象カード {0} が見つかりません。スキップ" -f $cand.cardId)
                    $logEntries += [pscustomobject]@{ status = 'skipped'; reason = 'target not found'; cand = $cand }
                    $skippedCount++
                } else {
                    # newText に「front / back」が両方含まれていれば分離。なければ back のみ書き換え。
                    $newFront = $null; $newBack = $null
                    if ($cand.newText -match '^(?<f>.+?)\s*/\s*(?<b>.+)$') {
                        $newFront = $Matches['f'].Trim()
                        $newBack  = $Matches['b'].Trim()
                    } else {
                        $newBack = $cand.newText
                    }
                    if ($newFront) { $cards[$ci].front = $newFront }
                    if ($newBack)  { $cards[$ci].back  = $newBack }
                    Write-Host ("  ✓ 書き換え: {0}" -f $cand.cardId)
                    $logEntries += [pscustomobject]@{ status = 'applied'; action = 'rewrite'; cand = $cand }
                    $appliedCount++
                }
            }
            'deepdive' {
                $srcRef = $null
                $ci = Get-CardIndex -cards $cards -id $cand.baseCardId
                if ($ci -ge 0) { $srcRef = $cards[$ci].source }
                $maxNum++
                $newId = ('card_{0:D3}' -f $maxNum)
                $newCard = New-CardObject -id $newId -front $cand.front -back $cand.back -tags $cand.tags -source $srcRef
                [void]$cards.Add($newCard)
                Write-Host ("  ✓ 深掘り追加: {0} (元: {1})" -f $newId, $cand.baseCardId)
                $logEntries += [pscustomobject]@{ status = 'applied'; action = 'deepdive'; cand = $cand; newId = $newId }
                $appliedCount++
            }
            'mistake_hit' {
                # 新規追加なし。記録のみ。
                Write-Host ("  ✓ 記録のみ（ヒット既存カードの優先キュー化は別スクリプト管轄）")
                $logEntries += [pscustomobject]@{ status = 'applied'; action = 'mistake_hit_recorded'; cand = $cand }
                $appliedCount++
            }
            'mistake_new' {
                $maxNum++
                $newId = ('card_{0:D3}' -f $maxNum)
                $newCard = New-CardObject -id $newId -front $cand.front -back $cand.back -tags $cand.tags -source $null
                [void]$cards.Add($newCard)
                Write-Host ("  ✓ 演習新規追加: {0} (mistake: {1})" -f $newId, $cand.mistakeId)
                $logEntries += [pscustomobject]@{ status = 'applied'; action = 'mistake_new'; cand = $cand; newId = $newId }
                $appliedCount++
            }
        }
    } catch {
        Write-Warning ("  ✗ 適用エラー: {0}" -f $_.Exception.Message)
        $logEntries += [pscustomobject]@{ status = 'error'; reason = $_.Exception.Message; cand = $cand }
        $skippedCount++
    }
}

# ─── cards.json 書き込み ─────────────────────────────
$cardsAfter = $cards.Count
if ($appliedCount -gt 0) {
    @($cards.ToArray()) | ConvertTo-Json -Depth 12 -AsArray | Out-File -FilePath $cardsPath -Encoding UTF8
    Write-Host ""
    Write-Host ("cards.json 更新: {0} 枚 → {1} 枚" -f $cardsBefore, $cardsAfter)
} else {
    Write-Host ""
    Write-Host "適用 0 件。cards.json は変更していません。"
}

# ─── applied.md 生成 ─────────────────────────────────
$proposalBasename = [System.IO.Path]::GetFileNameWithoutExtension($ProposalPath)
$appliedMdPath = Join-Path $proposalsDir ("{0}.applied.md" -f $proposalBasename)

$applSb = New-Object System.Text.StringBuilder
[void]$applSb.AppendLine(("# SRS 進化提案 適用ログ - {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')))
[void]$applSb.AppendLine("")
[void]$applSb.AppendLine(("- 元 proposal: {0}" -f (Split-Path -Leaf $ProposalPath)))
[void]$applSb.AppendLine(("- 候補総数: {0}" -f $candidates.Count))
[void]$applSb.AppendLine(("- 適用: {0} 件 / スキップ: {1} 件" -f $appliedCount, $skippedCount))
[void]$applSb.AppendLine(("- カード枚数: {0} → {1}" -f $cardsBefore, $cardsAfter))
[void]$applSb.AppendLine(("- バックアップ: {0}" -f (Split-Path -Leaf $backupPath)))
[void]$applSb.AppendLine("")
[void]$applSb.AppendLine("## 詳細ログ")
[void]$applSb.AppendLine("")
foreach ($le in $logEntries) {
    $cand = $le.cand
    $tag = ''
    switch ($cand.type) {
        'delete'      { $tag = "削除 {0}" -f $cand.cardId }
        'split'       { $tag = "分割 {0}" -f $cand.cardId }
        'rewrite'     { $tag = "書き換え {0}" -f $cand.cardId }
        'deepdive'    { $tag = "深掘り (元 {0})" -f $cand.baseCardId }
        'mistake_hit' { $tag = "演習 {0} (ヒット既存)" -f $cand.mistakeId }
        'mistake_new' { $tag = "演習 {0} (新規)" -f $cand.mistakeId }
    }
    if ($le.status -eq 'applied') {
        $line = "- ✓ {0} を適用しました" -f $tag
        if ($le.newId)  { $line += "（新ID: {0}）" -f $le.newId }
        if ($le.newIds) { $line += "（新IDs: {0}）" -f ($le.newIds -join ', ') }
    } elseif ($le.status -eq 'skipped') {
        $line = "- ○ {0} はスキップ（{1}）" -f $tag, $le.reason
    } else {
        $line = "- ✗ {0} はエラー（{1}）" -f $tag, $le.reason
    }
    [void]$applSb.AppendLine($line)
}

$applSb.ToString() | Out-File -FilePath $appliedMdPath -Encoding UTF8

# ─── サマリ表示 ──────────────────────────────────────
Write-Host ""
Write-Host "─────────────────────────────────────────────"
Write-Host ("{0} 件適用、{1} 件スキップ、合計カード数 {2} 枚（前は {3} 枚）" -f $appliedCount, $skippedCount, $cardsAfter, $cardsBefore)
Write-Host ("Applied log: {0}" -f $appliedMdPath)
Write-Host "─────────────────────────────────────────────"
