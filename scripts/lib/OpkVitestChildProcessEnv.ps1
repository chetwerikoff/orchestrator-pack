#requires -Version 5.1
<#
.SYNOPSIS
  Propagate vitest harness store-isolation env into descendant PowerShell/CLI processes.
#>

function Get-OpkVitestChildProcessEnvOverrides {
    if ($env:OPK_VITEST_HARNESS -ne '1') {
        return @{}
    }

    $overrides = @{}
    $explicitKeys = @(
        'HOME',
        'USERPROFILE',
        'PATH',
        'TMPDIR',
        'TEMP',
        'TMP',
        'XDG_STATE_HOME',
        'OPK_VITEST_PRODUCTION_XDG_STATE_HOME',
        'ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR',
        'OPK_REAL_PWSH',
        'OPK_REAL_AO',
        'OPK_REAL_AO_BINARY',
        'GIT_REAL_BINARY',
        'GIT_SYSTEM_BINARY'
    )

    foreach ($item in Get-ChildItem Env:) {
        $name = [string]$item.Name
        if (-not $name) {
            continue
        }
        if ($name -like 'AO_*' -or $name -like 'OPK_VITEST_*' -or $explicitKeys -contains $name) {
            $overrides[$name] = [string]$item.Value
        }
    }

    return $overrides
}

function Merge-OpkVitestChildProcessEnv {
    param(
        [hashtable]$Environment = @{},
        [switch]$PreferExisting
    )

    $merged = @{}
    foreach ($entry in @($Environment.GetEnumerator())) {
        $merged[[string]$entry.Key] = [string]$entry.Value
    }

    foreach ($entry in @((Get-OpkVitestChildProcessEnvOverrides).GetEnumerator())) {
        $name = [string]$entry.Key
        $value = [string]$entry.Value
        if ($PreferExisting -and $merged.ContainsKey($name)) {
            continue
        }
        $merged[$name] = $value
    }

    return $merged
}

function Set-OpkVitestProcessStartInfoEnvironment {
    param([System.Diagnostics.ProcessStartInfo]$ProcessStartInfo)

    if (-not $ProcessStartInfo) {
        return
    }

    foreach ($entry in @((Get-OpkVitestChildProcessEnvOverrides).GetEnumerator())) {
        $ProcessStartInfo.Environment[[string]$entry.Key] = [string]$entry.Value
    }
}
