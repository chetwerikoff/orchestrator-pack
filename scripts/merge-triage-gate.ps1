#requires -Version 5.1
param(
    [Parameter(Mandatory)][ValidateSet('run-gate','policy','architect-inbox','architect-token','architect-adjudicate','worker-appeal')]
    [string]$Command,
    [string]$PayloadJson = '{}'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Merge-TriageGate.ps1')
$payload = ConvertFrom-Json -InputObject $PayloadJson -AsHashtable
switch ($Command) {
    'run-gate' { Invoke-MergeTriageGate -Payload $payload }
    'policy' { Get-MergeTriagePolicy -Payload $payload }
    'architect-inbox' { Get-MergeTriageArchitectInbox -Payload $payload }
    'architect-token' { New-MergeTriageArchitectToken -Payload $payload }
    'architect-adjudicate' { Submit-MergeTriageArchitectVerdict -Payload $payload }
    'worker-appeal' { Submit-MergeTriageWorkerAppeal -Payload $payload }
}
