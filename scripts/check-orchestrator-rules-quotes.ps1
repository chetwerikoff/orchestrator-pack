[CmdletBinding()]
param(
    [string]$ExamplePath = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $ExamplePath) {
    $ExamplePath = Join-Path $Root 'agent-orchestrator.yaml.example'
}

if (-not (Test-Path -LiteralPath $ExamplePath -PathType Leaf)) {
    Write-Host "[FAIL] Example config not found: $ExamplePath"
    exit 1
}

function Get-OrchestratorRulesLiteral {
    param([string[]]$Lines)

    $start = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match '^\s+orchestratorRules:\s*\|\s*$') {
            $start = $i + 1
            break
        }
    }
    if ($start -lt 0) {
        return $null
    }

    $block = New-Object System.Collections.Generic.List[string]
    for ($j = $start; $j -lt $Lines.Count; $j++) {
        $line = $Lines[$j]
        if ($line -match '^\s{6}') {
            $block.Add($line.Substring(6)) | Out-Null
        }
        elseif ($line -match '^\s*$') {
            $block.Add('') | Out-Null
        }
        else {
            break
        }
    }

  return ($block -join "`n")
}

$lines = @(Get-Content -LiteralPath $ExamplePath)
$literal = Get-OrchestratorRulesLiteral -Lines $lines
if ($null -eq $literal) {
    Write-Host '[FAIL] orchestratorRules: | literal not found in example config'
    exit 1
}

$quoteIndex = $literal.IndexOf([char]'"')
if ($quoteIndex -ge 0) {
    $snippet = $literal.Substring([Math]::Max(0, $quoteIndex - 40), [Math]::Min(80, $literal.Length - [Math]::Max(0, $quoteIndex - 40)))
    Write-Host '[FAIL] Double-quote character found in orchestratorRules literal'
    Write-Host "       Near: ...$snippet..."
    exit 1
}

Write-Host '[PASS] orchestratorRules literal contains no double-quote characters'
exit 0
