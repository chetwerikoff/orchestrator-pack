#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
/**
 * AO-free declaration producer and canonical contract for the PR scope guard.
 *
 * This module intentionally has no dependency on AO state, AO environment
 * variables, or the historical declaration snapshot schema.
 */

import { runProcessSync } from './kernel/subprocess.ts';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIssueBody } from '@orchestrator-pack/shared/lib/issue_parser.js';

export const PR_SCOPE_DECLARATION_SCHEMA =
  'orchestrator-pack/pr-scope-declaration/v1';

/**
 * Repository policy is deliberately defined once here. Both producer and
 * verifier import this source; an artifact can narrow roots or add denials,
 * but cannot widen this policy.
 */
export const REPOSITORY_DENYLIST = [
  'vendor/**',
  'packages/core/**',
  'secrets/**',
  'credentials/**',
] as const;

export const REPOSITORY_ALLOWED_ROOTS = [
  '.claude/skills/**',
  '.cursor/rules/**',
  '.cursor/skills/**',
  'scripts/**',
  'tests/external-output-references/**',
  'plugins/**',
  'prompts/**',
  'docs/declarations/**',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/**',
  '.github/workflows/**',
  'README.md',
  'package.json',
  'package-lock.json',
  'agent-orchestrator.yaml.example',
] as const;

export type CanonicalEntry = {
  value: string;
  prefix: boolean;
};

export interface PrScopeDeclaration {
  schema_version: typeof PR_SCOPE_DECLARATION_SCHEMA;
  issue_number: number;
  declared_paths: string[];
  denylist: string[];
  allowed_roots: string[];
  /** Informational only; never used as a source or trust witness. */
  source_revision?: string;
}

export type DeclarationFailureKind =
  | 'malformed'
  | 'unsupported-schema'
  | 'wrong-Issue'
  | 'invalid-normalization'
  | 'policy-violation';

export interface DeclarationValidationFailure {
  ok: false;
  kind: DeclarationFailureKind;
  errors: string[];
}

export interface DeclarationValidationSuccess {
  ok: true;
  declaration: PrScopeDeclaration;
}

export type DeclarationValidationResult =
  | DeclarationValidationSuccess
  | DeclarationValidationFailure;

const DRIVE_PREFIX = /^[A-Za-z]:/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalizeEntry(
  raw: unknown,
  field: string,
  index: number,
): { ok: true; entry: CanonicalEntry } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: `${field}[${index}] must be a string` };
  }

  if (raw.length === 0) {
    return { ok: false, error: `${field}[${index}] is empty` };
  }
  if (raw !== raw.trim()) {
    return {
      ok: false,
      error: `${field}[${index}] must not have leading or trailing whitespace`,
    };
  }

  let value = raw;
  if (value.includes('\0')) {
    return { ok: false, error: `${field}[${index}] contains NUL` };
  }

  const globPrefix = value.endsWith('/**');
  const trailingSlash = value.endsWith('/');
  const prefix = globPrefix || trailingSlash;
  if (globPrefix) {
    value = value.slice(0, -3);
  }
  if (value.endsWith('/')) {
    value = value.slice(0, -1);
  }

  value = value.replaceAll('\\', '/');
  if (DRIVE_PREFIX.test(value) || value.startsWith('/')) {
    return {
      ok: false,
      error: `${field}[${index}] "${raw}" is not repository-relative`,
    };
  }

  if (value.includes('*') || value.includes('?')) {
    return {
      ok: false,
      error: `${field}[${index}] "${raw}" uses an unsupported glob; use a literal path or terminal /** directory prefix`,
    };
  }

  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return {
          ok: false,
          error: `${field}[${index}] "${raw}" escapes the repository with ..`,
        };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return { ok: false, error: `${field}[${index}] "${raw}" normalizes to empty` };
  }

  const normalized = segments.join('/');
  return { ok: true, entry: { value: normalized, prefix } };
}

function canonicalEntryText(entry: CanonicalEntry): string {
  return entry.prefix ? `${entry.value}/` : entry.value;
}

function canonicalizeEntries(
  values: unknown,
  field: string,
): { ok: true; entries: CanonicalEntry[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(values)) {
    return { ok: false, errors: [`${field} must be an array`] };
  }

  const entries: CanonicalEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const result = canonicalizeEntry(value, field, index);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    const text = canonicalEntryText(result.entry);
    if (seen.has(text)) {
      errors.push(`${field}[${index}] duplicates normalized entry "${text}"`);
      return;
    }
    seen.add(text);
    entries.push(result.entry);
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  entries.sort((left, right) =>
    canonicalEntryText(left).localeCompare(canonicalEntryText(right)),
  );
  return { ok: true, entries };
}

