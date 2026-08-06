#!/usr/bin/env -S node --experimental-strip-types
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RetiredSurfaceDefinition {
  readonly id: string;
  readonly sourceCommandPattern: string;
  readonly pathPattern: string;
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
const SELF_AUTHORITY_PATHS = new Set([
  CANONICAL_PATTERN_SOURCE,
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
  'tests/',
  'docs/issues_drafts/',
  'docs/declarations/',
  'docs/archive/',
] as const;
const EXCLUDED_EXACT = new Set([
  'docs/issue_queue_index.md',
  'scripts/lib/vitest-pre-topology-measurement.mjs',
]);

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isHistoricalOrDeniedPath(path: string): boolean {
  const normalized = normalizePath(path);
  return EXCLUDED_EXACT.has(normalized)
    || SELF_AUTHORITY_PATHS.has(normalized)
    || EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function walk(root: string, current = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    const repoPath = normalizePath(relative(root, absolute));
    if (isHistoricalOrDeniedPath(repoPath)) continue;
    if (entry.isDirectory()) result.push(...walk(root, absolute));
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
    new RegExp(definition.sourceCommandPattern, 'gmi');
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
  const requested = input.paths?.map(normalizePath) ?? walk(repoRoot);
  const excludedPaths = requested.filter(isHistoricalOrDeniedPath).sort();
  const scannedPaths = requested.filter((path) => !isHistoricalOrDeniedPath(path)).sort();
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
      const regex = new RegExp(surface.sourceCommandPattern, 'gmi');
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

function main(): void {
  const repoRoot = resolve(process.cwd());
  const result = scanRetiredRuntimeSurfaces({ repoRoot });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.violations.length > 0) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
