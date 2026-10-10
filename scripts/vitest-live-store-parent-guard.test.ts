import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WAKE_SUPERVISOR_PROJECT_ID } from './pr2-foundation/wake-supervisor-state-constants.mjs';

import { repoRoot } from './lib/vitest-live-store-harness.mjs';
import {
  isExternalJournalSnapshotOnlyChange,
  isExternalWakeSupervisorSnapshotOnlyChange,
  startParentLiveStoreGuard,
} from './lib/vitest-live-store-parent-guard.mjs';
import { runProcess, runProcessSync } from './kernel/subprocess.ts';

const temporaryRoots: string[] = [];
const temporaryFiles: string[] = [];

function cleanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'OPK_VITEST_HARNESS',
    'OPK_VITEST_HARNESS_ROOT',
    'OPK_VITEST_HARNESS_INVENTORY',
    'OPK_VITEST_REENTRY_HARNESS_ROOT',
    'NODE_OPTIONS',
  ]) delete env[name];
  return env;
}

function productionEnvironment(root: string): NodeJS.ProcessEnv {
  const env = cleanEnvironment();
  const home = join(root, 'home');
  const temporary = join(root, 'tmp');
  const wake = join(root, 'wake-supervisor');
  const packBase = join(root, 'pack-state');
  for (const path of [home, temporary, wake, packBase]) mkdirSync(path, { recursive: true });
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    XDG_STATE_HOME: join(home, '.local', 'state'),
    OPK_VITEST_PRODUCTION_HOME: home,
    OPK_VITEST_PRODUCTION_TMP: temporary,
    OPK_VITEST_PRODUCTION_WAKE_ROOT: wake,
    OPK_VITEST_PRODUCTION_OPK_BASE: packBase,
    OPK_WAKE_SUPERVISOR_STATE_DIR: wake,
    ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: wake,
    OPK_SIDE_PROCESS_STATE_DIR: wake,
    OPK_BASE_DIR: packBase,
  });
  return env;
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for child readiness file: ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function waitForWatchDelivery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function runHarnessedVitest(testPath: string, env: NodeJS.ProcessEnv): Promise<{
  exitCode: number | null;
  stderr: string;
  stdout: string;
}> {
  return runProcess({
    command: process.execPath,
    args: [
      join(repoRoot, 'scripts', 'run-vitest-with-harness.mjs'),
      'run',
      '--maxWorkers=1',
      testPath,
    ],
    cwd: repoRoot,
    env,
    inheritParentEnv: false,
  }).then((result) => ({ exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout }));
}


const RUNTIME_SELECTORS = ['OPK_PROJECT_ID', 'GH_REPO', 'ORCA_TERMINAL_HANDLE'] as const;

function setSyntheticParentSelectors(env: NodeJS.ProcessEnv, seeded: boolean): void {
  if (seeded) {
    Object.assign(env, {
      OPK_PROJECT_ID: 'orchestrator-pack',
      GH_REPO: 'chetwerikoff/orchestrator-pack',
      ORCA_TERMINAL_HANDLE: 'synthetic-terminal',
    });
  } else {
    for (const name of RUNTIME_SELECTORS) delete env[name];
  }
}

function makeStartupRecorder(root: string): {
  entryFile: string;
  nodeOptions: string;
  originalImport: string;
  recorder: string;
} {
  const id = basename(root);
  const originalImport = join(repoRoot, 'scripts', '.opk-parent-guard-original-' + id + '.mjs');
  const recorder = join(repoRoot, 'scripts', '.opk-parent-guard-entry-' + id + '.mjs');
  const entryFile = join(root, 'vitest-entry.json');
  temporaryFiles.push(originalImport, recorder);
  writeFileSync(originalImport, '// synthetic inherited Node preload\n', 'utf8');
  writeFileSync(recorder, [
    "import { writeFileSync } from 'node:fs';",
    "const entry = String(process.argv[1] ?? '').replaceAll(String.fromCharCode(92), '/');",
    "if (entry.endsWith('/node_modules/vitest/vitest.mjs')) {",
    "  const names = ['OPK_PROJECT_ID', 'GH_REPO', 'ORCA_TERMINAL_HANDLE'];",
    "  const selectors = Object.fromEntries(names.map((name) => [name, { present: Object.hasOwn(process.env, name), value: process.env[name] ?? null }]));",
    "  writeFileSync(" + JSON.stringify(entryFile) + ", JSON.stringify({ entry, selectors, harnessRoot: process.env.OPK_VITEST_HARNESS_ROOT ?? null, harnessEnabled: process.env.OPK_VITEST_HARNESS ?? null, productionWakeRoot: process.env.OPK_VITEST_PRODUCTION_WAKE_ROOT ?? null, leaseRoot: process.env.OPK_TESTMODE_LEASE_ROOT ?? null, reentryRoot: process.env.OPK_VITEST_REENTRY_HARNESS_ROOT ?? null, nodeOptions: process.env.NODE_OPTIONS ?? '', ci: process.env.CI ?? null, xdgConfigHome: process.env.XDG_CONFIG_HOME ?? null }) + '\\n');",
    '}',
    '',
  ].join('\n'), 'utf8');
  return {
    entryFile,
    originalImport,
    recorder,
    nodeOptions: ['--import=' + pathToFileURL(originalImport).href, '--import=' + pathToFileURL(recorder).href].join(' '),
  };
}

