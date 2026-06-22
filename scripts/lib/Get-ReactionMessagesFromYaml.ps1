#requires -Version 5.1
<#
.SYNOPSIS
  Resolve static send-to-agent reaction messages from live operator YAML (Issue #402).
#>
. (Join-Path $PSScriptRoot 'Get-PackReviewCommand.ps1')

function Get-ReactionMessagesFromYaml {
    param(
        [string]$YamlPath = '',
        [string]$PackRoot = ''
    )

    if (-not $PackRoot) {
        $PackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }

    if (-not $YamlPath) {
        $YamlPath = Resolve-PackOrchestratorYamlPath -PackRoot $PackRoot
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
            error    = 'missing_yaml_path'
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
