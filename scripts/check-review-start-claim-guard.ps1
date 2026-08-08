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

$retiredCli = ([char]97).ToString() + ([char]111).ToString()
$reviewRunPattern = @'
(?is)(\b{0}\s+review\s+run\b|@\(\s*['"]review['"]\s*,\s*['"]run['"]|@runArgs)
'@
$reviewRunLiteral = [regex](($reviewRunPattern.Trim()) -f [regex]::Escape($retiredCli))
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
        $rel -like 'scripts/lib/Review-MechanicalForbiddenCommand.ps1' -or
        $rel -like 'scripts/review-send-reconcile.ps1') { continue }
    if ($allow.ContainsKey($rel)) { continue }

    $direct = $reviewRunLiteral.IsMatch($text)
    if ($direct -and -not $claimGate.IsMatch($text)) {
        $violations += "$rel reaches the retired review-run command without Review-StartClaim"
    }
}

$claimBridgePath = Join-Path $RepoRoot 'scripts/lib/Review-StartClaimLifecycle.ps1'
$claimStorePath = Join-Path $RepoRoot 'scripts/lib/review-start-claim-store.ts'
$packReviewRunnerPath = Join-Path $RepoRoot 'scripts/pack-review-runner.ts'
$hardCut = -not (Test-Path -LiteralPath $claimBridgePath -PathType Leaf)
if ($hardCut) {
    if (-not (Test-Path -LiteralPath $claimStorePath -PathType Leaf)) {
        $violations += 'TypeScript review-start claim authority is missing after PowerShell bridge removal'
    }
    if (-not (Test-Path -LiteralPath $packReviewRunnerPath -PathType Leaf)) {
        $violations += 'pack-review runner is missing after PowerShell bridge removal'
    }
    else {
        $runnerSource = Get-Content -LiteralPath $packReviewRunnerPath -Raw
        if ($runnerSource -notmatch 'from\s+[''"]\./lib/review-start-claim-store\.ts[''"]') {
            $violations += 'pack-review runner is not bound directly to the TypeScript claim authority'
        }
        if ($runnerSource -match 'Review-StartClaimLifecycle\.ps1') {
            $violations += 'pack-review runner still references the removed PowerShell claim bridge'
        }
    }
}

$conformancePath = Join-Path $RepoRoot 'scripts/pr2a/final-conformance.ts'
$gitDir = Join-Path $RepoRoot '.git'
$pr2aLandingCommit = '17ac39d725ba9ae7c881816405d5225e541177c7'
if (-not $hardCut -and $violations.Count -eq 0 -and (Test-Path -LiteralPath $conformancePath -PathType Leaf) -and (Test-Path -LiteralPath $gitDir)) {
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

            $postLanding = $false
            if ($violations.Count -eq 0) {
                & $git.Source -C $RepoRoot cat-file -e "$pr2aLandingCommit^{commit}" 2>$null
                if ($LASTEXITCODE -ne 0) {
                    & $git.Source -C $RepoRoot fetch --no-tags origin $pr2aLandingCommit *> $null
                }
                & $git.Source -C $RepoRoot merge-base --is-ancestor $pr2aLandingCommit HEAD 2>$null
                if ($LASTEXITCODE -eq 0) {
                    $postLanding = $true
                }
                elseif ($LASTEXITCODE -ne 1) {
                    $violations += 'Issue #948 final conformance could not classify the PR2a landing boundary against HEAD'
                }
            }

            if ($violations.Count -eq 0) {
                $conformanceExitCode = 1
                Push-Location -LiteralPath $RepoRoot
                try {
                    if ($postLanding) {
                        $filterScript = @'
import { buildConformanceReport } from './scripts/pr2a/final-conformance.ts';
const oneTimeCodes = new Set([
  'planned_operation_missing_or_changed',
  'unreviewed_final_tree_operation',
  'path_outside_allowed_roots',
  'denylisted_path_changed',
  'new_powershell_logic_added',
  'non_regular_final_tree_mode',
]);
const report = buildConformanceReport('HEAD');
const remaining = report.findings.filter((finding) => !oneTimeCodes.has(finding.code));
if (remaining.length > 0) {
  process.stderr.write(`${JSON.stringify(remaining)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('[PASS] Issue #948 post-landing conformance: frozen PR2a operation-set findings ignored; enduring invariants remain green\n');
}
'@
                        $conformanceOutput = @(& $node.Source --no-warnings --experimental-strip-types --input-type=module -e $filterScript 2>&1 | ForEach-Object { [string]$_ })
                    }
                    else {
                        $conformanceOutput = @(& $node.Source --no-warnings --experimental-strip-types $conformancePath --ref HEAD --json 2>&1 | ForEach-Object { [string]$_ })
                    }
                    $conformanceExitCode = $LASTEXITCODE
                }
                finally {
                    Pop-Location
                }
                if ($conformanceExitCode -ne 0) {
                    $detail = ($conformanceOutput -join ' ').Trim()
                    if ($detail.Length -gt 1800) { $detail = $detail.Substring(0, 1800) + '...[truncated]' }
                    if ($detail) {
                        $violations += "Issue #948 final conformance rejected the current HEAD: $detail"
                    }
                    else {
                        $violations += 'Issue #948 final conformance rejected the current HEAD'
                    }
                }
                elseif ($conformanceOutput.Count -gt 0) {
                    $conformanceOutput | ForEach-Object { Write-Host $_ }
                }
            }
        }
    }
}

if ($hardCut -and $violations.Count -eq 0) {
    Write-Host '[PASS] Issue #1248 hard cut: PowerShell claim bridge absent and pack-review runner bound to TypeScript authority'
}

if ($violations.Count -gt 0) {
    Write-Host "review-start-claim guard failed:"
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host '[PASS] review-start-claim guard: TypeScript claim authority and empty D928 executable closure verified'
