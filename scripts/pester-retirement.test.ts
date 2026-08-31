// @vitest-ci-lane heavy
// @vitest-pre-topology-seconds 30

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from './kernel/subprocess.ts';

const ROOT = process.cwd();

async function run(command: string, args: readonly string[]) {
  return runProcess({
    command,
    args,
    cwd: ROOT,
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 30_000,
  });
}
function output(result: Awaited<ReturnType<typeof run>>): string {
  return `${result.stdout}\n${result.stderr}`;
}

describe('terminal PowerShell/Pester retirement coverage', () => {
  it('keeps the CI-red watchdog behavior on the Node authority', async () => {
    const result = await run(process.execPath, [path.join(ROOT, 'scripts/lib/ci-red-watchdog-selftest.mjs')]);
    expect(result.ok, output(result)).toBe(true);
    expect(output(result)).toMatch(/\[PASS\] CI-red watchdog self-test \([0-9]+ cases\)/u);
  });

  it('runs self-architect fixtures through the TypeScript entrypoint', async () => {
    const duplicate = await run(process.execPath, [
      '--experimental-strip-types', 'scripts/lint-self-architect.ts',
      '-FixtureRoot', 'tests/fixtures/lint-self-architect/duplicate-literal', '-Strict',
    ]);
    expect(duplicate.ok).toBe(false);
    expect(output(duplicate)).toMatch(/duplicate-literal/u);

    const negative = await run(process.execPath, [
      '--experimental-strip-types', 'scripts/lint-self-architect.ts',
      '-FixtureRoot', 'tests/fixtures/lint-self-architect/negative', '-Strict',
    ]);
    expect(negative.ok, output(negative)).toBe(true);
  });

  it('proves the tracked shell estate is empty and retirement guard stays live', async () => {
    const tracked = await run('git', ['ls-files']);
    expect(tracked.ok, output(tracked)).toBe(true);
    const shellFiles = tracked.stdout.split(/\r?\n/u).filter((file) => /\.(?:ps1|psm1|psd1)$/iu.test(file));
    expect(shellFiles).toEqual([]);

    const retirement = await run(process.execPath, [
      '--experimental-strip-types', 'scripts/runtime-retirement/retired-surface-selftest.ts',
    ]);
    expect(retirement.ok, output(retirement)).toBe(true);

    const workflow = readFileSync(path.join(ROOT, '.github/workflows/scope-guard.yml'), 'utf8');
    expect(workflow).not.toMatch(/^\s*test-pester:\s*$/mu);
    expect(workflow).not.toContain('install-pester-ci');
  });
});
