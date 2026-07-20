param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('create', 'edit', 'verify')]
    [string] $Mode,

    [Parameter(Mandatory = $true)]
    [string] $DraftPath,

    [string] $Repo = 'chetwerikoff/orchestrator-pack',

    [int] $IssueNumber = 0,

    [string] $Title,

    [switch] $Json
)

$ErrorActionPreference = 'Stop'
$packRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $packRoot 'scripts/publish-issue-body-sync.ts'

$args = @($Mode, '--draft-path', $DraftPath, '--repo', $Repo)
if ($IssueNumber -gt 0) {
    $args += @('--issue-number', [string]$IssueNumber)
}
if ($Title) {
    $args += @('--title', $Title)
}
if ($Json) {
    $args += '--json'
}

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
$nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major." }
$typeScriptLauncher = (Join-Path $packRoot 'scripts/lib/Invoke-TypeScriptCli.ts')
$nodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $cli, '--')
& $node.Source @nodeArgs @args
exit $LASTEXITCODE
