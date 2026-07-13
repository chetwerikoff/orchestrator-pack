#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [switch]$Json,
    [switch]$SelfTest
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

# Compatibility exception: these are shared planner/type modules, not supervised
# children or PowerShell entrypoints. Existing consumers retain this stable import
# path while the PR removes the registry child, .ps1 entrypoint, lock and launch
# bindings. Any reintroduction on a binding surface still fails closed below.
$compatibilityAllowlist = @(
    'docs/review-finding-delivery-confirm.mjs',
    'docs/review-finding-delivery-confirm.d.mts'
)

function Invoke-RetirementEvaluation {
    param([Parameter(Mandatory = $true)][string]$Root)

    $failures = [System.Collections.Generic.List[object]]::new()
    function Add-Failure {
        param([string]$Surface, [string]$Marker, [string]$Reason)
        $failures.Add([pscustomobject]@{
            surface = $Surface
            marker = $Marker
            reason = $Reason
        })
    }

    $registryRel = 'scripts/orchestrator-side-process-registry.json'
    $registryPath = Join-Path $Root $registryRel
    if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
        Add-Failure -Surface $registryRel -Marker '<missing>' -Reason 'binding surface missing'
    }
    else {
        try {
            $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
            $requiredIds = @($registry.requiredChildIds | ForEach-Object { [string]$_ })
            $children = @($registry.children)
            foreach ($item in $retired) {
                if ($requiredIds -contains $item.id) {
                    Add-Failure -Surface $registryRel -Marker $item.id -Reason 'retired id present in requiredChildIds'
                }
                foreach ($child in $children) {
                    if ([string]$child.id -eq $item.id) {
                        Add-Failure -Surface $registryRel -Marker $item.id -Reason 'retired child row present'
                    }
                    if ([string]$child.script -eq $item.script) {
                        Add-Failure -Surface $registryRel -Marker $item.script -Reason 'retired entrypoint present in child row'
                    }
                    if ($item.lock -and [string]$child.sideEffectLockFile -eq $item.lock) {
                        Add-Failure -Surface $registryRel -Marker $item.lock -Reason 'retired lock name present in child row'
                    }
                }
            }
        }
        catch {
            Add-Failure -Surface $registryRel -Marker '<invalid-json>' -Reason $_.Exception.Message
        }
    }

    foreach ($rel in $bindingFiles) {
        $path = Join-Path $Root $rel
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            Add-Failure -Surface $rel -Marker '<missing>' -Reason 'binding surface missing'
            continue
        }
        $text = Get-Content -LiteralPath $path -Raw
        foreach ($item in $retired) {
            foreach ($marker in @($item.id, $item.script, $item.lock)) {
                if (-not $marker) { continue }
                if ($text.Contains([string]$marker)) {
                    Add-Failure -Surface $rel -Marker ([string]$marker) -Reason 'retired marker reintroduced'
                }
            }
        }
    }

    foreach ($item in $retired) {
        $entrypoint = Join-Path $Root (Join-Path 'scripts' $item.script)
        if (Test-Path -LiteralPath $entrypoint -PathType Leaf) {
            Add-Failure -Surface ('scripts/' + $item.script) -Marker $item.script -Reason 'retired entrypoint still exists'
        }
    }

    foreach ($rel in $compatibilityAllowlist) {
        $path = Join-Path $Root $rel
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            Add-Failure -Surface $rel -Marker '<missing>' -Reason 'declared compatibility surface missing'
        }
    }

    return [pscustomobject]@{
        schemaVersion = 1
        issue = 745
        status = $(if ($failures.Count -eq 0) { 'pass' } else { 'fail' })
        checkedSurfaces = @($registryRel) + $bindingFiles
        retiredChildIds = @($retired | ForEach-Object { $_.id })
        compatibilityAllowlist = $compatibilityAllowlist
        compatibilityJustification = 'shared planner/type modules only; no registry, entrypoint, lock, or launch binding'
        failures = @($failures)
    }
}

function Write-SelfTestFile {
    param([string]$Root, [string]$RelativePath, [string]$Content)
    $path = Join-Path $Root $RelativePath
    $parent = Split-Path -Parent $path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Set-Content -LiteralPath $path -Value $Content -Encoding utf8NoBOM
}

