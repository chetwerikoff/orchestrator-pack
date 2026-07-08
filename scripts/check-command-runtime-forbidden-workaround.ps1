#requires -Version 5.1
<#
  Static guard: forbid temp gh wrappers, GraphQL/curl bypasses, and recovery duplication (Issue #532).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$GuardScript = Join-Path $Root 'scripts/lib/command-runtime-bootstrap.mjs'

function Invoke-CommandRuntimeGuard {
    param(
        [string]$FilePath,
        [ValidateSet('workaround', 'recovery')]
        [string]$Mode
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        return @()
    }

    $subcommand = if ($Mode -eq 'recovery') { 'scanRecovery' } else { 'scanWorkaround' }
    $output = & node $GuardScript $subcommand $FilePath 2>&1
    if ($LASTEXITCODE -eq 0) {
        return @()
    }

    try {
        return @($output | ConvertFrom-Json)
    }
    catch {
        throw "command-runtime forbidden-workaround guard failed for ${FilePath}: $output"
    }
}

$workaroundRoots = @(
    (Join-Path $Root 'AGENTS.md'),
    (Join-Path $Root 'prompts/investigate_root_cause.md'),
    (Join-Path $Root 'agent-orchestrator.yaml.example')
)

$recoveryRoots = @(
    (Join-Path $Root 'scripts/lib/command-runtime-bootstrap.mjs'),
    (Join-Path $Root 'scripts/orchestrator-command-runtime-preflight.ps1'),
    (Join-Path $Root 'scripts/check-command-runtime-bootstrap.ps1')
)

$violations = @()
foreach ($file in $workaroundRoots) {
    $violations += Invoke-CommandRuntimeGuard -FilePath $file -Mode 'workaround'
}
foreach ($file in $recoveryRoots) {
    $violations += Invoke-CommandRuntimeGuard -FilePath $file -Mode 'recovery'
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] command-runtime forbidden-workaround guard:'
    foreach ($item in $violations) {
        $marker = if ($item.id) { $item.id } else { $item.pattern }
        Write-Host "$($item.file): $marker :: $($item.line)"
    }
    exit 1
}

Write-Host '[PASS] command-runtime forbidden-workaround static guard (Issue #532)'
exit 0
