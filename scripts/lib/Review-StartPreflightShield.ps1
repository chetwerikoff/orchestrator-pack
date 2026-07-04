#requires -Version 5.1
<#
  Bounded transient retry shield for review-start fresh-head gh pr view (Issue #584).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Review-StartEnvelopeExternalIo.ps1')
. (Join-Path $PSScriptRoot 'Review-StartClaimLifecycle.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-ReviewStartAudit.ps1')
. (Join-Path $PSScriptRoot 'Gh-PrChecks.ps1')

$Script:ReviewStartPreflightShieldCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-start-preflight-shield.mjs'

function Invoke-ReviewStartPreflightShieldCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewStartPreflightShieldCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-start-preflight-shield' -JsonDepth 30
}

function Get-ReviewStartPreflightShieldMaxAttempts {
    $fromEnv = [string]$env:AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS
    $parsed = 0
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return 4
}

function Get-ReviewStartPreflightShieldWallClockBudgetMs {
    $fromEnv = [string]$env:AO_REVIEW_START_PREFLIGHT_SHIELD_WALL_CLOCK_BUDGET_MS
    $parsed = 0
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return 60_000
}

function Get-ReviewStartPreflightShieldInjectedJitterMs {
    $fromEnv = [string]$env:AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS
    $parsed = -1
    if ($fromEnv -and [int]::TryParse($fromEnv, [ref]$parsed) -and $parsed -ge 0) {
        return $parsed
    }
    return $null
}

function Get-ReviewStartPreflightShieldRemainingClaimMs {
    param([hashtable]$ClaimResult)

    if (-not $ClaimResult -or -not $ClaimResult.acquired) { return $null }
    . (Join-Path $PSScriptRoot 'Review-StartSupervisedGh.ps1')
    return [int](Get-ReviewStartSupervisedGhDeadlineMs -ClaimResult $ClaimResult)
}

function Invoke-ReviewStartPreflightGhSingleCapture {
    param(
        [string]$RepoRoot,
        [int]$PrNumber,
        [hashtable]$ClaimResult = $null
    )

    if ($ClaimResult -and $ClaimResult.acquired) {
        . (Join-Path $PSScriptRoot 'Review-StartSupervisedGh.ps1')
        $transport = Invoke-ReviewStartSupervisedGh -ClaimResult $ClaimResult -RepoRoot $RepoRoot -GhArguments @(
            'pr', 'view', [string]$PrNumber, '--json', 'number,headRefOid,baseRefName,state'
        )
        $parse = if ($transport.ok) {
            Invoke-CommandRuntimeParseStructuredOutput -Stdout $transport.stdout -Stderr $transport.stderr
        }
        else {
            @{ ok = $false; reason = if ($transport.timedOut) { 'preflight_timeout' } else { '' } }
        }
        return @{
            exitCode = [int]$transport.exitCode
            stdout   = [string]$transport.stdout
            stderr   = [string]$transport.stderr
            timedOut = [bool]$transport.timedOut
            parse    = $parse
            supervised = $true
            ownershipLost = ([string]$transport.reason -eq 'claim_ownership_lost')
        }
    }

    $capture = Invoke-GhPrViewStructuredCapture -RepoRoot $RepoRoot -PrNumber $PrNumber
    return @{
        exitCode   = [int]$capture.exitCode
        stdout     = [string]$capture.stdout
        stderr     = [string]$capture.stderr
        timedOut   = $false
        parse      = $capture.parse
        supervised = $false
        ownershipLost = $false
    }
}

