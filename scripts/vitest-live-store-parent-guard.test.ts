import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    watch: () => ({ close() {} }),
  };
});

import { repoRoot } from './lib/vitest-live-store-harness.mjs';
import { startParentLiveStoreGuard } from './lib/vitest-live-store-parent-guard.mjs';
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

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const file of temporaryFiles.splice(0)) rmSync(file, { force: true });
});

describe('parent live-store guard', () => {
  it('ignores an unobserved external wake-store snapshot change around a passing harness child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-parent-guard-regression-'));
    temporaryRoots.push(root);
    const productionEnv = productionEnvironment(root);
    const fixture = join(repoRoot, 'scripts', '.opk-parent-guard-passing-child.test.ts');
    temporaryFiles.push(fixture);
    writeFileSync(
      fixture,
      "import { expect, it } from 'vitest'; it('passes', () => expect(true).toBe(true));\n",
      'utf8',
    );
    const guard = startParentLiveStoreGuard(productionEnv);

    try {
      const childPromise = runHarnessedVitest(
        fixture,
        productionEnvironment(join(root, 'child-production')),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      writeFileSync(join(productionEnv.OPK_VITEST_PRODUCTION_WAKE_ROOT!, 'external-tick.json'), 'tick\n');
      const child = await childPromise;

      expect(child.exitCode, child.stderr).toBe(0);
      expect(() => guard.stop()).not.toThrow();
    } finally {
      try { guard.stop(); } catch {}
    }
  });
});
