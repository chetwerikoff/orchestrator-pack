#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$StrictPrereqs,
    [switch]$TestBackedSmoke
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Failures = [System.Collections.Generic.List[string]]::new()
$Warnings = [System.Collections.Generic.List[string]]::new()

. (Join-Path $PSScriptRoot 'lib/Get-VersionFromText.ps1')
. (Join-Path $PSScriptRoot 'lib/Write-PackCheckLine.ps1')

function Write-Check {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('PASS', 'WARN', 'FAIL')][string]$Status,
        [string]$Detail = ''
    )
    Write-PackCheckLine -Name $Name -Status $Status -Detail $Detail
}

function Add-Failure {
    param([Parameter(Mandatory)][string]$Message)
    $Failures.Add($Message) | Out-Null
}

function Add-Warning {
    param([Parameter(Mandatory)][string]$Message)
    $Warnings.Add($Message) | Out-Null
}

function Test-RequiredPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [ValidateSet('Leaf', 'Container')][string]$PathType = 'Leaf'
    )
    $absolute = Join-Path $Root $Path
    if (Test-Path -LiteralPath $absolute -PathType $PathType) {
        Write-Check -Name $Path -Status 'PASS' -Detail 'present'
        return $true
    }
    Write-Check -Name $Path -Status 'FAIL' -Detail 'missing'
    Add-Failure "Missing required path: $Path"
    return $false
}

function Test-AbsentPath {
    param([Parameter(Mandatory)][string]$Path)
    $absolute = Join-Path $Root $Path
    if (Test-Path -LiteralPath $absolute) {
        Write-Check -Name $Path -Status 'FAIL' -Detail 'must be absent'
        Add-Failure "Retired path remains active: $Path"
        return $false
    }
    Write-Check -Name $Path -Status 'PASS' -Detail 'absent'
    return $true
}

function Invoke-RepositoryCheck {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Path,
        [string[]]$Arguments = @(),
        [switch]$Optional
    )
    $absolute = Join-Path $Root $Path
    if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) {
        if ($Optional) {
            Write-Check -Name $Name -Status 'WARN' -Detail "missing optional check: $Path"
            Add-Warning "Missing optional check: $Path"
            return
        }
        Write-Check -Name $Name -Status 'FAIL' -Detail "missing: $Path"
        Add-Failure "Missing required check: $Path"
        return
    }

    & pwsh -NoProfile -File $absolute @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        Write-Check -Name $Name -Status 'PASS' -Detail 'completed'
    }
    else {
        Write-Check -Name $Name -Status 'FAIL' -Detail "exit=$exitCode"
        Add-Failure "$Name failed with exit $exitCode"
    }
}

function Get-Node22 {
    $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) {
        $message = 'Node.js is not available'
        if ($StrictPrereqs) {
            Write-Check -Name 'node' -Status 'FAIL' -Detail $message
            Add-Failure $message
        }
        else {
            Write-Check -Name 'node' -Status 'WARN' -Detail $message
            Add-Warning $message
        }
        return $null
    }

    $text = ((& $command.Source '--version' 2>&1 | Out-String).Trim())
    if ($LASTEXITCODE -ne 0) {
        Write-Check -Name 'node' -Status 'FAIL' -Detail "version command failed: $text"
        Add-Failure 'Unable to read Node.js version'
        return $null
    }
    $version = Get-VersionFromText $text
    if (-not $version -or $version.Major -ne 22) {
        $message = "Node.js 22.x is required; detected $text"
        if ($StrictPrereqs) {
            Write-Check -Name 'node' -Status 'FAIL' -Detail $message
            Add-Failure $message
        }
        else {
            Write-Check -Name 'node' -Status 'WARN' -Detail $message
            Add-Warning $message
        }
        return $null
    }
    Write-Check -Name 'node' -Status 'PASS' -Detail $text
    return $command.Source
}

function Test-PluginIdentity {
    param(
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][string]$PackageName,
        [Parameter(Mandatory)][string]$CommandName
    )
    $packagePath = Join-Path $Root "plugins/$Directory/package.json"
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        Write-Check -Name "plugin/$Directory" -Status 'FAIL' -Detail 'package.json missing'
        Add-Failure "Missing plugin package: $Directory"
        return
    }
    try {
        $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Write-Check -Name "plugin/$Directory" -Status 'FAIL' -Detail 'malformed package.json'
        Add-Failure "Malformed package manifest: $Directory"
        return
    }

    $nameMatches = [string]$package.name -eq $PackageName
    $binNames = @($package.bin.PSObject.Properties.Name)
    $commandMatches = $binNames -contains $CommandName
    if ($nameMatches -and $commandMatches) {
        Write-Check -Name "plugin/$Directory" -Status 'PASS' -Detail "$PackageName / $CommandName"
        return
    }
    Write-Check -Name "plugin/$Directory" -Status 'FAIL' -Detail "name=$($package.name); bins=$($binNames -join ',')"
    Add-Failure "Plugin identity mismatch: $Directory"
}

Write-Host '== orchestrator-pack verify =='
Write-Host "Root: $Root"
Write-Host ''

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Check -Name 'pwsh' -Status 'FAIL' -Detail "PowerShell 7+ required; detected $($PSVersionTable.PSVersion)"
    exit 1
}
Write-Check -Name 'pwsh' -Status 'PASS' -Detail ([string]$PSVersionTable.PSVersion)

