#requires -Version 5.1
<#
  Process-boundary helpers for autonomous orchestrator spawn/git gate (Issue #324).
#>

. (Join-Path $PSScriptRoot 'Get-ProcessCommandLine.ps1')

$Script:AutonomousRealBinariesConfigName = 'autonomous-real-binaries.json'
$Script:AutonomousBoundaryExitCode = 93
$Script:TurnVisibleRealBinaryEnvVars = @('AO_REAL_BINARY', 'GIT_REAL_BINARY')
$Script:SanctionedGitParentPatterns = @(
    'reviewer-workspace-preflight.ps1',
    'orchestrator-worktree-preflight.ps1'
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
    param([string]$CandidatePath)

    if (-not $CandidatePath) { return $false }
    if ($CandidatePath -like '*git-autonomous-guard.ps1') { return $true }
    $packScripts = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
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
    param([string]$CandidatePath)

    if (-not $CandidatePath) { return $false }
    if ($CandidatePath -like '*ao-autonomous-guard.ps1') { return $true }
    $packScripts = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
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
    $packScripts = (Resolve-Path -LiteralPath (Join-Path $PackRoot 'scripts')).Path
    $config = Get-AutonomousRealBinariesConfig -PackRoot $PackRoot
    if ($config) {
        $configured = [string]$config.$BinaryName
        if ($configured -and $configured -ne $BinaryName) {
            if (Test-Path -LiteralPath $configured) {
                $resolved = (Resolve-Path -LiteralPath $configured).Path
                $isShim = if ($BinaryName -eq 'ao') {
                    Test-IsPackAoShimPathForBoundary -CandidatePath $resolved
                }
                else {
                    Test-IsPackGitShimPath -CandidatePath $resolved
                }
                if (-not $isShim) {
                    return $resolved
                }
            }
            $cmd = Get-Command $configured -ErrorAction SilentlyContinue
            if ($cmd) {
                $isShim = if ($BinaryName -eq 'ao') {
                    Test-IsPackAoShimPathForBoundary -CandidatePath $cmd.Source
                }
                else {
                    Test-IsPackGitShimPath -CandidatePath $cmd.Source
                }
                if (-not $isShim) {
                    return $cmd.Source
                }
            }
        }
    }

    foreach ($dir in ($env:PATH -split [IO.Path]::PathSeparator)) {
        if (-not $dir -or $dir -eq $packScripts) { continue }
        $candidate = Join-Path $dir $BinaryName
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $isShim = if ($BinaryName -eq 'ao') {
            Test-IsPackAoShimPathForBoundary -CandidatePath $candidate
        }
        else {
            Test-IsPackGitShimPath -CandidatePath $candidate
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
            Test-IsPackAoShimPathForBoundary -CandidatePath $cmd.Source
        }
        else {
            Test-IsPackGitShimPath -CandidatePath $cmd.Source
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
    if (Test-OrchestratorAutonomousSurfaceActiveForBoundary) {
        return Resolve-AutonomousRealBinaryPath -BinaryName 'ao'
    }

    if ($env:AO_REAL_BINARY -and $env:AO_REAL_BINARY -ne 'ao') {
        if (Test-Path -LiteralPath $env:AO_REAL_BINARY -ErrorAction SilentlyContinue) {
            $resolved = (Resolve-Path -LiteralPath $env:AO_REAL_BINARY).Path
            if (-not (Test-IsPackAoShimPathForBoundary -CandidatePath $resolved)) { return $resolved }
        }
        $configured = Get-Command $env:AO_REAL_BINARY -ErrorAction SilentlyContinue
        if ($configured -and -not (Test-IsPackAoShimPathForBoundary -CandidatePath $configured.Source)) {
            return $configured.Source
        }
    }

    return Resolve-AutonomousRealBinaryPath -BinaryName 'ao'
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
            if (-not (Test-IsPackGitShimPath -CandidatePath $resolved) -and -not (Test-IsPackGitRealBinaryPath -CandidatePath $resolved -PackRoot $PackRoot)) {
                return $resolved
            }
        }
        $configured = [string]$config.git
        if ($configured -and $configured -ne 'git' -and (Test-Path -LiteralPath $configured)) {
            $resolved = (Resolve-Path -LiteralPath $configured).Path
            if (-not (Test-IsPackGitShimPath -CandidatePath $resolved) -and -not (Test-IsPackGitRealBinaryPath -CandidatePath $resolved -PackRoot $PackRoot)) {
                return $resolved
            }
        }
    }

    if ($env:GIT_SYSTEM_BINARY -and (Test-Path -LiteralPath $env:GIT_SYSTEM_BINARY -ErrorAction SilentlyContinue)) {
        return (Resolve-Path -LiteralPath $env:GIT_SYSTEM_BINARY).Path
    }

    foreach ($candidate in @('/usr/bin/git', '/bin/git', '/usr/local/bin/git')) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $cmd = Get-Command git -ErrorAction SilentlyContinue
    if ($cmd -and -not (Test-IsPackGitShimPath -CandidatePath $cmd.Source) -and -not (Test-IsPackGitRealBinaryPath -CandidatePath $cmd.Source -PackRoot $PackRoot)) {
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
            if (-not (Test-IsPackGitShimPath -CandidatePath $resolved)) { return $resolved }
        }
    }

    return Resolve-AutonomousRealBinaryPath -BinaryName 'git'
}

