#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$StrictPrereqs,
    [switch]$TestBackedSmoke
)

$Root = Split-Path -Parent $PSScriptRoot
$Arguments = @('--experimental-strip-types', (Join-Path $PSScriptRoot 'verify.ts'), '--repo-root', $Root)
if ($StrictPrereqs) { $Arguments += '--strict-prereqs' }
if ($TestBackedSmoke) { $Arguments += '--test-backed-smoke' }

& node @Arguments
exit $LASTEXITCODE
