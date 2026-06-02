[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$TrustedRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
if ($env:PR_SCOPE_REPO_ROOT) {
    $PrRoot = (Resolve-Path $env:PR_SCOPE_REPO_ROOT).Path
}
else {
    $PrRoot = $TrustedRoot
}
$CheckScript = Join-Path $PSScriptRoot 'pr-scope-check.ts'

function Write-ScopeGuardComment {
    param(
        [string]$Body,
        [int]$PrNumber
    )

    if (-not $PrNumber) {
        return
    }

    $commentFile = New-TemporaryFile
    try {
        Set-Content -LiteralPath $commentFile.FullName -Value $Body -Encoding utf8NoBOM
        gh pr comment $PrNumber --body-file $commentFile.FullName | Out-Null
    }
    finally {
        Remove-Item -LiteralPath $commentFile.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Format-ScopeGuardComment {
    param(
        [object]$Result
    )

    $payloadFile = New-TemporaryFile
    try {
        $Result | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $payloadFile.FullName -Encoding utf8NoBOM
        Push-Location $TrustedRoot
        try {
            return node --import tsx $CheckScript --format-comment --input $payloadFile.FullName
        }
        finally {
            Pop-Location
        }
    }
    finally {
        Remove-Item -LiteralPath $payloadFile.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Normalize-PrBody {
    param([string]$Body)

    if ([string]::IsNullOrWhiteSpace($Body)) {
        return ''
    }

    $text = $Body.Trim()
    if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) {
        $text = $text.Substring(1)
    }

    return $text
}

function Test-DegradedLabelAuthorized {
    param(
        [string]$Repository,
        [int]$PrNumber
    )

    $events = gh api "repos/$Repository/issues/$PrNumber/events" --paginate 2>$null | ConvertFrom-Json
    if (-not $events) {
        return $false
    }

    $labelEvents = @($events | Where-Object {
            $_.event -eq 'labeled' -and $_.label.name -eq 'scope-guard-degraded'
        })

    if ($labelEvents.Count -eq 0) {
        return $false
    }

    $latest = $labelEvents[-1]
    $actor = $latest.actor.login
    if (-not $actor) {
        return $false
    }

    $permission = gh api "repos/$Repository/collaborators/$actor/permission" --jq '.permission' 2>$null
    return $permission -in @('write', 'maintain', 'admin')
}

function Invoke-PrScopeCheckCore {
    param(
        [hashtable]$InputJson
    )

    $payloadFile = New-TemporaryFile
    try {
        $InputJson | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $payloadFile.FullName -Encoding utf8NoBOM
        Push-Location $TrustedRoot
        try {
            $output = node --import tsx $CheckScript --input $payloadFile.FullName
        }
        finally {
            Pop-Location
        }
        if ($LASTEXITCODE -eq 2) {
            throw 'pr-scope-check.ts failed with configuration error'
        }
        return $output | ConvertFrom-Json
    }
    finally {
        Remove-Item -LiteralPath $payloadFile.FullName -Force -ErrorAction SilentlyContinue
    }
}

$prNumber = [int]($env:PR_NUMBER ?? '0')
$repository = $env:GITHUB_REPOSITORY
$isFork = ($env:PR_HEAD_REPO_FORK ?? 'false').ToLowerInvariant() -eq 'true'
$degradedRequested = ($env:SCOPE_GUARD_DEGRADED_LABEL ?? 'false').ToLowerInvariant() -eq 'true'

if (-not $prNumber -or -not $repository) {
    Write-Error 'PR_NUMBER and GITHUB_REPOSITORY are required for pr-scope-check.ps1'
}

# Always read the PR body via gh — do not pass github.event.pull_request.body through
# workflow env (PR_BODY). Multiline bodies with colons truncate in GHA env injection.
$prJson = gh pr view $prNumber --repo $repository --json body | ConvertFrom-Json
$prBody = Normalize-PrBody -Body ([string]$prJson.body)

function Get-ScopeGuardIssueNumber {
    param([string]$Body)

    $payloadFile = New-TemporaryFile
    try {
        (@{ prBody = $Body } | ConvertTo-Json -Depth 5 -Compress) | Set-Content -LiteralPath $payloadFile.FullName -Encoding utf8NoBOM
        Push-Location $TrustedRoot
        try {
            $output = node --import tsx $CheckScript --resolve-issue-number --input $payloadFile.FullName
        }
        finally {
            Pop-Location
        }
        if ($LASTEXITCODE -ne 0) {
            return $null
        }
        $parsed = $output | ConvertFrom-Json
        if ($null -eq $parsed.issueNumber) {
            return $null
        }
        return [int]$parsed.issueNumber
    }
    finally {
        Remove-Item -LiteralPath $payloadFile.FullName -Force -ErrorAction SilentlyContinue
    }
}

$issueBody = $null
$issueReadFailed = $false
$linkedIssueNumber = Get-ScopeGuardIssueNumber -Body $prBody

if ($linkedIssueNumber) {
    $issueViewOutput = gh issue view $linkedIssueNumber --json body 2>&1
    if ($LASTEXITCODE -ne 0) {
        $issueReadFailed = $true
    }
    else {
        try {
            $issueJson = $issueViewOutput | ConvertFrom-Json
            $issueBody = [string]$issueJson.body
        }
        catch {
            $issueReadFailed = $true
        }
    }
}

$degradedMode = $false
if ($isFork -and $issueReadFailed) {
    if ($degradedRequested -and (Test-DegradedLabelAuthorized -Repository $repository -PrNumber $prNumber)) {
        $degradedMode = $true
    }
}

$prPaths = @(gh pr diff $prNumber --name-only)
if ($LASTEXITCODE -ne 0) {
    Write-Error "gh pr diff failed for PR #$prNumber"
}

$operatorAdoptionCheck = Join-Path $PSScriptRoot 'check-operator-adoption-example.ps1'
if (Test-Path -LiteralPath $operatorAdoptionCheck -PathType Leaf) {
    & $operatorAdoptionCheck -ChangedPaths $prPaths -PrBody $prBody
    if ($LASTEXITCODE -ne 0) {
        $adoptionFailure = [pscustomobject]@{
            ok      = $false
            reason  = 'operator_adoption_handoff'
            message = 'agent-orchestrator.yaml.example changed without docs/migration_notes.md or PR-body waiver (No operator adoption required)'
        }
        Write-ScopeGuardComment -Body (Format-ScopeGuardComment -Result $adoptionFailure) -PrNumber $prNumber
        Write-Host $adoptionFailure.message
        exit 1
    }
}

$input = @{
    repoRoot     = $PrRoot
    prBody       = $prBody
    issueBody    = if ($issueReadFailed) { $null } else { $issueBody }
    prPaths      = $prPaths
    degradedMode = $degradedMode
    forkPr       = $isFork
}

$result = Invoke-PrScopeCheckCore -InputJson $input
Write-ScopeGuardComment -Body (Format-ScopeGuardComment -Result $result) -PrNumber $prNumber

if (-not $result.ok) {
    Write-Host "scope guard failed: $($result.message)"
    exit 1
}

Write-Host 'scope guard passed'
exit 0
