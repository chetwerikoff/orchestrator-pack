import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter, RuntimeAssignmentWorkerResolution, RuntimeWorker } from './runtime/contracts.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import {
  currentWorkerAssignment,
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
} from './lib/worker-assignment-store.ts';
import {
  loadWorkerRecoveryCleanupAuthority,
  parseWorkerRecoveryArgs,
  runWorkerRecovery,
} from './invoke-worker-recovery.ts';

const roots: string[] = [];
const previousBase = process.env.OPK_BASE_DIR;
type ResolutionWithTarget = RuntimeAssignmentWorkerResolution & { readonly workerId?: string };

function runtimeWithResolution(
  base: DeterministicRuntimeAdapter,
  resolution: ResolutionWithTarget,
): RuntimeAdapter {
  const adapter = base as unknown as RuntimeAdapter;
  Object.defineProperty(adapter, 'resolveAssignmentWorker', {
    configurable: true,
    value: vi.fn(() => ({ status: 'ok' as const, value: resolution })),
  });
  return adapter;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opk-recovery-cli-'));
  roots.push(root);
  process.env.OPK_BASE_DIR = root;
  const file = resolveWorkerAssignmentStorePath('orchestrator-pack', process.env);
  const published = await publishCurrentWorkerAssignment({
    file,
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1416,
    taskId: 'task-1416',
    kind: 'local',
    provider: 'orca',
    bindingKey: 'dispatch-1',
    role: 'worker',
  });
  if (!published.ok) throw new Error(published.reason);
  const base = new DeterministicRuntimeAdapter();
  const cleanupWorkspace = join(root, 'stale-worktree');
  const created = base.spawnWorker({ title: 'old', command: 'cursor-agent', workspace: cleanupWorkspace });
  if (created.status !== 'ok') throw new Error('worker fixture failed');
  const sessionDir = join(root, 'projects', 'orchestrator-pack', 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `${created.value.identity.id}.json`), `${JSON.stringify({
    runtimeHandle: {
      runtime: created.value.identity.runtime,
      id: created.value.identity.id,
      generation: created.value.identity.generation,
      data: { workspacePath: cleanupWorkspace, headSha: 'test-head' },
    },
  })}\n`, 'utf8');
  const args = [
    '--repository', 'chetwerikoff/orchestrator-pack',
    '--issue-number', '1416',
    '--task-id', 'task-1416',
    '--assignment-id', published.assignment.assignmentId,
    '--assignment-generation', String(published.assignment.generation),
    '--provider', 'orca',
    '--binding-key', 'dispatch-1',
    '--worker-id', created.value.identity.id,
    '--worker-generation', created.value.identity.generation,
    '--cleanup-workspace', cleanupWorkspace,
    '--expected-head-sha', 'test-head',
    '--repo-root', root,
  ] as const;
  const options = parseWorkerRecoveryArgs(args);
  const authority = loadWorkerRecoveryCleanupAuthority(options);
  if (!authority.ok) throw new Error(authority.reason);
  return { root, file, assignment: published.assignment, base, worker: created.value, options, authority: authority.authority };
}

