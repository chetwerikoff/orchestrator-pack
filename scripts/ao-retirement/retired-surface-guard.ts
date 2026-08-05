import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type InventoryKind = 'clean' | 'deferred-active' | 'historical-exclusion' | 'preserve';

export interface RetiredSurfaceDefinition {
  readonly id: string;
  readonly sourceCommandPattern: string;
  readonly reason: string;
  readonly owningReference: string;
}

export interface InventoryRow {
  readonly path: string;
  readonly kind: InventoryKind;
  readonly reason?: string;
}

export interface RetiredSurfaceInventory {
  readonly schemaVersion: 1;
  readonly candidateBase: string;
  readonly patternSource: string;
  readonly rows: readonly InventoryRow[];
}

export interface GuardViolation {
  readonly path: string;
  readonly surfaceId: string;
  readonly match: string;
}

export interface GuardResult {
  readonly candidateBase: string;
  readonly scannedPaths: readonly string[];
  readonly deferredPaths: readonly string[];
  readonly historicalPaths: readonly string[];
  readonly preservedPaths: readonly string[];
  readonly violations: readonly GuardViolation[];
}

const INVENTORY_KINDS = new Set<InventoryKind>([
  'clean',
  'deferred-active',
  'historical-exclusion',
  'preserve',
]);

const REQUIRED_PRESERVE_PATHS = [
  'plugins/ao-task-declaration',
  'plugins/ao-scope-guard',
  'plugins/ao-token-chain-ledger',
  'plugins/ao-codex-pr-reviewer',
] as const;

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON at ${path}: ${message}`);
  }
}

function normalizeRepoPath(input: string): string {
  const trimmed = input.trim().replaceAll('\\', '/');
  if (!trimmed || isAbsolute(trimmed) || trimmed.startsWith('../') || trimmed.includes('/../')) {
    throw new Error(`invalid repository-relative path: ${input}`);
  }
  return normalize(trimmed).replaceAll('\\', '/').replace(/^\.\//, '');
}

export function loadInventory(path: string): RetiredSurfaceInventory {
  const raw = parseJson(path);
  assertObject(raw, 'inventory');
  if (raw.schemaVersion !== 1) throw new Error('inventory schemaVersion must be 1');
  if (typeof raw.candidateBase !== 'string' || !/^[0-9a-f]{40}$/.test(raw.candidateBase)) {
    throw new Error('inventory candidateBase must be a lowercase 40-hex commit');
  }
  if (typeof raw.patternSource !== 'string' || raw.patternSource.trim() === '') {
    throw new Error('inventory patternSource must be non-empty');
  }
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) {
    throw new Error('inventory rows must be a non-empty array');
  }

  const seen = new Set<string>();
  const rows: InventoryRow[] = raw.rows.map((candidate, index) => {
    assertObject(candidate, `inventory row ${index}`);
    if (typeof candidate.path !== 'string') throw new Error(`inventory row ${index} path must be a string`);
    if (typeof candidate.kind !== 'string' || !INVENTORY_KINDS.has(candidate.kind as InventoryKind)) {
      throw new Error(`inventory row ${index} has unknown kind`);
    }
    const normalizedPath = normalizeRepoPath(candidate.path);
    if (seen.has(normalizedPath)) throw new Error(`duplicate inventory path: ${normalizedPath}`);
    seen.add(normalizedPath);
    const kind = candidate.kind as InventoryKind;
    const reason = typeof candidate.reason === 'string' ? candidate.reason.trim() : '';
    if (kind !== 'clean' && reason === '') {
      throw new Error(`inventory row ${normalizedPath} requires a reason`);
    }
    return { path: normalizedPath, kind, ...(reason ? { reason } : {}) };
  });

  const actualPreserves = rows.filter((row) => row.kind === 'preserve').map((row) => row.path).sort();
  const expectedPreserves = [...REQUIRED_PRESERVE_PATHS].sort();
  if (JSON.stringify(actualPreserves) !== JSON.stringify(expectedPreserves)) {
    throw new Error(`preserve paths must equal the exact four approved plugin roots: ${expectedPreserves.join(', ')}`);
  }

  return {
    schemaVersion: 1,
    candidateBase: raw.candidateBase,
    patternSource: normalizeRepoPath(raw.patternSource),
    rows,
  };
}

export function loadRetiredSurfaces(path: string): readonly RetiredSurfaceDefinition[] {
  const raw = parseJson(path);
  assertObject(raw, 'retired surface source');
  if (!Array.isArray(raw.surfaces) || raw.surfaces.length === 0) {
    throw new Error('retired surface source must contain surfaces');
  }
  const seen = new Set<string>();
  return raw.surfaces.map((candidate, index) => {
    assertObject(candidate, `retired surface ${index}`);
    for (const field of ['id', 'sourceCommandPattern', 'reason', 'owningReference'] as const) {
      if (typeof candidate[field] !== 'string' || candidate[field].trim() === '') {
        throw new Error(`retired surface ${index} ${field} must be non-empty`);
      }
    }
    const id = candidate.id as string;
    if (seen.has(id)) throw new Error(`duplicate retired surface id: ${id}`);
    seen.add(id);
    try {
      new RegExp(candidate.sourceCommandPattern as string, 'gmi');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid retired surface regex ${id}: ${message}`);
    }
    return {
      id,
      sourceCommandPattern: candidate.sourceCommandPattern as string,
      reason: candidate.reason as string,
      owningReference: candidate.owningReference as string,
    };
  });
}

