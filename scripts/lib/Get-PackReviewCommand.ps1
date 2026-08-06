#requires -Version 5.1
<#
.SYNOPSIS
  Pack review command and reviewer-wrapper fixture validation helpers.
#>
. (Join-Path $PSScriptRoot 'Resolve-PackReviewer.ps1')

$Script:PackReviewAgnosticEntryBasename = 'invoke-pack-review.ps1'

function Test-WrapperScriptInRunBody {
    param(
        [string]$Basename,
        [string]$RunBody
    )

    if ([string]::IsNullOrWhiteSpace($Basename) -or [string]::IsNullOrWhiteSpace($RunBody)) {
        return $false
    }
    return $RunBody -match [regex]::Escape($Basename)
}

function Get-ReviewerFromRunBody {
    param([string]$RunBody)

    if ([string]::IsNullOrWhiteSpace($RunBody)) { return $null }
    if (Test-WrapperScriptInRunBody -Basename 'run-pack-review-claude.ps1' -RunBody $RunBody) { return 'claude' }
    if (Test-WrapperScriptInRunBody -Basename 'run-pack-review-gpt.ts' -RunBody $RunBody) { return 'gpt' }
    if (Test-WrapperScriptInRunBody -Basename 'run-pack-review.ps1' -RunBody $RunBody) { return 'codex' }
    return $null
}

function Get-ReviewScriptBasenameFromCommand {
    param([string]$ReviewCommand)

    if ([string]::IsNullOrWhiteSpace($ReviewCommand)) { return $null }
    if ($ReviewCommand -match '([^\\/]+\.(?:ps1|mjs|ts))') { return $Matches[1] }
    return $null
}

function Get-ExpectedPackReviewer {
    param(
        [string]$ExpectedReviewer,
        [string]$ReviewCommand,
        [switch]$FixtureMode
    )

    if (-not [string]::IsNullOrWhiteSpace($ExpectedReviewer)) {
        $normalized = $ExpectedReviewer.Trim().ToLowerInvariant()
        if ($Script:PackReviewerWrapperById.ContainsKey($normalized)) { return $normalized }
    }

    $entryBasename = Get-ReviewScriptBasenameFromCommand -ReviewCommand $ReviewCommand
    if ($entryBasename -eq $Script:PackReviewAgnosticEntryBasename) {
        if ($FixtureMode) { return $null }
        return Get-PackReviewerFromSelector
    }
    if ($entryBasename -eq 'run-pack-review-claude.ps1') { return 'claude' }
    if ($entryBasename -eq 'run-pack-review.ps1') { return 'codex' }
    return $null
}

function Test-ReviewCommandInRunBody {
    param(
        [string]$ReviewCommand,
        [string]$RunBody
    )

    if ([string]::IsNullOrWhiteSpace($ReviewCommand) -or [string]::IsNullOrWhiteSpace($RunBody)) {
        return $null
    }

    $scriptName = Get-ReviewScriptBasenameFromCommand -ReviewCommand $ReviewCommand
    if ($scriptName -and -not (Test-WrapperScriptInRunBody -Basename $scriptName -RunBody $RunBody)) {
        return $scriptName
    }
    return $null
}

function Test-PackReviewForbiddenDrift {
    param(
        [string]$ExpectedBasename,
        [string]$RunBody
    )

    if ([string]::IsNullOrWhiteSpace($ExpectedBasename) -or [string]::IsNullOrWhiteSpace($RunBody)) {
        return $null
    }

    if ($ExpectedBasename -eq 'run-pack-review-claude.ps1') {
        if ($RunBody -match '[/\\]review\.ps1\b') { return 'review.ps1' }
        if (Test-WrapperScriptInRunBody -Basename 'run-pack-review.ps1' -RunBody $RunBody) {
            return 'run-pack-review.ps1'
        }
    }
    elseif ($ExpectedBasename -eq 'run-pack-review.ps1') {
        if (Test-WrapperScriptInRunBody -Basename 'run-pack-review-claude.ps1' -RunBody $RunBody) {
            return 'run-pack-review-claude.ps1'
        }
        if ($RunBody -match '[/\\]review\.ps1\b') { return 'review.ps1' }
    }
    return $null
}

