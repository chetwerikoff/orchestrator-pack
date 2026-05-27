#!/usr/bin/env tsx

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateDeclarationSnapshot,
  type DeclarationSnapshot,
} from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { parseIssueBody } from '@orchestrator-pack/shared/lib/issue_parser.js';
import { normalizePath } from '@orchestrator-pack/shared/lib/normalize.js';
import { partitionControlArtifacts } from '../plugins/ao-scope-guard/lib/control_artifacts.js';
import { pathMatchesAnyPattern } from '../plugins/ao-scope-guard/lib/glob_match.js';
import {
  normalizeIssueConstraints,
  validateDeclaredScope,
} from '../plugins/ao-task-declaration/lib/validate.js';

const SNAPSHOT_DIR = join('docs', 'declarations');

/** GitHub-supported closing keywords; keep in sync with pr-scope-check.ps1 */
export const ISSUE_LINK_PATTERN =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)\b/gi;

export interface PrScopeCheckInput {
  repoRoot: string;
  issueNumber: number;
  issueBody: string | null;
  prPaths: string[];
  degradedMode: boolean;
  forkPr: boolean;
}

export type PrScopeCheckResult =
  | {
      ok: true;
      snapshot: DeclarationSnapshot;
      checkedPaths: string[];
      skippedControlArtifacts: string[];
      unverifiedIssueConstraints: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      reason:
        | 'missing_issue_link'
        | 'missing_snapshot'
        | 'snapshot_chain_inconsistency'
        | 'issue_unreadable'
        | 'issue_parse_error'
        | 'scope_violation'
        | 'invalid_path';
      message: string;
      violations?: {
        outOfScope: string[];
        denied: string[];
        declarationErrors: string[];
        invalidPaths: Array<{ path: string; reason: string }>;
      };
      unverifiedIssueConstraints?: boolean;
    };

type PrPathSnapshotCheckResult =
  | {
      ok: true;
      checkedPaths: string[];
      skippedControlArtifacts: string[];
    }
  | {
      ok: false;
      reason: 'scope_violation' | 'invalid_path';
      message: string;
      violations: {
        outOfScope: string[];
        denied: string[];
        declarationErrors: string[];
        invalidPaths: Array<{ path: string; reason: string }>;
      };
      checkedPaths: string[];
      skippedControlArtifacts: string[];
    };

interface LoadedSnapshot {
  iterationId: string;
  snapshot: DeclarationSnapshot;
}

export function extractLinkedIssueNumber(prBody: string): number | null {
  const normalizedBody = prBody.replace(/^\uFEFF/, '').trim();
  const matches = [...normalizedBody.matchAll(ISSUE_LINK_PATTERN)];
  if (matches.length === 0) {
    return null;
  }

  const issueNumber = Number(matches[matches.length - 1]![1]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }

  return issueNumber;
}

function iterationIdFromFilename(issueNumber: number, filename: string): string | null {
  const prefix = `${issueNumber}.`;
  if (!filename.startsWith(prefix) || !filename.endsWith('.json')) {
    return null;
  }

  return filename.slice(prefix.length, -'.json'.length);
}

