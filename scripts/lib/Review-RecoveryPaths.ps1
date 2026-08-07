# Runtime-neutral review workspace path helpers retained after liveness retirement.

function Get-ReviewRecoveryProjectDirFromRepoRoot {
    param([string]$RepoRoot)
    if (-not $RepoRoot) { return $null }
    $resolved = (Resolve-Path -LiteralPath $RepoRoot).Path
    $dir = [System.IO.DirectoryInfo]::new($resolved)
    while ($dir -and $dir.Parent) {
        if ($dir.Parent.Name -eq 'workspaces' -and $dir.Parent.Parent -and $dir.Parent.Parent.Name -eq 'code-reviews') {
            return $dir.Parent.Parent.Parent.FullName
        }
        $dir = $dir.Parent
    }
    return $null
}

function Get-ReviewRecoveryStoreDirFromRepoRoot {
    param([string]$RepoRoot)
    $projectDir = Get-ReviewRecoveryProjectDirFromRepoRoot -RepoRoot $RepoRoot
    if (-not $projectDir) { return $null }
    return Join-Path $projectDir 'code-reviews'
}

function Get-ReviewRecoveryReviewerSessionIdFromRepoRoot {
    param([string]$RepoRoot)
    if (-not $RepoRoot) { return $null }
    $resolved = (Resolve-Path -LiteralPath $RepoRoot).Path
    $dir = [System.IO.DirectoryInfo]::new($resolved)
    while ($dir -and $dir.Parent) {
        if ($dir.Parent.Name -eq 'workspaces' -and $dir.Parent.Parent -and $dir.Parent.Parent.Name -eq 'code-reviews') {
            return $dir.Name
        }
        $dir = $dir.Parent
    }
    return $null
}
