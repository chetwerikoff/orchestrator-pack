#requires -Version 5.1

function Invoke-PackReviewRunnerList {
    [CmdletBinding()]
    param(
        [string]$Project = 'orchestrator-pack',
        [string]$StoreRoot = ''
    )

    $packRoot = [string](Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
    $launcher = Join-Path $packRoot 'scripts/lib/Invoke-TypeScriptCli.ts'
    $runner = Join-Path $packRoot 'scripts/pack-review-runner.ts'
    $args = @(
        '--experimental-strip-types',
        $launcher,
        '--repo-root', $packRoot,
        '--script', $runner,
        '--',
        'list',
        '--project-id', ($(if ($Project) { $Project } else { 'orchestrator-pack' }))
    )
    if ($StoreRoot) { $args += @('--store-root', $StoreRoot) }

    $raw = & node @args 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "pack-review-runner list failed (exit $LASTEXITCODE): $($raw -join [Environment]::NewLine)"
    }
    $text = ($raw | ForEach-Object { [string]$_ }) -join "`n"
    if (-not $text.Trim()) { throw 'pack-review-runner list returned empty stdout' }
    return $text | ConvertFrom-Json
}

function Get-PackReviewRuns {
    [CmdletBinding()]
    param(
        [string]$Project = 'orchestrator-pack',
        [string]$StoreRoot = ''
    )
    return Invoke-PackReviewRunnerList -Project $Project -StoreRoot $StoreRoot
}

function Get-PackReviewRunsFromPayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Payload,
        [string]$Project = 'orchestrator-pack'
    )

    if ($null -eq $Payload) { throw 'pack review payload is null' }
    if ($Payload.PSObject.Properties.Name -contains 'runs') { return @($Payload.runs) }
    if ($Payload.PSObject.Properties.Name -contains 'data') { return @($Payload.data) }
    if ($Payload -is [System.Collections.IEnumerable] -and $Payload -isnot [string]) { return @($Payload) }
    throw "pack review payload for project '$Project' has no runs array"
}
