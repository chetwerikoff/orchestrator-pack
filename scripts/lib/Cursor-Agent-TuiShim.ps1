# Pack-owned cursor-agent TUI shim helpers (Issue #725).

function Get-CursorAgentTuiShimUserHome {
    if (-not [string]::IsNullOrWhiteSpace($env:OPK_CURSOR_AGENT_HOME)) {
        return $env:OPK_CURSOR_AGENT_HOME
    }
    if (-not [string]::IsNullOrWhiteSpace($env:HOME)) {
        return $env:HOME
    }
    return [Environment]::GetFolderPath('UserProfile')
}

function Get-CursorAgentTuiShimPackInstallPath {
    Join-Path (Get-CursorAgentTuiShimUserHome) '.local/share/orchestrator-pack/cursor-agent-tui-shim.sh'
}

function Get-CursorAgentTuiShimSymlinkPath {
    Join-Path (Get-CursorAgentTuiShimUserHome) '.local/bin/cursor-agent'
}

function Get-CursorAgentAgentEntryPath {
    Join-Path (Get-CursorAgentTuiShimUserHome) '.local/bin/agent'
}

function Get-CursorAgentTuiShimSourcePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackRoot
    )
    Join-Path $PackRoot 'scripts/cursor-agent-tui-shim.sh'
}

function Resolve-CursorAgentRealBinaryPath {
    param(
        [string]$VersionsRoot = ''
    )

    $home = Get-CursorAgentTuiShimUserHome
    if ([string]::IsNullOrWhiteSpace($VersionsRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($env:OPK_CURSOR_AGENT_VERSIONS_ROOT)) {
            $VersionsRoot = $env:OPK_CURSOR_AGENT_VERSIONS_ROOT
        }
        else {
            $VersionsRoot = Join-Path $home '.local/share/cursor-agent/versions'
        }
    }

    if (-not (Test-Path -LiteralPath $VersionsRoot -PathType Container)) {
        return $null
    }

    $candidates = @(
        Get-ChildItem -LiteralPath $VersionsRoot -Directory -Filter '2026*' -ErrorAction SilentlyContinue |
            Sort-Object Name
    )
    if ($candidates.Count -eq 0) {
        $candidates = @(
            Get-ChildItem -LiteralPath $VersionsRoot -Directory -Filter '20*' -ErrorAction SilentlyContinue |
                Sort-Object Name
        )
    }
    if ($candidates.Count -eq 0) {
        return $null
    }

    $newest = $candidates[-1].FullName
    $binary = Join-Path $newest 'cursor-agent'
    if (Test-Path -LiteralPath $binary) {
        return $binary
    }
    return $null
}

function Get-CursorAgentTuiShimTopology {
    param(
        [string]$PackInstallPath = '',
        [string]$SymlinkPath = ''
    )

    if ([string]::IsNullOrWhiteSpace($PackInstallPath)) {
        $PackInstallPath = Get-CursorAgentTuiShimPackInstallPath
    }
    if ([string]::IsNullOrWhiteSpace($SymlinkPath)) {
        $SymlinkPath = Get-CursorAgentTuiShimSymlinkPath
    }

    $result = [ordered]@{
        Pass         = $false
        Reason       = 'unknown'
        ClobberShape = 'none'
        SymlinkPath  = $SymlinkPath
        InstallPath  = $PackInstallPath
        ResolvedTarget = $null
    }

    if (-not (Test-Path -LiteralPath $PackInstallPath -PathType Leaf)) {
        $result.Reason = 'pack shim install target missing'
        $result.ClobberShape = 'missing-install'
        return [pscustomobject]$result
    }

    if (-not (Test-Path -LiteralPath $SymlinkPath)) {
        $result.Reason = 'cursor-agent path missing'
        $result.ClobberShape = 'missing'
        return [pscustomobject]$result
    }

    $item = Get-Item -LiteralPath $SymlinkPath -Force
    if ($item.LinkType -eq 'SymbolicLink') {
        $target = $item.Target
        if ($target -is [string[]]) {
            $target = $target[0]
        }
        $result.ResolvedTarget = $target
        $expected = (Resolve-Path -LiteralPath $PackInstallPath).Path
        $actual = try { (Resolve-Path -LiteralPath $target -ErrorAction Stop).Path } catch { $target }
        if ($actual -eq $expected) {
            $result.Pass = $true
            $result.Reason = 'symlink resolves to pack shim'
            return [pscustomobject]$result
        }
        $result.Reason = "symlink repointed to $actual"
        $result.ClobberShape = 'symlink-repoint'
        return [pscustomobject]$result
    }

    if ($item.PSIsContainer) {
        $result.Reason = 'cursor-agent path is a directory'
        $result.ClobberShape = 'directory'
        return [pscustomobject]$result
    }

    $result.Reason = 'cursor-agent path is a regular file (not symlink)'
    $result.ClobberShape = 'regular-file'
    return [pscustomobject]$result
}

