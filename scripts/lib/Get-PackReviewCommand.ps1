#requires -Version 5.1
<#
.SYNOPSIS
  Extract NAMED REVIEW_COMMAND from agent-orchestrator YAML (example or live).
#>
function Get-PackReviewCommandFromYaml {
    param(
        [Parameter(Mandatory)]
        [string]$YamlPath
    )

    if (-not (Test-Path -LiteralPath $YamlPath -PathType Leaf)) {
        return $null
    }

    $text = Get-Content -LiteralPath $YamlPath -Raw
  $match = [regex]::Match(
        $text,
        '(?ms)NAMED\s+REVIEW_COMMAND[^\r\n]*\r?\n\s+(.+?)(?:\r?\n\s+Alternate|\r?\n\s+RUNTIME|\r?\n\s+[A-Z]{2,})'
    )
    if (-not $match.Success) {
        return $null
    }

    return $match.Groups[1].Value.Trim()
}

function Test-ReviewCommandInTerminationReason {
    param(
        [string]$ReviewCommand,
        [string]$TerminationReason
    )

    if ([string]::IsNullOrWhiteSpace($ReviewCommand) -or [string]::IsNullOrWhiteSpace($TerminationReason)) {
        return $null
    }

    $scriptName = $null
    if ($ReviewCommand -match '([^\\/]+\.(?:ps1|mjs|ts))') {
        $scriptName = $Matches[1]
    }

    if ($scriptName -and $TerminationReason -notlike "*$scriptName*") {
        return $scriptName
    }

    return $null
}
