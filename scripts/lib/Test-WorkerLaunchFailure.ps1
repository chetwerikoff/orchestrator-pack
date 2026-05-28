# Shared detection for Cursor worker prompt-delivery launch failure on Windows (Issue #63).

function Get-WorkerLaunchFailureSignature {
    <#
    .SYNOPSIS
      Classify PTY or log text for worker launch-failure signatures A/B.
    .OUTPUTS
      PSCustomObject: IsLaunchFailure, Signature ('A'|'B'|null), Messages
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    $normalized = $Text -replace "`r`n", "`n"
    $messages = New-Object System.Collections.Generic.List[string]
    $signature = $null

    if ($normalized -match '(?is)printf\s*:.*not recognized|The term ''printf'' is not recognized') {
        $signature = 'A'
        $messages.Add('Signature A: printf not recognized under PowerShell') | Out-Null
    }
    if ($normalized -match "(?is)unknown option '-ne'") {
        if (-not $signature) { $signature = 'A' }
        $messages.Add("Signature A: agent CLI saw unknown option '-ne'") | Out-Null
    }
    if ($normalized -match '(?is)command line is too long|The command line is too long') {
        if (-not $signature) { $signature = 'B' }
        else { $signature = 'A+B' }
        $messages.Add('Signature B: Windows command-line length limit exceeded') | Out-Null
    }
    if ($normalized -match '(?is)agent:\s*command not found') {
        $messages.Add('Git Bash: agent binary not on PATH (AO_SHELL=bash without shim)') | Out-Null
    }

  return [pscustomobject]@{
        IsLaunchFailure = [bool]$signature
        Signature       = $signature
        Messages        = @($messages)
    }
}

function Test-WorkerLaunchFailurePtyLog {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    $result = Get-WorkerLaunchFailureSignature -Text $Text
    return $result.IsLaunchFailure
}

function Get-WorkerPromptLaunchFeasibilityWarning {
    <#
    .SYNOPSIS
      Warn when a worker prompt file is large enough to risk Signature B on Windows.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PromptFilePath,
        [int]$ArgvLimitBytes = 8000
    )

    if (-not (Test-Path -LiteralPath $PromptFilePath -PathType Leaf)) {
        return $null
    }

    $size = (Get-Item -LiteralPath $PromptFilePath).Length
    if ($size -le $ArgvLimitBytes) {
        return $null
    }

    return "Worker prompt file is $size bytes (empirical Windows argv risk above ~$ArgvLimitBytes). AO may inline it into the launch command and fail with 'command line is too long' (Signature B). See docs/migration_notes.md (Issue #63)."
}
