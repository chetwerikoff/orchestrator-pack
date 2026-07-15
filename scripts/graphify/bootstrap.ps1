#requires -Version 7.0
<#
.SYNOPSIS
  Create (or repair) the isolated Python environment for the graphify code-graph tooling (Issue #833, AC#2).
.DESCRIPTION
  Creates an isolated venv at .graphify/venv -- never the operator's global Python site-packages --
  and installs exactly the packages pinned in scripts/graphify/requirements.lock.txt via
  `pip install --no-deps`, so a future run cannot silently resolve different transitive versions.
  Safe to re-run: rebuilds the venv from the lock each time.
.EXAMPLE
  pwsh scripts/graphify/bootstrap.ps1
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Resolve-GraphifyEnv.ps1')

function Resolve-Python3 {
    foreach ($candidate in @('python3', 'python')) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($null -ne $cmd) {
            $versionOutput = & $cmd.Source '--version' 2>&1
            if ($versionOutput -match '(\d+)\.(\d+)') {
                $major = [int]$Matches[1]
                $minor = [int]$Matches[2]
                if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 10)) {
                    return $cmd.Source
                }
            }
        }
    }
    throw 'No python3 >=3.10 found on PATH. Install Python 3.10+ and re-run this bootstrap.'
}

$python = Resolve-Python3
$venvDir = Get-GraphifyVenvDir
$lockFile = Get-GraphifyLockFile

if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) {
    throw "Pinned lock file not found at '$lockFile'."
}

Write-Host "[graphify bootstrap] creating isolated venv at $venvDir"
& $python '-m' 'venv' '--clear' $venvDir
if ($LASTEXITCODE -ne 0) { throw "python -m venv failed with exit code $LASTEXITCODE" }

$venvPython = if ($IsWindows) { Join-Path $venvDir 'Scripts/python.exe' } else { Join-Path $venvDir 'bin/python' }
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    throw "venv creation did not produce an interpreter at '$venvPython'."
}

Write-Host '[graphify bootstrap] installing pinned dependency set (pip install --no-deps -r requirements.lock.txt)'
& $venvPython '-m' 'pip' 'install' '--upgrade' 'pip' '--quiet'
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed with exit code $LASTEXITCODE" }

& $venvPython '-m' 'pip' 'install' '--no-deps' '-r' $lockFile
if ($LASTEXITCODE -ne 0) { throw "pip install --no-deps -r $lockFile failed with exit code $LASTEXITCODE" }

Write-Host '[graphify bootstrap] verifying installed set matches the pinned lock exactly'
$installedFreeze = & $venvPython '-m' 'pip' 'freeze'
if ($LASTEXITCODE -ne 0) { throw "pip freeze failed with exit code $LASTEXITCODE" }

$lockedPins = Get-Content -LiteralPath $lockFile | Where-Object { $_ -and $_ -notmatch '^\s*#' } | ForEach-Object { $_.Trim() } | Sort-Object
$installedPins = $installedFreeze | Where-Object { $_ -and $_ -notmatch '^\s*#' } | ForEach-Object { $_.Trim() } | Sort-Object

$missing = $lockedPins | Where-Object { $installedPins -notcontains $_ }
$extra = $installedPins | Where-Object { $lockedPins -notcontains $_ }

if ($missing.Count -gt 0 -or $extra.Count -gt 0) {
    Write-Host '[FAIL] installed environment does not match the pinned lock exactly:'
    foreach ($m in $missing) { Write-Host "  missing (pinned but not installed): $m" }
    foreach ($e in $extra) { Write-Host "  extra (installed but not pinned): $e" }
    exit 1
}

Write-Host "[PASS] isolated environment at $venvDir matches scripts/graphify/requirements.lock.txt exactly ($($lockedPins.Count) packages)."
Write-Host '[graphify bootstrap] this environment is not the machine global Python install; list its exact contents any time with:'
Write-Host "  $venvPython -m pip freeze"
