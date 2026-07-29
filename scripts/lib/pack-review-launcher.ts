import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../kernel/subprocess.ts';
import { resolvePackRepoRoot } from './pack-pr-review-contract.ts';
import { isProducerGroundedProvenNonDelivery } from './pack-review-proven-non-delivery.ts';
import {
  acquirePackReviewStageClaim,
  establishPriorTurnState,
  extractPackReviewStageFields,
  PACK_REVIEW_STAGE,
  readPackReviewStageClaim,
  resolvePackReviewStageClaimNamespace,
  updatePackReviewStageClaimFields,
  type EstablishedPriorTurnState,
  type PackReviewStageClaimFields,
} from './pack-review-stage-claim.ts';
import type { ClaimResult } from './review-start-claim-store.ts';

export type CallerObservationClass = 'A1' | 'A2' | 'A3' | 'A4';
export type CallerClass = 'worker' | 'operator' | 'fanout';
export type LauncherDisposition =
  | 'started'
  | 'adopted'
  | 'recovery'
  | 'consumed'
  | 'recovery_required'
  | 'ambiguous_claim'
  | 'pre_claim_error';

export interface PackReviewLauncherResult {
  disposition: LauncherDisposition;
  prNumber: number;
  headSha: string;
  stage: typeof PACK_REVIEW_STAGE;
  newChatSendCount: number;
  claimPath?: string;
  claimKey?: string;
  invocationId?: string;
  chatUrl?: string;
  replyPath?: string;
  workDir?: string;
  childPid?: number;
  establishedState?: EstablishedPriorTurnState;
  error?: string;
  detail?: string;
}

export interface PrResolution {
  repoSlug: string;
  prNumber: number;
  headSha: string;
  state: 'OPEN' | 'CLOSED';
}

export interface PackReviewLauncherDependencies {
  resolvePr: (repoRoot: string, prNumber: number, expectedHead?: string) => Promise<PrResolution>;
  acquireClaim: typeof acquirePackReviewStageClaim;
  readClaim: typeof readPackReviewStageClaim;
  spawnDetachedReview: (input: DetachedReviewSpawnInput) => Promise<{ childPid: number; workDir: string }>;
  runBrowserSend?: (input: BrowserSendInput) => Promise<BrowserSendResult>;
  childAlive?: (pid: number) => boolean;
  replyExists?: (path: string) => boolean;
  now?: () => number;
}

export interface DetachedReviewSpawnInput {
  repoRoot: string;
  repoSlug: string;
  prNumber: number;
  headSha: string;
  claim: ClaimResult;
  workDir: string;
  surface: string;
}

export interface BrowserSendInput {
  repoRoot: string;
  repoSlug: string;
  prNumber: number;
  headSha: string;
  claim: ClaimResult;
  workDir: string;
}