function New-SelfTestFixture {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ('opk-745-retirement-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $survivors = @(
        'listener',
        'review-trigger-reconcile',
        'review-trigger-reeval',
        'review-ready-report-state-seed',
        'ci-green-wake-reconcile',
        'worker-message-submit-reconcile',
        'review-start-claim-reaper',
        'ci-failure-notification-reconcile',
        'dead-worker-reconcile',
        'escalation-router'
    )
    $registry = [ordered]@{
        schemaVersion = 1
        requiredChildIds = $survivors
        children = @($survivors | ForEach-Object { [ordered]@{ id = $_; script = ($_.ToString() + '.ps1') } })
    }
    Write-SelfTestFile -Root $root -RelativePath 'scripts/orchestrator-side-process-registry.json' -Content ($registry | ConvertTo-Json -Depth 8)
    foreach ($rel in $bindingFiles) {
        $content = if ($rel.EndsWith('.json')) { '{"schemaVersion":1}' } else { '# clean fixture' }
        Write-SelfTestFile -Root $root -RelativePath $rel -Content $content
    }
    Write-SelfTestFile -Root $root -RelativePath 'docs/review-finding-delivery-confirm.mjs' -Content 'export const compatibility = true;'
    Write-SelfTestFile -Root $root -RelativePath 'docs/review-finding-delivery-confirm.d.mts' -Content 'export declare const compatibility: boolean;'
    return $root
}

function Invoke-RetirementSelfTest {
    $cases = [System.Collections.Generic.List[object]]::new()
    $cleanRoot = New-SelfTestFixture
    try {
        $clean = Invoke-RetirementEvaluation -Root $cleanRoot
        $cases.Add([pscustomobject]@{
            name = 'clean-tree'
            expected = 'pass'
            actual = $clean.status
            ok = ($clean.status -eq 'pass')
        })
    }
    finally {
        Remove-Item -LiteralPath $cleanRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    foreach ($item in $retired) {
        $registryRoot = New-SelfTestFixture
        try {
            $registryPath = Join-Path $registryRoot 'scripts/orchestrator-side-process-registry.json'
            $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
            $registry.requiredChildIds = @($registry.requiredChildIds) + @($item.id)
            $registry.children = @($registry.children) + @([pscustomobject]@{ id = $item.id; script = $item.script })
            Set-Content -LiteralPath $registryPath -Value ($registry | ConvertTo-Json -Depth 8) -Encoding utf8NoBOM
            $actual = Invoke-RetirementEvaluation -Root $registryRoot
            $cases.Add([pscustomobject]@{
                name = ($item.id + ':registry')
                expected = 'fail'
                actual = $actual.status
                ok = ($actual.status -eq 'fail')
            })
        }
        finally {
            Remove-Item -LiteralPath $registryRoot -Recurse -Force -ErrorAction SilentlyContinue
        }

        foreach ($rel in $bindingFiles) {
            $surfaceRoot = New-SelfTestFixture
            try {
                $payload = if ($rel.EndsWith('.json')) {
                    @{ marker = $item.script } | ConvertTo-Json -Compress
                }
                else {
                    '# launches ' + $item.script
                }
                Write-SelfTestFile -Root $surfaceRoot -RelativePath $rel -Content $payload
                $actual = Invoke-RetirementEvaluation -Root $surfaceRoot
                $cases.Add([pscustomobject]@{
                    name = ($item.id + ':' + $rel)
                    expected = 'fail'
                    actual = $actual.status
                    ok = ($actual.status -eq 'fail')
                })
            }
            finally {
                Remove-Item -LiteralPath $surfaceRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $failed = @($cases | Where-Object { -not $_.ok })
    return [pscustomobject]@{
        schemaVersion = 1
        issue = 745
        status = $(if ($failed.Count -eq 0) { 'pass' } else { 'fail' })
        expectedNegativeCases = ($retired.Count * (1 + $bindingFiles.Count))
        negativeCases = @($cases | Where-Object { $_.expected -eq 'fail' }).Count
        cleanCases = @($cases | Where-Object { $_.expected -eq 'pass' }).Count
        failures = $failed
    }
}

$result = if ($SelfTest) {
    Invoke-RetirementSelfTest
}
else {
    Invoke-RetirementEvaluation -Root $RepoRoot
}

if ($Json) {
    $result | ConvertTo-Json -Depth 10
}
elseif ($result.status -eq 'pass') {
    Write-Host $(if ($SelfTest) { 'vestigial fleet retirement self-test: PASS' } else { 'vestigial fleet retirement guard: PASS' })
}
else {
    Write-Host $(if ($SelfTest) { 'vestigial fleet retirement self-test: FAIL' } else { 'vestigial fleet retirement guard: FAIL' })
    foreach ($failure in @($result.failures)) {
        if ($failure.PSObject.Properties.Name -contains 'surface') {
            Write-Host ("- {0}: {1} ({2})" -f $failure.surface, $failure.marker, $failure.reason)
        }
        else {
            Write-Host ("- {0}: expected={1} actual={2}" -f $failure.name, $failure.expected, $failure.actual)
        }
    }
}

$exitCode = if ($result.status -eq 'pass') { 0 } else { 1 }
if ($env:OPK_VITEST_HARNESS -eq '1') {
    $global:LASTEXITCODE = $exitCode
    return
}
exit $exitCode
