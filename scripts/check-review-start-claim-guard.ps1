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
$claimGate = [regex]'(?is)(Acquire-ReviewStartClaim|acquireReviewStartClaim|review-start-claim-store\.ts|Review-StartClaimLifecycle\.ps1|Invoke-ReviewWakeTriggerOnCompletionWake|Invoke-ReviewTriggerReevalPlannedRun|Invoke-PlannedReviewRun|Invoke-OrchestratorClaimedReviewRun|invoke-orchestrator-claimed-review-run\.ps1)'
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
        $rel -like 'scripts/lib/Review-MechanicalForbiddenCommand.ps1' -or
        $rel -like 'scripts/review-send-reconcile.ps1') { continue }
    if ($allow.ContainsKey($rel)) { continue }

    $direct = $reviewRunLiteral.IsMatch($text)
    if ($direct -and -not $claimGate.IsMatch($text)) {
        $violations += "$rel reaches ao review run without Review-StartClaim"
    }
}

$conformancePath = Join-Path $RepoRoot 'scripts/pr2a/final-conformance.ts'
$gitDir = Join-Path $RepoRoot '.git'
if ($violations.Count -eq 0 -and (Test-Path -LiteralPath $conformancePath -PathType Leaf) -and (Test-Path -LiteralPath $gitDir)) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        $violations += 'Node 22 is required for Issue #948 final conformance'
    }
    else {
        $major = (& $node.Source -p 'process.versions.node.split(".")[0]').Trim()
        if ($major -ne '22') {
            $violations += "Issue #948 final conformance requires Node 22 (found $major)"
        }
        else {
            $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $git) {
                $violations += 'Git is required for Issue #948 tree-bound final conformance'
            }
            else {
                $shallow = (& $git.Source -C $RepoRoot rev-parse --is-shallow-repository 2>$null | Out-String).Trim()
                if ($LASTEXITCODE -ne 0) {
                    $violations += 'Issue #948 final conformance could not inspect repository history depth'
                }
                elseif ($shallow -eq 'true') {
                    & $git.Source -C $RepoRoot fetch --no-tags --unshallow origin *> $null
                    if ($LASTEXITCODE -ne 0) {
                        $violations += 'Issue #948 final conformance could not recover the reviewed planning history from origin'
                    }
                }
            }
            if ($violations.Count -eq 0) {
                $conformanceOutput = @(& $node.Source --experimental-strip-types $conformancePath --ref HEAD 2>&1 | ForEach-Object { [string]$_ })
                if ($LASTEXITCODE -ne 0) {
                    $detail = ($conformanceOutput -join ' ').Trim()
                    if ($detail.Length -gt 1800) { $detail = $detail.Substring(0, 1800) + '...[truncated]' }
                    if ($detail) {
                        $violations += "Issue #948 final conformance rejected the current HEAD: $detail"
                    }
                    else {
                        $violations += 'Issue #948 final conformance rejected the current HEAD'
                    }
                }
            }
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host "review-start-claim guard failed:"
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host '[PASS] review-start-claim guard: TypeScript claim authority and empty D928 executable closure verified'
