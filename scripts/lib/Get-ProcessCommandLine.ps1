#requires -Version 5.1
<#
  Shared process command-line reader for Linux/macOS/Windows.
#>

function Get-ProcessCommandLineById {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return '' }

    if ($IsLinux) {
        $procPath = "/proc/$ProcessId/cmdline"
        if (Test-Path -LiteralPath $procPath) {
            $raw = [System.IO.File]::ReadAllBytes($procPath)
            if ($raw.Length -eq 0) { return '' }
            $parts = New-Object System.Collections.Generic.List[string]
            $current = New-Object System.Text.StringBuilder
            foreach ($byte in $raw) {
                if ($byte -eq 0) {
                    if ($current.Length -gt 0) {
                        $parts.Add($current.ToString())
                        $current.Clear() | Out-Null
                    }
                }
                else {
                    [void]$current.Append([char]$byte)
                }
            }
            if ($current.Length -gt 0) {
                $parts.Add($current.ToString())
            }
            return ($parts -join ' ')
        }
    }

    if ($IsMacOS) {
        $out = & ps -p $ProcessId -o command= 2>$null
        return (($out | ForEach-Object { $_.ToString() }) -join ' ').Trim()
    }

    try {
        $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        return [string]$cim.CommandLine
    }
    catch {
        return ''
    }
}

function Get-OrchestratorWakeSupervisorProcessCommandLine {
    param([int]$ProcessId)
    return Get-ProcessCommandLineById -ProcessId $ProcessId
}
