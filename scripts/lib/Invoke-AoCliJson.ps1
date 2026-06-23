#requires -Version 5.1
<#
.SYNOPSIS
  Parse JSON from ao CLI commands that may prefix non-JSON log lines.
#>

function Invoke-AoCliJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$AoArgs,
        [string]$FailureLabel = ''
    )

    $label = if ($FailureLabel) { $FailureLabel } else { "ao $($AoArgs -join ' ')" }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & ao @AoArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
            $text = ($raw | Out-String).Trim()
            throw "$label failed (exit $LASTEXITCODE): $text"
        }

        $text = ($raw | ForEach-Object {
                if ($_ -is [string]) { $_ }
                elseif ($null -ne $_) { $_.ToString() }
            }) -join "`n"
        $start = $text.IndexOf('{')
        if ($start -lt 0) {
            throw "$label produced no JSON output"
        }

        return $text.Substring($start) | ConvertFrom-Json
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}

function Get-AoReviewRunsFromPayload {
    param(
        $Payload,
        [string]$Project = ''
    )

    $runs = @($Payload.runs)
    if (-not $runs -and $Payload.data) {
        $runs = @($Payload.data)
    }

    if ($Project) {
        $runs = @($runs | Where-Object { $_.projectId -eq $Project })
    }

    return $runs
}

function Get-AoStatusSessionsFromPayload {
    param($Payload)

    $sessions = @($Payload.data)
    if (-not $sessions -and $Payload.sessions) {
        $sessions = @($Payload.sessions)
    }

    return $sessions
}

function Get-AoReviewListJson {
    param([string]$Project = '')

    $args = @('review', 'list')
    if ($Project) { $args += $Project }
    $args += '--json'
    return Invoke-AoCliJson -AoArgs $args -FailureLabel 'ao review list'
}

function Get-AoReviewRuns {
    param([string]$Project = '')

    $payload = Get-AoReviewListJson -Project $Project
    return Get-AoReviewRunsFromPayload -Payload $payload -Project $Project
}

function Get-AoStatusReportsJson {
    return Invoke-AoCliJson -AoArgs @('status', '--json', '--reports', 'full') -FailureLabel 'ao status'
}

function Get-AoStatusReportsIncludingTerminatedJson {
    return Invoke-AoCliJson -AoArgs @('status', '--json', '--reports', 'full', '--include-terminated') -FailureLabel 'ao status --include-terminated'
}

function Get-AoStatusSessions {
    $payload = Get-AoStatusReportsJson
    return Get-AoStatusSessionsFromPayload -Payload $payload
}

function Get-AoStatusSessionsIncludingTerminated {
    $payload = Get-AoStatusReportsIncludingTerminatedJson
    return Get-AoStatusSessionsFromPayload -Payload $payload
}

function Get-AoEventsSince {
    param([int]$SinceMinutes = 30)

    $payload = Invoke-AoCliJson -AoArgs @(
        'events', 'list', '--since', "${SinceMinutes}m", '--limit', '500', '--json'
    ) -FailureLabel 'ao events list'
    return @($payload.events)
}
