#requires -Version 5.1
<#
.SYNOPSIS
  Shared guard: review mechanical scripts must not invoke worker-lifecycle commands.
#>

function Test-ReviewMechanicalForbiddenCommand {
    param([string]$CommandLine)

    $blocked = @(
        'ao spawn',
        '--claim-pr',
        'ao session kill',
        'ao send',
        'ao review run'
    )
    foreach ($frag in $blocked) {
        if ($CommandLine -match [regex]::Escape($frag)) {
            throw "forbidden lifecycle fragment in command: $frag"
        }
    }
}
