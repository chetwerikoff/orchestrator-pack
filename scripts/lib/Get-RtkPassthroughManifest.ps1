#requires -Version 7.0

function Get-RtkPassthroughManifest {
    <#
    .SYNOPSIS
      Load a JSON passthrough manifest from scripts/.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('pack', 'upstream')]
        [string]$Kind,

        [string]$ScriptsRoot = $PSScriptRoot
    )

    if ($Kind -eq 'pack') {
        $fileName = 'rtk-passthrough-pack.manifest.json'
    }
    else {
        $fileName = 'rtk-passthrough-upstream-defaults.manifest.json'
    }

    $root = if ($ScriptsRoot -match '[\\/]lib$') {
        Split-Path -Parent $ScriptsRoot
    }
    else {
        $ScriptsRoot
    }

    $path = Join-Path $root $fileName
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Manifest not found: $path"
    }

    $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    $doc = $raw | ConvertFrom-Json
    if (-not $doc.patterns) {
        throw "Manifest missing patterns array: $path"
    }

    $patterns = @($doc.patterns | ForEach-Object { [string]$_ } | Where-Object { $_ -and $_.Trim() })
    return [pscustomobject]@{
        Path     = $path
        Patterns = $patterns
        Document = $doc
    }
}

function Get-RtkPackFamilyChecklist {
    <#
    .SYNOPSIS
      Canonical five-family checklist for pack RTK passthrough (Issue #145).
      Each family must be covered by at least one manifest pattern (exact or required set).
    #>
    [CmdletBinding()]
    param()

    return @(
        [pscustomobject]@{
            Id       = 'git-diff'
            Label    = 'git diff'
            Required = @('git diff')
        },
        [pscustomobject]@{
            Id       = 'git-log'
            Label    = 'git log'
            Required = @('git log')
        },
        [pscustomobject]@{
            Id       = 'gh-pr-checks'
            Label    = 'gh pr checks'
            Required = @('gh pr checks')
        },
        [pscustomobject]@{
            Id       = 'ao-subcommands'
            Label    = 'ao * (all ao subcommands)'
            Required = @('ao ')
        },
        [pscustomobject]@{
            Id       = 'ao-declare'
            Label    = 'ao-declare (executable and npx)'
            Required = @('ao-declare', 'npx ao-declare')
        }
    )
}

function Test-RtkPackFamilyCoverage {
    param(
        [Parameter(Mandatory)]
        [string[]]$ManifestPatterns
    )

    $missing = New-Object System.Collections.Generic.List[string]
    foreach ($family in Get-RtkPackFamilyChecklist) {
        foreach ($required in $family.Required) {
            if ($ManifestPatterns -notcontains $required) {
                $missing.Add(('{0} :: missing pattern "{1}"' -f $family.Id, $required)) | Out-Null
            }
        }
    }
    return $missing
}
