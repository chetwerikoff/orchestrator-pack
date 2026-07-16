[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('required-file', 'contract-marker')]
    [string]$Scenario,
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $RepoRoot).Path
$Failures = [System.Collections.Generic.List[string]]::new()

function Write-Check {
    param([string]$Name, [string]$Status, [string]$Detail = '')
    Write-Host "[$Status] $Name - $Detail"
}

function Add-Failure {
    param([string]$Message)
    $Failures.Add($Message) | Out-Null
}

# Exact behavior replay from scripts/verify.ps1 at frozen source blob
# 6e1c57e8a8114e0e74618bb6e8129463ca4ae881.
function Test-RequiredFile {
    param([string]$RelativePath)
    $path = Join-Path $Root $RelativePath
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Write-Check $RelativePath 'PASS' 'present'
    }
    else {
        Write-Check $RelativePath 'FAIL' 'missing'
        Add-Failure "Missing file: $RelativePath"
    }
}

function Test-ContractMarkers {
    param(
        [string]$RelativePath,
        [string[]]$Markers
    )
    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Check $RelativePath 'FAIL' 'missing contract README'
        Add-Failure "Missing contract README: $RelativePath"
        return
    }

    $content = Get-Content -LiteralPath $path -Raw
    $missing = @()
    foreach ($marker in $Markers) {
        if ($content.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            $missing += $marker
        }
    }

    if ($missing.Count -eq 0) {
        Write-Check $RelativePath 'PASS' 'contract markers present'
    }
    else {
        Write-Check $RelativePath 'FAIL' ('missing markers: ' + ($missing -join ', '))
        Add-Failure "Contract $RelativePath missing markers: $($missing -join ', ')"
    }
}

switch ($Scenario) {
    'required-file' {
        Test-RequiredFile 'AGENTS.md'
    }
    'contract-marker' {
        Test-ContractMarkers 'plugins/ao-scope-guard/README.md' @('DD-024', 'runtime guard', 'git add', 'commit', 'PR-level CI', 'second line')
    }
}

foreach ($failure in $Failures) {
    Write-Host "LEGACY_DIAGNOSTIC: $failure"
}
if ($Failures.Count -gt 0) { exit 1 }
exit 0
