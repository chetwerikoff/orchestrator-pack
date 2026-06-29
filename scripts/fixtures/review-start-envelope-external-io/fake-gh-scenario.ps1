#requires -Version 5.1
param([string[]]$Args)

$ErrorActionPreference = 'Stop'
$scenario = [string]$env:AO_REVIEW_START_GH_SCENARIO
$call = 0
if ($env:AO_REVIEW_START_GH_CALL_COUNT) { $call = [int]$env:AO_REVIEW_START_GH_CALL_COUNT }
$env:AO_REVIEW_START_GH_CALL_COUNT = [string]($call + 1)

function Write-Err([string]$Message) {
    [Console]::Error.WriteLine($Message)
}

switch ($scenario) {
    'dns_timeout' {
        Write-Err 'dial tcp: lookup api.github.com on 127.0.0.53:53: read udp 127.0.0.1:12345->127.0.0.53:53: i/o timeout'
        exit 1
    }
    'tls_reset' {
        Write-Err 'Get "https://api.github.com/repos/o/r/pulls?state=open": read tcp 10.0.0.1:443->140.82.121.3:443: read: connection reset by peer'
        exit 1
    }
    'auth' {
        Write-Err 'HTTP 401: Bad credentials (https://api.github.com/graphql)'
        exit 1
    }
    'hang' {
        Start-Sleep -Seconds 120
        Write-Output '[]'
        exit 0
    }
    'large_stdout' {
        $chunk = 'x' * 8192
        for ($i = 0; $i -lt 32; $i++) {
            Write-Output $chunk
        }
        exit 0
    }
    'pr510' {
        if ($call -lt 2) {
            Write-Err 'gh-wrapper: REST route failed for pr-list-open: Get "https://api.github.com/repos/o/r/pulls": dial tcp: i/o timeout'
            exit 1
        }
        Write-Output '[{"number":510,"headRefOid":"abc123def4567890abcdef1234567890abcdef12","baseRefName":"main"}]'
        exit 0
    }
    default {
        Write-Output '[]'
        exit 0
    }
}
