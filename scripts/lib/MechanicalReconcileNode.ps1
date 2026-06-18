#requires -Version 5.1
<#
.SYNOPSIS
  Shared Node stdin/JSON filter and mechanical state-file helpers for reconcile scripts.
#>

$Script:MechanicalJsonReflectionKeys = @(
    'Keys', 'Values', 'Count', 'SyncRoot', 'IsFixedSize', 'IsReadOnly', 'IsSynchronized'
)

$Script:MechanicalPipeBufferBytes = 65536
$Script:MechanicalTransportEnvelopeBytes = 2 * 1024 * 1024
$Script:MechanicalStorageCeilingBytes = [Math]::Floor($Script:MechanicalTransportEnvelopeBytes * 0.65)
$Script:MechanicalPersistedStoreCeilingBytes = [Math]::Floor($Script:MechanicalStorageCeilingBytes / 2)
$Script:MechanicalReconcilePlanOverheadBytes = $Script:MechanicalPipeBufferBytes

function Get-MechanicalTransportEnvelopeBytes {
    return $Script:MechanicalTransportEnvelopeBytes
}

function Get-MechanicalStorageCeilingBytes {
    return $Script:MechanicalStorageCeilingBytes
}

function Get-MechanicalPersistedStoreCeilingBytes {
    return $Script:MechanicalPersistedStoreCeilingBytes
}

function Get-MechanicalTransportTempRoot {
    if ($env:AO_MECHANICAL_TRANSPORT_TEMP) {
        return $env:AO_MECHANICAL_TRANSPORT_TEMP
    }
    if ($IsLinux -or $IsMacOS) {
        $homeRoot = if ($env:HOME) { $env:HOME } else { [System.IO.Path]::GetTempPath() }
        return Join-Path $homeRoot '.orchestrator-mechanical-transport'
    }
    if ($env:LOCALAPPDATA) {
        return Join-Path $env:LOCALAPPDATA 'orchestrator-mechanical-transport'
    }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-mechanical-transport'
}

function Protect-MechanicalTransportPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [switch]$Directory
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    if ($IsLinux -or $IsMacOS) {
        $mode = if ($Directory) { '700' } else { '600' }
        if (Get-Command chmod -ErrorAction SilentlyContinue) {
            & chmod $mode -- $Path 2>$null
        }
        return
    }

    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetOwner($identity.User)
        $acl.SetAccessRuleProtection($true, $false)
        $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
        $inherit = if ($Directory) {
            [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        }
        else {
            [System.Security.AccessControl.InheritanceFlags]::None
        }
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $identity.Name,
            $rights,
            $inherit,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    catch {
        # Best-effort hardening; transport still works if ACL tightening is unavailable.
    }
}

function Initialize-MechanicalTransportTempRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    if (-not (Test-Path -LiteralPath $Root)) {
        New-Item -ItemType Directory -Path $Root -Force | Out-Null
    }
    Protect-MechanicalTransportPath -Path $Root -Directory
}

function Write-MechanicalTransportPrivateFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
    Protect-MechanicalTransportPath -Path $Path
}

function New-MechanicalTransportTempPaths {
    $root = Get-MechanicalTransportTempRoot
    Initialize-MechanicalTransportTempRoot -Root $root
    $token = [guid]::NewGuid().ToString('N')
    return @{
        InputPath  = Join-Path $root "${token}.in.json"
        OutputPath = Join-Path $root "${token}.out.json"
    }
}

function Remove-MechanicalTransportTempPaths {
    param(
        [string[]]$Paths
    )

    foreach ($path in @($Paths)) {
        if ($path -and (Test-Path -LiteralPath $path)) {
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-MechanicalJsonTextComplete {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $false
    }
    try {
        $null = $Text | ConvertFrom-Json
        return $true
    }
    catch {
        return $false
    }
}

function Read-MechanicalNodeFilterCliOutput {
    param(
        [string]$OutputPath,
        [string]$Label,
        [string]$Subcommand
    )

    if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
        throw "${Label}.mjs ${Subcommand} produced no output file (partial or interrupted child result)"
    }

    $outputText = Get-Content -LiteralPath $OutputPath -Raw
    $outputBytes = [System.Text.Encoding]::UTF8.GetByteCount([string]$outputText)
    if ($outputBytes -gt $Script:MechanicalTransportEnvelopeBytes) {
        throw "${Label}.mjs ${Subcommand} output exceeds transport envelope (${outputBytes} > $($Script:MechanicalTransportEnvelopeBytes))"
    }
    if (-not (Test-MechanicalJsonTextComplete -Text $outputText)) {
        throw "${Label}.mjs ${Subcommand} returned malformed or truncated JSON output"
    }

    return $outputText | ConvertFrom-Json
}


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

function Merge-MechanicalFixtureDeliveryFields {
    param(
        [hashtable]$Payload,
        [object]$Fixture
    )

    if ($Fixture.workerDeliveries) {
        $Payload.workerDeliveries = @($Fixture.workerDeliveries)
    }
    if ($Fixture.aoEvents) {
        $Payload.aoEvents = @($Fixture.aoEvents)
    }
    if ($Fixture.dispatchJournal) {
        $Payload.dispatchJournal = ConvertTo-MechanicalJsonMap -Value $Fixture.dispatchJournal
    }
    return $Payload
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
    $inputBytes = [System.Text.Encoding]::UTF8.GetByteCount($json)
    if ($inputBytes -gt $Script:MechanicalTransportEnvelopeBytes) {
        throw "${Label}.mjs ${Subcommand} payload exceeds transport envelope (${inputBytes} > $($Script:MechanicalTransportEnvelopeBytes))"
    }

    $tempPaths = New-MechanicalTransportTempPaths
    $inputPath = $tempPaths.InputPath
    $outputPath = $tempPaths.OutputPath
    try {
        Write-MechanicalTransportPrivateFile -Path $inputPath -Content $json
        $stderr = & node $FilterCliPath $Subcommand --input-file $inputPath --output-file $outputPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "${Label}.mjs $Subcommand exited ${LASTEXITCODE}: $stderr"
        }

        return Read-MechanicalNodeFilterCliOutput -OutputPath $outputPath -Label $Label -Subcommand $Subcommand
    }
    catch {
        if ($_.Exception.Message -match 'disk|space|no space|ENOSPC') {
            Remove-MechanicalTransportTempPaths -Paths @($inputPath, $outputPath)
        }
        throw
    }
    finally {
        Remove-MechanicalTransportTempPaths -Paths @($inputPath, $outputPath)
    }
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
                    if ($ActionTracking) {
                        Set-MechanicalJsonStateFile -Path $Path -State $state -DefaultState $DefaultState -JsonDepth 30
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
