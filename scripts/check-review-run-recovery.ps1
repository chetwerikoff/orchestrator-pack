#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$registryPath = Join-Path $PSScriptRoot 'orchestrator-side-process-registry.json'
$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$required = @($registry.requiredChildIds | Where-Object { $_ -eq 'review-run-recovery' })
$children = @($registry.children | Where-Object { $_.id -eq 'review-run-recovery' })
if ($required.Count -ne 1 -or $children.Count -ne 1) { throw 'review-run-recovery must be registered exactly once as a required side-process child' }
if (-not $children[0].sideEffecting) { throw 'review-run-recovery must be marked sideEffecting' }
if ($children[0].sideEffectLockFile -ne 'review-run-recovery-side-effect.lock') { throw 'review-run-recovery side-effect lock mismatch' }
$cli = Join-Path $root 'docs/review-run-recovery.mjs'
$result = ('{}' | node $cli validate-config | ConvertFrom-Json)
if (-not $result.ok) { throw "default recovery config invalid: $($result.errors -join '; ')" }
Write-Host 'review-run-recovery registration/config OK'
