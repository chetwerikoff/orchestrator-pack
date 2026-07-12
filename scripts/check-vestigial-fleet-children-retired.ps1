#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}
else {
    $RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
}

$retired = @(
    @{ id = 'review-run-recovery'; script = 'review-run-recovery.ps1'; lock = 'review-run-recovery-side-effect.lock' },
    @{ id = 'review-stuck-run-reaper'; script = 'review-stuck-run-reaper.ps1'; lock = 'review-stuck-run-reaper-side-effect.lock' },
    @{ id = 'review-finding-delivery-confirm'; script = 'review-finding-delivery-confirm.ps1'; lock = 'delivery-confirm-side-effect.lock' },
    @{ id = 'ci-failure-notification-reaction'; script = 'ci-failure-notification-reaction.ps1'; lock = $null }
)

$bindingFiles = @(
    'scripts/orchestrator-wake-supervisor.ps1',
    'scripts/launch-argv-inventory.json',
    'scripts/orchestrator-escalation-emitter-inventory.json',
    'scripts/orchestrator-message-audit-roots.manifest.json',
    'scripts/orchestrator-message-protected-runtime.manifest.json',
    'scripts/orchestrator-message-send-helpers.manifest.json',
    'scripts/fixtures/mechanical-json-state/state-coverage-manifest.json',
    'docs/review-pipeline-spawn-budget.mjs',
    'docs/review-pipeline-spawn-budget-attribution.mjs'
)

$failures = [System.Collections.Generic.List[object]]::new()
function Add-RetirementFailure {
    param([string]$Surface, [string]$Marker, [string]$Reason)
    $failures.Add([pscustomobject]@{
        surface = $Surface
        marker = $Marker
        reason = $Reason
    })
}

$registryRel = 'scripts/orchestrator-side-process-registry.json'
$registryPath = Join-Path $RepoRoot $registryRel
if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
    Add-RetirementFailure -Surface $registryRel -Marker '<missing>' -Reason 'binding surface missing'
}
else {
    try {
        $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
        $requiredIds = @($registry.requiredChildIds | ForEach-Object { [string]$_ })
        $children = @($registry.children)
        foreach ($item in $retired) {
            if ($requiredIds -contains $item.id) {
                Add-RetirementFailure -Surface $registryRel -Marker $item.id -Reason 'retired id present in requiredChildIds'
            }
            foreach ($child in $children) {
                if ([string]$child.id -eq $item.id) {
                    Add-RetirementFailure -Surface $registryRel -Marker $item.id -Reason 'retired child row present'
                }
                if ([string]$child.script -eq $item.script) {
                    Add-RetirementFailure -Surface $registryRel -Marker $item.script -Reason 'retired entrypoint present in child row'
                }
                if ($item.lock -and [string]$child.sideEffectLockFile -eq $item.lock) {
                    Add-RetirementFailure -Surface $registryRel -Marker $item.lock -Reason 'retired lock name present in child row'
                }
            }
        }
    }
    catch {
        Add-RetirementFailure -Surface $registryRel -Marker '<invalid-json>' -Reason $_.Exception.Message
    }
}

foreach ($rel in $bindingFiles) {
    $path = Join-Path $RepoRoot $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Add-RetirementFailure -Surface $rel -Marker '<missing>' -Reason 'binding surface missing'
        continue
    }
    $text = Get-Content -LiteralPath $path -Raw
    foreach ($item in $retired) {
        foreach ($marker in @($item.id, $item.script, $item.lock)) {
            if (-not $marker) { continue }
            if ($text.Contains([string]$marker)) {
                Add-RetirementFailure -Surface $rel -Marker ([string]$marker) -Reason 'retired marker reintroduced'
            }
        }
    }
}

foreach ($item in $retired) {
    $entrypoint = Join-Path $RepoRoot (Join-Path 'scripts' $item.script)
    if (Test-Path -LiteralPath $entrypoint -PathType Leaf) {
        Add-RetirementFailure -Surface ('scripts/' + $item.script) -Marker $item.script -Reason 'retired entrypoint still exists'
    }
}

$result = [pscustomobject]@{
    schemaVersion = 1
    issue = 745
    status = $(if ($failures.Count -eq 0) { 'pass' } else { 'fail' })
    checkedSurfaces = @($registryRel) + $bindingFiles
    retiredChildIds = @($retired | ForEach-Object { $_.id })
    failures = @($failures)
}

if ($Json) {
    $result | ConvertTo-Json -Depth 8
}
elseif ($failures.Count -eq 0) {
    Write-Host 'vestigial fleet retirement guard: PASS'
}
else {
    Write-Host 'vestigial fleet retirement guard: FAIL'
    foreach ($failure in $failures) {
        Write-Host ("- {0}: {1} ({2})" -f $failure.surface, $failure.marker, $failure.reason)
    }
}

if ($failures.Count -gt 0) { exit 1 }
exit 0
