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
    $output = (& git -C $Root show "$Ref`:$Path" 2>$null | Out-String)
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

$resolver = Join-Path $Root 'scripts/lib/Resolve-MergeStableCiBase.ps1'
if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
    throw "missing merge-stable base resolver: $resolver"
}
. $resolver
$base = Resolve-MergeStableCiBase -RepoRoot $Root

$failures = [System.Collections.Generic.List[string]]::new()
foreach ($surface in $requiredSurfaces) {
    foreach ($ref in @([string]$base.BaseSha, 'HEAD')) {
        $failure = Test-RequiredSurfaceAtRef -Ref $ref -Surface $surface
        if ($failure) { $failures.Add($failure) }
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] side-process registry sequencing guard: semantic prerequisites are absent or drifted'
    foreach ($failure in $failures) { Write-Host "  - $failure" }
    exit 1
}

Write-Host "[PASS] side-process registry sequencing guard: #709/#711 semantic surfaces are present at base $($base.BaseSha) and HEAD."
exit 0
