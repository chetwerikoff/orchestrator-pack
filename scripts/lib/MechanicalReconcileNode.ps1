#requires -Version 5.1
<#
.SYNOPSIS
  Shared Node stdin/JSON filter and mechanical state-file helpers for reconcile scripts.
#>

function Invoke-MechanicalNodeFilterCli {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilterCliPath,
        [Parameter(Mandatory = $true)]
        [string]$Subcommand,
        [Parameter(Mandatory = $true)]
        [hashtable]$Payload,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [int]$JsonDepth = 20
    )

    $json = $Payload | ConvertTo-Json -Depth $JsonDepth -Compress
    $output = $json | & node $FilterCliPath $Subcommand 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "${Label}.mjs $Subcommand exited ${LASTEXITCODE}: $output"
    }

    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    return $text | ConvertFrom-Json
}

function Get-MechanicalJsonStateFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [object]$DefaultState
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $DefaultState
    }

    try {
        $raw = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        foreach ($prop in $DefaultState.Keys) {
            if (-not $raw.$prop) {
                $raw | Add-Member -NotePropertyName $prop -NotePropertyValue $DefaultState[$prop] -Force
            }
        }
        return $raw
    }
    catch {
        return $DefaultState
    }
}

function Set-MechanicalJsonStateFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [object]$State,
        [int]$JsonDepth = 20
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $State | ConvertTo-Json -Depth $JsonDepth -Compress | Set-Content -LiteralPath $Path -Encoding utf8
}
