#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$required = @(
    'docs/merge-triage-gate.mjs',
    'docs/merge-triage-markers.v1.json',
    'scripts/lib/Merge-TriageGate.ps1',
    'scripts/merge-triage.test.ts'
)
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $rel) -PathType Leaf)) {
        Write-Host "Missing required file: $rel"
        exit 1
    }
}
$gate = Get-Content -LiteralPath (Join-Path $Root 'docs/merge-triage-gate.mjs') -Raw
if ($gate -match '\bao\s+review\s+list\b') {
    Write-Host 'merge triage gate must not call dead ao review list'
    exit 1
}
foreach ($needle in @('at_cap_open_findings','merge_triage_cleared','marker_list_hash','open_findings_snapshot_hash','PENDING_ARCHITECT','PENDING_OPERATOR','adjudication_provenance_token','issueArchitectToken')) {
    if ($gate -notmatch [regex]::Escape($needle)) {
        Write-Host "merge triage gate missing contract marker: $needle"
        exit 1
    }
}
$markers = Get-Content -LiteralPath (Join-Path $Root 'docs/merge-triage-markers.v1.json') -Raw
foreach ($marker in @('parser error','ReferenceError','every … classified malformed','CI will fail','verify.ps1 fails','written to disk','passed to coworker/provider','if the process crashes between…','TOCTOU','when bwrap/unshare is unavailable','[scope-violation]','declare the path','sync to issue #N')) {
    if ($markers -notmatch [regex]::Escape($marker)) {
        Write-Host "marker list missing seed marker: $marker"
        exit 1
    }
}
$rules = Get-Content -LiteralPath (Join-Path $Root 'AGENTS.md') -Raw
if ($rules -notmatch 'merge-triage-gate' -or $rules -notmatch 'merge_triage_cleared') {
    Write-Host 'AGENTS.md missing merge-triage policy pointer'
    exit 1
}
Write-Host 'check-merge-triage-gate: PASS'
exit 0
