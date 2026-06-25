#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Executable,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Remaining
)

$ErrorActionPreference = 'Stop'
$guardDir = $PSScriptRoot
$shCandidates = @(
    (Join-Path ${env:ProgramFiles} 'Git\usr\bin\sh.exe'),
    (Join-Path ${env:ProgramFiles} 'Git\bin\sh.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\sh.exe')
)
$sh = $shCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $sh) {
    $command = Get-Command sh -ErrorAction SilentlyContinue
    if ($command) {
        $sh = $command.Source
    }
}
if (-not $sh) {
    $payload = @{
        executable = $Executable
        decision   = 'skipped_or_denied_slow_test'
        reason     = 'command guard sh unavailable on Windows'
    } | ConvertTo-Json -Compress
    Write-Error "review-test-budget:$payload"
    exit 127
}

$wrapper = Join-Path $guardDir $Executable
& $sh $wrapper @Remaining
exit $LASTEXITCODE
