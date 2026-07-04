#requires -Version 5.1
param([string[]]$Args)

$ErrorActionPreference = 'Stop'
$scenario = [string]$env:AO_REVIEW_START_SCOPED_GH_SCENARIO

function Write-Err([string]$Message) {
    [Console]::Error.WriteLine($Message)
}

function Get-ScopedGhScenarioAttempt {
    $stateFile = [string]$env:AO_REVIEW_START_SCOPED_GH_STATE_FILE
    if (-not $stateFile) { return 1 }
    $count = 0
    if (Test-Path -LiteralPath $stateFile) {
        $raw = Get-Content -LiteralPath $stateFile -Raw
        [void][int]::TryParse([string]$raw, [ref]$count)
    }
    $count++
    Set-Content -LiteralPath $stateFile -Value ([string]$count) -Encoding UTF8
    return $count
}

function Write-OpenPrJson {
    param([int]$PrNumber, [string]$HeadSha)
    if ($PrNumber -le 0) { $PrNumber = 565 }
    Write-Output (@{
        number      = $PrNumber
        headRefOid  = $HeadSha
        baseRefName = 'main'
        state       = 'OPEN'
    } | ConvertTo-Json -Compress)
}

$prNumber = 0
for ($i = 0; $i -lt $Args.Count; $i++) {
    if ([string]$Args[$i] -eq 'view' -and ($i + 1) -lt $Args.Count) {
        $parsed = 0
        if ([int]::TryParse([string]$Args[$i + 1], [ref]$parsed)) {
            $prNumber = $parsed
        }
        break
    }
}

switch ($scenario) {
    'bashdb_stderr_valid_json' {
        $head = [string]$env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA
        if (-not $head) {
            $head = '31fc8c6143c23e6db1b47fa8525aced110e2f84e'
        }
        if ($prNumber -le 0) { $prNumber = 565 }
        Write-Output (@{
            number      = $prNumber
            headRefOid  = $head
            baseRefName = 'main'
            state       = 'OPEN'
        } | ConvertTo-Json -Compress)
        Write-Err '/usr/share/bashdb/debugger-support.db: No such file or directory'
        exit 0
    }
    'malformed_stdout' {
        Write-Output 'not-json'
        exit 0
    }
    'gh_command_failed' {
        Write-Err 'gh: command failed: unexpected error'
        exit 1
    }
    'closed_pr' {
        if ($prNumber -le 0) { $prNumber = 565 }
        Write-Output (@{
            number      = $prNumber
            headRefOid  = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
            baseRefName = 'main'
            state       = 'CLOSED'
        } | ConvertTo-Json -Compress)
        exit 0
    }
    'fill_stderr_then_valid_json' {
        $head = [string]$env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA
        if (-not $head) {
            $head = '31fc8c6143c23e6db1b47fa8525aced110e2f84e'
        }
        if ($prNumber -le 0) { $prNumber = 565 }
        for ($i = 0; $i -lt 2000; $i++) {
            Write-Err "stderr-line-$i"
        }
        Write-Output (@{
            number      = $prNumber
            headRefOid  = $head
            baseRefName = 'main'
            state       = 'OPEN'
        } | ConvertTo-Json -Compress)
        exit 0
    }
    'primary_rate_limit_then_ok' {
        $attempt = Get-ScopedGhScenarioAttempt
        $failUntil = [int]([string]$env:AO_REVIEW_START_SCOPED_GH_FAIL_UNTIL_ATTEMPT)
        if ($failUntil -le 0) { $failUntil = 1 }
        if ($attempt -le $failUntil) {
            Write-Err 'retry-after: 1'
            Write-Err 'x-ratelimit-remaining: 0'
            Write-Err 'x-ratelimit-reset: 9999999999'
            Write-Err 'HTTP 403: API rate limit exceeded for user'
            exit 1
        }
        $head = [string]$env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA
        if (-not $head) { $head = '31fc8c6143c23e6db1b47fa8525aced110e2f84e' }
        Write-OpenPrJson -PrNumber $prNumber -HeadSha $head
        exit 0
    }
    'secondary_403_then_ok' {
        $attempt = Get-ScopedGhScenarioAttempt
        if ($attempt -le 1) {
            Write-Err 'retry-after: 1'
            Write-Err 'HTTP 403: You have triggered an abuse detection mechanism. Please wait before retrying.'
            exit 1
        }
        $head = [string]$env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA
        if (-not $head) { $head = '31fc8c6143c23e6db1b47fa8525aced110e2f84e' }
        Write-OpenPrJson -PrNumber $prNumber -HeadSha $head
        exit 0
    }
    'http_429_then_ok' {
        $attempt = Get-ScopedGhScenarioAttempt
        if ($attempt -le 1) {
            Write-Err 'retry-after: 1'
            Write-Err 'HTTP 429: Too Many Requests'
            exit 1
        }
        $head = [string]$env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA
        if (-not $head) { $head = '31fc8c6143c23e6db1b47fa8525aced110e2f84e' }
        Write-OpenPrJson -PrNumber $prNumber -HeadSha $head
        exit 0
    }
    'upstream_502_then_ok' {
        $attempt = Get-ScopedGhScenarioAttempt
        if ($attempt -le 1) {
            Write-Err 'HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/pulls/565)'
            exit 1
        }
        $head = [string]$env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA
        if (-not $head) { $head = '31fc8c6143c23e6db1b47fa8525aced110e2f84e' }
        Write-OpenPrJson -PrNumber $prNumber -HeadSha $head
        exit 0
    }
    'always_rate_limit' {
        Write-Err 'HTTP 429: Too Many Requests'
        exit 1
    }
    'head_drift_then_ok' {
        $attempt = Get-ScopedGhScenarioAttempt
        $headA = [string]$env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA_A
        $headB = [string]$env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA_B
        if (-not $headA) { $headA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
        if (-not $headB) { $headB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
        if ($attempt -le 1) {
            Write-Err 'HTTP 429: Too Many Requests'
            exit 1
        }
        Write-OpenPrJson -PrNumber $prNumber -HeadSha $headB
        exit 0
    }
    'gh_auth_failed' {
        Write-Err 'HTTP 401: Bad credentials'
        exit 1
    }
    'policy_denied' {
        Write-Err 'policy boundary deny: review-start preflight blocked'
        exit 1
    }
    default {
        Write-Err "unknown scoped gh scenario: $scenario"
        exit 2
    }
}
