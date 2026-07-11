import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateWakePayload } from '../docs/orchestrator-wake-filter.mjs';
import { notificationEvent } from './orchestrator-wake-listener.shared.js';

const repoRoot = path.join(import.meta.dirname, '..');
const listenerScript = path.join(repoRoot, 'scripts/orchestrator-wake-listener.ps1');

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

  it('accepts review.changes_requested from code review block (legacy needs_triage status)', () => {
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
      expect(result.wakeKind).toBe('review.changes_requested');
      expect(result.runId).toBe('op-rev-11');
    }
  });


  it('promotes info-priority ready_for_review hand-off envelope (Issue #381)', () => {
    const result = evaluateWakePayload(
      notificationEvent({
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
      }),
      {
        supervisedProjectId: 'orchestrator-pack',
        supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
        openPrs: [{ number: 42, headRefOid: 'abc123', baseRefName: 'main' }],
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wakeKind).toBe('ready_for_review');
      expect(result.handoffAdmission?.promotedFromInfoPriority).toBe(true);
    }
  });


  it('promotes info-priority review.pending hand-off envelope (Issue #390)', () => {
    const result = evaluateWakePayload(
      notificationEvent({
        type: 'review.pending',
        priority: 'info',
        sessionId: 'op-worker-2',
        projectId: 'orchestrator-pack',
        data: {
          schemaVersion: 3,
          semanticType: 'review.pending',
          subject: {
            session: { id: 'op-worker-2', projectId: 'orchestrator-pack' },
            pr: {
              number: 42,
              url: 'https://github.com/chetwerikoff/orchestrator-pack/pull/42',
            },
          },
        },
      }),
      {
        supervisedProjectId: 'orchestrator-pack',
        supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
        openPrs: [{ number: 42, headRefOid: 'abc123', baseRefName: 'main' }],
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wakeKind).toBe('ready_for_review');
      expect(result.wakeKind).not.toBe('review.changes_requested');
      expect(result.handoffAdmission?.promotedFromInfoPriority).toBe(true);
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

  it('merge.ready actuator preserved without FYI wake send', () => {
    const listener = readFileSync(listenerScript, 'utf8');
    expect(listener).toContain("Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-handoff-envelope'");
    expect(listener).toContain('Invoke-ReviewWakeTriggerOnCompletionWake');
    expect(listener).toContain("$dedupDecision = Test-AndRecordWakeDedup");
    expect(listener.indexOf('Invoke-ReviewWakeTriggerOnCompletionWake')).toBeLessThan(
      listener.indexOf('$dedupDecision = Test-AndRecordWakeDedup'),
    );
    expect(listener).not.toContain('Send-OrchestratorWakeMessage');
  });

  it('progress stamps preserved without FYI wake send', () => {
    const listener = readFileSync(listenerScript, 'utf8');
    expect(listener).toContain("Write-OrchestratorSideProcessProgress -ChildId 'listener' -Phase 'accepted'");
    expect(listener).toContain('$lastAcceptedAt = Get-Date');
    expect(listener).toContain('$lastProgressAt = Get-Date');
    expect(listener).not.toContain('Send-OrchestratorWakeMessage');
  });
});
