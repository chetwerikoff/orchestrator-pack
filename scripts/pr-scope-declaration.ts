#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
/**
 * AO-free declaration producer and canonical contract for the PR scope guard.
 *
 * This module intentionally has no dependency on AO state, AO environment
 * variables, or the historical declaration snapshot schema.
 */

import { runProcessSync } from './kernel/subprocess.ts';
import { parseRemoteSlug } from './lib/git-origin-slug.mjs';
import { WRAPPER_PATH } from './lib/gh-resolve-real-binary.mjs';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseIssueBody,
  type IssueConstraints,
} from '@orchestrator-pack/shared/lib/issue_parser.js';
import {
  matchesPathPattern,
  parsePathPattern,
  pathPatternsOverlap,
  pathPatternWithin,
} from '@orchestrator-pack/shared/lib/path_pattern.js';

export const PR_SCOPE_DECLARATION_SCHEMA =
  'orchestrator-pack/pr-scope-declaration/v1';

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
  '.gitignore',
  '.mise.toml',
  'scripts/**',
  'tests/README.md',
  'tests/external-output-references/**',
  'tests/fixtures/pack-gpt-browser-turn-harness.mjs',
  'tests/issue854-worker-status-binding-cache.mjs',
  'tests/worker-status-store-live-rca.ts',
  'plugins/**',
  'prompts/**',
  'docs/declarations/**',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/**',
  '.github/workflows/**',
  'README.md',
  'agent' + '-orchestrator.yaml.example',
  'package.json',
  'package-lock.json',
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

export function canonicalizeEntry(
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
  if (globPrefix) value = value.slice(0, -3);
  if (value.endsWith('/')) value = value.slice(0, -1);

  value = value.replaceAll('\\', '/');
  if (DRIVE_PREFIX.test(value) || value.startsWith('/')) {
    return {
      ok: false,
      error: `${field}[${index}] "${raw}" is not repository-relative`,
    };
  }

  // Filename suffix stars can declare files or add denials, never widen allowed roots.
  const terminalFileStar =
    (field === 'declared_paths' || field === 'denylist') &&
    !prefix &&
    value.endsWith('*') &&
    value.indexOf('*') === value.length - 1 &&
    /(?:^|\/)[^/*]+\*$/.test(value);
  if (
    (value.includes('*') && !terminalFileStar) ||
    value.includes('?') ||
    /[\[\]{}]/.test(value) ||
    /(?:^|[^\\])[@+?!*]\(/.test(value)
  ) {
    return {
      ok: false,
      error: `${field}[${index}] "${raw}" uses an unsupported glob; use a literal path or terminal /** directory prefix`,
    };
  }

  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
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

  return {
    ok: true,
    entry: { value: segments.join('/'), prefix },
  };
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

  if (errors.length > 0) return { ok: false, errors };
  entries.sort((left, right) =>
    canonicalEntryText(left).localeCompare(canonicalEntryText(right)),
  );
  return { ok: true, entries };
}

function canonicalTexts(entries: CanonicalEntry[]): string[] {
  return entries.map(canonicalEntryText);
}

function parsePolicyEntries(
  values: readonly string[],
  field: string,
): { ok: true; entries: string[] } | { ok: false; errors: string[] } {
  const entries: string[] = [];
  const errors: string[] = [];

  values.forEach((value, index) => {
    const parsed = parsePathPattern(value);
    if (!parsed.ok) {
      errors.push(`${field}[${index}] ${parsed.reason}`);
      return;
    }
    if (parsed.pattern.source !== value) {
      errors.push(
        `${field}[${index}] "${value}" must be canonically normalized`,
      );
      return;
    }
    entries.push(parsed.pattern.source);
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, entries };
}

function pathEntryMatches(path: string, entry: CanonicalEntry): boolean {
  return matchesPathPattern(canonicalEntryText(entry), path);
}

export function normalizeRepositoryPath(raw: unknown):
  | { ok: true; path: string }
  | { ok: false; reason: string } {
  const result = canonicalizeEntry(raw, 'path', 0);
  if (!result.ok) return { ok: false, reason: result.error };
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
    const result = canonicalizeEntry(raw, 'declared_paths', 0);
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
    const candidate = canonicalEntryText(entry.entry);
    const covered = canonicalRoots.entries.some((root) =>
      pathPatternWithin(candidate, canonicalEntryText(root)),
    );
    if (!covered) {
      return { ok: false, path: candidate, root: roots.join(', ') };
    }
  }
  return { ok: true };
}

export function policySubset(
  narrower: readonly string[],
  broader: readonly string[],
): boolean {
  const broad = parsePolicyEntries(broader, 'policy');
  const narrow = parsePolicyEntries(narrower, 'policy');
  if (!broad.ok || !narrow.ok) return false;
  return narrow.entries.every((candidate) =>
    broad.entries.some((parent) => pathPatternWithin(candidate, parent)),
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
      errors: [`schema_version must be "${PR_SCOPE_DECLARATION_SCHEMA}"`],
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
    return { ok: false, kind: 'invalid-normalization', errors };
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

  const effectiveDenylist = [
    ...REPOSITORY_DENYLIST,
    ...canonicalTexts(denylist.entries),
  ];
  const denied = declared.entries.find((entry) =>
    effectiveDenylist.some((raw) => {
      const parsed = canonicalizeEntry(raw, 'denylist', 0);
      return (
        parsed.ok &&
        pathPatternsOverlap(
          canonicalEntryText(entry),
          canonicalEntryText(parsed.entry),
        )
      );
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

export type LiveIssueScopeSelectionResult =
  | { ok: true; allowed_roots: string[]; denylist: string[] }
  | { ok: false; message: string };

export interface LiveIssueScopeBinding {
  issueNumber?: number;
  prNumber?: number;
  headSha?: string;
}

const LIVE_ISSUE_BOOTSTRAP_SCHEMA = 'scope-guard-bootstrap/v1';
const LIVE_ISSUE_BOOTSTRAP_WORKFLOW = '.github/workflows/scope-guard.yml';
const LIVE_ISSUE_BOOTSTRAP_FENCE_PATTERN =
  /```scope-guard-bootstrap\/v1\s*\r?\n([\s\S]*?)```/gi;
const SOURCE_REVISION_MARKER_PATTERN =
  /^<!--[ \t]*source-revision:[ \t]*(r\d+)[ \t]*-->[ \t]*\r?$/gm;
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ISSUE_SCOPE_FENCE_PATTERN =
  /```(denylist|allowed-roots)\s*\r?\n([\s\S]*?)```/gi;

function hasDuplicateEntries(entries: readonly string[]): boolean {
  return new Set(entries).size !== entries.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.localeCompare(b));
  const sortedRight = [...right].sort((a, b) => a.localeCompare(b));
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function validateLiveIssueBootstrap(
  issueBody: string,
  allowedRoots: readonly string[],
  binding?: LiveIssueScopeBinding,
): string | null {
  const bootstrapMatches = [
    ...issueBody.matchAll(
      new RegExp(
        LIVE_ISSUE_BOOTSTRAP_FENCE_PATTERN.source,
        LIVE_ISSUE_BOOTSTRAP_FENCE_PATTERN.flags,
      ),
    ),
  ];
  if (bootstrapMatches.length === 0) return null;
  if (bootstrapMatches.length !== 1) {
    return 'live-Issue scope selection failed: exactly one scope-guard-bootstrap/v1 fence is required; FAIL/no-selection/fresh-declaration';
  }

  const revisionMatches = [
    ...issueBody.matchAll(
      new RegExp(
        SOURCE_REVISION_MARKER_PATTERN.source,
        SOURCE_REVISION_MARKER_PATTERN.flags,
      ),
    ),
  ];
  if (revisionMatches.length !== 1) {
    return 'live-Issue scope selection failed: exactly one source-revision marker is required for bootstrap-bound scope; FAIL/no-selection/fresh-declaration';
  }

  if (
    !binding ||
    !Number.isInteger(binding.issueNumber) ||
    binding.issueNumber! <= 0 ||
    !Number.isInteger(binding.prNumber) ||
    binding.prNumber! <= 0 ||
    typeof binding.headSha !== 'string' ||
    !FULL_GIT_SHA_PATTERN.test(binding.headSha)
  ) {
    return 'live-Issue scope selection failed: current Issue, PR, and 40-hex head binding context is required; FAIL/no-selection/fresh-declaration';
  }

  let bootstrap: unknown;
  try {
    bootstrap = JSON.parse(bootstrapMatches[0]?.[1] ?? '') as unknown;
  } catch {
    return 'live-Issue scope selection failed: malformed scope-guard-bootstrap/v1 fence; FAIL/no-selection/fresh-declaration';
  }
  if (!isRecord(bootstrap)) {
    return 'live-Issue scope selection failed: scope-guard-bootstrap/v1 must contain an object; FAIL/no-selection/fresh-declaration';
  }

  const implementationPaths = bootstrap.allowedImplementationPaths;
  if (
    !Array.isArray(implementationPaths) ||
    !implementationPaths.every(
      (value): value is string => typeof value === 'string',
    )
  ) {
    return 'live-Issue scope selection failed: bootstrap allowedImplementationPaths must be a string array; FAIL/no-selection/fresh-declaration';
  }

  const sourceRevision = revisionMatches[0]?.[1];
  const bindingValid =
    bootstrap.schema === LIVE_ISSUE_BOOTSTRAP_SCHEMA &&
    bootstrap.issueNumber === binding.issueNumber &&
    bootstrap.prNumber === binding.prNumber &&
    bootstrap.headSha === binding.headSha &&
    bootstrap.sourceRevision === sourceRevision &&
    bootstrap.workflowPath === LIVE_ISSUE_BOOTSTRAP_WORKFLOW &&
    bootstrap.declarationArtifactsAllowed === false &&
    bootstrap.expiresOnMismatch === true &&
    sameStringSet(implementationPaths, allowedRoots);
  if (!bindingValid) {
    return 'live-Issue scope selection failed: bootstrap binding is stale, substituted, or path-mismatched; FAIL/no-selection/fresh-declaration';
  }

  return null;
}

export function selectLiveIssueScope(
  issueBody: string,
  issueConstraints: IssueConstraints,
  binding?: LiveIssueScopeBinding,
): LiveIssueScopeSelectionResult {
  const fenceCounts = { denylist: 0, 'allowed-roots': 0 };
  let match: RegExpExecArray | null;
  const pattern = new RegExp(
    ISSUE_SCOPE_FENCE_PATTERN.source,
    ISSUE_SCOPE_FENCE_PATTERN.flags,
  );
  while ((match = pattern.exec(issueBody)) !== null) {
    const label = match[1] as keyof typeof fenceCounts;
    fenceCounts[label] += 1;
  }

  if (fenceCounts.denylist !== 1 || fenceCounts['allowed-roots'] !== 1) {
    return {
      ok: false,
      message:
        'live-Issue scope selection failed: exactly one denylist and one allowed-roots fence are required; FAIL/no-selection/fresh-declaration',
    };
  }

  const allowed_roots = issueConstraints.allowed_roots;
  if (!allowed_roots || allowed_roots.length === 0) {
    return {
      ok: false,
      message:
        'live-Issue scope selection failed: explicit allowed-roots are required; repository-wide fallback is forbidden; FAIL/no-selection/fresh-declaration',
    };
  }

  const bootstrapError = validateLiveIssueBootstrap(
    issueBody,
    allowed_roots,
    binding,
  );
  if (bootstrapError) return { ok: false, message: bootstrapError };

  if (
    hasDuplicateEntries(issueConstraints.denylist) ||
    hasDuplicateEntries(allowed_roots)
  ) {
    return {
      ok: false,
      message:
        'live-Issue scope selection failed: scope entries contain duplicates; FAIL/no-selection/fresh-declaration',
    };
  }

  const checkedRoots = canonicalizeEntries(allowed_roots, 'allowed_roots');
  const checkedDenylist = canonicalizeEntries(issueConstraints.denylist, 'denylist');
  if (!checkedRoots.ok || !checkedDenylist.ok) {
    const errors = [
      ...(checkedRoots.ok ? [] : checkedRoots.errors),
      ...(checkedDenylist.ok ? [] : checkedDenylist.errors),
    ];
    return {
      ok: false,
      message: `live-Issue scope selection failed: ${errors.join('; ')}; FAIL/no-selection/fresh-declaration`,
    };
  }

  // Preserve the live-scope interface: fence order and terminal /** spellings
  // remain unchanged after the stricter field-specific grammar check.
  const parsedAllowedRoots = parsePolicyEntries(allowed_roots, 'allowed-roots');
  const parsedDenylist = parsePolicyEntries(issueConstraints.denylist, 'denylist');
  if (!parsedAllowedRoots.ok || !parsedDenylist.ok) {
    const errors = [
      ...(parsedAllowedRoots.ok ? [] : parsedAllowedRoots.errors),
      ...(parsedDenylist.ok ? [] : parsedDenylist.errors),
    ];
    return {
      ok: false,
      message: `live-Issue scope selection failed: ${errors.join('; ')}; FAIL/no-selection/fresh-declaration`,
    };
  }
  if (!policySubset(parsedAllowedRoots.entries, REPOSITORY_ALLOWED_ROOTS)) {
    return {
      ok: false,
      message:
        'live-Issue scope selection failed: allowed-roots widen the repository ceiling; FAIL/no-selection/fresh-declaration',
    };
  }

  return {
    ok: true,
    allowed_roots: parsedAllowedRoots.entries,
    denylist: parsedDenylist.entries,
  };
}

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

  const valid: Array<{
    candidate: DeclarationCandidate;
    declaration: PrScopeDeclaration;
  }> = [];
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
  if (selected.candidate.issueByFilename !== issueNumber) {
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
  const ghWrapper = WRAPPER_PATH;
  if (!existsSync(ghWrapper)) {
    throw new Error(
      'pack scripts/gh wrapper is required when --issue-body-file is not supplied',
    );
  }
  const result = runProcessSync({
    command: ghWrapper,
    args: ['issue', 'view', String(issueNumber), '--json', 'body'],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) {
    throw new Error(
      `gh issue view failed: ${result.stderr || result.error || result.outcome}`,
    );
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
  return value.split(',').filter((entry) => entry.length > 0);
}

export type PrScopeGuardApplicability = 'guarded' | 'guard-free' | 'unverified';

function gitOutput(repoRoot: string, args: string[]): string | null {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
    timeoutMs: 10_000,
  });
  return result.ok ? result.stdout.trim() : null;
}

type WorkflowState = true | false | null;
type WorkflowField = { key: string; value: string; indent: number; index: number };

function workflowIndent(line: string): number {
  return /^\s*/u.exec(line)?.[0].length ?? 0;
}

