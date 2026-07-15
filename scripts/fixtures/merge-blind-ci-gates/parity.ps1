#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$historicalPrHead = '3a3a299cdcc0e00270b4fa2c785b98ac7fdb4992'
$historicalMain = '225187b7d3507a0872fc1bf435089a7e3aa0c1d7'
$tempRoots = [System.Collections.Generic.List[string]]::new()

function New-FixtureRoot {
    param([string]$Prefix)
    $path = Join-Path ([IO.Path]::GetTempPath()) ("$Prefix-$([guid]::NewGuid().ToString('N'))")
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    $tempRoots.Add($path)
    & git -C $path init -b main | Out-Null
    & git -C $path config user.email 'fixture@example.invalid'
    & git -C $path config user.name 'merge-blind-fixture'
    return $path
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Commit-All {
    param([string]$Root, [string]$Message)
    & git -C $Root add -A
    if ($LASTEXITCODE -ne 0) { throw "git add failed in $Root" }
    & git -C $Root commit -m $Message | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git commit failed in $Root" }
    return (& git -C $Root rev-parse HEAD | Out-String).Trim()
}

function Invoke-WithContext {
    param(
        [ValidateSet('pr', 'push')][string]$Context,
        [string]$BaseSha,
        [scriptblock]$Action
    )
    $keys = @('BASE_SHA', 'GITHUB_BASE_SHA', 'PR_BASE_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'PR_HEAD_SHA')
    $saved = @{}
    foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
    try {
        foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
        if ($Context -eq 'pr') {
            $env:PR_BASE_SHA = $BaseSha
            $env:GITHUB_EVENT_NAME = 'pull_request'
        }
        else {
            $env:GITHUB_EVENT_NAME = 'push'
        }
        return & $Action
    }
    finally {
        foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
    }
}

function Assert-ContextParity {
    param(
        [string]$Name,
        [string]$ScriptPath,
        [string]$FixtureRoot,
        [string]$BaseSha,
        [ValidateSet('pass', 'fail')][string]$Expected
    )
    $results = @{}
    foreach ($context in @('pr', 'push')) {
        $captured = Invoke-WithContext -Context $context -BaseSha $BaseSha -Action {
            $text = (& pwsh -NoProfile -File $ScriptPath $FixtureRoot 2>&1 | Out-String)
            [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $text }
        }
        $results[$context] = $captured
        $ok = if ($Expected -eq 'pass') { $captured.ExitCode -eq 0 } else { $captured.ExitCode -ne 0 }
        if (-not $ok) {
            throw "$Name $context expected $Expected but exit=$($captured.ExitCode):`n$($captured.Output)"
        }
    }
    if ($results.pr.ExitCode -ne $results.push.ExitCode) {
        throw "$Name produced different PR/push exit codes: PR=$($results.pr.ExitCode), push=$($results.push.ExitCode)"
    }
}

function Invoke-RpcProbe {
    param([string]$FixtureRoot, [string]$Context, [string]$BaseSha, [string]$ProbePath, [string]$ValidatorPath)
    return Invoke-WithContext -Context $Context -BaseSha $BaseSha -Action {
        $json = (& node $ProbePath $FixtureRoot $ValidatorPath 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "RPC probe failed: $json" }
        return ($json | ConvertFrom-Json)
    }
}

try {
    $gateRoot = New-FixtureRoot -Prefix 'opk-823-gates'
    $helperSource = Join-Path $RepoRoot 'scripts/lib/Resolve-MergeStableCiBase.ps1'
    $helperTarget = Join-Path $gateRoot 'scripts/lib/Resolve-MergeStableCiBase.ps1'
    New-Item -ItemType Directory -Path (Split-Path -Parent $helperTarget) -Force | Out-Null
    Copy-Item -LiteralPath $helperSource -Destination $helperTarget

    Write-Utf8NoBom (Join-Path $gateRoot 'scripts/lib/Orchestrator-WakeSupervisorLease.ps1') @'
# State-root singleton lease for wake supervisor fleet cardinality (Issue #709)
function Get-OrchestratorWakeSupervisorLeasePath {}
$lock = 'supervisor.lock'
'@
    Write-Utf8NoBom (Join-Path $gateRoot 'scripts/lib/Orchestrator-FleetHygiene.ps1') @'
# Fleet hygiene assertions H1–H7 (Issue #711)
$Script:FleetHygieneAssertionIds = @('H1')
function Get-FleetHygieneConfig {}
'@
    Write-Utf8NoBom (Join-Path $gateRoot 'protected.txt') "stable`n"
    Write-Utf8NoBom (Join-Path $gateRoot 'docs/orchestrator-message-registry.mjs') @'
#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const [command, root, base] = process.argv.slice(2);
if (command === 'audit') process.exit(0);
if (command === 'generate-map') { process.stdout.write('stub-map\n'); process.exit(0); }
if (command === 'check-protected-runtime') {
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
  process.exit(changed.includes('protected.txt') ? 1 : 0);
}
process.exit(2);
'@
    Write-Utf8NoBom (Join-Path $gateRoot 'docs/orchestrator-message-map.md') "stub-map`n"

    $base = Commit-All -Root $gateRoot -Message 'semantic prerequisites'
    Write-Utf8NoBom (Join-Path $gateRoot 'unrelated.txt') "same guarded tree, new commit identity`n"
    $head = Commit-All -Root $gateRoot -Message 'unrelated change'
    & git -C $gateRoot update-ref refs/remotes/origin/main $head

    $sequencing = Join-Path $RepoRoot 'scripts/check-side-process-registry-709-711-sequencing.ps1'
    $registry = Join-Path $RepoRoot 'scripts/check-orchestrator-message-registry.ps1'
    Assert-ContextParity -Name 'sequencing positive' -ScriptPath $sequencing -FixtureRoot $gateRoot -BaseSha $base -Expected pass
    Assert-ContextParity -Name 'message registry positive' -ScriptPath $registry -FixtureRoot $gateRoot -BaseSha $base -Expected pass

    Write-Utf8NoBom (Join-Path $gateRoot 'protected.txt') "genuine protected drift`n"
    Write-Utf8NoBom (Join-Path $gateRoot 'scripts/lib/Orchestrator-FleetHygiene.ps1') "# genuine drift removed the #711 semantic contract`n"
    $driftHead = Commit-All -Root $gateRoot -Message 'genuine guarded drift'
    & git -C $gateRoot update-ref refs/remotes/origin/main $driftHead
    Assert-ContextParity -Name 'sequencing negative' -ScriptPath $sequencing -FixtureRoot $gateRoot -BaseSha $base -Expected fail
    Assert-ContextParity -Name 'message registry negative' -ScriptPath $registry -FixtureRoot $gateRoot -BaseSha $base -Expected fail

    $rpcRoot = New-FixtureRoot -Prefix 'opk-823-rpc'
    Write-Utf8NoBom (Join-Path $rpcRoot 'scripts/lib/vitest-ci-lanes.mjs') "// stable binding-scope payload`n"
    Write-Utf8NoBom (Join-Path $rpcRoot 'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json') (@{
        bindingMode = 'scoped-tree-content-v1'
        captureCommitSha = ('0' * 40)
    } | ConvertTo-Json)
    $capture = Commit-All -Root $rpcRoot -Message 'capture scoped tree'
    Write-Utf8NoBom (Join-Path $rpcRoot 'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json') (@{
        bindingMode = 'scoped-tree-content-v1'
        captureCommitSha = $capture
    } | ConvertTo-Json)
    [void](Commit-All -Root $rpcRoot -Message 'bind metadata')
    Write-Utf8NoBom (Join-Path $rpcRoot 'unrelated.txt') "merge identity changes, binding scope does not`n"
    $rpcHead = Commit-All -Root $rpcRoot -Message 'unrelated change'
    & git -C $rpcRoot update-ref refs/remotes/origin/main $rpcHead

    $validatorPath = Join-Path $RepoRoot 'scripts/lib/validate-supervisor-heavy-lane-rpc-artifacts.mjs'
    $probePath = Join-Path $rpcRoot 'probe.mjs'
    Write-Utf8NoBom $probePath "import { pathToFileURL } from 'node:url';`nconst module = await import(pathToFileURL(process.argv[3]).href);`nconsole.log(JSON.stringify(module.inspectSupervisorHeavyLaneRpcBinding(process.argv[2])));`n"
    $positive = @{}
    foreach ($context in @('pr', 'push')) {
        $positive[$context] = Invoke-RpcProbe -FixtureRoot $rpcRoot -Context $context -BaseSha $capture -ProbePath $probePath -ValidatorPath $validatorPath
        if (-not $positive[$context].ok) { throw "RPC positive $context failed: $($positive[$context].reason)" }
    }

    Write-Utf8NoBom (Join-Path $rpcRoot 'scripts/lib/vitest-ci-lanes.mjs') "// genuine binding-scope drift`n"
    [void](Commit-All -Root $rpcRoot -Message 'genuine RPC scope drift')
    $negative = @{}
    foreach ($context in @('pr', 'push')) {
        $negative[$context] = Invoke-RpcProbe -FixtureRoot $rpcRoot -Context $context -BaseSha $capture -ProbePath $probePath -ValidatorPath $validatorPath
        if ($negative[$context].ok) { throw "RPC negative $context unexpectedly passed" }
    }
    if (($negative.pr.stalePaths -join '|') -ne ($negative.push.stalePaths -join '|')) {
        throw 'RPC negative control produced different PR/push stale paths'
    }

    Write-Host "[PASS] issue #823 PR/main parity and negative controls (historical PR $historicalPrHead, post-merge main $historicalMain)"
    exit 0
}
finally {
    foreach ($path in $tempRoots) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}
