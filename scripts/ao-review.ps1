#requires -Version 5.1
<#
.SYNOPSIS
  Anti-corruption shim mapping legacy ao review argv to AO 0.10 HTTP primitives (Issue #623).

.DESCRIPTION
  run <session>  -> POST /api/v1/sessions/{id}/reviews/trigger
  list <session> -> GET  /api/v1/sessions/{id}/reviews
  send           -> REMOVED (non-zero)
  execute        -> REMOVED (non-zero)
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Subcommand = '',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @(),
    [switch]$Json,
    [string]$FixtureTriggerPath = '',
    [string]$FixtureListPath = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/Invoke-AoReviewApi.ps1')

function Write-AoReviewShimJson {
    param($Value)
    $Value | ConvertTo-Json -Depth 20 -Compress | Write-Output
}

function Write-AoReviewRemoved {
    param([string]$Name)
    Write-Error "ao-review ${Name}: REMOVED on AO 0.10 — delivery is automatic on submit; no external execute hook"
    exit 2
}

$sub = $Subcommand.Trim().ToLowerInvariant()
switch ($sub) {
    'run' {
        $sessionId = ($Rest | Where-Object { $_ -and -not $_.StartsWith('-') } | Select-Object -First 1)
        if (-not $sessionId) {
            Write-Error 'Usage: ao-review run <worker-session-id>'
            exit 2
        }
        $fixture = $null
        if ($FixtureTriggerPath) {
            $fixture = Get-Content -LiteralPath $FixtureTriggerPath -Raw | ConvertFrom-Json
        }
        $result = Invoke-AoReviewTriggerForWorker -SessionId $sessionId -FixturePayload $fixture
        if (-not $result.ok) {
            if ($result.httpStatus -eq 422) { exit 22 }
            exit 1
        }
        if ($Json) { Write-AoReviewShimJson $result; exit 0 }
        Write-Output "review trigger ok session=$sessionId http=$($result.httpStatus) reused=$($result.reused)"
        exit 0
    }
    'list' {
        $sessionId = ($Rest | Where-Object { $_ -and -not $_.StartsWith('-') } | Select-Object -First 1)
        if (-not $sessionId) {
            Write-Error 'Usage: ao-review list <worker-session-id> [--json]'
            exit 2
        }
        $fixture = $null
        if ($FixtureListPath) {
            $fixture = Get-Content -LiteralPath $FixtureListPath -Raw | ConvertFrom-Json
        }
        $payload = Get-AoSessionReviewsJson -SessionId $sessionId -FixturePayload $fixture
        if ($Json) { Write-AoReviewShimJson $payload; exit 0 }
        $runs = ConvertTo-AoReviewRunsFromSessionReviews -Payload $payload -LinkedSessionId $sessionId
        Write-AoReviewShimJson @{ runs = @($runs) }
        exit 0
    }
    'send' { Write-AoReviewRemoved 'send' }
    'execute' { Write-AoReviewRemoved 'execute' }
    default {
        Write-Error @'
Usage:
  ao-review run <worker-session-id> [--json]
  ao-review list <worker-session-id> [--json]
  ao-review send   (REMOVED on AO 0.10)
  ao-review execute (REMOVED on AO 0.10)
'@
        exit 2
    }
}
