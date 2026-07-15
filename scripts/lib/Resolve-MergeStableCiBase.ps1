Set-StrictMode -Version Latest

function Invoke-MergeStableGitText {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )

    $output = (& git -C $RepoRoot @Arguments 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        if ($AllowFailure) { return $null }
        throw "git $($Arguments -join ' ') failed in $RepoRoot"
    }
    return $output
}

function Resolve-MergeStableCiBase {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [string[]]$CandidateRefs = @()
    )

    $head = Invoke-MergeStableGitText -RepoRoot $RepoRoot -Arguments @('rev-parse', '--verify', 'HEAD^{commit}')
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
        $CandidateRefs
        $env:BASE_SHA
        $env:GITHUB_BASE_SHA
        $env:PR_BASE_SHA
        'origin/main'
        'refs/remotes/origin/main'
        'main'
    )) {
        if ([string]::IsNullOrWhiteSpace([string]$candidate)) { continue }
        $trimmed = ([string]$candidate).Trim()
        if (-not $candidates.Contains($trimmed)) { $candidates.Add($trimmed) }
    }

    foreach ($candidate in $candidates) {
        $candidateCommit = Invoke-MergeStableGitText -RepoRoot $RepoRoot -Arguments @('rev-parse', '--verify', "$candidate^{commit}") -AllowFailure
        if (-not $candidateCommit) { continue }
        $mergeBase = Invoke-MergeStableGitText -RepoRoot $RepoRoot -Arguments @('merge-base', 'HEAD', $candidateCommit) -AllowFailure
        if ($mergeBase -and $mergeBase -ne $head) {
            return [pscustomobject]@{
                BaseRef = $candidate
                BaseSha = $mergeBase
                HeadSha = $head
                Source = 'merge-base'
            }
        }
    }

    $firstParent = Invoke-MergeStableGitText -RepoRoot $RepoRoot -Arguments @('rev-parse', '--verify', 'HEAD^1') -AllowFailure
    if ($firstParent -and $firstParent -ne $head) {
        return [pscustomobject]@{
            BaseRef = 'HEAD^1'
            BaseSha = $firstParent
            HeadSha = $head
            Source = 'first-parent'
        }
    }

    throw 'unable to resolve a non-self CI comparison base'
}
