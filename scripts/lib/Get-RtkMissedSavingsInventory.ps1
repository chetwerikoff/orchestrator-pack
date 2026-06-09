#requires -Version 7.0

function Get-RtkRiskTierContract {
    <#
    .SYNOPSIS
      Risk-tier contract for RTK missed-savings inventory (Issue #199).
    #>
    [CmdletBinding()]
    param()

    return [pscustomobject]@{
        LowPrefixes    = @('grep', 'find', 'cat ', 'cat\t', 'ls ', 'ls\t', 'wc ', 'head ', 'tail ', 'tree ')
        MediumPrefixes = @('gh pr', 'gh issue', 'git branch', 'git log')
        HighPrefixes   = @(
            'ao status', 'ao review', 'ao events', 'ao report', 'ao send', 'ao spawn',
            'ao review send', 'npx ao-declare', 'ao-declare', 'git diff', 'gh pr checks'
        )
        SensitivityTargets = @(
            '.env', 'credentials', 'secret', 'token', 'private-key', 'id_rsa',
            'declarations/', '.ao/declarations', 'agent-orchestrator.yaml'
        )
    }
}

function Test-RtkSensitivityExactnessOverride {
    param(
        [Parameter(Mandatory)]
        [string]$CommandShape
    )

    $contract = Get-RtkRiskTierContract
    $lower = $CommandShape.ToLowerInvariant()
    foreach ($needle in $contract.SensitivityTargets) {
        if ($lower.Contains($needle)) {
            return $true
        }
    }
    return $false
}

function Get-RtkCommandRiskTier {
    param(
        [Parameter(Mandatory)]
        [string]$CommandShape
    )

    if (Test-RtkSensitivityExactnessOverride -CommandShape $CommandShape) {
        return 'high'
    }

    $normalized = $CommandShape.Trim().ToLowerInvariant()
    $contract = Get-RtkRiskTierContract

    foreach ($prefix in $contract.HighPrefixes) {
        if ($normalized.StartsWith($prefix) -or $normalized -eq $prefix.Trim()) {
            return 'high'
        }
    }
    if ($normalized -match '^ao(\s|$)') {
        return 'high'
    }

    foreach ($prefix in $contract.MediumPrefixes) {
        if ($normalized.StartsWith($prefix)) {
            return 'medium'
        }
    }

    foreach ($prefix in $contract.LowPrefixes) {
        if ($normalized.StartsWith($prefix)) {
            return 'low'
        }
    }

    return 'unknown'
}

function Test-RtkPassthroughMatch {
    param(
        [Parameter(Mandatory)]
        [string]$CommandShape,

        [Parameter(Mandatory)]
        [string[]]$PassthroughPatterns
    )

    foreach ($pattern in $PassthroughPatterns) {
        if ($CommandShape.Contains($pattern)) {
            return [pscustomobject]@{
                Matched = $true
                Pattern = $pattern
            }
        }
    }

    return [pscustomobject]@{
        Matched = $false
        Pattern = ''
    }
}

function Get-RtkInventoryRecommendedAction {
    param(
        [Parameter(Mandatory)]
        [string]$RiskTier,

        [bool]$PassthroughMatched,
        [bool]$SensitivityOverride
    )

    if ($SensitivityOverride) {
        return 'permanently-raw (sensitivity/exactness override)'
    }

    switch ($RiskTier) {
        'low' {
            if ($PassthroughMatched) {
                return 'guidance: prefer dedicated file tools; RTK may already compact when not passthrough-matched'
            }
            return 'low-risk capture candidate (guidance + optional passthrough review when not in §R.3 family)'
        }
        'medium' {
            return 'inventory + guidance only (no passthrough change without §6-class gate)'
        }
        'high' {
            return 'permanently-raw or §6-gated JSON inspection only (never blanket ao removal)'
        }
        default {
            return 'classify manually; default guidance-only until tier known'
        }
    }
}

function Test-RtkFieldPreservationRequired {
    param(
        [Parameter(Mandatory)]
        [string]$RiskTier,

        [bool]$PassthroughMatched,
        [bool]$SensitivityOverride
    )

    if ($SensitivityOverride) {
        return $false
    }
    if ($RiskTier -eq 'high' -and $PassthroughMatched) {
        return $true
    }
    if ($RiskTier -eq 'medium' -and $PassthroughMatched) {
        return $true
    }
    return $false
}

function ConvertFrom-RtkDiscoverJson {
    <#
    .SYNOPSIS
      Parse rtk discover --format json into normalized inventory rows.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Json,

        [string[]]$PassthroughPatterns = @()
    )

    $doc = $Json | ConvertFrom-Json
    $rows = New-Object System.Collections.Generic.List[object]

    foreach ($entry in @($doc.supported)) {
        $shape = [string]$entry.command
        $tier = Get-RtkCommandRiskTier -CommandShape $shape
        $sensitivity = Test-RtkSensitivityExactnessOverride -CommandShape $shape
        $match = Test-RtkPassthroughMatch -CommandShape $shape -PassthroughPatterns $PassthroughPatterns
        $rows.Add([pscustomobject]@{
                CommandShape                 = $shape
                OccurrenceCount              = [int]$entry.count
                EstimatedMissedTokens        = [int]$entry.estimated_savings_tokens
                PassthroughMatch             = $match.Matched
                PassthroughPattern           = $match.Pattern
                RiskTier                     = $tier
                SensitivityExactnessOverride = $sensitivity
                RecommendedAction            = (Get-RtkInventoryRecommendedAction -RiskTier $tier -PassthroughMatched $match.Matched -SensitivityOverride $sensitivity)
                FieldPreservationTestRequired = (Test-RtkFieldPreservationRequired -RiskTier $tier -PassthroughMatched $match.Matched -SensitivityOverride $sensitivity)
                DiscoverBucket               = 'supported'
            }) | Out-Null
    }

    foreach ($entry in @($doc.unsupported)) {
        $shape = [string]$entry.base_command
        $example = [string]$entry.example
        if (-not $shape) {
            $shape = $example
        }
        # discover's base_command is often just the executable; match tier/passthrough on the
        # full example so patterns like `ao ` (trailing space) hit real `ao …` invocations.
        $classifyShape = if ($example) { $example } else { $shape }
        $tier = Get-RtkCommandRiskTier -CommandShape $classifyShape
        $sensitivity = Test-RtkSensitivityExactnessOverride -CommandShape $classifyShape
        $match = Test-RtkPassthroughMatch -CommandShape $classifyShape -PassthroughPatterns $PassthroughPatterns
        $rows.Add([pscustomobject]@{
                CommandShape                 = $shape
                OccurrenceCount              = [int]$entry.count
                EstimatedMissedTokens        = $null
                PassthroughMatch             = $match.Matched
                PassthroughPattern           = $match.Pattern
                RiskTier                     = $tier
                SensitivityExactnessOverride = $sensitivity
                RecommendedAction            = (Get-RtkInventoryRecommendedAction -RiskTier $tier -PassthroughMatched $match.Matched -SensitivityOverride $sensitivity)
                FieldPreservationTestRequired = (Test-RtkFieldPreservationRequired -RiskTier $tier -PassthroughMatched $match.Matched -SensitivityOverride $sensitivity)
                DiscoverBucket               = 'unsupported'
            }) | Out-Null
    }

    return [pscustomobject]@{
        SessionsScanned = [int]$doc.sessions_scanned
        TotalCommands   = [int]$doc.total_commands
        SinceDays       = [int]$doc.since_days
        Rows            = $rows.ToArray()
    }
}

