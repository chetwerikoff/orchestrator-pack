[CmdletBinding()]
param(
    [switch]$InstallAO,
    [string]$TargetRepo,
    [switch]$StrictPrereqs
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$VerifyScript = Join-Path $PSScriptRoot 'verify.ps1'

Write-Host '== orchestrator-pack bootstrap =='
Write-Host "Root: $Root"
Write-Host 'This helper does not read or print secrets.'
Write-Host 'It does not run ao start automatically.'
Write-Host ''

$verifyArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $VerifyScript)
if ($StrictPrereqs) { $verifyArgs += '-StrictPrereqs' }

if (Get-Command pwsh -ErrorAction SilentlyContinue) {
    & pwsh @verifyArgs
}
else {
    & powershell.exe @verifyArgs
}
$verifyExit = $LASTEXITCODE
if ($verifyExit -ne 0) {
    Write-Host ''
    Write-Host "verify.ps1 exited with code $verifyExit. Fix failures above before using this pack."
    exit $verifyExit
}

Write-Host ''
Write-Host '== AO CLI install =='
if ($InstallAO) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host 'npm not found; cannot install @aoagents/ao.'
        exit 1
    }

    Write-Host 'Installing AO CLI with npm, without sudo/admin escalation:'
    Write-Host 'npm install -g @aoagents/ao'
    & npm install -g '@aoagents/ao'
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'npm install failed. If this is a permissions issue, configure a user-owned npm prefix and retry.'
        exit $LASTEXITCODE
    }

    if (Get-Command ao -ErrorAction SilentlyContinue) {
        & ao --version
    }
}
else {
    Write-Host 'AO CLI install was not requested.'
    Write-Host 'Recommended command:'
    Write-Host '  npm install -g @aoagents/ao'
    if (Get-Command ao -ErrorAction SilentlyContinue) {
        Write-Host 'Existing AO CLI detected:'
        & ao --version
    }
    else {
        Write-Host 'AO CLI not currently found on PATH.'
    }
}

Write-Host ''
Write-Host '== AO start safety =='
if ($TargetRepo) {
    Write-Host 'Explicit target repo argument received. Not starting AO automatically.'
    Write-Host 'Review agent-orchestrator.yaml first, then run:'
    Write-Host ('  ao start "{0}"' -f $TargetRepo)
}
else {
    Write-Host 'No -TargetRepo supplied. This script will not run AO against a real repository.'
    Write-Host 'When ready, run one of:'
    Write-Host '  ao start C:\Users\che\Documents\Projects\your-target-repo'
    Write-Host '  ao start https://github.com/your-org/your-repo'
}