function workflowLines(source: string): string[] {
  return source.replace(/^\uFEFF/u, '').split(/\r?\n/u).map((line) => {
    let quote: "'" | '"' | null = null;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      if (quote === '"' && char === '\\') { index += 1; continue; }
      if (quote === "'" && char === "'" && line[index + 1] === "'") { index += 1; continue; }
      if (quote === char) { quote = null; continue; }
      if (!quote && (char === "'" || char === '"')) { quote = char; continue; }
      if (!quote && char === '#' && (index === 0 || /\s/u.test(line[index - 1]!))) {
        return line.slice(0, index).trimEnd();
      }
    }
    return line;
  });
}

function workflowField(line: string, index: number): WorkflowField | null {
  const indent = workflowIndent(line);
  const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*(.*)$/u.exec(line.slice(indent));
  if (!match) return null;
  return { key: match[1] ?? match[2] ?? match[3]!, value: match[4]!, indent, index };
}

function workflowBlockEnd(lines: readonly string[], start: number, parentIndent: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() && workflowIndent(lines[index]!) <= parentIndent) return index;
  }
  return lines.length;
}

function workflowChildren(
  lines: readonly string[],
  start: number,
  end: number,
  parentIndent: number,
): WorkflowField[] {
  const candidates: WorkflowField[] = [];
  for (let index = start + 1; index < end; index += 1) {
    if (!lines[index]!.trim() || workflowIndent(lines[index]!) <= parentIndent) continue;
    const field = workflowField(lines[index]!, index);
    if (field) candidates.push(field);
  }
  const level = Math.min(...candidates.map((field) => field.indent));
  return candidates.filter((field) => field.indent === level);
}

