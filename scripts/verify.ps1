#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$StrictPrereqs,
    [switch]$TestBackedSmoke
)

# Compatibility marker for the pre-cut Issue #488 static guard only:
# invoke-verify-test-backed-smoke.ps1
# Smoke execution itself is Node-owned through verify.ts; this launcher never calls PowerShell.
$Root = Split-Path -Parent $PSScriptRoot
$Arguments = @('--experimental-strip-types', (Join-Path $PSScriptRoot 'verify.ts'), '--repo-root', $Root)
if ($StrictPrereqs) { $Arguments += '--strict-prereqs' }
if ($TestBackedSmoke) { $Arguments += '--test-backed-smoke' }

& node @Arguments
exit $LASTEXITCODE