function canonicalTexts(entries: CanonicalEntry[]): string[] {
  return entries.map(canonicalEntryText);
}

function pathEntryMatches(path: string, entry: CanonicalEntry): boolean {
  return entry.prefix
    ? path === entry.value || path.startsWith(`${entry.value}/`)
    : path === entry.value;
}

export function normalizeRepositoryPath(raw: unknown): {
  ok: true;
  path: string;
} | {
  ok: false;
  reason: string;
} {
  const result = canonicalizeEntry(raw, 'path', 0);
  if (!result.ok) {
    return { ok: false, reason: result.error };
  }
  if (result.entry.prefix) {
    return {
      ok: false,
      reason: 'changed paths must be literal files, not directory prefixes',
    };
  }
  return { ok: true, path: result.entry.value };
}

export function pathMatchesEntries(
  path: string,
  entries: readonly string[],
): boolean {
  const canonical = normalizeRepositoryPath(path);
  if (!canonical.ok) return false;
  return entries.some((raw) => {
    const result = canonicalizeEntry(raw, 'entry', 0);
    return result.ok && pathEntryMatches(canonical.path, result.entry);
  });
}

export function entriesWithinRoots(
  entries: readonly string[],
  roots: readonly string[],
): { ok: true } | { ok: false; path: string; root: string } {
  const canonicalRoots = canonicalizeEntries(roots, 'allowed_roots');
  if (!canonicalRoots.ok) {
    return { ok: false, path: roots[0] ?? '', root: 'invalid root policy' };
  }

  for (const raw of entries) {
    const entry = canonicalizeEntry(raw, 'declared_paths', 0);
    if (!entry.ok) {
      return { ok: false, path: raw, root: entry.error };
    }
    const covered = canonicalRoots.entries.some((root) => {
      if (root.prefix) {
        return (
          entry.entry.value === root.value ||
          entry.entry.value.startsWith(`${root.value}/`)
        );
      }
      return !entry.entry.prefix && entry.entry.value === root.value;
    });
    if (!covered) {
      return {
        ok: false,
        path: canonicalEntryText(entry.entry),
        root: roots.join(', '),
      };
    }
  }
  return { ok: true };
}

export function policySubset(
  narrower: readonly string[],
  broader: readonly string[],
): boolean {
  const broad = canonicalizeEntries(broader, 'policy');
  const narrow = canonicalizeEntries(narrower, 'policy');
  if (!broad.ok || !narrow.ok) return false;
  return narrow.entries.every((candidate) =>
    broad.entries.some((parent) => {
      if (parent.prefix) {
        return (
          candidate.value === parent.value ||
          candidate.value.startsWith(`${parent.value}/`)
        );
      }
      return !candidate.prefix && candidate.value === parent.value;
    }),
  );
}

function arraysAreCanonical(
  original: unknown,
  entries: CanonicalEntry[],
): boolean {
  return (
    Array.isArray(original) &&
    JSON.stringify(original) === JSON.stringify(canonicalTexts(entries))
  );
}

