#requires -Version 5.1

function Invoke-RuntimeWorkerCli {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('readiness','list','find')][string]$Command,
        [string]$Adapter = '',
        [string]$Cwd = '',
        [int]$TimeoutMs = 0,
        [string]$Workspace = 'active',
        [string]$Runtime = '',
        [string]$Id = '',
        [string]$Generation = ''
    )
    $packRoot = [string](Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
    $launcher = Join-Path $packRoot 'scripts/lib/Invoke-TypeScriptCli.ts'
    $cli = Join-Path $packRoot 'scripts/runtime/runtime-cli.ts'
    $args = @('--experimental-strip-types', $launcher, '--repo-root', $packRoot, '--script', $cli, '--', $Command)
    if ($Adapter) { $args += @('--adapter', $Adapter) }
    if ($Cwd) { $args += @('--cwd', $Cwd) }
    if ($TimeoutMs -gt 0) { $args += @('--timeout-ms', [string]$TimeoutMs) }
    if ($Command -eq 'list' -and $Workspace) { $args += @('--workspace', $Workspace) }
    if ($Command -eq 'find') {
        $args += @('--runtime', $Runtime, '--id', $Id, '--generation', $Generation)
    }
    $raw = & node @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "runtime-cli $Command failed (exit $LASTEXITCODE): $($raw -join [Environment]::NewLine)" }
    $text = ($raw | ForEach-Object { [string]$_ }) -join "`n"
    if (-not $text.Trim()) { throw "runtime-cli $Command returned empty stdout" }
    return $text | ConvertFrom-Json
}

function Get-RuntimeReadiness { param([string]$Adapter = '', [string]$Cwd = '', [int]$TimeoutMs = 0) return Invoke-RuntimeWorkerCli -Command readiness -Adapter $Adapter -Cwd $Cwd -TimeoutMs $TimeoutMs }
function Get-RuntimeWorkers { param([string]$Adapter = '', [string]$Cwd = '', [int]$TimeoutMs = 0, [string]$Workspace = 'active') return Invoke-RuntimeWorkerCli -Command list -Adapter $Adapter -Cwd $Cwd -TimeoutMs $TimeoutMs -Workspace $Workspace }
function Find-RuntimeWorker { param([Parameter(Mandatory=$true)][string]$Runtime,[Parameter(Mandatory=$true)][string]$Id,[Parameter(Mandatory=$true)][string]$Generation,[string]$Adapter = '',[string]$Cwd = '',[int]$TimeoutMs = 0) return Invoke-RuntimeWorkerCli -Command find -Runtime $Runtime -Id $Id -Generation $Generation -Adapter $Adapter -Cwd $Cwd -TimeoutMs $TimeoutMs }
