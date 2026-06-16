function Resolve-ReadDelegationCheckRepoRoot {
    param(
        [string]$RepoRoot,
        [string]$ScriptRoot
    )
    if ($RepoRoot) {
        return $RepoRoot
    }
    return Split-Path -Parent $ScriptRoot
}
