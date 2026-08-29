import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { repoRoot } from './lib/vitest-live-store-harness.mjs';
import { isExternalJournalSnapshotOnlyChange } from './lib/vitest-live-store-parent-guard.mjs';
import { runProcess } from './kernel/subprocess.ts';

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

function runHarnessedVitest(testPath: string, env: NodeJS.ProcessEnv): Promise<{
  exitCode: number | null;
  stderr: string;
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
  }).then((result) => ({ exitCode: result.exitCode, stderr: result.stderr }));
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
    writeFileSync(
      fixture,
      "import { expect, it } from 'vitest'; it('passes', async () => { await new Promise((resolve) => setTimeout(resolve, 400)); expect(true).toBe(true); });\n",
      'utf8',
    );
    const childEnvironment = productionEnvironment(join(root, 'child-production'));
    const childPromise = runHarnessedVitest(fixture, childEnvironment);
    await new Promise((resolve) => setTimeout(resolve, 50));
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
  });

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
    childEnvironment.LEAK_PATH = join(
      childEnvironment.OPK_VITEST_PRODUCTION_WAKE_ROOT!,
      'unclassified-child-leak.json',
    );
    const child = await runHarnessedVitest(fixture, childEnvironment);

    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain('OPK_VITEST_LIVE_STORE_GUARD_FAILED');
  });

});