function assertPreSetupVitestEntry(
  recorder: ReturnType<typeof makeStartupRecorder>,
  parentEnv: NodeJS.ProcessEnv,
): {
  entry: string;
  selectors: Record<string, { present: boolean; value: string | null }>;
  harnessRoot: string;
  reentryRoot: string | null;
  ci: string | null;
  xdgConfigHome: string | null;
} {
  // Missing/wrong-process output is fatal; only the actual vitest.mjs entry writes this file.
  expect(existsSync(recorder.entryFile), 'Vitest startup recorder did not run').toBe(true);
  const snapshot = JSON.parse(readFileSync(recorder.entryFile, 'utf8'));
  expect(snapshot.entry).toMatch(/\/node_modules\/vitest\/vitest\.mjs$/);
  for (const name of RUNTIME_SELECTORS) {
    expect(snapshot.selectors[name], name + ' was inherited at Vitest entry').toEqual({
      present: false,
      value: null,
    });
  }
  expect(snapshot.harnessEnabled).toBe('1');
  expect(typeof snapshot.harnessRoot).toBe('string');
  expect(snapshot.harnessRoot.length).toBeGreaterThan(0);
  expect(snapshot.leaseRoot).toBe(join(snapshot.harnessRoot, 'state', 'testmode-fleet-leases'));
  expect(snapshot.productionWakeRoot).toBe(parentEnv.OPK_VITEST_PRODUCTION_WAKE_ROOT);
  expect(snapshot.nodeOptions).toContain(pathToFileURL(recorder.originalImport).href);
  expect(snapshot.nodeOptions).toContain(pathToFileURL(recorder.recorder).href);
  expect(snapshot.nodeOptions).toContain('vitest-live-store-preload.mjs');
  return snapshot;
}

function makeOfflineProjectCard(configHome: string, primaryRoot: string, repository: string): string {
  mkdirSync(primaryRoot, { recursive: true });
  const init = runProcessSync({ command: 'git', args: ['init', '--quiet', primaryRoot] });
  expect(init.exitCode, init.stderr).toBe(0);
  const origin = runProcessSync({ command: 'git', args: ['-C', primaryRoot, 'remote', 'add', 'origin', 'https://github.com/' + repository + '.git'] });
  expect(origin.exitCode, origin.stderr).toBe(0);
  const cardPath = join(configHome, 'orchestrator-pack', 'projects', 'fixture-project.json');
  mkdirSync(join(configHome, 'orchestrator-pack', 'projects'), { recursive: true });
  writeFileSync(cardPath, JSON.stringify({
    projectId: 'fixture-project',
    repository,
    primaryRoot,
    defaultBranch: 'main',
    orcaWorkspacePattern: '.*',
    orchestratorTitlePattern: '.*',
    browserGpt: { projectUrl: 'https://example.test/project' },
  }), 'utf8');
  return cardPath;
}

