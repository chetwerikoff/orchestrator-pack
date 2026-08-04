#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { runProcessSync } from './kernel/subprocess.ts';
import { join } from 'node:path';
import {
  validateDeclarationSnapshot,
  type DeclarationSnapshot,
} from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { normalizePath } from '@orchestrator-pack/shared/lib/normalize.js';
import {
  parseIssueBody,
  type IssueConstraints,
} from '@orchestrator-pack/shared/lib/issue_parser.js';
import { classifyScopedPaths } from '../plugins/ao-scope-guard/lib/check.ts';
import { pathMatchesAnyPattern } from '../plugins/ao-task-declaration/lib/glob_match.ts';
import { partitionControlArtifacts } from '../plugins/ao-scope-guard/lib/control_artifacts.ts';
import {
  REPOSITORY_DENYLIST,
  normalizeRepositoryPath,
  pathMatchesEntries,
  policySubset,
  selectDeclarationArtifact,
  selectLiveIssueScope,
  type PrScopeDeclaration,
} from './pr-scope-declaration.ts';
import { listIssueSnapshots } from '../plugins/ao-task-declaration/lib/snapshot.ts';
import {
  normalizeIssueConstraints,
  validateDeclaredScope,
} from '../plugins/ao-task-declaration/lib/validate.ts';
import {
  classifyNoCeremonyPaths,
  classifySpecDocsPaths,
  extractClosingIssueNumber,
  extractNonClosingIssueNumber,
  hasClosingIssueReference,
  hasNoCeremonyIssueLink,
  hasSpecOnlySignal,
  isNoCeremonyPr,
  ISSUE_LINK_PATTERN,
  NO_CEREMONY_MARKDOWN_GLOBS,
  resolveIssueNumberForFetch,
  SPEC_DOCS_ALLOWLIST,
} from './pr-scope-contract.ts';

export { resolveIssueNumberForFetch } from './pr-scope-contract.ts';

const SNAPSHOT_DIR = join('docs', 'declarations');
const DECLARATION_SNAPSHOT_SAMPLE = join('docs', 'declarations', '0.sample.json');
export const RUNTIME_HISTORY_DELIVERY_BRANCH = 'ci/vitest-runtime-history-refresh';
export const RUNTIME_HISTORY_DELIVERY_PATH = 'scripts/vitest-runtime-history.json';

function issueBlocksCommittedDeclarationSnapshots(constraints: IssueConstraints): boolean {
  return pathMatchesAnyPattern(DECLARATION_SNAPSHOT_SAMPLE, constraints.denylist);
}

function splitIssueAllowedRootsToDeclaredScope(allowedRoots: string[]): {
  declared_paths: string[];
  declared_globs: string[];
} {
  const declared_paths: string[] = [];
  const declared_globs: string[] = [];

  for (const root of allowedRoots) {
    if (root.includes('*')) {
      declared_globs.push(root);
    } else {
      declared_paths.push(root);
    }
  }

  return { declared_paths, declared_globs };
}

function classifyDenylistedPrPaths(
  prPaths: string[],
  denylist: string[],
): {
  denied: string[];
  invalidPaths: Array<{ path: string; reason: string }>;
} {
  const denied: string[] = [];
  const invalidPaths: Array<{ path: string; reason: string }> = [];

  if (denylist.length === 0) {
    return { denied, invalidPaths };
  }

  for (const rawPath of prPaths) {
    const normalized = normalizePath(rawPath);
    if (!normalized.ok) {
      invalidPaths.push({ path: rawPath, reason: normalized.reason });
      continue;
    }

    if (pathMatchesAnyPattern(normalized.path, denylist)) {
      denied.push(normalized.path);
    }
  }

  return { denied, invalidPaths };
}

/** Re-export for backward compatibility. */
export {
  extractClosingIssueNumber as extractLinkedIssueNumber,
  ISSUE_LINK_PATTERN,
} from './pr-scope-contract.ts';

