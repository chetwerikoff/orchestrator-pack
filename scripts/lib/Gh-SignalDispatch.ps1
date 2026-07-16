#requires -Version 5.1
<# Thin PowerShell dispatch for the TypeScript gh signal classifier (Issue #849). #>

. (Join-Path $PSScriptRoot 'Invoke-TypeScriptCli.ps1')

$Script:GhSignalClassifierCli = Join-Path $PSScriptRoot 'gh-signal-classifier.ts'

function Invoke-GhSignalJsonCommand {
    param(
        [string]$Command = 'gh',
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [ValidateSet('array', 'object', 'number', 'any')]
        [string]$ExpectedRoot = 'any',
        [int[]]$AllowedExitCodes = @(0),
        [string]$WorkingDirectory = '',
        [string]$FixturePath = ''
    )

    $inputPath = Join-Path ([System.IO.Path]::GetTempPath()) ("gh-signal-input-{0}.json" -f [guid]::NewGuid().ToString('n'))
    $outputPath = Join-Path ([System.IO.Path]::GetTempPath()) ("gh-signal-output-{0}.json" -f [guid]::NewGuid().ToString('n'))
    try {
        $payload = @{
            command          = $Command
            args             = @($Arguments)
            expectedRoot     = $ExpectedRoot
            allowedExitCodes = @($AllowedExitCodes)
        }
        if ($WorkingDirectory) { $payload.cwd = $WorkingDirectory }
        if ($FixturePath) { $payload.fixturePath = $FixturePath }
        $json = $payload | ConvertTo-Json -Depth 20 -Compress
        if (Get-Command Write-MechanicalTransportPrivateFile -ErrorAction SilentlyContinue) {
            Write-MechanicalTransportPrivateFile -Path $inputPath -Content $json
        }
        else {
            [System.IO.File]::WriteAllText($inputPath, $json, [System.Text.UTF8Encoding]::new($false))
        }

        $nodeArgs = @(Get-OpkTypeScriptNodeArguments -ScriptPath $Script:GhSignalClassifierCli)
        $nodeDiagnostic = & node @nodeArgs run `
            --input-file $inputPath --output-file $outputPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "gh signal classifier failed (exit $LASTEXITCODE): $nodeDiagnostic"
        }
        if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
            throw 'gh signal classifier produced no output envelope'
        }
        $result = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
        if ($nodeDiagnostic) {
            [Console]::Error.WriteLine((@($nodeDiagnostic | ForEach-Object { [string]$_ }) -join "`n"))
        }
        if ([string]$result.stderr) {
            [Console]::Error.Write([string]$result.stderr)
            if (-not ([string]$result.stderr).EndsWith("`n")) { [Console]::Error.WriteLine() }
        }
        return $result
    }
    finally {
        Remove-Item -LiteralPath $inputPath, $outputPath -Force -ErrorAction SilentlyContinue
    }
}

function Format-GhSignalFailureDetail {
    param([object]$Result)

    $parts = @("reason=$([string]$Result.reason)")
    if ($null -ne $Result.exitCode) { $parts += "exit=$([int]$Result.exitCode)" }
    if ([string]$Result.stderr) { $parts += "stderr=$(([string]$Result.stderr).Trim())" }
    if ([string]$Result.stdout) { $parts += "stdout=$(([string]$Result.stdout).Trim())" }
    return ($parts -join '; ')
}
