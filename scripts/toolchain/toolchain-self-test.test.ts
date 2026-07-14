import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { checkNodeMajor } from '#opk-toolchain/check-node-major';
import {
  compareRawChildProcessBaseline,
  discoverRawChildProcessCalls,
  makeRawChildProcessBaseline,
  type RawChildProcessBaseline,
} from '#opk-toolchain/child-process-policy';
import { lintTypeScriptFoundation } from '#opk-toolchain/check-ts-policy';
import {
  comparePowerShellBootBaseline,
  discoverPowerShellBootTests,
  makePowerShellBootBaseline,
  type PowerShellBootBaseline,
} from '#opk-toolchain/powershell-child-policy';

const temporaryRoots = new Set<string>();

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-toolchain-'));
  temporaryRoots.add(root);
  return root;
}

function write(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe('TypeScript foundation check self-tests', () => {
  it('turns the Node-major check red on a representative mismatch', () => {
    expect(checkNodeMajor('22\n', '22.16.0')).toMatchObject({ ok: true, expected: 22, actual: 22 });
    expect(checkNodeMajor('22\n', '20.19.0')).toMatchObject({ ok: false, expected: 22, actual: 20 });
  });

  it('turns typechecking red on a representative type error', () => {
    const root = temporaryRoot();
    const sourcePath = join(root, 'type-error.ts');
    writeFileSync(sourcePath, 'const count: number = "wrong";\n');
    const program = ts.createProgram({
      rootNames: [sourcePath],
      options: { strict: true, noEmit: true, skipLibCheck: true },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.some((diagnostic) => diagnostic.code === 2322)).toBe(true);
  });

  it('turns lint red for floating and misused promises', () => {
    const root = temporaryRoot();
    write(root, 'tsconfig.json', JSON.stringify({
      include: ['scripts/kernel/**/*.ts'],
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }));
    write(root, 'scripts/kernel/example.ts', `
      async function work(): Promise<void> {}
      work();
      [1].forEach(async () => { await work(); });
    `);
    write(root, 'scripts/toolchain/raw-child-process-baseline.json', JSON.stringify({ version: 1, entries: [] }));
    const violations = lintTypeScriptFoundation(root);
    expect(violations.map((violation) => violation.rule)).toContain('floating-promise');
    expect(violations.map((violation) => violation.rule)).toContain('misused-promise');
  });

  it('rejects a new raw child-process call and cannot silently grow an exception', () => {
    const root = temporaryRoot();
    write(root, 'scripts/existing.ts', `import { spawn } from 'node:child_process';\nspawn('git', ['status']);\n`);
    const first = discoverRawChildProcessCalls(root, () => false);
    const baseline = makeRawChildProcessBaseline(first);
    expect(compareRawChildProcessBaseline(first, baseline)).toEqual({ added: [], stale: [] });

    write(root, 'scripts/existing.ts', `
      import { spawn } from 'node:child_process';
      spawn('git', ['status']);
      spawn('git', ['diff']);
    `);
    const comparison = compareRawChildProcessBaseline(
      discoverRawChildProcessCalls(root, () => false),
      baseline,
    );
    expect(comparison.added).toHaveLength(1);
    expect(comparison.stale).toEqual([]);
  });

  it('rejects inline require raw child-process calls', () => {
    const root = temporaryRoot();
    write(root, 'scripts/inline-require.ts', `
      require('node:child_process').spawn('git', ['status']);
    `);
    const comparison = compareRawChildProcessBaseline(
      discoverRawChildProcessCalls(root, () => false),
      { version: 1, entries: [] },
    );
    expect(comparison.added).toMatchObject([
      { path: 'scripts/inline-require.ts', api: 'spawn' },
    ]);
  });

  it('rejects dynamic import raw child-process calls for namespace and destructured bindings', () => {
    const root = temporaryRoot();
    write(root, 'scripts/dynamic-import.ts', `
      async function run(): Promise<void> {
        const cp = await import('node:child_process');
        cp.spawn('git', ['status']);
        const { spawnSync } = await import('node:child_process');
        spawnSync('git', ['diff']);
      }
      void run();
    `);
    const comparison = compareRawChildProcessBaseline(
      discoverRawChildProcessCalls(root, () => false),
      { version: 1, entries: [] },
    );
    expect(comparison.added).toMatchObject([
      { path: 'scripts/dynamic-import.ts', api: 'spawn' },
      { path: 'scripts/dynamic-import.ts', api: 'spawnSync' },
    ]);
  });

  it('rejects default-import raw child-process calls', () => {
    const root = temporaryRoot();
    write(root, 'scripts/default-import.ts', `
      import cp from 'node:child_process';
      cp.spawn('git', ['status']);
    `);
    const comparison = compareRawChildProcessBaseline(
      discoverRawChildProcessCalls(root, () => false),
      { version: 1, entries: [] },
    );
    expect(comparison.added).toMatchObject([
      { path: 'scripts/default-import.ts', api: 'spawn' },
    ]);
  });

  it('turns the PowerShell growth guard red for direct and shared-helper additions', () => {
    const root = temporaryRoot();
    const empty: PowerShellBootBaseline = { version: 1, entries: [] };
    write(root, 'scripts/direct.test.ts', `
      import { spawnSync } from 'node:child_process';
      const testShell = 'pwsh';
      spawnSync(testShell, ['-NoProfile']);
    `);
    write(root, 'scripts/helper.test.ts', `
      import { runPwsh } from './_test-pwsh-helpers.js';
      runPwsh('Write-Output ok');
    `);
    const discovered = discoverPowerShellBootTests(root);
    const comparison = comparePowerShellBootBaseline(discovered, empty);
    expect(comparison.added.map((entry) => entry.path)).toEqual([
      'scripts/direct.test.ts',
      'scripts/helper.test.ts',
    ]);
  });

  it('turns the PowerShell growth guard red for inline require additions', () => {
    const root = temporaryRoot();
    const empty: PowerShellBootBaseline = { version: 1, entries: [] };
    write(root, 'scripts/inline-require.test.ts', `
      require('node:child_process').spawnSync('pwsh', ['-NoProfile']);
    `);
    const comparison = comparePowerShellBootBaseline(discoverPowerShellBootTests(root), empty);
    expect(comparison.added).toMatchObject([
      { path: 'scripts/inline-require.test.ts', mechanisms: ['direct:spawnSync'] },
    ]);
  });

  it('turns the PowerShell growth guard red for dynamic import additions', () => {
    const root = temporaryRoot();
    const empty: PowerShellBootBaseline = { version: 1, entries: [] };
    write(root, 'scripts/dynamic-import.test.ts', `
      async function run(): Promise<void> {
        const cp = await import('node:child_process');
        cp.spawnSync('pwsh', ['-NoProfile']);
        const { spawn } = await import('node:child_process');
        spawn('pwsh', ['-NoProfile']);
      }
      void run();
    `);
    const comparison = comparePowerShellBootBaseline(discoverPowerShellBootTests(root), empty);
    expect(comparison.added).toMatchObject([
      { path: 'scripts/dynamic-import.test.ts', mechanisms: ['direct:spawn', 'direct:spawnSync'] },
    ]);
  });

  it('turns the PowerShell growth guard red for default imports', () => {
    const root = temporaryRoot();
    const empty: PowerShellBootBaseline = { version: 1, entries: [] };
    write(root, 'scripts/default-import.test.ts', `
      import cp from 'node:child_process';
      cp.spawnSync('pwsh', ['-NoProfile']);
    `);
    const comparison = comparePowerShellBootBaseline(discoverPowerShellBootTests(root), empty);
    expect(comparison.added).toMatchObject([
      { path: 'scripts/default-import.test.ts', mechanisms: ['direct:spawnSync'] },
    ]);
  });

  it('requires stale PowerShell baseline entries to be removed instead of becoming free slots', () => {
    const root = temporaryRoot();
    write(root, 'scripts/direct.test.ts', `
      import { spawnSync } from 'node:child_process';
      spawnSync('pwsh', ['-NoProfile']);
    `);
    const initial = discoverPowerShellBootTests(root);
    const baseline = makePowerShellBootBaseline(initial);
    rmSync(join(root, 'scripts/direct.test.ts'));
    const comparison = comparePowerShellBootBaseline(discoverPowerShellBootTests(root), baseline);
    expect(comparison.added).toEqual([]);
    expect(comparison.stale.map((entry) => entry.path)).toEqual(['scripts/direct.test.ts']);
  });

  it('keeps the committed baselines machine-readable and justified', () => {
    const repoRoot = resolve(import.meta.dirname, '../..');
    const raw = JSON.parse(
      readFileSync(join(repoRoot, 'scripts/toolchain/raw-child-process-baseline.json'), 'utf8'),
    ) as RawChildProcessBaseline;
    const pwsh = JSON.parse(
      readFileSync(join(repoRoot, 'scripts/toolchain/powershell-child-tests.json'), 'utf8'),
    ) as PowerShellBootBaseline;
    expect(raw.entries.length).toBeGreaterThan(0);
    expect(raw.entries.every((entry) => entry.justification.length > 20)).toBe(true);
    expect(pwsh.entries.length).toBeGreaterThan(0);
    expect(pwsh.entries.every((entry) => entry.justification.length > 20)).toBe(true);
  });
});
