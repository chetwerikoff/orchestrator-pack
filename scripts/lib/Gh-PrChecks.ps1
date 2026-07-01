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
        [string]$RepoRoot
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

function Invoke-GhPrViewStructuredCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber
    )

    $command = Resolve-ReviewStartScopedGhCommand
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

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdoutDrain = $proc.StandardOutput.ReadToEndAsync()
    $stderrDrain = $proc.StandardError.ReadToEndAsync()
    $proc.WaitForExit() | Out-Null
    try { $stdoutDrain.Wait(5000) | Out-Null } catch { }
    try { $stderrDrain.Wait(5000) | Out-Null } catch { }
    $stdout = [string]$stdoutDrain.Result
    $stderr = [string]$stderrDrain.Result
    $exitCode = $proc.ExitCode

    $parse = Invoke-CommandRuntimeParseStructuredOutput -Stdout $stdout -Stderr $stderr
    return @{
        exitCode = $exitCode
        stdout   = $stdout
        stderr   = $stderr
        parse    = $parse
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
        failureClass = 'infra_transport'
    }
}

function Invoke-ReviewStartScopedGhPrView {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber
    )

    $capture = Invoke-GhPrViewStructuredCapture -RepoRoot $RepoRoot -PrNumber $PrNumber
    if ($capture.exitCode -ne 0) {
        return @{
            openPrs          = @()
            transportFailure = (New-ReviewStartScopedGhTransportFailure -Capture $capture -Reason 'gh_command_failed')
        }
    }
    if (-not $capture.parse.ok) {
        $reason = [string]$capture.parse.reason
        if (-not $reason) { $reason = 'structured_output_polluted' }
        return @{
            openPrs          = @()
            transportFailure = (New-ReviewStartScopedGhTransportFailure -Capture $capture -Reason $reason)
        }
    }

    $pr = $capture.parse.value
    if (-not $pr -or [string]$pr.state -ne 'OPEN') {
        return @{ openPrs = @(); transportFailure = $null }
    }

    Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
    return @{ openPrs = @($pr); transportFailure = $null }
}


function Invoke-GhOpenPrListForNumbers {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$PrNumbers,
        [scriptblock]$ProgressWriter = $null
    )

    $unique = @($PrNumbers | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    if ($unique.Count -eq 0) {
        return @()
    }

    Push-Location -LiteralPath $RepoRoot
    try {
        $prs = @()
        $ordinal = 0
        foreach ($n in $unique) {
            $ordinal += 1
            if ($ProgressWriter) {
                & $ProgressWriter 'open_pr_view' $ordinal
            }
            $capture = Invoke-GhPrViewStructuredCapture -RepoRoot $RepoRoot -PrNumber $n
            if ($capture.exitCode -ne 0 -or -not $capture.parse.ok) {
                continue
            }
            $pr = $capture.parse.value
            if ([string]$pr.state -ne 'OPEN') {
                continue
            }
            Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
            $prs += $pr
        }
        return $prs
    }
    finally {
        Pop-Location
    }
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
        [string]$EmptyChecksWarning = ''
    )

    Push-Location -LiteralPath $RepoRoot
    try {
        $raw = gh pr checks $PrNumber --json name,state,bucket,link,startedAt,completedAt,workflow,description 2>&1
        $exitCode = $LASTEXITCODE
        $checks = ConvertFrom-GhJsonArrayOutput -RawOutput $raw
        if ($exitCode -ne 0 -and $checks.Count -eq 0 -and $EmptyChecksWarning) {
            Write-GhPrChecksLog $EmptyChecksWarning
        }
        return @($checks)
    }
    finally {
        Pop-Location
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
        [string]$ProtectionLookupWarning = ''
    )

    Push-Location -LiteralPath $RepoRoot
    try {
        $baseRef = gh pr view $PrNumber --json baseRefName -q .baseRefName 2>&1
        if ($LASTEXITCODE -ne 0 -or -not $baseRef) {
            return @{ names = $null; lookupFailed = $true }
        }

        $repoSlug = gh repo view --json nameWithOwner -q .nameWithOwner 2>&1
        if ($LASTEXITCODE -ne 0 -or -not $repoSlug) {
            return @{ names = $null; lookupFailed = $true }
        }

        $encodedBaseRef = Get-GhEncodedBranchRef -BranchRef $baseRef
        $protectionRaw = gh api "repos/$repoSlug/branches/$encodedBaseRef/protection" 2>&1
        $protectionExit = $LASTEXITCODE
        if ($protectionExit -ne 0) {
            $protectionText = ($protectionRaw | ForEach-Object { $_.ToString() }) -join "`n"
            if ($protectionText -match 'Branch not protected|404') {
                return @{ names = $null; lookupFailed = $false }
            }
            if ($ProtectionLookupWarning) {
                Write-GhPrChecksLog ($ProtectionLookupWarning -f $PrNumber, $protectionExit)
            }
            return @{ names = $null; lookupFailed = $true }
        }

        $protection = $protectionRaw | ConvertFrom-Json
        $rsc = $protection.required_status_checks
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
    finally {
        Pop-Location
    }
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
        [scriptblock]$ProgressWriter = $null
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

        try {
            if ($ProgressWriter) {
                & $ProgressWriter 'checks' $ordinal
            }
            $ciChecksByPr[[string]$n] = @(Invoke-GhPrChecks -RepoRoot $RepoRoot -PrNumber $n)
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
            -ProtectionLookupWarning $ProtectionLookupWarningTemplate
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
