import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildChangedPathManifest,
  resolveVitestPrScopeSelection,
} from './vitest-pr-scoped-selection.mjs';

const roots: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-vitest-pr-scope-'));
  roots.push(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@test.local']);
  git(root, ['config', 'user.name', 'orchestrator-pack-fixture']);
  return root;
}

function commitAll(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('changed-path manifest deletion handling', () => {
  it('keeps a deletion-heavy exported manifest below the 60000-byte cap', () => {
    const root = createRepo();
    const longSegments = [
      'segment-a-'.padEnd(104, 'a'),
      'segment-b-'.padEnd(104, 'b'),
      'segment-c-'.padEnd(104, 'c'),
      'segment-d-'.padEnd(104, 'd'),
    ];

    for (let index = 0; index < 110; index += 1) {
      write(
        root,
        join('docs', 'declarations', ...longSegments, `entry-${String(index).padStart(3, '0')}.json`),
        '{}\n',
      );
    }
    const base = commitAll(root, 'base');

    rmSync(join(root, 'docs'), { recursive: true, force: true });
    const head = commitAll(root, 'delete declarations');

    const full = buildChangedPathManifest(root, base, head, {
      includeDeleted: true,
      maxBytes: 60_000,
    });
    expect(full.diffOk).toBe(false);
    expect(full.failureReason).toBe('changed-path-export-oversized');

    const exported = buildChangedPathManifest(root, base, head);
    expect(exported.diffOk).toBe(true);
    expect(exported.entries).toEqual([]);
    expect(exported.entryCount).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(exported), 'utf8')).toBeLessThanOrEqual(60_000);
  });

  it('selects a heavy test that imports a deleted module', () => {
    const root = createRepo();
    write(root, 'scripts/lib/deleted-module.mjs', 'export const value = 42;\n');
    write(
      root,
      'scripts/deleted-module.test.ts',
      "import { value } from './lib/deleted-module.mjs';\nexport const observed = value;\n",
    );
    const base = commitAll(root, 'base');

    unlinkSync(join(root, 'scripts/lib/deleted-module.mjs'));
    const head = commitAll(root, 'delete module');

    const full = buildChangedPathManifest(root, base, head, {
      includeDeleted: true,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(full.diffOk).toBe(true);
    expect(full.entries).toMatchObject([
      { status: 'D', path: 'scripts/lib/deleted-module.mjs' },
    ]);

    const selected = resolveVitestPrScopeSelection({
      repoRoot: root,
      changedPathManifest: full,
      discoveredTests: ['scripts/deleted-module.test.ts'],
      heavyFiles: ['scripts/deleted-module.test.ts'],
      prScopeMode: 'enforce',
    });

    expect(selected.wouldRunMode).toBe('scoped');
    expect(selected.effectiveRunMode).toBe('scoped');
    expect(selected.selectedHeavyFiles).toEqual(['scripts/deleted-module.test.ts']);
  });
});