export interface BrowserSendResult {
  invocationId?: string;
  chatUrl?: string;
  replyPath?: string;
  turnState: PackReviewStageClaimFields['turnState'];
  childPid?: number;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function resultBase(
  disposition: LauncherDisposition,
  pr: PrResolution,
  establishedState?: EstablishedPriorTurnState,
  extra: Partial<PackReviewLauncherResult> = {},
): PackReviewLauncherResult {
  return {
    disposition,
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    stage: PACK_REVIEW_STAGE,
    newChatSendCount: 0,
    establishedState,
    ...extra,
  };
}

export function decideLauncherAction(input: {
  observation: CallerObservationClass;
  established: EstablishedPriorTurnState;
  caller: CallerClass;
  provenNonDelivery?: boolean;
}): { disposition: LauncherDisposition; allowSend: boolean } {
  void input.caller;
  const { observation, established } = input;
  if (established === 'unknown') {
    if (observation === 'A2' || observation === 'A4') {
      return { disposition: 'recovery_required', allowSend: false };
    }
    return { disposition: 'ambiguous_claim', allowSend: false };
  }
  switch (established) {
    case 'B1':
    case 'B5':
      return { disposition: 'started', allowSend: true };
    case 'B2':
      return { disposition: 'adopted', allowSend: false };
    case 'B3':
      return { disposition: 'recovery', allowSend: false };
    case 'B4':
      return { disposition: 'consumed', allowSend: false };
    default:
      return { disposition: 'recovery_required', allowSend: false };
  }
}

export async function defaultResolvePr(
  repoRoot: string,
  prNumber: number,
  expectedHead?: string,
): Promise<PrResolution> {
  const slugResult = await runProcess({
    command: 'gh',
    args: ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  if (!slugResult.ok) {
    throw new Error(`gh_repo_resolution_failed:${trim(slugResult.stderr || slugResult.error)}`);
  }
  const repoSlug = trim(slugResult.stdout);
  const prResult = await runProcess({
    command: 'gh',
    args: ['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'headRefOid,state', '--jq', '{head:.headRefOid,state:.state}'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  if (!prResult.ok) {
    throw new Error(`gh_pr_resolution_failed:${trim(prResult.stderr || prResult.error)}`);
  }
  const parsed = JSON.parse(prResult.stdout) as { head?: string; state?: string };
  const headSha = trim(parsed.head).toLowerCase();
  const state = trim(parsed.state).toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED';
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('invalid_head_sha');
  }
  if (expectedHead && expectedHead.toLowerCase() !== headSha) {
    throw new Error('stale_head_guard');
  }
  return { repoSlug, prNumber, headSha, state };
}

export function launcherWorkerScriptPath(): string {
  return join(fileURLToPath(new URL('.', import.meta.url)), 'pack-review-launcher-worker.ts');
}

export async function defaultSpawnDetachedReview(input: DetachedReviewSpawnInput): Promise<{ childPid: number; workDir: string }> {
  mkdirSync(input.workDir, { recursive: true });
  const markerPath = join(input.workDir, 'launcher-started.json');
  const packRoot = resolvePackRepoRoot();
  const workerScript = launcherWorkerScriptPath();
  const logPath = join(input.workDir, 'worker.log');
  const nodeArgs = [
    '--experimental-strip-types',
    workerScript,
    '--repo-root', input.repoRoot,
    '--repo-slug', input.repoSlug,
    '--pr-number', String(input.prNumber),
    '--head-sha', input.headSha,
    '--claim-path', String(input.claim.path),
    '--work-dir', input.workDir,
    '--surface', input.surface,
  ];
  const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const launchCommand = [
    'nohup',
    shellQuote(process.execPath),
    ...nodeArgs.map(shellQuote),
    '</dev/null',
    '>>',
    shellQuote(logPath),
    '2>&1',
    '&',
    'echo',
    '$!',
  ].join(' ');
  const launched = await runProcess({
    command: 'bash',
    args: ['-lc', launchCommand],
    cwd: packRoot,
    inheritParentEnv: true,
    env: {
      ...process.env,
      OPK_PACK_REVIEW_LAUNCHER_WORKER: '1',
    },
    allowEmptyStdout: false,
    timeoutMs: 15_000,
  });
  if (!launched.ok) {
    throw new Error(trim(launched.stderr || launched.error || 'detached_launch_failed'));
  }
  const childPid = Number(trim(launched.stdout).split(/\s+/).pop());
  if (!Number.isInteger(childPid) || childPid <= 0) {
    throw new Error('detached_launch_missing_pid');
  }
  writeFileSync(markerPath, JSON.stringify({
    childPid,
    startedAtUtc: new Date().toISOString(),
    claimPath: input.claim.path,
  }), 'utf8');
  updatePackReviewStageClaimFields(input.claim, {
    turnState: 'live',
    childPid,
    workDir: input.workDir,
  });
  return { childPid, workDir: input.workDir };
}

export async function launchPackReviewChat(input: {
  repoRoot?: string;
  prNumber: number;
  headSha?: string;
  surface?: string;
  caller?: CallerClass;
  observation?: CallerObservationClass;
  projectId?: string;
  namespace?: string;
  deps?: Partial<PackReviewLauncherDependencies>;
}): Promise<PackReviewLauncherResult> {
  const repoRoot = input.repoRoot ?? process.cwd();
  const deps: PackReviewLauncherDependencies = {
    resolvePr: defaultResolvePr,
    acquireClaim: acquirePackReviewStageClaim,
    readClaim: readPackReviewStageClaim,
    spawnDetachedReview: defaultSpawnDetachedReview,
    childAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    replyExists: (path) => existsSync(path),
    now: () => Date.now(),
    ...input.deps,
  };
  const caller = input.caller ?? 'worker';
  const observation = input.observation ?? 'A1';
  const surface = trim(input.surface) || `pack-review-launcher-${caller}`;

  let pr: PrResolution;
  try {
    pr = await deps.resolvePr(repoRoot, input.prNumber, input.headSha);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      disposition: 'pre_claim_error',
      prNumber: input.prNumber,
      headSha: trim(input.headSha).toLowerCase(),
      stage: PACK_REVIEW_STAGE,
      newChatSendCount: 0,
      error: message.split(':')[0] ?? 'pre_claim_error',
      detail: message,
    };
  }

  if (pr.state !== 'OPEN') {
    return resultBase('pre_claim_error', pr, undefined, { error: 'pr_not_open' });
  }

  const namespace = resolvePackReviewStageClaimNamespace({ projectId: input.projectId, namespace: input.namespace });
  const claimRead = deps.readClaim(namespace, pr.prNumber, pr.headSha);
  const established = establishPriorTurnState({
    claimRead,
    childAlive: deps.childAlive,
    replyExists: deps.replyExists,
  });

  const decision = decideLauncherAction({
    observation,
    established,
    caller,
    provenNonDelivery: claimRead.ok
      ? isProducerGroundedProvenNonDelivery({
        ...(extractPackReviewStageFields(claimRead.record)?.provenNonDelivery ?? {}),
        remediationCompleted: extractPackReviewStageFields(claimRead.record)?.remediationCompleted,
      })
      : false,
  });

  if (!decision.allowSend) {
    const fields = claimRead.ok ? extractPackReviewStageFields(claimRead.record) : null;
    return resultBase(decision.disposition, pr, established, {
      claimPath: claimRead.path,
      claimKey: claimRead.ok ? claimRead.record.key : undefined,
      invocationId: fields?.invocationId,
      chatUrl: fields?.chatUrl,
      replyPath: fields?.replyPath,
      workDir: fields?.workDir,
      childPid: fields?.childPid,
    });
  }

  if (established === 'B5' && claimRead.ok) {
    rmSync(claimRead.path, { force: true });
  }

  const claim = deps.acquireClaim({
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    surface,
    projectId: input.projectId,
    namespace,
    startReason: 'pack-review-chat-launch',
  });

  if (!claim.acquired) {
    const reread = deps.readClaim(namespace, pr.prNumber, pr.headSha);
    const restablished = establishPriorTurnState({
      claimRead: reread,
      childAlive: deps.childAlive,
      replyExists: deps.replyExists,
    });
    const adopt = decideLauncherAction({ observation, established: restablished, caller });
    const fields = reread.ok ? extractPackReviewStageFields(reread.record) : null;
    return resultBase(adopt.disposition, pr, restablished, {
      claimPath: reread.path,
      claimKey: reread.ok ? reread.record.key : undefined,
      invocationId: fields?.invocationId,
      chatUrl: fields?.chatUrl,
      replyPath: fields?.replyPath,
      workDir: fields?.workDir,
      childPid: fields?.childPid,
      detail: trim(claim.reason),
    });
  }

  const workDir = join(namespace, 'work', `${pr.prNumber}-${pr.headSha.slice(0, 12)}-${deps.now?.() ?? Date.now()}`);
  const spawned = await deps.spawnDetachedReview({
    repoRoot,
    repoSlug: pr.repoSlug,
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    claim,
    workDir,
    surface,
  });

  return resultBase('started', pr, established === 'B5' ? 'B5' : 'B1', {
    newChatSendCount: 1,
    claimPath: claim.path,
    claimKey: claim.key,
    workDir: spawned.workDir,
    childPid: spawned.childPid,
  });
}

export async function consultPackReviewStageBeforeBrowserSend(input: {
  prNumber: number;
  headSha: string;
  projectId?: string;
  namespace?: string;
  deps?: Partial<PackReviewLauncherDependencies>;
}): Promise<{ allowSend: boolean; result: PackReviewLauncherResult }> {
  const namespace = resolvePackReviewStageClaimNamespace({ projectId: input.projectId, namespace: input.namespace });
  const deps: PackReviewLauncherDependencies = {
    resolvePr: defaultResolvePr,
    acquireClaim: acquirePackReviewStageClaim,
    readClaim: readPackReviewStageClaim,
    spawnDetachedReview: async () => ({ childPid: 0, workDir: '' }),
    childAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
    replyExists: (path) => existsSync(path),
    ...input.deps,
  };
  const pr: PrResolution = {
    repoSlug: '',
    prNumber: input.prNumber,
    headSha: input.headSha.toLowerCase(),
    state: 'OPEN',
  };
  const claimRead = deps.readClaim(namespace, pr.prNumber, pr.headSha);
  const established = establishPriorTurnState({
    claimRead,
    childAlive: deps.childAlive,
    replyExists: deps.replyExists,
  });
  const decision = decideLauncherAction({ observation: 'A1', established, caller: 'worker' });
  if (!decision.allowSend) {
    const fields = claimRead.ok ? extractPackReviewStageFields(claimRead.record) : null;
    return {
      allowSend: false,
      result: resultBase(decision.disposition, pr, established, {
        claimPath: claimRead.path,
        claimKey: claimRead.ok ? claimRead.record.key : undefined,
        invocationId: fields?.invocationId,
        chatUrl: fields?.chatUrl,
        replyPath: fields?.replyPath,
        workDir: fields?.workDir,
        childPid: fields?.childPid,
      }),
    };
  }
  if (established === 'B5' && claimRead.ok) {
    rmSync(claimRead.path, { force: true });
  }
  const claim = deps.acquireClaim({
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    surface: 'pack-gpt-reviewer-sync',
    projectId: input.projectId,
    namespace,
    startReason: 'sync-browser-send',
  });
  if (!claim.acquired) {
    const reread = deps.readClaim(namespace, pr.prNumber, pr.headSha);
    const restablished = establishPriorTurnState({ claimRead: reread, childAlive: deps.childAlive, replyExists: deps.replyExists });
    const adopt = decideLauncherAction({ observation: 'A1', established: restablished, caller: 'worker' });
    const fields = reread.ok ? extractPackReviewStageFields(reread.record) : null;
    return {
      allowSend: false,
      result: resultBase(adopt.disposition, pr, restablished, {
        claimPath: reread.path,
        claimKey: reread.ok ? reread.record.key : undefined,
        invocationId: fields?.invocationId,
        chatUrl: fields?.chatUrl,
        replyPath: fields?.replyPath,
        workDir: fields?.workDir,
        childPid: fields?.childPid,
        detail: trim(claim.reason),
      }),
    };
  }
  return {
    allowSend: true,
    result: resultBase('started', pr, established === 'B5' ? 'B5' : 'B1', {
      newChatSendCount: 1,
      claimPath: claim.path,
      claimKey: claim.key,
    }),
  };
}

export function readLauncherWitness(workDir: string): { childPid?: number; startedAtUtc?: string } | null {
  const witnessPath = join(workDir, 'launcher-started.json');
  if (!existsSync(witnessPath)) return null;
  try {
    return JSON.parse(readFileSync(witnessPath, 'utf8')) as { childPid?: number; startedAtUtc?: string };
  } catch {
    return null;
  }
}