function Invoke-ReviewStartPreflightShieldBackoffPause {
    param(
        [hashtable]$ClaimResult,
        [int]$BackoffMs,
        [string]$TransientClass
    )

    if (-not $ClaimResult -or -not $ClaimResult.acquired -or $BackoffMs -le 0) {
        Start-Sleep -Milliseconds ([Math]::Max(1, $BackoffMs))
        return @{ ok = $true }
    }

    $pauseStart = Start-ReviewStartClaimInfraPause -ClaimResult $ClaimResult -SupervisedGhPid 0
    if (-not $pauseStart.ok) {
        return @{ ok = $false; reason = [string]$pauseStart.reason }
    }

    Start-Sleep -Milliseconds ([Math]::Max(1, $BackoffMs))

    $classification = Invoke-ReviewStartPreflightShieldCli -Subcommand 'backoff-classification' -Payload @{
        transientClass = $TransientClass
    }
    $closed = Complete-ReviewStartClaimInfraPause -ClaimResult $ClaimResult -Stderr '' -Classification $classification
    if (-not $closed.ok) {
        return @{ ok = $false; reason = [string]$closed.reason }
    }
    if (-not (Test-ReviewStartClaimOwnership -ClaimResult $ClaimResult)) {
        return @{ ok = $false; reason = 'claim_ownership_lost' }
    }
    return @{ ok = $true }
}

