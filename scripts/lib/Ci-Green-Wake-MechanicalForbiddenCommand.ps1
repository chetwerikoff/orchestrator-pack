#requires -Version 5.1
<#
.SYNOPSIS
  CI-green wake reconciler may ao send workers but must not spawn, claim-pr, or kill.
#>

function Test-CiGreenWakeMechanicalForbiddenCommand {
    param([string]$CommandLine)

    $blocked = @(
        'ao spawn',
        '--claim-pr',
        'ao session kill'
    )
    foreach ($frag in $blocked) {
        if ($CommandLine -match [regex]::Escape($frag)) {
            throw "forbidden lifecycle fragment in command: $frag"
        }
    }
}
