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

    $tsxPackage = Join-Path $depsRoot 'node_modules/tsx/package.json'
    if (-not (Test-Path -LiteralPath $tsxPackage)) {
        Push-Location $depsRoot
        try {
            # Bootstrap from trusted-base lockfile only; never run PR-controlled lifecycle scripts.
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

    $loader = Join-Path $depsRoot 'node_modules/tsx/dist/loader.mjs'
    if (-not (Test-Path -LiteralPath $loader)) {
        [Console]::Error.WriteLine("${WrapperName}: tsx loader missing in $depsRoot after npm ci")
        exit 1
    }

    return (Resolve-Path -LiteralPath $loader).Path
}
