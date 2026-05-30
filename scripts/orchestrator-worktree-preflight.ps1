#requires -Version 5.1
<#
.SYNOPSIS
  List stale orchestrator/* branches and AO worktrees before ao start (Issue #91).

.DESCRIPTION
  Read-only by default. With -Apply, removes reported git worktrees/branches and
  the AO worktree directory (orchestrator namespace only).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$OrchestratorSessionId = '',
    [string]$ProjectSlug = '',
    [string]$RepoRoot = '',
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Get-OrchestratorWorktreeHygiene.ps1')

if (-not $RepoRoot) {
    $RepoRoot = [string](Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
else {
    $RepoRoot = [string]$RepoRoot
}

$orchId = $OrchestratorSessionId
if (-not $orchId) {
    $orchId = if ($env:AO_ORCHESTRATOR_SESSION_ID) { $env:AO_ORCHESTRATOR_SESSION_ID.Trim() } else { 'op-orchestrator' }
}

Write-Host "== Orchestrator worktree preflight (session: $orchId) =="
$report = Get-OrchestratorStaleWorktreeFindings -RepoRoot $RepoRoot -SessionId $orchId -ProjectSlug $ProjectSlug

if ($report.Findings.Count -eq 0) {
    Write-Host '[OK] No stale orchestrator worktree or branch detected.'
    exit 0
}

Write-Host "[WARN] $($report.Findings.Count) stale item(s) — run cleanup before ao start if spawn shows branch_collision:"
foreach ($f in $report.Findings) {
    Write-Host ("  [{0}] {1}" -f $f.Kind, $f.Detail)
    Write-Host ("         {0}" -f $f.Command)
}

if (-not $Apply) {
    Write-Host ''
    Write-Host 'Re-run with -Apply to execute the commands above (destructive).'
    exit 2
}

Push-Location -LiteralPath $RepoRoot
try {
    foreach ($f in $report.Findings) {
        if (-not $PSCmdlet.ShouldProcess($f.Detail, $f.Kind)) { continue }
        switch ($f.Kind) {
            'git-worktree' {
                $wtPath = $f.Path
                Write-Host ">> git worktree remove --force `"$wtPath`""
                & git worktree remove --force $wtPath
                if ($LASTEXITCODE -ne 0) { throw "git worktree remove failed for $wtPath" }
            }
            'git-branch' {
                Write-Host ">> git branch -D $($report.Paths.BranchName)"
                & git branch -D $report.Paths.BranchName
                if ($LASTEXITCODE -ne 0) { throw "git branch -D failed for $($report.Paths.BranchName)" }
            }
            'ao-worktree-dir' {
                Write-Host ">> Remove-Item $($report.Paths.AoWorktreePath)"
                Remove-Item -LiteralPath $report.Paths.AoWorktreePath -Recurse -Force
            }
        }
    }
}
finally {
    Pop-Location
}

Write-Host '[OK] Apply completed — verify with git worktree list and ao start.'
exit 0
