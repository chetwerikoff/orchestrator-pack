[CmdletBinding()]
param(
    [switch]$SkipNpm,
    [int]$VitestShard = 0,
    [int]$VitestShardCount = 0
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Failures = New-Object System.Collections.Generic.List[string]
$RuntimeReportPath = Join-Path $Root '.vitest-runtime-report.json'

. (Join-Path $PSScriptRoot 'lib/Write-PackCheckLine.ps1')
function Write-Track {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Detail = ''
    )
    Write-PackCheckLine -Name $Name -Status $Status -Detail $Detail
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
                if (Test-Path -LiteralPath $RuntimeReportPath) {
                    Remove-Item -LiteralPath $RuntimeReportPath -Force
                }
                if ($VitestShard -gt 0 -and $VitestShardCount -gt 0) {
                    & npm test -- --shard="$VitestShard/$VitestShardCount" --reporter=default --reporter=json --outputFile=$RuntimeReportPath
                }
                else {
                    & npm test -- --reporter=default --reporter=json --outputFile=$RuntimeReportPath
                }
                if ($LASTEXITCODE -ne 0) {
                    Write-Track 'vitest' 'FAIL' "exit=$LASTEXITCODE"
                    $Failures.Add('Vitest track failed') | Out-Null
                }
                else {
                    Write-Track 'vitest' 'PASS' 'completed'
                    if (-not (Test-Path -LiteralPath $RuntimeReportPath)) {
                        Write-Track 'vitest-runtime-budget' 'FAIL' 'missing JSON report'
                        $Failures.Add('Vitest runtime report missing after successful run') | Out-Null
                    }
                    else {
                        & node (Join-Path $Root 'scripts/enforce-vitest-runtime-budget.mjs') $RuntimeReportPath
                        if ($LASTEXITCODE -ne 0) {
                            Write-Track 'vitest-runtime-budget' 'FAIL' "exit=$LASTEXITCODE"
                            $Failures.Add('Vitest runtime budget guard failed (Issue #488)') | Out-Null
                        }
                        else {
                            Write-Track 'vitest-runtime-budget' 'PASS' 'within budget'
                        }
                    }
                }
            }
        }
        finally {
            Pop-Location
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
