#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$requiredCommits = @{
    '709' = '7ccf7396'
    '711' = 'afa96f0d'
}

function Resolve-SequencingBaseRef {
    $eventBaseSha = ''
    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_EVENT_PATH) -and (Test-Path -LiteralPath $env:GITHUB_EVENT_PATH -PathType Leaf)) {
        try {
            $event = Get-Content -LiteralPath $env:GITHUB_EVENT_PATH -Raw | ConvertFrom-Json -Depth 20
            if ($event.pull_request.base.sha) {
                $eventBaseSha = [string]$event.pull_request.base.sha
            }
        }
        catch {
            $eventBaseSha = ''
        }
    }

    $candidates = @(
        $env:BASE_SHA,
        $env:GITHUB_BASE_SHA,
        $env:PR_BASE_SHA,
        $eventBaseSha,
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
        Write-Host '[SKIP] side-process registry sequencing guard: unable to resolve base ref (tried BASE_SHA, GITHUB_BASE_SHA, PR_BASE_SHA, GITHUB_EVENT_PATH pull_request.base.sha, origin/main, refs/remotes/origin/main, main)'
        exit 0
    }

    $mergeBaseRaw = (& git merge-base HEAD $baseRef 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($mergeBaseRaw)) {
        Write-Host "[SKIP] side-process registry sequencing guard: unable to resolve merge-base with $baseRef"
        exit 0
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
