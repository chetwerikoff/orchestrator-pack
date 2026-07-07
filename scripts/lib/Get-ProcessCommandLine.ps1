#requires -Version 5.1
<#
  Shared process command-line reader for Linux/macOS/Windows.
#>

function Get-ProcessCommandLinePartsById {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return @() }

    if ($IsLinux) {
        $procPath = "/proc/$ProcessId/cmdline"
        if (Test-Path -LiteralPath $procPath) {
            $raw = [System.IO.File]::ReadAllBytes($procPath)
            if ($raw.Length -eq 0) { return @() }
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
            return [string[]]$parts.ToArray()
        }
        return @()
    }

    if ($IsMacOS) {
        $out = & ps -p $ProcessId -o command= 2>$null
        $commandLine = (($out | ForEach-Object { $_.ToString() }) -join ' ').Trim()
        if (-not $commandLine) { return @() }
        return [string[]](Split-ProcessCommandLineTokens -CommandLine $commandLine)
    }

    try {
        $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        $commandLine = [string]$cim.CommandLine
        if (-not $commandLine) { return @() }
        return [string[]](Split-ProcessCommandLineTokens -CommandLine $commandLine)
    }
    catch {
        return @()
    }
}

function Get-ProcessCommandLineById {
    param([int]$ProcessId)

    $parts = @(Get-ProcessCommandLinePartsById -ProcessId $ProcessId)
    if ($parts.Count -eq 0) { return '' }
    return ($parts -join ' ')
}

function Get-OrchestratorWakeSupervisorProcessCommandLineFixture {
    param([int]$ProcessId)

    $fixturePath = $env:AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE
    if (-not $fixturePath) { return $null }
    if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) { return $null }

    try {
        $map = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }

    $key = [string]$ProcessId
    if ($map.PSObject.Properties.Name -contains $key) {
        return [string]$map.$key
    }
    return $null
}


function Get-OrchestratorWakeSupervisorProcessCommandLineTokens {
    param([int]$ProcessId)

    $fixture = Get-OrchestratorWakeSupervisorProcessCommandLineFixture -ProcessId $ProcessId
    if ($null -ne $fixture) {
        return Split-ProcessCommandLineTokens -CommandLine $fixture
    }
    return Get-ProcessCommandLinePartsById -ProcessId $ProcessId
}

function Get-OrchestratorWakeSupervisorProcessCommandLine {
    param([int]$ProcessId)

    $fixture = Get-OrchestratorWakeSupervisorProcessCommandLineFixture -ProcessId $ProcessId
    if ($null -ne $fixture) {
        return $fixture
    }
    return Get-ProcessCommandLineById -ProcessId $ProcessId
}

function Split-ProcessCommandLineTokens {
    param([string]$CommandLine)

    $tokens = New-Object System.Collections.Generic.List[string]
    if (-not $CommandLine) {
        return @()
    }

    $current = New-Object System.Text.StringBuilder
    $inSingle = $false
    $inDouble = $false
    for ($index = 0; $index -lt $CommandLine.Length; $index++) {
        $char = $CommandLine[$index]
        if ($char -eq "'" -and -not $inDouble) {
            $inSingle = -not $inSingle
            continue
        }
        if ($char -eq '"' -and -not $inSingle) {
            $inDouble = -not $inDouble
            continue
        }
        if ([char]::IsWhiteSpace($char) -and -not $inSingle -and -not $inDouble) {
            if ($current.Length -gt 0) {
                $tokens.Add($current.ToString())
                $current.Clear() | Out-Null
            }
            continue
        }
        [void]$current.Append($char)
    }
    if ($current.Length -gt 0) {
        $tokens.Add($current.ToString())
    }
    return ,@($tokens.ToArray())
}
