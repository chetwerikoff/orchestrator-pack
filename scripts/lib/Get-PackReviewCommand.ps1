#requires -Version 5.1
<#
.SYNOPSIS
  Extract NAMED REVIEW_COMMAND from agent-orchestrator YAML (example or live).
#>
. (Join-Path $PSScriptRoot 'Resolve-PackReviewer.ps1')

$Script:PackReviewAgnosticEntryBasename = 'invoke-pack-review.ps1'

function Get-ReviewerFromRunBody {
    param([string]$RunBody)

    if ([string]::IsNullOrWhiteSpace($RunBody)) {
        return $null
    }

    if (Test-WrapperScriptInRunBody -Basename 'run-pack-review-claude.ps1' -RunBody $RunBody) {
        return 'claude'
    }

    if (Test-WrapperScriptInRunBody -Basename 'run-pack-review.ps1' -RunBody $RunBody) {
        return 'codex'
    }

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
        if ($Script:PackReviewerWrapperById.ContainsKey($normalized)) {
            return $normalized
        }
    }

    $entryBasename = Get-ReviewScriptBasenameFromCommand -ReviewCommand $ReviewCommand
    if ($entryBasename -eq $Script:PackReviewAgnosticEntryBasename) {
        if ($FixtureMode) {
            return $null
        }
        return Get-PackReviewerFromSelector
    }

    if ($entryBasename -eq 'run-pack-review-claude.ps1') {
        return 'claude'
    }

    if ($entryBasename -eq 'run-pack-review.ps1') {
        return 'codex'
    }

    return $null
}

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

    $raw = $match.Groups[1].Value.Trim()
    $firstLine = ($raw -split "`r?`n")[0].Trim()
    return $firstLine
}