function assertExpectedKind(path: string, kind: InventoryKind): void {
  if (!existsSync(path)) throw new Error(`inventory path missing: ${path}`);
  const stat = statSync(path);
  if (kind === 'preserve') {
    if (!stat.isDirectory()) throw new Error(`preserve path is not a directory: ${path}`);
  } else if (!stat.isFile()) {
    throw new Error(`inventory path is not a file: ${path}`);
  }
}

export function evaluateRetiredSurfaceInventory(input: {
  readonly repoRoot: string;
  readonly inventoryPath: string;
}): GuardResult {
  const repoRoot = resolve(input.repoRoot);
  const inventoryPath = resolve(input.inventoryPath);
  const inventory = loadInventory(inventoryPath);
  const patternPath = resolve(repoRoot, inventory.patternSource);
  if (relative(repoRoot, patternPath).startsWith('..')) {
    throw new Error('patternSource resolves outside repository root');
  }
  const surfaces = loadRetiredSurfaces(patternPath);
  const violations: GuardViolation[] = [];
  const scannedPaths: string[] = [];
  const deferredPaths: string[] = [];
  const historicalPaths: string[] = [];
  const preservedPaths: string[] = [];

  for (const row of inventory.rows) {
    const absolutePath = resolve(repoRoot, row.path);
    if (relative(repoRoot, absolutePath).startsWith('..')) {
      throw new Error(`inventory path resolves outside repository root: ${row.path}`);
    }
    assertExpectedKind(absolutePath, row.kind);
    if (row.kind === 'deferred-active') {
      deferredPaths.push(row.path);
      continue;
    }
    if (row.kind === 'historical-exclusion') {
      historicalPaths.push(row.path);
      continue;
    }
    if (row.kind === 'preserve') {
      preservedPaths.push(row.path);
      continue;
    }

    scannedPaths.push(row.path);
    const content = readFileSync(absolutePath, 'utf8');
    for (const surface of surfaces) {
      const regex = new RegExp(surface.sourceCommandPattern, 'gmi');
      for (const match of content.matchAll(regex)) {
        violations.push({
          path: row.path,
          surfaceId: surface.id,
          match: match[0].slice(0, 160),
        });
      }
    }
  }

  return {
    candidateBase: inventory.candidateBase,
    scannedPaths,
    deferredPaths,
    historicalPaths,
    preservedPaths,
    violations,
  };
}

function defaultPaths(): { repoRoot: string; inventoryPath: string } {
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(scriptPath), '../..');
  return {
    repoRoot,
    inventoryPath: join(repoRoot, 'scripts/ao-retirement/retired-surface-inventory.json'),
  };
}

function main(): void {
  const defaults = defaultPaths();
  const result = evaluateRetiredSurfaceInventory(defaults);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.violations.length > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
