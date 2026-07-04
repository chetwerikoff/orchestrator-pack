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
$repoRoot = Split-Path -Parent $PSScriptRoot
$draftReviewPromptPath = Join-Path $repoRoot 'prompts/codex_draft_review_prompt.md'

$roleBlock = switch ($Kind) {
    'issue-draft' {
        if (-not (Test-Path -LiteralPath $draftReviewPromptPath)) {
            Write-Error "Missing draft review prompt: $draftReviewPromptPath"
            exit 2
        }
        (Get-Content -Raw -LiteralPath $draftReviewPromptPath).Replace(
            '{{ARTIFACT_SECTION}}',
            "--- ARTIFACT ($resolved) ---`n$text"
        )
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

$prompt = if ($Kind -eq 'issue-draft') {
    $roleBlock
} else {
@"

$roleBlock

Tag valid issues P0, P1, or P2.
If no concrete issues remain, respond with exactly NO_FINDINGS on its own line.

--- ARTIFACT ($resolved) ---
$text
"@
}

Write-Host "== architect codex review ($Kind) =="
Write-Host "Artifact: $resolved"
Write-Host 'Invoker: codex review (NOT codex exec / codex exec review)'
Write-Host 'Sandbox: sandbox_mode=danger-full-access (no containment)'

# Match ao-codex-pr-reviewer CODEX_SPAWN_ENV_STRIP — network-capable review must not inherit exfiltratable tokens.
$codexEnvStrip = @(
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'CODEX_AUTH_JSON',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL'
)
$savedCodexEnv = @{}
foreach ($name in $codexEnvStrip) {
    if (Test-Path -LiteralPath "Env:$name") {
        $savedCodexEnv[$name] = (Get-Item -LiteralPath "Env:$name").Value
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
}

try {
    $output = & codex review `
        -c 'sandbox_mode=danger-full-access' `
        $prompt 2>&1
}
finally {
    foreach ($entry in $savedCodexEnv.GetEnumerator()) {
        Set-Item -LiteralPath "Env:$($entry.Key)" -Value $entry.Value
    }
}

$joined = ($output | Out-String).TrimEnd()
if ($joined) {
    Write-Host $joined
}

$clean = $joined -match '(?m)^NO_FINDINGS\s*$'
if ($FailOnFindings -and -not $clean) {
    exit 1
}

exit 0
