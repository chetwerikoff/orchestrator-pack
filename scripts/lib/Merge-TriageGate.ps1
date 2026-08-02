#requires -Version 5.1
<#
.SYNOPSIS
  Pack-owned at-cap merge triage gate wrapper (Issue #648, Issue #898).
#>
$Script:MergeTriageFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/merge-triage-gate.mjs'
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

function Invoke-MergeTriageCli {
    param(
        [Parameter(Mandatory)][string]$Subcommand,
        [hashtable]$Payload = @{}
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:MergeTriageFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'merge-triage-gate' -JsonDepth 40
}

function Protect-MergeTriageAutomaticBlockAuthority {
    param([Parameter(Mandatory)]$Result)

    # Issue #898: finding prose and marker classifiers are routing hints only. They
    # may enqueue trusted production or architect adjudication, but cannot mint an
    # automatic BLOCK. A future/selected deterministic producer uses a distinct
    # trusted_current_head_* reason and therefore is not rewritten here.
    $reason = [string]$Result.reason
    $textOnlyReasons = @(
        'block_marker',
        'scope_violation_denylist'
    )
    if ([string]$Result.verdict -eq 'BLOCK' -and $textOnlyReasons -contains $reason) {
        $Result.verdict = 'PENDING_ARCHITECT'
        $Result.reason = if ($reason -eq 'scope_violation_denylist') {
            'scope_candidate_requires_trusted_producer'
        }
        else {
            'block_marker_requires_architect_or_trusted_producer'
        }
    }
    return $Result
}

function Invoke-MergeTriageGate {
    param([hashtable]$Payload)
    $result = Invoke-MergeTriageCli -Subcommand 'runGate' -Payload $Payload
    return Protect-MergeTriageAutomaticBlockAuthority -Result $result
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

function Submit-MergeTriageOperatorBudgetReset {
    param([hashtable]$Payload)
    return Invoke-MergeTriageCli -Subcommand 'acknowledgeArchitectBudget' -Payload $Payload
}

