#requires -Version 5.1
<#
.SYNOPSIS
  Shared gh pr list / checks / branch-protection helpers for mechanical reconcile scripts.
#>

. (Join-Path $PSScriptRoot 'Gh-FleetInventoryCache.ps1')

function Write-GhPrChecksLog {
    param([string]$Message)

    if ($null -ne $Script:GhPrChecksLogWriter) {
        & $Script:GhPrChecksLogWriter $Message
    }
}

function ConvertFrom-GhJsonArrayOutput {
    param([object]$RawOutput)

    $text = ($RawOutput | ForEach-Object {
            if ($_ -is [string]) { $_ }
            elseif ($null -ne $_) { $_.ToString() }
        }) -join "`n"
    $start = $text.IndexOf('[')
    if ($start -lt 0) {
        return @()
    }

    return @($text.Substring($start) | ConvertFrom-Json)
}

function ConvertTo-GhOpenPrArray {
    param($OpenPrs)

    if ($null -eq $OpenPrs) {
        return ,@()
    }
    $normalized = @($OpenPrs | Where-Object { $null -ne $_ })
    if ($normalized.Count -eq 0) {
        return ,@()
    }
    return ,$normalized
}

function Invoke-GhOpenPrList {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [string]$Consumer = ''
    )

    # List query stays cheap (no commits connection). Head commit dates use the
    # fleet SHA memo; open-PR rows use the shared short-TTL snapshot (#453).
    $prs = @(Invoke-GhFleetCachedOpenPrListRaw -RepoRoot $RepoRoot)
    foreach ($pr in $prs) {
        Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
    }
    return $prs
}

$Script:CommandRuntimeBootstrapCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts/lib/command-runtime-bootstrap.mjs'

function Invoke-CommandRuntimeParseStructuredOutput {
    param(
        [string]$Stdout = '',
        [string]$Stderr = ''
    )

    $payload = (@{ stdout = $Stdout; stderr = $Stderr } | ConvertTo-Json -Compress -Depth 5)
    $raw = & node $Script:CommandRuntimeBootstrapCli parseStructuredOutput $payload 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "command-runtime-bootstrap parseStructuredOutput failed: $raw"
    }
    return $raw | ConvertFrom-Json
}

function Resolve-ReviewStartScopedGhCommand {
    $override = [string]$env:AO_REVIEW_START_SCOPED_GH_COMMAND
    if ($override) { return $override }
    $packGh = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts/gh'
    if (Test-Path -LiteralPath $packGh) { return $packGh }
    return 'gh'
}


function New-GhPrViewMissingBinaryCapture {
    param([string]$Command)

    $message = "gh command not found: $Command"
    return @{
        exitCode = -1
        stdout   = ''
        stderr   = $message
        timedOut = $false
        parse    = @{ ok = $false; reason = 'gh_binary_missing' }
    }
}

function Test-ReviewStartGhCommandResolvable {
    param([string]$Command)

    if (-not $Command) { return $false }
    if ($Command -eq 'gh') { return $true }
    if ($Command -match '[/\\]' -or $Command -match '\.(ps1|exe|cmd|bat)$') {
        return Test-Path -LiteralPath $Command
    }
    return $true
}