function Get-AoArgvSubcommand {
    param([string[]]$Argv)

    if (-not $Argv -or $Argv.Count -eq 0) {
        return ''
    }
    foreach ($token in $Argv) {
        if ([string]$token -match '^-') {
            continue
        }
        return [string]$token
    }
    return ''
}

function Test-AutonomousSpawnDenied {
    param([string[]]$Argv)

    if (-not (Test-OrchestratorAutonomousSurfaceActiveForBoundary)) {
        return @{ denied = $false; reason = 'manual_surface' }
    }

    $sub = Get-AoArgvSubcommand -Argv $Argv
    if ($sub -match '^(?i)spawn$') {
        return @{ denied = $true; reason = 'autonomous_spawn_denied' }
    }
    return @{ denied = $false; reason = 'not_spawn' }
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

function Split-ProcessCommandLineTokens {
    param([string]$CommandLine)

    $tokens = New-Object System.Collections.Generic.List[string]
    if (-not $CommandLine) {
        return @($tokens)
    }

    $current = New-Object System.Text.StringBuilder
    $inSingle = $false
    $inDouble = $false
    for ($index = 0; $index -lt $CommandLine.Length; $index++) {
        $char = $CommandLine[$index]
        if ($char -eq "'" -and -not $inDouble) {
            $inSingle = -not $inSingle
            continue
        }
        if ($char -eq '"' -and -not $inSingle) {
            $inDouble = -not $inDouble
            continue
        }
        if ([char]::IsWhiteSpace($char) -and -not $inSingle -and -not $inDouble) {
            if ($current.Length -gt 0) {
                $tokens.Add($current.ToString())
                $current.Clear() | Out-Null
            }
            continue
        }
        [void]$current.Append($char)
    }
    if ($current.Length -gt 0) {
        $tokens.Add($current.ToString())
    }
    return @($tokens)
}

function Test-ProcessCommandLineIsSanctionedGitParent {
    param([string]$CommandLine)

    if (-not $CommandLine) { return $false }
    $tokens = Split-ProcessCommandLineTokens -CommandLine $CommandLine
    if ($tokens.Count -eq 0) { return $false }

    for ($index = 0; $index -lt $tokens.Count; $index++) {
        if ($tokens[$index] -ieq '-File' -and ($index + 1) -lt $tokens.Count) {
            $scriptLeaf = Split-Path -Leaf ($tokens[$index + 1].Trim('"').Trim("'"))
            foreach ($pattern in $Script:SanctionedGitParentPatterns) {
                if ($scriptLeaf -ieq $pattern) {
                    return $true
                }
            }
        }
    }

    $firstLeaf = Split-Path -Leaf ($tokens[0].Trim('"').Trim("'"))
    foreach ($pattern in $Script:SanctionedGitParentPatterns) {
        if ($firstLeaf -ieq $pattern) {
            return $true
        }
    }
    return $false
}

function Test-ProcessCommandLineIsAoReviewRun {
    param([string]$CommandLine)

    if (-not $CommandLine) { return $false }
    $aoReviewRun = [regex]::Match($CommandLine, '(?i)\bao(?:\.cmd)?\s+review\s+run\b')
    if (-not $aoReviewRun.Success) {
        $aoReviewRun = [regex]::Match($CommandLine, '(?i)\breview\s+run\b.*--execute\b')
    }
    if (-not $aoReviewRun.Success) {
        return $false
    }
    $gitPrimary = [regex]::Match($CommandLine, '(?i)\bgit\s+(?:-[a-zA-Z]|branch|checkout|switch|worktree|reset|commit|merge|rebase|pull|tag|stash|push|fetch)\b')
    if (-not $gitPrimary.Success) {
        return $true
    }
    return $aoReviewRun.Index -lt $gitPrimary.Index
}

function Test-AutonomousGitSanctionedProvenance {
    param(
        [string[]]$FixtureParentChain = @()
    )

    $chain = if ($FixtureParentChain.Count -gt 0) {
        @($FixtureParentChain)
    }
    else {
        Get-ProcessParentChainCommandLines
    }

    $depthLimit = [Math]::Min($chain.Count, $Script:SanctionedGitParentMaxDepth)
    for ($i = 0; $i -lt $depthLimit; $i++) {
        if (Test-ProcessCommandLineIsSanctionedGitParent -CommandLine $chain[$i]) {
            return $true
        }
    }

    if ([string]$env:AO_CLAIMED_REVIEW_RUN_BYPASS -eq '1') {
        foreach ($cmd in $chain) {
            if (Test-ProcessCommandLineIsAoReviewRun -CommandLine $cmd) {
                return $true
            }
        }
    }

    return $false
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
    switch -Regex ($sub) {
        '^(?i)fetch$' {
            $tail = ($Argv[($index + 1)..($Argv.Count - 1)] -join ' ')
            if ($tail -match '(?i)--dry-run') {
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
        '^(?i)(status|log|rev-parse|diff|show)$' { return $false }
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

    if (Test-AutonomousGitSanctionedProvenance -FixtureParentChain $FixtureParentChain) {
        return @{ denied = $false; reason = 'sanctioned_git_child' }
    }

    return @{ denied = $true; reason = 'autonomous_mutating_git_denied' }
}
