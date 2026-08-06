param([Parameter(Mandatory = $true)][int]$IssueNumber)
$ErrorActionPreference = 'Stop'
$Root = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { Write-Error 'scope-guard pre-commit: not inside a git worktree' }
$bypass = $env:OPK_SCOPE_GUARD_BYPASS
if ($bypass) { Write-Host "scope-guard pre-commit: bypass active — $bypass" -ForegroundColor Yellow; exit 0 }
$scopeCheck = Join-Path $Root 'plugins/scope-guard/bin/scope-check.ts'
if (-not (Test-Path -LiteralPath $scopeCheck -PathType Leaf)) { Write-Error "scope-guard pre-commit: scope-check not found at $scopeCheck" }
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
$nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion." }
$typeScriptLauncher = Join-Path $Root 'scripts/lib/Invoke-TypeScriptCli.ts'
& $node.Source '--experimental-strip-types' $typeScriptLauncher '--script' $scopeCheck '--' '--issue' $IssueNumber '--mode' 'index' '--repo-root' $Root
if ($LASTEXITCODE -ne 0) { Write-Host 'Commit blocked by scope-guard.' -ForegroundColor Red; exit 1 }