$node = Get-Node22

Write-Host ''
Write-Host '== Required runtime-neutral surfaces =='
$requiredFiles = @(
    'AGENTS.md',
    'README.md',
    'package.json',
    'package-lock.json',
    '.claude/skills/change-orchestrator-runtime/SKILL.md',
    '.cursor/skills/change-orchestrator-runtime/SKILL.md',
    'scripts/runtime/contracts.ts',
    'scripts/runtime/registry.ts',
    'scripts/runtime/runtime-cli.ts',
    'scripts/lib/operator-publication.ts',
    'scripts/lib/worker-degraded-ci-handoff.ts',
    'scripts/pack-review-runner.ts',
    'scripts/pack-worker-report.ps1',
    'scripts/runtime-retirement/retired-surface-guard.ts',
    'scripts/runtime-retirement/retired-surface-selftest.ts',
    'scripts/json-producers/retired-runtime-surfaces.json',
    'scripts/check-reusable.ps1'
)
foreach ($path in $requiredFiles) { [void](Test-RequiredPath -Path $path) }

foreach ($directory in @(
    'plugins/task-declaration',
    'plugins/scope-guard',
    'plugins/token-chain-ledger',
    'plugins/codex-pr-reviewer',
    'prompts',
    '.github/workflows'
)) {
    [void](Test-RequiredPath -Path $directory -PathType Container)
}

Test-PluginIdentity -Directory 'task-declaration' -PackageName '@orchestrator-pack/task-declaration' -CommandName 'pack-declare'
Test-PluginIdentity -Directory 'scope-guard' -PackageName '@orchestrator-pack/scope-guard' -CommandName 'scope-check'
Test-PluginIdentity -Directory 'token-chain-ledger' -PackageName '@orchestrator-pack/token-chain-ledger' -CommandName 'pack-ledger'
Test-PluginIdentity -Directory 'codex-pr-reviewer' -PackageName '@orchestrator-pack/codex-pr-reviewer' -CommandName 'pack-codex-review'

Write-Host ''
Write-Host '== Removed configuration surfaces =='
$retiredConfig = ('agent' + '-orchestrator.yaml.example')
[void](Test-AbsentPath -Path $retiredConfig)

Write-Host ''
Write-Host '== Static repository checks =='
Invoke-RepositoryCheck -Name 'review delivery stdout guard' -Path 'scripts/check-review-delivery-no-visibility-poll.ps1'
Invoke-RepositoryCheck -Name 'strict review fixtures' -Path 'scripts/invoke-pack-review-strict-gate.ps1'
Invoke-RepositoryCheck -Name 'GitHub inventory guard' -Path 'scripts/check-gh-inventory-static.ps1'

if ($node) {
    Write-Host ''
    Write-Host '== Node 22 static checks =='
    $nodeChecks = @(
        @{ Name = 'runtime retirement scan'; Path = 'scripts/runtime-retirement/retired-surface-selftest.ts'; Args = @('--experimental-strip-types') },
        @{ Name = 'gate runner'; Path = 'scripts/gate-runner/runner.ts'; Args = @('--experimental-strip-types') }
    )
    Push-Location $Root
    try {
        foreach ($check in $nodeChecks) {
            $scriptPath = Join-Path $Root $check.Path
            $nodeArgs = @($check.Args) + @($scriptPath, '--repo-root', $Root)
            & $node @nodeArgs
            $exitCode = $LASTEXITCODE
            if ($exitCode -eq 0) {
                Write-Check -Name $check.Name -Status 'PASS' -Detail 'completed'
            }
            else {
                Write-Check -Name $check.Name -Status 'FAIL' -Detail "exit=$exitCode"
                Add-Failure "$($check.Name) failed with exit $exitCode"
            }
        }
    }
    finally {
        Pop-Location
    }
}

if ($TestBackedSmoke) {
    Write-Host ''
    Write-Host '== Optional test-backed smoke =='
    $smoke = Join-Path $Root 'scripts/invoke-verify-test-backed-smoke.ps1'
    if (-not (Test-Path -LiteralPath $smoke -PathType Leaf)) {
        Write-Check -Name 'test-backed smoke' -Status 'FAIL' -Detail 'helper missing'
        Add-Failure 'Missing scripts/invoke-verify-test-backed-smoke.ps1'
    }
    else {
        & pwsh -NoProfile -File $smoke
        if ($LASTEXITCODE -eq 0) {
            Write-Check -Name 'test-backed smoke' -Status 'PASS' -Detail 'completed'
        }
        else {
            Write-Check -Name 'test-backed smoke' -Status 'FAIL' -Detail "exit=$LASTEXITCODE"
            Add-Failure 'Test-backed smoke failed'
        }
    }
}

Write-Host ''
Write-Host '== Summary =='
Write-Host "Failures: $($Failures.Count)"
Write-Host "Warnings: $($Warnings.Count)"
if ($Warnings.Count -gt 0) {
    foreach ($warning in $Warnings) { Write-Host "[WARN] $warning" }
}
if ($Failures.Count -gt 0) {
    foreach ($failure in $Failures) { Write-Host "[FAIL] $failure" }
    exit 1
}
Write-Host '[PASS] orchestrator-pack verification completed.'
exit 0
