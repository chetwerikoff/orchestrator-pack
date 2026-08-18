// @vitest-ci-lane light
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from './kernel/subprocess.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath } from './lib/worker-assignment-store.ts';
import { readWorkerReportStoreFile } from '../docs/worker-report-store.mjs';
import {
  evaluatePackWorkerReport,
  resolvePackWorkerReportRequest,
  type ReportDeps,
  type ReportRequest,
} from './pack-worker-report.ts';

const roots: string[] = [];
const headSha = '0123456789abcdef0123456789abcdef01234567';

async function fixture(kind: 'local'|'remote' = 'remote') {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-report-1416-'));
  roots.push(root);
  process.env.OPK_BASE_DIR = root;
  const assignmentFile = resolveWorkerAssignmentStorePath('orchestrator-pack', process.env);
  const published = await publishCurrentWorkerAssignment({
    file: assignmentFile,
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1416,
    taskId: 'task-1416',
    kind,
    provider: kind === 'remote' ? 'browser-gpt' : 'orca',
    bindingKey: kind === 'remote' ? 'remote-1' : 'dispatch-1',
  });
  if (!published.ok) throw new Error(published.reason);
  const reportStorePath = path.join(root, 'worker-report-store.json');
  const request: ReportRequest = {
    state: 'ready_for_review',
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1416,
    taskId: 'task-1416',
    assignmentId: published.assignment.assignmentId,
    assignmentGeneration: published.assignment.generation,
    prNumber: 1456,
    headSha,
    deliveryRunId: '',
    projectId: 'orchestrator-pack',
    repoRoot: process.cwd(),
    dryRun: false,
  };
  return { root, assignment: published.assignment, reportStorePath, request };
}

function runFixture(input: { ready?: boolean; malformedPr?: boolean; prHead?: string; calls?: string[] } = {}): NonNullable<ReportDeps['run']> {
  return async (command, args) => {
    input.calls?.push(`${command} ${args.join(' ')}`);
    if (command === 'gh' && args[0] === 'pr') {
      if (input.malformedPr) return { ok: true, stdout: '{bad-json' };
      return { ok: true, stdout: JSON.stringify({ number: 1456, state: 'OPEN', headRefOid: input.prHead ?? headSha, body: 'Closes #1416' }) };
    }
    if (command === 'gh' && args[0] === 'issue') {
      return { ok: true, stdout: JSON.stringify({ body: '#1416 body' }) };
    }
    if (command === process.execPath) {
      return { ok: true, stdout: JSON.stringify({ ok: input.ready !== false, reason: input.ready === false ? 'ci_pending' : 'ready' }) };
    }
    return { ok: false, stdout: '', stderr: 'unexpected child' };
  };
}

function autoBindingRun(input: { prHead?: string; body?: string; repo?: string } = {}): NonNullable<ReportDeps['run']> {
  return async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      return { ok: true, stdout: `${headSha}\n` };
    }
    if (command === 'gh' && args[0] === 'repo') {
      return { ok: true, stdout: JSON.stringify({ nameWithOwner: input.repo ?? 'chetwerikoff/orchestrator-pack' }) };
    }
    if (command === 'gh' && args[0] === 'pr') {
      return { ok: true, stdout: JSON.stringify({ number: 1456, state: 'OPEN', headRefOid: input.prHead ?? headSha, body: input.body ?? 'Closes #1416' }) };
    }
    return { ok: false, stdout: '', stderr: 'unexpected child' };
  };
}

