// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath } from './lib/worker-assignment-store.ts';
import { readWorkerReportStoreFile } from '../docs/worker-report-store.mjs';
import {
  evaluatePackWorkerReport,
  type ReportDeps,
  type ReportRequest,
} from './pack-worker-report.ts';

const roots: string[] = [];
const headSha = '0123456789abcdef0123456789abcdef01234567';

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-report-1418-'));
  roots.push(root);
  process.env.OPK_BASE_DIR = root;
  const assignmentFile = resolveWorkerAssignmentStorePath('orchestrator-pack', process.env);
  const published = await publishCurrentWorkerAssignment({
    file: assignmentFile,
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1418,
    taskId: 'task-1418',
    kind: 'remote',
    provider: 'browser-gpt',
    bindingKey: 'remote-1418',
  });
  if (!published.ok) throw new Error(published.reason);
  const reportStorePath = path.join(root, 'worker-report-store.json');
  const request: ReportRequest = {
    state: 'ready_for_review',
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1418,
    taskId: 'task-1418',
    assignmentId: published.assignment.assignmentId,
    assignmentGeneration: published.assignment.generation,
    prNumber: 1481,
    headSha,
    deliveryRunId: '',
    projectId: 'orchestrator-pack',
    repoRoot: process.cwd(),
    dryRun: false,
  };
  return { root, assignment: published.assignment, reportStorePath, request };
}

function runFixture(input: { malformedPr?: boolean; prHead?: string; calls?: string[] } = {}): NonNullable<ReportDeps['run']> {
  return async (command, args) => {
    input.calls?.push(`${command} ${args.join(' ')}`);
    if (command === 'gh' && args[0] === 'pr') {
      if (input.malformedPr) return { ok: true, stdout: '{bad-json' };
      return {
        ok: true,
        stdout: JSON.stringify({ number: 1481, state: 'OPEN', headRefOid: input.prHead ?? headSha, body: 'Closes #1418' }),
      };
    }
    return { ok: false, stdout: '', stderr: 'unexpected child' };
  };
}

afterEach(() => {
  delete process.env.OPK_BASE_DIR;
  delete process.env.OPK_WORKER_REPORT_STORE;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack-worker-report review/smoke stage boundary', () => {
  it('records ready_for_review after exact assignment and PR binding without invoking smoke', async () => {
    const f = await fixture();
    const calls: string[] = [];
    const result = await evaluatePackWorkerReport(f.request, {
      run: runFixture({ calls }),
      reportStorePath: f.reportStorePath,
      now: () => 1_000,
    });
    expect(result).toMatchObject({
      disposition: 'recorded', accepted: true, recordWritten: true, requestedState: 'ready_for_review',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('gh pr view');
    expect(calls.some((call) => call.includes('worker-smoke-run'))).toBe(false);
    expect(calls.some((call) => call.startsWith(process.execPath))).toBe(false);
    const store = readWorkerReportStoreFile(f.reportStorePath) as { sourceRecords?: Record<string, unknown> };
    expect(Object.keys(store.sourceRecords ?? {})).toHaveLength(1);
    expect(JSON.stringify(store.sourceRecords)).toContain(f.assignment.assignmentId);
  });

  it('keeps dry-run ready_for_review smoke-free and side-effect free', async () => {
    const f = await fixture();
    const calls: string[] = [];
    const result = await evaluatePackWorkerReport({ ...f.request, dryRun: true }, {
      run: runFixture({ calls }),
      reportStorePath: f.reportStorePath,
    });
    expect(result).toMatchObject({ disposition: 'dry_run', accepted: true, recordWritten: false, dryRun: true });
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.includes('worker-smoke-run'))).toBe(false);
    expect(existsSync(f.reportStorePath)).toBe(false);
  });

  it('treats stale assignment and PR-head drift as non-acceptance with zero store delta', async () => {
    const f = await fixture();
    const stale = await evaluatePackWorkerReport(
      { ...f.request, assignmentGeneration: f.request.assignmentGeneration + 1 },
      { run: runFixture(), reportStorePath: f.reportStorePath },
    );
    expect(stale).toEqual({
      disposition: 'continue_work', accepted: false, recordWritten: false,
      requestedState: 'ready_for_review', reason: 'assignment_stale',
    });
    const drift = await evaluatePackWorkerReport(f.request, {
      run: runFixture({ prHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      reportStorePath: f.reportStorePath,
    });
    expect(drift).toEqual({
      disposition: 'continue_work', accepted: false, recordWritten: false,
      requestedState: 'ready_for_review', reason: 'pr_head_mismatch',
    });
    expect(existsSync(f.reportStorePath)).toBe(false);
  });

  it('classifies malformed GitHub JSON and store-write failure as command_error', async () => {
    const f = await fixture();
    const malformed = await evaluatePackWorkerReport(f.request, {
      run: runFixture({ malformedPr: true }), reportStorePath: f.reportStorePath,
    });
    expect(malformed).toMatchObject({
      disposition: 'command_error', accepted: false, recordWritten: false, reason: 'github_child_json_malformed',
    });

    const badStore = path.join(f.root, 'store-as-directory');
    mkdirSync(badStore);
    const failed = await evaluatePackWorkerReport(
      { ...f.request, state: 'working' },
      { run: runFixture(), reportStorePath: badStore },
    );
    expect(failed).toMatchObject({ disposition: 'command_error', accepted: false, recordWritten: false });
  });

  it('keeps addressing_reviews correlated to a durable delivery run', async () => {
    const f = await fixture();
    const missing = await evaluatePackWorkerReport(
      { ...f.request, state: 'addressing_reviews' },
      { run: runFixture(), reportStorePath: f.reportStorePath },
    );
    expect(missing).toEqual({
      disposition: 'continue_work', accepted: false, recordWritten: false,
      requestedState: 'addressing_reviews', reason: 'delivery_run_unresolved',
    });
    const accepted = await evaluatePackWorkerReport(
      { ...f.request, state: 'addressing_reviews', deliveryRunId: 'run-1418' },
      { run: runFixture(), reportStorePath: f.reportStorePath },
    );
    expect(accepted).toMatchObject({ disposition: 'recorded', accepted: true, recordWritten: true });
  });
});
