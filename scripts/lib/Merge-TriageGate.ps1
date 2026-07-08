#requires -Version 5.1
<#
.SYNOPSIS
  Pack-owned at-cap merge triage gate wrapper (Issue #648).
#>
$Script:MergeTriageFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/merge-triage-gate.mjs'
. (Join-Path $PSScriptRoot 'Invoke-MechanicalNodeFilterCli.ps1')

function Invoke-MergeTriageCli {
    param(
        [Parameter(Mandatory)][string]$Subcommand,
        [hashtable]$Payload = @{}
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:MergeTriageFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'merge-triage-gate' -JsonDepth 40
}

function Invoke-MergeTriageGate {
    param([hashtable]$Payload)
    return Invoke-MergeTriageCli -Subcommand 'runGate' -Payload $Payload
}

function Get-MergeTriagePolicy {
    param([hashtable]$Payload)
    return Invoke-MergeTriageCli -Subcommand 'evaluateMergePolicy' -Payload $Payload
}

function Get-MergeTriageArchitectInbox {
    param([hashtable]$Payload = @{})
    return Invoke-MergeTriageCli -Subcommand 'readArchitectInbox' -Payload $Payload
}

function New-MergeTriageArchitectToken {
    param([hashtable]$Payload)
    return Invoke-MergeTriageCli -Subcommand 'issueArchitectToken' -Payload $Payload
}

function Submit-MergeTriageArchitectVerdict {
    param([hashtable]$Payload)
    return Invoke-MergeTriageCli -Subcommand 'adjudicateArchitectFinding' -Payload $Payload
}

function Submit-MergeTriageWorkerAppeal {
    param([hashtable]$Payload)
    return Invoke-MergeTriageCli -Subcommand 'fileWorkerAppeal' -Payload $Payload
}
