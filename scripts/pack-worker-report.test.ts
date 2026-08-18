// @vitest-ci-lane light
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from './kernel/subprocess.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath } from './lib/worker-assignment-store.ts';
import { readWorkerReportStoreFile } from '../docs/worker-report-store.mjs';
import {
  evaluatePackWorkerReport,
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

function linkDir(source: string, target: string): void {
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

function createPublicWrapperSandbox(root: string): { repoRoot: string; binDir: string } {
  const repoRoot = path.join(root, 'public-wrapper');
  const scriptsDir = path.join(repoRoot, 'scripts');
  const binDir = path.join(root, 'bin');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const sourceRoot = process.cwd();
  copyFileSync(path.join(sourceRoot, 'scripts', 'pack-worker-report'), path.join(scriptsDir, 'pack-worker-report'));
  copyFileSync(path.join(sourceRoot, 'scripts', 'pack-worker-report.ts'), path.join(scriptsDir, 'pack-worker-report.ts'));
  chmodSync(path.join(scriptsDir, 'pack-worker-report'), 0o755);
  linkDir(path.join(sourceRoot, 'scripts', 'kernel'), path.join(scriptsDir, 'kernel'));
  linkDir(path.join(sourceRoot, 'scripts', 'lib'), path.join(scriptsDir, 'lib'));
  linkDir(path.join(sourceRoot, 'scripts', 'pr2-foundation'), path.join(scriptsDir, 'pr2-foundation'));
  linkDir(path.join(sourceRoot, 'scripts', 'toolchain'), path.join(scriptsDir, 'toolchain'));
  linkDir(path.join(sourceRoot, 'docs'), path.join(repoRoot, 'docs'));

  writeFileSync(path.join(scriptsDir, 'worker-smoke-run.ts'), [
    "const ok = process.env.OPK_TEST_SMOKE_READY !== '0';",
    "process.stdout.write(`${JSON.stringify({ ok, reason: ok ? 'ready' : 'ci_pending' })}\\n`);",
    'process.exitCode = ok ? 0 : 1;',
    '',
  ].join('\n'), 'utf8');

  const ghPath = path.join(binDir, 'gh');
  writeFileSync(ghPath, [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "if (args[0] === 'pr') {",
    "  if (process.env.OPK_TEST_GH_MODE === 'malformed') process.stdout.write('{bad-json');",
    "  else process.stdout.write(`${JSON.stringify({ number: 1456, state: 'OPEN', headRefOid: process.env.OPK_TEST_HEAD_SHA, body: 'Closes #1416' })}\\n`);",
    "} else if (args[0] === 'issue') {",
    "  process.stdout.write(`${JSON.stringify({ body: '#1416 body' })}\\n`);",
    "} else {",
    "  process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
    '  process.exitCode = 1;',
    '}',
    '',
  ].join('\n'), 'utf8');
  chmodSync(ghPath, 0o755);
  return { repoRoot, binDir };
}

async function runPublicWrapper(input: {
  state: string;
  smokeReady?: boolean;
  assignmentId: string;
  assignmentGeneration: number;
  root: string;
  dryRun?: boolean;
  malformedGh?: boolean;
  storeAsDirectory?: boolean;
}) {
  const sandbox = createPublicWrapperSandbox(input.root);
  const storePath = path.join(input.root, 'public-worker-report-store.json');
  if (input.storeAsDirectory) mkdirSync(storePath);
  const cliArgs = [
    path.join(sandbox.repoRoot, 'scripts', 'pack-worker-report'),
    '--state', input.state,
    '--repository', 'chetwerikoff/orchestrator-pack',
    '--issue-number', '1416',
    '--task-id', 'task-1416',
    '--assignment-id', input.assignmentId,
    '--assignment-generation', String(input.assignmentGeneration),
    '--pr-number', '1456',
    '--head-sha', headSha,
    '--project-id', 'orchestrator-pack',
    '--repo-root', sandbox.repoRoot,
    ...(input.dryRun ? ['--dry-run'] : []),
  ];
  const result = await runProcess({
    command: 'bash',
    args: cliArgs,
    cwd: sandbox.repoRoot,
    inheritParentEnv: true,
    env: {
      OPK_BASE_DIR: input.root,
      OPK_WORKER_REPORT_STORE: storePath,
      OPK_TEST_HEAD_SHA: headSha,
      OPK_TEST_SMOKE_READY: input.smokeReady === false ? '0' : '1',
      OPK_TEST_GH_MODE: input.malformedGh ? 'malformed' : 'normal',
      PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  const lines = result.stdout.trim().split(/\r?\n/u);
  expect(lines).toHaveLength(1);
  return {
    result,
    output: JSON.parse(lines[0]!) as Record<string, unknown>,
    storePath,
    storeExists: existsSync(storePath) && !input.storeAsDirectory,
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

  it.each([
    ['accepted ready', { state:'ready_for_review', smokeReady:true }, 0, 'recorded', true, true, true],
    ['ordinary not-ready', { state:'ready_for_review', smokeReady:false }, 0, 'continue_work', false, false, false],
    ['unresolved binding', { state:'ready_for_review', generationDelta:1 }, 0, 'continue_work', false, false, false],
    ['dry-run ready', { state:'ready_for_review', smokeReady:true, dryRun:true }, 0, 'dry_run', true, false, false],
    ['dry-run not-ready', { state:'ready_for_review', smokeReady:false, dryRun:true }, 0, 'continue_work', false, false, false],
    ['malformed child output', { state:'working', malformedGh:true }, 2, 'command_error', false, false, false],
    ['store-write failure', { state:'working', storeAsDirectory:true }, 2, 'command_error', false, false, false],
    ['non-ready state', { state:'fixing_ci' }, 0, 'recorded', true, true, true],
  ] as const)(
    'public wrapper subprocess matrix: %s',
    async (_name, scenario, exitCode, disposition, accepted, recordWritten, storeDelta) => {
      const f = await fixture();
      const run = await runPublicWrapper({
        root: f.root,
        state: scenario.state,
        assignmentId: f.assignment.assignmentId,
        assignmentGeneration: f.assignment.generation + ('generationDelta' in scenario ? scenario.generationDelta : 0),
        smokeReady: 'smokeReady' in scenario ? scenario.smokeReady : true,
        dryRun: 'dryRun' in scenario ? scenario.dryRun : false,
        malformedGh: 'malformedGh' in scenario ? scenario.malformedGh : false,
        storeAsDirectory: 'storeAsDirectory' in scenario ? scenario.storeAsDirectory : false,
      });
      expect(run.result.exitCode).toBe(exitCode);
      expect(run.output).toMatchObject({ disposition, accepted, recordWritten });
      expect(run.storeExists).toBe(storeDelta);
    },
  );

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
