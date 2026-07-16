from pathlib import Path

adapter_path = Path("scripts/lib/Invoke-AoReviewApi.ps1")
text = adapter_path.read_text(encoding="utf-8")

cli = r'''
$Script:AoReviewApiCli = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path 'docs/ao-0-10-review-api.mjs'

function Invoke-AoReviewApiCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:AoReviewApiCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'ao-0-10-review-api' -JsonDepth 30
}
'''
marker = ". (Join-Path $PSScriptRoot 'Invoke-TypeScriptCli.ps1')\n"
if "function Invoke-AoReviewApiCli" not in text:
    if text.count(marker) != 1:
        raise SystemExit("Invoke-AoReviewApiCli insertion marker not unique")
    text = text.replace(marker, marker + cli, 1)

setter = r'''
function Set-AoProjectReviewerHarness {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectId,
        [string]$Harness = '',
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null
    )

    if (-not [string]::IsNullOrWhiteSpace($Harness)) {
        throw 'reviewer harness activation is retired; this compatibility helper only clears reviewers'
    }
    $path = "/api/v1/projects/$([uri]::EscapeDataString($ProjectId))/config"
    $body = @{ reviewers = @() }
    return Invoke-AoDaemonHttpJson -Method PUT -Path $path -Body $body -BaseUrl $BaseUrl `
        -HealthPayload $HealthPayload -AllowedStatus @(200)
}

'''
setter_marker = "\nfunction Test-ReviewBeforeCleanupGate {"
if "function Set-AoProjectReviewerHarness" not in text:
    if text.count(setter_marker) != 1:
        raise SystemExit("Set-AoProjectReviewerHarness insertion marker not unique")
    text = text.replace(setter_marker, "\n" + setter + "function Test-ReviewBeforeCleanupGate {", 1)

fixture_guard = r'''
    if ($null -ne $ProjectConfigFixture -and -not $SkipHarnessGuard) {
        $projectConfig = Unwrap-AoProjectConfigPayload -Payload $ProjectConfigFixture
        $guard = Invoke-AoReviewApiCli -Subcommand 'harness-guard' -Payload @{
            payload         = $projectConfig
            expectedHarness = 'codex'
        }
        if ($guard.abort) {
            return @{
                ok         = $false
                httpStatus = 0
                reason     = [string]$guard.reason
                classified = $true
                harness    = $guard.harness
            }
        }
    }

'''
fn_start = text.index("function Invoke-AoReviewTriggerForWorker")
fn_end = text.index("function Get-ReviewTriggerInvocationLine", fn_start)
fn = text[fn_start:fn_end]
if "ProjectConfigFixture -and -not $SkipHarnessGuard" not in fn:
    try_marker = "    try {\n"
    if fn.count(try_marker) != 1:
        raise SystemExit("Invoke-AoReviewTriggerForWorker try marker not unique")
    fn = fn.replace(try_marker, fixture_guard + try_marker, 1)
    text = text[:fn_start] + fn + text[fn_end:]

adapter_path.write_text(text, encoding="utf-8")
