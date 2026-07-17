import './review-delivery-outcome-base.fixture.js';
import './pack-review-delivery-outcome.fixture.js';
import './review-delivery-outcome-runner.fixture.js';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPackReviewRun, getPackReviewRun } from './lib/pack-review-run-store.js';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const deliveryOutcomeRunHeadSha = 'abc123def4567890abcdef1234567890abcdef12';
const deliveryOutcomeStdout = JSON.stringify({
  verdict: 'clean',
  findingCount: 0,
  findings: [],
});
const deliveryOutcomeSuccessReason = 'explicit_send_dispatched\nдоставка ✓';

type PowerShellDeliveryCase = {
  name: string;
  runId: string;
  ok: boolean;
  skipped: boolean;
  escalated: boolean;
  reason: string;
};

describe('pack review delivery outcome live PowerShell chain (Issue #862)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('records success, duplicate skip, non-escalated failure, and escalated failure through the pack-review upper seam', () => {
    const storeRoot = mkdtempSync(path.join(tmpdir(), 'opk-delivery-chain-store-'));
    const lifecycleRoot = mkdtempSync(path.join(tmpdir(), 'opk-delivery-chain-lifecycle-'));
    tempDirs.push(storeRoot, lifecycleRoot);
    const lifecyclePath = path.join(lifecycleRoot, 'lifecycle.json');
    const runs = [901, 902, 903, 904].map((prNumber) => createPackReviewRun({
      storeRoot,
      projectId: 'orchestrator-pack',
      prNumber,
      headSha: deliveryOutcomeRunHeadSha,
      linkedSessionId: `worker-${prNumber}`,
      startReason: 'delivery-outcome-live-chain-test',
      surface: 'vitest',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
    }).run);

    const script = [
      `. ${psString(path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewPostSubmitDelivery.ps1'))}`,
      `. ${psString(path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1'))}`,
      'function gh {',
      "  if ($args.Count -ge 2 -and $args[0] -eq 'pr' -and $args[1] -eq 'view') {",
      "    return ([ordered]@{ number = [int]$env:AO_PR_NUMBER; body = 'Closes #862' } | ConvertTo-Json -Compress)",
      '  }',
      "  throw \"unexpected gh call: $($args -join ' ')\"",
      '}',
      'function Invoke-ScriptedReviewStdoutDeliverySend {',
      '  param($SessionId, $MessageText, $DeliveryKey, $DeliveryId, $PrNumber, $TargetSha, $ProjectId, $FindingsHash, $WorkerTarget, $OpenPrs, $LifecycleStorePath, [switch]$DryRun)',
      "  Set-ScriptedReviewStdoutDeliveryLifecycleEntry -DeliveryKey $DeliveryKey -Patch @{ state = 'delivered'; terminalStatus = 'delivered'; terminalAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } -LifecycleStorePath $LifecycleStorePath",
      `  return @{ ok = $true; sent = $true; skipped = $false; escalated = $false; reason = ${psString(deliveryOutcomeSuccessReason)}; terminal = 'delivered' }`,
      '}',
      'function Record-DeliveryCase {',
      '  param([string]$Name, [string]$RunId, [int]$PrNumber, [object[]]$Sessions, [object[]]$OpenPrs, [switch]$SimulateCrashAfterVerdictBeforeSend)',
      '  $env:PACK_REVIEW_RUN_ID = $RunId',
      '  $env:AO_PR_NUMBER = [string]$PrNumber',
      `  $delivery = Invoke-ScriptedReviewPostSubmitDeliveryFromPackReview -RepoRoot ${psString(repoRoot)} -WrapperStdout ${psString(deliveryOutcomeStdout)} -WrapperExitCode 0 -LifecycleStorePath ${psString(lifecyclePath)} -Sessions $Sessions -OpenPrs $OpenPrs -SkipTelemetry -SimulateCrashAfterVerdictBeforeSend:$SimulateCrashAfterVerdictBeforeSend`,
      `  Record-PackReviewDeliveryOutcome -Delivery $delivery -ReviewTargetRoot ${psString(repoRoot)}`,
      '  return [ordered]@{',
      '    name = $Name',
      '    runId = $RunId',
      '    ok = [bool]$delivery.ok',
      '    skipped = [bool]$delivery.skipped',
      '    escalated = [bool]$delivery.escalated',
      '    reason = [string]$delivery.reason',
      '  }',
      '}',
      `$headSha = (git -C ${psString(repoRoot)} rev-parse HEAD).Trim()`,
      '$successSessions = @(@{ id = \'worker-901\'; sessionId = \'worker-901\'; name = \'worker-901\'; role = \'worker\'; status = \'working\'; prNumber = 901; branch = \'feat/issue-901\' })',
      '$successPrs = @(@{ number = 901; headRefOid = $headSha; headRefName = \'feat/issue-901\' })',
      '$results = @()',
      `$results += Record-DeliveryCase -Name 'success' -RunId ${psString(runs[0]!.id)} -PrNumber 901 -Sessions $successSessions -OpenPrs $successPrs`,
      `$results += Record-DeliveryCase -Name 'duplicate' -RunId ${psString(runs[1]!.id)} -PrNumber 901 -Sessions $successSessions -OpenPrs $successPrs`,
      `$results += Record-DeliveryCase -Name 'failed' -RunId ${psString(runs[2]!.id)} -PrNumber 903 -Sessions @() -OpenPrs @() -SimulateCrashAfterVerdictBeforeSend`,
      '$ambiguousSessions = @(@{ id = \'worker-904-a\'; sessionId = \'worker-904-a\'; role = \'worker\'; status = \'working\'; prNumber = 904; branch = \'feat/issue-904\' }, @{ id = \'worker-904-b\'; sessionId = \'worker-904-b\'; role = \'worker\'; status = \'working\'; prNumber = 904; branch = \'feat/issue-904\' })',
      '$ambiguousPrs = @(@{ number = 904; headRefOid = $headSha; headRefName = \'feat/issue-904\' })',
      `$results += Record-DeliveryCase -Name 'escalated' -RunId ${psString(runs[3]!.id)} -PrNumber 904 -Sessions $ambiguousSessions -OpenPrs $ambiguousPrs`,
      '$missingReasonRejected = $false',
      'try {',
      '  $missingLower = ConvertTo-ScriptedReviewStdoutDeliveryOutcome -Outcome @{ ok = $true; sent = $true }',
      '  ConvertTo-ScriptedReviewPostSubmitDeliveryOutcome -Delivery $missingLower | Out-Null',
      '}',
      'catch {',
      "  $missingReasonRejected = $_.Exception.Message -match 'missing a string reason'",
      '}',
      '[ordered]@{ cases = @($results); missingReasonRejected = $missingReasonRejected } | ConvertTo-Json -Depth 10 -Compress',
    ].join('\n');

    const parsed = JSON.parse(runPwsh(script, {
      PACK_REVIEW_RUN_STORE_ROOT: storeRoot,
      PACK_REVIEW_PROJECT_ID: 'orchestrator-pack',
    })) as { cases: PowerShellDeliveryCase[]; missingReasonRejected: boolean };

    expect(parsed.missingReasonRejected).toBe(true);
    expect(parsed.cases).toHaveLength(4);
    expect(parsed.cases[0]).toMatchObject({
      name: 'success',
      ok: true,
      skipped: false,
      escalated: false,
      reason: deliveryOutcomeSuccessReason,
    });
    expect(parsed.cases[1]).toMatchObject({
      name: 'duplicate',
      ok: true,
      skipped: true,
      escalated: false,
      reason: 'already_delivered',
    });
    expect(parsed.cases[2]).toMatchObject({
      name: 'failed',
      ok: false,
      skipped: false,
      escalated: false,
      reason: 'crash_after_verdict_recorded',
    });
    expect(parsed.cases[3]).toMatchObject({
      name: 'escalated',
      ok: false,
      skipped: false,
      escalated: true,
    });
    expect(parsed.cases[3]!.reason.length).toBeGreaterThan(0);

    for (const result of parsed.cases) {
      const stored = getPackReviewRun(result.runId, { storeRoot });
      expect(stored?.deliveryOutcome).toEqual({
        classification: result.skipped ? 'skipped' : result.ok ? 'delivered' : 'failed',
        escalated: result.escalated,
        reason: result.reason,
      });
    }
  });
});
