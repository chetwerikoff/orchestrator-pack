[CmdletBinding()]
param(
    [switch]$InstallScopeGuard,
    [switch]$UninstallScopeGuard
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'git not found; cannot install hooks.'
    exit 1
}

$inside = @(& git -C $Root rev-parse --is-inside-work-tree 2>$null)
if ($LASTEXITCODE -ne 0 -or (($inside | Select-Object -First 1) -ne 'true')) {
    Write-Host 'Not a git worktree yet. Run git init or clone this repository first, then rerun this script.'
    exit 1
}

$gitDirRaw = @(& git -C $Root rev-parse --git-dir 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Could not resolve .git directory:'
    $gitDirRaw | ForEach-Object { Write-Host $_ }
    exit 1
}

$gitDir = ($gitDirRaw | Select-Object -First 1).Trim()
if (-not [System.IO.Path]::IsPathRooted($gitDir)) {
    $gitDir = Join-Path $Root $gitDir
}

$hooksDir = Join-Path $gitDir 'hooks'
New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$scopeGuardMarker = '# orchestrator-pack ao-scope-guard pre-commit'
$scopeGuardHookPath = Join-Path $hooksDir 'pre-commit'
$scopeGuardSource = Join-Path $Root 'plugins/ao-scope-guard/hooks/pre-commit'

if ($UninstallScopeGuard) {
    if (Test-Path -LiteralPath $scopeGuardHookPath -PathType Leaf) {
        $existing = Get-Content -LiteralPath $scopeGuardHookPath -Raw
        if ($existing -like "*$scopeGuardMarker*") {
            Remove-Item -LiteralPath $scopeGuardHookPath -Force
            Write-Host "Removed scope-guard pre-commit hook: $scopeGuardHookPath"
        }
        else {
            Write-Host "pre-commit hook exists but is not managed by orchestrator-pack; left unchanged."
        }
    }
    else {
        Write-Host 'No pre-commit hook to remove.'
    }
}

if ($InstallScopeGuard) {
    if (-not (Test-Path -LiteralPath $scopeGuardSource -PathType Leaf)) {
        Write-Host "Scope-guard hook source not found: $scopeGuardSource"
        exit 1
    }

    $scopeHook = @(
        '#!/usr/bin/env sh'
        'set -eu'
        $scopeGuardMarker
        'ROOT="$(git rev-parse --show-toplevel)"'
        'exec "$ROOT/plugins/ao-scope-guard/hooks/pre-commit"'
    ) -join "`n"

    [System.IO.File]::WriteAllText($scopeGuardHookPath, $scopeHook.Replace("`r`n", "`n"), $utf8NoBom)

    if (Get-Command chmod -ErrorAction SilentlyContinue) {
        & chmod +x $scopeGuardHookPath | Out-Null
        & chmod +x $scopeGuardSource | Out-Null
    }

    Write-Host "Installed scope-guard pre-commit hook: $scopeGuardHookPath"
    Write-Host 'Set AO_ISSUE_NUMBER in the environment before committing.'
    Write-Host 'Re-run with -UninstallScopeGuard to remove the hook.'
}

$hookPath = Join-Path $hooksDir 'pre-push'

$hook = @'
#!/usr/bin/env sh
set -eu
ROOT="$(git rev-parse --show-toplevel)"
if command -v pwsh >/dev/null 2>&1; then
  PS_BIN="pwsh"
else
  PS_BIN="powershell.exe"
fi
"$PS_BIN" -NoProfile -ExecutionPolicy Bypass -File "$ROOT/scripts/verify.ps1"
"$PS_BIN" -NoProfile -ExecutionPolicy Bypass -File "$ROOT/scripts/check-reusable.ps1"
'@

[System.IO.File]::WriteAllText($hookPath, $hook.Replace("`r`n", "`n"), $utf8NoBom)

if (Get-Command chmod -ErrorAction SilentlyContinue) {
    & chmod +x $hookPath | Out-Null
}

Write-Host "Installed pre-push hook: $hookPath"
Write-Host 'The hook runs scripts/verify.ps1 and scripts/check-reusable.ps1 before every push.'
if (-not $InstallScopeGuard) {
    Write-Host 'Pass -InstallScopeGuard to also install the ao-scope-guard pre-commit hook.'
}