function listSnapshotFilenames(repoRoot: string, issueNumber: number): string[] {
  const dir = join(repoRoot, SNAPSHOT_DIR);
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(`${issueNumber}.`) && name.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

function readSnapshotFile(
  repoRoot: string,
  issueNumber: number,
  filename: string,
): LoadedSnapshot | { error: string } {
  const iterationId = iterationIdFromFilename(issueNumber, filename);
  if (!iterationId) {
    return { error: `invalid snapshot filename: ${filename}` };
  }

  try {
    const raw = JSON.parse(
      readFileSync(join(repoRoot, SNAPSHOT_DIR, filename), 'utf8'),
    ) as unknown;
    const validated = validateDeclarationSnapshot(raw);
    if (!validated.ok) {
      return { error: `${filename}: ${validated.errors.join('; ')}` };
    }

    if (validated.snapshot.issue_number !== issueNumber) {
      return {
        error: `${filename}: issue_number ${validated.snapshot.issue_number} does not match ${issueNumber}`,
      };
    }

    if (validated.snapshot.iteration_id !== iterationId) {
      return {
        error: `${filename}: iteration_id does not match filename segment "${iterationId}"`,
      };
    }

    return { iterationId, snapshot: validated.snapshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `${filename}: ${message}` };
  }
}

export function resolveLatestCommittedSnapshot(
  repoRoot: string,
  issueNumber: number,
):
  | { ok: true; snapshot: DeclarationSnapshot }
  | { ok: false; reason: 'missing_snapshot' | 'snapshot_chain_inconsistency'; message: string } {
  const filenames = listSnapshotFilenames(repoRoot, issueNumber);
  if (filenames.length === 0) {
    return {
      ok: false,
      reason: 'missing_snapshot',
      message: `no declaration snapshots found under docs/declarations/${issueNumber}.*.json`,
    };
  }

  const loaded: LoadedSnapshot[] = [];
  for (const filename of filenames) {
    const result = readSnapshotFile(repoRoot, issueNumber, filename);
    if ('error' in result) {
      return {
        ok: false,
        reason: 'snapshot_chain_inconsistency',
        message: `snapshot chain inconsistency: ${result.error}`,
      };
    }
    loaded.push(result);
  }

  const heads = loaded.filter(
    (candidate) =>
      !loaded.some((other) => other.snapshot.supersedes === candidate.iterationId),
  );

  if (heads.length !== 1) {
    return {
      ok: false,
      reason: 'snapshot_chain_inconsistency',
      message:
        heads.length === 0
          ? 'snapshot chain inconsistency: no head iteration found (cycle or broken supersedes links)'
          : `snapshot chain inconsistency: multiple head iterations (${heads.map((h) => h.iterationId).join(', ')})`,
    };
  }

  const head = heads[0]!;
  const byId = new Map(loaded.map((entry) => [entry.iterationId, entry]));
  const chainNewestFirst: LoadedSnapshot[] = [];
  const visited = new Set<string>();
  let current: LoadedSnapshot | undefined = head;

  while (current) {
    if (visited.has(current.iterationId)) {
      return {
        ok: false,
        reason: 'snapshot_chain_inconsistency',
        message: 'snapshot chain inconsistency: supersedes chain contains a cycle',
      };
    }
    visited.add(current.iterationId);
    chainNewestFirst.push(current);

    const previousId = current.snapshot.supersedes;
    if (!previousId) {
      break;
    }

    current = byId.get(previousId);
    if (!current) {
      return {
        ok: false,
        reason: 'snapshot_chain_inconsistency',
        message: `snapshot chain inconsistency: supersedes references missing iteration "${previousId}"`,
      };
    }
  }

  if (visited.size !== loaded.length) {
    return {
      ok: false,
      reason: 'snapshot_chain_inconsistency',
      message: 'snapshot chain inconsistency: orphan snapshot iterations exist outside the supersedes chain',
    };
  }

  const chainOldestFirst = [...chainNewestFirst].reverse();
  for (let index = 1; index < chainOldestFirst.length; index += 1) {
    const previous = Date.parse(chainOldestFirst[index - 1]!.snapshot.created_at);
    const currentCreatedAt = Date.parse(chainOldestFirst[index]!.snapshot.created_at);
    if (
      Number.isNaN(previous) ||
      Number.isNaN(currentCreatedAt) ||
      currentCreatedAt < previous
    ) {
      return {
        ok: false,
        reason: 'snapshot_chain_inconsistency',
        message:
          'snapshot chain inconsistency: created_at order disagrees with supersedes chain order',
      };
    }
  }

  return { ok: true, snapshot: head.snapshot };
}

function pathInDeclaredScope(
  path: string,
  declaredPaths: string[],
  declaredGlobs: string[],
): boolean {
  if (declaredPaths.includes(path)) {
    return true;
  }
  return pathMatchesAnyPattern(path, declaredGlobs);
}

function checkPrPathsAgainstSnapshot(
  prPaths: string[],
  snapshot: DeclarationSnapshot,
): PrPathSnapshotCheckResult {
  const { control, scoped } = partitionControlArtifacts(prPaths);
  const outOfScope: string[] = [];
  const invalidPaths: Array<{ path: string; reason: string }> = [];
  const checkedPaths: string[] = [];

  for (const rawPath of scoped) {
    const normalized = normalizePath(rawPath);
    if (!normalized.ok) {
      invalidPaths.push({ path: rawPath, reason: normalized.reason });
      continue;
    }

    checkedPaths.push(normalized.path);
    if (
      !pathInDeclaredScope(
        normalized.path,
        snapshot.declared_paths,
        snapshot.declared_globs,
      )
    ) {
      outOfScope.push(normalized.path);
    }
  }

  if (invalidPaths.length > 0) {
    return {
      ok: false,
      reason: 'invalid_path',
      message: 'one or more PR diff paths failed normalization',
      violations: { outOfScope, denied: [], declarationErrors: [], invalidPaths },
      checkedPaths,
      skippedControlArtifacts: control,
    };
  }

  if (outOfScope.length > 0) {
    return {
      ok: false,
      reason: 'scope_violation',
      message: 'PR diff includes paths outside the committed declaration snapshot',
      violations: { outOfScope, denied: [], declarationErrors: [], invalidPaths: [] },
      checkedPaths,
      skippedControlArtifacts: control,
    };
  }

  return { ok: true, checkedPaths, skippedControlArtifacts: control };
}

export function checkPrScope(input: PrScopeCheckInput): PrScopeCheckResult {
  const snapshotResult = resolveLatestCommittedSnapshot(input.repoRoot, input.issueNumber);
  if (!snapshotResult.ok) {
    return {
      ok: false,
      reason: snapshotResult.reason,
      message: snapshotResult.message,
    };
  }

  const snapshot = snapshotResult.snapshot;
  const warnings: string[] = [];
  let unverifiedIssueConstraints = false;

  if (input.issueBody === null) {
    if (input.forkPr && !input.degradedMode) {
      return {
        ok: false,
        reason: 'issue_unreadable',
        message:
          'fork PR: linked issue body could not be read with workflow permissions; apply label scope-guard-degraded (by a maintainer with write access) for snapshot-only validation',
      };
    }

    if (input.forkPr && input.degradedMode) {
      unverifiedIssueConstraints = true;
      warnings.push(
        'degraded mode: denylist and allowed_roots constraints were not verified against the linked issue body',
      );
    } else {
      return {
        ok: false,
        reason: 'issue_unreadable',
        message: 'linked issue body could not be read',
      };
    }
  } else if (!input.degradedMode) {
    let constraints;
    try {
      constraints = normalizeIssueConstraints(parseIssueBody(input.issueBody));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: 'issue_parse_error',
        message: `failed to parse linked issue constraints: ${message}`,
      };
    }

    const declarationCheck = validateDeclaredScope(
      {
        declared_paths: snapshot.declared_paths,
        declared_globs: snapshot.declared_globs,
      },
      constraints,
    );

    if (!declarationCheck.ok) {
      return {
        ok: false,
        reason: 'scope_violation',
        message: 'committed declaration snapshot violates linked issue constraints',
        violations: {
          outOfScope: [],
          denied: [],
          declarationErrors: declarationCheck.errors,
          invalidPaths: [],
        },
      };
    }
  } else {
    unverifiedIssueConstraints = true;
    warnings.push(
      'degraded mode: denylist and allowed_roots constraints were not verified against the linked issue body',
    );
  }

  const pathCheck = checkPrPathsAgainstSnapshot(input.prPaths, snapshot);
  if (!pathCheck.ok) {
    return {
      ok: false,
      reason: pathCheck.reason,
      message: pathCheck.message,
      violations: pathCheck.violations,
      unverifiedIssueConstraints,
    };
  }

  return {
    ok: true,
    snapshot,
    checkedPaths: pathCheck.checkedPaths,
    skippedControlArtifacts: pathCheck.skippedControlArtifacts,
    unverifiedIssueConstraints,
    warnings,
  };
}

