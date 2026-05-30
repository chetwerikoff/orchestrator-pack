#requires -Version 5.1
<#
.SYNOPSIS
  Unlock op-orchestrator worktree and restart AO (Windows EPERM / orphan cleanup).

.DESCRIPTION
  Use from external PowerShell when ao start fails with EPERM on the orchestrator
  worktree, or Remove-Item on that directory fails because another process holds it.

  - Removes ~/.ao/bin/agent if present (bash shim breaks pwsh orchestrator spawn).
  - Kills only processes Handle reports on the worktree path (not all node.exe).
  - Repairs git worktree registration, then ao stop && ao start.

  See docs/migration_notes.md (Windows orchestrator prevention) and
  docs/orchestrator-recovery-runbook.md (step 2c).

  Handle (optional): winget install --id Microsoft.Sysinternals.Handle -e
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$RepoRoot = '',
    [string]$OrchestratorSessionId = 'op-orchestrator',
    [string]$ProjectSlug = 'orchestrator-pack',
    [switch]$SkipAoRestart
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    $RepoRoot = [string](Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
else {
    $RepoRoot = [string]$RepoRoot
}

$wt = Join-Path $env:USERPROFILE ".agent-orchestrator\projects\$ProjectSlug\worktrees\$OrchestratorSessionId"
$branch = "orchestrator/$OrchestratorSessionId"
$handleExe = @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Microsoft.Sysinternals.Handle_Microsoft.Winget.Source_8wekyb3d8bbwe\handle64.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Microsoft.Sysinternals.Handle_Microsoft.Winget.Source_8wekyb3d8bbwe\handle.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

Write-Host "== 1. Shim check (~/.ao/bin/agent must be absent) =="
$shim = Join-Path $env:USERPROFILE '.ao\bin\agent'
if (Test-Path -LiteralPath $shim) {
    if ($PSCmdlet.ShouldProcess($shim, 'Remove bash agent shim')) {
        Remove-Item -LiteralPath $shim -Force
        Write-Host "[OK] Removed $shim"
    }
}
else {
    Write-Host "[OK] No ~/.ao/bin/agent"
}

Write-Host "`n== 2. Kill processes holding worktree =="
if ($handleExe) {
    $out = & $handleExe -accepteula -nobanner $wt 2>&1 | Out-String
    if ($out -match 'No matching handles') {
        Write-Host "[OK] No open handles on worktree."
    }
    else {
        $out -split "`n" | ForEach-Object {
            if ($_ -match '^\s*(\S+)\.exe\s+pid:\s*(\d+)') {
                $procId = [int]$Matches[2]
                $name = $Matches[1]
                if ($PSCmdlet.ShouldProcess("PID $procId ($name)", 'taskkill /T /F')) {
                    Write-Host ">> taskkill /T /F /PID $procId ($name)"
                    taskkill /T /F /PID $procId 2>$null | Out-Null
                }
            }
        }
    }
}
else {
    Write-Warning "handle64 not found; killing by command-line match (install: winget install Microsoft.Sysinternals.Handle -e)"
    Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and (
            $_.CommandLine -match [regex]::Escape($OrchestratorSessionId) -and
            $_.CommandLine -match 'pty-host\.js|orchestrator-prompt'
        )
    } | ForEach-Object {
        if ($PSCmdlet.ShouldProcess("PID $($_.ProcessId)", 'taskkill /T /F')) {
            taskkill /T /F /PID $_.ProcessId 2>$null | Out-Null
        }
    }
}

Start-Sleep -Seconds 2

Write-Host "`n== 3. Repair git worktree =="
Push-Location -LiteralPath $RepoRoot
try {
    $listed = git worktree list 2>&1 | Out-String
    $wtNorm = $wt.Replace('\', '/')
    if ($listed -notmatch [regex]::Escape($wtNorm)) {
        if ((Test-Path -LiteralPath $wt) -and $PSCmdlet.ShouldProcess($wt, 'Remove orphan directory')) {
            Remove-Item -LiteralPath $wt -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (git branch --list $branch 2>$null) {
            Write-Host ">> git worktree add `"$wt`" $branch"
            git worktree add $wt $branch
        }
        else {
            Write-Host ">> git worktree add -b $branch `"$wt`" main"
            git worktree add -b $branch $wt main
        }
    }
    else {
        Write-Host "[OK] Worktree already registered."
    }
    git worktree list
}
finally {
    Pop-Location
}

if ($SkipAoRestart) {
    Write-Host "`n[SkipAoRestart] Done. Run: ao stop; ao start"
    exit 0
}

Write-Host "`n== 4. Restart AO =="
ao stop 2>&1 | Out-Null
Start-Sleep -Seconds 2
ao start
Write-Host "`nVerify (after ~15s): node `"`$env:TEMP\ao-pipe-read.cjs`""