afterEach(() => {
  delete process.env.OPK_BASE_DIR;
  delete process.env.OPK_WORKER_REPORT_STORE;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack-worker-report Node hard cut', () => {
  it('records accepted ready only after exact binding and ready gate', async () => {
    const f = await fixture();
    const result = await evaluatePackWorkerReport(f.request, { run: runFixture({ ready: true }), reportStorePath: f.reportStorePath, now: () => 1000 });
    expect(result).toMatchObject({ disposition: 'recorded', accepted: true, recordWritten: true, requestedState: 'ready_for_review' });
    const store = readWorkerReportStoreFile(f.reportStorePath) as { sourceRecords?: Record<string, unknown> };
    expect(Object.keys(store.sourceRecords ?? {})).toHaveLength(1);
    expect(JSON.stringify(store.sourceRecords)).toContain(f.assignment.assignmentId);
  });

  it('resolves the documented state-only public command from exact repo, PR/head, Issue, and current assignment facts', async () => {
    const f = await fixture('local');
    const resolved = await resolvePackWorkerReportRequest(['--state', 'fixing_ci'], process.env, { run: autoBindingRun() });
    expect(resolved).toEqual({
      kind: 'ok',
      value: {
        state: 'fixing_ci',
        repository: 'chetwerikoff/orchestrator-pack',
        issueNumber: 1416,
        taskId: 'task-1416',
        assignmentId: f.assignment.assignmentId,
        assignmentGeneration: f.assignment.generation,
        prNumber: 1456,
        headSha,
        deliveryRunId: '',
        projectId: 'orchestrator-pack',
        repoRoot: process.cwd(),
        dryRun: false,
      },
    });
    if (resolved.kind !== 'ok') return;
    const result = await evaluatePackWorkerReport(resolved.value, { run: runFixture(), reportStorePath: f.reportStorePath });
    expect(result).toMatchObject({ disposition: 'recorded', accepted: true, recordWritten: true, requestedState: 'fixing_ci' });
  });

  it('keeps state-only binding failures as continue_work with zero store delta', async () => {
    const f = await fixture();
    const resolved = await resolvePackWorkerReportRequest(['--state', 'fixing_ci'], process.env, { run: autoBindingRun({ prHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) });
    expect(resolved).toEqual({ kind: 'continue_work', reason: 'pr_head_mismatch' });
    expect(existsSync(f.reportStorePath)).toBe(false);
  });

  it('returns continue_work with zero store delta when ready evidence is incomplete', async () => {
    const f = await fixture();
    const result = await evaluatePackWorkerReport(f.request, { run: runFixture({ ready: false }), reportStorePath: f.reportStorePath });
    expect(result).toMatchObject({ disposition: 'continue_work', accepted: false, recordWritten: false });
    expect(result.reason).toContain('worker_smoke_gate_not_ready');
    expect(existsSync(f.reportStorePath)).toBe(false);
  });

  it('runs the ready gate during dry-run and reports admissibility without writing', async () => {
    const f = await fixture();
    const accepted = await evaluatePackWorkerReport({ ...f.request, dryRun: true }, { run: runFixture({ ready: true }), reportStorePath: f.reportStorePath });
    expect(accepted).toMatchObject({ disposition: 'dry_run', accepted: true, recordWritten: false, dryRun: true });
    expect(existsSync(f.reportStorePath)).toBe(false);

    const denied = await evaluatePackWorkerReport({ ...f.request, dryRun: true }, { run: runFixture({ ready: false }), reportStorePath: f.reportStorePath });
    expect(denied).toMatchObject({ disposition: 'continue_work', accepted: false, recordWritten: false });
    expect(existsSync(f.reportStorePath)).toBe(false);
  });

  it('treats stale assignment and PR head mismatch as explicit non-acceptance', async () => {
    const f = await fixture();
    const stale = await evaluatePackWorkerReport({ ...f.request, assignmentGeneration: f.request.assignmentGeneration + 1 }, { run: runFixture(), reportStorePath: f.reportStorePath });
    expect(stale).toEqual({ disposition: 'continue_work', accepted: false, recordWritten: false, requestedState: 'ready_for_review', reason: 'assignment_stale' });
    const head = await evaluatePackWorkerReport(f.request, { run: runFixture({ prHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), reportStorePath: f.reportStorePath });
    expect(head).toEqual({ disposition: 'continue_work', accepted: false, recordWritten: false, requestedState: 'ready_for_review', reason: 'pr_head_mismatch' });
    expect(existsSync(f.reportStorePath)).toBe(false);
  });

  it('classifies malformed child JSON and store-write failures as command_error', async () => {
    const f = await fixture();
    const malformed = await evaluatePackWorkerReport(f.request, { run: runFixture({ malformedPr: true }), reportStorePath: f.reportStorePath });
    expect(malformed).toMatchObject({ disposition: 'command_error', accepted: false, recordWritten: false, reason: 'github_child_json_malformed' });

    const badStore = path.join(f.root, 'store-as-directory');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(badStore);
    const failed = await evaluatePackWorkerReport({ ...f.request, state: 'working' }, { run: runFixture(), reportStorePath: badStore });
    expect(failed).toMatchObject({ disposition: 'command_error', accepted: false, recordWritten: false });
  });

  it('preserves non-ready admission without invoking the ready-only smoke gate', async () => {
    const f = await fixture();
    const calls: string[] = [];
    const result = await evaluatePackWorkerReport({ ...f.request, state: 'fixing_ci' }, { run: runFixture({ calls }), reportStorePath: f.reportStorePath });
    expect(result).toMatchObject({ disposition: 'recorded', accepted: true, recordWritten: true, requestedState: 'fixing_ci' });
    expect(calls.some((call) => call.startsWith(process.execPath))).toBe(false);
  });

  it('keeps addressing_reviews correlated to an exact delivery run', async () => {
    const f = await fixture();
    const missing = await evaluatePackWorkerReport({ ...f.request, state: 'addressing_reviews' }, { run: runFixture(), reportStorePath: f.reportStorePath });
    expect(missing).toEqual({ disposition: 'continue_work', accepted: false, recordWritten: false, requestedState: 'addressing_reviews', reason: 'delivery_run_unresolved' });
    const accepted = await evaluatePackWorkerReport({ ...f.request, state: 'addressing_reviews', deliveryRunId: 'run-1' }, { run: runFixture(), reportStorePath: f.reportStorePath });
    expect(accepted).toMatchObject({ disposition: 'recorded', accepted: true, recordWritten: true });
  });

  it('public wrapper emits exactly one command_error JSON object for malformed usage', async () => {
    const result = await runProcess({
      command: 'bash',
      args: ['scripts/pack-worker-report'],
      cwd: process.cwd(),
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 15_000,
    });
    expect(result.exitCode).toBe(2);
    const lines = result.stdout.trim().split(/\r?\n/u);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ disposition: 'command_error', accepted: false, recordWritten: false });
  });
});
