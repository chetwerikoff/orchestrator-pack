#requires -Version 5.1
<#
  Shared autonomous capability inventory validation helpers (#318 / #324).
#>

function Get-AutonomousCapabilityInventoryViolations {
    param(
        [object]$Inventory,
        [string]$RepoRoot,
        [switch]$IncludeBoundaryChecks
    )

    $repoInventory = @($Inventory.capabilities)
    $violations = New-Object System.Collections.Generic.List[string]

    if ($IncludeBoundaryChecks) {
        if ([string]$Inventory.boundaryVersion -ne 'autonomous-orchestrator-boundary/v1') {
            $violations.Add("stale boundary marker: $($Inventory.boundaryVersion)")
        }
    }

    foreach ($row in $repoInventory) {
        $classification = [string]$row.classification
        if ($classification -ne 'gated' -and $classification -ne 'unavailable') {
            $violations.Add("unclassified capability: $($row.id)")
        }
        $path = [string]$row.path
        if ($path -like 'scripts/*' -and -not (Test-Path -LiteralPath (Join-Path $RepoRoot $path))) {
            if ($classification -eq 'gated') {
                $violations.Add("gated capability path missing: $path")
            }
        }
    }

    if ($IncludeBoundaryChecks) {
        foreach ($id in @('ao-spawn-raw', 'git-mutating-direct', 'turn-visible-real-binary-env')) {
            $row = $repoInventory | Where-Object { [string]$_.id -eq $id } | Select-Object -First 1
            if (-not $row -or [string]$row.classification -ne 'unavailable') {
                $violations.Add("required unavailable capability missing or misclassified: $id")
            }
        }
        foreach ($id in @('git-shim', 'git-autonomous-guard', 'autonomous-real-binaries-config')) {
            $row = $repoInventory | Where-Object { [string]$_.id -eq $id } | Select-Object -First 1
            if (-not $row -or [string]$row.classification -ne 'gated') {
                $violations.Add("required gated capability missing or misclassified: $id")
            }
        }

        $configPath = Join-Path $RepoRoot '.ao' 'autonomous-real-binaries.json'
        if (Test-Path -LiteralPath $configPath) {
            try {
                $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
                . (Join-Path $RepoRoot 'scripts/lib/Orchestrator-AutonomousBoundary.ps1')
                $configuredAo = [string]$config.ao
                if ($configuredAo -and -not (Test-AutonomousConfiguredAoPointerUsable -ConfiguredPath $configuredAo -PackRoot $RepoRoot)) {
                    $violations.Add("broken explicit ao pointer: $configuredAo")
                }
                $configuredGit = [string]$config.git
                if ($configuredGit) {
                    if (Test-IsKnownSystemGitBinaryPath -CandidatePath $configuredGit) {
                        $violations.Add('configured git must be pack scripts/git-real-binary, not a host system binary')
                    }
                    $expectedWrapper = Get-PackGitRealBinaryPath -PackRoot $RepoRoot
                    if ($configuredGit -ne $expectedWrapper) {
                        $violations.Add("configured git must resolve to $expectedWrapper")
                    }
                }
            }
            catch {
                $violations.Add('invalid .ao/autonomous-real-binaries.json')
            }
        }

        $boundaryCli = Join-Path $RepoRoot 'docs/autonomous-orchestrator-boundary.mjs'
        if (-not (Test-Path -LiteralPath $boundaryCli)) {
            $violations.Add('missing docs/autonomous-orchestrator-boundary.mjs')
        }
        else {
            $payload = @{
                liveCapabilities = @($repoInventory | ForEach-Object { @{ id = [string]$_.id; classification = [string]$_.classification } })
            } | ConvertTo-Json -Compress -Depth 5
            $boundaryValidation = $payload | node $boundaryCli evaluatePreflight 2>$null | ConvertFrom-Json
            if (-not $boundaryValidation.ok) {
                $violations.Add("boundary preflight validation failed: $($boundaryValidation.reason)")
            }
        }
    }

    return @($violations)
}

function Get-UnclassifiedReviewStartHelperViolations {
    param(
        [object]$Inventory,
        [string]$RepoRoot
    )

    $repoInventory = @($Inventory.capabilities)
    $violations = New-Object System.Collections.Generic.List[string]
    $roots = @('scripts', 'docs', 'prompts', 'plugins')
    $files = foreach ($root in $roots) {
        $full = Join-Path $RepoRoot $root
        if (Test-Path -LiteralPath $full) {
            Get-ChildItem -LiteralPath $full -Recurse -File -Include *.ps1,*.psm1,*.mjs,*.js,*.ts | Where-Object {
                $_.Name -match 'review' -and $_.Name -match 'run|start'
            }
        }
    }
    foreach ($file in @($files)) {
        $rel = [System.IO.Path]::GetRelativePath($RepoRoot, $file.FullName).Replace('\', '/')
        if ($rel -match 'invoke-orchestrator-claimed-review-run|invoke-manual-review-run|ao-autonomous-guard|git-autonomous-guard|scripts/ao$|scripts/git$|Invoke-OrchestratorClaimedReviewRun') {
            continue
        }
        $text = Get-Content -LiteralPath $file.FullName -Raw
        if ($text -match 'function\s+Invoke-.*ReviewRun' -and $text -notmatch 'Invoke-OrchestratorClaimedReviewRun|Invoke-PlannedReviewRun|Invoke-ReviewWakeTrigger|Invoke-ReviewTriggerReeval') {
            $violations.Add("unclassified review-start helper: $rel")
        }
    }
    return @($violations)
}

function Test-AutonomousReviewStartPreflightInventory {
    param([object]$Inventory)

    . (Join-Path $PSScriptRoot 'Orchestrator-AutonomousReviewStartGate.ps1')
    $repoInventory = @($Inventory.capabilities)
    return Invoke-OrchestratorClaimedReviewRunFilterCli -Subcommand 'evaluatePreflight' -Payload @{
        loadedGateVersion  = [string]$Inventory.version
        atomicClaimPresent = $true
        liveCapabilities   = @($repoInventory | ForEach-Object { @{ id = [string]$_.id; classification = [string]$_.classification } })
    }
}
