#requires -Version 5.1
<#
  Issue #948 observer bridge. This file no longer loads or implements the
  PowerShell side-process supervisor. It exposes only bounded read/parse
  helpers needed by surviving operator and test surfaces.
#>

. (Join-Path $PSScriptRoot 'Orchestrator-WakeSupervisorStateRoot.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessHealth.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessProgressEvidence.ps1')
. (Join-Path $PSScriptRoot 'Get-ProcessCommandLine.ps1')

$Script:OrchestratorSideProcessPackRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$Script:OrchestratorSideProcessTestChildScript = Join-Path $Script:OrchestratorSideProcessPackRoot 'scripts/orchestrator-wake-supervisor-test-child.ps1'
$Script:OrchestratorSideProcessObserverCli = Join-Path $PSScriptRoot 'orchestrator-side-process-observer-cli.ts'

function ConvertTo-OrchestratorObserverHashtable {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [bool] -or $Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or $Value -is [double] -or $Value -is [decimal]) { return $Value }
    if ($Value -is [System.Collections.IDictionary]) {
        $map = @{}
        foreach ($key in $Value.Keys) { $map[[string]$key] = ConvertTo-OrchestratorObserverHashtable $Value[$key] }
        return $map
    }
    if ($Value -is [pscustomobject]) {
        $map = @{}
        foreach ($property in $Value.PSObject.Properties) { $map[$property.Name] = ConvertTo-OrchestratorObserverHashtable $property.Value }
        return $map
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return @($Value | ForEach-Object { ConvertTo-OrchestratorObserverHashtable $_ })
    }
    return $Value
}

function Invoke-OrchestratorSideProcessObserver {
    param([Parameter(Mandatory = $true)][string]$Operation, [hashtable]$Payload = @{})
    if (-not (Test-Path -LiteralPath $Script:OrchestratorSideProcessObserverCli -PathType Leaf)) {
        throw "Missing side-process observer: $Script:OrchestratorSideProcessObserverCli"
    }
    $json = $Payload | ConvertTo-Json -Depth 20 -Compress
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'node'
    $psi.ArgumentList.Add('--no-warnings')
    $psi.ArgumentList.Add('--experimental-strip-types')
    $psi.ArgumentList.Add($Script:OrchestratorSideProcessObserverCli)
    $psi.ArgumentList.Add($Operation)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    [void]$process.Start()
    $process.StandardInput.Write($json)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "side-process observer failed ($($process.ExitCode)): $stderr" }
    if (-not $stdout.Trim()) { return $null }
    return ConvertTo-OrchestratorObserverHashtable ($stdout | ConvertFrom-Json)
}

function Get-OrchestratorWakeSupervisorDefaultProjectId { return [string](Invoke-OrchestratorSideProcessObserver 'default-project-id') }
function Get-OrchestratorWakeSupervisorChildRegistry { return @(Invoke-OrchestratorSideProcessObserver 'registry') }
function Get-OrchestratorWakeSupervisorChildEntry { param([string]$ChildId) return Invoke-OrchestratorSideProcessObserver 'child-entry' @{ ChildId = $ChildId } }
function Get-OrchestratorWakeSupervisorPaths { param([string]$StateRoot) return Invoke-OrchestratorSideProcessObserver 'paths' @{ StateRoot = $StateRoot } }
function Normalize-OrchestratorWakeSupervisorPath { param([string]$PathValue) return [string](Invoke-OrchestratorSideProcessObserver 'normalize-path' @{ PathValue = $PathValue }) }
function Get-OrchestratorWakeSupervisorCommandLineSwitchValue { param([string[]]$Tokens, [string]$SwitchName) return Invoke-OrchestratorSideProcessObserver 'switch-value' @{ Tokens = @($Tokens); SwitchName = $SwitchName } }
function Test-OrchestratorWakeSupervisorCommandLineHasSwitch { param([string[]]$Tokens, [string]$SwitchName) return [bool](Invoke-OrchestratorSideProcessObserver 'has-switch' @{ Tokens = @($Tokens); SwitchName = $SwitchName }) }
function Get-OrchestratorWakeSupervisorCommandLineScriptPath { param([string[]]$Tokens) return [string](Invoke-OrchestratorSideProcessObserver 'script-path' @{ Tokens = @($Tokens) }) }
function Test-OrchestratorWakeSupervisorSupervisorCommandLineIdentity { param([string]$CommandLine = '', [string[]]$Tokens = @(), [string]$ProjectId, [string]$StateRoot) return [bool](Invoke-OrchestratorSideProcessObserver 'supervisor-command-identity' @{ CommandLine = $CommandLine; Tokens = @($Tokens); ProjectId = $ProjectId; StateRoot = $StateRoot }) }
function Read-OrchestratorWakeSupervisorPidFile { param([string]$Path) return [int](Invoke-OrchestratorSideProcessObserver 'read-pid' @{ Path = $Path }) }
function Test-OrchestratorWakeSupervisorSideEffectInFlight { param([hashtable]$Paths, [string]$ChildId) $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId $ChildId; if (-not $entry -or -not $entry.SideEffecting -or -not $entry.SideEffectLockFile) { return $false }; $lockPath = $Paths["${ChildId}Lock"]; if (-not $lockPath) { $lockPath = Join-Path $Paths.Root $entry.SideEffectLockFile }; return Test-OrchestratorSideEffectInFlight -LockPath $lockPath }
