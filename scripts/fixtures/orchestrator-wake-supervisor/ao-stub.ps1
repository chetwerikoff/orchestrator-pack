#requires -Version 5.1

$failure = [string]$env:AO_WAKE_SUPERVISOR_STATUS_FAILURE
if ($args.Count -gt 0 -and $args[0] -eq 'status' -and $failure) {
    switch ($failure) {
        'connection-refused' {
            Write-Error 'dial tcp 127.0.0.1:3001: connect: connection refused'
            exit 1
        }
        'connection-reset' {
            Write-Error 'read tcp 127.0.0.1:3001: read: connection reset by peer'
            exit 1
        }
        'http-503' {
            Write-Error 'HTTP 503 Service Unavailable'
            exit 1
        }
    }
}

$fixture = [string]$env:AO_WAKE_SUPERVISOR_FIXTURE
if (-not $fixture -or -not (Test-Path -LiteralPath $fixture)) {
    Write-Error 'ao stub: missing AO_WAKE_SUPERVISOR_FIXTURE'
    exit 1
}

Get-Content -LiteralPath $fixture -Raw -Encoding UTF8