export function formatScopeCheckComment(result: PrScopeCheckResult): string {
  if (result.ok) {
    const lines = [
      '## Scope guard — passed',
      '',
      `Active snapshot: \`docs/declarations/${result.snapshot.issue_number}.${result.snapshot.iteration_id}.json\``,
      `Checked paths: ${result.checkedPaths.length}`,
    ];
    if (result.skippedControlArtifacts.length > 0) {
      lines.push(
        `Skipped control artifacts: ${result.skippedControlArtifacts.length}`,
      );
    }
    if (result.unverifiedIssueConstraints) {
      lines.push('', '**Warning:** issue denylist / allowed_roots constraints were not verified.');
    }
    for (const warning of result.warnings) {
      lines.push('', `> ${warning}`);
    }
    return lines.join('\n');
  }

  const lines = [
    '## Scope guard — failed',
    '',
    result.message,
  ];

  if (result.unverifiedIssueConstraints) {
    lines.push('', '**Note:** issue denylist / allowed_roots constraints were not verified.');
  }

  if (result.reason === 'missing_issue_link') {
    lines.push(
      '',
      'Add a closing reference to the task issue in the PR description, for example:',
      '',
      '```',
      'Closes #123',
      'Fixes #123',
      'Resolves #123',
      '```',
    );
  }

  if (result.violations) {
    if (result.violations.outOfScope.length > 0) {
      lines.push('', '### Out of scope (PR diff)', ...result.violations.outOfScope.map((p) => `- \`${p}\``));
    }
    if (result.violations.denied.length > 0) {
      lines.push('', '### Denylisted', ...result.violations.denied.map((p) => `- \`${p}\``));
    }
    if (result.violations.declarationErrors.length > 0) {
      lines.push(
        '',
        '### Declaration vs issue',
        ...result.violations.declarationErrors.map((e) => `- ${e}`),
      );
    }
    if (result.violations.invalidPaths.length > 0) {
      lines.push(
        '',
        '### Invalid paths',
        ...result.violations.invalidPaths.map((e) => `- \`${e.path}\`: ${e.reason}`),
      );
    }
  }

  return lines.join('\n');
}

