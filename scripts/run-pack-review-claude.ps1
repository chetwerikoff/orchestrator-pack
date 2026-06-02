# Canonical AO Claude Sonnet review entrypoint: preflight, Claude CLI, pack parser.
# Parallel to scripts/run-pack-review.ps1 (Codex). Referenced by REVIEW_COMMAND (Issue #79).
#Requires -Version 5.1
param()

$ErrorActionPreference = 'Stop'
$Script:WrapperName = 'run-pack-review-claude.ps1'
. (Join-Path $PSScriptRoot 'lib/Parse-PackReviewCliArgs.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-AutoReviewPrContext.ps1')
. (Join-Path $PSScriptRoot 'lib/Install-PackReviewDependencies.ps1')

$cli = Split-PackReviewCliArgs -Argv $args
$resolvedRoot = (Resolve-Path -LiteralPath $cli.RepoRoot).Path
$packRoot = Split-Path -Parent $PSScriptRoot
$reviewTs = Join-Path $packRoot 'plugins/ao-codex-pr-reviewer/bin/review.ts'
$fixtureRunner = Join-Path $packRoot 'scripts/run-pack-review-fixture.mjs'
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

Add-PackReviewAutoForwardArgs -ForwardArgs $forwardArgs -RepoRoot $resolvedRoot | Out-Null

$workspacePrompt = Join-Path $resolvedRoot 'prompts/codex_review_prompt.md'
if (Test-Path -LiteralPath $workspacePrompt -PathType Leaf) {
    $env:AO_CODEX_REVIEW_PROMPT_FILE = $workspacePrompt
}

Push-Location -LiteralPath $resolvedRoot
try {
    Install-PackReviewDependencies -WrapperName $Script:WrapperName

    $promptArgs = @(
        '--import', 'tsx', $reviewTs,
        '--repo-root', $resolvedRoot,
        '--base', $cli.Base,
        '--prompt-only'
    )
    foreach ($arg in $forwardArgs) {
        $promptArgs += $arg
    }

    # review.ts --prompt-only logs 'prompt-only mode' to stderr; with 2>&1 + Stop that becomes
    # a terminating ErrorRecord. Use Continue for this call and keep stdout only.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $promptRaw = @(& node @promptArgs 2>&1)
        $promptExit = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prevEap
    }

    $prompt = @(
        $promptRaw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }
    ) -join "`n"
    $prompt = $prompt.TrimEnd()
    if ($promptExit -ne 0) {
        [Console]::Error.WriteLine("$Script:WrapperName: review.ts --prompt-only failed (exit $promptExit)")
        if ($prompt) { [Console]::Error.WriteLine($prompt) }
        exit $promptExit
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
        $ErrorActionPreference = 'Continue'
        try {
            $claudeRaw = @(Get-Content -LiteralPath $promptFile -Raw | & claude @claudeArgs 2>&1)
            $claudeExit = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $prevEap
        }

        $claudeOut = @(
            $claudeRaw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }
        ) -join "`n"
        $claudeOut = $claudeOut.TrimEnd()

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

        $ErrorActionPreference = 'Continue'
        try {
            & node @parseArgs
            $parseExit = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $prevEap
        }

        exit $parseExit
    }
    finally {
        Remove-Item -LiteralPath $promptFile, $claudeFile -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