function Get-RtkKillGateAssessment {
    <#
    .SYNOPSIS
      Compute kill-gate inputs from inventory rows (Issue #199 §5).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object[]]$InventoryRows,

        [int]$MaterialityPercent = 15,

        [int]$HighRiskAoTokensPerInvocation = 250
    )

    $lowRiskTokens = 0
    $highAoCount = 0

    foreach ($row in $InventoryRows) {
        if ($row.RiskTier -eq 'low' -and $null -ne $row.EstimatedMissedTokens) {
            $lowRiskTokens += [int]$row.EstimatedMissedTokens
        }
        if ($row.RiskTier -eq 'high' -and $row.CommandShape -match '^ao(\s|$| review| events| status| spawn| report| send| session| list| worker)') {
            $highAoCount += [int]$row.OccurrenceCount
        }
    }

    $highAoTokens = $highAoCount * $HighRiskAoTokensPerInvocation
    $denominator = $lowRiskTokens + $highAoTokens
    $sharePercent = if ($denominator -gt 0) { [math]::Round(100.0 * $highAoTokens / $denominator, 1) } else { 0.0 }
    $go = $sharePercent -ge $MaterialityPercent

    return [pscustomobject]@{
        MaterialityPercent              = $MaterialityPercent
        LowRiskQuantifiedMissedTokens   = $lowRiskTokens
        HighRiskAoInvocationCount       = $highAoCount
        HighRiskAoTokensPerInvocation   = $HighRiskAoTokensPerInvocation
        HighRiskAoEstimatedMissedTokens = $highAoTokens
        HighRiskSharePercent            = $sharePercent
        Decision                        = if ($go) { 'go' } else { 'no-go' }
    }
}
