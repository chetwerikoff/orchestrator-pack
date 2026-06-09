#requires -Version 5.1
<#
.SYNOPSIS
  Shared Node stdin/JSON filter and mechanical state-file helpers for reconcile scripts.
#>

$Script:MechanicalJsonReflectionKeys = @(
    'Keys', 'Values', 'Count', 'SyncRoot', 'IsFixedSize', 'IsReadOnly', 'IsSynchronized'
)

function Get-MechanicalJsonReflectionKeys {
    return @($Script:MechanicalJsonReflectionKeys)
}

function Test-MechanicalJsonReflectionKey {
    param([string]$Key)
    return $Script:MechanicalJsonReflectionKeys -contains $Key
}

function ConvertTo-MechanicalJsonMap {
    param([object]$Value)

    $map = @{}
    if ($null -eq $Value) {
        return $map
    }

    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in @($Value.Keys)) {
            $name = [string]$key
            if (Test-MechanicalJsonReflectionKey -Key $name) {
                continue
            }
            $map[$name] = $Value[$key]
        }
        return $map
    }

    foreach ($prop in $Value.PSObject.Properties) {
        if ($prop.MemberType -ne 'NoteProperty' -and $prop.MemberType -ne 'Property') {
            continue
        }
        if (Test-MechanicalJsonReflectionKey -Key $prop.Name) {
            continue
        }
        $map[$prop.Name] = $prop.Value
    }
    return $map
}

function Copy-MechanicalJsonMap {
    param([object]$Map)
    return ConvertTo-MechanicalJsonMap -Value $Map
}

function Get-MechanicalJsonStateMapFieldNames {
    param([hashtable]$DefaultState)

    $names = @()
    foreach ($key in @($DefaultState.Keys)) {
        $defaultValue = $DefaultState[$key]
        if ($defaultValue -is [System.Collections.IDictionary]) {
            $names += [string]$key
        }
    }
    return $names
}

function Test-MechanicalJsonStateRecoveryIsUntrusted {
    param([object]$Recovery)

    if (-not $Recovery) { return $false }
    if ($Recovery -is [System.Collections.IDictionary]) {
        return $Recovery.Contains('fenceTrusted') -and $Recovery['fenceTrusted'] -eq $false
    }
    return ($null -ne $Recovery.fenceTrusted) -and ($Recovery.fenceTrusted -eq $false)
}

function Remove-MechanicalJsonStateRecoveryMeta {
    param([hashtable]$State)

    $clean = @{}
    foreach ($key in @($State.Keys)) {
        if ($key -eq '_recovery') {
            if (Test-MechanicalJsonStateRecoveryIsUntrusted -Recovery $State[$key]) {
                $clean[$key] = $State[$key]
            }
            continue
        }
        $clean[$key] = $State[$key]
    }
    return $clean
}

function Assert-MechanicalJsonStateFencesTrusted {
    param(
        [object]$State,
        [string]$Context = 'side effects'
    )

    if (Test-MechanicalJsonStateFencesTrusted -State $State) {
        return
    }

    $reason = Get-MechanicalJsonStateRecoveryReason -State $State
    if (-not $reason) {
        $reason = 'fences untrusted'
    }
    throw "STATE FENCES UNTRUSTED: $reason; failing closed for $Context"
}

function Test-MechanicalJsonStateFencesTrusted {
    param([object]$State)

    if (-not $State) { return $true }
    if ($State -is [System.Collections.IDictionary]) {
        $recovery = $State['_recovery']
    }
    else {
        $recovery = $State._recovery
    }
    if (-not $recovery) { return $true }
    if ($recovery -is [System.Collections.IDictionary]) {
        if ($recovery.Contains('fenceTrusted') -and $recovery['fenceTrusted'] -eq $false) {
            return $false
        }
        return $true
    }
    if ($null -ne $recovery.fenceTrusted -and $recovery.fenceTrusted -eq $false) {
        return $false
    }
    return $true
}

