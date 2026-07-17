#requires -Version 5.1
<#
.SYNOPSIS
  Fail when example YAML canonical REVIEW_COMMAND points at gitignored .ao/ paths.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')

$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$command = Get-PackReviewCommandFromYaml -YamlPath $example

if (-not $command) {
    Write-Host '[FAIL] NAMED REVIEW_COMMAND not found in agent-orchestrator.yaml.example'
    exit 1
}

if ($command -match '(?i)(^|[\s"''`])\.ao/|\\\.ao\\') {
    Write-Host '[FAIL] Canonical REVIEW_COMMAND must not use gitignored .ao/ paths'
    Write-Host "  REVIEW_COMMAND: $command"
    exit 1
}

Write-Host '[PASS] example REVIEW_COMMAND does not use .ao/ as primary path'
exit 0
