#requires -Version 7.0
<#
.SYNOPSIS
  Guard + regression for guarded intra-function dot-source retention loads (Issue #610).

  Ensures audit retention symbols survive repeated calls in one long-lived runspace and
  forbids the script-scope-loaded-flag + intra-function dot-source pattern from returning.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$Script:RequiredGuardedDotSourceSites = @(
    @{
        id = 'fleet-cache-audit-retention-load'
        file = 'scripts/lib/Gh-FleetInventoryCache.ps1'
        loadedTarget = 'Audit-JsonlRetention.ps1'
        disposition = 'fixed-script-scope-load'
    },
    @{
        id = 'audit-jsonl-process-alive-load'
        file = 'scripts/lib/Audit-JsonlRetention.ps1'
        loadedTarget = 'Orchestrator-ProcessAlive.ps1'
        disposition = 'fixed-script-scope-load'
    }
)

function Get-GuardedIntraFunctionDotSourceSites {
    param([string]$ScriptsRoot)

    $sites = New-Object System.Collections.Generic.List[object]
    Get-ChildItem -LiteralPath $ScriptsRoot -Filter '*.ps1' -Recurse -File | ForEach-Object {
        $parseErrors = $null
        $tokens = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$parseErrors)
        if (-not $ast) { return }

        $functions = $ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
            }, $true)
        foreach ($func in $functions) {
            $ifStmts = $func.FindAll({
                    param($node)
                    $node -is [System.Management.Automation.Language.IfStatementAst]
                }, $false)
            foreach ($ifStmt in $ifStmts) {
                $condText = $ifStmt.Condition.Extent.Text
                if ($condText -notmatch '(?i)\$Script:\w+Loaded') { continue }

                $body = $ifStmt.Body
                $statements = @()
                if ($body -is [System.Management.Automation.Language.StatementBlockAst]) {
                    $statements = @($body.Statements)
                }
                $hasDotSource = $false
                $hasLoadedAssign = $false
                foreach ($stmt in $statements) {
                    $text = $stmt.Extent.Text
                    if ($text -match '(?m)^\s*\.\s+') { $hasDotSource = $true }
                    if ($text -match '(?i)\$Script:\w+Loaded\s*=\s*\$true') { $hasLoadedAssign = $true }
                }
                if ($hasDotSource -and $hasLoadedAssign) {
                    $relative = $_.FullName.Substring($ScriptsRoot.Length).TrimStart([char]'\', [char]'/')
                    $sites.Add([ordered]@{
                            file = $relative
                            function = $func.Name
                            condition = $condText
                        }) | Out-Null
                }
            }
        }
    }
    return $sites
}

function Test-GuardedDotSourceInventory {
    $scriptsRoot = Join-Path $Root 'scripts'
    $sites = @(Get-GuardedIntraFunctionDotSourceSites -ScriptsRoot $scriptsRoot)
    if ($sites.Count -eq 0) {
        return
    }

    $known = @{}
    foreach ($entry in $Script:RequiredGuardedDotSourceSites) {
        $known[$entry.file] = $entry
    }

    $failures = New-Object System.Collections.Generic.List[string]
    foreach ($site in $sites) {
        $rel = ($site.file -replace '\\', '/')
        if (-not $known.ContainsKey($rel)) {
            $failures.Add("unclassified guarded intra-function dot-source: $rel::$($site.function) condition=$($site.condition)") | Out-Null
            continue
        }
        $failures.Add("guarded intra-function dot-source still present: $rel::$($site.function) (expected $($known[$rel].disposition))") | Out-Null
    }

    if ($failures.Count -gt 0) {
        Write-Host '[FAIL] guarded intra-function dot-source inventory (Issue #610):'
        $failures | ForEach-Object { Write-Host $_ }
        exit 1
    }
}

