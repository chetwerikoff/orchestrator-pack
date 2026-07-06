#requires -Version 7.0
<#
.SYNOPSIS
  Project-scoped orchestrator discovery guard (Issue #619 AC#6).
#>
[CmdletBinding()]
param(
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')

$CapturesDir = Join-Path $Root 'tests/external-output-references/captures/ao-0-10-cli'
$orchPayload = Get-Content -LiteralPath (Join-Path $CapturesDir 'orchestrator-ls.raw.json') -Raw | ConvertFrom-Json
$workerPayload = Get-Content -LiteralPath (Join-Path $CapturesDir 'session-ls.raw.json') -Raw | ConvertFrom-Json

$resolved = Resolve-AoOrchestratorSessionId -Project 'orchestrator-pack' -OrchestratorListPayload $orchPayload
if (-not $resolved -or $resolved.Id -ne 'orchestrator-pack-5') {
    throw "expected live orchestrator-pack-5 for orchestrator-pack; got $($resolved.Id)"
}

$foreignOnly = [pscustomobject]@{
    data = @(
        [pscustomobject]@{
            id           = 'foreign-orch'
            projectId    = 'other-project'
            role         = 'orchestrator'
            status       = 'idle'
            isTerminated = $false
        }
    )
}
$foreignResolved = Resolve-AoOrchestratorSessionId -Project 'orchestrator-pack' -OrchestratorListPayload $foreignOnly
if ($foreignResolved) {
    throw 'foreign orchestrator row must not be selected for orchestrator-pack'
}

$missingProject = [pscustomobject]@{
    data = @(
        [pscustomobject]@{
            id           = 'missing-project'
            role         = 'orchestrator'
            status       = 'idle'
            isTerminated = $false
        }
    )
}
$missingResolved = Resolve-AoOrchestratorSessionId -Project 'orchestrator-pack' -OrchestratorListPayload $missingProject
if ($missingResolved) {
    throw 'orchestrator row with missing projectId must not be selected'
}

$merged = Get-AoStatusSessions -Project 'orchestrator-pack' -WorkerListPayload $workerPayload -OrchestratorListPayload $orchPayload
if (@($merged | Where-Object { $_.projectId -eq 'other-project' }).Count -gt 0) {
    throw 'merged sessions must exclude foreign projectId rows'
}

if ($SelfTest) {
    $badPayload = [pscustomobject]@{
        data = @(
            [pscustomobject]@{
                id           = 'orchestrator-pack-5'
                projectId    = 'other-project'
                role         = 'orchestrator'
                status       = 'idle'
                isTerminated = $false
            }
        )
    }
    $bad = Resolve-AoOrchestratorSessionId -Project 'orchestrator-pack' -OrchestratorListPayload $badPayload
    if ($bad) {
        Write-Host '[PASS] self-test: foreign orchestrator excluded'
        exit 0
    }
    throw 'self-test: expected null for foreign orchestrator under project filter'
}

Write-Host '[PASS] AO session adapter project filter (Issue #619)'
exit 0