function Get-MechanicalJsonStateRecoveryReason {
    param([object]$State)

    if (-not $State) { return '' }
    if ($State -is [System.Collections.IDictionary]) {
        $recovery = $State['_recovery']
    }
    else {
        $recovery = $State._recovery
    }
    if (-not $recovery) { return '' }
    if ($recovery -is [System.Collections.IDictionary]) {
        return [string]$recovery['reason']
    }
    return [string]$recovery.reason
}

function ConvertTo-MechanicalJsonStateHashtable {
    param([object]$Value)

    if ($Value -is [System.Collections.IDictionary]) {
        $copy = @{}
        foreach ($key in @($Value.Keys)) {
            $copy[[string]$key] = $Value[$key]
        }
        return $copy
    }
    if ($null -eq $Value) {
        return @{}
    }

    $copyFromObject = @{}
    foreach ($prop in $Value.PSObject.Properties) {
        if ($prop.MemberType -ne 'NoteProperty' -and $prop.MemberType -ne 'Property') {
            continue
        }
        $copyFromObject[$prop.Name] = $prop.Value
    }
    return $copyFromObject
}

function Normalize-MechanicalJsonState {
    param(
        [object]$State,
        [hashtable]$DefaultState
    )

    $normalized = ConvertTo-MechanicalJsonStateHashtable -Value $State
    foreach ($key in @($DefaultState.Keys)) {
        $defaultValue = $DefaultState[$key]
        if ($defaultValue -is [System.Collections.IDictionary]) {
            if (-not $normalized.ContainsKey($key) -or $null -eq $normalized[$key]) {
                $normalized[$key] = @{}
            }
            else {
                $normalized[$key] = ConvertTo-MechanicalJsonMap -Value $normalized[$key]
            }
            continue
        }
        if (-not $normalized.ContainsKey($key)) {
            $normalized[$key] = $defaultValue
        }
    }
    return $normalized
}

function Get-MechanicalJsonStateBackupPath {
    param([string]$Path)
    return "${Path}.bak"
}

function Get-MechanicalJsonStateQuarantinePath {
    param([string]$Path)
    $stamp = (Get-Date).ToString('yyyyMMddHHmmssfff')
    return "${Path}.corrupt-${stamp}"
}

function Read-MechanicalJsonStateRawObject {
    param([string]$Path)

    $rawText = Get-Content -LiteralPath $Path -Raw
    if ([string]::IsNullOrWhiteSpace($rawText)) {
        throw 'empty state file'
    }
    $parsed = $rawText | ConvertFrom-Json
    return ConvertTo-MechanicalJsonStateHashtable -Value $parsed
}

function Test-MechanicalJsonStateFileParseable {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    try {
        $null = Read-MechanicalJsonStateRawObject -Path $Path
        return $true
    }
    catch {
        return $false
    }
}

function Copy-MechanicalJsonStateBackup {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }
    if (-not (Test-MechanicalJsonStateFileParseable -Path $Path)) {
        return
    }
    $backupPath = Get-MechanicalJsonStateBackupPath -Path $Path
    Copy-Item -LiteralPath $Path -Destination $backupPath -Force
}

function Restore-MechanicalJsonStateFromBackup {
    param([string]$Path)

    $backupPath = Get-MechanicalJsonStateBackupPath -Path $Path
    if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
        return $null
    }
    return Read-MechanicalJsonStateRawObject -Path $backupPath
}

function Invoke-MechanicalNodeFilterCli {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilterCliPath,
        [Parameter(Mandatory = $true)]
        [string]$Subcommand,
        [Parameter(Mandatory = $true)]
        [hashtable]$Payload,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [int]$JsonDepth = 20
    )

    $json = $Payload | ConvertTo-Json -Depth $JsonDepth -Compress
    $output = $json | & node $FilterCliPath $Subcommand 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "${Label}.mjs $Subcommand exited ${LASTEXITCODE}: $output"
    }

    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    return $text | ConvertFrom-Json
}

