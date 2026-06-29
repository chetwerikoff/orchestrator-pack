#requires -Version 5.1
<#
  Cross-attempt review-start envelope ledger bridge (Issue #516).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

$Script:ReviewStartEnvelopeLedgerCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-start-envelope-ledger.mjs'

function Invoke-ReviewStartEnvelopeLedgerCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewStartEnvelopeLedgerCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-start-envelope-ledger' -JsonDepth 30
}

function Get-ReviewStartEnvelopeLedgerPath {
    param([string]$Namespace)
    if (-not $Namespace) { throw 'Get-ReviewStartEnvelopeLedgerPath requires Namespace' }
    return Join-Path $Namespace 'envelope-ledger.json'
}

function Get-ReviewStartEnvelopeLedgerLockPath {
    param([string]$LedgerPath)
    return "$LedgerPath.lock"
}

function Get-ReviewStartEnvelopeLedgerEscalationThreshold {
    $raw = [string]$env:AO_REVIEW_START_CONSECUTIVE_FAILURE_ESCALATE_THRESHOLD
    if ($raw) {
        $parsed = 0
        if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
    }
    return 3
}

function Invoke-ReviewStartEnvelopeLedgerLocked {
    param(
        [string]$LedgerPath,
        [scriptblock]$Action
    )

    $dir = Split-Path -Parent $LedgerPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $lockPath = Get-ReviewStartEnvelopeLedgerLockPath -LedgerPath $LedgerPath
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        try {
            $lock = New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop
            $owner = @{
                pid           = $PID
                processGuid   = [guid]::NewGuid().ToString('n')
                acquiredAtUtc = (Get-Date).ToUniversalTime().ToString('o')
            }
            ($owner | ConvertTo-Json -Compress) | Set-Content -LiteralPath (Join-Path $lockPath '.owner') -Encoding UTF8
            try {
                $ledger = @{}
                if (Test-Path -LiteralPath $LedgerPath -PathType Leaf) {
                    $ledger = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json
                    if ($ledger.entries) {
                        $entries = @{}
                        foreach ($prop in $ledger.entries.PSObject.Properties) {
                            $entries[$prop.Name] = $prop.Value
                        }
                        $ledger = @{ schemaVersion = $ledger.schemaVersion; entries = $entries }
                    }
                }
                $result = & $Action $ledger
                $shouldPersist = $false
                $ledgerToPersist = $null
                if ($result -is [hashtable]) {
                    $shouldPersist = [bool]$result.persist -and $null -ne $result.ledger
                    $ledgerToPersist = $result.ledger
                }
                elseif ($null -ne $result -and ($result.PSObject.Properties.Name -contains 'persist')) {
                    $shouldPersist = [bool]$result.persist -and $null -ne $result.ledger
                    $ledgerToPersist = $result.ledger
                }
                if ($shouldPersist -and $ledgerToPersist) {
                    ($ledgerToPersist | ConvertTo-Json -Compress -Depth 30) | Set-Content -LiteralPath $LedgerPath -Encoding UTF8
                }
                return $result
            }
            finally {
                Remove-Item -LiteralPath $lockPath -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        catch [System.IO.IOException] {
            Start-Sleep -Milliseconds 25
        }
    }
    throw "timed out acquiring review-start envelope ledger lock: $lockPath"
}

function Read-ReviewStartEnvelopeLedgerEntry {
    param(
        [string]$Namespace,
        [int]$PrNumber,
        [string]$HeadSha
    )

    $path = Get-ReviewStartEnvelopeLedgerPath -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $ledger = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $normalizedHead = [string]$HeadSha.Trim().ToLower()
    $key = "pr-$PrNumber-$normalizedHead"
    if (-not $ledger.entries) { return $null }
    $entry = $ledger.entries.$key
    if (-not $entry) { return $null }
    return $entry
}

function Reset-ReviewStartEnvelopeLedger {
    param(
        [string]$Namespace,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$Reason,
        [array]$ReviewRuns = @()
    )

    $path = Get-ReviewStartEnvelopeLedgerPath -Namespace $Namespace
    return Invoke-ReviewStartEnvelopeLedgerLocked -LedgerPath $path -Action {
        param($ledger)
        $result = Invoke-ReviewStartEnvelopeLedgerCli -Subcommand 'apply-reset' -Payload @{
            ledger   = $ledger
            prNumber = $PrNumber
            headSha  = $HeadSha
            reason   = $Reason
            reviewRuns = @($ReviewRuns)
        }
        if (-not $result.changed) {
            return @{ ok = $true; changed = $false; reason = [string]$result.reason }
        }
        return @{ ok = $true; changed = $true; ledger = $result.ledger; persist = $true }
    }
}

function Reset-ReviewStartEnvelopeLedgerForCoveredHead {
    param(
        [string]$Namespace,
        [int]$PrNumber,
        [string]$HeadSha,
        [array]$ReviewRuns = @()
    )
    $covered = Invoke-ReviewStartEnvelopeLedgerCli -Subcommand 'should-reset' -Payload @{
        reason = 'covered_head'
        prNumber = $PrNumber
        headSha = $HeadSha
        reviewRuns = @($ReviewRuns)
        covered = $true
    }
    if (-not $covered.reset) { return @{ ok = $true; changed = $false } }
    return Reset-ReviewStartEnvelopeLedger -Namespace $Namespace -PrNumber $PrNumber -HeadSha $HeadSha `
        -Reason 'covered_head' -ReviewRuns $ReviewRuns
}

function Reset-ReviewStartEnvelopeLedgerForPreflightSuccess {
    param(
        [string]$Namespace,
        [int]$PrNumber,
        [string]$HeadSha
    )
    return Reset-ReviewStartEnvelopeLedger -Namespace $Namespace -PrNumber $PrNumber -HeadSha $HeadSha -Reason 'preflight_success'
}

function Write-ReviewStartEnvelopeLedgerEscalation {
    param(
        [string]$Namespace,
        [int]$PrNumber,
        [string]$HeadSha,
        [int]$ConsecutiveFailureCount,
        [string]$LastFailureClass,
        [string[]]$Surfaces = @(),
        [scriptblock]$LogWriter = $null
    )

    $normalized = [string]$HeadSha.Trim().ToLower()
    $surfaceList = ($Surfaces | Where-Object { $_ }) -join ','
    $message = "ESCALATE review-start-envelope-ledger PR #$PrNumber head=$normalized consecutiveFailureCount=$ConsecutiveFailureCount lastFailureClass=$LastFailureClass surfaces=$surfaceList"
    if ($LogWriter) {
        & $LogWriter $message
    }
    else {
        [Console]::Error.WriteLine($message)
    }

    $auditRoot = Join-Path $Namespace 'envelope-ledger-escalations'
    if (-not (Test-Path -LiteralPath $auditRoot)) {
        New-Item -ItemType Directory -Path $auditRoot -Force | Out-Null
    }
    $auditPath = Join-Path $auditRoot "pr-$PrNumber-$normalized.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).json"
    @{
        prNumber                 = $PrNumber
        headSha                  = $normalized
        consecutiveFailureCount  = $ConsecutiveFailureCount
        lastFailureClass         = $LastFailureClass
        surfaces                 = @($Surfaces)
        escalatedAtUtc           = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress -Depth 10 | Set-Content -LiteralPath $auditPath -Encoding UTF8
    return $auditPath
}

function Record-ReviewStartEnvelopeLedgerTerminal {
    param(
        [string]$Namespace,
        [object]$Record,
        [string]$Outcome,
        [hashtable]$Extra = @{},
        [scriptblock]$LogWriter = $null
    )

    if (-not $Record) { return @{ ok = $false; reason = 'missing_record' } }
    $prNumber = [int]$Record.prNumber
    $headSha = [string]$Record.headSha
    $surface = [string]$Record.holder.surface
    $path = Get-ReviewStartEnvelopeLedgerPath -Namespace $Namespace
    $threshold = Get-ReviewStartEnvelopeLedgerEscalationThreshold

    if ($Outcome -eq 'run_started') {
        return Reset-ReviewStartEnvelopeLedger -Namespace $Namespace -PrNumber $prNumber -HeadSha $headSha -Reason 'run_started'
    }

    return Invoke-ReviewStartEnvelopeLedgerLocked -LedgerPath $path -Action {
        param($ledger)
        $result = Invoke-ReviewStartEnvelopeLedgerCli -Subcommand 'apply-terminal' -Payload @{
            ledger    = $ledger
            prNumber  = $prNumber
            headSha   = $headSha
            outcome   = $Outcome
            extra     = $Extra
            surface   = $surface
            threshold = $threshold
            nowUtc    = (Get-Date).ToUniversalTime().ToString('o')
        }
        if (-not $result.changed) {
            return @{ ok = $true; changed = $false; counted = [bool]$result.counted }
        }
        if ($result.shouldEscalate) {
            $entry = $result.entry
            Write-ReviewStartEnvelopeLedgerEscalation -Namespace $Namespace -PrNumber $prNumber -HeadSha $headSha `
                -ConsecutiveFailureCount ([int]$entry.consecutiveFailureCount) `
                -LastFailureClass ([string]$entry.lastFailureClass) `
                -Surfaces @($entry.surfaces) -LogWriter $LogWriter | Out-Null
            $marked = Invoke-ReviewStartEnvelopeLedgerCli -Subcommand 'mark-escalated' -Payload @{
                ledger   = $result.ledger
                prNumber = $prNumber
                headSha  = $headSha
                nowUtc   = (Get-Date).ToUniversalTime().ToString('o')
            }
            $result.ledger = $marked.ledger
        }
        return @{
            ok                      = $true
            changed                 = $true
            counted                 = [bool]$result.counted
            consecutiveFailureCount = [int]$result.consecutiveFailureCount
            shouldEscalate          = [bool]$result.shouldEscalate
            ledger                  = $result.ledger
            persist                 = $true
        }
    }
}

function Sync-ReviewStartEnvelopeLedgerFromTerminal {
    param(
        [string]$Namespace,
        [string]$ActivePath,
        [object]$Record,
        [string]$Outcome,
        [hashtable]$Extra = @{},
        [scriptblock]$LogWriter = $null
    )

    if ($Outcome -eq 'run_started') {
        return Record-ReviewStartEnvelopeLedgerTerminal -Namespace $Namespace -Record $Record -Outcome $Outcome -Extra $Extra -LogWriter $LogWriter
    }

    $reviewRuns = @()
    if ($Extra -and $Extra.ContainsKey('reviewRuns') -and $null -ne $Extra.reviewRuns) {
        $reviewRuns = @($Extra.reviewRuns)
    }
    if ($reviewRuns.Count -gt 0) {
        Reset-ReviewStartEnvelopeLedgerForCoveredHead -Namespace $Namespace -PrNumber ([int]$Record.prNumber) `
            -HeadSha ([string]$Record.headSha) -ReviewRuns $reviewRuns | Out-Null
    }

    return Record-ReviewStartEnvelopeLedgerTerminal -Namespace $Namespace -Record $Record -Outcome $Outcome -Extra $Extra -LogWriter $LogWriter
}