function workflowFlowItems(source: string): string[] | null {
  const text = source.trim();
  if (!((text[0] === '[' && text.at(-1) === ']') ||
        (text[0] === '{' && text.at(-1) === '}'))) return null;
  const items: string[] = [];
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let start = 1;
  for (let index = 1; index < text.length - 1; index += 1) {
    const char = text[index]!;
    if (quote === '"' && char === '\\') { index += 1; continue; }
    if (quote === "'" && char === "'" && text[index + 1] === "'") { index += 1; continue; }
    if (quote === char) { quote = null; continue; }
    if (!quote && (char === "'" || char === '"')) { quote = char; continue; }
    if (quote) continue;
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      items.push(text.slice(start, index).trim());
      start = index + 1;
    }
    if (depth < 0) return null;
  }
  if (quote || depth !== 0) return null;
  const last = text.slice(start, -1).trim();
  if (last) items.push(last);
  return items;
}

function workflowScalar(value: string): string {
  const text = value.trim();
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text) as string; } catch { return text; }
  }
  return text;
}

function workflowFlowMap(source: string): Map<string, string> | null {
  if (!source.trim().startsWith('{')) return null;
  const items = workflowFlowItems(source);
  if (!items) return null;
  const map = new Map<string, string>();
  for (const item of items) {
    const pair = workflowField(item, 0);
    if (!pair || map.has(pair.key)) return null;
    map.set(pair.key, pair.value);
  }
  return map;
}

