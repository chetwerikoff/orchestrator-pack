#requires -Version 5.1
<#
.SYNOPSIS
  Coverage guard: every PowerShell-managed side-process state file has round-trip fixtures (Issue #248).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$manifestPath = Join-Path $Root 'scripts/fixtures/mechanical-json-state/state-coverage-manifest.json'
$fixtureDir = Join-Path $Root 'scripts/fixtures/mechanical-json-state'
$requiredFixtures = @(
    'corrupt-seven-key-runs.json',
    'partial-missing-sent.json',
    'unparseable-truncated.json',
    'clean-sent-populated.json',
    'clean-ci-green-maps.json',
    'clean-degraded-ci.json',
    'clean-deliveries.json',
    'clean-watch-entries.json',
    'clean-report-state-seed-maps.json',
    'clean-dead-worker-maps.json',
    'clean-escalation-maps.json'
)

$discoveryExcludeCallers = @(
    'scripts/check-side-process-state-coverage.ps1',
    'scripts/mechanical-json-state.Tests.ps1'
)

if (-not (Test-Path -LiteralPath $registryPath)) {
    Write-Host "Missing registry: $registryPath"
    exit 1
}
if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Host "Missing coverage manifest: $manifestPath"
    exit 1
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$errors = [System.Collections.Generic.List[string]]::new()

foreach ($fixture in $requiredFixtures) {
    $path = Join-Path $fixtureDir $fixture
    if (-not (Test-Path -LiteralPath $path)) {
        $errors.Add("missing fixture: $fixture")
    }
}

$fixtureBodies = @{}
foreach ($fixture in $requiredFixtures) {
    $fixtureBodies[$fixture] = Get-Content -LiteralPath (Join-Path $fixtureDir $fixture) -Raw
}

$registryIds = @($registry.requiredChildIds)
$manifestChildren = @($manifest.children)
$exemptChildIds = @($manifest.jsExempt | ForEach-Object { [string]$_.childId } | Where-Object { $_ })
foreach ($req in $registryIds) {
    $healthOnly = @('listener', 'heartbeat')
    if ($healthOnly -contains $req -or $exemptChildIds -contains $req) {
        continue
    }
    $match = $manifestChildren | Where-Object { $_.id -eq $req } | Select-Object -First 1
    if (-not $match) {
        $errors.Add("registry child missing from state coverage manifest: $req")
    }
}

$helperPattern = 'Get-MechanicalJsonStateFile'
$scriptsRoot = Join-Path $Root 'scripts'
$discoveredCallers = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
Get-ChildItem -LiteralPath $scriptsRoot -Filter '*.ps1' -Recurse |
    Where-Object { $_.FullName -notlike '*fixtures*' } |
    ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length + 1).Replace('\', '/')
        $text = Get-Content -LiteralPath $_.FullName -Raw
        if ($text -match $helperPattern -and
            $relative -ne 'scripts/lib/MechanicalReconcileNode.ps1' -and
            $discoveryExcludeCallers -notcontains $relative) {
            [void]$discoveredCallers.Add($relative)
        }
    }

$manifestCallers = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($child in $manifestChildren) {
    if (-not $child.mapFields -or @($child.mapFields).Count -eq 0) {
        $errors.Add("manifest child $($child.id) has no mapFields")
        continue
    }
    if (-not $child.callerScripts -or @($child.callerScripts).Count -eq 0) {
        $errors.Add("manifest child $($child.id) has no callerScripts")
        continue
    }

    $callerTexts = @{}
    foreach ($callerScript in @($child.callerScripts)) {
        $normalized = ($callerScript -replace '\\', '/').TrimStart('/')
        [void]$manifestCallers.Add($normalized)
        $callerPath = Join-Path $Root $normalized
        if (-not (Test-Path -LiteralPath $callerPath)) {
            $errors.Add("manifest child $($child.id) caller script not found: $normalized")
            continue
        }
        $callerTexts[$normalized] = Get-Content -LiteralPath $callerPath -Raw
    }

    foreach ($mapField in @($child.mapFields)) {
        $fieldCoveredInScript = $false
        foreach ($callerText in $callerTexts.Values) {
            if ($callerText -match [regex]::Escape([string]$mapField)) {
                $fieldCoveredInScript = $true
                break
            }
        }
        if (-not $fieldCoveredInScript) {
            $errors.Add("manifest child $($child.id) map field not referenced in caller scripts: $mapField")
        }

        $fieldCoveredInFixture = $false
        foreach ($fixtureName in $requiredFixtures) {
            if ($fixtureBodies[$fixtureName] -match [regex]::Escape([string]$mapField)) {
                $fieldCoveredInFixture = $true
                break
            }
        }
        if (-not $fieldCoveredInFixture) {
            $errors.Add("manifest child $($child.id) map field lacks fixture coverage: $mapField")
        }
    }
}

foreach ($discovered in @($discoveredCallers)) {
    if (-not $manifestCallers.Contains($discovered)) {
        $errors.Add("discovered state helper caller missing from manifest: $discovered")
    }
}

foreach ($manifestCaller in @($manifestCallers)) {
    if (-not $discoveredCallers.Contains($manifestCaller)) {
        $errors.Add("manifest caller script does not use shared state helper: $manifestCaller")
    }
}

$bespokePath = Join-Path $Root 'scripts/review-finding-delivery-confirm.ps1'
if (-not (Test-Path -LiteralPath $bespokePath)) {
    $errors.Add('missing bespoke state path: review-finding-delivery-confirm.ps1')
}
elseif ((Get-Content -LiteralPath $bespokePath -Raw) -notmatch 'Get-MechanicalJsonStateFile') {
    $errors.Add('bespoke delivery-confirm state path must adopt shared mechanical state helper')
}

if ($manifest.jsExempt.Count -lt 1) {
    $errors.Add('manifest must document JS-owned wake dedup exemption')
}

if ($errors.Count -gt 0) {
    Write-Host '[FAIL] side-process state coverage guard:'
    foreach ($err in $errors) { Write-Host "- $err" }
    Write-Host "discovered callers: $($discoveredCallers -join ', ')"
    Write-Host "manifest callers: $($manifestCallers -join ', ')"
    exit 1
}

Write-Host '[PASS] side-process state coverage manifest and fixtures (Issue #248)'
exit 0
