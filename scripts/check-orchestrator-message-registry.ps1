#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$registryCli = Join-Path $Root 'docs/orchestrator-message-registry.mjs'
$mapPath = Join-Path $Root 'docs/orchestrator-message-map.md'
$baseResolver = Join-Path $Root 'scripts/lib/resolve-merge-stable-ci-base.mjs'
$failures = [System.Collections.Generic.List[string]]::new()

if ($IsWindows -and -not $env:WSL_DISTRO_NAME) {
    $failures.Add('unsupported host: native Windows execution is refused (use Linux/WSL + pwsh 7+)')
}
elseif ($PSVersionTable.PSEdition -eq 'Desktop') {
    $failures.Add('unsupported host: Windows PowerShell is refused (use pwsh 7+ on Linux/WSL)')
}

if (-not (Test-Path -LiteralPath $registryCli -PathType Leaf)) {
    $failures.Add("missing registry cli: $registryCli")
}
if (-not (Test-Path -LiteralPath $baseResolver -PathType Leaf)) {
    $failures.Add("missing merge-stable base resolver: $baseResolver")
}

if ($failures.Count -eq 0) {
    & node $registryCli audit $Root
    if ($LASTEXITCODE -ne 0) {
        $failures.Add('registration audit failed (see node output above)')
    }

    $candidateArgs = @()
    if ($env:ORCHESTRATOR_MESSAGE_REGISTRY_BASE_REF) {
        $candidateArgs = @('--candidate', $env:ORCHESTRATOR_MESSAGE_REGISTRY_BASE_REF.Trim())
    }
    $baseRef = (& node $baseResolver --repo-root $Root @candidateArgs 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($baseRef)) {
        if ($baseRef) { Write-Host $baseRef }
        $failures.Add('protected runtime diff check could not resolve a non-self comparison base')
    }
    else {
        $protectedRuntimeOut = & node $registryCli check-protected-runtime $Root $baseRef 2>&1
        if ($LASTEXITCODE -ne 0) {
            if ($protectedRuntimeOut) { Write-Host $protectedRuntimeOut }
            $failures.Add('protected runtime diff check failed (see node output above)')
        }
    }

    $generated = (& node $registryCli generate-map $Root 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        $failures.Add('map generation failed')
    }
    elseif (-not (Test-Path -LiteralPath $mapPath -PathType Leaf)) {
        $failures.Add("missing committed map: $mapPath")
    }
    elseif ((Get-Content -LiteralPath $mapPath -Raw) -ne $generated) {
        $failures.Add('committed orchestrator message map differs from regenerated output')
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] orchestrator message registry guard:'
    foreach ($f in $failures) { Write-Host "  - $f" }
    exit 1
}

Write-Host '[PASS] orchestrator message registry audit and committed map OK.'
exit 0
