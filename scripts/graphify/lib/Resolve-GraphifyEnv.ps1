#requires -Version 7.0
<#
.SYNOPSIS
  Shared path resolution + guarded `graphify` invocation for scripts/graphify/*.ps1 (Issue #833).
.DESCRIPTION
  Every pack-owned graphify entrypoint (build-graph.ps1, refresh-graph.ps1) resolves the isolated
  venv and calls Invoke-GraphifyCommand instead of shelling out directly, so the "never invoke
  graphify install / <platform> install" constraint has exactly one enforcement point.
#>
$ErrorActionPreference = 'Stop'

# Repo root: this file lives at scripts/graphify/lib/, so up three levels.
$script:GraphifyRepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

function Get-GraphifyRepoRoot {
    return $script:GraphifyRepoRoot
}

function Get-GraphifyVenvDir {
    return Join-Path (Get-GraphifyRepoRoot) '.graphify/venv'
}

function Get-GraphifyGraphOutDir {
    return Join-Path (Get-GraphifyRepoRoot) '.graphify/graph'
}

function Get-GraphifyLockFile {
    return Join-Path $PSScriptRoot '../requirements.lock.txt'
}

function Get-GraphifyExecutable {
    $venvDir = Get-GraphifyVenvDir
    $candidates = @(
        (Join-Path $venvDir 'bin/graphify'),
        (Join-Path $venvDir 'Scripts/graphify.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    throw "graphify executable not found under '$venvDir'. Run scripts/graphify/bootstrap.ps1 first."
}

# Subcommands this pack is allowed to invoke. `install` and every
# `<platform> install` variant are deliberately absent -- they write into
# CLAUDE.md / AGENTS.md / .cursor/rules/**, which this repo's architect owns.
# See AC#1 / AC#7 in Issue #833.
$script:GraphifyAllowedSubcommands = @('extract', 'update')

function Invoke-GraphifyCommand {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('extract', 'update')]
        [string]$Subcommand,

        [Parameter(Mandatory = $false)]
        [string[]]$Arguments = @()
    )

    if ($script:GraphifyAllowedSubcommands -notcontains $Subcommand) {
        throw "Refusing to invoke graphify subcommand '$Subcommand' -- not in the allowed set ($($script:GraphifyAllowedSubcommands -join ', '))."
    }
    foreach ($arg in $Arguments) {
        # Exact-token match only: a normal repo/output path containing an "install" path
        # component (e.g. /tmp/install/orchestrator-pack) must still pass through untouched.
        # This only rejects 'install' passed as its own standalone argv element, matching how
        # graphify's own CLI expects the install subcommand to appear.
        if ($arg -eq 'install') {
            throw "Refusing to invoke graphify: argument '$arg' looks like an install-family subcommand. This mechanism must never run 'graphify install' or any '<platform> install' variant."
        }
    }

    $exe = Get-GraphifyExecutable
    $fullArgs = @($Subcommand) + $Arguments

    # graphify writes a small cwd-relative graphify-out/manifest.json as a side effect,
    # independent of --out. Run from inside the gitignored .graphify/ working dir so that
    # stray write lands there too, never at the repo root.
    $workDir = Join-Path (Get-GraphifyRepoRoot) '.graphify'
    New-Item -ItemType Directory -Force -Path $workDir | Out-Null
    Push-Location $workDir
    try {
        & $exe @fullArgs
        if ($LASTEXITCODE -ne 0) {
            throw "graphify $Subcommand failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}