function Resolve-PackOrchestratorYamlPath {
    param(
        [string]$CliYamlPath = '',
        [string]$PackRoot = ''
    )

    if ($CliYamlPath) {
        return $CliYamlPath
    }
    if (-not $PackRoot) {
        $PackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    $live = Join-Path $PackRoot 'agent-orchestrator.yaml'
    if (Test-Path -LiteralPath $live -PathType Leaf) {
        return $live
    }
    return (Join-Path $PackRoot 'agent-orchestrator.yaml.example')
}

function Test-WrapperScriptInRunBody {
    param(
        [string]$Basename,
        [string]$RunBody
    )

    if ([string]::IsNullOrWhiteSpace($Basename) -or [string]::IsNullOrWhiteSpace($RunBody)) {
        return $false
    }

    $pattern = [regex]::Escape($Basename)
    return $RunBody -match $pattern
}

function Test-ReviewCommandInRunBody {
    param(
        [string]$ReviewCommand,
        [string]$RunBody
    )

    if ([string]::IsNullOrWhiteSpace($ReviewCommand) -or [string]::IsNullOrWhiteSpace($RunBody)) {
        return $null
    }

    $scriptName = $null
    if ($ReviewCommand -match '([^\\/]+\.(?:ps1|mjs|ts))') {
        $scriptName = $Matches[1]
    }

    if ($scriptName -and -not (Test-WrapperScriptInRunBody -Basename $scriptName -RunBody $RunBody)) {
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
        [string]$RunBody
    )

    if ([string]::IsNullOrWhiteSpace($ExpectedBasename) -or [string]::IsNullOrWhiteSpace($RunBody)) {
        return $null
    }

    if ($ExpectedBasename -eq 'run-pack-review-claude.ps1') {
        if ($RunBody -match '[/\\]review\.ps1\b') {
            return 'review.ps1'
        }
        if (Test-WrapperScriptInRunBody -Basename 'run-pack-review.ps1' -RunBody $RunBody) {
            return 'run-pack-review.ps1'
        }
    }
    elseif ($ExpectedBasename -eq 'run-pack-review.ps1') {
        if (Test-WrapperScriptInRunBody -Basename 'run-pack-review-claude.ps1' -RunBody $RunBody) {
            return 'run-pack-review-claude.ps1'
        }
        if ($RunBody -match '[/\\]review\.ps1\b') {
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
        [string]$ReviewCommand,
        [string]$ExpectedReviewer = '',
        [switch]$FixtureMode
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
                Message = ('Latest review run is {0} with findingCount=0; not clean (read body)' -f $latest.status)
                Run     = $latest
            }) | Out-Null
    }

    $reason = [string]$latest.body
    $entryBasename = Get-ReviewScriptBasenameFromCommand -ReviewCommand $ReviewCommand
    $resolvedReviewer = Get-ExpectedPackReviewer -ExpectedReviewer $ExpectedReviewer -ReviewCommand $ReviewCommand -FixtureMode:$FixtureMode
    $usesSelector = ($entryBasename -eq $Script:PackReviewAgnosticEntryBasename) -or
        -not [string]::IsNullOrWhiteSpace($ExpectedReviewer)

    if ($usesSelector -and -not $resolvedReviewer) {
        $violations.Add([pscustomobject]@{
                Kind    = 'selector-mismatch'
                Message = 'PACK_REVIEWER (or fixture expectedReviewer) must be claude or codex for reviewer-agnostic REVIEW_COMMAND'
                Run     = $latest
            }) | Out-Null
    }
    elseif ($usesSelector -and $resolvedReviewer -and [string]::IsNullOrWhiteSpace($reason)) {
        $violations.Add([pscustomobject]@{
                Kind    = 'selector-mismatch'
                Message = ('body is blank; cannot verify PACK_REVIEWER={0} matched executed wrapper' -f $resolvedReviewer)
                Run     = $latest
            }) | Out-Null
    }
    elseif (-not [string]::IsNullOrWhiteSpace($reason)) {
        if ($usesSelector) {
            $expectedWrapper = Get-PackReviewWrapperBasenameForReviewer -Reviewer $resolvedReviewer
            $executedReviewer = Get-ReviewerFromRunBody -RunBody $reason
            if (-not $executedReviewer) {
                $violations.Add([pscustomobject]@{
                        Kind    = 'selector-mismatch'
                        Message = ('body does not name a tracked wrapper for PACK_REVIEWER={0}' -f $resolvedReviewer)
                        Run     = $latest
                    }) | Out-Null
            }
            elseif ($executedReviewer -ne $resolvedReviewer) {
                $violations.Add([pscustomobject]@{
                        Kind    = 'selector-mismatch'
                        Message = ('body executed {0} but PACK_REVIEWER (or fixture) expects {1}' -f $executedReviewer, $resolvedReviewer)
                        Run     = $latest
                    }) | Out-Null
            }
            elseif (-not (Test-WrapperScriptInRunBody -Basename $expectedWrapper -RunBody $reason)) {
                $violations.Add([pscustomobject]@{
                        Kind    = 'selector-mismatch'
                        Message = ("body does not mention expected wrapper ($expectedWrapper)")
                        Run     = $latest
                    }) | Out-Null
            }
        }
        else {
            $basename = $entryBasename
            $missingExpected = Test-ReviewCommandInRunBody -ReviewCommand $ReviewCommand -RunBody $reason
            if ($missingExpected) {
                $violations.Add([pscustomobject]@{
                        Kind    = 'command-drift'
                        Message = "body does not mention configured script ($missingExpected)"
                        Run     = $latest
                    }) | Out-Null
            }

            $forbidden = Test-PackReviewForbiddenDrift -ExpectedBasename $basename -RunBody $reason
            if ($forbidden) {
                $violations.Add([pscustomobject]@{
                        Kind    = 'command-drift'
                        Message = ('body names forbidden script ({0}) while REVIEW_COMMAND expects {1}' -f $forbidden, $basename)
                        Run     = $latest
                    }) | Out-Null
            }
        }
    }

    return $violations.ToArray()
}
