#requires -Version 5.1

function Get-SupervisedRepoSlug {
    param([string]$RepoRoot)

    if (-not $RepoRoot) { return '' }
    Push-Location -LiteralPath $RepoRoot
    try {
        $remote = git remote get-url origin 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $remote) { return '' }
        if ($remote -match 'github\.com[:/](?<owner>[^/\s#?]+)/(?<repo>[^/\s#?]+)') {
            $repo = [string]$Matches['repo']
            if ($repo.EndsWith('.git', [System.StringComparison]::OrdinalIgnoreCase)) {
                $repo = $repo.Substring(0, $repo.Length - 4)
            }
            return "$($Matches['owner'])/$repo".ToLower()
        }
        return ''
    }
    finally {
        Pop-Location
    }
}
