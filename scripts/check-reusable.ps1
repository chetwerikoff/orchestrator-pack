#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$AllowNoGit
)

$Root = Split-Path -Parent $PSScriptRoot
$Arguments = @('--experimental-strip-types', (Join-Path $PSScriptRoot 'verify.ts'), '--repo-root', $Root, '--reusable-only')
if ($AllowNoGit) { $Arguments += '--allow-no-git' }

& node @Arguments
exit $LASTEXITCODE
