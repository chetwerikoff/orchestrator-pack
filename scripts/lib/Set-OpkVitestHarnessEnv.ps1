#requires -Version 5.1
<#
.SYNOPSIS
  Establish pack-owned Vitest marker and isolate every inventoried live-default store (Issues #664, #752).
#>

function Get-OrchestratorEscalationSharedDefaultStatePath {
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-escalation-state.json'
}

function Get-OrchestratorEscalationSharedDefaultOperatorInboxDir {
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-operator-inbox'
}

function Get-OrchestratorEscalationSharedDefaultHealthSpoolDir {
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-escalation-health'
}

function Remove-StaleOpkVitestHarnessRoots {
    param(
        [string]$TempRoot = ([System.IO.Path]::GetTempPath()),
        [int]$MaxRemovals = 16,
        [int]$MaxAgeHours = 24
    )

    $removed = 0
    $cutoff = (Get-Date).ToUniversalTime().AddHours(-1 * [Math]::Max(1, $MaxAgeHours))
    foreach ($item in @(Get-ChildItem -LiteralPath $TempRoot -Directory -Filter 'opk-vitest-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc)) {
        if ($removed -ge [Math]::Max(1, $MaxRemovals)) { break }
        if ($item.LastWriteTimeUtc -ge $cutoff) { continue }
        try {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
            $removed++
        }
        catch {
            # Bounded best effort; stale cleanup must not mask the test result.
        }
    }
}

function Protect-OpkVitestHarnessDirectory {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
    if ($IsLinux -or $IsMacOS) {
        if (Get-Command chmod -ErrorAction SilentlyContinue) {
            & chmod 700 -- $Path 2>$null
            if ($LASTEXITCODE -ne 0) { throw "failed to protect Vitest harness directory: $Path" }
        }
        return
    }
    # Native Windows is not a supported pack runtime. Keep the directory private
    # when possible without introducing a dependency on an elevated shell.
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $acl = Get-Acl -LiteralPath $Path
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $identity.Name,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $acl.SetAccessRule($rule)
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    catch {
        throw "failed to protect Vitest harness directory: $Path"
    }
}

function Get-OpkVitestProductionWakeRoot {
    if ($env:AO_WAKE_SUPERVISOR_STATE_DIR) {
        return $env:AO_WAKE_SUPERVISOR_STATE_DIR.Trim()
    }
    if ($env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR) {
        return $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR.Trim()
    }
    if ($env:XDG_STATE_HOME) {
        return Join-Path $env:XDG_STATE_HOME 'orchestrator-pack-wake-supervisor'
    }
    if ($env:LOCALAPPDATA) {
        return Join-Path $env:LOCALAPPDATA 'orchestrator-pack-wake-supervisor'
    }
    $homeRoot = if ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
    return Join-Path (Join-Path (Join-Path $homeRoot '.local') 'state') 'orchestrator-pack-wake-supervisor'
}

function Set-OpkVitestHarnessEnv {
    param([string]$RootDir = '')

    if (-not $RootDir) {
        Remove-StaleOpkVitestHarnessRoots
        $RootDir = Join-Path ([System.IO.Path]::GetTempPath()) ('opk-vitest-' + [guid]::NewGuid().ToString('n'))
    }

    if (-not $env:OPK_VITEST_PRODUCTION_HOME) {
        $env:OPK_VITEST_PRODUCTION_HOME = if ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
    }
    if (-not $env:OPK_VITEST_PRODUCTION_TMP) {
        $env:OPK_VITEST_PRODUCTION_TMP = if ($env:TMPDIR) { $env:TMPDIR } elseif ($env:TEMP) { $env:TEMP } elseif ($env:TMP) { $env:TMP } else { [System.IO.Path]::GetTempPath() }
    }
    if (-not $env:OPK_VITEST_PRODUCTION_AO_BASE) {
        $env:OPK_VITEST_PRODUCTION_AO_BASE = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $env:OPK_VITEST_PRODUCTION_HOME '.agent-orchestrator' }
    }
    if (-not $env:OPK_VITEST_PRODUCTION_WAKE_ROOT) {
        $env:OPK_VITEST_PRODUCTION_WAKE_ROOT = Get-OpkVitestProductionWakeRoot
    }

    $wakeDir = Join-Path $RootDir 'wake'
    $stateDir = Join-Path $RootDir 'state'
    $tmpDir = Join-Path $RootDir 'tmp'
    $inboxDir = Join-Path $RootDir 'operator-inbox'
    $healthDir = Join-Path $RootDir 'health-spool'
    $aoBaseDir = Join-Path $RootDir 'ao-base'
    $transportDir = Join-Path $RootDir 'transport'
    foreach ($dir in @($RootDir, $wakeDir, $stateDir, $tmpDir, $inboxDir, $healthDir, $aoBaseDir, $transportDir)) {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        Protect-OpkVitestHarnessDirectory -Path $dir
    }

    $env:OPK_VITEST_HARNESS = '1'
    $env:OPK_VITEST_HARNESS_ROOT = $RootDir
    $env:OPK_VITEST_HARNESS_INVENTORY = Join-Path (Split-Path -Parent $PSScriptRoot) 'vitest-live-store-inventory.json'
    $env:TMPDIR = $tmpDir
    $env:TEMP = $tmpDir
    $env:TMP = $tmpDir
    $env:AO_WAKE_SUPERVISOR_STATE_DIR = $wakeDir
    $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = $wakeDir
    $env:AO_SIDE_PROCESS_STATE_DIR = $wakeDir
    $env:AO_BASE_DIR = $aoBaseDir
    $env:AO_MECHANICAL_TRANSPORT_TEMP = $transportDir
    $env:AO_ORCHESTRATOR_ESCALATION_STATE = Join-Path $stateDir 'orchestrator-escalation-state.json'
    $env:AO_OPERATOR_ESCALATION_INBOX = $inboxDir
    $env:AO_ESCALATION_HEALTH_SPOOL = $healthDir
    $env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL = Join-Path $wakeDir 'worker-message-dispatch-journal.json'
    $env:AO_WORKER_MESSAGE_SUBMIT_STATE = Join-Path $stateDir 'orchestrator-worker-message-submit-state.json'
    $env:AO_WORKER_STATUS_STORE = Join-Path $wakeDir 'worker-status-store.json'
    $env:AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE = Join-Path $stateDir 'orchestrator-review-handoff-wake-admission.json'
    $env:AO_REPORT_STATE_SEED_STATE = Join-Path $stateDir 'orchestrator-review-ready-report-state-seed-state.json'
    $env:AO_REVIEW_TRIGGER_REEVAL_WATCH_STATE = Join-Path $stateDir 'orchestrator-review-trigger-reeval-watch.json'
    $env:AO_WORKER_REPORT_STORE = Join-Path $wakeDir 'worker-report-store.json'
    $env:AO_PR_SESSION_BINDING_CACHE = Join-Path $wakeDir 'pr-session-binding-cache.json'
    $env:AO_CI_GREEN_WAKE_RECONCILE_STATE = Join-Path $stateDir 'orchestrator-ci-green-wake-state.json'
    $env:AO_DEAD_WORKER_RECONCILE_STATE = Join-Path $wakeDir 'orchestrator-dead-worker-reconcile-state.json'
    $env:AO_REVIEW_TRIGGER_RECONCILE_STATE = Join-Path $stateDir 'orchestrator-review-reconcile-state.json'
    $env:AO_WAKE_DEDUP_STATE = Join-Path $stateDir 'orchestrator-wake-dedup.json'
    $env:AO_WAKE_LISTENER_SIDE_EFFECT_LOCK = Join-Path $stateDir 'orchestrator-wake-listener-side-effect.lock'
    $env:AO_WORKER_MESSAGE_ADOPTION_STATE = Join-Path $stateDir 'orchestrator-worker-message-send-adoption.json'
    $env:AO_REVIEW_CLAIM_DIR = Join-Path (Join-Path (Join-Path $aoBaseDir 'projects') 'orchestrator-pack') 'review-start-claims'
    $env:AO_WORKER_NUDGE_CLAIM_DIR = Join-Path (Join-Path (Join-Path $aoBaseDir 'projects') 'orchestrator-pack') 'worker-nudge-claims'

    . (Join-Path $PSScriptRoot 'OpkVitestStoreIsolation.ps1')
    Enable-OpkVitestStoreIsolation

    return @{
        root         = $RootDir
        wakeDir      = $wakeDir
        statePath    = $env:AO_ORCHESTRATOR_ESCALATION_STATE
        inboxDir     = $inboxDir
        healthDir    = $healthDir
        stateDir     = $stateDir
        tmpDir       = $tmpDir
        aoBaseDir    = $aoBaseDir
        transportDir = $transportDir
    }
}
