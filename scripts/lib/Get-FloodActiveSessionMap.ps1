#requires -Version 5.1
<#
.SYNOPSIS
  Shared terminal flood detection helpers for mechanical reconcilers.
#>

function Invoke-FloodDetectCli {
    param(
        [array]$Events,
        [long]$NowMs,
        [string]$DetectCli = ''
    )

    if (-not $DetectCli) {
        $packRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        $DetectCli = Join-Path $packRoot 'docs/terminal-flood-detect.mjs'
    }

    $json = @{
        events = @($Events)
        nowMs  = $NowMs
    } | ConvertTo-Json -Depth 30 -Compress
    $output = $json | & node $DetectCli detect 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "terminal-flood-detect.mjs detect exited ${LASTEXITCODE}: $output"
    }
    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    return $text | ConvertFrom-Json
}

function Get-FloodActiveSessionMap {
    param(
        [array]$Events,
        [long]$NowMs,
        [string]$DetectCli = ''
    )

    $map = @{}
    if (-not $Events -or $Events.Count -eq 0) {
        return $map
    }
    $result = Invoke-FloodDetectCli -Events $Events -NowMs $NowMs -DetectCli $DetectCli
    foreach ($row in @($result.flaggedSessions)) {
        if ($row.sessionId) {
            $map[[string]$row.sessionId] = $true
        }
    }
    return $map
}
