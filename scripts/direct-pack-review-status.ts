#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { resolve } from 'node:path';
import {
  createGithubReviewTransport,
  directReviewReconciliationRequiresDescendantFixFacts,
  parseDirectPackReviewEvidence,
  projectDirectPackReviewState,
  type GithubReviewSummary,
} from './lib/github-review-reconciliation.ts';
import {
  PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
  projectPackReviewSemanticStatus,
  projectRunnerPackReviewStatusFact,
  publishPackReviewRequiredStatus,
  semanticPackReviewRequiredStatusRequest,
  type PackReviewRequiredStatusRequest,
  type PackReviewSemanticSourceState,
} from './lib/pack-review-delivery.ts';
import { runProcessSync } from './kernel/subprocess.ts';
import { resolveTrackedGhWrapper } from './lib/gh-resolve-real-binary.mjs';

export interface DirectPackReviewStatusOptions {
  readonly repoRoot: string;
  readonly repoSlug: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly reviewId: string;
  readonly reviewHeadSha: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export interface DirectPackReviewStatusDependencies {
  readonly currentHead: () => string;
  readonly listReviews: () => Promise<readonly GithubReviewSummary[]>;
  readonly isAncestor: (ancestorSha: string, descendantSha: string) => boolean;
  readonly runnerStatus: () => PackReviewSemanticSourceState;
  readonly writeStatus: (request: PackReviewRequiredStatusRequest) => Promise<void>;
}

export type DirectPackReviewStatusResult =
  | { readonly ok: true; readonly skipped: true; readonly reason: string }
  | { readonly ok: true; readonly skipped: false; readonly projection: ReturnType<typeof projectPackReviewSemanticStatus> };

function normalizedSha(value: unknown): string {
  const sha = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(sha) ? sha : '';
}

function sameReviewIdentifier(left: unknown, right: unknown): boolean {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  return Boolean(a && a === b);
}

export function validateDirectPackReviewStatusOptions(options: DirectPackReviewStatusOptions): void {
  if (!options.repoSlug.includes('/')
      || !Number.isInteger(options.prNumber)
      || options.prNumber <= 0
      || !normalizedSha(options.headSha)
      || !normalizedSha(options.reviewHeadSha)
      || !options.reviewId.trim()) {
    throw new Error('direct_review_binding_invalid');
  }
}

export async function reconcileDirectPackReviewStatus(
  options: DirectPackReviewStatusOptions,
  deps: DirectPackReviewStatusDependencies,
): Promise<DirectPackReviewStatusResult> {
  validateDirectPackReviewStatusOptions(options);
  const eventHead = normalizedSha(options.headSha);
  const reviewHead = normalizedSha(options.reviewHeadSha);
  const currentHead = normalizedSha(deps.currentHead());
  if (!currentHead || currentHead !== eventHead || reviewHead !== eventHead) {
    return { ok: true, skipped: true, reason: 'direct_review_stale_publication_head' };
  }

  const reviews = [...await deps.listReviews()];
  const submitted = reviews.find((review) => sameReviewIdentifier(review.id, options.reviewId));
  const owner = options.repoSlug.split('/')[0] ?? '';
  if (!submitted || !parseDirectPackReviewEvidence(submitted, owner)) {
    return { ok: true, skipped: true, reason: 'review_not_canonical_direct_pack_review' };
  }

  const direct = projectDirectPackReviewState({
    reviews,
    repositoryOwnerLogin: owner,
    currentHeadSha: currentHead,
    workerLifecycle: '',
    requiredCiGreen: false,
    exactHeadSmokePassed: false,
    isAncestor: deps.isAncestor,
  });

  if (directReviewReconciliationRequiresDescendantFixFacts(direct)) {
    return { ok: true, skipped: true, reason: 'ancestor_blocker_requires_descendant_fix_facts' };
  }

  const projection = projectPackReviewSemanticStatus({
    runner: deps.runnerStatus(),
    direct: {
      hasLegitimateReview: direct.hasLegitimateReview,
      unresolvedBlockingFinding: direct.state === 'blocked',
    },
  });
  if (!options.dryRun) {
    await deps.writeStatus(semanticPackReviewRequiredStatusRequest({
      headSha: currentHead,
      projection,
    }));
  }
  return { ok: true, skipped: false, projection };
}

function githubApiObject(repoRoot: string, endpoint: string): Record<string, unknown> {
  const result = runProcessSync({
    command: resolveTrackedGhWrapper(),
    args: ['api', endpoint],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) {
    throw new Error(`GitHub API read failed for ${endpoint}: ${result.stderr || result.error || result.outcome}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`GitHub API read returned invalid JSON for ${endpoint}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`GitHub API read returned a non-object for ${endpoint}`);
  }
  return parsed as Record<string, unknown>;
}

function liveCurrentHead(options: DirectPackReviewStatusOptions): string {
  const pr = githubApiObject(options.repoRoot, `repos/${options.repoSlug}/pulls/${options.prNumber}`);
  const head = pr.head && typeof pr.head === 'object' && !Array.isArray(pr.head)
    ? (pr.head as Record<string, unknown>).sha
    : '';
  return normalizedSha(head);
}

function liveRunnerStatus(options: DirectPackReviewStatusOptions): PackReviewSemanticSourceState {
  const combined = githubApiObject(
    options.repoRoot,
    `repos/${options.repoSlug}/commits/${options.headSha}/status`,
  );
  const statuses = Array.isArray(combined.statuses)
    ? combined.statuses.filter((value): value is Record<string, unknown> =>
        Boolean(value && typeof value === 'object' && !Array.isArray(value)))
    : [];
  const current = statuses
    .filter((status) => String(status.context ?? '') === PACK_REVIEW_REQUIRED_STATUS_CONTEXT)
    .sort((left, right) =>
      Date.parse(String(right.updated_at ?? right.created_at ?? '')) -
      Date.parse(String(left.updated_at ?? left.created_at ?? '')))[0];
  return current
    ? projectRunnerPackReviewStatusFact(current.state, current.description)
    : { hasLegitimateReview: false, unresolvedBlockingFinding: false };
}

function liveIsAncestor(options: DirectPackReviewStatusOptions, ancestorSha: string, descendantSha: string): boolean {
  if (ancestorSha === descendantSha) return true;
  const comparison = githubApiObject(
    options.repoRoot,
    `repos/${options.repoSlug}/compare/${ancestorSha}...${descendantSha}`,
  );
  return String(comparison.status ?? '').trim().toLowerCase() === 'ahead';
}

export function parseDirectPackReviewStatusArgs(argv: readonly string[]): DirectPackReviewStatusOptions {
  const options: DirectPackReviewStatusOptions = {
    repoRoot: process.cwd(),
    repoSlug: '',
    prNumber: 0,
    headSha: '',
    reviewId: '',
    reviewHeadSha: '',
    dryRun: false,
    json: false,
  };
  const mutable = { ...options };
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--repo-root': mutable.repoRoot = resolve(argv[++index] ?? process.cwd()); break;
      case '--repo-slug': mutable.repoSlug = argv[++index] ?? ''; break;
      case '--pr': mutable.prNumber = Number.parseInt(argv[++index] ?? '', 10); break;
      case '--head-sha': mutable.headSha = argv[++index] ?? ''; break;
      case '--review-id': mutable.reviewId = argv[++index] ?? ''; break;
      case '--review-head-sha': mutable.reviewHeadSha = argv[++index] ?? ''; break;
      case '--dry-run': mutable.dryRun = true; break;
      case '--json': mutable.json = true; break;
      default: throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  validateDirectPackReviewStatusOptions(mutable);
  return mutable;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseDirectPackReviewStatusArgs(argv);
  const transport = createGithubReviewTransport({
    repoRoot: options.repoRoot,
    repoSlug: options.repoSlug,
    prNumber: options.prNumber,
  });
  const result = await reconcileDirectPackReviewStatus(options, {
    currentHead: () => liveCurrentHead(options),
    listReviews: () => transport.listReviews(),
    isAncestor: (ancestorSha, descendantSha) =>
      liveIsAncestor(options, ancestorSha, descendantSha),
    runnerStatus: () => liveRunnerStatus(options),
    writeStatus: async (request) => publishPackReviewRequiredStatus({
      repoRoot: options.repoRoot,
      repoSlug: options.repoSlug,
      headSha: options.headSha,
      request,
    }),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