function makeTransientEnvironmentProbe(
  root: string,
  parentConfigHome: string,
  childConfigHome: string,
  childCardPath: string,
  sentinelCardPath: string,
): { fixture: string; testFile: string } {
  const testFile = join(root, 'vitest-test-observation.json');
  const fixture = join(repoRoot, 'scripts', '.opk-parent-guard-env-' + basename(root) + '.test.ts');
  temporaryFiles.push(fixture);
  writeFileSync(fixture, [
    "import { expect, it, vi } from 'vitest';",
    "import { existsSync, rmSync, writeFileSync } from 'node:fs';",
    "import { launchingTerminalHandle } from './chatgpt-browser-turn/chat-bindings.ts';",
    "import { resolveTargetContext } from './lib/target-context.ts';",
    "it('sees no inherited selectors before test-local opt-in', () => {",
    "  const names = ['OPK_PROJECT_ID', 'GH_REPO', 'ORCA_TERMINAL_HANDLE'];",
    "  const selectors = Object.fromEntries(names.map((name) => [name, { present: Object.hasOwn(process.env, name), value: process.env[name] ?? null }]));",
    "  for (const name of names) expect(selectors[name]).toEqual({ present: false, value: null });",
    "  expect(launchingTerminalHandle(process.env)).toBeUndefined();",
    "  expect(process.env.OPK_VITEST_HARNESS).toBe('1');",
    "  expect(process.env.OPK_TESTMODE_LEASE_ROOT).toContain('testmode-fleet-leases');",
    "  expect(process.env.NODE_OPTIONS).toContain('vitest-live-store-preload.mjs');",
    "  writeFileSync(" + JSON.stringify(testFile) + ", JSON.stringify({ selectors, terminal: launchingTerminalHandle(process.env) ?? null, harnessRoot: process.env.OPK_VITEST_HARNESS_ROOT ?? null, leaseRoot: process.env.OPK_TESTMODE_LEASE_ROOT ?? null }));",
    "  expect(process.env.XDG_CONFIG_HOME).toBe(" + JSON.stringify(parentConfigHome) + ");",
    "  expect(existsSync(" + JSON.stringify(sentinelCardPath) + ")).toBe(true);",
    "  expect(launchingTerminalHandle({ ORCA_TERMINAL_HANDLE: 'synthetic-terminal' })).toBe('synthetic-terminal');",
    "  try {",
    "    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'synthetic-test-local-terminal');",
    "    expect(launchingTerminalHandle(process.env)).toBe('synthetic-test-local-terminal');",
    "    vi.stubEnv('XDG_CONFIG_HOME', " + JSON.stringify(childConfigHome) + ");",
    "    vi.stubEnv('OPK_PROJECT_ID', 'fixture-project');",
    "    vi.stubEnv('GH_REPO', 'example-co/selected');",
    "    const resolved = resolveTargetContext();",
    "    expect(resolved.cardPath).toBe(" + JSON.stringify(childCardPath) + ");",
    "    expect(resolved.repository).toBe('example-co/selected');",
    "    rmSync(" + JSON.stringify(childCardPath) + ");",
    "    let missingError: unknown;",
    "    try { resolveTargetContext(); } catch (error) { missingError = error; }",
    "    expect(missingError).toMatchObject({ code: 'card-missing' });",
    "  } finally { vi.unstubAllEnvs(); }",
    "  expect(launchingTerminalHandle(process.env)).toBeUndefined();",
    "});",
    '',
  ].join('\n'), 'utf8');
  return { fixture, testFile };
}

function writeAtomicJournal(wakeRoot: string): void {
  const journal = join(wakeRoot, 'worker-message-dispatch-journal.json');
  const temporary = join(wakeRoot, `.${'a'.repeat(32)}.tmp`);
  writeFileSync(`${journal}.lock`, 'lock\n', 'utf8');
  writeFileSync(temporary, 'tick\n', 'utf8');
  renameSync(temporary, journal);
  rmSync(`${journal}.lock`, { force: true });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const file of temporaryFiles.splice(0)) rmSync(file, { force: true });
});