function Write-CursorAgentTuiShimAlert {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Code,
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [string]$AlertDestination = ''
    )

    $payload = @{
        timestamp = (Get-Date).ToUniversalTime().ToString('o')
        source    = 'cursor-agent-tui-shim'
        code      = $Code
        message   = $Message
    } | ConvertTo-Json -Compress

    $dest = $AlertDestination
    if ([string]::IsNullOrWhiteSpace($dest) -and $env:AO_FLEET_HYGIENE_ALERT_FILE) {
        $dest = $env:AO_FLEET_HYGIENE_ALERT_FILE
    }
    if ($dest) {
        $parent = Split-Path -Parent $dest
        if ($parent -and -not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
        }
        Add-Content -LiteralPath $dest -Value $payload -Encoding utf8
    }
    [Console]::Error.WriteLine($payload)
}

function Install-CursorAgentTuiShim {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackRoot,
        [switch]$Quiet
    )

    $source = Get-CursorAgentTuiShimSourcePath -PackRoot $PackRoot
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing pack shim source: $source"
    }

    $installPath = Get-CursorAgentTuiShimPackInstallPath
    $installDir = Split-Path -Parent $installPath
    if (-not (Test-Path -LiteralPath $installDir)) {
        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    }

    Copy-Item -LiteralPath $source -Destination $installPath -Force
    if ($IsLinux -or $IsMacOS) {
        & chmod '+x' $installPath
        if ($LASTEXITCODE -ne 0) {
            throw "chmod failed for $installPath"
        }
    }

    $binDir = Join-Path (Get-CursorAgentTuiShimUserHome) '.local/bin'
    if (-not (Test-Path -LiteralPath $binDir)) {
        New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    }

    $symlinkPath = Get-CursorAgentTuiShimSymlinkPath
    $agentPath = Get-CursorAgentAgentEntryPath
    $agentBefore = $null
    if (Test-Path -LiteralPath $agentPath) {
        $agentBefore = Get-Item -LiteralPath $agentPath -Force
    }

    if (Test-Path -LiteralPath $symlinkPath) {
        Remove-Item -LiteralPath $symlinkPath -Force
    }
    New-Item -ItemType SymbolicLink -Path $symlinkPath -Target $installPath -Force | Out-Null

    if (Test-Path -LiteralPath $agentPath) {
        $agentAfter = Get-Item -LiteralPath $agentPath -Force
        if ($agentBefore -and $agentAfter) {
            $beforeTarget = if ($agentBefore.LinkType -eq 'SymbolicLink') { $agentBefore.Target } else { $agentBefore.FullName }
            $afterTarget = if ($agentAfter.LinkType -eq 'SymbolicLink') { $agentAfter.Target } else { $agentAfter.FullName }
            if ($beforeTarget -ne $afterTarget) {
                throw "Install mutated ~/.local/bin/agent (forbidden write surface)"
            }
        }
    }

    if (-not $Quiet) {
        Write-Host "[install-cursor-agent-tui-shim] installed $installPath -> $symlinkPath"
    }

    return [pscustomobject]@{
        InstallPath = $installPath
        SymlinkPath = $symlinkPath
    }
}


function Test-CursorAgentTuiShimSelfHealEnabled {
    if ($env:OPK_CURSOR_AGENT_SHIM_SELF_HEAL_DISABLE -eq '1') {
        return [pscustomobject]@{ Enabled = $false; Reason = 'OPK_CURSOR_AGENT_SHIM_SELF_HEAL_DISABLE=1' }
    }
    return [pscustomobject]@{ Enabled = $true; Reason = 'self-heal enabled' }
}

