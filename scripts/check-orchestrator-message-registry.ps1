#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$registryCli = Join-Path $Root 'docs/orchestrator-message-registry.mjs'
$mapPath = Join-Path $Root 'docs/orchestrator-message-map.md'
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

if ($failures.Count -eq 0) {
    & node $registryCli audit $Root
    if ($LASTEXITCODE -ne 0) {
        $failures.Add('registration audit failed (see node output above)')
    }

    & node $registryCli check-protected-runtime $Root origin/main 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $failures.Add('protected runtime diff check failed (see node output above)')
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
