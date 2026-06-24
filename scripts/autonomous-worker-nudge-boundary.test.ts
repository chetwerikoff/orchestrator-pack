import { describe, expect, it } from 'vitest';
import {
  evaluateBoundary,
  findForbiddenAutonomousWorkerSendInvocations,
} from '../docs/worker-nudge-gate.mjs';

describe('autonomous-worker-nudge-boundary (#430)', () => {
  it('still denies raw ao send on autonomous surface', () => {
    const verdict = evaluateBoundary({
      commandLine: 'ao send opk-worker continue task',
      autonomousSurface: true,
      journaledTransportInternal: false,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('autonomous_raw_worker_send_denied');
    expect(findForbiddenAutonomousWorkerSendInvocations(['ao send opk-worker ping'])).toHaveLength(1);
  });

  it('allows gated task-continuation invoke path', () => {
    const verdict = evaluateBoundary({
      commandLine:
        'pwsh -NoProfile -File scripts/invoke-gated-worker-nudge.ps1 -SessionId opk-430 -IssueNumber 417 -IntentClass task-continuation',
      autonomousSurface: true,
      journaledTransportInternal: false,
    });
    expect(verdict.allowed).toBe(true);
  });
});
