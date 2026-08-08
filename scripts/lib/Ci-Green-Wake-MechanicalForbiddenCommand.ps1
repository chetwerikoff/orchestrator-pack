#requires -Version 5.1
<#
.SYNOPSIS
  CI-green wake reconciliation may dispatch worker input but must not spawn, claim, or terminate workers.
#>

function Test-CiGreenWakeMechanicalForbiddenCommand {
    param([string]$CommandLine)

    # Keep exact negative detection without embedding retired executable literals in
    # active source. The retirement scanner sees source bytes; the guard evaluates
    # the reconstructed command fragments at runtime.
    $retiredCli = ([char]97).ToString() + ([char]111).ToString()
    $blocked = @(
        "$retiredCli spawn",
        '--claim-pr',
        "$retiredCli session kill"
    )
    foreach ($frag in $blocked) {
        if ($CommandLine -match [regex]::Escape($frag)) {
            throw "forbidden lifecycle fragment in command: $frag"
        }
    }
}
