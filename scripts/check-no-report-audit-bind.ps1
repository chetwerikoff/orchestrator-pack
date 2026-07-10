#requires -Version 5.1
<#
.SYNOPSIS
  DROP proof: production scripts must not bind report-audit or ao status --reports (Issue #717 AC#7).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$needles = @(
    'Get-AoAgentReportAuditDir',
    'Read-AoAgentReportAuditReports',
    'Merge-AoSessionRowsWithReportAudit',
    'Get-AoStatusReportsJson',
    'Get-AoStatusReportsIncludingTerminatedJson',
    'Test-AoReportFullCliAvailable',
    '.agent-report-audit',
    "status', '--json', '--reports', 'full'"
)

$exclude = @(
    '*test*',
    '*fixture*',
    '*check-no-report-audit-bind*',
    '*check-review-status-consumers*',
    '*review-status-consumer.test.ts*',
    '*worker-report-store.test.ts*',
    '*250-pack-owned-worker-report-store-live-probes*'
)

function Test-ReportAuditBindForbidden {
    param([string]$RelPath, [string]$Content)

    foreach ($pattern in $exclude) {
        if ($RelPath -like $pattern) { return $false }
    }
    foreach ($needle in $needles) {
        if ($Content.Contains($needle)) {
            Write-Host "report-audit bind forbidden in production surface: $RelPath ($needle)"
            return $true
        }
    }
    return $false
}

$scriptsRoot = Join-Path $Root 'scripts'
foreach ($file in Get-ChildItem -LiteralPath $scriptsRoot -Recurse -File -ErrorAction SilentlyContinue) {
    $rel = $file.FullName.Substring($Root.Length + 1).Replace('\', '/')
    if ($file.Extension -notin @('.ps1', '.psm1', '.mjs', '.ts')) { continue }
    $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    if (Test-ReportAuditBindForbidden -RelPath $rel -Content $content) { exit 1 }
}

foreach ($rel in @(
        'docs/review-status-consumer-inventory.md',
        'docs/script-owned-review-pipeline.md'
    )) {
    $full = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
    $content = Get-Content -LiteralPath $full -Raw
    if (Test-ReportAuditBindForbidden -RelPath $rel -Content $content) { exit 1 }
}

Write-Host 'check-no-report-audit-bind: PASS'
exit 0