function Invoke-CursorAgentTuiShimSelfHeal {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackRoot,
        [string]$Source = 'manual',
        [switch]$Quiet
    )

    $selfHealGate = Test-CursorAgentTuiShimSelfHealEnabled
    if (-not $selfHealGate.Enabled) {
        return [pscustomobject]@{
            Healed   = $false
            Alerted  = $false
            Message  = "self-heal disabled: $($selfHealGate.Reason)"
            Topology = (Get-CursorAgentTuiShimTopology)
        }
    }

    $topology = Get-CursorAgentTuiShimTopology
    if ($topology.Pass) {
        return [pscustomobject]@{
            Healed  = $false
            Alerted = $false
            Message = 'topology ok'
            Topology = $topology
        }
    }

    try {
        $install = Install-CursorAgentTuiShim -PackRoot $PackRoot -Quiet:$Quiet
        $after = Get-CursorAgentTuiShimTopology
        $message = "self-heal from $Source restored $($install.SymlinkPath) (was: $($topology.Reason))"
        Write-CursorAgentTuiShimAlert -Code 'cursor_agent_shim_drift_healed' -Message $message
        return [pscustomobject]@{
            Healed   = $after.Pass
            Alerted  = $true
            Message  = $message
            Topology = $after
        }
    }
    catch {
        $message = "self-heal from $Source failed: $_ (drift: $($topology.Reason))"
        Write-CursorAgentTuiShimAlert -Code 'cursor_agent_shim_drift_heal_failed' -Message $message
        return [pscustomobject]@{
            Healed   = $false
            Alerted  = $true
            Message  = $message
            Topology = $topology
        }
    }
}

function Test-CursorAgentTrustWatcherRunning {
    if ($env:OPK_FORCE_TRUST_WATCHER_DOWN -eq '1') {
        return [pscustomobject]@{ Pass = $false; Reason = 'trust-watcher process not found' }
    }

    if ($IsLinux) {
        $result = & pgrep -f 'orchestrator-worktree-trust-watcher\.ps1' 2>$null
        if ($LASTEXITCODE -eq 0 -and $result) {
            return [pscustomobject]@{ Pass = $true; Reason = "pid=$result" }
        }
        return [pscustomobject]@{ Pass = $false; Reason = 'trust-watcher process not found' }
    }

    $procs = Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'orchestrator-worktree-trust-watcher\.ps1' }
    if ($procs) {
        return [pscustomobject]@{ Pass = $true; Reason = "pid=$($procs[0].ProcessId)" }
    }
    return [pscustomobject]@{ Pass = $false; Reason = 'trust-watcher process not found' }
}

function Invoke-CursorAgentTuiShimPtyProbe {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$ProbeEnv,
        [Parameter(Mandatory = $true)]
        [string[]]$Argv,
        [int]$TimeoutSeconds = 3,
        [ValidateSet('translate', 'passthrough')]
        [string]$ExpectMode
    )

    if (-not (Get-Command script -ErrorAction SilentlyContinue)) {
        throw 'script(1) required for PTY probes'
    }
    if (-not (Get-Command timeout -ErrorAction SilentlyContinue)) {
        throw 'timeout(1) required for PTY probes'
    }

    $cursorAgent = $ProbeEnv['CURSOR_AGENT_BIN']
    if (-not $cursorAgent) {
        $cursorAgent = Join-Path (Get-CursorAgentTuiShimUserHome) '.local/bin/cursor-agent'
    }

    $envPairs = @(
        "HOME='$((Get-CursorAgentTuiShimUserHome) -replace "'", "'\\''")'"
        "OPK_CURSOR_AGENT_HOME='$((Get-CursorAgentTuiShimUserHome) -replace "'", "'\\''")'"
        'AO_SESSION_ID='
    )
    foreach ($key in $ProbeEnv.Keys) {
        if ($key -eq 'CURSOR_AGENT_BIN') { continue }
        $value = [string]$ProbeEnv[$key]
        $escaped = $value -replace "'", "'\\''"
        $envPairs = @($envPairs | Where-Object { $_ -notlike "$key=*" })
        $envPairs += "$key='$escaped'"
    }
    $envPrefix = if ($envPairs.Count -gt 0) { ($envPairs -join ' ') + ' ' } else { '' }

    $argvText = ($Argv | ForEach-Object {
            $a = [string]$_
            if ($a -match '\s') { "'$($a -replace "'", "'\\''")'" } else { $a }
        }) -join ' '

    $inner = "${envPrefix}${cursorAgent} ${argvText}"
    $cmd = "timeout ${TimeoutSeconds}s script -qec $(($inner | ConvertTo-Json)) /dev/null 2>&1; echo __EXIT__:`$?"

    $output = & bash -lc $cmd 2>&1 | Out-String
    $exitMatch = [regex]::Match($output, '__EXIT__:(\d+)')
    $exitCode = if ($exitMatch.Success) { [int]$exitMatch.Groups[1].Value } else { -1 }
    $body = if ($exitMatch.Success) { $output.Substring(0, $exitMatch.Index) } else { $output }

    $hasTuiBanner = $body -match 'CURSOR_AGENT_TUI_BANNER'
    $hasHeadless = $body -match 'No prompt provided'
    $timedOut = $exitCode -eq 124

    $pass = $false
    $reason = ''
    if ($ExpectMode -eq 'translate') {
        if ($hasTuiBanner -or $timedOut) {
            $pass = $true
            $reason = 'translate path observed TUI attach or alive beyond headless window'
        }
        elseif ($hasHeadless) {
            $reason = 'translate path got immediate headless exit'
        }
        else {
            $reason = "translate path inconclusive (exit=$exitCode)"
        }
    }
    else {
        if ($hasHeadless -and -not $hasTuiBanner) {
            $pass = $true
            $reason = 'passthrough path observed stock headless behavior'
        }
        elseif ($hasTuiBanner) {
            $reason = 'passthrough path incorrectly attached TUI'
        }
        else {
            $reason = "passthrough path inconclusive (exit=$exitCode)"
        }
    }

    return [pscustomobject]@{
        Pass     = $pass
        Reason   = $reason
        ExitCode = $exitCode
        Output   = $body
        ExpectMode = $ExpectMode
    }
}

