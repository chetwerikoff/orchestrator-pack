param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
$guardScript = Join-Path $Root 'scripts/session-pr-binding-resolver.test.ts'
if (-not (Test-Path -LiteralPath $guardScript)) {
  throw "missing session-pr-binding sole-path guard test: $guardScript"
}

Push-Location $Root
try {
  npm test -- session-pr-binding-resolver 2>&1 | Out-String | Write-Output
  if ($LASTEXITCODE -ne 0) {
    throw "session-pr-binding resolver contract tests failed with exit=$LASTEXITCODE"
  }
}
finally {
  Pop-Location
}
