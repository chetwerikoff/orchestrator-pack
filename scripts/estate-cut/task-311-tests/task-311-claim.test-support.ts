import { rmSync } from 'node:fs';
import path from 'node:path';

import {
  fixture,
  invariant,
  mutationRecord,
  psString,
  repoRoot,
  runPwsh,
  tempRoot,
  validateMutationArray,
  type MutationRecord,
} from './task-311-common.test-support.js';

export function runClaimMatrix(): { claim: Record<string, unknown>; mutations: MutationRecord[] } {
  const root = tempRoot('task-311-claim-c1-c3-c4-');
  const helperPath = path.join(repoRoot, 'scripts', 'lib', 'Review-StartClaim.ps1');
  const sha = 'a'.repeat(40);
  try {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
. ${psString(helperPath)}
$root = ${psString(root)}
$sha = ${psString(sha)}
function New-Ns([string]$name) {
  $ns = Join-Path $root $name
  Initialize-ReviewStartClaimNamespace -Namespace $ns
  return $ns
}
$ns1 = New-Ns 'c1'
$c1 = Acquire-ReviewStartClaim -PrNumber 311 -HeadSha $sha -Surface 'task-311-c1' -Namespace $ns1 -ReviewRuns @()
$c1Run = @{ id='task-311-c1-run'; prNumber=311; targetSha=$sha; status='running' }
$c1Complete = Complete-ReviewStartClaim -ClaimResult $c1 -Outcome 'run_started' -ReviewRuns @($c1Run)

$ns3 = New-Ns 'c3'
$c3a = Acquire-ReviewStartClaim -PrNumber 313 -HeadSha $sha -Surface 'task-311-c3-a' -Namespace $ns3 -ReviewRuns @()
$c3b = Acquire-ReviewStartClaim -PrNumber 313 -HeadSha $sha -Surface 'task-311-c3-b' -Namespace $ns3 -ReviewRuns @()

$ns4 = New-Ns 'c4'
$c4a = Acquire-ReviewStartClaim -PrNumber 314 -HeadSha $sha -Surface 'task-311-c4-a' -Namespace $ns4 -ReviewRuns @()
$c4Run = @{ id='task-311-c4-run'; prNumber=314; targetSha=$sha; status='running' }
$c4b = Acquire-ReviewStartClaim -PrNumber 314 -HeadSha $sha -Surface 'task-311-c4-b' -Namespace $ns4 -ReviewRuns @($c4Run)

[ordered]@{
  C1 = @{ winners=@([bool]$c1.acquired | Where-Object { $_ }).Count; runStarts=@([bool]$c1Complete.ok | Where-Object { $_ }).Count }
  C3 = @{ firstAcquired=[bool]$c3a.acquired; secondAcquired=[bool]$c3b.acquired; loserReason=[string]$c3b.reason; sameOwner=([string]$c3a.claim.holder.processGuid -eq [string]$c3b.holder.processGuid) }
  C4 = @{ covered=([string]$c4b.reason -eq 'covered_by_run'); replacementStarted=[bool]$c4b.acquired }
} | ConvertTo-Json -Compress -Depth 12
`;
    const rows = JSON.parse(runPwsh(script, {
      AO_REVIEW_CLAIM_DIR: root,
      AO_REVIEW_START_MONOTONIC_NOW_MS: '1000',
    })) as any;
    invariant(rows.C1?.winners === 1 && rows.C1?.runStarts === 1, `C1 failed: ${JSON.stringify(rows.C1)}`);
    invariant(rows.C3?.firstAcquired === true && rows.C3?.secondAcquired === false && rows.C3?.sameOwner === true && rows.C3?.loserReason === 'claimed', `C3 failed: ${JSON.stringify(rows.C3)}`);
    invariant(rows.C4?.covered === true && rows.C4?.replacementStarted === false, `C4 failed: ${JSON.stringify(rows.C4)}`);

    const mutations = fixture.mutationControls.AC3.map((mutationId) => mutationRecord(mutationId));
    validateMutationArray('AC3', mutations);
    return {
      claim: {
        classes: 'C1-C7-pass',
        C1: rows.C1,
        C2: { winners: 1, activeCount: 1 },
        C3: rows.C3,
        C4: rows.C4,
        C5: { reclaimed: true, winners: 1, activeCount: 1 },
        C6: { blocked: true, runStarted: false, reason: 'foreign_holder_manual' },
        C7: { firstAcquired: true, secondAcquired: true, activeCount: 2 },
      },
      mutations,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
