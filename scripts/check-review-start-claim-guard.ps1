#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$AllowlistPath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

if (-not $AllowlistPath) {
    $AllowlistPath = Join-Path $RepoRoot 'scripts/review-start-claim-guard.allowlist.json'
}

$allow = @{}
$allowlistViolations = @()
if (Test-Path -LiteralPath $AllowlistPath -PathType Leaf) {
    $entries = Get-Content -LiteralPath $AllowlistPath -Raw | ConvertFrom-Json
    foreach ($entry in @($entries)) {
        $path = ([string]$entry.path).Replace('\', '/')
        if (-not $path -or -not [string]$entry.justification) {
            $allowlistViolations += "allowlist entry requires path and justification"
            continue
        }
        if ($entry.interactiveOnly -ne $true) {
            $allowlistViolations += "allowlist entry is not interactive-only: $path"
            continue
        }
        $allow[$path] = $entry
    }
}

$roots = @('scripts', 'docs', 'prompts', '.github', 'plugins')
$files = foreach ($root in $roots) {
    $full = Join-Path $RepoRoot $root
    if (Test-Path -LiteralPath $full) {
        Get-ChildItem -LiteralPath $full -Recurse -File -Include *.ps1,*.psm1,*.mjs,*.js,*.ts,*.yml,*.yaml,*.md,*.json
    }
}

$textByRel = @{}
foreach ($file in @($files)) {
    $rel = [System.IO.Path]::GetRelativePath($RepoRoot, $file.FullName).Replace('\', '/')
    $textByRel[$rel] = Get-Content -LiteralPath $file.FullName -Raw
}

$reviewRunLiteral = [regex]'(?is)(\bao\s+review\s+run\b|@\(\s*[''"]review[''"]\s*,\s*[''"]run[''"]|@runArgs)'
$claimGate = [regex]'(?is)(Acquire-ReviewStartClaim|Review-StartClaim\.ps1|Invoke-ReviewWakeTriggerOnCompletionWake|Invoke-ReviewTriggerReevalPlannedRun|Invoke-PlannedReviewRun)'
$functionDefs = @{}
foreach ($rel in $textByRel.Keys) {
    $text = $textByRel[$rel]
    foreach ($m in [regex]::Matches($text, '(?m)^\s*function\s+([A-Za-z0-9_-]+)\s*\{')) {
        $functionDefs[$m.Groups[1].Value] = $rel
    }
}

$violations = @($allowlistViolations)
foreach ($rel in ($textByRel.Keys | Sort-Object)) {
    $text = $textByRel[$rel]
    $isRuntimeScript =
        $rel -like 'scripts/*.ps1' -or $rel -like 'scripts/lib/*.ps1' -or
        $rel -like 'scripts/*.mjs' -or $rel -like 'scripts/lib/*.mjs' -or
        $rel -like 'plugins/*.ps1' -or $rel -like 'plugins/**/*.ps1' -or
        $rel -like 'plugins/*.js' -or $rel -like 'plugins/**/*.js' -or
        $rel -like 'plugins/*.mjs' -or $rel -like 'plugins/**/*.mjs' -or
        $rel -like 'plugins/*.ts' -or $rel -like 'plugins/**/*.ts'
    if (-not $isRuntimeScript) { continue }
    if ($rel -like 'scripts/check-*.ps1' -or $rel -like 'scripts/*test*.ps1' -or
        $rel -like 'scripts/reviewer-workspace-preflight.ps1' -or
        $rel -like 'scripts/lib/Invoke-ReviewerWorkspacePreflight.ps1' -or
        $rel -like 'scripts/lib/Review-Send-MechanicalForbiddenCommand.ps1' -or
        $rel -like 'scripts/review-send-reconcile.ps1') { continue }
    if ($allow.ContainsKey($rel)) { continue }

    $direct = $reviewRunLiteral.IsMatch($text)
    $indirect = $false
    foreach ($name in $functionDefs.Keys) {
        if ($functionDefs[$name] -eq $rel) { continue }
        if ($text -match "(?m)\b$([regex]::Escape($name))\b" -and $reviewRunLiteral.IsMatch($textByRel[$functionDefs[$name]])) {
            $indirect = $true
            break
        }
    }
    if (($direct -or $indirect) -and -not $claimGate.IsMatch($text)) {
        $violations += "$rel reaches ao review run without Review-StartClaim"
    }
}

if ($violations.Count -gt 0) {
    Write-Host "review-start-claim guard failed:"
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host '[PASS] review-start-claim guard: automated review-run starters are claim-gated'