function workflowSequence(
  value: string,
  lines: readonly string[],
  field: WorkflowField | undefined,
  end: number,
): string[] | null {
  const text = value.trim();
  if (text.startsWith('[')) return workflowFlowItems(text)?.map(workflowScalar) ?? null;
  if (text || !field) return null;
  const values: string[] = [];
  let listIndent: number | null = null;
  for (let index = field.index + 1; index < end; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const indent = workflowIndent(line);
    if (indent <= field.indent) break;
    const match = /^\s*-\s*(.+?)\s*$/u.exec(line);
    if (!match || (listIndent !== null && indent !== listIndent)) return null;
    listIndent = indent;
    values.push(workflowScalar(match[1]!));
  }
  return values.length ? values : null;
}

function normalPrTrigger(lines: readonly string[]): WorkflowState {
  const on = lines.map(workflowField).find((field) => field?.indent === 0 && field.key === 'on');
  if (!on) return lines.some((line) => /\bpull_request\b/u.test(line)) ? null : false;
  const onEnd = workflowBlockEnd(lines, on.index, on.indent);
  let prValue: string | undefined;
  let prField: WorkflowField | undefined;
  const onText = on.value.trim();

  if (onText.startsWith('{')) {
    const events = workflowFlowMap(onText);
    if (!events) return null;
    prValue = events.get('pull_request');
    if (prValue === undefined) return false;
  } else if (onText.startsWith('[')) {
    const events = workflowFlowItems(onText);
    if (!events) return null;
    return events.map(workflowScalar).includes('pull_request');
  } else if (onText) {
    return workflowScalar(onText) === 'pull_request';
  } else {
    prField = workflowChildren(lines, on.index, onEnd, on.indent)
      .find((field) => field.key === 'pull_request');
    if (!prField) return false;
    prValue = prField.value;
  }

  let types: string | undefined;
  let typesField: WorkflowField | undefined;
  let typesEnd = onEnd;
  if (prValue?.trim().startsWith('{')) {
    const map = workflowFlowMap(prValue);
    if (!map) return null;
    types = map.get('types');
    if (types === undefined) return true;
  } else if (prValue?.trim()) {
    return null;
  } else if (prField) {
    typesEnd = workflowBlockEnd(lines, prField.index, prField.indent);
    typesField = workflowChildren(lines, prField.index, typesEnd, prField.indent)
      .find((field) => field.key === 'types');
    if (!typesField) return true;
    types = typesField.value;
  } else {
    return true;
  }

  const events = workflowSequence(types ?? '', lines, typesField, typesEnd);
  if (!events) return null;
  const opened = events.includes('opened');
  const synchronize = events.includes('synchronize');
  if (opened && synchronize) return true;
  // A partial normal-PR trigger may still enforce scope on some PR updates.
  return opened || synchronize ? null : false;
}