export function validatePrScopeDeclaration(
  input: unknown,
  issueNumber?: number,
): DeclarationValidationResult {
  if (!isRecord(input)) {
    return { ok: false, kind: 'malformed', errors: ['artifact must be an object'] };
  }
  if (input.schema_version !== PR_SCOPE_DECLARATION_SCHEMA) {
    return {
      ok: false,
      kind: 'unsupported-schema',
      errors: [
        `schema_version must be "${PR_SCOPE_DECLARATION_SCHEMA}"`,
      ],
    };
  }
  if (
    typeof input.issue_number !== 'number' ||
    !Number.isInteger(input.issue_number) ||
    input.issue_number <= 0
  ) {
    return {
      ok: false,
      kind: 'malformed',
      errors: ['issue_number must be a positive integer'],
    };
  }
  if (issueNumber !== undefined && input.issue_number !== issueNumber) {
    return {
      ok: false,
      kind: 'wrong-Issue',
      errors: [
        `artifact issue_number ${String(input.issue_number)} does not match current Issue ${issueNumber}`,
      ],
    };
  }

  const declared = canonicalizeEntries(input.declared_paths, 'declared_paths');
  const denylist = canonicalizeEntries(input.denylist, 'denylist');
  const roots = canonicalizeEntries(input.allowed_roots, 'allowed_roots');
  const errors = [
    ...(declared.ok ? [] : declared.errors),
    ...(denylist.ok ? [] : denylist.errors),
    ...(roots.ok ? [] : roots.errors),
  ];
  if (!declared.ok || !denylist.ok || !roots.ok || errors.length > 0) {
    return {
      ok: false,
      kind: 'invalid-normalization',
      errors,
    };
  }
  if (declared.entries.length === 0) {
    return {
      ok: false,
      kind: 'malformed',
      errors: ['declared_paths must contain at least one path'],
    };
  }
  if (
    !arraysAreCanonical(input.declared_paths, declared.entries) ||
    !arraysAreCanonical(input.denylist, denylist.entries) ||
    !arraysAreCanonical(input.allowed_roots, roots.entries)
  ) {
    return {
      ok: false,
      kind: 'invalid-normalization',
      errors: ['artifact arrays must be sorted and canonically normalized'],
    };
  }
  if (!policySubset(REPOSITORY_DENYLIST, canonicalTexts(denylist.entries))) {
    return {
      ok: false,
      kind: 'policy-violation',
      errors: [
        'artifact denylist must include only repository policy entries or narrower additions',
      ],
    };
  }
  if (!policySubset(canonicalTexts(roots.entries), REPOSITORY_ALLOWED_ROOTS)) {
    return {
      ok: false,
      kind: 'policy-violation',
      errors: ['artifact allowed_roots widens the repository allowed-root ceiling'],
    };
  }
  const effectiveDenylist = [
    ...REPOSITORY_DENYLIST,
    ...canonicalTexts(denylist.entries),
  ];
  const withinRoots = entriesWithinRoots(
    canonicalTexts(declared.entries),
    canonicalTexts(roots.entries),
  );
  if (!withinRoots.ok) {
    return {
      ok: false,
      kind: 'policy-violation',
      errors: [
        `declared path "${withinRoots.path}" is outside allowed roots (${withinRoots.root})`,
      ],
    };
  }
  const denied = declared.entries.find((entry) =>
    effectiveDenylist.some((raw) => {
      const parsed = canonicalizeEntry(raw, 'denylist', 0);
      return parsed.ok && pathEntryMatches(entry.value, parsed.entry);
    }),
  );
  if (denied) {
    return {
      ok: false,
      kind: 'policy-violation',
      errors: [
        `declared path "${canonicalEntryText(denied)}" is denylisted by repository policy`,
      ],
    };
  }

  if (
    input.source_revision !== undefined &&
    typeof input.source_revision !== 'string'
  ) {
    return {
      ok: false,
      kind: 'malformed',
      errors: ['source_revision must be a string when present'],
    };
  }

  return {
    ok: true,
    declaration: {
      schema_version: PR_SCOPE_DECLARATION_SCHEMA,
      issue_number: input.issue_number,
      declared_paths: canonicalTexts(declared.entries),
      denylist: canonicalTexts(denylist.entries),
      allowed_roots: canonicalTexts(roots.entries),
      ...(typeof input.source_revision === 'string'
        ? { source_revision: input.source_revision }
        : {}),
    },
  };
}

export interface DeclarationCandidate {
  path: string;
  issueByFilename: number | null;
  issueByPayload: number | null;
  payload: unknown | null;
  readError?: string;
  parseError?: string;
}

export type DeclarationSelectionResult =
  | {
      ok: true;
      path: string;
      declaration: PrScopeDeclaration;
      candidates: DeclarationCandidate[];
    }
  | {
      ok: false;
      reason:
        | 'missing'
        | 'malformed'
        | 'unsupported-schema'
        | 'wrong-Issue'
        | 'duplicate'
        | 'conflicting'
        | 'candidate-discovery-error'
        | 'candidate-read-error';
      message: string;
      candidates: DeclarationCandidate[];
    };

function issueFromFilename(filename: string): number | null {
  const match = /^(\d+)\.[^/]+$/.exec(filename);
  return match ? Number(match[1]) : null;
}

function listRegularFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result.push(full);
    }
  };
  visit(root);
  return result.sort();
}

function readCandidate(path: string, repoRoot: string): DeclarationCandidate {
  const relativePath = relative(repoRoot, path).replaceAll('\\', '/');
  const filename = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const issueByFilename = issueFromFilename(filename);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      path: relativePath,
      issueByFilename,
      issueByPayload: null,
      payload: null,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      path: relativePath,
      issueByFilename,
      issueByPayload: null,
      payload: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  const issueByPayload =
    isRecord(payload) &&
    typeof payload.issue_number === 'number' &&
    Number.isInteger(payload.issue_number)
      ? payload.issue_number
      : null;
  return { path: relativePath, issueByFilename, issueByPayload, payload };
}

