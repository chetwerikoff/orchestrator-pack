#requires -Version 5.1
<#
.SYNOPSIS
  REMOVED on AO 0.10 — auto-delivery supersedes first-send reconcile (Issues #210, #625).

.DESCRIPTION
  AO 0.10 delivers review findings automatically on submit. The Issue #202
  `ao review send` loop is retired. Operators should rely on project-config
  reviewers harness (#210) and `review-finding-delivery-confirm.ps1` for
  worker receipt observation only.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
Write-Error @'
review-send-reconcile: REMOVED on AO 0.10 — delivery is automatic on submit.
Remove this child from orchestrator-side-process-registry.json / wake-supervisor after upgrade.
Use review-finding-delivery-confirm.ps1 for delivery receipt observation.
'@
exit 2
