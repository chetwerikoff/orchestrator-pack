#requires -Version 5.1
param([string[]]$Args)

$ErrorActionPreference = 'Stop'
$scenario = [string]$env:AO_REVIEW_START_SCOPED_GH_SCENARIO

function Write-Err([string]$Message) {
    [Console]::Error.WriteLine($Message)
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
        Write-Err 'HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/pulls/565)'
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
    default {
        Write-Err "unknown scoped gh scenario: $scenario"
        exit 2
    }
}
