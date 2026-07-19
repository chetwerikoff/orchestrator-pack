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

. (Join-Path $packRoot 'scripts/lib/Invoke-TypeScriptCli.ps1')
$nodeArgs = Get-OpkTypeScriptNodeArguments -ScriptPath $cli
& node @nodeArgs @args
exit $LASTEXITCODE