function Invoke-ReviewStartPreflightGhPrView {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [hashtable]$ClaimResult = $null,
        [string]$AuditRoot = ''
    )

    if (-not $AuditRoot) {
        $AuditRoot = Get-OrchestratorReviewStartAuditRoot
    }

    $maxAttempts = Get-ReviewStartPreflightShieldMaxAttempts
    $wallBudgetMs = Get-ReviewStartPreflightShieldWallClockBudgetMs
    $startedMono = Get-ReviewStartMonotonicNowMs
    $attempt = 0
    $lastCapture = $null
    $lastClassification = $null

    while ($true) {
        $attempt++

        if ($ClaimResult -and $ClaimResult.acquired) {
            if (-not (Test-ReviewStartClaimOwnership -ClaimResult $ClaimResult)) {
                return @{
                    openPrs          = @()
                    transportFailure = @{
                        ok           = $false
                        reason       = 'claim_ownership_lost'
                        failureClass = 'infra_transport'
                        exitCode     = if ($lastCapture) { [int]$lastCapture.exitCode } else { -1 }
                        stderr       = if ($lastCapture) { [string]$lastCapture.stderr } else { '' }
                        stdout       = if ($lastCapture) { [string]$lastCapture.stdout } else { '' }
                    }
                }
            }
        }

        $budget = Invoke-ReviewStartPreflightShieldCli -Subcommand 'budget' -Payload @{
            attempt             = $attempt
            maxAttempts         = $maxAttempts
            startedMonotonicMs  = $startedMono
            nowMonotonicMs      = (Get-ReviewStartMonotonicNowMs)
            wallClockBudgetMs   = $wallBudgetMs
            remainingClaimMs    = (Get-ReviewStartPreflightShieldRemainingClaimMs -ClaimResult $ClaimResult)
        }
        if ($attempt -gt 1 -and -not $budget.canRetry) {
            break
        }

        $capture = Invoke-ReviewStartPreflightGhSingleCapture -RepoRoot $RepoRoot -PrNumber $PrNumber -ClaimResult $ClaimResult
        $lastCapture = $capture

        if ($capture.ownershipLost) {
            return @{
                openPrs          = @()
                transportFailure = @{
                    ok           = $false
                    reason       = 'claim_ownership_lost'
                    failureClass = 'infra_transport'
                    exitCode     = [int]$capture.exitCode
                    stderr       = [string]$capture.stderr
                    stdout       = [string]$capture.stdout
                }
            }
        }

        $parseOk = $null
        $parseReason = ''
        if ($capture.parse) {
            $parseOk = [bool]$capture.parse.ok
            $parseReason = [string]$capture.parse.reason
        }

        $classification = Invoke-ReviewStartPreflightShieldCli -Subcommand 'classify' -Payload @{
            exitCode    = [int]$capture.exitCode
            stderr      = [string]$capture.stderr
            stdout      = [string]$capture.stdout
            timedOut    = [bool]$capture.timedOut
            parseOk     = $parseOk
            parseReason = $parseReason
        }
        $lastClassification = $classification

        $headSha = ''
        if ($parseOk -and $capture.parse.value) {
            $headSha = [string]$capture.parse.value.headRefOid
        }

        if ([string]$classification.disposition -eq 'success') {
            $pr = $capture.parse.value
            if (-not $pr -or [string]$pr.state -ne 'OPEN') {
                return @{ openPrs = @(); transportFailure = $null }
            }
            Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
            return @{ openPrs = @($pr); transportFailure = $null }
        }

        if ([string]$classification.disposition -eq 'terminal') {
            Write-ReviewStartPreflightShieldAudit -AuditRoot $AuditRoot -PrNumber $PrNumber -HeadSha $headSha `
                -Attempt $attempt -Disposition 'terminal' -Reason ([string]$classification.reason) `
                -BackoffMs 0 -HeaderDegraded $false | Out-Null
            return @{
                openPrs          = @()
                transportFailure = (New-ReviewStartScopedGhTransportFailure -Capture $capture -Reason ([string]$classification.reason))
            }
        }

        $rateHeaders = @{}
        foreach ($line in ([string]$capture.stderr -split "`n")) {
            if ($line -match '^([\w-]+):\s*(.+)$') {
                $name = $Matches[1].ToLowerInvariant()
                if ($name -eq 'retry-after' -or $name.StartsWith('x-ratelimit-')) {
                    $rateHeaders[$name] = $Matches[2].Trim()
                }
            }
        }

        $backoff = Invoke-ReviewStartPreflightShieldCli -Subcommand 'backoff' -Payload @{
            attempt          = $attempt
            headers          = $rateHeaders
            injectedJitterMs = (Get-ReviewStartPreflightShieldInjectedJitterMs)
            nowMs            = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        $backoffMs = [int]$backoff.backoffMs

        Write-ReviewStartPreflightShieldAudit -AuditRoot $AuditRoot -PrNumber $PrNumber -HeadSha $headSha `
            -Attempt $attempt -Disposition 'transient_retry' -Reason ([string]$classification.reason) `
            -BackoffMs $backoffMs -HeaderDegraded ([bool]$backoff.headerDegraded) `
            -TransientClass ([string]$classification.transientClass) | Out-Null

        $retryBudget = Invoke-ReviewStartPreflightShieldCli -Subcommand 'budget' -Payload @{
            attempt             = $attempt
            maxAttempts         = $maxAttempts
            startedMonotonicMs  = $startedMono
            nowMonotonicMs      = (Get-ReviewStartMonotonicNowMs)
            wallClockBudgetMs   = $wallBudgetMs
            remainingClaimMs    = (Get-ReviewStartPreflightShieldRemainingClaimMs -ClaimResult $ClaimResult)
        }
        if (-not $retryBudget.canRetry) {
            break
        }

        if ($backoffMs -gt $retryBudget.remainingMs) {
            break
        }

        $pause = Invoke-ReviewStartPreflightShieldBackoffPause -ClaimResult $ClaimResult `
            -BackoffMs $backoffMs -TransientClass ([string]$classification.transientClass)
        if (-not $pause.ok) {
            $reason = if ([string]$pause.reason -eq 'claim_ownership_lost') { 'claim_ownership_lost' } else { 'preflight_transient_exhausted' }
            return @{
                openPrs          = @()
                transportFailure = @{
                    ok           = $false
                    reason       = $reason
                    failureClass = 'infra_transport'
                    exitCode     = [int]$capture.exitCode
                    stderr       = [string]$capture.stderr
                    stdout       = [string]$capture.stdout
                }
            }
        }
    }

    $terminalReason = if ($lastClassification) { [string]$lastClassification.reason } else { 'preflight_transient_exhausted' }
    Write-ReviewStartPreflightShieldAudit -AuditRoot $AuditRoot -PrNumber $PrNumber -HeadSha '' `
        -Attempt $attempt -Disposition 'exhausted' -Reason 'preflight_transient_exhausted' `
        -BackoffMs 0 -HeaderDegraded $false -TransientClass $terminalReason | Out-Null

    return @{
        openPrs          = @()
        transportFailure = @{
            ok           = $false
            reason       = 'preflight_transient_exhausted'
            failureClass = 'infra_transport'
            exitCode     = if ($lastCapture) { [int]$lastCapture.exitCode } else { -1 }
            stderr       = if ($lastCapture) { [string]$lastCapture.stderr } else { '' }
            stdout       = if ($lastCapture) { [string]$lastCapture.stdout } else { '' }
            attempts     = $attempt
        }
    }
}
