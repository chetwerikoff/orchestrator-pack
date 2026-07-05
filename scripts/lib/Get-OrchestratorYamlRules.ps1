#requires -Version 5.1
<#
  Extract orchestratorRules literal text from agent-orchestrator YAML.
#>

function Get-YamlOrchestratorRules {
    param([string]$Raw)

    $lines = $Raw -split "`n"
    $capture = $false
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        if ($line -match '^\s+orchestratorRules:\s*(?:\||>)\s*$') {
            $capture = $true
            continue
        }
        if ($capture) {
            if ($line -match '^\S') { break }
            $out.Add($line)
        }
    }
    return ($out -join "`n")
}

function Get-OrchestratorRulesFromYamlPath {
    param([string]$YamlPath)

    if (-not $YamlPath -or -not (Test-Path -LiteralPath $YamlPath -PathType Leaf)) {
        return ''
    }
    return Get-YamlOrchestratorRules -Raw (Get-Content -LiteralPath $YamlPath -Raw)
}
