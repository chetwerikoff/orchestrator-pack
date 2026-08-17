#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface RetiredSurfaceDefinition {
  readonly id: string;
  readonly sourceCommandPattern: string;
  readonly pathPattern: string;
  readonly reason: string;
  readonly owningReference: string;
}

export interface HistoricalDisposition {
  readonly path: string;
  readonly class: string;
  readonly reason: string;
  readonly owningReference: string;
}

export interface GuardViolation {
  readonly path: string;
  readonly line: number;
  readonly surfaceId: string;
  readonly match: string;
  readonly reason: string;
}

export interface GuardResult {
  readonly scannedFileCount: number;
  readonly scannedPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly violations: readonly GuardViolation[];
}

const CANONICAL_PATTERN_SOURCE = 'scripts/json-producers/retired-runtime-surfaces.json';
export const HISTORICAL_DISPOSITION_SOURCE = 'docs/investigations/runtime-hard-cut/historical-dispositions.json';
const SELF_AUTHORITY_PATHS = new Set([
  CANONICAL_PATTERN_SOURCE,
  HISTORICAL_DISPOSITION_SOURCE,
  'scripts/runtime-retirement/retired-surface-guard.ts',
  'scripts/runtime-retirement/retired-surface-guard.test.ts',
  'scripts/runtime-retirement/retired-surface-selftest.ts',
  'docs/investigations/runtime-hard-cut/baseline.json',
  'docs/investigations/runtime-hard-cut/final.json',
]);

const EXCLUDED_PREFIXES = [
  '.git/',
  'node_modules/',
  'vendor/',
  'packages/core/',
  'tests/external-output-references/',
  'docs/issues_drafts/',
  'docs/declarations/',
  'docs/archive/',
  'scripts/gate-runner/census/',
  'scripts/gate-runner/goldens/',
  'scripts/fixtures/gate-runner/legacy-wave-3b/',
  'scripts/pr2-foundation/terminalized/',
] as const;
const EXCLUDED_EXACT = new Set([
  'docs/issue_queue_index.md',
  'docs/vitest-light-lane-isolation-audit-874.md',
  'docs/submit-reconcile-delivery-source-audit.json',
  'scripts/estate-cut/issue-906.base-anchor.json',
  'scripts/estate-cut/issue-906.manifest.json',
  'scripts/pr2a/planning-manifest.json',
  'scripts/reachability-purge.manifest.json',
  'scripts/fixtures/reaction-config/report_stale_message.live-capture.provenance.json',
  'scripts/fixtures/reaction-config/report_stale_message.live-capture.txt',
  'scripts/lib/vitest-pre-topology-measurement.mjs',
]);

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

export function loadHistoricalDispositions(repoRoot: string): readonly HistoricalDisposition[] {
  const source = join(repoRoot, HISTORICAL_DISPOSITION_SOURCE);
  if (!existsSync(source)) return [];
  const raw = JSON.parse(readFileSync(source, 'utf8')) as {
    version?: unknown;
    owner?: unknown;
    dispositions?: unknown;
  };
  if (raw.version !== 1 || !Array.isArray(raw.dispositions)) {
    throw new Error('historical disposition source must be version 1 with a dispositions array');
  }
  if (raw.owner !== undefined && (typeof raw.owner !== 'string' || raw.owner.trim() === '')) {
    throw new Error('historical disposition source owner must be non-empty when present');
  }
  const seen = new Set<string>();
  const result: HistoricalDisposition[] = [];
  for (const [index, candidate] of raw.dispositions.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`historical disposition ${index} must be an object`);
    }
    const value = candidate as Record<string, unknown>;
    for (const field of ['path', 'class', 'reason', 'owningReference'] as const) {
      if (typeof value[field] !== 'string' || String(value[field]).trim() === '') {
        throw new Error(`historical disposition ${index} ${field} must be non-empty`);
      }
    }
    const path = normalizePath(String(value.path));
    if (path === '' || path.startsWith('/') || path.endsWith('/') || path.includes('*') || path.split('/').includes('..')) {
      throw new Error(`historical disposition ${index} must name one normalized exact repository file: ${path}`);
    }
    if (seen.has(path)) throw new Error(`duplicate historical disposition: ${path}`);
    seen.add(path);
    result.push({
      path,
      class: String(value.class),
      reason: String(value.reason),
      owningReference: String(value.owningReference),
    });
  }
  return result;
}

