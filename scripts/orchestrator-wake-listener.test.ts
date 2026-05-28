import { describe, expect, it } from 'vitest';
import {
  buildWakeMessage,
  evaluateWakePayload,
  type AoWebhookBody,
} from '../docs/orchestrator-wake-filter.js';

function notificationEvent(
  overrides: Partial<NonNullable<AoWebhookBody['event']>> & {
    data?: Record<string, unknown>;
  } = {},
) {
  return {
    type: 'notification' as const,
    event: {
      id: 'evt-1',
      type: 'ci.failing',
      priority: 'action',
      sessionId: 'op-worker-3',
      projectId: 'orchestrator-pack',
      timestamp: '2026-05-28T12:00:00.000Z',
      message: 'CI failed',
      data: {
        schemaVersion: 3,
        semanticType: 'ci.failing',
        subject: {
          session: { id: 'op-worker-3', projectId: 'orchestrator-pack' },
          pr: { number: 42, url: 'https://github.com/org/repo/pull/42' },
        },
      },
      ...overrides,
    },
  };
}

describe('evaluateWakePayload', () => {
  it('accepts wake-relevant ci.failing notification', () => {
    const result = evaluateWakePayload(notificationEvent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wakeKind).toBe('ci.failing');
      expect(result.sessionId).toBe('op-worker-3');
      expect(result.prNumber).toBe(42);
      expect(result.wakeMessage).toContain('wake ci.failing');
      expect(result.wakeMessage).toContain('session=op-worker-3');
      expect(result.wakeMessage).toContain('pr=#42');
    }
  });

  it('drops info-class priority payloads', () => {
    const result = evaluateWakePayload(
      notificationEvent({ priority: 'info', type: 'summary.all_complete' }),
    );
    expect(result).toEqual({ ok: false, reason: 'info_priority', detail: 'info' });
  });

  it('rejects malformed payload', () => {
    expect(evaluateWakePayload(null)).toEqual({
      ok: false,
      reason: 'malformed_payload',
      detail: 'body is not an object',
    });
    expect(evaluateWakePayload({ type: 'message', message: 'ping' })).toEqual({
      ok: false,
      reason: 'not_notification',
      detail: 'message',
    });
  });

  it('rejects payload missing session id with missing_session_id', () => {
    const result = evaluateWakePayload(
      notificationEvent({ sessionId: '', type: 'merge.ready', priority: 'action' }),
    );
    expect(result).toEqual({ ok: false, reason: 'missing_session_id' });
  });

  it('accepts report.stale via reaction semantic type', () => {
    const result = evaluateWakePayload(
      notificationEvent({
        type: 'reaction.escalated',
        priority: 'urgent',
        sessionId: 'op-worker-9',
        data: {
          schemaVersion: 3,
          semanticType: 'report.stale',
          subject: { session: { id: 'op-worker-9', projectId: 'p' } },
          reaction: { key: 'report-stale', action: 'escalated' },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wakeKind).toBe('report.stale');
    }
  });

  it('accepts ready_for_review semantic type', () => {
    const result = evaluateWakePayload(
      notificationEvent({
        type: 'session.working',
        priority: 'action',
        sessionId: 'op-worker-2',
        data: {
          schemaVersion: 3,
          semanticType: 'ready_for_review',
          subject: { session: { id: 'op-worker-2', projectId: 'p' } },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wakeKind).toBe('ready_for_review');
    }
  });

  it('accepts review.needs_triage from code review block', () => {
    const result = evaluateWakePayload(
      notificationEvent({
        type: 'review.pending',
        priority: 'action',
        sessionId: 'op-worker-1',
        data: {
          schemaVersion: 3,
          semanticType: 'review.pending',
          subject: { session: { id: 'op-worker-1', projectId: 'p' } },
          codeReview: { runId: 'op-rev-11', status: 'needs_triage' },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wakeKind).toBe('review.needs_triage');
      expect(result.runId).toBe('op-rev-11');
    }
  });

  it('drops dashboard-style info notification', () => {
    const result = evaluateWakePayload(
      notificationEvent({
        type: 'session.working',
        priority: 'info',
        sessionId: 'op-worker-1',
        data: {
          schemaVersion: 3,
          semanticType: 'session.working',
          subject: { session: { id: 'op-worker-1', projectId: 'p' } },
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'info_priority', detail: 'info' });
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