afterEach(() => {
  if (previousBase === undefined) delete process.env.OPK_BASE_DIR;
  else process.env.OPK_BASE_DIR = previousBase;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('assignment-fenced worker recovery entrypoint', () => {
  it('returns operator_required_successor_start after exact gone cleanup and never auto-spawns', async () => {
    const f = await fixture();
    expect(f.base.stopWorker(f.worker.identity).status).toBe('ok');
    const adapter = runtimeWithResolution(f.base, { kind: 'gone', workerId: f.worker.identity.id });
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const spawn = vi.spyOn(f.base, 'spawnWorker');
    const result = await runWorkerRecovery({
      options: f.options,
      adapter,
      claimNamespace: join(f.root, 'claims'),
      cleanupAuthority: f.authority,
    });
    expect(result).toMatchObject({
      outcome: 'operator_required_successor_start',
      disposition: 'operator_manual',
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1416,
      taskId: 'task-1416',
      expectedAssignment: {
        assignmentId: f.assignment.assignmentId,
        generation: f.assignment.generation,
      },
      provider: 'orca',
      bindingKey: 'dispatch-1',
      recoveryWorkspacePath: f.options.cleanupWorkspacePath,
      expectedHeadSha: 'test-head',
      cleanupOutcome: 'completed',
      cleanupReason: 'gone_target_cleanup_completed',
      claimFinalized: true,
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(currentWorkerAssignment(f.file, 1416)).toEqual(f.assignment);
  });

  it.each(['busy', 'idle'] as const)('returns skipped_live for %s and never claims, stops, cleans, or starts', async (liveness) => {
    const f = await fixture();
    f.base.setLiveness(f.worker.identity, liveness);
    const adapter = runtimeWithResolution(f.base, { kind: 'resolved', worker: f.worker });
    const stop = vi.spyOn(f.base, 'stopWorker');
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const spawn = vi.spyOn(f.base, 'spawnWorker');
    const result = await runWorkerRecovery({
      options: f.options,
      adapter,
      claimNamespace: join(f.root, 'claims'),
      cleanupAuthority: f.authority,
    });
    expect(result).toMatchObject({ outcome: 'skipped_live', reason: `runtime_${liveness}` });
    expect(result.claimFinalized).toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses cleanup when gone Dispatch target and pack cleanup reservation name different workers', async () => {
    const f = await fixture();
    expect(f.base.stopWorker(f.worker.identity).status).toBe('ok');
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const result = await runWorkerRecovery({
      options: f.options,
      adapter: runtimeWithResolution(f.base, { kind: 'gone', workerId: 'foreign-terminal' }),
      claimNamespace: join(f.root, 'claims'),
      cleanupAuthority: f.authority,
    });
    expect(result).toMatchObject({
      outcome: 'skipped_ambiguous',
      reason: 'cleanup_ownership_authority_target_mismatch',
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects a stale expected assignment before recovery effects', async () => {
    const f = await fixture();
    const winner = await publishCurrentWorkerAssignment({
      file: f.file,
      repository: f.assignment.repository,
      issueNumber: f.assignment.issueNumber,
      taskId: f.assignment.taskId,
      kind: 'remote',
      provider: 'browser-gpt',
      bindingKey: 'remote-2',
      expectedCurrent: { assignmentId: f.assignment.assignmentId, generation: f.assignment.generation },
      role: 'worker',
    });
    if (!winner.ok) throw new Error(winner.reason);
    const adapter = runtimeWithResolution(f.base, { kind: 'gone', workerId: f.worker.identity.id });
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const spawn = vi.spyOn(f.base, 'spawnWorker');
    const result = await runWorkerRecovery({
      options: f.options,
      adapter,
      claimNamespace: join(f.root, 'claims'),
      cleanupAuthority: f.authority,
    });
    expect(result).toMatchObject({ outcome: 'assignment_stale', reason: 'assignment_stale' });
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('requires exact logical assignment binding CLI fields and has no successor-start selector', () => {
    expect(() => parseWorkerRecoveryArgs([
      '--cleanup-workspace', '/tmp/worktree',
      '--expected-head-sha', 'test-head',
      '--worker-id', 'w', '--worker-generation', 'g',
    ])).toThrow('--repository is required');
    expect(() => parseWorkerRecoveryArgs([
      '--repository', 'owner/repo', '--issue-number', '1', '--task-id', 'task',
      '--assignment-id', 'wa-1', '--assignment-generation', '1', '--provider', 'orca', '--binding-key', 'd-1',
      '--worker-id', 'w', '--worker-generation', 'g', '--cleanup-workspace', '/tmp/worktree', '--expected-head-sha', 'test-head',
      '--spawn-workspace', 'active',
    ])).toThrow('unknown argument: --spawn-workspace');
  });

  it('dry-run validates exact current assignment/cleanup authority but performs no runtime effect', async () => {
    const f = await fixture();
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const spawn = vi.spyOn(f.base, 'spawnWorker');
    const result = await runWorkerRecovery({
      options: { ...f.options, dryRun: true },
      adapter: runtimeWithResolution(f.base, { kind: 'resolved', worker: f.worker }),
      cleanupAuthority: f.authority,
    });
    expect(result).toMatchObject({
      outcome: 'dry_run', disposition: 'no_effect',
      assignmentId: f.assignment.assignmentId,
      assignmentGeneration: f.assignment.generation,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
