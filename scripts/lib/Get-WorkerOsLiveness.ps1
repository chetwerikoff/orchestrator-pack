#requires -Version 5.1

function Get-WorkerOsLiveness {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [string]$TmuxCommand = 'tmux'
    )

    if ([string]::IsNullOrWhiteSpace($SessionId)) {
        return 'unknown'
    }
    if (-not (Get-Command $TmuxCommand -ErrorAction SilentlyContinue)) {
        return 'unknown'
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & $TmuxCommand has-session -t $SessionId 2>$null
        if ($LASTEXITCODE -eq 0) { return 'pane-alive' }
        return 'pane-gone'
    }
    catch {
        return 'unknown'
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}

function Get-WorkerOsLivenessMap {
    param([object[]]$Sessions)

    $map = @{}
    foreach ($session in @($Sessions)) {
        if (-not $session) { continue }
        $sessionId = [string]($session.sessionId ?? $session.id ?? $session.name)
        if (-not $sessionId) { continue }
        $map[$sessionId] = Get-WorkerOsLiveness -SessionId $sessionId
    }
    return $map
}