function readJsonInput(): PrScopeCheckInput {
  const inputIndex = process.argv.indexOf('--input');
  const raw =
    inputIndex >= 0
      ? readFileSync(process.argv[inputIndex + 1] ?? '', 'utf8')
      : readFileSync(0, 'utf8');
  const parsed = JSON.parse(raw) as PrScopeCheckInput;
  if (!parsed.repoRoot || !parsed.issueNumber || !Array.isArray(parsed.prPaths)) {
    throw new Error('input JSON must include repoRoot, issueNumber, and prPaths');
  }
  return parsed;
}

export function runPrScopeCheckFromStdin(): PrScopeCheckResult {
  return checkPrScope(readJsonInput());
}

function isDirectExecution(): boolean {
  return process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/pr-scope-check.ts') ?? false;
}

if (isDirectExecution()) {
  try {
    if (process.argv.includes('--format-comment')) {
      const inputIndex = process.argv.indexOf('--input');
      const raw =
        inputIndex >= 0
          ? readFileSync(process.argv[inputIndex + 1] ?? '', 'utf8')
          : readFileSync(0, 'utf8');
      const result = JSON.parse(raw) as PrScopeCheckResult;
      process.stdout.write(`${formatScopeCheckComment(result)}\n`);
      process.exit(0);
    }

    const result = runPrScopeCheckFromStdin();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pr-scope-check: ${message}\n`);
    process.exit(2);
  }
}
