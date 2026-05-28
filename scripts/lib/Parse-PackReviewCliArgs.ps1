# Shared CLI flag parsing for scripts/run-pack-review.ps1 (Issue #60).
function Split-PackReviewCliArgs {
    param([string[]]$Argv)

    $repoRoot = '.'
    $base = 'origin/main'
    $forward = [System.Collections.Generic.List[string]]::new()

    for ($i = 0; $i -lt $Argv.Count; $i++) {
        $token = $Argv[$i]
        switch ($token) {
            '--repo-root' {
                if (($i + 1) -ge $Argv.Count) {
                    throw 'Missing value for --repo-root'
                }
                $repoRoot = $Argv[++$i]
                continue
            }
            '--base' {
                if (($i + 1) -ge $Argv.Count) {
                    throw 'Missing value for --base'
                }
                $base = $Argv[++$i]
                continue
            }
            default {
                $forward.Add($token) | Out-Null
            }
        }
    }

    return [pscustomobject]@{
        RepoRoot    = $repoRoot
        Base        = $base
        ForwardArgs = $forward.ToArray()
    }
}
