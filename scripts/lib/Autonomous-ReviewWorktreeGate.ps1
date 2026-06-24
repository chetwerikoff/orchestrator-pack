#requires -Version 5.1
<#
  Claim-bound allow + canonical workspace path hardening for autonomous review worktree add (Issue #429).
#>

$Script:AutonomousReviewWorktreeGateRoot = $PSScriptRoot
. (Join-Path $Script:AutonomousReviewWorktreeGateRoot 'Review-StartClaim.ps1')
. (Join-Path $Script:AutonomousReviewWorktreeGateRoot 'Review-StartClaimLifecycle.ps1')

$Script:AutonomousReviewWorktreeClaimSchemaVersion = 1

function Get-AutonomousReviewWorktreeProjectId {
    $project = if ($env:AO_PROJECT_ID) { $env:AO_PROJECT_ID.Trim() }
    elseif ($env:AO_PROJECT) { $env:AO_PROJECT.Trim() }
    else { 'orchestrator-pack' }
    if (-not $project) { return 'orchestrator-pack' }
    return $project
}

function Get-AutonomousReviewWorktreeStateRoot {
    param([string]$ProjectId = '')

    if (-not $ProjectId) {
        $ProjectId = Get-AutonomousReviewWorktreeProjectId
    }
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    return (Join-Path (Join-Path $base 'projects') $ProjectId)
}

function Get-AutonomousReviewWorktreeWorkspacePrefix {
    param([string]$ProjectId = '')

    return (Join-Path (Get-AutonomousReviewWorktreeStateRoot -ProjectId $ProjectId) 'code-reviews/workspaces')
}

function Get-AutonomousReviewWorktreeProjectIdFromNamespace {
    param([string]$Namespace)

    if (-not $Namespace) { return $null }
    $normalized = ($Namespace -replace '\\', '/').TrimEnd('/')
    if ($normalized -match '/projects/([^/]+)/review-start-claims$') {
        return $Matches[1]
    }
    return $null
}

function Import-AutonomousReviewWorktreeClaimReader {
    # Review-StartClaim.ps1 is loaded at module import; keep for call-site compatibility.
}

function Get-GitArgvPermittedReviewWorktreeAddDetach {
    param([string[]]$Argv)

    $index = Get-GitArgvSubcommandIndex -Argv $Argv
    if ($index -ge $Argv.Count) {
        return @{ ok = $false; reason = 'missing_subcommand' }
    }
    if ([string]$Argv[$index] -notmatch '^(?i)worktree$') {
        return @{ ok = $false; reason = 'not_worktree' }
    }
    if (($index + 1) -ge $Argv.Count -or [string]$Argv[$index + 1] -notmatch '^(?i)add$') {
        return @{ ok = $false; reason = 'not_worktree_add' }
    }

    $cursor = $index + 2
    $detach = $false
    $path = $null
    $commit = $null
    while ($cursor -lt $Argv.Count) {
        $token = [string]$Argv[$cursor]
        if ($token -match '^(?i)--detach$') {
            $detach = $true
            $cursor++
            continue
        }
        if ($token -match '^(?i)(-b|--branch)$') {
            if (($cursor + 1) -ge $Argv.Count) {
                return @{ ok = $false; reason = 'incomplete_branch_flag' }
            }
            $cursor += 2
            continue
        }
        if ($token -match '^(?i)(-f|--force|--checkout|--lock|--orphan)$') {
            $cursor++
            continue
        }
        if ($token -match '^-') {
            return @{ ok = $false; reason = 'unsupported_flag' }
        }
        if (-not $path) {
            $path = $token
            $cursor++
            continue
        }
        if (-not $commit) {
            $commit = $token
            $cursor++
            continue
        }
        return @{ ok = $false; reason = 'extra_positional' }
    }

    if (-not $detach) {
        return @{ ok = $false; reason = 'missing_detach' }
    }
    if (-not $path) {
        return @{ ok = $false; reason = 'missing_path' }
    }
    if (-not $commit) {
        return @{ ok = $false; reason = 'missing_explicit_commit' }
    }
    return @{ ok = $true; path = $path; commit = $commit }
}

function Resolve-AutonomousReviewWorktreeExistingAncestorPath {
    param([string]$TargetPath)

    if (-not $TargetPath) {
        return @{ ok = $false; reason = 'empty_path' }
    }
    if (Test-Path -LiteralPath $TargetPath) {
        try {
            $item = Get-Item -LiteralPath $TargetPath -Force
            if ($item.LinkType -eq 'SymbolicLink' -and $item.Target) {
                $targetPath = if ($item.Target -is [string]) { $item.Target } else { $item.Target[0] }
                if (-not [System.IO.Path]::IsPathRooted($targetPath)) {
                    $targetPath = Join-Path (Split-Path -Parent $item.FullName) $targetPath
                }
                return Resolve-AutonomousReviewWorktreeExistingAncestorPath -TargetPath $targetPath
            }
            return @{ ok = $true; path = $item.FullName }
        }
        catch {
            return @{ ok = $false; reason = 'path_resolution_failed' }
        }
    }

    $parent = Split-Path -Parent $TargetPath
    if (-not $parent) {
        try {
            return @{ ok = $true; path = [System.IO.Path]::GetFullPath($TargetPath) }
        }
        catch {
            return @{ ok = $false; reason = 'unresolvable_path' }
        }
    }

    $resolvedParent = Resolve-AutonomousReviewWorktreeExistingAncestorPath -TargetPath $parent
    if (-not $resolvedParent.ok) {
        return $resolvedParent
    }
    return @{
        ok   = $true
        path = Join-Path $resolvedParent.path (Split-Path -Leaf $TargetPath)
    }
}

function Resolve-AutonomousReviewWorktreeCanonicalPath {
    param([string]$TargetPath)

    if (-not $TargetPath) {
        return @{ ok = $false; reason = 'empty_path' }
    }
    $resolved = Resolve-AutonomousReviewWorktreeExistingAncestorPath -TargetPath $TargetPath
    if (-not $resolved.ok) {
        return $resolved
    }
    if ($resolved.path -match '([\x00-\x1f])') {
        return @{ ok = $false; reason = 'control_characters' }
    }
    return @{ ok = $true; path = $resolved.path }
}

function Test-PathIsUnderCanonicalPrefix {
    param(
        [string]$CandidatePath,
        [string]$PrefixPath
    )

    $candidate = $CandidatePath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $prefix = $PrefixPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    if (-not $candidate -or -not $prefix) {
        return $false
    }
    if ($IsLinux -or $IsMacOS) {
        if ($candidate -ceq $prefix) { return $true }
        return $candidate.StartsWith($prefix + [System.IO.Path]::DirectorySeparatorChar)
    }
    if ($candidate -ieq $prefix) { return $true }
    return $candidate.StartsWith($prefix + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-AutonomousReviewWorktreeTargetPathHardened {
    param(
        [string]$TargetPath,
        [string]$ProjectId
    )

    $resolved = Resolve-AutonomousReviewWorktreeCanonicalPath -TargetPath $TargetPath
    if (-not $resolved.ok) {
        return @{ allowed = $false; reason = $resolved.reason }
    }

    $workspacePrefix = Get-AutonomousReviewWorktreeWorkspacePrefix -ProjectId $ProjectId
    $prefixResolved = Resolve-AutonomousReviewWorktreeExistingAncestorPath -TargetPath $workspacePrefix
    if (-not $prefixResolved.ok) {
        return @{ allowed = $false; reason = 'prefix_unresolvable' }
    }

    $canonicalTarget = $resolved.path

    if (-not (Test-PathIsUnderCanonicalPrefix -CandidatePath $canonicalTarget -PrefixPath $prefixResolved.path)) {
        return @{ allowed = $false; reason = 'path_escape' }
    }

    if (Test-Path -LiteralPath $canonicalTarget) {
        return @{ allowed = $false; reason = 'target_preexists' }
    }

    return @{ allowed = $true; reason = 'path_ok'; canonicalPath = $canonicalTarget }
}

function Test-ReviewStartClaimHeadShaFormat {
    param([string]$HeadSha)

    $normalized = ([string]$HeadSha).Trim().ToLowerInvariant()
    if ($normalized -match '^[0-9a-f]{40}$') {
        return @{ ok = $true; headSha = $normalized }
    }
    return @{ ok = $false; reason = 'invalid_head_sha' }
}

function Test-AutonomousReviewWorktreeClaimHolderLive {
    param([object]$Holder)

    if (-not $Holder) { return $false }
    $liveness = Invoke-ReviewStartClaimLifecycleCli -Subcommand 'classify-holder' -Payload @{
        holder    = $Holder
        localHost = (Get-ReviewStartClaimLocalHostName)
    }
    return ([string]$liveness.outcome -eq 'alive')
}

function Test-ReviewStartClaimRecordIsLive {
    param([object]$Record)

    Import-AutonomousReviewWorktreeClaimReader
    if ($null -eq $Record) { return $false }
    if ([int]$Record.schemaVersion -ne $Script:AutonomousReviewWorktreeClaimSchemaVersion) { return $false }
    if ([string]$Record.state -ne 'active') { return $false }
    if (-not $Record.holder) { return $false }
    return (Test-AutonomousReviewWorktreeClaimHolderLive -Holder $Record.holder)
}

function Find-LiveReviewStartClaimForHeadSha {
    param(
        [string]$HeadSha,
        [string]$Namespace = '',
        [string]$ProjectId = ''
    )

    Import-AutonomousReviewWorktreeClaimReader
    if (-not $Namespace) {
        if (-not $ProjectId) {
            $ProjectId = Get-AutonomousReviewWorktreeProjectId
        }
        $Namespace = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId
    }
    if (-not $ProjectId) {
        $ProjectId = Get-AutonomousReviewWorktreeProjectIdFromNamespace -Namespace $Namespace
        if (-not $ProjectId) {
            $ProjectId = Get-AutonomousReviewWorktreeProjectId
        }
    }

    if (-not (Test-Path -LiteralPath $Namespace -PathType Container)) {
        return @{ ok = $false; reason = 'claim_namespace_missing' }
    }

    $headShape = Test-ReviewStartClaimHeadShaFormat -HeadSha $HeadSha
    if (-not $headShape.ok) {
        return @{ ok = $false; reason = $headShape.reason }
    }
    $normalizedHead = $headShape.headSha
    $matches = @()
    foreach ($file in Get-ChildItem -LiteralPath $Namespace -Filter '*.json' -File -ErrorAction SilentlyContinue) {
        $read = Read-ReviewStartClaimRecord -Path $file.FullName
        if (-not $read.ok) { continue }
        if ([string]$read.record.headSha -ne $normalizedHead) { continue }
        if (-not (Test-ReviewStartClaimRecordIsLive -Record $read.record)) { continue }
        $matches += @{
            record    = $read.record
            path      = $file.FullName
            projectId = $ProjectId
            namespace = $Namespace
        }
    }

    if ($matches.Count -eq 0) {
        return @{ ok = $false; reason = 'no_live_claim' }
    }
    if ($matches.Count -gt 1) {
        return @{ ok = $false; reason = 'ambiguous_live_claim' }
    }
    return @{ ok = $true; claim = $matches[0] }
}

function Test-AutonomousReviewWorktreeClaimBoundAllow {
    param([string[]]$Argv)

    if ([string]$env:AO_CLAIMED_REVIEW_RUN_BYPASS -eq '1') {
        # Env bypass alone never authorizes worktree add (Issue #429).
    }

    $shape = Get-GitArgvPermittedReviewWorktreeAddDetach -Argv $Argv
    if (-not $shape.ok) {
        return @{ allowed = $false; reason = $shape.reason }
    }

    $claimLookup = Find-LiveReviewStartClaimForHeadSha -HeadSha $shape.commit
    if (-not $claimLookup.ok) {
        return @{ allowed = $false; reason = $claimLookup.reason }
    }

    $claimProjectId = $claimLookup.claim.projectId
    $pathCheck = Test-AutonomousReviewWorktreeTargetPathHardened -TargetPath $shape.path -ProjectId $claimProjectId
    if (-not $pathCheck.allowed) {
        return @{ allowed = $false; reason = $pathCheck.reason }
    }

    return @{
        allowed   = $true
        reason    = 'claimed_worktree_allow'
        prNumber  = [int]$claimLookup.claim.record.prNumber
        headSha   = [string]$claimLookup.claim.record.headSha
        projectId = $claimProjectId
        path      = [string]$pathCheck.canonicalPath
    }
}