function Invoke-GhPrViewStructuredCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [int]$TimeoutMs = 0
    )

    $command = Resolve-ReviewStartScopedGhCommand
    if (-not (Test-ReviewStartGhCommandResolvable -Command $command)) {
        return New-GhPrViewMissingBinaryCapture -Command $command
    }
    $ghArgs = @('pr', 'view', [string]$PrNumber, '--json', 'number,headRefOid,baseRefName,state')
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($command -match '\.ps1$') {
        $psi.FileName = 'pwsh'
        $escapedArgs = ($ghArgs | ForEach-Object {
            $part = [string]$_
            if ($part -match '\s') { '"' + $part.Replace('"', '\"') + '"' } else { $part }
        }) -join ' '
        $psi.Arguments = "-NoProfile -File `"$command`" $escapedArgs"
    }
    else {
        $psi.FileName = $command
        $psi.Arguments = ($ghArgs | ForEach-Object { [string]$_ }) -join ' '
    }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $RepoRoot

    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    }
    catch {
        return New-GhPrViewMissingBinaryCapture -Command $command
    }
    $stdoutDrain = $proc.StandardOutput.ReadToEndAsync()
    $stderrDrain = $proc.StandardError.ReadToEndAsync()
    $timedOut = $false
    if ($TimeoutMs -gt 0) {
        $timedOut = -not $proc.WaitForExit([Math]::Max(1, $TimeoutMs))
        if ($timedOut) {
            try { $proc.Kill($true) } catch { }
            try { $proc.WaitForExit(2000) | Out-Null } catch { }
        }
    }
    else {
        $proc.WaitForExit() | Out-Null
    }
    try { $stdoutDrain.Wait(5000) | Out-Null } catch { }
    try { $stderrDrain.Wait(5000) | Out-Null } catch { }
    $stdout = [string]$stdoutDrain.Result
    $stderr = [string]$stderrDrain.Result
    $exitCode = if ($timedOut) { -1 } else { $proc.ExitCode }

    $parse = if ($timedOut) {
        @{ ok = $false; reason = 'preflight_timeout' }
    }
    else {
        Invoke-CommandRuntimeParseStructuredOutput -Stdout $stdout -Stderr $stderr
    }
    return @{
        exitCode = $exitCode
        stdout   = $stdout
        stderr   = $stderr
        timedOut = $timedOut
        parse    = $parse
    }
}

function Resolve-ReviewStartScopedGhTransportFailureClass {
    param([string]$Reason)

    switch -Regex ($Reason) {
        '^(preflight_transient_exhausted|preflight_timeout|claim_ownership_lost|gh_binary_missing)$' { return 'infra_transport' }
        default { return '' }
    }
}

function New-ReviewStartScopedGhTransportFailure {
    param(
        [hashtable]$Capture,
        [string]$Reason
    )

    return @{
        ok           = $false
        reason       = $Reason
        exitCode     = [int]$Capture.exitCode
        stderr       = [string]$Capture.stderr
        stdout       = [string]$Capture.stdout
        failureClass = (Resolve-ReviewStartScopedGhTransportFailureClass -Reason $Reason)
    }
}

function New-ReviewStartTargetStateDenial {
    param([string]$Reason)

    return @{
        ok     = $false
        reason = $Reason
    }
}

function Invoke-ReviewStartScopedGhPrView {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [string]$AuditRoot = ''
    )

    . (Join-Path $PSScriptRoot 'Review-StartPreflightShield.ps1')
    return Invoke-ReviewStartPreflightGhPrView -RepoRoot $RepoRoot -PrNumber $PrNumber -AuditRoot $AuditRoot
}

function Invoke-GhOpenPrListForNumbers {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$PrNumbers,
        [scriptblock]$ProgressWriter = $null,
        [string]$Consumer = ''
    )

    $unique = @($PrNumbers | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    if ($unique.Count -eq 0) {
        return @()
    }

    $prs = @()
    $ordinal = 0
    foreach ($n in $unique) {
        $ordinal += 1
        if ($ProgressWriter) {
            & $ProgressWriter 'open_pr_view' $ordinal
        }
        try {
            $pr = Invoke-GhFleetCachedPrView -RepoRoot $RepoRoot -PrNumber $n -Consumer $Consumer
        }
        catch {
            continue
        }
        if (-not $pr) {
            continue
        }
        if ([string]$pr.state -ne 'OPEN') {
            continue
        }
        Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
        $prs += $pr
    }
    return $prs
}

function Get-GhEncodedBranchRef {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BranchRef
    )

    return [uri]::EscapeDataString([string]$BranchRef)
}

function Invoke-GhPrChecks {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [string]$HeadSha = '',
        [string]$EmptyChecksWarning = '',
        [string]$Consumer = ''
    )

    if (-not $HeadSha) {
        $view = Invoke-GhFleetCachedPrView -RepoRoot $RepoRoot -PrNumber $PrNumber -Consumer $Consumer
        $HeadSha = [string]$view.headRefOid
    }
    if (-not $HeadSha) {
        if ($EmptyChecksWarning) {
            Write-GhPrChecksLog $EmptyChecksWarning
        }
        return @()
    }

    try {
        return @(Invoke-GhFleetCachedChecksByHeadSha -RepoRoot $RepoRoot -PrNumber $PrNumber -HeadSha $HeadSha -Consumer $Consumer)
    }
    catch {
        if ($_.Exception.Message -match 'snapshot_populate_failed|child_checks_bypass') {
            throw
        }
        if ($EmptyChecksWarning) {
            Write-GhPrChecksLog $EmptyChecksWarning
        }
        return @()
    }
}

function Get-GhRequiredCheckNamesForPr {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [Parameter(Mandatory = $true)]
        [scriptblock]$MergeRequiredNames,
        [string]$ProtectionLookupWarning = '',
        [string]$Consumer = ''
    )

    $prView = Invoke-GhFleetCachedPrView -RepoRoot $RepoRoot -PrNumber $PrNumber -Consumer $Consumer
    if (-not $prView -or -not $prView.baseRefName) {
        return @{ names = $null; lookupFailed = $true }
    }

    $baseRef = [string]$prView.baseRefName
    try {
        $protectionLookup = Invoke-GhFleetCachedBranchProtection -RepoRoot $RepoRoot -BaseBranch $baseRef -Consumer $Consumer
    }
    catch {
        if ($ProtectionLookupWarning) {
            Write-GhPrChecksLog ($ProtectionLookupWarning -f $PrNumber, 1)
        }
        return @{ names = $null; lookupFailed = $true }
    }

    if ($protectionLookup.lookupFailed) {
        return @{ names = $null; lookupFailed = $true }
    }
    if ($protectionLookup.unprotected -or -not $protectionLookup.protection) {
        return @{ names = $null; lookupFailed = $false }
    }

    $rsc = $protectionLookup.protection.required_status_checks
    if (-not $rsc) {
        return @{ names = $null; lookupFailed = $false }
    }

    $merged = & $MergeRequiredNames @{
        contexts = @($rsc.contexts)
        checks   = @($rsc.checks)
    }
    if (-not $merged -or @($merged).Count -eq 0) {
        return @{ names = $null; lookupFailed = $false }
    }

    return @{ names = @($merged); lookupFailed = $false }
}

function Get-GhChecksBundleByPr {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $false)]
        [AllowEmptyCollection()]
        [AllowNull()]
        [array]$OpenPrs,
        [Parameter(Mandatory = $true)]
        [scriptblock]$MergeRequiredNames,
        [string]$EmptyChecksWarningTemplate = 'warn: gh pr checks PR #{0} exit {1} with no parseable JSON',
        [string]$ChecksFetchFailedWarningTemplate = 'warn: checks fetch failed PR #{0} : {1}',
        [string]$ProtectionLookupWarningTemplate = 'warn: branch protection lookup failed PR #{0} (exit {1}); treating required CI as unresolved',
        [scriptblock]$ProgressWriter = $null,
        [string]$Consumer = ''
    )

    $ciChecksByPr = @{}
    $requiredCheckNamesByPr = @{}
    $requiredCheckLookupFailedByPr = @{}
    $OpenPrs = ConvertTo-GhOpenPrArray -OpenPrs $OpenPrs
    if (-not $OpenPrs.Count) {
        return @{
            ciChecksByPr                  = $ciChecksByPr
            requiredCheckNamesByPr        = $requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $requiredCheckLookupFailedByPr
        }
    }
    $ordinal = 0
    foreach ($pr in @($OpenPrs)) {
        $ordinal += 1
        $n = [int]$pr.number
        if (-not $n) {
            continue
        }

        $expectedHead = [string]$pr.headRefOid
        if (-not $expectedHead) {
            try {
                $viewForHead = Invoke-GhFleetCachedPrView -RepoRoot $RepoRoot -PrNumber $n -Consumer $Consumer
            }
            catch {
                Write-GhPrChecksLog ("stale head fence PR #{0}: pr_view_failed" -f $n)
                continue
            }
            if (-not $viewForHead) {
                Write-GhPrChecksLog ("stale head fence PR #{0}: no_pr_view" -f $n)
                continue
            }
            $expectedHead = [string]$viewForHead.headRefOid
        }
        if (-not $expectedHead) {
            Write-GhPrChecksLog ("stale head fence PR #{0}: no_head_ref" -f $n)
            continue
        }

        $headGate = Test-GhFleetPrHeadCurrent -RepoRoot $RepoRoot -PrNumber $n -ExpectedHeadSha $expectedHead -Consumer $Consumer
        if (-not $headGate.current) {
            Write-GhPrChecksLog ("stale head fence PR #{0}: {1}" -f $n, $headGate.reason)
            continue
        }

        try {
            if ($ProgressWriter) {
                & $ProgressWriter 'checks' $ordinal
            }
            $checks = @(Invoke-GhPrChecks -RepoRoot $RepoRoot -PrNumber $n -HeadSha $expectedHead -Consumer $Consumer)
            $ciChecksByPr[[string]$n] = $checks
            $null = Test-GhFleetCiDeltaUnchanged -RepoRoot $RepoRoot -HeadSha $expectedHead -Checks $checks -Consumer $Consumer
        }
        catch {
            Write-GhPrChecksLog ($ChecksFetchFailedWarningTemplate -f $n, $_)
            $ciChecksByPr[[string]$n] = @()
        }

        if ($ProgressWriter) {
            & $ProgressWriter 'required_checks' $ordinal
        }
        $requiredLookup = Get-GhRequiredCheckNamesForPr -RepoRoot $RepoRoot -PrNumber $n `
            -MergeRequiredNames $MergeRequiredNames `
            -ProtectionLookupWarning $ProtectionLookupWarningTemplate `
            -Consumer $Consumer
        if ($requiredLookup.lookupFailed) {
            $requiredCheckLookupFailedByPr[[string]$n] = $true
        }
        elseif ($requiredLookup.names) {
            $requiredCheckNamesByPr[[string]$n] = @($requiredLookup.names)
        }
    }

    return @{
        ciChecksByPr                  = $ciChecksByPr
        requiredCheckNamesByPr        = $requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $requiredCheckLookupFailedByPr
    }
}