export interface PrScopeCheckInput {
  repoRoot: string;
  prBody: string;
  issueBody: string | null;
  prPaths: string[];
  degradedMode: boolean;
  forkPr: boolean;
  prNumber?: number;
  prHeadRef?: string;
  sameRepo?: boolean;
  /** Required by the CI entrypoint; direct callers may provide prPaths for unit tests. */
  baseSha?: string;
  headSha?: string;
}

export type PrScopeCheckResult =
  | {
      ok: true;
      mode: 'implementation' | 'spec-only' | 'no-ceremony' | 'runtime-history-delivery';
      snapshot?: DeclarationSnapshot;
      declarationPath?: string;
      scopeSource?: 'declaration' | 'live-issue';
      issueNumber?: number;
      checkedPaths: string[];
      skippedControlArtifacts: string[];
      unverifiedIssueConstraints: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      reason:
        | 'missing_issue_link'
        | 'missing_spec_issue_reference'
        | 'spec_only_with_closing_keyword'
        | 'skill_doc_with_closing_keyword'
        | 'skill_doc_with_issue_reference'
        | 'spec_docs_scope_violation'
        | 'skill_doc_scope_violation'
        | 'missing_snapshot'
        | 'snapshot_chain_inconsistency'
        | 'issue_unreadable'
        | 'issue_parse_error'
        | 'scope_violation'
        | 'invalid_path'
        | 'diff-incomplete'
        | 'declaration-selection-failed';
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

function iterationIdFromFilename(issueNumber: number, filename: string): string | null {
  const prefix = `${issueNumber}.`;
  if (!filename.startsWith(prefix) || !filename.endsWith('.json')) {
    return null;
  }

  return filename.slice(prefix.length, -'.json'.length);
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
  const filenames = listIssueSnapshots(repoRoot, issueNumber);
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

function checkPrPathsAgainstDeclaredScope(
  prPaths: string[],
  options: {
    declaredPaths: string[];
    declaredGlobs: string[];
    denylist: string[];
    outOfScopeMessage: string;
  },
): PrPathSnapshotCheckResult {
  const denylistPrecheck = classifyDenylistedPrPaths(prPaths, options.denylist);
  const { control, scoped } = partitionControlArtifacts(prPaths);

  if (denylistPrecheck.invalidPaths.length > 0) {
    return {
      ok: false,
      reason: 'invalid_path',
      message: 'one or more PR diff paths failed normalization',
      violations: {
        outOfScope: [],
        denied: denylistPrecheck.denied,
        declarationErrors: [],
        invalidPaths: denylistPrecheck.invalidPaths,
      },
      checkedPaths: [],
      skippedControlArtifacts: control,
    };
  }

  if (denylistPrecheck.denied.length > 0) {
    return {
      ok: false,
      reason: 'scope_violation',
      message: 'PR diff includes denylisted paths from linked issue constraints',
      violations: {
        outOfScope: [],
        denied: denylistPrecheck.denied,
        declarationErrors: [],
        invalidPaths: [],
      },
      checkedPaths: [],
      skippedControlArtifacts: control,
    };
  }

  const { outOfScope, denied, invalidPaths, checkedPaths } = classifyScopedPaths(scoped, {
    denylist: options.denylist,
    declaredPaths: options.declaredPaths,
    declaredGlobs: options.declaredGlobs,
  });

  if (invalidPaths.length > 0) {
    return {
      ok: false,
      reason: 'invalid_path',
      message: 'one or more PR diff paths failed normalization',
      violations: { outOfScope, denied, declarationErrors: [], invalidPaths },
      checkedPaths,
      skippedControlArtifacts: control,
    };
  }

  if (denied.length > 0) {
    return {
      ok: false,
      reason: 'scope_violation',
      message: 'PR diff includes denylisted paths from linked issue constraints',
      violations: { outOfScope, denied, declarationErrors: [], invalidPaths: [] },
      checkedPaths,
      skippedControlArtifacts: control,
    };
  }

  if (outOfScope.length > 0) {
    return {
      ok: false,
      reason: 'scope_violation',
      message: options.outOfScopeMessage,
      violations: { outOfScope, denied: [], declarationErrors: [], invalidPaths: [] },
      checkedPaths,
      skippedControlArtifacts: control,
    };
  }

  return { ok: true, checkedPaths, skippedControlArtifacts: control };
}

function checkPrPathsAgainstSnapshot(
  prPaths: string[],
  snapshot: DeclarationSnapshot,
  issueDenylist: string[] = [],
): PrPathSnapshotCheckResult {
  return checkPrPathsAgainstDeclaredScope(prPaths, {
    declaredPaths: snapshot.declared_paths,
    declaredGlobs: snapshot.declared_globs,
    denylist: issueDenylist,
    outOfScopeMessage: 'PR diff includes paths outside the committed declaration snapshot',
  });
}

function checkPrPathsAgainstLiveIssueScope(
  prPaths: string[],
  scope: {
    allowed_roots: string[];
    denylist: string[];
  },
): PrPathSnapshotCheckResult {
  const { declared_paths, declared_globs } =
    splitIssueAllowedRootsToDeclaredScope(scope.allowed_roots);
  return checkPrPathsAgainstDeclaredScope(prPaths, {
    declaredPaths: declared_paths,
    declaredGlobs: declared_globs,
    denylist: [...REPOSITORY_DENYLIST, ...scope.denylist],
    outOfScopeMessage:
      'PR diff includes paths outside the bound declaration-free live-Issue scope',
  });
}

function checkNoCeremonyPrScope(input: PrScopeCheckInput): PrScopeCheckResult {
  if (hasNoCeremonyIssueLink(input.prBody)) {
    return {
      ok: false,
      reason: 'skill_doc_with_issue_reference',
      message:
        'no-ceremony PRs must not link any GitHub issue in the PR description (closing keywords, Refs/See forms, bare #N, or github.com/.../issues/N URLs)',
    };
  }

  const pathCheck = classifyNoCeremonyPaths(input.prPaths);
  if (!pathCheck.ok) {
    if (pathCheck.invalidPaths.length > 0) {
      return {
        ok: false,
        reason: 'invalid_path',
        message: 'one or more PR diff paths failed normalization',
        violations: {
          outOfScope: [],
          denied: [],
          declarationErrors: [],
          invalidPaths: pathCheck.invalidPaths,
        },
      };
    }

    return {
      ok: false,
      reason: 'skill_doc_scope_violation',
      message:
        'no-ceremony PR diff includes paths outside the markdown union surface (spec-docs and skill instruction markdown; see docs/repository_policy.md)',
      violations: {
        outOfScope: pathCheck.outOfNoCeremonyMarkdown,
        denied: [],
        declarationErrors: [],
        invalidPaths: [],
      },
    };
  }

  return {
    ok: true,
    mode: 'no-ceremony',
    checkedPaths: pathCheck.checkedPaths,
    skippedControlArtifacts: [],
    unverifiedIssueConstraints: false,
    warnings: [],
  };
}

function checkSpecOnlyPrScope(input: PrScopeCheckInput): PrScopeCheckResult {
  if (hasClosingIssueReference(input.prBody)) {
    return {
      ok: false,
      reason: 'spec_only_with_closing_keyword',
      message:
        'spec-only PRs must not use GitHub closing keywords (Closes/Fixes/Resolves #N); use a non-closing reference such as Refs #N so the implementation issue stays open',
    };
  }
  const issueNumber = extractNonClosingIssueNumber(input.prBody);
  if (issueNumber === null) {
    return {
      ok: false,
      reason: 'missing_spec_issue_reference',
      message:
        'spec-only PR description must include a non-closing issue reference such as Refs #N (See #N and Related to #N are also accepted)',
    };
  }

  if (input.issueBody === null) {
    return {
      ok: false,
      reason: 'issue_unreadable',
      message: input.forkPr
        ? 'spec-only PR: linked issue could not be read (verify Refs #N refers to an open issue and workflow permissions allow gh issue view)'
        : `spec-only PR: linked issue #${issueNumber} could not be read (verify Refs #${issueNumber} refers to an existing issue)`,
    };
  }

  const pathCheck = classifySpecDocsPaths(input.prPaths);
  if (!pathCheck.ok) {
    if (pathCheck.invalidPaths.length > 0) {
      return {
        ok: false,
        reason: 'invalid_path',
        message: 'one or more PR diff paths failed normalization',
        violations: {
          outOfScope: [],
          denied: [],
          declarationErrors: [],
          invalidPaths: pathCheck.invalidPaths,
        },
      };
    }

    return {
      ok: false,
      reason: 'spec_docs_scope_violation',
      message:
        'spec-only PR diff includes paths outside the spec-docs allowlist (docs surfaces, or markdown-only under .claude/skills/** and .cursor/skills/**; see docs/repository_policy.md)',
      violations: {
        outOfScope: pathCheck.outOfAllowlist,
        denied: [],
        declarationErrors: [],
        invalidPaths: [],
      },
    };
  }

  return {
    ok: true,
    mode: 'spec-only',
    issueNumber,
    checkedPaths: pathCheck.checkedPaths,
    skippedControlArtifacts: [],
    unverifiedIssueConstraints: false,
    warnings: [],
  };
}

function checkDeclarationPaths(
  paths: string[],
  declaration: PrScopeDeclaration,
  selectedArtifactPath: string,
): PrPathSnapshotCheckResult {
  const outOfScope: string[] = [];
  const denied: string[] = [];
  const invalidPaths: Array<{ path: string; reason: string }> = [];
  const checkedPaths: string[] = [];
  const effectiveDenylist = [
    ...REPOSITORY_DENYLIST,
    ...declaration.denylist,
  ];

  for (const rawPath of paths) {
    const normalized = normalizeRepositoryPath(rawPath);
    if (!normalized.ok) {
      invalidPaths.push({ path: rawPath, reason: normalized.reason });
      continue;
    }
    checkedPaths.push(normalized.path);
    // Only the selected artifact is managed by this guard. Every other file
    // under docs/declarations is an ordinary changed path.
    if (normalized.path === selectedArtifactPath) continue;

    if (pathMatchesEntries(normalized.path, effectiveDenylist)) {
      denied.push(normalized.path);
      continue;
    }
    if (!pathMatchesEntries(normalized.path, declaration.allowed_roots)) {
      outOfScope.push(
        `${normalized.path} (outside allowed roots: ${declaration.allowed_roots.join(', ')})`,
      );
      continue;
    }
    if (!pathMatchesEntries(normalized.path, declaration.declared_paths)) {
      outOfScope.push(`${normalized.path} (outside declaration)`);
    }
  }

  if (invalidPaths.length > 0) {
    return {
      ok: false,
      reason: 'invalid_path',
      message: 'artifact-diff-mismatch: invalid changed path normalization',
      violations: { outOfScope, denied, declarationErrors: [], invalidPaths },
      checkedPaths,
      skippedControlArtifacts: [selectedArtifactPath],
    };
  }
  if (denied.length > 0) {
    return {
      ok: false,
      reason: 'scope_violation',
      message: `denylisted-path: ${denied.join(', ')}; exact path and denylist reason; remove or relocate`,
      violations: { outOfScope, denied, declarationErrors: [], invalidPaths: [] },
      checkedPaths,
      skippedControlArtifacts: [selectedArtifactPath],
    };
  }
  if (outOfScope.length > 0) {
    const hasRoot = outOfScope.some((path) => path.includes('(outside allowed roots:'));
    return {
      ok: false,
      reason: 'scope_violation',
      message: `${hasRoot ? 'out-of-root' : 'artifact-diff-mismatch'}: ${outOfScope.join(', ')}; exact path and reason; fix artifact or diff`,
      violations: { outOfScope, denied: [], declarationErrors: [], invalidPaths: [] },
      checkedPaths,
      skippedControlArtifacts: [selectedArtifactPath],
    };
  }
  return {
    ok: true,
    checkedPaths,
    skippedControlArtifacts: [selectedArtifactPath],
  };
}

function checkImplementationPrScope(
  input: PrScopeCheckInput,
  issueNumber: number,
): PrScopeCheckResult {
  if (input.issueBody === null) {
    return {
      ok: false,
      reason: 'issue_unreadable',
      message: 'issue_unreadable: linked issue body could not be read; retry command',
    };
  }

  let issueConstraints: ReturnType<typeof normalizeIssueConstraints>;
  try {
    issueConstraints = normalizeIssueConstraints(parseIssueBody(input.issueBody));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: 'issue_parse_error',
      message: `issue_parse_error: failed to parse linked issue constraints: ${message}`,
    };
  }

  const selected = selectDeclarationArtifact(input.repoRoot, issueNumber);
  if (!selected.ok) {
    if (selected.reason === 'missing') {
      const liveIssueScope = selectLiveIssueScope(
        input.issueBody,
        issueConstraints,
        {
          issueNumber,
          prNumber: input.prNumber,
          headSha: input.headSha,
        },
      );
      if (liveIssueScope.ok) {
        const pathCheck = checkPrPathsAgainstLiveIssueScope(
          input.prPaths,
          liveIssueScope,
        );
        if (!pathCheck.ok) {
          return {
            ok: false,
            reason: pathCheck.reason,
            message: pathCheck.message,
            violations: pathCheck.violations,
          };
        }

        return {
          ok: true,
          mode: 'implementation',
          scopeSource: 'live-issue',
          issueNumber,
          checkedPaths: pathCheck.checkedPaths,
          skippedControlArtifacts: pathCheck.skippedControlArtifacts,
          unverifiedIssueConstraints: false,
          warnings: [
            'declaration-free live-Issue scope selected; no declaration artifact was required',
          ],
        };
      }

      return {
        ok: false,
        reason: 'declaration-selection-failed',
        message: liveIssueScope.message,
        violations: {
          outOfScope: [],
          denied: [],
          declarationErrors: [liveIssueScope.message],
          invalidPaths: [],
        },
      };
    }

    return {
      ok: false,
      reason: 'declaration-selection-failed',
      message: selected.message,
      violations: {
        outOfScope: [],
        denied: [],
        declarationErrors: [selected.message],
        invalidPaths: [],
      },
    };
  }

  const declaration = selected.declaration;
  if (
    !policySubset(issueConstraints.denylist, declaration.denylist) ||
    (issueConstraints.allowed_roots !== undefined &&
      !policySubset(declaration.allowed_roots, issueConstraints.allowed_roots))
  ) {
    return {
      ok: false,
      reason: 'declaration-selection-failed',
      message:
        'policy-violation: declaration does not preserve the linked Issue denylist/root ceiling; remediation: fresh declaration',
      violations: {
        outOfScope: [],
        denied: [],
        declarationErrors: ['artifact policy is inconsistent with Issue fences'],
        invalidPaths: [],
      },
    };
  }

  const pathCheck = checkDeclarationPaths(
    input.prPaths,
    declaration,
    selected.path,
  );
  if (!pathCheck.ok) {
    return {
      ok: false,
      reason: pathCheck.reason,
      message: pathCheck.message,
      violations: pathCheck.violations,
    };
  }

  return {
    ok: true,
    mode: 'implementation',
    scopeSource: 'declaration',
    declarationPath: selected.path,
    issueNumber,
    checkedPaths: pathCheck.checkedPaths,
    skippedControlArtifacts: pathCheck.skippedControlArtifacts,
    unverifiedIssueConstraints: false,
    warnings: [],
  };
}

export function checkRuntimeHistoryDeliveryPrScope(
  input: PrScopeCheckInput,
): PrScopeCheckResult | null {
  const eligible =
    input.sameRepo === true &&
    input.forkPr === false &&
    input.prHeadRef === RUNTIME_HISTORY_DELIVERY_BRANCH;
  if (!eligible) {
    return null;
  }

  const normalizedPaths: string[] = [];
  const invalidPaths: Array<{ path: string; reason: string }> = [];
  for (const rawPath of input.prPaths) {
    const normalized = normalizePath(rawPath);
    if (!normalized.ok) {
      invalidPaths.push({ path: rawPath, reason: normalized.reason });
    } else {
      normalizedPaths.push(normalized.path);
    }
  }

  if (invalidPaths.length > 0) {
    return {
      ok: false,
      reason: 'invalid_path',
      message: 'one or more runtime-history delivery paths failed normalization',
      violations: {
        outOfScope: [],
        denied: [],
        declarationErrors: [],
        invalidPaths,
      },
    };
  }

  const unexpectedPaths = normalizedPaths.filter(
    (path) => path !== RUNTIME_HISTORY_DELIVERY_PATH,
  );
  if (
    normalizedPaths.length !== 1 ||
    normalizedPaths[0] !== RUNTIME_HISTORY_DELIVERY_PATH
  ) {
    return {
      ok: false,
      reason: 'scope_violation',
      message: `runtime-history delivery PR must change only ${RUNTIME_HISTORY_DELIVERY_PATH}`,
      violations: {
        outOfScope: unexpectedPaths.length > 0 ? unexpectedPaths : normalizedPaths,
        denied: [],
        declarationErrors: [],
        invalidPaths: [],
      },
    };
  }

  return {
    ok: true,
    mode: 'runtime-history-delivery',
    checkedPaths: normalizedPaths,
    skippedControlArtifacts: [],
    unverifiedIssueConstraints: false,
    warnings: [
      'closing issue reference exempted only for the same-repo fixed runtime-history delivery branch',
    ],
  };
}

function acquireRequiredDiff(input: PrScopeCheckInput):
  | { ok: true; paths: string[] }
  | { ok: false; message: string } {
  const base = input.baseSha?.trim();
  const head = input.headSha?.trim();
  if (!base && !head) {
    if (input.prPaths.length > 0) return { ok: true, paths: input.prPaths };
    return {
      ok: false,
      message: 'diff-incomplete: merge-base and PR head are unavailable; retry command',
    };
  }
  if (!base || !head) {
    return {
      ok: false,
      message: 'diff-incomplete: both verified base SHA and PR head SHA are required; retry command',
    };
  }

  const runGit = (args: string[]): string => {
    const result = runProcessSync({
      command: 'git',
      args,
      cwd: input.repoRoot,
      inheritParentEnv: true,
    });
    if (!result.ok) throw new Error(result.stderr || result.error || result.outcome);
    return result.stdout;
  };
  try {
    const mergeBases = runGit(['merge-base', '--all', base, head])
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (mergeBases.length !== 1) {
      return {
        ok: false,
        message: `diff-incomplete: expected one merge base for ${base} and ${head}, found ${mergeBases.length}; retry command`,
      };
    }
    const mergeBase = mergeBases[0]!;
    const ancestry = runProcessSync({
      command: 'git',
      args: ['merge-base', '--is-ancestor', mergeBase, head],
      cwd: input.repoRoot,
      inheritParentEnv: true,
    });
    if (!ancestry.ok) {
      throw new Error(ancestry.stderr || ancestry.error || ancestry.outcome);
    }
    const output = runGit([
      'diff',
      '--name-status',
      '--find-renames',
      mergeBase,
      head,
    ]).trim();
    if (!output) return { ok: true, paths: [] };

    const paths: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      const fields = line.split('\t');
      const status = fields[0] ?? '';
      if (/^[Rr]\d+$/.test(status)) {
        if (fields.length !== 3) {
          return { ok: false, message: `diff-incomplete: ambiguous rename row "${line}"; retry command` };
        }
        paths.push(fields[1]!, fields[2]!);
      } else if (/^[Cc]\d+$/.test(status)) {
        if (fields.length !== 3) {
          return { ok: false, message: `diff-incomplete: ambiguous copy row "${line}"; retry command` };
        }
        paths.push(fields[2]!);
      } else if (/^[AMD]$/.test(status)) {
        if (fields.length !== 2 || !fields[1]) {
          return { ok: false, message: `diff-incomplete: malformed status row "${line}"; retry command` };
        }
        paths.push(fields[1]);
      } else {
        return { ok: false, message: `diff-incomplete: unsupported status row "${line}"; retry command` };
      }
    }
    return { ok: true, paths };
  } catch (error) {
    return {
      ok: false,
      message: `diff-incomplete: git diff acquisition failed: ${error instanceof Error ? error.message : String(error)}; retry command`,
    };
  }
}

