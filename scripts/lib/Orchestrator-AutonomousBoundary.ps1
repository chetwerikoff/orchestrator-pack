#requires -Version 5.1
<#
  Process-boundary helpers for autonomous orchestrator spawn/git gate (Issue #324).
#>

. (Join-Path $PSScriptRoot 'Get-ProcessCommandLine.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-ReviewWorktreeGate.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-SpawnWorktreeGate.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-WorkerRecoveryGate.ps1')

$Script:AutonomousRealBinariesConfigName = 'autonomous-real-binaries.json'
$Script:AutonomousBoundaryExitCode = 93
$Script:TurnVisibleRealBinaryEnvVars = @('AO_REAL_BINARY', 'GIT_REAL_BINARY')
$Script:SanctionedGitPreflightPatterns = @(
    'reviewer-workspace-preflight.ps1',
    'orchestrator-worktree-preflight.ps1'
)
$Script:WorkerRecoveryParentPattern = 'invoke-worker-recovery.ps1'
$Script:ClaimedReviewRunInvokerPattern = 'Invoke-OrchestratorClaimedReviewRun.ps1'
$Script:SanctionedGitParentPatterns = @(
    $Script:SanctionedGitPreflightPatterns
    $Script:ClaimedReviewRunInvokerPattern
)
$Script:SanctionedGitParentMaxDepth = 2

function Get-PackRootFromBoundaryLib {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path
}

function Get-AutonomousRealBinariesConfigPath {
    param([string]$PackRoot = '')
    if (-not $PackRoot) {
        $PackRoot = Get-PackRootFromBoundaryLib
    }
    return Join-Path $PackRoot '.ao' $Script:AutonomousRealBinariesConfigName
}

function Get-AutonomousRealBinariesConfig {
    param([string]$PackRoot = '')
    $configPath = Get-AutonomousRealBinariesConfigPath -PackRoot $PackRoot
    if (-not (Test-Path -LiteralPath $configPath)) {
        return $null
    }
    try {
        return (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

$Script:AutonomousExplicitAoMisconfigurationWarningEmitted = $false
$Script:AutonomousExplicitAoConfigExampleDoc = 'docs/autonomous-real-binaries.example.json'

function Test-AutonomousLiteralPathIsExecutable {
    param([string]$CandidatePath)

    if (-not (Test-Path -LiteralPath $CandidatePath)) { return $false }
    if ($IsWindows) { return $true }
    try {
        $mode = [System.IO.File]::GetUnixFileMode($CandidatePath)
        $executeMask = [System.IO.UnixFileMode]::UserExecute -bor [System.IO.UnixFileMode]::GroupExecute -bor [System.IO.UnixFileMode]::OtherExecute
        return [bool]($mode -band $executeMask)
    }
    catch {
        return $false
    }
}

function Test-AutonomousConfiguredAoPointerUsable {
    param(
        [string]$ConfiguredPath,
        [string]$PackRoot = ''
    )

    if (-not $ConfiguredPath -or $ConfiguredPath -eq 'ao') { return $false }
    if (Test-Path -LiteralPath $ConfiguredPath) {
        if (-not (Test-AutonomousLiteralPathIsExecutable -CandidatePath $ConfiguredPath)) {
            return $false
        }
        $resolved = (Resolve-Path -LiteralPath $ConfiguredPath).Path
        return -not (Test-IsPackAoShimPathForBoundary -CandidatePath $resolved -PackRoot $PackRoot)
    }
    $cmd = Get-Command $ConfiguredPath -ErrorAction SilentlyContinue
    if ($cmd -and -not (Test-IsPackAoShimPathForBoundary -CandidatePath $cmd.Source -PackRoot $PackRoot)) {
        return $true
    }
    return $false
}

function Write-AutonomousExplicitAoConfigMisconfigurationWarning {
    param(
        [ValidateSet('broken-pointer', 'invalid-json')]
        [string]$Reason,
        [string]$ConfigPath,
        [string]$ConfiguredPath = ''
    )

    if ($Script:AutonomousExplicitAoMisconfigurationWarningEmitted) { return }
    $Script:AutonomousExplicitAoMisconfigurationWarningEmitted = $true
    $exampleDoc = $Script:AutonomousExplicitAoConfigExampleDoc
    if ($Reason -eq 'invalid-json') {
        [Console]::Error.WriteLine("autonomous real-binary config: invalid JSON (config: $ConfigPath; see $exampleDoc)")
        return
    }
    [Console]::Error.WriteLine("autonomous real-binary config: explicit ao pointer missing or not executable: $ConfiguredPath (config: $ConfigPath; see $exampleDoc)")
}

function Invoke-AutonomousExplicitAoConfigSurfacePolicy {
    param([string]$PackRoot = '')

    if (-not (Test-OrchestratorAutonomousSurfaceActiveForBoundary)) { return }
    $configPath = Get-AutonomousRealBinariesConfigPath -PackRoot $PackRoot
    if (-not (Test-Path -LiteralPath $configPath)) { return }
    try {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        $configuredAo = [string]$config.ao
        if ($configuredAo -and -not (Test-AutonomousConfiguredAoPointerUsable -ConfiguredPath $configuredAo -PackRoot $PackRoot)) {
            Write-AutonomousExplicitAoConfigMisconfigurationWarning -Reason 'broken-pointer' -ConfigPath $configPath -ConfiguredPath $configuredAo
        }
    }
    catch {
        Write-AutonomousExplicitAoConfigMisconfigurationWarning -Reason 'invalid-json' -ConfigPath $configPath
    }
}

function Test-TurnVisibleRealBinaryBypassPresent {
    foreach ($name in $Script:TurnVisibleRealBinaryEnvVars) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) {
            return $true
        }
    }
    return $false
}

function Get-PackGitRealBinaryPath {
    param([string]$PackRoot = '')

    if (-not $PackRoot) {
        $PackRoot = Get-PackRootFromBoundaryLib
    }
    return (Join-Path (Resolve-Path -LiteralPath (Join-Path $PackRoot 'scripts')).Path 'git-real-binary')
}

function Test-IsPackGitShimPath {
    param(
        [string]$CandidatePath,
        [string]$PackRoot = ''
    )

    if (-not $CandidatePath) { return $false }
    if ($CandidatePath -like '*git-autonomous-guard.ps1') { return $true }
    if (-not $PackRoot) {
        $PackRoot = Get-PackRootFromBoundaryLib
    }
    $packScripts = (Resolve-Path -LiteralPath (Join-Path $PackRoot 'scripts')).Path
    try {
        $resolved = (Get-Item -LiteralPath $CandidatePath -ErrorAction Stop).FullName
    }
    catch {
        return $false
    }
    return $resolved -eq (Join-Path $packScripts 'git')
}

function Test-IsPackGitRealBinaryPath {
    param(
        [string]$CandidatePath,
        [string]$PackRoot = ''
    )

    if (-not $CandidatePath) { return $false }
    if ($CandidatePath -like '*git-real-binary*') {
        return $true
    }
    try {
        $resolved = (Get-Item -LiteralPath $CandidatePath -ErrorAction Stop).FullName
    }
    catch {
        return $false
    }
    return $resolved -eq (Get-PackGitRealBinaryPath -PackRoot $PackRoot)
}

function Test-IsKnownSystemGitBinaryPath {
    param([string]$CandidatePath)

    if (-not $CandidatePath) { return $false }
    $leaf = Split-Path -Leaf $CandidatePath
    if ($leaf -ne 'git') { return $false }
    $normalized = ($CandidatePath -replace '\\', '/')
    return $normalized -match '^(?i)(/usr/bin/|/bin/|/usr/local/bin/)'
}

function Test-IsPackAoShimPathForBoundary {
    param(
        [string]$CandidatePath,
        [string]$PackRoot = ''
    )

    if (-not $CandidatePath) { return $false }
    if ($CandidatePath -like '*ao-autonomous-guard.ps1') { return $true }
    if (-not $PackRoot) {
        $PackRoot = Get-PackRootFromBoundaryLib
    }
    $packScripts = (Resolve-Path -LiteralPath (Join-Path $PackRoot 'scripts')).Path
    try {
        $resolved = (Get-Item -LiteralPath $CandidatePath -ErrorAction Stop).FullName
    }
    catch {
        return $false
    }
    return $resolved -eq (Join-Path $packScripts 'ao')
}

function Resolve-AutonomousRealBinaryPath {
    param(
        [ValidateSet('ao', 'git')]
        [string]$BinaryName,
        [string]$PackRoot = ''
    )

    if (-not $PackRoot) {
        $PackRoot = Get-PackRootFromBoundaryLib
    }
    if ($BinaryName -eq 'ao') {
        Invoke-AutonomousExplicitAoConfigSurfacePolicy -PackRoot $PackRoot
    }
    $packScripts = (Resolve-Path -LiteralPath (Join-Path $PackRoot 'scripts')).Path
    $config = Get-AutonomousRealBinariesConfig -PackRoot $PackRoot
    if ($config) {
        $configured = [string]$config.$BinaryName
        if ($configured) {
            if ($BinaryName -eq 'ao' -and -not (Test-AutonomousConfiguredAoPointerUsable -ConfiguredPath $configured -PackRoot $PackRoot)) {
                # Broken explicit ao (including literal "ao"); surface policy warned — fall through.
            }
            elseif ($configured -ne $BinaryName) {
                if (Test-Path -LiteralPath $configured) {
                    $resolved = (Resolve-Path -LiteralPath $configured).Path
                    $isShim = if ($BinaryName -eq 'ao') {
                        Test-IsPackAoShimPathForBoundary -CandidatePath $resolved -PackRoot $PackRoot
                    }
                    else {
                        Test-IsPackGitShimPath -CandidatePath $resolved -PackRoot $PackRoot
                    }
                    if (-not $isShim) {
                        return $resolved
                    }
                }
                $cmd = Get-Command $configured -ErrorAction SilentlyContinue
                if ($cmd) {
                    $isShim = if ($BinaryName -eq 'ao') {
                        Test-IsPackAoShimPathForBoundary -CandidatePath $cmd.Source -PackRoot $PackRoot
                    }
                    else {
                        Test-IsPackGitShimPath -CandidatePath $cmd.Source -PackRoot $PackRoot
                    }
                    if (-not $isShim) {
                        return $cmd.Source
                    }
                }
            }
        }
    }

    foreach ($dir in ($env:PATH -split [IO.Path]::PathSeparator)) {
        if (-not $dir -or $dir -eq $packScripts) { continue }
        $candidate = Join-Path $dir $BinaryName
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $isShim = if ($BinaryName -eq 'ao') {
            Test-IsPackAoShimPathForBoundary -CandidatePath $candidate -PackRoot $PackRoot
        }
        else {
            Test-IsPackGitShimPath -CandidatePath $candidate -PackRoot $PackRoot
        }
        if ($isShim) { continue }
        return (Get-Item -LiteralPath $candidate).FullName
    }

    if ($BinaryName -eq 'ao') {
        foreach ($fallback in @(
                (Join-Path $HOME '.local/bin/ao'),
                (Join-Path $HOME '.npm-global/bin/ao'),
                (Join-Path $HOME '.ao/bin/ao')
            )) {
            if (Test-Path -LiteralPath $fallback) {
                return (Resolve-Path -LiteralPath $fallback).Path
            }
        }
    }

    $cmd = Get-Command $BinaryName -ErrorAction SilentlyContinue
    if ($cmd) {
        $isShim = if ($BinaryName -eq 'ao') {
            Test-IsPackAoShimPathForBoundary -CandidatePath $cmd.Source -PackRoot $PackRoot
        }
        else {
            Test-IsPackGitShimPath -CandidatePath $cmd.Source -PackRoot $PackRoot
        }
        if (-not $isShim) {
            return $cmd.Source
        }
    }
    return $BinaryName
}

function Test-OrchestratorAutonomousSurfaceActiveForBoundary {
    return [string]$env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE -eq '1'
}

function Resolve-RealAoExecutable {
    param([string]$PackRoot = '')

    if (Test-OrchestratorAutonomousSurfaceActiveForBoundary) {
        return Resolve-AutonomousRealBinaryPath -BinaryName 'ao' -PackRoot $PackRoot
    }

    if ($env:AO_REAL_BINARY -and $env:AO_REAL_BINARY -ne 'ao') {
        if (Test-Path -LiteralPath $env:AO_REAL_BINARY -ErrorAction SilentlyContinue) {
            $resolved = (Resolve-Path -LiteralPath $env:AO_REAL_BINARY).Path
            if (-not (Test-IsPackAoShimPathForBoundary -CandidatePath $resolved -PackRoot $PackRoot)) { return $resolved }
        }
        $configured = Get-Command $env:AO_REAL_BINARY -ErrorAction SilentlyContinue
        if ($configured -and -not (Test-IsPackAoShimPathForBoundary -CandidatePath $configured.Source -PackRoot $PackRoot)) {
            return $configured.Source
        }
    }

    return Resolve-AutonomousRealBinaryPath -BinaryName 'ao' -PackRoot $PackRoot
}

function Resolve-SystemGitExecutable {
    param([string]$PackRoot = '')

    if (-not $PackRoot) {
        $PackRoot = Get-PackRootFromBoundaryLib
    }
    $config = Get-AutonomousRealBinariesConfig -PackRoot $PackRoot
    if ($config) {
        $systemBinary = [string]$config.gitSystemBinary
        if ($systemBinary -and (Test-Path -LiteralPath $systemBinary)) {
            $resolved = (Resolve-Path -LiteralPath $systemBinary).Path
            if (-not (Test-IsPackGitShimPath -CandidatePath $resolved -PackRoot $PackRoot) -and -not (Test-IsPackGitRealBinaryPath -CandidatePath $resolved -PackRoot $PackRoot)) {
                return $resolved
            }
        }
        $configured = [string]$config.git
        if ($configured -and $configured -ne 'git' -and (Test-Path -LiteralPath $configured)) {
            $resolved = (Resolve-Path -LiteralPath $configured).Path
            if (-not (Test-IsPackGitShimPath -CandidatePath $resolved -PackRoot $PackRoot) -and -not (Test-IsPackGitRealBinaryPath -CandidatePath $resolved -PackRoot $PackRoot)) {
                return $resolved
            }
        }
    }

    if (-not (Test-OrchestratorAutonomousSurfaceActiveForBoundary)) {
        if ($env:GIT_SYSTEM_BINARY -and (Test-Path -LiteralPath $env:GIT_SYSTEM_BINARY -ErrorAction SilentlyContinue)) {
            return (Resolve-Path -LiteralPath $env:GIT_SYSTEM_BINARY).Path
        }
    }

    foreach ($candidate in @('/usr/bin/git', '/bin/git', '/usr/local/bin/git')) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $cmd = Get-Command git -ErrorAction SilentlyContinue
    if ($cmd -and -not (Test-IsPackGitShimPath -CandidatePath $cmd.Source -PackRoot $PackRoot) -and -not (Test-IsPackGitRealBinaryPath -CandidatePath $cmd.Source -PackRoot $PackRoot)) {
        return $cmd.Source
    }
    return 'git'
}

function Resolve-RealGitExecutable {
    if (Test-OrchestratorAutonomousSurfaceActiveForBoundary) {
        return Get-PackGitRealBinaryPath
    }

    if ($env:GIT_REAL_BINARY -and $env:GIT_REAL_BINARY -ne 'git') {
        if (Test-Path -LiteralPath $env:GIT_REAL_BINARY -ErrorAction SilentlyContinue) {
            $resolved = (Resolve-Path -LiteralPath $env:GIT_REAL_BINARY).Path
            if (-not (Test-IsPackGitShimPath -CandidatePath $resolved -PackRoot $PackRoot)) { return $resolved }
        }
    }

    return Resolve-AutonomousRealBinaryPath -BinaryName 'git'
}

function Get-LinuxParentProcessId {
    param([int]$ProcessId)

    $statPath = "/proc/$ProcessId/stat"
    if (-not (Test-Path -LiteralPath $statPath -PathType Leaf)) { return 0 }
    $stat = Get-Content -LiteralPath $statPath -Raw
    $end = $stat.LastIndexOf(')')
    if ($end -lt 0) { return 0 }
    $rest = $stat.Substring($end + 2).Trim() -split '\s+'
    if ($rest.Count -lt 2) { return 0 }
    return [int]$rest[1]
}

function Get-ParentProcessId {
    param([int]$ProcessId)

    if ($IsLinux) {
        return Get-LinuxParentProcessId -ProcessId $ProcessId
    }
    if ($IsMacOS) {
        $out = & ps -p $ProcessId -o ppid= 2>$null
        return [int]($out.ToString().Trim())
    }
    try {
        $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        return [int]$cim.ParentProcessId
    }
    catch {
        return 0
    }
}

function Get-ProcessParentChainCommandLines {
    param(
        [int]$MaxDepth = 12,
        [int]$StartProcessId = $PID
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $current = $StartProcessId
    for ($depth = 0; $depth -lt $MaxDepth; $depth++) {
        $ppid = Get-ParentProcessId -ProcessId $current
        if ($ppid -le 0 -or $ppid -eq $current) { break }
        $cmd = Get-ProcessCommandLineById -ProcessId $ppid
        if ($cmd) {
            $lines.Add($cmd)
        }
        $current = $ppid
        if ($current -le 1) { break }
    }
    return @($lines)
}

function Test-ProcessCommandLineIsSanctionedGitParent {
    param(
        [string]$CommandLine,
        [string[]]$SanctionedPatterns = $Script:SanctionedGitParentPatterns
    )

    if (-not $CommandLine) { return $false }
    $tokens = Split-ProcessCommandLineTokens -CommandLine $CommandLine
    if ($tokens.Count -eq 0) { return $false }

    for ($index = 0; $index -lt $tokens.Count; $index++) {
        if ($tokens[$index] -ieq '-File' -and ($index + 1) -lt $tokens.Count) {
            $scriptLeaf = Split-Path -Leaf ($tokens[$index + 1].Trim('"').Trim("'"))
            foreach ($pattern in $SanctionedPatterns) {
                if ($scriptLeaf -ieq $pattern) {
                    return $true
                }
            }
        }
    }

    $firstLeaf = Split-Path -Leaf ($tokens[0].Trim('"').Trim("'"))
    foreach ($pattern in $SanctionedPatterns) {
        if ($firstLeaf -ieq $pattern) {
            return $true
        }
    }
    return $false
}

function Test-ProcessCommandLineIsSanctionedPreflightParent {
    param([string]$CommandLine)

    return Test-ProcessCommandLineIsSanctionedGitParent -CommandLine $CommandLine -SanctionedPatterns $Script:SanctionedGitPreflightPatterns
}

function Test-ProcessCommandLineIsInvokeOrchestratorClaimedReviewRun {
    param([string]$CommandLine)

    return Test-ProcessCommandLineIsSanctionedGitParent -CommandLine $CommandLine -SanctionedPatterns @($Script:ClaimedReviewRunInvokerPattern)
}

function Test-ProcessCommandLineContainsUnquotedShellCompoundOperator {
    param([string]$Segment)

    if (-not $Segment) { return $false }
    $inSingle = $false
    $inDouble = $false
    for ($index = 0; $index -lt $Segment.Length; $index++) {
        $char = $Segment[$index]
        if ($char -eq "'" -and -not $inDouble) {
            $inSingle = -not $inSingle
            continue
        }
        if ($char -eq '"' -and -not $inSingle) {
            $inDouble = -not $inDouble
            continue
        }
        if (-not $inSingle -and -not $inDouble) {
            if ($char -eq ';' -or $char -eq '|') {
                return $true
            }
            if ($char -eq '&' -and ($index + 1) -lt $Segment.Length -and $Segment[$index + 1] -eq '&') {
                return $true
            }
        }
    }
    return $false
}

function Test-ProcessCommandLineIsAoReviewRunGitWorktreeSetup {
    param([string]$CommandLine)

    if (-not $CommandLine) { return $false }
    $aoReviewRun = [regex]::Match($CommandLine, '(?i)\bao(?:\.cmd)?\s+review\s+run\b')
    if (-not $aoReviewRun.Success) {
        $aoReviewRun = [regex]::Match($CommandLine, '(?i)\breview\s+run\b.*--execute\b')
    }
    if (-not $aoReviewRun.Success) {
        return $false
    }
    $gitWorktree = [regex]::Match($CommandLine, '(?i)\bgit\s+worktree\s+add\b')
    if (-not $gitWorktree.Success) {
        return $false
    }
    if ($gitWorktree.Index -lt $aoReviewRun.Index) {
        return $false
    }
    $reviewRunEnd = $aoReviewRun.Index + $aoReviewRun.Length
    $between = $CommandLine.Substring($reviewRunEnd, $gitWorktree.Index - $reviewRunEnd)
    if (Test-ProcessCommandLineContainsUnquotedShellCompoundOperator -Segment $between) {
        return $false
    }
    return $true
}

function Test-GitArgvIsAoOwnedWorktreeAdd {
    param([string[]]$Argv)

    $index = Get-GitArgvSubcommandIndex -Argv $Argv
    if ($index -ge $Argv.Count) {
        return $false
    }
    if ([string]$Argv[$index] -notmatch '^(?i)worktree$') {
        return $false
    }
    if (($index + 1) -ge $Argv.Count) {
        return $false
    }
    return [string]$Argv[$index + 1] -match '^(?i)add$'
}

function Get-AutonomousGitSanctionedProvenanceClass {
    param([string[]]$FixtureParentChain = @())

    if ($FixtureParentChain.Count -gt 0) {
        $chain = [string[]]$FixtureParentChain
    }
    else {
        $chain = Get-ProcessParentChainCommandLines
    }

    $depthLimit = [Math]::Min($chain.Count, $Script:SanctionedGitParentMaxDepth)
    for ($i = 0; $i -lt $depthLimit; $i++) {
        if (Test-ProcessCommandLineIsSanctionedPreflightParent -CommandLine $chain[$i]) {
            return 'preflight'
        }
    }

    for ($i = 0; $i -lt $depthLimit; $i++) {
        $cmd = $chain[$i]
        if (Test-ProcessCommandLineIsInvokeOrchestratorClaimedReviewRun -CommandLine $cmd) {
            return 'claimed_review_run'
        }
        if (Test-ProcessCommandLineIsAoReviewRunGitWorktreeSetup -CommandLine $cmd) {
            return 'review_run_worktree_command'
        }
    }

    return 'none'
}

function Test-AutonomousGitSanctionedProvenance {
    param(
        [string[]]$FixtureParentChain = @(),
        [string[]]$Argv = @()
    )

    switch (Get-AutonomousGitSanctionedProvenanceClass -FixtureParentChain $FixtureParentChain) {
        'preflight' { return $true }
        default { return $false }
    }
}

function Get-GitArgvSubcommandIndex {
    param([string[]]$Argv)

    if (-not $Argv -or $Argv.Count -eq 0) {
        return 0
    }

    $index = 0
    while ($index -lt $Argv.Count) {
        $token = [string]$Argv[$index]
        if ($token -in @('-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace')) {
            $index += 2
            continue
        }
        if ($token -match '^--.+=.+$') {
            $index++
            continue
        }
        if ($token -match '^-c[^-].+$' -or $token -match '^-C.+$') {
            $index++
            continue
        }
        if ($token -match '^-') {
            $index++
            continue
        }
        break
    }
    return $index
}

function Test-GitArgvDefinesAlias {
    param([string[]]$Argv)

    if (-not $Argv -or $Argv.Count -eq 0) {
        return $false
    }

    for ($index = 0; $index -lt $Argv.Count; $index++) {
        $token = [string]$Argv[$index]
        if ($token -eq '-c' -and ($index + 1) -lt $Argv.Count) {
            $value = [string]$Argv[$index + 1]
            if ($value -match '^(?i)alias\.') {
                return $true
            }
            $index++
            continue
        }
        if ($token -match '^-c[^-].+$' -and $token.Substring(2) -match '^(?i)alias\.') {
            return $true
        }
    }
    return $false
}

function Test-GitTokenIsExactOption {
    param(
        [string]$Token,
        [string]$Option
    )

    $lowered = $Token.ToLowerInvariant()
    $opt = $Option.ToLowerInvariant()
    return ($lowered -eq $opt) -or $lowered.StartsWith("${opt}=")
}

function Test-GitArgvTailHasExactOption {
    param(
        [string[]]$Argv,
        [int]$StartIndex,
        [string]$Option
    )

    for ($i = $StartIndex; $i -lt $Argv.Count; $i++) {
        if (Test-GitTokenIsExactOption -Token $Argv[$i] -Option $Option) {
            return $true
        }
    }
    return $false
}

function Test-GitArgvTailHasPositionalOperand {
    param(
        [string[]]$Argv,
        [int]$StartIndex
    )

    for ($i = $StartIndex; $i -lt $Argv.Count; $i++) {
        if (-not $Argv[$i].StartsWith('-')) {
            return $true
        }
    }
    return $false
}

function Test-GitTokenIsConfigGetOption {
    param([string]$Token)

    switch -Regex ($Token) {
        '^(?i)(--get|--get-all|--get-regexp|--get-urlmatch)$' { return $true }
        '^(?i)(--get|--get-all|--get-regexp|--get-urlmatch)=' { return $true }
    }
    return $false
}

function Test-GitArgvConfigTailIsGetReadOnly {
    param(
        [string[]]$Argv,
        [int]$StartIndex
    )

    $sawGet = $false
    for ($i = $StartIndex; $i -lt $Argv.Count; $i++) {
        $token = [string]$Argv[$i]
        if (Test-GitTokenIsConfigGetOption -Token $token) {
            $sawGet = $true
            continue
        }
        if ($token.StartsWith('-')) {
            continue
        }
        if (-not $sawGet) {
            return $false
        }
    }
    return $sawGet
}


function Test-GitArgvIsWorktreeList {
    param([string[]]$Argv)

    $index = Get-GitArgvSubcommandIndex -Argv $Argv
    if ($index -ge $Argv.Count) { return $false }
    if ([string]$Argv[$index] -notmatch '^(?i)worktree$') { return $false }
    if (($index + 1) -ge $Argv.Count) { return $false }
    return [string]$Argv[$index + 1] -match '^(?i)list$'
}

function Test-GitArgvIsWorktreeRemoveForce {
    param([string[]]$Argv)

    $index = Get-GitArgvSubcommandIndex -Argv $Argv
    if ($index -ge $Argv.Count) { return $false }
    if ([string]$Argv[$index] -notmatch '^(?i)worktree$') { return $false }
    if (($index + 1) -ge $Argv.Count) { return $false }
    if ([string]$Argv[$index + 1] -notmatch '^(?i)remove$') { return $false }
    for ($i = $index + 2; $i -lt $Argv.Count; $i++) {
        if ([string]$Argv[$i] -match '^(?i)(--force|-f)$') { return $true }
    }
    return $false
}

function Test-GitArgvIsMutating {
    param([string[]]$Argv)

    if (-not $Argv -or $Argv.Count -eq 0) {
        return $false
    }

    if (Test-GitArgvDefinesAlias -Argv $Argv) {
        return $true
    }

    $index = Get-GitArgvSubcommandIndex -Argv $Argv
    if ($index -ge $Argv.Count) {
        return $false
    }

    $sub = [string]$Argv[$index]
    if (Test-GitArgvIsWorktreeList -Argv $Argv) { return $false }
    switch -Regex ($sub) {
        '^(?i)fetch$' {
            if (Test-GitArgvTailHasExactOption -Argv $Argv -StartIndex ($index + 1) -Option '--dry-run') {
                return $false
            }
            return $true
        }
        '^(?i)stash$' {
            if ($index + 1 -ge $Argv.Count) {
                return $true
            }
            $stashSub = [string]$Argv[$index + 1]
            if ($stashSub -match '^(?i)(list|show)$') {
                return $false
            }
            return $true
        }
        '^(?i)config$' {
            if (Test-GitArgvConfigTailIsGetReadOnly -Argv $Argv -StartIndex ($index + 1)) {
                return $false
            }
            return $true
        }
        '^(?i)branch$' {
            if (Test-GitArgvTailHasPositionalOperand -Argv $Argv -StartIndex ($index + 1)) {
                return $true
            }
            if (Test-GitArgvTailHasExactOption -Argv $Argv -StartIndex ($index + 1) -Option '--show-current') {
                return $false
            }
            return $true
        }
        '^(?i)(status|log|rev-parse|diff|show|ls-files|ls-tree|cat-file|merge-base|grep|check-ignore|check-attr|describe|for-each-ref|show-ref|name-rev|var|version|help|rev-list)$' { return $false }
        default { return $true }
    }
}

function Test-AutonomousGitDenied {
    param(
        [string[]]$Argv,
        [string[]]$FixtureParentChain = @()
    )

    if (-not (Test-OrchestratorAutonomousSurfaceActiveForBoundary)) {
        return @{ denied = $false; reason = 'manual_surface' }
    }

    if (-not (Test-GitArgvIsMutating -Argv $Argv)) {
        return @{ denied = $false; reason = 'read_only_git' }
    }

    if (Test-GitArgvIsAoOwnedWorktreeAdd -Argv $Argv) {
        $claimAllow = Test-AutonomousReviewWorktreeClaimBoundAllow -Argv $Argv
        if ($claimAllow.allowed) {
            return @{ denied = $false; reason = 'claimed_worktree_allow' }
        }
        $spawnAllow = Test-AutonomousSpawnWorktreeGrantBoundAllow -Argv $Argv
        if ($spawnAllow.allowed) {
            return @{
                denied                = $false
                reason                = [string]$spawnAllow.reason
                normalizedCommitOid   = [string]$spawnAllow.normalizedCommitOid
                spawnGrantFinalize    = if ($spawnAllow.spawnGrantFinalize) { $spawnAllow.spawnGrantFinalize } else { $null }
            }
        }
        if ($spawnAllow.reason -and [string]$spawnAllow.reason -ne 'grant_env_missing') {
            return @{ denied = $true; reason = [string]$spawnAllow.reason }
        }
        return @{ denied = $true; reason = 'autonomous_mutating_git_denied' }
    }

    if (Test-GitArgvIsWorktreeRemoveForce -Argv $Argv) {
        $recoveryAllow = Test-AutonomousWorkerRecoveryGitAllow -Argv $Argv -FixtureParentChain $FixtureParentChain
        if ($recoveryAllow.allowed) {
            return @{ denied = $false; reason = 'recovery_worktree_remove_allow' }
        }
        if (Test-AutonomousGitSanctionedProvenance -FixtureParentChain $FixtureParentChain -Argv $Argv) {
            return @{ denied = $false; reason = 'sanctioned_git_child' }
        }
        return @{ denied = $true; reason = [string]$recoveryAllow.reason }
    }

    if (Test-AutonomousGitSanctionedProvenance -FixtureParentChain $FixtureParentChain -Argv $Argv) {
        return @{ denied = $false; reason = 'sanctioned_git_child' }
    }

    return @{ denied = $true; reason = 'autonomous_mutating_git_denied' }
}

. (Join-Path $PSScriptRoot 'Orchestrator-AutonomousSpawnGate.ps1')