function Test-CursorAgentTuiShimResolutionDiagnostic {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackRoot,
        [hashtable]$ProbeEnv = @{}
    )

    $cursorAgent = Join-Path (Get-CursorAgentTuiShimUserHome) '.local/bin/cursor-agent'
    $envPairs = @()
    foreach ($key in $ProbeEnv.Keys) {
        $value = [string]$ProbeEnv[$key]
        $escaped = $value -replace "'", "'\\''"
        $envPairs += "$key='$escaped'"
    }
    $envPrefix = if ($envPairs.Count -gt 0) { ($envPairs -join ' ') + ' ' } else { '' }
    $cmd = "${envPrefix}${cursorAgent} -p stream-json"
    $output = & bash -lc $cmd 2>&1 | Out-String
    $hasDiagnostic = $output -match '\[cursor-agent-tui-shim\] FATAL'
    return [pscustomobject]@{
        Pass       = $hasDiagnostic
        Reason     = if ($hasDiagnostic) { 'loud resolution diagnostic emitted' } else { 'missing resolution diagnostic' }
        Output     = $output
        ExitCode   = $LASTEXITCODE
    }
}

function Invoke-CursorAgentTuiShimOfflineVerification {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackRoot,
        [switch]$SkipTrustWatcherCheck,
        [switch]$Quiet
    )

    $script:CursorAgentTuiShimVerifyResults = [System.Collections.Generic.List[object]]::new()
    $script:CursorAgentTuiShimVerifyFailed = $false

    function Add-Result {
        param($Name, $Result)
        $script:CursorAgentTuiShimVerifyResults.Add([pscustomobject]@{ Name = $Name; Result = $Result })
        if (-not $Result.Pass) {
            $script:CursorAgentTuiShimVerifyFailed = $true
            Write-CursorAgentTuiShimAlert -Code "verify_$Name" -Message $Result.Reason
        }
        if (-not $Quiet) {
            $status = if ($Result.Pass) { 'PASS' } else { 'FAIL' }
            Write-Host "[$status] $Name : $($Result.Reason)"
        }
    }

    $topology = Get-CursorAgentTuiShimTopology
    Add-Result 'topology' ([pscustomobject]@{
            Pass   = $topology.Pass
            Reason = if ($topology.Pass) { $topology.Reason } else { "topological FAIL: $($topology.Reason)" }
        })

    $translate = Invoke-CursorAgentTuiShimPtyProbe -ProbeEnv @{
            AO_SESSION_ID = 'orchestrator-pack-93'
        } -Argv @('-p', 'stream-json') -ExpectMode 'translate'
    Add-Result 'translate-pty' $translate

    $passthrough = Invoke-CursorAgentTuiShimPtyProbe -ProbeEnv @{} -Argv @('-p', 'stream-json') -ExpectMode 'passthrough'
    Add-Result 'passthrough-pty' $passthrough

    $review = Invoke-CursorAgentTuiShimPtyProbe -ProbeEnv @{
            AO_SESSION_ID = 'review-orchestrator-pack-93'
        } -Argv @('-p', 'stream-json') -ExpectMode 'passthrough'
    Add-Result 'review-passthrough' $review

  if (-not $SkipTrustWatcherCheck) {
        $watcher = Test-CursorAgentTrustWatcherRunning
        Add-Result 'trust-watcher-running' ([pscustomobject]@{
                Pass   = $watcher.Pass
                Reason = if ($watcher.Pass) { $watcher.Reason } else { "trust-watcher-down: $($watcher.Reason)" }
            })
    }

    return [pscustomobject]@{
        Pass    = -not $script:CursorAgentTuiShimVerifyFailed
        Results = $script:CursorAgentTuiShimVerifyResults
    }
}
