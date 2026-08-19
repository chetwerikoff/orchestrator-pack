import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import {
  currentWorkerAssignment,
  withCurrentWorkerAssignmentFence,
  type WorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import { resolveCurrentWorkerAssignmentTarget } from '../lib/worker-assignment-runtime.ts';
import { resolvePackReviewRunStoreRoot } from '../lib/pack-review-run-store.ts';
import { parseComplexityTierFence } from '../lib/tier-gate-core.ts';
import { readPackReviewAuthority } from '../pack-review-state.ts';
import { sameRuntimeWorker, type RuntimeAdapter } from '../runtime/contracts.ts';
import {
  exactClosingIssue,
  resolveCiGreen,
  runSmokeAttempt,
  type CliOptions,
  type SmokeStartFenceResult,
} from '../worker-smoke-run.ts';

export interface PostReviewSmokeCandidate {
  readonly repoSlug: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly prBody: string;
}

export interface PostReviewSmokeOutcome {
  readonly handled: boolean;
  readonly attempted: boolean;
  readonly reason: string;
  readonly exitCode?: number;
}

export interface PostReviewSmokeDependencies {
  readonly projectId: string;
  readonly repoRoot: string;
  readonly assignmentStorePath: string;
  readonly adapter: RuntimeAdapter;
  readonly env?: NodeJS.ProcessEnv;
  readonly ciGreen?: typeof resolveCiGreen;
  readonly runAttempt?: typeof runSmokeAttempt;
  readonly readIssueBody?: (issueNumber: number, repository: string) => Promise<string>;
}

function exactAssignment(left: WorkerAssignment, right: WorkerAssignment): boolean {
  return left.assignmentId === right.assignmentId
    && left.generation === right.generation
    && left.issueNumber === right.issueNumber
    && left.taskId === right.taskId
    && left.kind === right.kind
    && left.provider === right.provider
    && left.bindingKey === right.bindingKey;
}

async function defaultReadIssueBody(
  repoRoot: string,
  issueNumber: number,
  repository: string,
): Promise<string> {
  const result = await runProcess({
    command: path.join(repoRoot, 'scripts', 'gh'),
    args: ['issue', 'view', String(issueNumber), '--repo', repository, '--json', 'body'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    throw new Error(`post_review_smoke_issue_unavailable:${result.stderr || result.error || result.exitCode}`);
  }
  const parsed = JSON.parse(result.stdout) as { body?: unknown };
  return String(parsed.body ?? '');
}

function reviewStageDisposition(input: {
  prNumber: number;
  headSha: string;
  projectId: string;
  env: NodeJS.ProcessEnv;
}): { kind: 'review_pending' | 'smoke_blocked' | 'smoke_candidate'; reason: string } {
  const storeRoot = resolvePackReviewRunStoreRoot({
    projectId: input.projectId,
    storeRoot: input.env.PACK_REVIEW_RUN_STORE_ROOT,
  });
  const authority = readPackReviewAuthority(input.prNumber, { storeRoot });
  if (!authority || authority.currentHeadSha !== input.headSha) {
    return { kind: 'review_pending', reason: 'review_authority_missing_or_stale' };
  }
  if (authority.cycle?.reviewStageComplete !== true) {
    return { kind: 'review_pending', reason: 'review_stage_incomplete' };
  }
  if (authority.cycle.state !== 'closed'
      || authority.terminal?.targetSha !== input.headSha
      || authority.terminal.reviewVerdict !== 'clean'
      || authority.smokeOrdering?.reviewSettledHeadSha !== input.headSha) {
    return { kind: 'smoke_blocked', reason: 'review_stage_complete_without_clean_terminal' };
  }
  const independent = authority.smokeOrdering?.independent;
  if (independent?.headSha === input.headSha) {
    if (independent.status === 'started') {
      return { kind: 'smoke_blocked', reason: 'independent_smoke_in_progress' };
    }
    if (independent.status === 'passed') {
      return { kind: 'smoke_blocked', reason: 'independent_smoke_already_passed' };
    }
    if (independent.status === 'failed' && independent.failureKind === 'finding') {
      return { kind: 'smoke_blocked', reason: 'independent_smoke_finding_requires_new_head' };
    }
  }
  return { kind: 'smoke_candidate', reason: 'clean_review_stage_complete' };
}

export async function reconcilePostReviewSmoke(
  candidate: PostReviewSmokeCandidate,
  dependencies: PostReviewSmokeDependencies,
): Promise<PostReviewSmokeOutcome> {
  const headSha = candidate.headSha.trim().toLowerCase();
  const env = dependencies.env ?? process.env;
  let disposition: ReturnType<typeof reviewStageDisposition>;
  try {
    disposition = reviewStageDisposition({
      prNumber: candidate.prNumber,
      headSha,
      projectId: dependencies.projectId,
      env,
    });
  } catch (error) {
    return {
      handled: true,
      attempted: false,
      reason: `review_authority_untrusted:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (disposition.kind === 'review_pending') {
    return { handled: false, attempted: false, reason: disposition.reason };
  }
  if (disposition.kind === 'smoke_blocked') {
    return { handled: true, attempted: false, reason: disposition.reason };
  }

  const issueNumber = exactClosingIssue(candidate.prBody);
  if (!issueNumber) {
    return { handled: true, attempted: false, reason: 'post_review_smoke_issue_binding_unresolved' };
  }

  let expected = currentWorkerAssignment(dependencies.assignmentStorePath, issueNumber);
  if (!expected) {
    return { handled: true, attempted: false, reason: 'post_review_smoke_assignment_missing_or_untrusted' };
  }
  if (expected.kind !== 'local') {
    return { handled: true, attempted: false, reason: 'post_review_smoke_remote_assignment_requires_local_reassignment' };
  }
  const initialTarget = resolveCurrentWorkerAssignmentTarget({
    file: dependencies.assignmentStorePath,
    expected,
    adapter: dependencies.adapter,
  });
  if (initialTarget.status !== 'resolved') {
    return { handled: true, attempted: false, reason: `post_review_smoke_target_${initialTarget.status}` };
  }

  const ciGreen = dependencies.ciGreen ?? resolveCiGreen;
  if (!ciGreen(
    candidate.prNumber,
    headSha,
    candidate.repoSlug,
    initialTarget.worker.workspacePath,
  )) {
    return { handled: true, attempted: false, reason: 'post_review_smoke_required_ci_not_green' };
  }

  let issueBody: string;
  try {
    issueBody = dependencies.readIssueBody
      ? await dependencies.readIssueBody(issueNumber, candidate.repoSlug)
      : await defaultReadIssueBody(dependencies.repoRoot, issueNumber, candidate.repoSlug);
  } catch (error) {
    return {
      handled: true,
      attempted: false,
      reason: error instanceof Error ? error.message : 'post_review_smoke_issue_unavailable',
    };
  }
  const tier = parseComplexityTierFence(issueBody);
  if (tier.kind !== 'tier-fence') {
    return { handled: true, attempted: false, reason: 'post_review_smoke_tier_unresolved' };
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), 'opk-post-review-smoke-'));
  const issueBodyFile = path.join(tempRoot, 'issue.md');
  writeFileSync(issueBodyFile, issueBody, 'utf8');
  let smokeActionEntered = false;
  const startFence = async <T>(action: () => T | Promise<T>): Promise<SmokeStartFenceResult<T>> => {
    const fenced = await withCurrentWorkerAssignmentFence(
      dependencies.assignmentStorePath,
      expected!,
      async () => {
        const current = currentWorkerAssignment(dependencies.assignmentStorePath, issueNumber);
        if (!current || !exactAssignment(current, expected!)) {
          return { kind: 'preaction_failed' as const, reason: 'assignment_stale' };
        }
        const target = resolveCurrentWorkerAssignmentTarget({
          file: dependencies.assignmentStorePath,
          expected: current,
          adapter: dependencies.adapter,
        });
        if (target.status !== 'resolved') {
          return { kind: 'preaction_failed' as const, reason: `target_${target.status}` };
        }
        if (!sameRuntimeWorker(target.worker.identity, initialTarget.worker.identity)
            || target.worker.workspacePath !== initialTarget.worker.workspacePath) {
          return { kind: 'preaction_failed' as const, reason: 'runtime_binding_changed' };
        }
        smokeActionEntered = true;
        return { kind: 'value' as const, value: await action() };
      },
    );
    if (!fenced.ok) {
      return { ok: false, reason: fenced.reason, actionEntered: smokeActionEntered };
    }
    if (fenced.value.kind === 'preaction_failed') {
      return { ok: false, reason: fenced.value.reason, actionEntered: false };
    }
    return { ok: true, value: fenced.value.value };
  };

  const options: CliOptions = {
    command: 'run',
    issueNumber,
    prNumber: candidate.prNumber,
    headSha,
    issueBodyFile,
    smokeComplexity: tier.tier === 'T3' ? 'complex' : 'routine',
    smokeActor: 'independent',
    repoRoot: initialTarget.worker.workspacePath,
    cwd: initialTarget.worker.workspacePath,
    dryRun: false,
    json: true,
  };

  try {
    const runAttempt = dependencies.runAttempt ?? runSmokeAttempt;
    const exitCode = await runAttempt(options, {
      adapter: dependencies.adapter,
      startFence,
    });
    if (!smokeActionEntered) {
      return {
        handled: true,
        attempted: false,
        reason: exitCode === 0 ? 'post_review_smoke_not_attempted' : 'post_review_smoke_preaction_failed',
        exitCode,
      };
    }
    return {
      handled: true,
      attempted: true,
      reason: exitCode === 0 ? 'post_review_smoke_completed' : 'post_review_smoke_failed',
      exitCode,
    };
  } catch (error) {
    return {
      handled: true,
      attempted: smokeActionEntered,
      reason: `post_review_smoke_error:${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
