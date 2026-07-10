#requires -Version 5.1
<#
  Structural guard for cursor-agent TUI shim wiring (Issue #725).
  Behavioral regression lives in scripts/cursor-agent-tui-shim.test.ts (full Vitest lane).
#>
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$selfPath = Join-Path $Root 'scripts/check-cursor-agent-tui-shim.ps1'

$requiredFiles = @(
    'scripts/cursor-agent-tui-shim.sh',
    'scripts/install-cursor-agent-tui-shim.ps1',
    'scripts/verify-cursor-agent-tui-shim.ps1',
    'scripts/lib/Cursor-Agent-TuiShim.ps1',
    'scripts/cursor-agent-tui-shim.test.ts',
    'scripts/orchestrator-worktree-trust-watcher.ps1',
    'docs/cursor-agent-tui-shim-runbook.md'
)

foreach ($rel in $requiredFiles) {
    $full = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        Write-Host "missing required file: $rel"
        exit 1
    }
}

$selfText = Get-Content -LiteralPath $selfPath -Raw
if ($selfText -match '(?m)(?:&\s+npm\s+ci|npm\s+ci\s+--)') {
    Write-Host 'check-cursor-agent-tui-shim.ps1 must not run npm ci; full Vitest lane owns behavioral checks (Issue #488)'
    exit 1
}
if ($selfText -match '(?m)&\s+npx\s+vitest|npx\s+vitest\s+run') {
    Write-Host 'check-cursor-agent-tui-shim.ps1 must not invoke Vitest; full Vitest lane owns behavioral checks (Issue #488)'
    exit 1
}

$shimText = Get-Content -LiteralPath (Join-Path $Root 'scripts/cursor-agent-tui-shim.sh') -Raw
if ($shimText -notmatch '\[cursor-agent-tui-shim\] FATAL') {
    Write-Host 'scripts/cursor-agent-tui-shim.sh must emit loud FATAL diagnostics on resolution failure'
    exit 1
}

$moduleText = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Cursor-Agent-TuiShim.ps1') -Raw
foreach ($pattern in @(
    'Test-CursorAgentTuiShimSelfHealEnabled',
    'Invoke-CursorAgentTuiShimSelfHeal',
    'OPK_CURSOR_AGENT_SHIM_SELF_HEAL_DISABLE'
)) {
    if ($moduleText -notmatch [regex]::Escape($pattern)) {
        Write-Host "Cursor-Agent-TuiShim.ps1 missing required symbol/pattern: $pattern"
        exit 1
    }
}

$watcherText = Get-Content -LiteralPath (Join-Path $Root 'scripts/orchestrator-worktree-trust-watcher.ps1') -Raw
if ($watcherText -notmatch 'Invoke-CursorAgentTuiShimSelfHeal') {
    Write-Host 'orchestrator-worktree-trust-watcher.ps1 must invoke Invoke-CursorAgentTuiShimSelfHeal'
    exit 1
}

$verifyText = Get-Content -LiteralPath (Join-Path $Root 'scripts/verify.ps1') -Raw
if ($verifyText -notmatch 'check-cursor-agent-tui-shim\.ps1') {
    Write-Host 'scripts/verify.ps1 must invoke scripts/check-cursor-agent-tui-shim.ps1'
    exit 1
}
if ($verifyText -notmatch 'verify-runtime/cursor-agent-tui-shim-vitest') {
    Write-Host 'scripts/verify.ps1 must SKIP cursor-agent TUI shim Vitest ownership to Issue #488 lane'
    exit 1
}

$lanes = Get-Content -LiteralPath (Join-Path $Root 'scripts/vitest-ci-lanes.config.json') -Raw | ConvertFrom-Json
$lane = $lanes.classification.'scripts/cursor-agent-tui-shim.test.ts'
if ($lane -ne 'light') {
    Write-Host 'scripts/cursor-agent-tui-shim.test.ts must be classified light in vitest-ci-lanes.config.json'
    exit 1
}

$migration = Get-Content -LiteralPath (Join-Path $Root 'docs/migration_notes.md') -Raw
foreach ($pattern in @(
    'cursor-agent TUI shim',
    'ln -sf',
    'OPK_CURSOR_AGENT_SHIM_SELF_HEAL_DISABLE',
    'orchestrator-worktree-trust-watcher'
)) {
    if ($migration -notmatch [regex]::Escape($pattern)) {
        Write-Host "docs/migration_notes.md missing cursor-agent shim rollback/adoption pattern: $pattern"
        exit 1
    }
}

$runbook = Get-Content -LiteralPath (Join-Path $Root 'docs/cursor-agent-tui-shim-runbook.md') -Raw
if ($runbook -notmatch 'restart|pkill') {
    Write-Host 'docs/cursor-agent-tui-shim-runbook.md must document stopping or restarting trust-watcher for rollback'
    exit 1
}

Write-Host '[PASS] cursor-agent TUI shim structural wiring (Issue #725)'
exit 0
