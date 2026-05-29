# Canonical AO Claude Sonnet review entrypoint: preflight, Claude CLI, pack parser.
# Parallel to scripts/run-pack-review.ps1 (Codex). Referenced by REVIEW_COMMAND (Issue #79).
#Requires -Version 5.1
param()

$ErrorActionPreference = 'Stop'
$Script:WrapperName = 'run-pack-review-claude.ps1'
. (Join-Path $PSScriptRoot 'lib/Parse-PackReviewCliArgs.ps1')

function Get-AutoPrNumber {
    param([string]$RepoRoot)

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        return $null
    }

    Push-Location -LiteralPath $RepoRoot
    try {
        $head = (git rev-parse HEAD 2>$null)
        if (-not $head) { return $null }
        $raw = (gh pr list --head $head --json number --jq '.[0].number' 2>$null)
        if (-not $raw) { return $null }
        $n = [int]$raw
        if ($n -gt 0) { return $n }
    }
    catch {
        return $null
    }
    finally {
        Pop-Location
    }

    return $null
}

$cli = Split-PackReviewCliArgs -Argv $args
$resolvedRoot = (Resolve-Path -LiteralPath $cli.RepoRoot).Path
$packRoot = Split-Path -Parent $PSScriptRoot
$reviewTs = Join-Path $packRoot 'plugins\ao-codex-pr-reviewer\bin\review.ts'
$fixtureRunner = Join-Path $packRoot 'scripts\run-pack-review-fixture.mjs'
$defaultModel = 'claude-sonnet-4-6'

if (-not (Test-Path -LiteralPath $reviewTs -PathType Leaf)) {
    Write-Error "Pack review wrapper not found at $reviewTs"
}
if (-not (Test-Path -LiteralPath $fixtureRunner -PathType Leaf)) {
    Write-Error "Fixture runner not found at $fixtureRunner"
}

$forwardArgs = [System.Collections.Generic.List[string]]::new()
foreach ($arg in $cli.ForwardArgs) {
    $forwardArgs.Add($arg) | Out-Null
}

if ($forwardArgs -notcontains '--pr-number') {
    $autoPr = Get-AutoPrNumber -RepoRoot $resolvedRoot
    if ($autoPr) {
        $forwardArgs.Add('--pr-number') | Out-Null
        $forwardArgs.Add([string]$autoPr) | Out-Null
    }
}

$workspacePrompt = Join-Path $resolvedRoot 'prompts\codex_review_prompt.md'
if (Test-Path -LiteralPath $workspacePrompt -PathType Leaf) {
    $env:AO_CODEX_REVIEW_PROMPT_FILE = $workspacePrompt
}

Push-Location -LiteralPath $resolvedRoot
try {
    # AO treats review-command stdout as findings — keep npm off stdout.
    npm ci --include=dev 1>$null
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine("$Script:WrapperName: npm ci failed (exit $LASTEXITCODE)")
        exit $LASTEXITCODE
    }

    $promptArgs = @(
        '--import', 'tsx', $reviewTs,
        '--repo-root', $resolvedRoot,
        '--base', $cli.Base,
        '--prompt-only'
    )
    foreach ($arg in $forwardArgs) {
        $promptArgs += $arg
    }

    $prompt = (& node @promptArgs 2>&1 | Out-String).TrimEnd()
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine("$Script:WrapperName: review.ts --prompt-only failed (exit $LASTEXITCODE)")
        if ($prompt) { [Console]::Error.WriteLine($prompt) }
        exit $LASTEXITCODE
    }
    if (-not $prompt) {
        [Console]::Error.WriteLine("$Script:WrapperName: empty prompt from review.ts --prompt-only")
        exit 1
    }

    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine("$Script:WrapperName: claude CLI not found on PATH")
        exit 1
    }

    $model = $defaultModel
    for ($i = 0; $i -lt $forwardArgs.Count; $i++) {
        if ($forwardArgs[$i] -eq '--model' -and ($i + 1) -lt $forwardArgs.Count) {
            $model = $forwardArgs[$i + 1]
            break
        }
    }

    $promptFile = [System.IO.Path]::GetTempFileName()
    $claudeFile = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($promptFile, $prompt, [System.Text.UTF8Encoding]::new($false))

        $claudeArgs = @('--print', '--model', $model)
        $claudeOut = Get-Content -LiteralPath $promptFile -Raw |
            & claude @claudeArgs 2>&1 |
            ForEach-Object {
                if ($_ -is [string]) { $_ }
                else { $_.ToString() }
            }
        $claudeOut = ($claudeOut -join "`n").TrimEnd()
        $claudeExit = $LASTEXITCODE

        if ($claudeExit -ne 0) {
            [Console]::Error.WriteLine("$Script:WrapperName: claude --print exited $claudeExit")
            if ($claudeOut) { [Console]::Error.WriteLine($claudeOut) }
            exit $claudeExit
        }

        [System.IO.File]::WriteAllText($claudeFile, $claudeOut, [System.Text.UTF8Encoding]::new($false))

        $parseArgs = @(
            '--import', 'tsx', $fixtureRunner,
            '--fixture-file', $claudeFile,
            '--repo-root', $resolvedRoot,
            '--base', $cli.Base
        )
        for ($i = 0; $i -lt $forwardArgs.Count; $i++) {
            if ($forwardArgs[$i] -eq '--model') {
                $i++
                continue
            }
            $parseArgs += $forwardArgs[$i]
        }

        & node @parseArgs
        exit $LASTEXITCODE
    }
    finally {
        Remove-Item -LiteralPath $promptFile, $claudeFile -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
