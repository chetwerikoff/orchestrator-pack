#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$requiredSurfaces = @(
    @{
        Issue = '709'
        Path = 'scripts/lib/Orchestrator-WakeSupervisorLease.ps1'
        Markers = @(
            'State-root singleton lease for wake supervisor fleet cardinality (Issue #709)',
            'function Get-OrchestratorWakeSupervisorLeasePath',
            "'supervisor.lock'"
        )
    },
    @{
        Issue = '711'
        Path = 'scripts/lib/Orchestrator-FleetHygiene.ps1'
        Markers = @(
            'Fleet hygiene assertions H1–H7 (Issue #711)',
            '$Script:FleetHygieneAssertionIds',
            'function Get-FleetHygieneConfig'
        )
    }
)

function Get-TrackedTextAtRef {
    param(
        [Parameter(Mandatory = $true)][string]$Ref,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $output = (& git show "$Ref`:$Path" 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0) { return $null }
    return $output
}

function Test-RequiredSurfaceAtRef {
    param(
        [Parameter(Mandatory = $true)][string]$Ref,
        [Parameter(Mandatory = $true)][hashtable]$Surface
    )
    $text = Get-TrackedTextAtRef -Ref $Ref -Path $Surface.Path
    if ($null -eq $text) {
        return "#$($Surface.Issue): missing $($Surface.Path) at $Ref"
    }
    foreach ($marker in $Surface.Markers) {
        if (-not $text.Contains($marker)) {
            return "#$($Surface.Issue): $($Surface.Path) at $Ref lacks semantic prerequisite marker: $marker"
        }
    }
    return $null
}

Push-Location $Root
try {
    $resolver = Join-Path $Root 'scripts/lib/resolve-merge-stable-ci-base.ts'
    if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
        throw "missing merge-stable base resolver: $resolver"
    }

    $baseJson = (& node --experimental-strip-types $resolver --repo-root $Root --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        Write-Host $baseJson
        throw 'side-process registry sequencing guard could not resolve a non-self comparison base'
    }
    $base = $baseJson | ConvertFrom-Json

    $failures = [System.Collections.Generic.List[string]]::new()
    foreach ($surface in $requiredSurfaces) {
        foreach ($ref in @([string]$base.baseSha, 'HEAD')) {
            $failure = Test-RequiredSurfaceAtRef -Ref $ref -Surface $surface
            if ($failure) { $failures.Add($failure) }
        }
    }

    if ($failures.Count -gt 0) {
        Write-Host '[FAIL] side-process registry sequencing guard: semantic prerequisites are absent or drifted'
        foreach ($failure in $failures) { Write-Host "  - $failure" }
        exit 1
    }

    Write-Host "[PASS] side-process registry sequencing guard: #709/#711 semantic surfaces are present at base $($base.baseSha) and HEAD."
    exit 0
}
finally {
    Pop-Location
}
