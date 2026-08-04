import { describe, expect, it } from 'vitest';
import {
  buildDeterministicDeliveryKey,
  canEvictLifecycleEntry,
  evaluateDeterministicJournalAdmission,
  hashReviewFindings,
  isVerdictSnapshotLost,
  TERMINAL_DELIVERED,
} from '../docs/review-delivery-lifecycle.mjs';
import {
  buildScriptedReviewDeliveryMessage,
  parsePackReviewTerminalStdout,
} from '../docs/scripted-review-post-submit-delivery.mjs';
import {
  classifyPackReviewPayload,
  isNonBlockingPackReviewFinding,
} from './lib/pack-review-delivery.ts';

const headSha = 'abc123def4567890abcdef1234567890abcdef12';
const prNumber = 718;

function deliveryKey(findings: unknown[]): string {
  const key = buildDeterministicDeliveryKey({
    prNumber,
    headSha,
    verdictSource: 'wrapper-stdout',
    findingsHash: hashReviewFindings(findings),
  });
  if (!key) throw new Error('delivery key required for test fixture');
  return key;
}

describe('runtime-neutral review delivery contract', () => {
  it('keeps actionable non-terminal lifecycle entries durable', () => {
    const result = canEvictLifecycleEntry({
      entry: { terminalStatus: '', state: 'verdict_recorded', lastUpdatedMs: 1 },
      prActionable: true,
      nowMs: 10_000,
    });
    expect(result).toEqual({ ok: false, reason: 'non_terminal_actionable_pr' });
  });

  it.each(['started', 'verdict_recorded', 'delivery_claimed', 'delivery_attempted'])(
    'fails closed when %s has no durable verdict snapshot',
    (state) => {
      expect(isVerdictSnapshotLost({ state, stdoutSnapshot: '' })).toBe(true);
      expect(isVerdictSnapshotLost({ state, stdoutSnapshot: '{"verdict":"clean"}' })).toBe(false);
    },
  );

  it('does not resend a terminal delivered deterministic journal entry', () => {
    const key = deliveryKey([]);
    const admission = evaluateDeterministicJournalAdmission({
      prior: {
        deliveryId: 'worker:pack-send:det:abc',
        deterministicKey: key,
        dispatchOutcome: 'dispatched',
        lifecycleTerminal: TERMINAL_DELIVERED,
      },
    }, {
      deterministicKey: key,
      findingsHash: hashReviewFindings([]),
    });
    expect(admission.action).toBe('no_op_terminal');
  });

  it('escalates changed findings for the same head instead of sending twice', () => {
    const priorFindings = [{ id: 'F1', severity: 'blocking' }];
    const nextFindings = [{ id: 'F2', severity: 'blocking' }];
    const priorKey = deliveryKey(priorFindings);
    const nextKey = deliveryKey(nextFindings);
    const admission = evaluateDeterministicJournalAdmission({
      prior: {
        deliveryId: 'worker:pack-send:det:abc',
        deterministicKey: priorKey,
        dispatchOutcome: 'dispatched',
        lifecycleTerminal: TERMINAL_DELIVERED,
        findingsHash: hashReviewFindings(priorFindings),
      },
    }, {
      deterministicKey: nextKey,
      findingsHash: hashReviewFindings(nextFindings),
    });
    expect(admission.ok).toBe(false);
    expect(admission.action).toBe('escalate_supersede');
    expect(admission.reason).toBe('different_findings_same_head');
  });

  it('parses terminal stdout and builds a deterministic worker message', () => {
    const parsed = parsePackReviewTerminalStdout(JSON.stringify({
      verdict: 'clean',
      findingCount: 0,
      findings: [],
    }));
    expect(parsed.ok).toBe(true);
    expect(parsed.gateVerdict).toBe('approved');

    const message = buildScriptedReviewDeliveryMessage({
      prNumber,
      deliveryKey: deliveryKey([]),
      headSha,
      gateVerdict: 'approved',
    });
    expect(message.ok).toBe(true);
    expect(message.message).toContain(`PR #${prNumber}`);
  });

  it('maps clean, non-blocking, and blocking payloads to the closed status contract', () => {
    expect(classifyPackReviewPayload({ verdict: 'clean', findingCount: 0, findings: [] })).toMatchObject({
      terminalStatus: 'up_to_date',
      requiredStatus: 'success',
      blocking: false,
    });
    expect(isNonBlockingPackReviewFinding({ severity: 'warning' })).toBe(true);
    expect(classifyPackReviewPayload({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'warning' }],
    })).toMatchObject({ terminalStatus: 'commented', requiredStatus: 'success', blocking: false });
    expect(classifyPackReviewPayload({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'blocking' }],
    })).toMatchObject({ terminalStatus: 'changes_requested', requiredStatus: 'failure', blocking: true });
  });
});
