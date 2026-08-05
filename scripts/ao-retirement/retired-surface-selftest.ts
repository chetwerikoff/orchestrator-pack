import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  evaluateRetiredSurfaceInventory,
  loadInventory,
  loadRetiredSurfaces,
} from './retired-surface-guard.ts';

const PRESERVES = [
  'plugins/ao-task-declaration',
  'plugins/ao-scope-guard',
  'plugins/ao-token-chain-ledger',
  'plugins/ao-codex-pr-reviewer',
] as const;

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(process.cwd(), '.issue-1250-retired-surface-'));
  write(root, 'scripts/json-producers/retired-surfaces.json', JSON.stringify({
    version: 1,
    surfaces: [
      { id: 'report', sourceCommandPattern: '\\bao (?:report|acknowledge)(?:\\s|$)', reason: 'retired', owningReference: '#1' },
      { id: 'status', sourceCommandPattern: '\\bao status\\b[^\\n]*--reports(?:\\s|$)', reason: 'retired', owningReference: '#1' },
      { id: 'review-list', sourceCommandPattern: '\\bao review list(?:\\s|$)', reason: 'retired', owningReference: '#1' },
      { id: 'events', sourceCommandPattern: '\\bao events(?:\\s|$)', reason: 'retired', owningReference: '#1' },
    ],
  }));
  write(root, 'clean.md', 'current pack-owned command only\n');
  write(root, 'deferred.md', 'ao report working\n');
  write(root, 'historical.md', 'ao review list\n');
  for (const path of PRESERVES) mkdirSync(join(root, path), { recursive: true });
  return root;
}

function inventory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    candidateBase: 'a'.repeat(40),
    patternSource: 'scripts/json-producers/retired-surfaces.json',
    rows: [
      { path: 'clean.md', kind: 'clean' },
      { path: 'deferred.md', kind: 'deferred-active', reason: 'active migration debt' },
      { path: 'historical.md', kind: 'historical-exclusion', reason: 'quoted evidence' },
      ...PRESERVES.map((path) => ({ path, kind: 'preserve', reason: 'exact preserve' })),
    ],
    ...overrides,
  };
}

function writeInventory(root: string, value: unknown): string {
  const path = join(root, 'scripts/ao-retirement/retired-surface-inventory.json');
  write(root, 'scripts/ao-retirement/retired-surface-inventory.json', JSON.stringify(value));
  return path;
}

function expectThrows(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, pattern);
}

function runFixtureChecks(): void {
  {
    const root = fixtureRoot();
    try {
      const result = evaluateRetiredSurfaceInventory({ repoRoot: root, inventoryPath: writeInventory(root, inventory()) });
      assert.deepEqual(result.violations, []);
      assert.deepEqual(result.scannedPaths, ['clean.md']);
      assert.deepEqual(result.preservedPaths, [...PRESERVES]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  for (const [surfaceId, text] of [
    ['report', 'ao report ready_for_review'],
    ['status', 'ao status --json --reports full'],
    ['review-list', 'ao review list --json'],
    ['events', 'ao events list --json'],
  ] as const) {
    const root = fixtureRoot();
    try {
      write(root, 'clean.md', `${text}\n`);
      const result = evaluateRetiredSurfaceInventory({ repoRoot: root, inventoryPath: writeInventory(root, inventory()) });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]?.path, 'clean.md');
      assert.equal(result.violations[0]?.surfaceId, surfaceId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const root = fixtureRoot();
    try {
      const duplicate = inventory({ rows: [
        { path: 'clean.md', kind: 'clean' },
        { path: 'clean.md', kind: 'clean' },
        ...PRESERVES.map((path) => ({ path, kind: 'preserve', reason: 'exact' })),
      ] });
      expectThrows(() => loadInventory(writeInventory(root, duplicate)), /duplicate inventory path/);
      const missingReason = inventory({ rows: [
        { path: 'deferred.md', kind: 'deferred-active' },
        ...PRESERVES.map((path) => ({ path, kind: 'preserve', reason: 'exact' })),
      ] });
      expectThrows(() => loadInventory(writeInventory(root, missingReason)), /requires a reason/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const root = fixtureRoot();
    try {
      mkdirSync(join(root, 'plugins/ao-neighbor'), { recursive: true });
      const withNeighbor = inventory({ rows: [
        { path: 'clean.md', kind: 'clean' },
        ...PRESERVES.map((path) => ({ path, kind: 'preserve', reason: 'exact' })),
        { path: 'plugins/ao-neighbor', kind: 'preserve', reason: 'prefix is not authority' },
      ] });
      expectThrows(() => loadInventory(writeInventory(root, withNeighbor)), /exact four approved plugin roots/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const root = fixtureRoot();
    try {
      const path = join(root, 'bad-patterns.json');
      writeFileSync(path, JSON.stringify({
        surfaces: [{ id: 'bad', sourceCommandPattern: '[', reason: 'bad', owningReference: '#1' }],
      }));
      expectThrows(() => loadRetiredSurfaces(path), /invalid retired surface regex/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function main(): void {
  runFixtureChecks();
  const repoRoot = process.cwd();
  const result = evaluateRetiredSurfaceInventory({
    repoRoot,
    inventoryPath: join(repoRoot, 'scripts/ao-retirement/retired-surface-inventory.json'),
  });
  assert.equal(result.candidateBase, 'afd99fb7bc5f4fcb210005d96b56db7d3064a45f');
  assert.deepEqual(result.violations, []);
  process.stdout.write(`${JSON.stringify({ status: 'pass', ...result })}\n`);
}

main();