describe('parent live-store guard', () => {
  it('settles a journal-only snapshot even when the watcher misses the event', () => {
    expect(isExternalJournalSnapshotOnlyChange(['worker-message-dispatch-journal.json'])).toBe(true);
    expect(isExternalJournalSnapshotOnlyChange([
      'worker-message-dispatch-journal.json',
      'unrelated-live-store-leak.json',
    ])).toBe(false);
  });

  it('settles only exact known external wake-supervisor snapshot paths', () => {
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      'typescript-supervisor-status.json',
    ])).toBe(true);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      'worker-message-dispatch-journal.json',
      'typescript-supervisor-status.json',
    ])).toBe(true);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      'unrelated-live-store-leak.json',
    ])).toBe(false);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      'typescript-supervisor-status.json',
      'unrelated-live-store-leak.json',
    ])).toBe(false);
  });

  it('ignores an atomic external supervisor-status update around a passing harness child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-supervisor-status-'));
    temporaryRoots.push(root);
    const fixture = join(repoRoot, 'scripts', '.opk-parent-guard-supervisor-status-child.test.ts');
    temporaryFiles.push(fixture);
    const readyFile = join(root, 'child-live-store-guard-ready');
    writeFileSync(
      fixture,
      [
        "import { expect, it } from 'vitest';",
        "import { writeFileSync } from 'node:fs';",
        "it('passes', async () => {",
        `  writeFileSync(${JSON.stringify(readyFile)}, 'ready\\n');`,
        '  await new Promise((resolve) => setTimeout(resolve, 400));',
        '  expect(true).toBe(true);',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    const childEnvironment = productionEnvironment(join(root, 'child-production'));
    const childPromise = runHarnessedVitest(fixture, childEnvironment);
    await waitForFile(readyFile);
    const wakeRoot = childEnvironment.OPK_VITEST_PRODUCTION_WAKE_ROOT!;
    const status = join(wakeRoot, 'typescript-supervisor-status.json');
    const temporary = join(
      wakeRoot,
      '.typescript-supervisor-status.json.1234.00000000-0000-4000-8000-000000000000.tmp',
    );
    writeFileSync(temporary, '{"restartState":"running"}\n', 'utf8');
    renameSync(temporary, status);
    const child = await childPromise;

    expect(child.exitCode, child.stderr).toBe(0);
  });

  it('settles exact wake-state paths and only newly created allowed ancestors', () => {
    const projectId = DEFAULT_WAKE_SUPERVISOR_PROJECT_ID;
    const allowedPaths = [
      'supervisor/typescript-supervisor-status.json',
      'supervisor/projected-registry.json',
      'orchestration-mail-reconcile.json',
      'orchestration-mail-reconcile.lock',
      `${projectId}/orchestration-mail-reconcile.json`,
      `${projectId}/orchestration-mail-reconcile.lock`,
      `${projectId}/supervisor/typescript-supervisor-status.json`,
      `${projectId}/supervisor/projected-registry.json`,
      `${projectId}/fleet-observer-snapshot.json`,
      `${projectId}/.tmp-1234-1700000000000-deadbeef`,
      `${projectId}/supervisor/.typescript-supervisor-status.json.1234.00000000-0000-4000-8000-000000000000.tmp`,
      `${projectId}/scheduler-tick-phases.jsonl`,
    ];
    expect(isExternalWakeSupervisorSnapshotOnlyChange(allowedPaths)).toBe(true);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      '.typescript-supervisor-status.json.1234.00000000-0000-4000-8000-000000000000.tmp',
    ])).toBe(true);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      `${projectId}/supervisor/supervisor/.typescript-supervisor-status.json.1234.00000000-0000-4000-8000-000000000000.tmp`,
    ])).toBe(false);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      `${projectId}/nested/scheduler-tick-phases.jsonl`,
    ])).toBe(false);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      `${projectId}/scheduler-tick-phases.jsonl.tmp`,
    ])).toBe(false);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      'scheduler-tick-phases.jsonl',
    ])).toBe(false);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      `${projectId}/unrelated-live-store-leak.json`,
    ])).toBe(false);
    const beforeCreated = new Map<string, string>();
    const afterCreated = new Map([
      [`${projectId}`, 'directory'],
      [`${projectId}/supervisor`, 'directory'],
      ...allowedPaths.map((path) => [path, 'file'] as [string, string]),
    ]);
    expect(isExternalWakeSupervisorSnapshotOnlyChange(
      [...allowedPaths, projectId, `${projectId}/supervisor`],
      '',
      beforeCreated,
      afterCreated,
    )).toBe(true);
    const beforeDeleted = new Map([[`${projectId}/supervisor`, 'directory']]);
    expect(isExternalWakeSupervisorSnapshotOnlyChange(
      [`${projectId}/supervisor`, `${projectId}/supervisor/typescript-supervisor-status.json`],
      '',
      beforeDeleted,
      new Map(),
    )).toBe(false);
  });

  it('allows existing cadence paths under a newly created non-selected project after watcher delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-foreign-cadence-'));
    temporaryRoots.push(root);
    const env = productionEnvironment(join(root, 'production'));
    env.OPK_PROJECT_ID = 'selected-project';
    const foreignProjectRoot = join(env.OPK_VITEST_PRODUCTION_WAKE_ROOT!, 'foreign-project');
    const foreignSupervisorRoot = join(foreignProjectRoot, 'supervisor');
    const guard = startParentLiveStoreGuard(env);
    mkdirSync(foreignSupervisorRoot, { recursive: true });
    const status = join(foreignSupervisorRoot, 'typescript-supervisor-status.json');
    const temporary = join(
      foreignSupervisorRoot,
      '.typescript-supervisor-status.json.1234.00000000-0000-4000-8000-000000000000.tmp',
    );
    writeFileSync(temporary, '{"restartState":"running"}\n', 'utf8');
    renameSync(temporary, status);
    writeFileSync(join(foreignProjectRoot, 'worker-report-store.json'), '{}\n', 'utf8');
    writeFileSync(join(foreignProjectRoot, 'worker-report-store.lock'), 'lock', 'utf8');
    writeFileSync(join(foreignProjectRoot, 'worker-report-store.json.tmp'), '{}\n', 'utf8');
    writeFileSync(join(foreignProjectRoot, 'orchestration-mail-reconcile.json'), '{}\n', 'utf8');
    writeFileSync(join(foreignProjectRoot, 'orchestration-mail-reconcile.lock'), 'lock', 'utf8');
    writeFileSync(join(foreignProjectRoot, 'fleet-observer-snapshot.json'), '{}\n', 'utf8');
    writeFileSync(join(foreignProjectRoot, '.tmp-1234-5678-abcdef12'), 'temporary', 'utf8');
    writeFileSync(join(foreignProjectRoot, 'scheduler-tick-phases.jsonl'), '{"phase":"scheduler-tick"}\n', 'utf8');
    writeFileSync(join(foreignSupervisorRoot, 'projected-registry.json'), '{}\n', 'utf8');
    writeFileSync(
      join(foreignSupervisorRoot, '.projected-registry.json.1234.00000000-0000-4000-8000-000000000000.tmp'),
      '{}\n',
      'utf8',
    );
    await waitForWatchDelivery();

    expect(() => guard.stop()).not.toThrow();
  });

  it('still rejects a doubled supervisor sidecar path in a non-selected project', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-foreign-nested-sidecar-'));
    temporaryRoots.push(root);
    const env = productionEnvironment(join(root, 'production'));
    env.OPK_PROJECT_ID = 'selected-project';
    const nestedSupervisorRoot = join(
      env.OPK_VITEST_PRODUCTION_WAKE_ROOT!,
      'foreign-project',
      'supervisor',
      'supervisor',
    );
    mkdirSync(nestedSupervisorRoot, { recursive: true });
    const guard = startParentLiveStoreGuard(env);
    writeFileSync(
      join(nestedSupervisorRoot, '.typescript-supervisor-status.json.1234.00000000-0000-4000-8000-000000000000.tmp'),
      'unsupported',
      'utf8',
    );

    expect(() => guard.stop()).toThrow(/OPK_VITEST_LIVE_STORE_GUARD_FAILED/);
  });

  it('rejects deletion of a pre-existing foreign supervisor subtree', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-foreign-delete-'));
    temporaryRoots.push(root);
    const env = productionEnvironment(join(root, 'production'));
    env.OPK_PROJECT_ID = 'selected-project';
    const foreignSupervisorRoot = join(env.OPK_VITEST_PRODUCTION_WAKE_ROOT!, 'foreign-project', 'supervisor');
    mkdirSync(foreignSupervisorRoot, { recursive: true });
    writeFileSync(join(foreignSupervisorRoot, 'typescript-supervisor-status.json'), '{"state":"before"}', 'utf8');
    const guard = startParentLiveStoreGuard(env);
    rmSync(foreignSupervisorRoot, { recursive: true });

    expect(() => guard.stop()).toThrow(/OPK_VITEST_LIVE_STORE_GUARD_FAILED/);
  });

  it('rejects nested and temporary scheduler phase log variants in a non-selected project', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-foreign-scheduler-log-'));
    temporaryRoots.push(root);
    const env = productionEnvironment(join(root, 'production'));
    env.OPK_PROJECT_ID = 'selected-project';
    const foreignProjectRoot = join(env.OPK_VITEST_PRODUCTION_WAKE_ROOT!, 'foreign-project');
    mkdirSync(foreignProjectRoot, { recursive: true });
    const guard = startParentLiveStoreGuard(env);
    mkdirSync(join(foreignProjectRoot, 'nested'), { recursive: true });
    writeFileSync(join(foreignProjectRoot, 'nested', 'scheduler-tick-phases.jsonl'), '{"phase":"unsupported"}\n', 'utf8');
    writeFileSync(join(foreignProjectRoot, 'scheduler-tick-phases.jsonl.tmp'), '{"phase":"unsupported"}\n', 'utf8');

    expect(() => guard.stop()).toThrow(/OPK_VITEST_LIVE_STORE_GUARD_FAILED/);
  });

  it('still rejects non-cadence writes under a new non-selected project after watcher delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-foreign-leak-'));
    temporaryRoots.push(root);
    const env = productionEnvironment(join(root, 'production'));
    env.OPK_PROJECT_ID = 'selected-project';
    const foreignRoot = join(env.OPK_VITEST_PRODUCTION_WAKE_ROOT!, 'foreign-project');
    const guard = startParentLiveStoreGuard(env);
    mkdirSync(foreignRoot, { recursive: true });
    writeFileSync(join(foreignRoot, 'unrelated-live-store-leak.json'), 'leak\n', 'utf8');
    await waitForWatchDelivery();

    expect(() => guard.stop()).toThrow(/OPK_VITEST_LIVE_STORE_GUARD_FAILED/);
  });


  it('settles an external selected-project worker report-store transaction', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-worker-report-'));
    temporaryRoots.push(root);
    const projectId = 'orchestrator-pack';
    const changedPaths = [
      `${projectId}/worker-report-store.json`,
      `${projectId}/worker-report-store.lock`,
      `${projectId}/worker-report-store.json.tmp`,
    ];
    expect(isExternalWakeSupervisorSnapshotOnlyChange(changedPaths, projectId)).toBe(true);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      'another-project/worker-report-store.json',
    ], projectId)).toBe(true);
    expect(isExternalWakeSupervisorSnapshotOnlyChange([
      `${projectId}/unrelated-live-store-leak.json`,
    ], projectId)).toBe(false);

    const env = productionEnvironment(join(root, 'production'));
    env.OPK_PROJECT_ID = projectId;
    const wakeRoot = env.OPK_VITEST_PRODUCTION_WAKE_ROOT!;
    const projectRoot = join(wakeRoot, projectId);
    const reportStore = join(projectRoot, 'worker-report-store.json');
    const reportLock = join(projectRoot, 'worker-report-store.lock');
    const reportTemp = `${reportStore}.tmp`;
    const guard = startParentLiveStoreGuard(env);
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(reportLock, 'lock', 'utf8');
    writeFileSync(reportStore, '{"generation":1}', 'utf8');
    writeFileSync(reportTemp, '{"generation":2}', 'utf8');
    renameSync(reportTemp, reportStore);
    rmSync(reportLock, { force: true });

    expect(() => guard.stop()).not.toThrow();
  });

  it('ignores a live supervisor tick under supervisor/ around a passing harness child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-supervisor-layout-'));
    temporaryRoots.push(root);
    const fixture = join(repoRoot, 'scripts', '.opk-parent-guard-supervisor-layout-child.test.ts');
    temporaryFiles.push(fixture);
    const readyFile = join(root, 'child-live-store-guard-ready');
    writeFileSync(
      fixture,
      [
        "import { expect, it } from 'vitest';",
        "import { writeFileSync } from 'node:fs';",
        "it('passes', async () => {",
        `  writeFileSync(${JSON.stringify(readyFile)}, 'ready\\n');`,
        '  await new Promise((resolve) => setTimeout(resolve, 400));',
        '  expect(true).toBe(true);',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    const childEnvironment = productionEnvironment(join(root, 'child-production'));
    const projectId = DEFAULT_WAKE_SUPERVISOR_PROJECT_ID;
    delete childEnvironment.OPK_PROJECT_ID;
    const wakeRoot = childEnvironment.OPK_VITEST_PRODUCTION_WAKE_ROOT!;
    const projectStateDir = join(wakeRoot, projectId);
    const supervisorDir = join(projectStateDir, 'supervisor');
    mkdirSync(supervisorDir, { recursive: true });
    mkdirSync(projectStateDir, { recursive: true });
    const durableWrite = (target: string, name: string, content: string): void => {
      const temporary = join(supervisorDir, `.${name}.1234.00000000-0000-4000-8000-000000000000.tmp`);
      writeFileSync(temporary, content, 'utf8');
      renameSync(temporary, target);
    };
    const status = join(supervisorDir, 'typescript-supervisor-status.json');
    const projected = join(supervisorDir, 'projected-registry.json');
    const reconcile = join(projectStateDir, 'orchestration-mail-reconcile.json');
    const reconcileLock = join(projectStateDir, 'orchestration-mail-reconcile.lock');
    const fleetSnapshot = join(projectStateDir, 'fleet-observer-snapshot.json');
    writeFileSync(status, '{"restartState":"waiting-restart"}\n', 'utf8');
    writeFileSync(projected, '{"children":[]}\n', 'utf8');
    writeFileSync(reconcile, '{"messages":{}}\n', 'utf8');
    writeFileSync(reconcileLock, '1\n', 'utf8');
    writeFileSync(fleetSnapshot, '{"snapshot":"before"}\n', 'utf8');

    const childPromise = runHarnessedVitest(fixture, childEnvironment);
    await waitForFile(readyFile);
    durableWrite(status, 'typescript-supervisor-status.json', '{"restartState":"running"}\n');
    durableWrite(projected, 'projected-registry.json', '{"children":[{"id":"pr2-scheduler"}]}\n');
    writeFileSync(reconcileLock, '2\n', 'utf8');
    writeFileSync(reconcile, '{"messages":{"msg":1}}\n', 'utf8');
    const fleetTemporary = join(projectStateDir, '.tmp-1234-1700000000000-deadbeef');
    writeFileSync(fleetTemporary, '{"snapshot":"after"}\n', 'utf8');
    renameSync(fleetTemporary, fleetSnapshot);
    const child = await childPromise;

    expect(child.exitCode, child.stderr).toBe(0);
  });

  it('ignores an observed external wake-store tick around a passing harness child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-regression-'));
    temporaryRoots.push(root);
    const fixture = join(repoRoot, 'scripts', '.opk-parent-guard-passing-child.test.ts');
    temporaryFiles.push(fixture);
    writeFileSync(
      fixture,
      "import { expect, it } from 'vitest'; it('passes', async () => { await new Promise((resolve) => setTimeout(resolve, 400)); expect(true).toBe(true); });\n",
      'utf8',
    );
    const childEnvironment = productionEnvironment(join(root, 'child-production'));
    const childPromise = runHarnessedVitest(fixture, childEnvironment);
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(join(childEnvironment.OPK_VITEST_PRODUCTION_WAKE_ROOT!, 'worker-message-dispatch-journal.json'), 'tick\n');
    const child = await childPromise;

    expect(child.exitCode, child.stderr).toBe(0);
  });

  it('ignores the observed atomic external journal transaction around a passing child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-atomic-journal-'));
    temporaryRoots.push(root);
    const fixture = join(repoRoot, 'scripts', '.opk-parent-guard-atomic-journal-child.test.ts');
    temporaryFiles.push(fixture);
    const readyFile = join(root, 'child-live-store-guard-ready');
    writeFileSync(
      fixture,
      [
        "import { expect, it } from 'vitest';",
        "import { writeFileSync } from 'node:fs';",
        "it('passes', async () => {",
        `  writeFileSync(${JSON.stringify(readyFile)}, 'ready\\n');`,
        '  await new Promise((resolve) => setTimeout(resolve, 400));',
        '  expect(true).toBe(true);',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    const childEnvironment = productionEnvironment(join(root, 'child-production'));
    const childPromise = runHarnessedVitest(fixture, childEnvironment);
    await waitForFile(readyFile);
    writeAtomicJournal(childEnvironment.OPK_VITEST_PRODUCTION_WAKE_ROOT!);
    const child = await childPromise;

    expect(child.exitCode, child.stderr).toBe(0);
  });

  it('retains a live-store mutation outside the journal transaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-journal-and-leak-'));
    temporaryRoots.push(root);
    const fixture = join(repoRoot, 'scripts', '.opk-parent-guard-journal-and-leak-child.test.ts');
    temporaryFiles.push(fixture);
    writeFileSync(
      fixture,
      "import { expect, it } from 'vitest'; it('passes', async () => { await new Promise((resolve) => setTimeout(resolve, 150)); expect(true).toBe(true); });\n",
      'utf8',
    );
    const childEnvironment = productionEnvironment(join(root, 'child-production'));
    const childPromise = runHarnessedVitest(fixture, childEnvironment);
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeAtomicJournal(childEnvironment.OPK_VITEST_PRODUCTION_WAKE_ROOT!);
    writeFileSync(
      join(childEnvironment.OPK_VITEST_PRODUCTION_WAKE_ROOT!, 'unrelated-live-store-leak.json'),
      'leak\n',
      'utf8',
    );
    const child = await childPromise;

    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain('OPK_VITEST_LIVE_STORE_GUARD_FAILED');
    expect(child.stderr).toContain('unrelated-live-store-leak.json');
  });


  it('removes inherited selectors at Vitest entry, before globalSetup, without erasing synthetic opt-ins', async () => {
    for (const seeded of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-entry-isolation-'));
      temporaryRoots.push(root);
      const environment = productionEnvironment(join(root, 'production'));
      setSyntheticParentSelectors(environment, seeded);
      const parentConfigHome = join(root, 'poisoned-parent-config');
      const childConfigHome = join(root, 'child-owned-config');
      const sentinel = makeOfflineProjectCard(parentConfigHome, join(root, 'sentinel-repo'), 'example-co/sentinel');
      const card = makeOfflineProjectCard(childConfigHome, join(root, 'child-repo'), 'example-co/selected');
      environment.XDG_CONFIG_HOME = parentConfigHome;
      const recorder = makeStartupRecorder(root);
      environment.NODE_OPTIONS = recorder.nodeOptions;
      const probe = makeTransientEnvironmentProbe(root, parentConfigHome, childConfigHome, card, sentinel);
      const parentSelectors = Object.fromEntries(RUNTIME_SELECTORS.map((name) => [name, environment[name]]));
      const invokingSelectors = Object.fromEntries(RUNTIME_SELECTORS.map((name) => [name, process.env[name]]));
      const child = await runHarnessedVitest(probe.fixture, environment);
      expect(child.exitCode, child.stdout + '\n' + child.stderr).toBe(0);
      const entry = assertPreSetupVitestEntry(recorder, environment);
      expect(entry.xdgConfigHome).toBe(parentConfigHome);
      expect(entry.reentryRoot).toBeNull();
      const inTest = JSON.parse(readFileSync(probe.testFile, 'utf8'));
      expect(inTest.selectors).toEqual(entry.selectors);
      expect(inTest.terminal).toBeNull();
      expect(inTest.harnessRoot).toBe(entry.harnessRoot);
      expect(inTest.leaseRoot).toBe(join(entry.harnessRoot, 'state', 'testmode-fleet-leases'));
      for (const name of RUNTIME_SELECTORS) {
        expect(environment[name]).toBe(parentSelectors[name]);
        expect(process.env[name]).toBe(invokingSelectors[name]);
      }
      expect(environment.NODE_OPTIONS).toBe(recorder.nodeOptions);
    }
  }, 120_000);

  it('is also clean before globalSetup on the real Vitest CI contract launcher', async () => {
    for (const seeded of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-ci-entry-'));
      temporaryRoots.push(root);
      const environment = productionEnvironment(join(root, 'production'));
      setSyntheticParentSelectors(environment, seeded);
      const recorder = makeStartupRecorder(root);
      environment.NODE_OPTIONS = recorder.nodeOptions;
      const parentSelectors = Object.fromEntries(RUNTIME_SELECTORS.map((name) => [name, environment[name]]));
      const child = await runProcess({
        command: process.execPath,
        args: ['--experimental-strip-types', join(repoRoot, 'scripts', 'vitest-ci-runner.ts'), 'contract'],
        cwd: repoRoot,
        env: environment,
        inheritParentEnv: false,
        timeoutMs: 110_000,
      });
      expect(child.exitCode, child.stdout + '\n' + child.stderr).toBe(0);
      expect(child.stdout).toContain('[PASS] Vitest contract lane files=3');
      const entry = assertPreSetupVitestEntry(recorder, environment);
      expect(entry.reentryRoot).toBe(entry.harnessRoot);
      expect(entry.ci).toBe('true');
      for (const name of RUNTIME_SELECTORS) expect(environment[name]).toBe(parentSelectors[name]);
      expect(environment.NODE_OPTIONS).toBe(recorder.nodeOptions);
    }
  }, 240_000);

  it('retains a child-originated live-store mutation when the watcher observes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-leak-'));
    temporaryRoots.push(root);
    const fixture = join(repoRoot, 'scripts', '.opk-parent-guard-leak-child.test.ts');
    temporaryFiles.push(fixture);
    writeFileSync(
      fixture,
      [
        "import { expect, it } from 'vitest';",
        "import { runProcess } from './kernel/subprocess.ts';",
        "it('passes its own assertion while leaking a production write', async () => {",
        "  const env = { ...process.env };",
        "  for (const name of ['OPK_VITEST_HARNESS', 'OPK_VITEST_HARNESS_ROOT', 'OPK_VITEST_HARNESS_INVENTORY', 'NODE_OPTIONS']) delete env[name];",
        "  const result = await runProcess({ command: process.execPath, args: ['--input-type=module', '-e', \"import('node:fs').then(({ writeFileSync }) => writeFileSync(process.env.LEAK_PATH, 'leak\\\\n'))\"], env: { ...env, LEAK_PATH: process.env.LEAK_PATH }, inheritParentEnv: false });",
        "  expect(result.exitCode).toBe(0);",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    const childEnvironment = productionEnvironment(join(root, 'child-production'));
    setSyntheticParentSelectors(childEnvironment, true);
    const selectedParentValues = Object.fromEntries(RUNTIME_SELECTORS.map((name) => [name, childEnvironment[name]]));
    const originalWakeRoot = childEnvironment.OPK_VITEST_PRODUCTION_WAKE_ROOT;
    childEnvironment.LEAK_PATH = join(
      childEnvironment.OPK_VITEST_PRODUCTION_WAKE_ROOT!,
      'unclassified-child-leak.json',
    );
    const child = await runHarnessedVitest(fixture, childEnvironment);

    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain('OPK_VITEST_LIVE_STORE_GUARD_FAILED');
    for (const name of RUNTIME_SELECTORS) expect(childEnvironment[name]).toBe(selectedParentValues[name]);
    expect(childEnvironment.OPK_VITEST_PRODUCTION_WAKE_ROOT).toBe(originalWakeRoot);
    expect(childEnvironment.OPK_VITEST_HARNESS).toBeUndefined();
    expect(childEnvironment.OPK_VITEST_REENTRY_HARNESS_ROOT).toBeUndefined();
  });

});
