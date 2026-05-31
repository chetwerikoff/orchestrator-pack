#Requires -Version 5.1
# Static checks for reviewer-agnostic entrypoint and PACK_REVIEWER selector (Issue #86).
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$entrypoint = Join-Path $Root 'scripts/invoke-pack-review.ps1'
$example = Join-Path $Root 'agent-orchestrator.yaml.example'

if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    Write-Host '[FAIL] scripts/invoke-pack-review.ps1 not found'
    exit 1
}

if (-not (Test-Path -LiteralPath $example -PathType Leaf)) {
    Write-Host '[FAIL] agent-orchestrator.yaml.example not found'
    exit 1
}

. (Join-Path $Root 'scripts/lib/Get-PackReviewCommand.ps1')

$command = Get-PackReviewCommandFromYaml -YamlPath $example
if (-not $command) {
    Write-Host '[FAIL] NAMED REVIEW_COMMAND not found in agent-orchestrator.yaml.example'
    exit 1
}

$basename = Get-ReviewScriptBasenameFromCommand -ReviewCommand $command
if ($basename -ne 'invoke-pack-review.ps1') {
    Write-Host "[FAIL] REVIEW_COMMAND must use reviewer-agnostic invoke-pack-review.ps1 (got $basename)"
    exit 1
}

if ($command -match 'run-pack-review-claude\.ps1' -or $command -match 'run-pack-review\.ps1' -or $command -match '\.ao/') {
    Write-Host '[FAIL] REVIEW_COMMAND must not name per-reviewer wrappers or .ao/ paths'
    Write-Host "  REVIEW_COMMAND: $command"
    exit 1
}

$yamlText = Get-Content -LiteralPath $example -Raw
if ($yamlText -notmatch 'PACK_REVIEWER') {
    Write-Host '[FAIL] example orchestratorRules must document PACK_REVIEWER selector'
    exit 1
}

$savedProcess = $env:PACK_REVIEWER
try {
    $env:PACK_REVIEWER = 'not-a-reviewer'
    & $entrypoint --repo-root $Root --base origin/main 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host '[FAIL] invoke-pack-review.ps1 must fail closed for unrecognized PACK_REVIEWER'
        exit 1
    }
}
finally {
    if ($null -eq $savedProcess) {
        Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue
    }
    else {
        $env:PACK_REVIEWER = $savedProcess
    }
}

Write-Host '[PASS] reviewer-agnostic entrypoint and PACK_REVIEWER fail-closed checks'
exit 0
