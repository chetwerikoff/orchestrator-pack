#requires -Version 5.1
<#
.SYNOPSIS
  First-send review reconciler may ao review send but must not spawn, claim-pr, kill, send, or report.
#>

function Test-ReviewSendMechanicalForbiddenCommand {
    param([string]$CommandLine)

    $blocked = @(
        'ao spawn',
        'claim-pr',
        'ao session kill',
        'ao send',
        'ao report',
        'ao review run'
    )
    foreach ($frag in $blocked) {
        if ($CommandLine -match [regex]::Escape($frag)) {
            throw "forbidden lifecycle fragment in command: $frag"
        }
    }
}
