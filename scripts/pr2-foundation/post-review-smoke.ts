import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import {
  currentWorkerAssignment,
  withCurrentWorkerAssignmentFence,
  type WorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import {
  bindingForIssue,
  resolveCurrentWorkerAssignmentBindings,
  type ResolvedWorkerAssignment,
} from '../lib/worker-assignment-runtime.ts';
import { resolvePackReviewRunStoreRoot } from '../lib/pack-review-run-store.ts';
import { parseComplexityTierFence } from '../lib/tier-gate-core.ts';
import {
  assertIndependentSmokeAdmission,
  readPackReviewAuthority,
  stagePackReviewImmutableRecord,
} from '../pack-review-state.ts';
import { sameRuntimeWorker, type RuntimeAdapter } from '../runtime/contracts.ts';
import {
  exactClosingIssue,
  resolveCiGreen,
  runSmokeAttempt,
  type CliOptions,
  type SmokeStartFenceResult,
} from '../worker-smoke-run.ts';

const REMOTE_ACTUATION_REASON = 'remote_assignment_no_runtime_managed_local_workspace';

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

type IssueBindingResolution =
  | { readonly status: 'resolved'; readonly binding: ResolvedWorkerAssignment }
  | { readonly status: 'assignment_untrusted' | 'runtime_unavailable' | 'target_unresolved' };

type RemoteActuationEvidenceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

function exactAssignment(left: WorkerAssignment, right: WorkerAssignment): boolean {
  return left.assignmentId === right.assignmentId
    && left.generation === right.generation
    && left.issueNumber === right.issueNumber
    && left.taskId === right.taskId
    && left.kind === right.kind
    && left.provider === right.provider
    && left.bindingKey === right.bindingKey;
}

function recordRemoteActuationNotApplicable(input: {
  projectId: string;
  env: NodeJS.ProcessEnv;
  repository: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  assignment: WorkerAssignment;
}): RemoteActuationEvidenceResult {
  if (input.assignment.kind !== 'remote') {
    return { ok: false, reason: 'assignment_not_remote' };
  }
  const storeRoot = resolvePackReviewRunStoreRoot({
    projectId: input.projectId,
    storeRoot: input.env.PACK_REVIEW_RUN_STORE_ROOT,
  });
  const key = [
    'local-smoke-na',
    `pr-${input.prNumber}`,
    input.headSha,
    input.assignment.assignmentId,
    `g-${input.assignment.generation}`,
  ].join('-');
  try {
    stagePackReviewImmutableRecord({
      kind: 'evidence',
      key,
      value: {
        schema: 'local-smoke-actuation/v1',
        disposition: 'not_applicable',
        reason: REMOTE_ACTUATION_REASON,
        repository: input.repository,
        issueNumber: input.issueNumber,
        prNumber: input.prNumber,
        headSha: input.headSha,
        assignment: {
          assignmentId: input.assignment.assignmentId,
          generation: input.assignment.generation,
          kind: 'remote',
          provider: input.assignment.provider,
        },
      },
      options: { storeRoot },
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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
  const independent = authority.smokeOrdering?.independent;
  if (independent?.headSha === input.headSha) {
    if (independent.status === 'started') {
      return { kind: 'smoke_blocked', reason: 'independent_smoke_in_progress' };
    }
    if (independent.status === 'passed') {
      return { kind: 'smoke_blocked', reason: 'independent_smoke_already_passed' };
    }
    if (independent.status === 'failed'
        && independent.failureKind === 'finding'
        && independent.failureHeadSha === input.headSha) {
      return { kind: 'smoke_blocked', reason: 'independent_smoke_finding_requires_new_head' };
    }
  }
  try {
    assertIndependentSmokeAdmission({ authority, headSha: input.headSha });
  } catch (error) {
    return {
      kind: 'smoke_blocked',
      reason: `independent_smoke_admission_blocked:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { kind: 'smoke_candidate', reason: 'review_stage_complete_smoke_admitted' };
}

function resolveIssueBinding(input: {
  file: string;
  repository: string;
  issueNumber: number;
  adapter: RuntimeAdapter;
}): IssueBindingResolution {
  const resolution = resolveCurrentWorkerAssignmentBindings({
    file: input.file,
    repository: input.repository,
    adapter: input.adapter,
  });
  if (resolution.status !== 'ok') return { status: resolution.status };
  const binding = bindingForIssue(resolution.bindings, input.issueNumber);
  if (!binding) return { status: 'target_unresolved' };
  return { status: 'resolved', binding };
}

export async function reconcilePostReviewSmoke(
  candidate: PostReviewSmokeCandidate,
  dependencies: PostReviewSmokeDependencies,
): Promise<PostReviewSmokeOutcome> {
  const headSha = candidate.headSha.trim().toLowerCase();
  const repository = candidate.repoSlug.trim().toLowerCase();
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

  const current = currentWorkerAssignment(dependencies.assignmentStorePath, issueNumber);
  if (!current) {
    return { handled: true, attempted: false, reason: 'post_review_smoke_assignment_missing_or_untrusted' };
  }
  if (current.repository !== repository || current.issueNumber !== issueNumber) {
    return { handled: true, attempted: false, reason: 'post_review_smoke_assignment_repository_or_issue_mismatch' };
  }

  const ciGreen = dependencies.ciGreen ?? resolveCiGreen;
  if (!ciGreen(candidate.prNumber, headSha, repository, dependencies.repoRoot)) {
    return { handled: true, attempted: false, reason: 'post_review_smoke_required_ci_not_green' };
  }

  if (current.kind !== 'local') {
    const recorded = recordRemoteActuationNotApplicable({
      projectId: dependencies.projectId,
      env,
      repository,
      issueNumber,
      prNumber: candidate.prNumber,
      headSha,
      assignment: current,
    });
    if (!recorded.ok) {
      return {
        handled: true,
        attempted: false,
        reason: `post_review_smoke_remote_disposition_unrecorded:${recorded.reason}`,
      };
    }
    return { handled: true, attempted: false, reason: 'post_review_smoke_remote_assignment_requires_local_reassignment' };
  }

  const initial = resolveIssueBinding({
    file: dependencies.assignmentStorePath,
    repository,
    issueNumber,
    adapter: dependencies.adapter,
  });
  if (initial.status !== 'resolved') {
    return { handled: true, attempted: false, reason: `post_review_smoke_target_${initial.status}` };
  }
  const expected = initial.binding.assignment;
  if (!exactAssignment(current, expected)) {
    return { handled: true, attempted: false, reason: 'post_review_smoke_assignment_binding_ambiguous' };
  }

  let issueBody: string;
  try {
    issueBody = dependencies.readIssueBody
      ? await dependencies.readIssueBody(issueNumber, repository)
      : await defaultReadIssueBody(dependencies.repoRoot, issueNumber, repository);
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
  const injectedIssueBodyResolver = dependencies.readIssueBody
    ? (smokeOptions: CliOptions, suppliedBody: string): string => {
      if (smokeOptions.issueNumber !== issueNumber
          || smokeOptions.prNumber !== candidate.prNumber
          || smokeOptions.headSha.trim().toLowerCase() !== headSha
          || smokeOptions.repoRoot !== initial.binding.worker.workspacePath
          || smokeOptions.cwd !== initial.binding.worker.workspacePath
          || suppliedBody !== issueBody) {
        throw new Error('post_review_smoke_injected_target_mismatch');
      }
      return issueBody;
    }
    : undefined;
  let smokeActionEntered = false;
  let remoteAssignmentObserved: WorkerAssignment | undefined;
  const startFence = async <T>(action: () => T | Promise<T>): Promise<SmokeStartFenceResult<T>> => {
    const fenced = await withCurrentWorkerAssignmentFence(
      dependencies.assignmentStorePath,
      expected,
      async () => {
        const currentInsideFence = currentWorkerAssignment(dependencies.assignmentStorePath, issueNumber);
        if (!currentInsideFence || !exactAssignment(currentInsideFence, expected)) {
          return { kind: 'preaction_failed' as const, reason: 'assignment_stale' };
        }
        if (currentInsideFence.repository !== repository || currentInsideFence.kind !== 'local') {
          return { kind: 'preaction_failed' as const, reason: 'assignment_scope_changed' };
        }
        const rebound = resolveIssueBinding({
          file: dependencies.assignmentStorePath,
          repository,
          issueNumber,
          adapter: dependencies.adapter,
        });
        if (rebound.status !== 'resolved') {
          return { kind: 'preaction_failed' as const, reason: `target_${rebound.status}` };
        }
        if (!exactAssignment(rebound.binding.assignment, expected)
            || !sameRuntimeWorker(rebound.binding.worker.identity, initial.binding.worker.identity)
            || rebound.binding.worker.workspacePath !== initial.binding.worker.workspacePath) {
          return { kind: 'preaction_failed' as const, reason: 'runtime_binding_changed' };
        }
        smokeActionEntered = true;
        return { kind: 'value' as const, value: await action() };
      },
    );
    if (!fenced.ok) {
      if (!smokeActionEntered && fenced.reason === 'assignment_stale') {
        const latest = currentWorkerAssignment(dependencies.assignmentStorePath, issueNumber);
        if (latest?.repository === repository && latest.issueNumber === issueNumber && latest.kind === 'remote') {
          const recorded = recordRemoteActuationNotApplicable({
            projectId: dependencies.projectId,
            env,
            repository,
            issueNumber,
            prNumber: candidate.prNumber,
            headSha,
            assignment: latest,
          });
          if (!recorded.ok) {
            return {
              ok: false,
              reason: `remote_disposition_unrecorded:${recorded.reason}`,
              actionEntered: false,
            };
          }
          remoteAssignmentObserved = latest;
          return {
            ok: false,
            reason: 'remote_assignment_requires_local_reassignment',
            actionEntered: false,
          };
        }
      }
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
    repoRoot: initial.binding.worker.workspacePath,
    cwd: initial.binding.worker.workspacePath,
    dryRun: false,
    json: true,
    reviewId: '',
    reviewHeadSha: '',
  };

  try {
    const runAttempt = dependencies.runAttempt ?? runSmokeAttempt;
    const exitCode = await runAttempt(options, {
      adapter: dependencies.adapter,
      startFence,
      ...(injectedIssueBodyResolver ? { resolveIssueBody: injectedIssueBodyResolver } : {}),
    });
    if (!smokeActionEntered) {
      return {
        handled: true,
        attempted: false,
        reason: remoteAssignmentObserved
          ? 'post_review_smoke_remote_assignment_requires_local_reassignment'
          : exitCode === 0
            ? 'post_review_smoke_not_attempted'
            : 'post_review_smoke_preaction_failed',
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
