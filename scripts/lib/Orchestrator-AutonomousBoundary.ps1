#requires -Version 5.1
<#
  In-process autonomous spawn/git policy helpers (Issues #324/#821).
#>

. (Join-Path $PSScriptRoot 'Get-ProcessCommandLine.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-ReviewWorktreeGate.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-SpawnWorktreeGate.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-WorkerRecoveryGate.ps1')

$Script:AutonomousBoundaryExitCode = 93
$Script:SanctionedGitPreflightPatterns = @(
    'reviewer-workspace-preflight.ps1',
    'orchestrator-worktree-preflight.ps1'
)
$Script:WorkerRecoveryParentPattern = 'invoke-worker-recovery.ps1'
$Script:SanctionedGitParentPatterns = @($Script:SanctionedGitPreflightPatterns)
$Script:SanctionedGitParentMaxDepth = 2

function Get-PackRootFromBoundaryLib {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path
}

function Test-OrchestratorAutonomousSurfaceActiveForBoundary {
    return -not [string]::IsNullOrEmpty([string]$env:AO_SESSION_ID)
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



function Test-GitArgvIsBranchDeleteForce {
    param([string[]]$Argv)

    $index = Get-GitArgvSubcommandIndex -Argv $Argv
    if ($index -ge $Argv.Count) { return $false }
    if ([string]$Argv[$index] -notmatch '^(?i)branch$') { return $false }
    for ($i = $index + 1; $i -lt $Argv.Count; $i++) {
        if ([string]$Argv[$i] -match '^(?i)(-D|--delete)$') { return $true }
    }
    return $false
}


function Test-GitArgvIsUpdateRefBranchDeleteForce {
    param([string[]]$Argv)

    $index = Get-GitArgvSubcommandIndex -Argv $Argv
    if ($index -ge $Argv.Count) { return $false }
    if ([string]$Argv[$index] -notmatch '^(?i)update-ref$') { return $false }
    for ($i = $index + 1; $i -lt $Argv.Count; $i++) {
        if ([string]$Argv[$i] -match '^(?i)-d$') {
            if (($i + 1) -lt $Argv.Count) {
                $ref = [string]$Argv[$i + 1]
                if ($ref -match '^refs/heads/') {
                    if (($i + 2) -lt $Argv.Count) {
                        $maybeOid = [string]$Argv[$i + 2]
                        if ($maybeOid -match '^[0-9a-f]{40}$') {
                            return $true
                        }
                    }
                    return $true
                }
            }
        }
    }
    return $false
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
                spawnGrantSkipMutation = [bool]$spawnAllow.spawnGrantSkipMutation
            }
        }
        if ($spawnAllow.reason -and [string]$spawnAllow.reason -ne 'grant_env_missing') {
            return @{ denied = $true; reason = [string]$spawnAllow.reason }
        }
        return @{ denied = $true; reason = 'autonomous_mutating_git_denied' }
    }


    if (Test-GitArgvIsBranchDeleteForce -Argv $Argv -or (Test-GitArgvIsUpdateRefBranchDeleteForce -Argv $Argv)) {
        $branchRecoveryAllow = Test-AutonomousWorkerRecoveryBranchGitAllow -Argv $Argv -FixtureParentChain $FixtureParentChain
        if ($branchRecoveryAllow.allowed) {
            return @{ denied = $false; reason = 'recovery_branch_delete_allow' }
        }
        return @{ denied = $true; reason = [string]$branchRecoveryAllow.reason }
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