export function loadHistoricalDispositionPaths(repoRoot: string): ReadonlySet<string> {
  return new Set(loadHistoricalDispositions(repoRoot).map((record) => record.path));
}

export function isHistoricalOrDeniedPath(
  path: string,
  historicalExact: ReadonlySet<string> = EXCLUDED_EXACT,
): boolean {
  const normalized = normalizePath(path);
  return historicalExact.has(normalized)
    || EXCLUDED_EXACT.has(normalized)
    || SELF_AUTHORITY_PATHS.has(normalized)
    || EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function walk(
  root: string,
  current = root,
  historicalExact: ReadonlySet<string> = EXCLUDED_EXACT,
): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    const repoPath = normalizePath(relative(root, absolute));
    if (isHistoricalOrDeniedPath(repoPath, historicalExact)) continue;
    if (entry.isDirectory()) result.push(...walk(root, absolute, historicalExact));
    else if (entry.isFile()) result.push(repoPath);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

export function loadRetiredSurfaces(repoRoot: string): readonly RetiredSurfaceDefinition[] {
  const raw = JSON.parse(readFileSync(join(repoRoot, CANONICAL_PATTERN_SOURCE), 'utf8')) as {
    version?: unknown;
    surfaces?: unknown;
  };
  if (raw.version !== 1 || !Array.isArray(raw.surfaces) || raw.surfaces.length === 0) {
    throw new Error('retired runtime surface source must be version 1 with non-empty surfaces');
  }
  const ids = new Set<string>();
  return raw.surfaces.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`surface ${index} must be an object`);
    }
    const value = candidate as Record<string, unknown>;
    const fields = ['id', 'sourceCommandPattern', 'pathPattern', 'reason', 'owningReference'] as const;
    for (const field of fields) {
      if (typeof value[field] !== 'string' || String(value[field]).trim() === '') {
        throw new Error(`surface ${index} ${field} must be non-empty`);
      }
    }
    const definition = value as unknown as RetiredSurfaceDefinition;
    if (ids.has(definition.id)) throw new Error(`duplicate retired surface id: ${definition.id}`);
    ids.add(definition.id);
    new RegExp(definition.sourceCommandPattern, 'gm');
    new RegExp(definition.pathPattern, 'i');
    return definition;
  });
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) if (content.charCodeAt(offset) === 10) line += 1;
  return line;
}

export function scanRetiredRuntimeSurfaces(input: {
  readonly repoRoot: string;
  readonly paths?: readonly string[];
}): GuardResult {
  const repoRoot = resolve(input.repoRoot);
  const surfaces = loadRetiredSurfaces(repoRoot);
  const historicalExact = new Set([...EXCLUDED_EXACT, ...loadHistoricalDispositionPaths(repoRoot)]);
  const requested = input.paths?.map(normalizePath) ?? walk(repoRoot, repoRoot, historicalExact);
  const excludedPaths = requested.filter((path) => isHistoricalOrDeniedPath(path, historicalExact)).sort();
  const scannedPaths = requested.filter((path) => !isHistoricalOrDeniedPath(path, historicalExact)).sort();
  const violations: GuardViolation[] = [];

  for (const path of scannedPaths) {
    const absolute = join(repoRoot, path);
    if (!statSync(absolute).isFile()) continue;
    for (const surface of surfaces) {
      const pathMatch = new RegExp(surface.pathPattern, 'i').exec(path);
      if (pathMatch) {
        violations.push({ path, line: 0, surfaceId: surface.id, match: pathMatch[0], reason: surface.reason });
      }
    }
    const content = readFileSync(absolute, 'utf8');
    for (const surface of surfaces) {
      const regex = new RegExp(surface.sourceCommandPattern, 'gm');
      for (const match of content.matchAll(regex)) {
        violations.push({
          path,
          line: lineAt(content, match.index ?? 0),
          surfaceId: surface.id,
          match: match[0],
          reason: surface.reason,
        });
      }
    }
  }

  violations.sort((left, right) => left.path.localeCompare(right.path)
    || left.line - right.line || left.surfaceId.localeCompare(right.surfaceId) || left.match.localeCompare(right.match));
  return { scannedFileCount: scannedPaths.length, scannedPaths, excludedPaths, violations };
}
