# Installs pack review dependencies without writing to stdout.
# AO treats REVIEW_COMMAND stdout as review findings — npm ci summary must not leak.
function Install-PackReviewDependencies {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WrapperName
    )

    npm ci --include=dev --loglevel=error --no-audit 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine("${WrapperName}: npm ci failed (exit $LASTEXITCODE)")
        exit $LASTEXITCODE
    }
}
