#requires -Version 5.1
<#
.SYNOPSIS
  Resolve static send-to-agent reaction messages from live operator YAML (Issue #402).
#>

function Test-ReactionConfigLiveOperatorYamlPath {
    param(
        [string]$YamlPath,
        [string]$PackRoot
    )

    $examplePath = [System.IO.Path]::GetFullPath((Join-Path $PackRoot 'agent-orchestrator.yaml.example'))
    $resolvedPath = [System.IO.Path]::GetFullPath($YamlPath)
    return $resolvedPath -ne $examplePath
}

function Get-ReactionMessagesFromYaml {
    param(
        [string]$YamlPath = '',
        [string]$PackRoot = ''
    )

    if (-not $PackRoot) {
        $PackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }

    if (-not $YamlPath) {
        $YamlPath = Join-Path $PackRoot 'agent-orchestrator.yaml'
    }

    $cli = Join-Path $PackRoot 'scripts/reaction-config-messages.mjs'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        return @{
            ok       = $false
            reason   = 'reaction_config_unavailable'
            error    = 'missing_reaction_config_cli'
            messages = @{}
        }
    }

    if (-not (Test-Path -LiteralPath $YamlPath -PathType Leaf)) {
        return @{
            ok       = $false
            reason   = 'reaction_config_unavailable'
            error    = 'missing_live_operator_yaml'
            messages = @{}
        }
    }

    if (-not (Test-ReactionConfigLiveOperatorYamlPath -YamlPath $YamlPath -PackRoot $PackRoot)) {
        return @{
            ok       = $false
            reason   = 'reaction_config_unavailable'
            error    = 'example_yaml_not_runtime_truth'
            messages = @{}
        }
    }

    try {
        $stdout = & node $cli parse --path $YamlPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            return @{
                ok       = $false
                reason   = 'reaction_config_unavailable'
                error    = ($stdout | Out-String).Trim()
                messages = @{}
            }
        }
        $parsed = $stdout | ConvertFrom-Json
        if (-not $parsed.ok) {
            return @{
                ok       = $false
                reason   = [string]$parsed.reason
                error    = [string]$parsed.error
                messages = @{}
            }
        }
        $messages = @{}
        if ($parsed.messages) {
            foreach ($prop in $parsed.messages.PSObject.Properties) {
                $messages[$prop.Name] = [string]$prop.Value
            }
        }
        return @{
            ok       = $true
            messages = $messages
        }
    }
    catch {
        return @{
            ok       = $false
            reason   = 'reaction_config_unavailable'
            error    = $_.Exception.Message
            messages = @{}
        }
    }
}