function Get-PackReviewGateViolations {
    param(
        [Parameter(Mandatory)][array]$Runs,
        [Parameter(Mandatory)][string]$ReviewCommand,
        [string]$ExpectedReviewer = '',
        [switch]$FixtureMode
    )

    $violations = [System.Collections.Generic.List[object]]::new()
    if (-not $Runs -or $Runs.Count -eq 0) { return @() }

    $latest = $Runs |
        Sort-Object {
            if ($_.completedAt) { [datetime]$_.completedAt }
            else { [datetime]::MinValue }
        } -Descending |
        Select-Object -First 1
    if (-not $latest) { return @() }

    $isEmptyFailed = @('failed', 'cancelled') -contains $latest.status -and
        [int]$latest.findingCount -eq 0 -and
        [int]$latest.openFindingCount -eq 0
    if ($isEmptyFailed) {
        $violations.Add([pscustomobject]@{
            Kind = 'empty-review-trap'
            Message = ('Latest review run is {0} with findingCount=0; not clean (read body)' -f $latest.status)
            Run = $latest
        }) | Out-Null
    }

    $body = [string]$latest.body
    $entryBasename = Get-ReviewScriptBasenameFromCommand -ReviewCommand $ReviewCommand
    $resolvedReviewer = Get-ExpectedPackReviewer `
        -ExpectedReviewer $ExpectedReviewer `
        -ReviewCommand $ReviewCommand `
        -FixtureMode:$FixtureMode
    $usesSelector = $entryBasename -eq $Script:PackReviewAgnosticEntryBasename -or
        -not [string]::IsNullOrWhiteSpace($ExpectedReviewer)

    if ($usesSelector -and -not $resolvedReviewer) {
        $violations.Add([pscustomobject]@{
            Kind = 'selector-mismatch'
            Message = 'PACK_REVIEWER (or fixture expectedReviewer) must be gpt, claude, or codex for the reviewer-neutral command'
            Run = $latest
        }) | Out-Null
    }
    elseif ($usesSelector -and $resolvedReviewer -and [string]::IsNullOrWhiteSpace($body)) {
        $violations.Add([pscustomobject]@{
            Kind = 'selector-mismatch'
            Message = ('body is blank; cannot verify PACK_REVIEWER={0} matched executed wrapper' -f $resolvedReviewer)
            Run = $latest
        }) | Out-Null
    }
    elseif (-not [string]::IsNullOrWhiteSpace($body)) {
        if ($usesSelector) {
            $expectedWrapper = Get-PackReviewWrapperBasenameForReviewer -Reviewer $resolvedReviewer
            $executedReviewer = Get-ReviewerFromRunBody -RunBody $body
            if (-not $executedReviewer) {
                $violations.Add([pscustomobject]@{
                    Kind = 'selector-mismatch'
                    Message = ('body does not name a tracked wrapper for PACK_REVIEWER={0}' -f $resolvedReviewer)
                    Run = $latest
                }) | Out-Null
            }
            elseif ($executedReviewer -ne $resolvedReviewer) {
                $violations.Add([pscustomobject]@{
                    Kind = 'selector-mismatch'
                    Message = ('body executed {0} but PACK_REVIEWER (or fixture) expects {1}' -f $executedReviewer, $resolvedReviewer)
                    Run = $latest
                }) | Out-Null
            }
            elseif (-not (Test-WrapperScriptInRunBody -Basename $expectedWrapper -RunBody $body)) {
                $violations.Add([pscustomobject]@{
                    Kind = 'selector-mismatch'
                    Message = "body does not mention expected wrapper ($expectedWrapper)"
                    Run = $latest
                }) | Out-Null
            }
        }
        else {
            $missingExpected = Test-ReviewCommandInRunBody -ReviewCommand $ReviewCommand -RunBody $body
            if ($missingExpected) {
                $violations.Add([pscustomobject]@{
                    Kind = 'command-drift'
                    Message = "body does not mention configured script ($missingExpected)"
                    Run = $latest
                }) | Out-Null
            }

            $forbidden = Test-PackReviewForbiddenDrift -ExpectedBasename $entryBasename -RunBody $body
            if ($forbidden) {
                $violations.Add([pscustomobject]@{
                    Kind = 'command-drift'
                    Message = ('body names forbidden script ({0}) while review command expects {1}' -f $forbidden, $entryBasename)
                    Run = $latest
                }) | Out-Null
            }
        }
    }

    return $violations.ToArray()
}
