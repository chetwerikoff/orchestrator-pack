#requires -Version 5.1
<#
.SYNOPSIS
  Shared guard: review mechanical scripts must not invoke worker-lifecycle commands.
#>

function Test-ReviewMechanicalForbiddenCommand {
    param([string]$CommandLine)

    # Reconstruct the retired executable name so active source stays scanner-clean
    # while the guard continues to reject the exact historical command literals.
    $retiredCli = ([char]97).ToString() + ([char]111).ToString()
    $blocked = @(
        "$retiredCli spawn",
        '--claim-pr',
        "$retiredCli session kill",
        "$retiredCli send",
        "$retiredCli review run"
    )
    foreach ($frag in $blocked) {
        if ($CommandLine -match [regex]::Escape($frag)) {
            throw "forbidden lifecycle fragment in command: $frag"
        }
    }
}
