#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$AllowNoGit
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Violations = [System.Collections.Generic.List[string]]::new()

function Convert-ToRepoPath {
    param([string]$Path)
    $normalized = $Path -replace '\\', '/'
    if ($normalized.StartsWith('./')) { return $normalized.Substring(2) }
    return $normalized
}

function Test-WildcardAny {
    param([string]$Path, [string[]]$Patterns)
    foreach ($pattern in $Patterns) {
        $wildcard = [System.Management.Automation.WildcardPattern]::new(
            $pattern,
            [System.Management.Automation.WildcardOptions]::IgnoreCase
        )
        if ($wildcard.IsMatch($Path)) { return $true }
    }
    return $false
}

function Add-Violation {
    param([string]$Path, [string]$Reason)
    $Violations.Add(('{0} :: {1}' -f $Path, $Reason)) | Out-Null
}

Write-Host '== reusable repository content guard =='
Write-Host "Root: $Root"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host '[WARN] git not found; cannot inspect tracked files.'
    if ($AllowNoGit) { exit 0 }
    exit 1
}

$inside = @(& git -C $Root rev-parse --is-inside-work-tree 2>$null)
if ($LASTEXITCODE -ne 0 -or (($inside | Select-Object -First 1) -ne 'true')) {
    Write-Host '[WARN] Not a git worktree; skipping tracked-file policy check.'
    if ($AllowNoGit) { exit 0 }
    exit 0
}

$trackedRaw = @(& git -C $Root ls-files 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Host '[FAIL] git ls-files failed:'
    $trackedRaw | ForEach-Object { Write-Host $_ }
    exit 1
}

$tracked = @(
    $trackedRaw |
        Where-Object { $_ -and $_.Trim() } |
        ForEach-Object { Convert-ToRepoPath $_ }
)
Write-Host ('Tracked files inspected: {0}' -f $tracked.Count)

$allowedRootPatterns = @(
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'LICENSE',
    'LICENSE.md',
    '.gitignore',
    '.gitattributes',
    '.editorconfig',
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'tsconfig.*.json',
    '*.config.js',
    '*.config.cjs',
    '*.config.mjs',
    '*.config.ts',
    '*.config.mts',
    '*.config.cts'
)

$allowedPathPatterns = @(
    '.github/*',
    '.cursor/skills/*',
    '.cursor/rules/*',
    '.claude/skills/*',
    'docs/*',
    'prompts/*',
    'plugins/*',
    'scripts/*',
    'schemas/*',
    'examples/*',
    'templates/*',
    'tests/*'
)

$exceptionPatterns = @(
    '.env.example',
    '*/.env.example'
)

$retiredConfigStem = 'agent' + '-orchestrator'
$retiredStateStem = '.agent' + '-orchestrator'
$forbiddenPatterns = @(
    "$retiredConfigStem.yaml",
    "$retiredConfigStem.*.yaml",
    '.env',
    '.env.*',
    '*/.env',
    '*/.env.*',
    '*.pem',
    '*.key',
    '*.pfx',
    '*.p12',
    '*.crt',
    '*.cer',
    'id_rsa',
    'id_rsa.*',
    '*/id_rsa',
    '*/id_rsa.*',
    'id_ed25519',
    'id_ed25519.*',
    '*/id_ed25519',
    '*/id_ed25519.*',
    'secrets/*',
    'private/*',
    '*/secrets/*',
    '*/private/*',
    '.orchestrator-pack/*',
    '*/.orchestrator-pack/*',
    "$retiredStateStem/*",
    "*/$retiredStateStem/*",
    'vendor/*',
    '*/vendor/*',
    'packages/core/*',
    '*/packages/core/*',
    'node_modules/*',
    '*/node_modules/*',
    '.pnpm-store/*',
    '*/.pnpm-store/*',
    '.npm/*',
    '*/.npm/*',
    'dist/*',
    '*/dist/*',
    'build/*',
    '*/build/*',
    'coverage/*',
    '*/coverage/*',
    '.out/*',
    '*/.out/*',
    '.cache/*',
    '*/.cache/*',
    '.turbo/*',
    '*/.turbo/*',
    '.next/*',
    '*/.next/*',
    '*.log',
    '*.tmp',
    '*.temp',
    '*.bak',
    '*.swp',
    '*.sqlite',
    '*.sqlite3',
    '*.db',
    '*.jsonl.local',
    'scratch/*',
    'tmp/*',
    'temp/*',
    'worktrees/*',
    'target-repos/*',
    '*/scratch/*',
    '*/tmp/*',
    '*/temp/*',
    '*/worktrees/*',
    '*/target-repos/*'
)

foreach ($path in $tracked) {
    $isException = Test-WildcardAny -Path $path -Patterns $exceptionPatterns
    if (-not $isException -and (Test-WildcardAny -Path $path -Patterns $forbiddenPatterns)) {
        Add-Violation -Path $path -Reason 'forbidden local/runtime/secret/upstream artifact pattern'
        continue
    }

    $isAllowed =
        (Test-WildcardAny -Path $path -Patterns $allowedRootPatterns) -or
        (Test-WildcardAny -Path $path -Patterns $allowedPathPatterns)
    if (-not $isAllowed) {
        Add-Violation -Path $path -Reason 'not in reusable pack allowlist'
    }
}

if ($Violations.Count -gt 0) {
    Write-Host '[FAIL] Non-reusable files are tracked or would be pushed:'
    foreach ($violation in $Violations) { Write-Host "- $violation" }
    Write-Host ''
    Write-Host 'Move reusable material under documented pack surfaces.'
    Write-Host 'Keep user configuration, generated state, target repos, upstream checkouts, and secrets untracked.'
    exit 1
}

Write-Host '[PASS] All tracked files match reusable-pack policy.'
exit 0
