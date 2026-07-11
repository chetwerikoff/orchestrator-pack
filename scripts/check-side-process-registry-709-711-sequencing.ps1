#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$requiredCommits = @{
    '709' = '7ccf7396'
    '711' = 'afa96f0d'
}

Push-Location $Root
try {
    $mergeBase = (& git merge-base HEAD origin/main).Trim()
    if (-not $mergeBase) {
        throw 'unable to resolve merge-base with origin/main'
    }

    $missing = [System.Collections.Generic.List[string]]::new()
    foreach ($issue in $requiredCommits.Keys) {
        $commit = $requiredCommits[$issue]
        & git merge-base --is-ancestor $commit $mergeBase
        if ($LASTEXITCODE -ne 0) {
            $missing.Add("#$issue@$commit")
        }
    }

    if ($missing.Count -gt 0) {
        Write-Host "[FAIL] side-process registry sequencing guard: merge-base $mergeBase predates required registry prerequisites"
        foreach ($entry in $missing) {
            Write-Host "  - missing prerequisite $entry"
        }
        exit 1
    }

    Write-Host "[PASS] side-process registry sequencing guard: merge-base $mergeBase includes #709 and #711 prerequisite commits."
    exit 0
}
finally {
    Pop-Location
}
