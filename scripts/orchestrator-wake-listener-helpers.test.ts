import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildWakeMessage,
  probeReadyForReviewHandoffEnvelope,
  isCompletionMergeIntentWake,
} from '../docs/orchestrator-wake-filter.mjs';
import { notificationEvent } from './orchestrator-wake-listener.shared.js';

const filterCli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/orchestrator-wake-filter.mjs');

describe('probeReadyForReviewHandoffEnvelope', () => {
  it('identifies ready_for_review hand-off envelopes without admission I/O', () => {
    const handoff = notificationEvent({
      type: 'session.working',
      priority: 'info',
      sessionId: 'op-worker-2',
      projectId: 'orchestrator-pack',
      data: {
        schemaVersion: 3,
        semanticType: 'ready_for_review',
        subject: {
          session: { id: 'op-worker-2', projectId: 'orchestrator-pack' },
          pr: {
            number: 42,
            url: 'https://github.com/chetwerikoff/orchestrator-pack/pull/42',
          },
        },
      },
    });
    expect(probeReadyForReviewHandoffEnvelope(handoff)).toEqual({ handoffEnvelope: true });
    expect(probeReadyForReviewHandoffEnvelope(notificationEvent())).toEqual({ handoffEnvelope: false });
    expect(probeReadyForReviewHandoffEnvelope(null)).toEqual({ handoffEnvelope: false });
  });
});

describe('isCompletionMergeIntentWake', () => {
  it('identifies merge.ready as completion merge-intent wake', () => {
    expect(isCompletionMergeIntentWake('merge.ready')).toBe(true);
    expect(isCompletionMergeIntentWake('ci.failing')).toBe(false);
  });
});

describe('buildWakeMessage', () => {
  it('includes run id when present', () => {
    expect(
      buildWakeMessage('review.needs_triage', {
        sessionId: 'op-1',
        runId: 'op-rev-11',
      }),
    ).toBe('wake review.needs_triage session=op-1 run=op-rev-11');
  });
});

describe('wake filter CLI evaluate wrapper', () => {
  it('returns malformed_payload for invalid bodyJson without exiting non-zero', () => {
    const payload = JSON.stringify({ bodyJson: '{not-json', admissionContext: {} });
    const result = spawnSync('node', [filterCli, 'evaluate'], { input: payload, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('malformed_payload');
    expect(String(parsed.detail)).toBeTruthy();
  });

  it('evaluates valid bodyJson wrapper payloads', () => {
    const body = notificationEvent({
      type: 'merge.ready',
      priority: 'action',
      sessionId: 'op-worker-3',
      data: {
        schemaVersion: 3,
        semanticType: 'merge.ready',
        subject: {
          session: { id: 'op-worker-3', projectId: 'orchestrator-pack' },
          pr: { number: 42, url: 'https://github.com/org/repo/pull/42' },
        },
      },
    });
    const payload = JSON.stringify({ bodyJson: JSON.stringify(body), admissionContext: {} });
    const result = spawnSync('node', [filterCli, 'evaluate'], { input: payload, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.wakeKind).toBe('merge.ready');
    }
  });
});

