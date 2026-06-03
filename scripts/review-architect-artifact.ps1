#!/usr/bin/env pwsh
# Architect read-only Codex review gate — issue drafts, adoption proposals, RCA memos.
# Uses `codex review` only (never `codex exec` / `codex exec review`).

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ArtifactPath,

    [ValidateSet('issue-draft', 'adoption-proposal', 'rca-memo')]
    [string]$Kind = 'issue-draft',

    [switch]$FailOnFindings
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Error 'review-architect-artifact.ps1 requires PowerShell 7+ (pwsh).'
    exit 2
}

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    Write-Error 'codex CLI is not on PATH. Install per docs/ubuntu-setup-runbook.md.'
    exit 2
}

if (-not (Test-Path -LiteralPath $ArtifactPath)) {
    Write-Error "Artifact not found: $ArtifactPath"
    exit 2
}

$resolved = (Resolve-Path -LiteralPath $ArtifactPath).Path
$text = Get-Content -Raw -LiteralPath $resolved

$roleBlock = switch ($Kind) {
    'issue-draft' {
@'
You are the lead architect reviewer for orchestrator-pack (read-only issue-draft spec review).
Review the DRAFT below for planner-freedom, observable acceptance criteria, command accuracy
(real ao / ao-declare flags; pwsh 7+ on Linux), denylist/allowed-roots fences, and cross-draft consistency.
Do NOT explore the repository unless the draft text is ambiguous.
Do NOT suggest implementation file names unless the draft already violates planner freedom.
'@
    }
    'adoption-proposal' {
@'
You are a critical reviewer for orchestrator-pack adoption proposals (read-only).
Critique the ADOPTION DECISIONS below — do not summarize the external source.
Check: cargo-cult risk, planner-freedom if we spec work, upgrade-safety (no core patch),
command accuracy, and whether pain is real.
Do NOT explore the repository unless the proposal is ambiguous.
'@
    }
    'rca-memo' {
@'
You are a critical reviewer for a root-cause investigation memo (read-only).
Challenge unsupported claims, missing queue/architecture search, items listed under Planned
that are closed, merged, or already on main, and patches proposed as durable fixes.
'@
    }
}

$prompt = @"
$roleBlock

Tag valid issues P0, P1, or P2.
If no concrete issues remain, respond with exactly NO_FINDINGS on its own line.

--- ARTIFACT ($resolved) ---
$text
"@

Write-Host "== architect codex review ($Kind) =="
Write-Host "Artifact: $resolved"
Write-Host 'Invoker: codex review (NOT codex exec / codex exec review)'

$output = & codex review $prompt 2>&1
$joined = ($output | Out-String).TrimEnd()
if ($joined) {
    Write-Host $joined
}

$clean = $joined -match '(?m)^NO_FINDINGS\s*$'
if ($FailOnFindings -and -not $clean) {
    exit 1
}

exit 0
