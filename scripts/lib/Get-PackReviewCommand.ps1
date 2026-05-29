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

function Test-WrapperScriptInTerminationReason {
    param(
        [string]$Basename,
        [string]$TerminationReason
    )

    if ([string]::IsNullOrWhiteSpace($Basename) -or [string]::IsNullOrWhiteSpace($TerminationReason)) {
        return $false
    }

    $pattern = [regex]::Escape($Basename)
    return $TerminationReason -match $pattern
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

    if ($scriptName -and -not (Test-WrapperScriptInTerminationReason -Basename $scriptName -TerminationReason $TerminationReason)) {
        return $scriptName
    }

    return $null
}

function Get-ReviewScriptBasenameFromCommand {
    param([string]$ReviewCommand)

    if ([string]::IsNullOrWhiteSpace($ReviewCommand)) {
        return $null
    }

    if ($ReviewCommand -match '([^\\/]+\.(?:ps1|mjs|ts))') {
        return $Matches[1]
    }

    return $null
}

function Test-PackReviewForbiddenDrift {
    param(
        [string]$ExpectedBasename,
        [string]$TerminationReason
    )

    if ([string]::IsNullOrWhiteSpace($ExpectedBasename) -or [string]::IsNullOrWhiteSpace($TerminationReason)) {
        return $null
    }

    if ($ExpectedBasename -eq 'run-pack-review-claude.ps1') {
        if ($TerminationReason -match '[/\\]review\.ps1\b') {
            return 'review.ps1'
        }
        if (Test-WrapperScriptInTerminationReason -Basename 'run-pack-review.ps1' -TerminationReason $TerminationReason) {
            return 'run-pack-review.ps1'
        }
    }
    elseif ($ExpectedBasename -eq 'run-pack-review.ps1') {
        if (Test-WrapperScriptInTerminationReason -Basename 'run-pack-review-claude.ps1' -TerminationReason $TerminationReason) {
            return 'run-pack-review-claude.ps1'
        }
        if ($TerminationReason -match '[/\\]review\.ps1\b') {
            return 'review.ps1'
        }
    }

    return $null
}

function Get-PackReviewGateViolations {
    param(
        [Parameter(Mandatory)]
        [array]$Runs,
        [Parameter(Mandatory)]
        [string]$ReviewCommand
    )

    $violations = [System.Collections.Generic.List[object]]::new()
    if (-not $Runs -or $Runs.Count -eq 0) {
        return @()
    }

    $latest = $Runs |
        Sort-Object {
            if ($_.completedAt) { [datetime]$_.completedAt }
            else { [datetime]::MinValue }
        } -Descending |
        Select-Object -First 1

    if (-not $latest) {
        return @()
    }

    $isEmptyFailed = @('failed', 'cancelled') -contains $latest.status -and
        [int]$latest.findingCount -eq 0 -and
        [int]$latest.openFindingCount -eq 0

    if ($isEmptyFailed) {
        $violations.Add([pscustomobject]@{
                Kind    = 'empty-review-trap'
                Message = ('Latest review run is {0} with findingCount=0; not clean (read terminationReason)' -f $latest.status)
                Run     = $latest
            }) | Out-Null
    }

    $reason = [string]$latest.terminationReason
    if (-not [string]::IsNullOrWhiteSpace($reason)) {
        $basename = Get-ReviewScriptBasenameFromCommand -ReviewCommand $ReviewCommand
        $missingExpected = Test-ReviewCommandInTerminationReason -ReviewCommand $ReviewCommand -TerminationReason $reason
        if ($missingExpected) {
            $violations.Add([pscustomobject]@{
                    Kind    = 'command-drift'
                    Message = "terminationReason does not mention configured script ($missingExpected)"
                    Run     = $latest
                }) | Out-Null
        }

        $forbidden = Test-PackReviewForbiddenDrift -ExpectedBasename $basename -TerminationReason $reason
        if ($forbidden) {
            $violations.Add([pscustomobject]@{
                    Kind    = 'command-drift'
                    Message = ('terminationReason names forbidden script ({0}) while REVIEW_COMMAND expects {1}' -f $forbidden, $basename)
                    Run     = $latest
                }) | Out-Null
        }
    }

    return $violations.ToArray()
}
