import { describe, expect, it } from 'vitest';
import type { WorkerAssignment } from '../lib/worker-assignment-store.ts';
import type { ResolvedWorkerAssignment } from '../lib/worker-assignment-runtime.ts';
import {
  assignmentsToStatusSessions,
  buildWorkerStatusReport,
} from './worker-status-report.ts';

function assignment(input: Partial<WorkerAssignment> & Pick<WorkerAssignment, 'assignmentId'|'generation'|'kind'|'provider'|'bindingKey'>): WorkerAssignment {
  return {
    schema:'orchestrator-pack/worker-assignment/v1', projectId:'orchestrator-pack',
    repository:'chetwerikoff/orchestrator-pack', issueNumber:1416, taskId:'task-1416',
    createdAtUtc:'2026-08-17T00:00:00.000Z', ...input,
  };
}

describe('assignment-centric WorkerStatus producer', () => {
  it('emits a remote logical assignment without fabricated runtime/session/workspace/liveness identity', () => {
    const remote = assignment({ assignmentId:'wa-remote', generation:2, kind:'remote', provider:'browser-gpt', bindingKey:'remote-task-1' });
    const sessions = assignmentsToStatusSessions({ assignments:[remote], project:'orchestrator-pack' });
    expect(sessions).toEqual([expect.objectContaining({
      assignmentId:'wa-remote', assignmentGeneration:2, kind:'remote', provider:'browser-gpt',
      bindingKey:'remote-task-1', localCapability:'not_applicable',
    })]);
    const serialized = JSON.stringify(sessions[0]);
    expect(serialized).not.toContain('sessionId');
    expect(serialized).not.toContain('workspacePath');
    expect(serialized).not.toContain('runtime');
    expect(serialized).not.toContain('liveness');

    const report = buildWorkerStatusReport(sessions, {}, 1_000, { killSwitchActive:false, siblingReady:true });
    expect(report.workers[0]).toMatchObject({
      assignmentId:'wa-remote', assignmentGeneration:2, kind:'remote', localCapability:'not_applicable',
      winningSource:'worker_assignment', stale:false,
    });
    expect(report.workers[0]?.sessionId).toBeUndefined();
  });

  it('joins runtime fields only for the exact current local assignment binding', () => {
    const local = assignment({ assignmentId:'wa-local', generation:3, kind:'local', provider:'orca', bindingKey:'dispatch-1' });
    const binding: ResolvedWorkerAssignment = {
      assignment:local,
      worker:{ identity:{ runtime:'orca', id:'terminal-1', generation:'pty-1' }, workspacePath:'/tmp/wt', title:'worker', provenance:'internal' },
    };
    const sessions = assignmentsToStatusSessions({ assignments:[local], bindings:[binding], project:'orchestrator-pack' });
    expect(sessions[0]).toMatchObject({
      assignmentId:'wa-local', assignmentGeneration:3, localCapability:'available',
      sessionId:'terminal-1', runtime:'orca', generation:'pty-1', workspacePath:'/tmp/wt',
    });
  });

  it('keeps an unresolved current local assignment and degrades only its local capability', () => {
    const local = assignment({ assignmentId:'wa-local', generation:3, kind:'local', provider:'orca', bindingKey:'dispatch-1' });
    const sessions = assignmentsToStatusSessions({
      assignments:[local], project:'orchestrator-pack',
      reconciliations:[{ assignment:local, reason:'target_unresolved' }],
    });
    expect(sessions[0]).toMatchObject({
      assignmentId:'wa-local', assignmentGeneration:3, kind:'local', localCapability:'degraded',
      localCapabilityReason:'target_unresolved',
    });
    expect(sessions[0]?.sessionId).toBeUndefined();
    const report = buildWorkerStatusReport(sessions, {}, 1_000, { killSwitchActive:false, siblingReady:true });
    expect(report.workers[0]).toMatchObject({
      assignmentId:'wa-local', kind:'local', localCapability:'degraded',
      derivedStatus:'unknown', winningSource:'degraded', stale:true, degradedReason:'target_unresolved',
    });
  });
});
