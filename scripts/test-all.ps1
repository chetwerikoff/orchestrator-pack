[CmdletBinding()]
param(
    [switch]$SkipNpm,
    [switch]$SkipPester,
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

        # #1248 r12: keep tests/** untouched while no longer discovering suites bound
        # exclusively to the intentionally deleted PowerShell owner-chain runtime.
        $retiredPesterSuitePaths = @(
            (Join-Path $Root 'tests/powershell/Issue748.RefreshConcurrency.Tests.ps1')
            (Join-Path $Root 'tests/powershell/Issue748.UnknownSnapshotExpiry.Tests.ps1')
            (Join-Path $Root 'tests/powershell/Issue748.WorkerStatusPopulation.Tests.ps1')
            (Join-Path $Root 'scripts/review-trigger-reconcile-worker-selected.Tests.ps1')
            (Join-Path $Root 'scripts/review-trigger-reconcile-worker-status.Tests.ps1')
            (Join-Path $Root 'scripts/review-trigger-reconcile.Tests.ps1')
            (Join-Path $Root 'scripts/worker-ci-failed-reconcile.Tests.ps1')
            (Join-Path $Root 'scripts/worker-depletion-reconcile.Tests.ps1')
            (Join-Path $Root 'scripts/worker-depletion-reconcile.json-fallback.Tests.ps1')
            (Join-Path $Root 'scripts/worker-report-stale-reconcile.Tests.ps1')
        )
        $pesterRoots = @(
            (Join-Path $Root 'tests/powershell')
            (Join-Path $Root 'scripts')
        )
        $pesterPaths = @(
            Get-ChildItem -Path $pesterRoots -Filter '*.Tests.ps1' -File -Recurse |
                Where-Object { $_.FullName -notin $retiredPesterSuitePaths } |
                Sort-Object FullName |
                Select-Object -ExpandProperty FullName
        )

        # #1248 r13: exclude only the exact legacy scriptblocks that require
        # intentionally deleted PowerShell owner-chain files. Sibling tests run.
        $legacyPesterBlockLines = @(
            "$(Join-Path $Root 'scripts/ci-red-watchdog-lookup-retention.Tests.ps1'):62"
            "$(Join-Path $Root 'scripts/ci-red-watchdog-lookup-retention.Tests.ps1'):81"
            "$(Join-Path $Root 'scripts/lib/Ci-Red-Watchdog.Tests.ps1'):8"
            "$(Join-Path $Root 'scripts/mechanical-json-state.Tests.ps1'):297"
            "$(Join-Path $Root 'scripts/mechanical-json-state.Tests.ps1'):319"
            "$(Join-Path $Root 'scripts/mechanical-json-state.Tests.ps1'):421"
            "$(Join-Path $Root 'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1'):374"
            "$(Join-Path $Root 'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1'):414"
        )
        $pesterConfig = New-PesterConfiguration
        $pesterConfig.Run.Path = $pesterPaths
        $pesterConfig.Run.PassThru = $true
        $pesterConfig.Filter.ExcludeLine = $legacyPesterBlockLines

        $result = Invoke-Pester -Configuration $pesterConfig
        $pesterFailed = $result.FailedCount
        $pesterPassed = $result.PassedCount
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
