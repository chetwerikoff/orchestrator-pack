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
    'clean-sent-populated.json'
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

$registryIds = @($registry.requiredChildIds)
$manifestChildren = @($manifest.children)
foreach ($req in $registryIds) {
    $healthOnly = @('listener', 'heartbeat')
    if ($healthOnly -contains $req) {
        continue
    }
    $match = $manifestChildren | Where-Object { $_.id -eq $req } | Select-Object -First 1
    if (-not $match) {
        $errors.Add("registry child missing from state coverage manifest: $req")
    }
}

foreach ($child in $manifestChildren) {
    if (-not $child.mapFields -or @($child.mapFields).Count -eq 0) {
        $errors.Add("manifest child $($child.id) has no mapFields")
    }
}

$helperPattern = 'Get-MechanicalJsonStateFile'
$scripts = Get-ChildItem -LiteralPath (Join-Path $Root 'scripts') -Filter '*.ps1' -Recurse |
    Where-Object { $_.FullName -notlike '*fixtures*' }
$helperCallers = @($scripts | Where-Object {
        (Get-Content -LiteralPath $_.FullName -Raw) -match $helperPattern
    } | ForEach-Object { $_.FullName.Replace("$Root/", '').Replace('\', '/') })

$bespokePath = Join-Path $Root 'scripts/review-finding-delivery-confirm.ps1'
if (-not (Test-Path -LiteralPath $bespokePath)) {
    $errors.Add('missing bespoke state path: review-finding-delivery-confirm.ps1')
}
else {
    $bespokeText = Get-Content -LiteralPath $bespokePath -Raw
    if ($bespokeText -notmatch 'Get-MechanicalJsonStateFile') {
        $errors.Add('bespoke delivery-confirm state path must adopt shared mechanical state helper')
    }
}

if ($manifest.jsExempt.Count -lt 1) {
    $errors.Add('manifest must document JS-owned wake dedup exemption')
}

if ($errors.Count -gt 0) {
    Write-Host '[FAIL] side-process state coverage guard:'
    foreach ($err in $errors) { Write-Host "- $err" }
    Write-Host "helper callers discovered: $($helperCallers -join ', ')"
    exit 1
}

Write-Host '[PASS] side-process state coverage manifest and fixtures (Issue #248)'
exit 0