function Test-RepeatedFleetCacheAuditWrites {
    $stateRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("fleet-audit-retention-" + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    try {
        $prevAudit = $env:GH_FLEET_CACHE_AUDIT
        $prevState = $env:AO_SIDE_PROCESS_STATE_DIR
        $env:GH_FLEET_CACHE_AUDIT = '1'
        $env:AO_SIDE_PROCESS_STATE_DIR = $stateRoot
        try {
            . (Join-Path $Root 'scripts/lib/Gh-FleetInventoryCache.ps1')
            Write-GhFleetInventoryCacheAudit -Event 'repeated-write-a' -Fields @{ key = 'a' }
            Write-GhFleetInventoryCacheAudit -Event 'repeated-write-b' -Fields @{ key = 'b' }
        }
        finally {
            if ($null -ne $prevAudit) { $env:GH_FLEET_CACHE_AUDIT = $prevAudit } else { Remove-Item Env:GH_FLEET_CACHE_AUDIT -ErrorAction SilentlyContinue }
            if ($null -ne $prevState) { $env:AO_SIDE_PROCESS_STATE_DIR = $prevState } else { Remove-Item Env:AO_SIDE_PROCESS_STATE_DIR -ErrorAction SilentlyContinue }
        }

        $auditPath = Join-Path $stateRoot 'github-fleet-cache/audit.jsonl'
        if (-not (Test-Path -LiteralPath $auditPath -PathType Leaf)) {
            throw 'fleet-cache audit.jsonl was not created'
        }
        $lines = @(Get-Content -LiteralPath $auditPath | Where-Object { $_.Trim() })
        if ($lines.Count -lt 2) {
            throw "expected at least 2 audit JSONL lines, got $($lines.Count)"
        }
        foreach ($line in $lines) {
            $null = $line | ConvertFrom-Json
        }
    }
    finally {
        Remove-Item -LiteralPath $stateRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-RepeatedProcessAliveMaintenanceShape {
    . (Join-Path $Root 'scripts/lib/Audit-JsonlRetention.ps1')
    $lockPath = Join-Path ([System.IO.Path]::GetTempPath()) ("audit-lock-" + [guid]::NewGuid().ToString('n') + '.lock')
    try {
        Set-Content -LiteralPath $lockPath -Value '99999999' -Encoding UTF8
        $first = Test-AuditJsonlMaintenanceLockStale -LockPath $lockPath
        $second = Test-AuditJsonlMaintenanceLockStale -LockPath $lockPath
        if (-not $first -or -not $second) {
            throw "expected stale lock for dead pid on both calls (first=$first second=$second)"
        }
    }
    finally {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
}

function Test-AuditOnlyFaultBoundary {
    $stateRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("fleet-audit-boundary-" + [guid]::NewGuid().ToString('n'))
    $cacheRoot = Join-Path $stateRoot 'github-fleet-cache'
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    $auditPath = Join-Path $cacheRoot 'audit.jsonl'
    Set-Content -LiteralPath $auditPath -Value '{"event":"seed"}' -Encoding UTF8
    $item = Get-Item -LiteralPath $auditPath
    $item.IsReadOnly = $true
    try {
        $prevAudit = $env:GH_FLEET_CACHE_AUDIT
        $prevState = $env:AO_SIDE_PROCESS_STATE_DIR
        $env:GH_FLEET_CACHE_AUDIT = '1'
        $env:AO_SIDE_PROCESS_STATE_DIR = $stateRoot
        try {
            . (Join-Path $Root 'scripts/lib/Gh-FleetInventoryCache.ps1')
            $threw = $false
            try {
                Write-GhFleetInventoryCacheAudit -Event 'boundary-write' -Fields @{ key = 'x' }
            }
            catch {
                $threw = $true
            }
            if ($threw) {
                throw 'Write-GhFleetInventoryCacheAudit must not throw to callers on audit-only failures'
            }
            $root = Get-GhFleetInventoryCacheRoot
            if ($root -ne $cacheRoot) {
                throw "cache root must remain available (expected $cacheRoot got $root)"
            }
        }
        finally {
            $item.IsReadOnly = $false
            if ($null -ne $prevAudit) { $env:GH_FLEET_CACHE_AUDIT = $prevAudit } else { Remove-Item Env:GH_FLEET_CACHE_AUDIT -ErrorAction SilentlyContinue }
            if ($null -ne $prevState) { $env:AO_SIDE_PROCESS_STATE_DIR = $prevState } else { Remove-Item Env:AO_SIDE_PROCESS_STATE_DIR -ErrorAction SilentlyContinue }
        }
    }
    finally {
        Remove-Item -LiteralPath $stateRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Test-GuardedDotSourceInventory
Test-RepeatedFleetCacheAuditWrites
Test-RepeatedProcessAliveMaintenanceShape
Test-AuditOnlyFaultBoundary

Write-Host '[PASS] audit retention guarded dot-source regression (Issue #610)'
exit 0