function Get-MechanicalJsonStateFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [hashtable]$DefaultState,
        [switch]$ActionTracking
    )

    $defaultClone = Normalize-MechanicalJsonState -State $DefaultState -DefaultState $DefaultState

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $defaultClone
    }

    $parsed = $null
    $parseFailed = $false
    try {
        $parsed = Read-MechanicalJsonStateRawObject -Path $Path
    }
    catch {
        $parseFailed = $true
    }

    if ($parseFailed) {
        $parsed = Restore-MechanicalJsonStateFromBackup -Path $Path
        if ($parsed) {
            try {
                $quarantinePath = Get-MechanicalJsonStateQuarantinePath -Path $Path
                Move-Item -LiteralPath $Path -Destination $quarantinePath -Force
                $state = Normalize-MechanicalJsonState -State $parsed -DefaultState $DefaultState
                if (Test-MechanicalJsonStateFencesTrusted -State $state) {
                    $state['_recovery'] = @{
                        fenceTrusted = $true
                        reason       = 'restored_from_backup'
                        quarantined  = $quarantinePath
                    }
                }
                else {
                    $recoveryReason = Get-MechanicalJsonStateRecoveryReason -State $state
                    if (-not $recoveryReason) {
                        $recoveryReason = 'restored_untrusted_backup'
                    }
                    $state['_recovery'] = @{
                        fenceTrusted = $false
                        reason       = $recoveryReason
                        quarantined  = $quarantinePath
                    }
                    if ($ActionTracking) {
                        Set-MechanicalJsonStateFile -Path $Path -State $state -DefaultState $DefaultState -JsonDepth 30
                    }
                }
                return $state
            }
            catch {
                $parsed = $null
            }
        }
        else {
            $parsed = $null
        }

        if ($ActionTracking) {
            $quarantinePath = Get-MechanicalJsonStateQuarantinePath -Path $Path
            if (Test-Path -LiteralPath $Path) {
                Move-Item -LiteralPath $Path -Destination $quarantinePath -Force
            }
            $state = $defaultClone
            $state['_recovery'] = @{
                fenceTrusted = $false
                reason       = 'unparseable_no_backup'
                quarantined  = $quarantinePath
            }
            Set-MechanicalJsonStateFile -Path $Path -State $state -DefaultState $DefaultState -JsonDepth 30
            return $state
        }

        return $defaultClone
    }

    return Normalize-MechanicalJsonState -State $parsed -DefaultState $DefaultState
}

function Set-MechanicalJsonStateFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [object]$State,
        [hashtable]$DefaultState = @{},
        [int]$JsonDepth = 20
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $toWrite = if ($DefaultState.Count -gt 0) {
        Normalize-MechanicalJsonState -State $State -DefaultState $DefaultState
    }
    else {
        ConvertTo-MechanicalJsonStateHashtable -Value $State
    }
    $toWrite = Remove-MechanicalJsonStateRecoveryMeta -State $toWrite

    $mapFieldSource = if ($DefaultState.Count -gt 0) { $DefaultState } else { $toWrite }
    foreach ($key in Get-MechanicalJsonStateMapFieldNames -DefaultState $mapFieldSource) {
        if ($toWrite.ContainsKey($key)) {
            $toWrite[$key] = ConvertTo-MechanicalJsonMap -Value $toWrite[$key]
        }
    }

    $tempPath = "${Path}.tmp"
    $json = $toWrite | ConvertTo-Json -Depth $JsonDepth -Compress
    Set-Content -LiteralPath $tempPath -Value $json -Encoding utf8 -NoNewline
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
    if (Test-MechanicalJsonStateFencesTrusted -State $toWrite) {
        Copy-MechanicalJsonStateBackup -Path $Path
    }
}
