function Ensure-ReverifyWorkspaceDeps {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [string]$WrapperName,
        [string]$TrustedBaseRoot
    )

    $trustedRoot = if ([string]::IsNullOrWhiteSpace($TrustedBaseRoot)) {
        $RepoRoot
    } else {
        $TrustedBaseRoot
    }

    $depsRoot = $trustedRoot
    if (-not (Test-Path -LiteralPath (Join-Path $trustedRoot 'package.json'))) {
        $depsRoot = $RepoRoot
    }

    $workspaceMarker = Join-Path $depsRoot 'node_modules/@orchestrator-pack/shared/package.json'
    if (-not (Test-Path -LiteralPath $workspaceMarker -PathType Leaf)) {
        Push-Location $depsRoot
        try {
            # Bootstrap from the trusted lockfile only; never run PR-controlled lifecycle scripts.
            npm ci --include=dev --ignore-scripts --loglevel=error --no-audit 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                [Console]::Error.WriteLine("${WrapperName}: npm ci failed in trusted base (exit $LASTEXITCODE)")
                exit $LASTEXITCODE
            }
        }
        finally {
            Pop-Location
        }
    }

    if (-not (Test-Path -LiteralPath $workspaceMarker -PathType Leaf)) {
        [Console]::Error.WriteLine("${WrapperName}: workspace dependencies missing in $depsRoot after npm ci")
        exit 1
    }

    return $depsRoot
}
