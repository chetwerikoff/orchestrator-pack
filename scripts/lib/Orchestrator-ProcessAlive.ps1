#requires -Version 5.1

function Test-ProcessAlive {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return $false }
    try {
        $proc = Get-Process -Id $ProcessId -ErrorAction Stop
        return -not $proc.HasExited
    }
    catch {
        return $false
    }
}