function workflowIf(raw: string): WorkflowState {
  let value = raw.trim();
  if (value.startsWith('\${{') && value.endsWith('}}')) value = value.slice(3, -2).trim();
  while (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1).trim();
  const or = value.split(/\s+\|\|\s+/u);
  if (or.length > 1) {
    const states = or.map(workflowIf);
    return states.includes(true) ? true : states.every((state) => state === false) ? false : null;
  }
  const and = value.split(/\s+&&\s+/u);
  if (and.length > 1) {
    const states = and.map(workflowIf);
    return states.includes(false) ? false : states.every((state) => state === true) ? true : null;
  }
  if (/^false$/iu.test(value)) return false;
  if (/^true$/iu.test(value)) return true;
  const event = /^github\.event_name\s*(==|!=)\s*(['"])([^'"]+)\2$/iu.exec(value);
  if (event) {
    const matches = event[3] === 'pull_request';
    return event[1] === '==' ? matches : !matches;
  }
  if (/^!\s*/u.test(value)) {
    const nested = workflowIf(value.replace(/^!\s*/u, ''));
    return nested === null ? null : !nested;
  }
  return null;
}

function guardJobState(lines: readonly string[], jobs: WorkflowField, jobsEnd: number): WorkflowState {
  const job = workflowChildren(lines, jobs.index, jobsEnd, jobs.indent)
    .find((field) => field.key === 'pr-scope-guard');
  if (!job) return false;
  const jobEnd = workflowBlockEnd(lines, job.index, job.indent);
  const properties = workflowChildren(lines, job.index, jobEnd, job.indent);
  const condition = properties.find((field) => field.key === 'if');
  const jobCondition = condition ? workflowIf(condition.value) : true;
  if (jobCondition === false) return false;
  const steps = properties.find((field) => field.key === 'steps');
  if (!steps) return null;
  const stepsEnd = workflowBlockEnd(lines, steps.index, steps.indent);
  const stepStarts = [];
  for (let index = steps.index + 1; index < stepsEnd; index += 1) {
    if (/^\s*-\s+\S/u.test(lines[index]!)) stepStarts.push(index);
  }
  if (stepStarts.length === 0) return null;
  const stepLevel = Math.min(...stepStarts.map((index) => workflowIndent(lines[index]!)));
  const starts = stepStarts.filter((index) => workflowIndent(lines[index]!) === stepLevel);
  let ambiguous = jobCondition === null;
  for (let number = 0; number < starts.length; number += 1) {
    const start = starts[number]!;
    const end = starts[number + 1] ?? stepsEnd;
    const first = workflowField(lines[start]!.trimStart().replace(/^-\s*/u, ''), start);
    const inline = first ? [{ ...first, indent: stepLevel + 2 }] : [];
    const properties = [...inline, ...workflowChildren(lines, start, end, stepLevel)];
    const run = properties.find((field) => field.key === 'run');
    if (!run) {
      if (/scripts\/pr-scope-(?:runner|check)\.ts/u.test(lines.slice(start, end).join('\n'))) ambiguous = true;
      continue;
    }
    const runLines = [run.value];
    for (let index = run.index + 1; index < end; index += 1) {
      if (lines[index]!.trim() && workflowIndent(lines[index]!) <= run.indent) break;
      runLines.push(lines[index]!);
    }
    const command = runLines.join('\n');
    if (!/\bnode\b/u.test(command) || !/scripts\/pr-scope-(?:runner|check)\.ts\b/u.test(command)) continue;
    const stepIf = properties.find((field) => field.key === 'if');
    const active = stepIf ? workflowIf(stepIf.value) : true;
    if (active === false) continue;
    if (active === null) { ambiguous = true; continue; }
    if (jobCondition === true) return true;
  }
  return ambiguous ? null : false;
}

function workflowGuardState(source: string): WorkflowState {
  const lines = workflowLines(source);
  const trigger = normalPrTrigger(lines);
  if (trigger === false) return false;
  if (!lines.some((line) => /\bpr-scope-guard\b/u.test(line))) return false;
  const jobs = lines.map(workflowField).find((field) => field?.indent === 0 && field.key === 'jobs');
  if (!jobs) return null;
  const job = guardJobState(lines, jobs, workflowBlockEnd(lines, jobs.index, jobs.indent));
  if (job === false) return false;
  return trigger === null || job === null ? null : true;
}

export function resolvePrScopeGuardApplicability(
  repoRoot: string,
  options: { baseRef?: string } = {},
): {
  status: PrScopeGuardApplicability;
  repository: string | null;
} {
  const origin = gitOutput(repoRoot, ['config', '--get', 'remote.origin.url']);
  const repository = origin ? parseRemoteSlug(origin) : null;
  if (!repository) return { status: 'unverified', repository };

  let branch = options.baseRef?.trim() ?? '';
  if (branch.startsWith('refs/remotes/origin/')) branch = branch.slice('refs/remotes/origin/'.length);
  else if (branch.startsWith('refs/heads/')) branch = branch.slice('refs/heads/'.length);
  else if (branch.startsWith('origin/')) branch = branch.slice('origin/'.length);
  if (!branch) {
    const advertisedHead = gitOutput(repoRoot, ['ls-remote', '--symref', 'origin', 'HEAD']);
    branch = advertisedHead?.match(/^ref:\s+refs\/heads\/([^\t\r\n]+)\tHEAD$/mu)?.[1] ?? '';
  }
  if (!branch || gitOutput(repoRoot, ['check-ref-format', '--branch', branch]) !== branch) {
    return { status: 'unverified', repository };
  }
  const advertised = gitOutput(repoRoot, ['ls-remote', '--heads', 'origin', 'refs/heads/' + branch]);
  const expected = advertised?.match(/^([0-9a-f]{40})\trefs\/heads\/[^\t\r\n]+$/mu)?.[1];
  if (!expected) return { status: 'unverified', repository };
  const fetched = runProcessSync({
    command: 'git',
    args: ['fetch', '--no-tags', '--quiet', 'origin', 'refs/heads/' + branch],
    cwd: repoRoot,
    inheritParentEnv: true,
    timeoutMs: 30_000,
  });
  if (!fetched.ok || gitOutput(repoRoot, ['rev-parse', 'FETCH_HEAD^{commit}']) !== expected) {
    return { status: 'unverified', repository };
  }

  const paths = gitOutput(repoRoot, ['ls-tree', '-r', '--name-only', 'FETCH_HEAD', '--', '.github/workflows']);
  if (paths === null) return { status: 'unverified', repository };
  let unresolved = false;
  for (const path of paths.split('\n').filter((entry) => /\.ya?ml$/iu.test(entry))) {
    const source = gitOutput(repoRoot, ['show', 'FETCH_HEAD:' + path]);
    if (source === null) return { status: 'unverified', repository };
    const state = workflowGuardState(source);
    if (state === true) return { status: 'guarded', repository };
    if (state === null) unresolved = true;
  }
  return { status: unresolved ? 'unverified' : 'guard-free', repository };
}

export function producePrScopeDeclaration(argv: string[]): PrScopeDeclaration | null {
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

  const applicability = resolvePrScopeGuardApplicability(repoRoot);
  if (applicability.status === 'unverified' || !applicability.repository) {
    throw new Error('PR scope guard applicability is unverified for the selected repository');
  }
  if (applicability.status === 'guard-free') {
    process.stdout.write(`no PR scope guard in ${applicability.repository}; the Issue fences are the scope\n`);
    return null;
  }
  if (amend) {
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
  // Preserve original Issue indices before merging in repository-wide denials.
  const issueDenyErrors = issueConstraints.denylist.flatMap((value, index) => {
    const checked = canonicalizeEntry(value, 'denylist', index);
    return checked.ok ? [] : [checked.error];
  });
  if (issueDenyErrors.length > 0) throw new Error(issueDenyErrors.join('; '));
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
        if (!result.ok) {
          throw new Error(result.stderr || result.error || result.outcome);
        }
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
  writeFileSync(
    target,
    `${JSON.stringify(validated.declaration, null, 2)}\n`,
    'utf8',
  );
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