export function checkPrScope(input: PrScopeCheckInput): PrScopeCheckResult {
  const diff = acquireRequiredDiff(input);
  if (!diff.ok) {
    return { ok: false, reason: 'diff-incomplete', message: diff.message };
  }
  const effectiveInput = { ...input, prPaths: diff.paths };

  // Path-based no-ceremony wins over the spec-only signal: a markdown-only union diff
  // must reject issue links even when the body also carries <!-- pr-type: spec-only --> and Refs #N.
  if (isNoCeremonyPr(effectiveInput.prPaths)) {
    return checkNoCeremonyPrScope(effectiveInput);
  }

  if (hasSpecOnlySignal(effectiveInput.prBody)) {
    return checkSpecOnlyPrScope(effectiveInput);
  }

  const issueNumber = extractClosingIssueNumber(effectiveInput.prBody);
  if (issueNumber === null) {
    const runtimeHistoryDeliveryResult = checkRuntimeHistoryDeliveryPrScope(effectiveInput);
    if (runtimeHistoryDeliveryResult !== null) {
      return runtimeHistoryDeliveryResult;
    }
    return {
      ok: false,
      reason: 'missing_issue_link',
      message:
        'PR description must include a closing issue reference such as Closes #N, Fixes #N, or Resolves #N',
    };
  }

  return checkImplementationPrScope(effectiveInput, issueNumber);
}

