#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$InstallDependencies,
    [switch]$StrictPrereqs,
    [switch]$TestBackedSmoke,
    [string]$TargetRepo
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$VerifyScript = Join-Path $PSScriptRoot 'verify.ps1'

Write-Host '== orchestrator-pack bootstrap =='
Write-Host "Root: $Root"
Write-Host 'This helper does not read or print secrets.'
Write-Host 'It does not start a runtime, mutate user configuration, or create state.'
Write-Host ''

if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
    throw 'PowerShell 7+ is required.'
}

$verifyArgs = @('-NoProfile', '-File', $VerifyScript)
if ($StrictPrereqs) { $verifyArgs += '-StrictPrereqs' }
if ($TestBackedSmoke) { $verifyArgs += '-TestBackedSmoke' }
& pwsh @verifyArgs
if ($LASTEXITCODE -ne 0) {
    throw "verify.ps1 exited with code $LASTEXITCODE"
}

if ($InstallDependencies) {
    Write-Host ''
    Write-Host '== Frozen workspace dependencies =='
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js 22.x is required before dependency installation.'
    }
    $nodeVersion = ((& node --version 2>&1 | Out-String).Trim())
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') {
        throw "Node.js 22.x is required; detected $nodeVersion"
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm is required before dependency installation.'
    }
    Push-Location $Root
    try {
        & npm ci --include=dev
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with code $LASTEXITCODE"
        }
        & npm run check:node-major --silent
        if ($LASTEXITCODE -ne 0) {
            throw "Node major check failed with code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
    Write-Host '[PASS] frozen workspace dependencies installed.'
}
else {
    Write-Host ''
    Write-Host 'Dependency installation was not requested.'
    Write-Host 'Run with -InstallDependencies to execute npm ci --include=dev.'
}

Write-Host ''
Write-Host '== Runtime-neutral next step =='
if ($TargetRepo) {
    Write-Host "Target repository: $TargetRepo"
    Write-Host 'Resolve the exact registered adapter and composite identity before effects.'
}
else {
    Write-Host 'No target repository was supplied; no target-side action was attempted.'
}
Write-Host 'Use scripts/runtime/runtime-cli.ts and the registered RuntimeAdapter for runtime operations.'
Write-Host '[PASS] bootstrap completed without host-runtime mutation.'
