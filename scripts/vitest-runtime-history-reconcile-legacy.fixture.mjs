#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from './kernel/subprocess.ts';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, 'scripts', 'refresh-vitest-runtime-history.mjs');
const testPath = 'scripts/legacy-runtime-history.test.ts';
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function history({ weight = null, provenance = 'fallback', samples = null, changedAt = null, dataChangedAt }) {
  return {
    issue: 556,
    source: 'ci-measured',
    dataChangedAt,
    smoothingRule: 'median-of-last-5-samples',
    files: weight == null ? {} : { [testPath]: weight },
    provenance: { [testPath]: provenance },
    recentSamples: samples == null ? {} : { [testPath]: samples },
    fileChangedAt: changedAt == null ? {} : { [testPath]: changedAt },
  };
}

function runReconcile({ remote, proposed, trusted = true, extraProposedPath = null }) {
  const root = join(tmpdir(), `vhr-legacy-reconcile-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fakeScripts = join(root, 'scripts');
  const fakePlugins = join(root, 'plugins');
  mkdirSync(fakeScripts, { recursive: true });
  mkdirSync(fakePlugins, { recursive: true });
  writeFileSync(join(fakeScripts, 'legacy-runtime-history.test.ts'), 'export {};\n', 'utf8');

  if (extraProposedPath) {
    proposed.provenance[extraProposedPath] = 'fallback';
  }

  const remotePath = join(root, 'remote.json');
  const proposedPath = join(root, 'proposed.json');
  const outputPath = join(root, 'output.json');
  writeFileSync(remotePath, `${JSON.stringify(remote, null, 2)}\n`, 'utf8');
  writeFileSync(proposedPath, `${JSON.stringify(proposed, null, 2)}\n`, 'utf8');

  const args = [
    cli,
    'reconcile',
    '--remote', remotePath,
    '--proposed', proposedPath,
    '--output', outputPath,
    '--repo-root', root,
  ];
  if (trusted) args.push('--require-equal-inventory');

  const result = runProcessSync({
    command: process.execPath,
    args,
    cwd: repoRoot,
    encoding: 'utf8',
    inheritParentEnv: true,
    timeoutMs: 30_000,
  });
  const output = existsSync(outputPath)
    ? JSON.parse(readFileSync(outputPath, 'utf8'))
    : null;
  rmSync(root, { recursive: true, force: true });
  return { result, output };
}

const trustedLegacy = runReconcile({
  remote: history({
    dataChangedAt: '2026-08-18T14:00:00.000Z',
  }),
  proposed: history({
    weight: 45000,
    provenance: 'measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  }),
});
assert(trustedLegacy.result.exitCode === 0, 'trusted legacy reconcile must succeed');
assert(trustedLegacy.output?.files?.[testPath] === 45000, 'trusted legacy weight must be preserved');
assert(trustedLegacy.output?.provenance?.[testPath] === 'measured', 'trusted legacy provenance must stay measured');
assert(!(testPath in (trustedLegacy.output?.recentSamples ?? {})), 'legacy repair must not invent recentSamples');
assert(!(testPath in (trustedLegacy.output?.fileChangedAt ?? {})), 'legacy repair must not invent fileChangedAt');

const validRemote = runReconcile({
  remote: history({
    weight: 31000,
    provenance: 'measured',
    samples: [31000],
    changedAt: '2026-08-18T16:00:00.000Z',
    dataChangedAt: '2026-08-18T16:00:00.000Z',
  }),
  proposed: history({
    weight: 45000,
    provenance: 'measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  }),
});
assert(validRemote.result.exitCode === 0, 'valid remote reconcile must succeed');
assert(validRemote.output?.files?.[testPath] === 31000, 'legacy carry-forward must not overwrite valid remote weight');
assert(validRemote.output?.fileChangedAt?.[testPath] === '2026-08-18T16:00:00.000Z', 'newer remote timestamp must remain authoritative');

const untrustedLegacy = runReconcile({
  remote: history({
    dataChangedAt: '2026-08-18T14:00:00.000Z',
  }),
  proposed: history({
    weight: 45000,
    provenance: 'measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  }),
  trusted: false,
});
assert(untrustedLegacy.result.exitCode === 0, 'untrusted reconcile must retain legacy behavior');
assert(!(testPath in (untrustedLegacy.output?.files ?? {})), 'untrusted reconcile must not restore legacy weight');
assert(untrustedLegacy.output?.provenance?.[testPath] === 'fallback', 'untrusted reconcile must keep remote fallback provenance');

const inventoryDrift = runReconcile({
  remote: history({
    dataChangedAt: '2026-08-18T14:00:00.000Z',
  }),
  proposed: history({
    weight: 45000,
    provenance: 'measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  }),
  extraProposedPath: 'scripts/not-in-trusted-inventory.test.ts',
});
assert(inventoryDrift.result.exitCode !== 0, 'inventory drift must remain fail-closed');
assert(
  `${inventoryDrift.result.stderr}${inventoryDrift.result.stdout}`.includes('inventory drift:'),
  'inventory drift failure must remain explicit',
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`[FAIL] ${failure}`);
  process.exit(1);
}

console.log('[PASS] runtime-history trusted legacy reconcile fixture');
