# Stale orchestrator worktree / branch detection (Issue #91).

function Get-OrchestratorAoProjectPaths {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [string]$ProjectSlug = ''
    )

    if (-not $ProjectSlug) {
        $ProjectSlug = Split-Path -Leaf (Get-Location).Path
        if (-not $ProjectSlug) { $ProjectSlug = 'orchestrator-pack' }
    }

    $projectRoot = Join-Path $env:USERPROFILE ".agent-orchestrator\projects\$ProjectSlug"
    return [pscustomobject]@{
        ProjectSlug    = $ProjectSlug
        SessionId      = $SessionId
        BranchName     = "orchestrator/$SessionId"
        AoWorktreePath = Join-Path $projectRoot "worktrees\$SessionId"
        PromptPath     = Join-Path $projectRoot "prompts\orchestrator-prompt-$SessionId.md"
    }
}

function Get-OrchestratorStaleWorktreeFindings {
    <#
    .SYNOPSIS
      List stale orchestrator/* branches and AO worktree dirs for a session id.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [string]$SessionId = 'op-orchestrator',
        [string]$ProjectSlug = ''
    )

    $paths = Get-OrchestratorAoProjectPaths -SessionId $SessionId -ProjectSlug $ProjectSlug
    $findings = New-Object System.Collections.Generic.List[object]

    Push-Location -LiteralPath $RepoRoot
    try {
        $branchExists = $false
        $branchOut = & git branch --list $paths.BranchName 2>&1
        if ($LASTEXITCODE -eq 0 -and $branchOut) {
            $branchExists = $true
            $findings.Add([pscustomobject]@{
                    Kind    = 'git-branch'
                    Detail  = $paths.BranchName
                    Command = "git branch -D $($paths.BranchName)"
                }) | Out-Null
        }

        $worktreeList = @(& git worktree list --porcelain 2>$null)
        $i = 0
        while ($i -lt $worktreeList.Count) {
            $line = $worktreeList[$i]
            if ($line -match '^worktree (.+)$') {
                $wtPath = $Matches[1]
                $wtBranch = $null
                if (($i + 2) -lt $worktreeList.Count) {
                    $branchLine = $worktreeList[$i + 2]
                    if ($branchLine -match '^branch refs/heads/(.+)$') {
                        $wtBranch = $Matches[1]
                    }
                }
                $pathMatchesSession = ($wtPath -like "*\$SessionId") -or ($wtPath -like "*/$SessionId")
                if ($wtBranch -eq $paths.BranchName -or $pathMatchesSession) {
                    $branchLabel = if ($wtBranch) { $wtBranch } else { 'detached' }
                    $findings.Add([pscustomobject]@{
                            Kind    = 'git-worktree'
                            Path    = $wtPath
                            Detail  = "$wtPath ($branchLabel)"
                            Command = "git worktree remove --force `"$wtPath`""
                        }) | Out-Null
                }
            }
            $i++
        }
    }
    finally {
        Pop-Location
    }

    if (Test-Path -LiteralPath $paths.AoWorktreePath -PathType Container) {
        $findings.Add([pscustomobject]@{
                Kind    = 'ao-worktree-dir'
                Detail  = $paths.AoWorktreePath
                Command = "Remove-Item -LiteralPath '$($paths.AoWorktreePath)' -Recurse -Force"
            }) | Out-Null
    }

    return [pscustomobject]@{
        Paths    = $paths
        Findings = [object[]]$findings.ToArray()
    }
}
