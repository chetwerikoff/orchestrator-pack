import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIsolatedInterposerPack } from './_test-interposer-pack-fixture.js';
import { withAoSpawnProbeStub } from './_test-autonomous-ao-stub-fixture.js';
import { repoRoot } from './_test-pwsh-helpers.js';
import {
  assertStubPackDocsImportClosure,
  STUB_PACK_FIXTURE_SITES,
} from './_test-stub-pack-import-closure.js';

describe('stub-pack docs import-closure guard (#508)', () => {
  it('passes on createIsolatedInterposerPack effective pack', () => {
    const pack = createIsolatedInterposerPack();
    try {
      expect(pack.packRoot).toBeTruthy();
    } finally {
      pack.cleanup();
    }
  });

  it('passes on withAoSpawnProbeStub composed effective pack', () => {
    withAoSpawnProbeStub(() => {
      // Guard runs during fixture assembly before this callback.
    });
  });

  it('fails with (fixture site, module, missingDep) for synthetic missing sibling import', () => {
    const packRoot = mkdtempSync(path.join(tmpdir(), 'opk-stub-pack-closure-'));
    const docsDir = path.join(packRoot, 'docs');
    mkdirSync(docsDir, { recursive: true });
    const moduleName = 'closure-probe-entry.mjs';
    const source = path.join(repoRoot, 'docs', 'review-mechanical-cli.mjs');
    const target = path.join(docsDir, moduleName);
    cpSync(source, target);
    const original = readFileSync(target, 'utf8');
    writeFileSync(target, `import './synthetic-missing.mjs';\n${original}`);

    try {
      expect(() =>
        assertStubPackDocsImportClosure('synthetic-missing-sibling', packRoot),
      ).toThrowError(
        /stub-pack docs import-closure failed \(synthetic-missing-sibling, closure-probe-entry\.mjs, synthetic-missing\.mjs\)/,
      );
    } finally {
      rmSync(packRoot, { recursive: true, force: true });
    }
  });

  it('times out cleanly for a non-import-safe module without hanging the vitest worker', () => {
    const packRoot = mkdtempSync(path.join(tmpdir(), 'opk-stub-pack-closure-'));
    const docsDir = path.join(packRoot, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      path.join(docsDir, 'stdin-hang-probe.mjs'),
      'while (true) {}\n',
    );

    try {
      expect(() =>
        assertStubPackDocsImportClosure('stdin-hang-probe', packRoot, { timeoutMs: 500 }),
      ).toThrow(/stub-pack docs import-closure timed out \(stdin-hang-probe\)/);
    } finally {
      rmSync(packRoot, { recursive: true, force: true });
    }
  });

  it('uses distinct fixture site labels for both entrypoints', () => {
    expect(STUB_PACK_FIXTURE_SITES.isolatedInterposer).toBe('createIsolatedInterposerPack');
    expect(STUB_PACK_FIXTURE_SITES.aoSpawnProbeStub).toBe('withAoSpawnProbeStub');
  });
});
