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
# Trusted/base checker only; PR head supplies repoRoot for snapshots/diff (Issue #6 / #691).
$CheckScript = Join-Path $PSScriptRoot 'pr-scope-check.ts'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
$nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major." }
$typeScriptLauncher = (Join-Path $TrustedRoot 'scripts/lib/Invoke-TypeScriptCli.ts')
. (Join-Path $PSScriptRoot 'lib/Gh-SignalDispatch.ps1')

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
            $nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $CheckScript, '--')
            $output = & $node.Source @nodeArgs --format-comment --input $payloadFile.FullName
            return $output
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

    $eventsRead = Invoke-GhSignalJsonCommand `
        -Arguments @('api', "repos/$Repository/issues/$PrNumber/events", '--paginate') `
        -ExpectedRoot 'array' `
        -WorkingDirectory $TrustedRoot
    if (-not $eventsRead.ok) {
        return $false
    }
    $events = @($eventsRead.value)

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
            $nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $CheckScript, '--')
            $output = & $node.Source @nodeArgs --input $payloadFile.FullName
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
$prHeadRef = [string]($env:PR_HEAD_REF ?? '')
$sameRepo = ($env:PR_HEAD_REPO_SAME ?? 'false').ToLowerInvariant() -eq 'true'
$degradedRequested = ($env:SCOPE_GUARD_DEGRADED_LABEL ?? 'false').ToLowerInvariant() -eq 'true'

if (-not $prNumber -or -not $repository) {
    Write-Error 'PR_NUMBER and GITHUB_REPOSITORY are required for pr-scope-check.ps1'
}

# Always read the PR body via gh — do not pass github.event.pull_request.body through
# workflow env (PR_BODY). Multiline bodies with colons truncate in GHA env injection.
$prRead = Invoke-GhSignalJsonCommand `
    -Arguments @('pr', 'view', [string]$prNumber, '--repo', $repository, '--json', 'body') `
    -ExpectedRoot 'object' `
    -WorkingDirectory $TrustedRoot
if (-not $prRead.ok) {
    Write-Error "gh pr view failed: $(Format-GhSignalFailureDetail -Result $prRead)"
}
$prBody = Normalize-PrBody -Body ([string]$prRead.value.body)

function Get-ScopeGuardIssueNumber {
    param([string]$Body)

    $payloadFile = New-TemporaryFile
    try {
        (@{ prBody = $Body } | ConvertTo-Json -Depth 5 -Compress) | Set-Content -LiteralPath $payloadFile.FullName -Encoding utf8NoBOM
        Push-Location $TrustedRoot
        try {
            $nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $CheckScript, '--')
            $output = & $node.Source @nodeArgs --resolve-issue-number --input $payloadFile.FullName
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

function Read-ScopeGuardIssueBody {
    param(
        [int]$IssueNumber,
        [string]$WorkingDirectory
    )

    try {
        $issueRead = Invoke-GhSignalJsonCommand `
            -Arguments @('issue', 'view', [string]$IssueNumber, '--json', 'body') `
            -ExpectedRoot 'object' `
            -WorkingDirectory $WorkingDirectory
        if (-not $issueRead.ok) {
            return @{ ok = $false; body = ''; reason = [string]$issueRead.reason }
        }
        return @{ ok = $true; body = [string]$issueRead.value.body; reason = '' }
    }
    catch {
        return @{ ok = $false; body = ''; reason = 'gh_signal_dispatch_failed' }
    }
}

$issueBody = $null
$issueReadFailed = $false
$linkedIssueNumber = Get-ScopeGuardIssueNumber -Body $prBody

if ($linkedIssueNumber) {
    $issueRead = Read-ScopeGuardIssueBody -IssueNumber $linkedIssueNumber -WorkingDirectory $TrustedRoot
    if ($issueRead.ok) {
        $issueBody = [string]$issueRead.body
    }
    else {
        $issueReadFailed = $true
    }
}

$degradedMode = $false
if ($isFork -and $issueReadFailed) {
    if ($degradedRequested -and (Test-DegradedLabelAuthorized -Repository $repository -PrNumber $prNumber)) {
        $degradedMode = $true
    }
}

function Get-PrChangedPaths {
    param(
        [string]$Repository,
        [int]$PrNumber,
        [string]$WorkingDirectory
    )

    $pageSize = 100
    $maxPages = 30
    $page = 1
    $paths = [System.Collections.Generic.List[string]]::new()

    while ($true) {
        $endpoint = "repos/$Repository/pulls/$PrNumber/files?per_page=$pageSize&page=$page"
        $filesRead = Invoke-GhSignalJsonCommand `
            -Arguments @('api', $endpoint, '--jq', '[.[].filename]') `
            -ExpectedRoot 'array' `
            -WorkingDirectory $WorkingDirectory
        if (-not $filesRead.ok) {
            Write-Error "failed to enumerate PR files page $page for PR #${PrNumber}: $(Format-GhSignalFailureDetail -Result $filesRead)"
        }

        $pagePaths = @($filesRead.value)
        foreach ($filenameValue in $pagePaths) {
            $filename = [string]$filenameValue
            if ([string]::IsNullOrWhiteSpace($filename)) {
                Write-Error "PR files response contained an entry without filename for PR #$PrNumber on page $page"
            }
            $paths.Add($filename)
        }

        if ($pagePaths.Count -lt $pageSize) { break }
        if ($page -ge $maxPages) {
            Write-Error "PR files response reached the 3000-file API ceiling for PR #$PrNumber; refusing a possibly truncated scope"
        }
        $page += 1
    }

    return @($paths)
}

$prPaths = @(Get-PrChangedPaths -Repository $repository -PrNumber $prNumber -WorkingDirectory $TrustedRoot)

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
    prHeadRef    = $prHeadRef
    sameRepo     = $sameRepo
}

$result = Invoke-PrScopeCheckCore -InputJson $input
Write-ScopeGuardComment -Body (Format-ScopeGuardComment -Result $result) -PrNumber $prNumber

if (-not $result.ok) {
    Write-Host "scope guard failed: $($result.message)"
    exit 1
}

Write-Host 'scope guard passed'
exit 0
