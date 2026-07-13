#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$target = Join-Path ([IO.Path]::GetTempPath()) ('opk-771-probe-' + [guid]::NewGuid().ToString('N'))
$exportDir = Join-Path $Root 'scripts/issue-771-target-files'

Push-Location $Root
try {
    & git fetch --no-tags origin agent/issue-771-powershell-scope
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $LASTEXITCODE" }
    & git worktree add --detach $target FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw "git worktree add failed: $LASTEXITCODE" }
}
finally { Pop-Location }

try {
    if (Test-Path -LiteralPath $exportDir) {
        Remove-Item -LiteralPath $exportDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $exportDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $target 'scripts/lib/Invoke-ReviewWakeTrigger.ps1') `
        -Destination (Join-Path $exportDir 'Invoke-ReviewWakeTrigger.ps1')
    Copy-Item -LiteralPath (Join-Path $target 'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1') `
        -Destination (Join-Path $exportDir 'Issue771.PowerShellDependencyScope.Tests.ps1')
    Set-Content -LiteralPath (Join-Path $exportDir 'head-sha.txt') -Value ((git -C $target rev-parse HEAD).Trim()) -Encoding utf8
    exit 0
}
finally {
    Push-Location $Root
    try { & git worktree remove --force $target 2>$null | Out-Null }
    finally { Pop-Location }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
}
