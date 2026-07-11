#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$requiredCommits = @{
    '709' = '7ccf7396'
    '711' = 'afa96f0d'
}

function Resolve-SequencingBaseRef {
    $candidates = @(
        $env:GITHUB_BASE_SHA,
        $env:PR_BASE_SHA,
        'origin/main',
        'refs/remotes/origin/main',
        'main'
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($candidate in $candidates) {
        $resolved = (& git rev-parse --verify --quiet $candidate 2>$null)
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($resolved)) {
            return [string]$candidate
        }
    }

    return $null
}

Push-Location $Root
try {
    $baseRef = Resolve-SequencingBaseRef
    if ([string]::IsNullOrWhiteSpace($baseRef)) {
        throw 'unable to resolve base ref for sequencing guard (tried GITHUB_BASE_SHA, PR_BASE_SHA, origin/main, refs/remotes/origin/main, main)'
    }

    $mergeBaseRaw = (& git merge-base HEAD $baseRef 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($mergeBaseRaw)) {
        throw "unable to resolve merge-base with $baseRef"
    }
    $mergeBase = $mergeBaseRaw.Trim()

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
