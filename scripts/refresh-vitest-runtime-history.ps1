#requires -Version 5.1
<#
.SYNOPSIS
  Refresh committed Vitest runtime-history from heavy-shard JSON reports (Issue #691).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReportsDir,

    [Parameter(Mandatory = $true)]
    [string]$CommitSha,

    [string]$RepoRoot = '',
    [string]$HistoryPath = '',
    [switch]$DryRun,
    [switch]$CommitBack
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$historyFile = if ($HistoryPath) { $HistoryPath } else { Join-Path $RepoRoot 'scripts/vitest-runtime-history.json' }
$refreshScript = Join-Path $PSScriptRoot 'refresh-vitest-runtime-history.mjs'

function Sync-RemoteRuntimeHistoryBase {
    git -C $RepoRoot fetch origin main | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw 'failed to fetch origin/main before runtime-history refresh'
    }
    $remoteHistory = git -C $RepoRoot show origin/main:scripts/vitest-runtime-history.json 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'origin/main is missing scripts/vitest-runtime-history.json'
    }
    Set-Content -LiteralPath $historyFile -Value $remoteHistory -Encoding utf8
}

function Invoke-RuntimeHistoryRefresh {
    param(
        [string]$BaseHistoryFile = ''
    )

    $args = @(
        $refreshScript,
        '--reports-dir', $ReportsDir,
        '--commit-sha', $CommitSha,
        '--repo-root', $RepoRoot,
        '--history-path', $historyFile
    )
    if ($BaseHistoryFile) {
        $args += @('--base-history-file', $BaseHistoryFile)
    }
    if ($DryRun) {
        $args += '--dry-run'
    }

    & node @args
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

function Invoke-RuntimeHistoryStaleReconcile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RemoteHistoryFile,

        [Parameter(Mandatory = $true)]
        [string]$ProposedHistoryFile
    )

    & node $refreshScript reconcile `
        --remote $RemoteHistoryFile `
        --proposed $ProposedHistoryFile `
        --output $historyFile
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

function Assert-OnlyRuntimeHistoryStaged {
    $staged = git -C $RepoRoot diff --cached --name-only --diff-filter=ACMR
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[FAIL] runtime-history commit-back failed to inspect staged paths'
        exit 1
    }

    $paths = @($staged | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($paths.Count -ne 1 -or $paths[0] -ne 'scripts/vitest-runtime-history.json') {
        $joined = if ($paths.Count -eq 0) { '<none>' } else { ($paths -join ', ') }
        Write-Host "[FAIL] runtime-history delivery path must stage only scripts/vitest-runtime-history.json (saw: $joined)"
        exit 1
    }
}

if ($CommitBack -and -not $DryRun) {
    Sync-RemoteRuntimeHistoryBase
}

Invoke-RuntimeHistoryRefresh

if (-not $CommitBack -or $DryRun) {
    exit 0
}

if (-not (Test-Path -LiteralPath $historyFile)) {
    Write-Host "[FAIL] expected history file missing after refresh: $historyFile"
    exit 1
}

$proposedSnapshot = Join-Path ([System.IO.Path]::GetTempPath()) "vhr-proposed-$([guid]::NewGuid().ToString('n')).json"
$remoteSnapshot = Join-Path ([System.IO.Path]::GetTempPath()) "vhr-remote-$([guid]::NewGuid().ToString('n')).json"
Copy-Item -LiteralPath $historyFile -Destination $proposedSnapshot -Force

$maxAttempts = 3
try {
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        git -C $RepoRoot fetch origin main | Out-Host
        if ($LASTEXITCODE -ne 0) {
            if ($attempt -eq $maxAttempts) {
                Write-Host '[FAIL] runtime-history commit-back failed to fetch origin/main'
                exit 1
            }
            continue
        }

        git -C $RepoRoot reset --hard origin/main
        if ($LASTEXITCODE -ne 0) {
            if ($attempt -eq $maxAttempts) {
                Write-Host '[FAIL] runtime-history commit-back failed to reset to origin/main'
                exit 1
            }
            continue
        }

        git -C $RepoRoot show origin/main:scripts/vitest-runtime-history.json | Set-Content -LiteralPath $remoteSnapshot -Encoding utf8
        if ($LASTEXITCODE -ne 0) {
            if ($attempt -eq $maxAttempts) {
                Write-Host '[FAIL] runtime-history commit-back failed to read origin/main history'
                exit 1
            }
            continue
        }

        Invoke-RuntimeHistoryStaleReconcile -RemoteHistoryFile $remoteSnapshot -ProposedHistoryFile $proposedSnapshot

        git -C $RepoRoot add -- 'scripts/vitest-runtime-history.json'
        Assert-OnlyRuntimeHistoryStaged
        $status = git -C $RepoRoot status --porcelain -- 'scripts/vitest-runtime-history.json'
        if ([string]::IsNullOrWhiteSpace($status)) {
            Write-Host '[PASS] runtime-history commit-back skipped (idempotent no-op after stale-base reconcile)'
            exit 0
        }

        git -C $RepoRoot -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' `
            commit -m "chore(ci): refresh vitest runtime-history from measured heavy-shard reports"
        if ($LASTEXITCODE -ne 0) {
            Write-Host '[FAIL] runtime-history commit-back failed'
            exit 1
        }

        Write-Host '[PASS] runtime-history commit-back prepared delivery commit for dedicated branch PR'
        exit 0
    }

    Write-Host '[FAIL] runtime-history delivery commit could not be prepared after stale-base reconcile retries'
    exit 1
}
finally {
    Remove-Item -LiteralPath $proposedSnapshot -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $remoteSnapshot -Force -ErrorAction SilentlyContinue
}
