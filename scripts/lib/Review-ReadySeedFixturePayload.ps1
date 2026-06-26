#requires -Version 5.1
<#
.SYNOPSIS
  Build hashtable fixture payloads for review-ready-report-state-seed tests.
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

function Merge-ReviewReadySeedFixtureObject {
    param(
        [object]$Base,
        [object]$Overlay
    )

    if ($null -eq $Overlay) { return $Base }
    if ($Overlay -isnot [System.Management.Automation.PSCustomObject] -and $Overlay -isnot [hashtable]) {
        return $Overlay
    }

    $merged = @{}
    if ($Base -is [System.Management.Automation.PSCustomObject]) {
        foreach ($prop in $Base.PSObject.Properties) {
            $merged[$prop.Name] = $prop.Value
        }
    }
    elseif ($Base -is [hashtable]) {
        foreach ($key in $Base.Keys) {
            $merged[[string]$key] = $Base[$key]
        }
    }

    foreach ($prop in $Overlay.PSObject.Properties) {
        $name = [string]$prop.Name
        $value = $prop.Value
        if ($null -ne $merged[$name] -and $value -is [System.Management.Automation.PSCustomObject]) {
            $merged[$name] = Merge-ReviewReadySeedFixtureObject -Base $merged[$name] -Overlay $value
        }
        else {
            $merged[$name] = $value
        }
    }
    return [pscustomobject]$merged
}

function Resolve-ReviewReadySeedFixture {
    param([string]$FixturePath)

    $fixtureDir = Split-Path -Parent $FixturePath
    $fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
    if ($fixture.extends) {
        $basePath = Join-Path $fixtureDir ([string]$fixture.extends)
        $base = Get-Content -LiteralPath $basePath -Raw | ConvertFrom-Json
        $fixture = Merge-ReviewReadySeedFixtureObject -Base $base -Overlay $fixture
    }
    return $fixture
}

function Get-ReviewReadySeedFixturePayload {
    param($Fixture)

    $payload = @{
        openPrs    = @($Fixture.openPrs)
        reviewRuns = @($Fixture.reviewRuns)
        sessions   = @($Fixture.sessions)
    }
    foreach ($name in @(
            'ciChecksByPr', 'requiredCheckNamesByPr', 'requiredCheckLookupFailedByPr',
            'bindingByKey', 'seededKeys', 'deferredScanKeys', 'handoffRecords',
            'terminalClaimKeys', 'watchEntries', 'tickCapacity', 'nowMs', 'reviewCommand',
            'supervisedRepoSlug', 'freshSnapshot', 'boundaryRace'
        )) {
        if ($null -ne $Fixture.$name) {
            if ($name -in @(
                    'ciChecksByPr', 'requiredCheckNamesByPr', 'requiredCheckLookupFailedByPr',
                    'bindingByKey', 'handoffRecords', 'watchEntries', 'freshSnapshot'
                )) {
                $payload[$name] = ConvertTo-MechanicalJsonMap -Value $Fixture.$name
            }
            else {
                $payload[$name] = $Fixture.$name
            }
        }
    }
    return $payload
}

function Write-ReviewReadySeedFixtureResult {
    param(
        [hashtable]$Result,
        [string]$Label = 'fixture'
    )

    $Result | ConvertTo-Json -Compress -Depth 20
    if (-not $Result.ok) { exit 1 }
    exit 0
}