export function formatScopeCheckComment(result: PrScopeCheckResult): string {
  if (result.ok) {
    if (result.mode === 'no-ceremony') {
      const lines = [
        '## Scope guard — passed (no-ceremony)',
        '',
        'No issue link, spec-only signal, or declaration snapshot required.',
        `Checked paths: ${result.checkedPaths.length} (spec-docs and/or skill instruction markdown only)`,
      ];
      for (const warning of result.warnings) {
        lines.push('', `> ${warning}`);
      }
      return lines.join('\n');
    }

    if (result.mode === 'runtime-history-delivery') {
      const lines = [
        '## Scope guard — passed (runtime-history delivery)',
        '',
        'Closing issue reference exempted for the same-repo fixed delivery branch.',
        `Checked paths: ${result.checkedPaths.length} (runtime-history artifact only)`,
      ];
      for (const warning of result.warnings) {
        lines.push('', `> ${warning}`);
      }
      return lines.join('\n');
    }

    if (result.mode === 'spec-only') {
      const lines = [
        '## Scope guard — passed (spec-only)',
        '',
        `Referenced issue: #${result.issueNumber} (non-closing; issue stays open on merge)`,
        `Checked paths: ${result.checkedPaths.length} (spec-docs allowlist)`,
      ];
      for (const warning of result.warnings) {
        lines.push('', `> ${warning}`);
      }
      return lines.join('\n');
    }

    const lines = [
      '## Scope guard — passed',
      '',
      ...(result.scopeSource === 'live-issue'
        ? ['Active scope: declaration-free live Issue']
        : result.declarationPath
          ? [`Active declaration: \`${result.declarationPath}\``]
          : result.snapshot
            ? [`Active snapshot: \`docs/declarations/${result.snapshot.issue_number}.${result.snapshot.iteration_id}.json\``]
            : ['Active declaration: _none_']),
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

  if (result.reason === 'missing_spec_issue_reference') {
    lines.push(
      '',
      'Spec-only PRs need a non-closing reference, for example:',
      '',
      '```',
      '<!-- pr-type: spec-only -->',
      '',
      'Refs #123',
      '```',
    );
  }

  if (result.reason === 'spec_only_with_closing_keyword') {
    lines.push(
      '',
      'Remove closing keywords (`Closes` / `Fixes` / `Resolves`) and use `Refs #N` instead.',
    );
  }

  if (
    result.reason === 'skill_doc_with_issue_reference' ||
    result.reason === 'skill_doc_with_closing_keyword'
  ) {
    lines.push(
      '',
      'Remove all issue links from the PR description. No-ceremony PRs must not use `Closes`/`Refs`/`#N`, or `github.com/.../issues/N` URLs.',
    );
  }

  if (result.reason === 'spec_docs_scope_violation') {
    lines.push(
      '',
      'Allowed paths for spec-only PRs:',
      ...SPEC_DOCS_ALLOWLIST.map((pattern) => `- \`${pattern}\``),
    );
  }

  if (result.reason === 'skill_doc_scope_violation') {
    lines.push(
      '',
      'No-ceremony PRs may change only markdown within:',
      ...NO_CEREMONY_MARKDOWN_GLOBS.map((pattern) => `- \`${pattern}\``),
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
  const parsed = JSON.parse(raw) as PrScopeCheckInput & { issueNumber?: number };
  if (!parsed.repoRoot || !Array.isArray(parsed.prPaths)) {
    throw new Error('input JSON must include repoRoot and prPaths');
  }
  if (typeof parsed.prBody !== 'string') {
    throw new Error('input JSON must include prBody');
  }
  return {
    repoRoot: parsed.repoRoot,
    prBody: parsed.prBody,
    issueBody: parsed.issueBody ?? null,
    prPaths: parsed.prPaths,
    degradedMode: Boolean(parsed.degradedMode),
    forkPr: Boolean(parsed.forkPr),
    prNumber: typeof parsed.prNumber === 'number' ? parsed.prNumber : undefined,
    prHeadRef: typeof parsed.prHeadRef === 'string' ? parsed.prHeadRef : '',
    sameRepo: Boolean(parsed.sameRepo),
    baseSha: typeof parsed.baseSha === 'string' ? parsed.baseSha : undefined,
    headSha: typeof parsed.headSha === 'string' ? parsed.headSha : undefined,
  };
}

export function runPrScopeCheckFromStdin(): PrScopeCheckResult {
  return checkPrScope(readJsonInput());
}

function isDirectExecution(): boolean {
  return process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/pr-scope-check.ts') ?? false;
}

if (isDirectExecution()) {
  try {
    if (process.argv.includes('--resolve-issue-number')) {
      const inputIndex = process.argv.indexOf('--input');
      const raw =
        inputIndex >= 0
          ? readFileSync(process.argv[inputIndex + 1] ?? '', 'utf8')
          : readFileSync(0, 'utf8');
      const parsed = JSON.parse(raw) as { prBody?: string };
      if (typeof parsed.prBody !== 'string') {
        throw new Error('input JSON must include prBody');
      }
      const issueNumber = resolveIssueNumberForFetch(parsed.prBody);
      process.stdout.write(`${JSON.stringify({ issueNumber })}\n`);
      process.exit(0);
    }

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