export function selectDeclarationArtifact(
  repoRoot: string,
  issueNumber: number,
): DeclarationSelectionResult {
  const root = join(repoRoot, 'docs', 'declarations');
  let paths: string[];
  try {
    paths = listRegularFiles(root);
  } catch (error) {
    return {
      ok: false,
      reason: 'candidate-discovery-error',
      message: `candidate-discovery-error: docs/declarations: ${
        error instanceof Error ? error.message : String(error)
      }`,
      candidates: [],
    };
  }

  const all = paths.map((path) => readCandidate(path, repoRoot));
  const candidates = all.filter(
    (candidate) =>
      candidate.issueByFilename === issueNumber ||
      candidate.issueByPayload === issueNumber,
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'missing',
      message: `missing: no valid current-Issue declaration candidate under docs/declarations for Issue ${issueNumber}; FAIL/no-selection/fresh-declaration`,
      candidates,
    };
  }

  const valid: Array<{ candidate: DeclarationCandidate; declaration: PrScopeDeclaration }> = [];
  for (const candidate of candidates) {
    if (candidate.readError) {
      return {
        ok: false,
        reason: 'candidate-read-error',
        message: `candidate-read-error: ${candidate.path}: ${candidate.readError}; remediation: retry command`,
        candidates,
      };
    }
    if (candidate.parseError) {
      return {
        ok: false,
        reason: 'malformed',
        message: `malformed: ${candidate.path}: ${candidate.parseError}; FAIL/no-selection/fresh-declaration; FAIL/no-legacy-fallback/fresh-declaration`,
        candidates,
      };
    }
    const validation = validatePrScopeDeclaration(candidate.payload, issueNumber);
    if (!validation.ok) {
      const kind =
        validation.kind === 'unsupported-schema'
          ? 'unsupported-schema'
          : validation.kind === 'wrong-Issue'
            ? 'wrong-Issue'
            : 'malformed';
      return {
        ok: false,
        reason: kind,
        message: `${kind}: ${candidate.path}: ${validation.errors.join('; ')}; FAIL/no-selection/fresh-declaration; FAIL/no-legacy-fallback/fresh-declaration`,
        candidates,
      };
    }
    valid.push({ candidate, declaration: validation.declaration });
  }

  if (valid.length !== 1) {
    const serialized = valid.map(({ declaration }) =>
      JSON.stringify(declaration),
    );
    const same = serialized.every((value) => value === serialized[0]);
    return {
      ok: false,
      reason: same ? 'duplicate' : 'conflicting',
      message: `${same ? 'duplicate' : 'conflicting'}: current-Issue declaration candidates ${valid
        .map(({ candidate }) => candidate.path)
        .join(', ')}; FAIL/no-selection/${same ? 'remove-duplicate' : 'fresh-declaration'}`,
      candidates,
    };
  }

  const selected = valid[0]!;
  if (
    selected.candidate.issueByFilename !== issueNumber
  ) {
    return {
      ok: false,
      reason: 'wrong-Issue',
      message: `wrong-Issue: ${selected.candidate.path}: valid payload is not in the canonical current-Issue filename; FAIL/no-selection/fresh-declaration`,
      candidates,
    };
  }
  return {
    ok: true,
    path: selected.candidate.path,
    declaration: selected.declaration,
    candidates,
  };
}

