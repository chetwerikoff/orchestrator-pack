param()

$ErrorActionPreference = 'Stop'
$Root = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) {
    Write-Error 'ao-scope-guard pre-commit: not inside a git worktree'
}

$bypass = $env:AO_SCOPE_GUARD_BYPASS
if ($bypass) {
    Write-Host "ao-scope-guard pre-commit: bypass active — $bypass" -ForegroundColor Yellow
    exit 0
}

$issueNumber = $env:AO_ISSUE_NUMBER
if (-not $issueNumber) {
    Write-Host 'ao-scope-guard pre-commit: AO_ISSUE_NUMBER is not set; skipping scope check' -ForegroundColor Yellow
    exit 0
}

$scopeCheck = Join-Path $Root 'plugins/ao-scope-guard/bin/scope-check.ts'
if (-not (Test-Path -LiteralPath $scopeCheck -PathType Leaf)) {
    Write-Error "ao-scope-guard pre-commit: scope-check not found at $scopeCheck"
}

$node = Get-Command node -ErrorAction Stop
& $node.Source --import tsx $scopeCheck `
    --issue $issueNumber `
    --mode index `
    --repo-root $Root

if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'Commit blocked by ao-scope-guard. To bypass with justification, run:' -ForegroundColor Red
    Write-Host '  $env:AO_SCOPE_GUARD_BYPASS = "<reason>"; git commit ...' -ForegroundColor Yellow
    Write-Host 'Document the bypass reason in the commit message or PR.' -ForegroundColor Yellow
    exit 1
}

exit 0
