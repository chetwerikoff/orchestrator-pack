[CmdletBinding()]
param(
    [switch]$SkipNpm,
    [switch]$SkipPester
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Failures = New-Object System.Collections.Generic.List[string]

function Write-Track {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Detail = ''
    )
    $line = ('[{0}] {1}' -f $Status, $Name)
    if ($Detail) { $line = "$line - $Detail" }
    Write-Host $line
}

Write-Host '== orchestrator-pack test-all =='
Write-Host "Root: $Root"
Write-Host ''

if (-not $SkipNpm) {
    Write-Host '== TypeScript (Vitest) =='
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) {
        Write-Track 'npm' 'FAIL' 'not found'
        $Failures.Add('npm not found') | Out-Null
    }
    else {
        Push-Location $Root
        try {
            if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules') -PathType Container)) {
                Write-Host 'Installing npm dependencies (including dev)...'
                & npm ci --include=dev
                if ($LASTEXITCODE -ne 0) {
                    Write-Track 'npm ci' 'FAIL' "exit=$LASTEXITCODE"
                    $Failures.Add('npm ci failed') | Out-Null
                }
            }

            if ($Failures.Count -eq 0) {
                & npm test
                if ($LASTEXITCODE -ne 0) {
                    Write-Track 'vitest' 'FAIL' "exit=$LASTEXITCODE"
                    $Failures.Add('Vitest track failed') | Out-Null
                }
                else {
                    Write-Track 'vitest' 'PASS' 'completed'
                }
            }
        }
        finally {
            Pop-Location
        }
    }
    Write-Host ''
}

if (-not $SkipPester) {
    Write-Host '== PowerShell (Pester) =='
    $pesterModule = Get-Module -ListAvailable -Name Pester |
        Where-Object { $_.Version -ge [version]'5.0.0' } |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $pesterModule) {
        Write-Track 'Pester' 'FAIL' 'Pester 5+ not installed'
        $Failures.Add('Pester 5+ not found; install with: Install-Module -Name Pester -MinimumVersion 5.0.0 -Scope CurrentUser -Force') | Out-Null
    }
    else {
        Import-Module Pester -MinimumVersion 5.0.0 -ErrorAction Stop
        $pesterRoots = @(
            (Join-Path $Root 'tests/powershell'),
            (Join-Path $Root 'scripts')
        )
        $pesterFailed = 0
        $pesterPassed = 0
        foreach ($pesterRoot in $pesterRoots) {
            $result = Invoke-Pester -Path $pesterRoot -PassThru
            $pesterFailed += $result.FailedCount
            $pesterPassed += $result.PassedCount
        }
        if ($pesterFailed -gt 0) {
            Write-Track 'pester' 'FAIL' ("failed={0}" -f $pesterFailed)
            $Failures.Add('Pester track failed') | Out-Null
        }
        else {
            Write-Track 'pester' 'PASS' ("passed={0}" -f $pesterPassed)
        }
    }
    Write-Host ''
}

Write-Host '== Summary =='
if ($Failures.Count -gt 0) {
    Write-Host 'Failures:'
    foreach ($failure in $Failures) { Write-Host "- $failure" }
    exit 1
}

Write-Host 'All test tracks passed.'
exit 0