function issueBodyForProducer(
  repoRoot: string,
  issueNumber: number,
  bodyFile?: string,
): string {
  if (bodyFile) return readFileSync(bodyFile, 'utf8');
  const ghWrapper = join(repoRoot, 'scripts', 'gh');
  if (!existsSync(ghWrapper)) {
    throw new Error('pack scripts/gh wrapper is required when --issue-body-file is not supplied');
  }
  const result = runProcessSync({
    command: ghWrapper,
    args: ['issue', 'view', String(issueNumber), '--json', 'body'],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) {
    throw new Error(`gh issue view failed: ${result.stderr || result.error || result.outcome}`);
  }
  const parsed = JSON.parse(result.stdout) as { body?: unknown };
  if (typeof parsed.body !== 'string') {
    throw new Error(`gh issue view ${issueNumber} did not return a body`);
  }
  return parsed.body;
}

function parseListArg(argv: string[], index: number): string[] {
  const value = argv[index + 1];
  if (!value) throw new Error(`missing value for ${argv[index]}`);
  return value
    .split(',')
    .filter((entry) => entry.length > 0);
}

export function producePrScopeDeclaration(argv: string[]): PrScopeDeclaration {
  let issueNumber: number | undefined;
  let declaredPaths: string[] = [];
  let declaredPrefixes: string[] = [];
  let repoRoot = process.cwd();
  let issueBodyFile: string | undefined;
  let outputPath: string | undefined;
  let amend = false;

  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--issue':
        issueNumber = Number(argv[++index]);
        break;
      case '--declared-paths':
        declaredPaths = [...declaredPaths, ...parseListArg(argv, index++)];
        break;
      case '--declared-prefixes':
      case '--declared-globs':
        declaredPrefixes = [...declaredPrefixes, ...parseListArg(argv, index++)];
        break;
      case '--issue-body-file':
        issueBodyFile = argv[++index];
        break;
      case '--repo-root':
        repoRoot = argv[++index] ?? repoRoot;
        break;
      case '--output':
        outputPath = argv[++index];
        break;
      case '--amend':
        amend = true;
        break;
      case '--help':
      case '-h':
        throw new Error(
          'Usage: node --experimental-strip-types scripts/pr-scope-declaration.ts --issue <n> --declared-paths <path[,path...]> [--declared-prefixes <dir/**,...>] [--issue-body-file <file>] [--output <path>]',
        );
      default:
        throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (!Number.isInteger(issueNumber) || issueNumber! <= 0) {
    throw new Error('--issue must be a positive integer');
  }
  if (declaredPaths.length === 0 && declaredPrefixes.length === 0) {
    throw new Error('at least one declared path or prefix is required');
  }
  if (amend) {
    // Keep the operator's old invocation spelling from silently creating a
    // legacy artifact. The bytes produced remain the new schema.
    process.stderr.write(
      'notice: --amend is accepted as a compatibility spelling; scope changes still require a fresh declaration\n',
    );
  }

  const issueConstraints = parseIssueBody(
    issueBodyForProducer(repoRoot, issueNumber!, issueBodyFile),
  );
  const roots = issueConstraints.allowed_roots ?? [...REPOSITORY_ALLOWED_ROOTS];
  const declaredEntries = canonicalizeEntries(
    [...declaredPaths, ...declaredPrefixes],
    'declared_paths',
  );
  const denyEntries = canonicalizeEntries(
    [...new Set([...REPOSITORY_DENYLIST, ...issueConstraints.denylist])],
    'denylist',
  );
  const rootEntries = canonicalizeEntries(roots, 'allowed_roots');
  if (!declaredEntries.ok || !denyEntries.ok || !rootEntries.ok) {
    const errors = [
      ...(declaredEntries.ok ? [] : declaredEntries.errors),
      ...(denyEntries.ok ? [] : denyEntries.errors),
      ...(rootEntries.ok ? [] : rootEntries.errors),
    ];
    throw new Error(errors.join('; '));
  }
  const declarationInput = {
    schema_version: PR_SCOPE_DECLARATION_SCHEMA,
    issue_number: issueNumber,
    declared_paths: canonicalTexts(declaredEntries.entries),
    denylist: canonicalTexts(denyEntries.entries),
    allowed_roots: canonicalTexts(rootEntries.entries),
    source_revision: (() => {
      try {
        const result = runProcessSync({
          command: 'git',
          args: ['rev-parse', 'HEAD'],
          cwd: repoRoot,
          inheritParentEnv: true,
        });
        if (!result.ok) throw new Error(result.stderr || result.error || result.outcome);
        return result.stdout.trim();
      } catch {
        return undefined;
      }
    })(),
  };
  const validated = validatePrScopeDeclaration(declarationInput, issueNumber);
  if (!validated.ok) throw new Error(validated.errors.join('; '));

  const target = resolve(
    repoRoot,
    outputPath ?? join('docs', 'declarations', `${issueNumber}.pr-scope.json`),
  );
  const targetRelative = relative(repoRoot, target).replaceAll('\\', '/');
  if (
    targetRelative === '..' ||
    targetRelative.startsWith('../') ||
    !targetRelative.startsWith('docs/declarations/')
  ) {
    throw new Error('output must be under docs/declarations/');
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(validated.declaration, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(validated.declaration, null, 2)}\n`);
  return validated.declaration;
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url).replaceAll('\\', '/') ===
    process.argv[1].replaceAll('\\', '/');
if (isDirectExecution) {
  try {
    producePrScopeDeclaration(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `pr-scope-declaration: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
