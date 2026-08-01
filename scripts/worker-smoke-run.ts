#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { classifyRequiredCiLevel } from '../docs/review-ready-stuck-guard.mjs';
import { runProcessSync } from './kernel/subprocess.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeOrcaTerminal,
  probeOrcaWorktree,
  readOrcaTerminal,
  resolveOrcaExecutable,
  sendOrcaTerminal,
  submitOrcaTerminalComposer,
  waitOrcaTerminal,
  type OrcaJsonResponse,
} from './lib/orca-cli.ts';
import { createBoundedOrcaTerminal } from './lib/worker-smoke-bounded-create.ts';
import {
  bindSmokeTerminalHandle,
  cleanupSmokeLifecycle,
  createSmokeLifecycleReservation,
  evaluateSmokeLifecycleCleanliness,
  inspectSmokeProgress,
  markSmokeCreateAmbiguous,
  markSmokeCreateInProgress,
  observeSmokeCancellationAcknowledgement,
  preflightSmokeLifecycle,
  releaseSmokeAdmission,
  SMOKE_ABSOLUTE_CEILING_MS,
  SMOKE_CREATE_TIMEOUT_MS,
  SMOKE_DELIVERY_TIMEOUT_MS,
  SMOKE_LIFECYCLE_POLL_MS,
  SMOKE_PROGRESS_STALL_MS,
  SMOKE_SHUTDOWN_TIMEOUT_MS,
  smokeCancelAcknowledgementPath,
  smokeCancelRequestPath,
  smokeProgressPath,
  writeSmokeCancelRequest,
} from './lib/worker-smoke-lifecycle.ts';
import {
  buildSmokeAgentPrompt,
  buildSmokeGhChildEnv,
  checkSmokeTestPlan,
  classifyDeclaredScenarioNonPassCause,
  classifySmokeChannelBinding,
  classifySmokeChildWaitObservation,
  createSmokeCompletionObservationState,
  createSmokeControlPlaneDiagnostic,
  createSmokeRunIdentity,
  detectTrackedImplementationMutation,
  ensureSmokeRunArtifactDir,
  evaluateWorkerSmokeGate,
  findCurrentHeadSmokePass,
  formatSmokeReportComment,
  hasPreexistingTrackedDirtiness,
  isDefinitePromptNonDelivery,
  normalizeSmokeReport,
  observeSmokeCompletionEvidence,
  observeSmokeDeliveryEstablished,
  observeSmokeUnsubmittedComposerPaste,
  orcaTerminalReadLines,
  orcaTerminalReadNextCursor,
  ownedSmokeTerminalClosedFromReports,
  parseSmokeAgentReport,
  preserveSmokeControlPlaneCause,
  resolveSmokeRequirement,
  resolveSmokeRunArtifactDir,
  scrubForwardedGhSecrets,
  scrubSmokeOutput,
  smokeAgentTerminalActivityBeyondSentPrompt,
  smokeAgentTerminalFullActivity,
  smokeReportHasPackProducer,
  SMOKE_HARNESS_TERMINAL_CLOSE_ACTION,
  SMOKE_REPORT_PRODUCER,
  stripLeadingSmokeAgentPrompt,
  trackedPorcelainPaths,
  verifySmokeHeadBinding,
  type SmokeChildStateWitness,
  type SmokeChildWaitNonPassCause,
  type SmokeControlPlaneCause,
  type SmokeControlPlaneDiagnostic,
  type SmokeNonPassCause,
  type SmokeReport,
  type SmokeRunBinding,
} from './lib/worker-smoke-core.ts';
import { verifySmokeRunReceipt, writeWorkerSmokeReceipt } from './lib/worker-smoke-receipt.ts';

interface CliOptions {
  command: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  issueBodyFile: string;
  repoRoot: string;
  cwd: string;
  dryRun: boolean;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    command: '',
    issueNumber: 0,
    prNumber: 0,
    headSha: '',
    issueBodyFile: '',
    repoRoot: process.cwd(),
    cwd: process.cwd(),
    dryRun: false,
    json: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    options.command = args.shift() ?? '';
  }
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    switch (token) {
      case '--issue':
        options.issueNumber = Number.parseInt(args[++index] ?? '', 10);
        break;
      case '--pr':
        options.prNumber = Number.parseInt(args[++index] ?? '', 10);
        break;
      case '--head-sha':
        options.headSha = args[++index] ?? '';
        break;
      case '--issue-body-file':
        options.issueBodyFile = args[++index] ?? '';
        break;
      case '--repo-root':
        options.repoRoot = args[++index] ?? options.repoRoot;
        break;
      case '--cwd':
        options.cwd = args[++index] ?? options.cwd;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

function emit(result: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (typeof result === 'string') {
    process.stdout.write(`${result}\n`);
  }
}

function fail(message: string, code = 1): never {
  process.stderr.write(`worker-smoke-run: ${message}\n`);
  process.exit(code);
}

function readIssueBody(path: string): string {
  if (!path) {
    fail('--issue-body-file is required');
  }
  return readFileSync(path, 'utf8');
}

const LEGACY_SMOKE_AGENT_WAIT_BUDGET_MS = 30 * 60 * 1000;
const SMOKE_AGENT_POLL_MS = SMOKE_LIFECYCLE_POLL_MS;

type SmokeLifecycleTerminalReason =
  | 'progress_stall'
  | 'absolute_safety_ceiling'
  | 'operator_cancelled';

function sleepSynchronously(milliseconds: number): void {
  if (milliseconds <= 0) {
    return;
  }
  runProcessSync({
    command: process.platform === 'win32' ? 'powershell' : 'sleep',
    args: process.platform === 'win32'
      ? ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${milliseconds}`]
      : [String(Math.max(1, Math.ceil(milliseconds / 1000)))],
  });
}

export function runSmokeGhSync(
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<NodeJS.ProcessEnv> = {},
): ReturnType<typeof runProcessSync> {
  return runProcessSync({
    command: 'gh',
    args: [...args],
    cwd,
    env: { ...buildSmokeGhChildEnv(), ...extraEnv },
  });
}

function scrubGhFailureMessage(message: string): string {
  return scrubSmokeOutput(scrubForwardedGhSecrets(message, buildSmokeGhChildEnv()));
}

function diagnosticFromResponse(response: OrcaJsonResponse): SmokeControlPlaneDiagnostic | undefined {
  return createSmokeControlPlaneDiagnostic({
    terminalAcquired: true,
    operation: response.operation,
    outcomeCategory: response.outcomeCategory,
    controlPlaneCode: response.error?.code,
  });
}

function attachControlPlaneDiagnostic(
  report: SmokeReport,
  diagnostic: SmokeControlPlaneDiagnostic | undefined,
): SmokeReport {
  if (diagnostic) {
    report.nonPassCause = diagnostic.cause;
    report.controlPlaneDiagnostic = diagnostic;
  }
  return report;
}

function buildSmokeRunResult(
  report: SmokeReport,
  published: boolean,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: report.result === 'PASS',
    report,
    published,
    ...extra,
    ...(report.nonPassCause ? { nonPassCause: report.nonPassCause } : {}),
    ...(report.controlPlaneDiagnostic
      ? { controlPlaneDiagnostic: report.controlPlaneDiagnostic }
      : {}),
  };
}

function closeOwnedSmokeTerminal(handle: string, cwd: string): {
  terminalCleanup: string;
  diagnostic?: SmokeControlPlaneDiagnostic;
} {
  const closeResult = closeOrcaTerminal(handle, { cwd });
  if (closeResult.ok) {
    return { terminalCleanup: 'closed_owned_handle' };
  }
  return {
    terminalCleanup: `close_failed:${closeResult.error?.code ?? 'unknown'}`,
    diagnostic: diagnosticFromResponse(closeResult),
  };
}

export interface SmokePromptDeliveryResult {
  ok: boolean;
  cause?: SmokeChildWaitNonPassCause;
  terminalReason?: Extract<SmokeLifecycleTerminalReason, 'absolute_safety_ceiling' | 'operator_cancelled'>;
  controlPlaneCause?: SmokeControlPlaneCause;
  controlPlaneDiagnostic?: SmokeControlPlaneDiagnostic;
  resendCount: number;
  composerSubmitCount: number;
}

export interface SmokeChildCompletionResult {
  ok: boolean;
  partial?: Partial<SmokeReport> | null;
  agentActivityObserved: boolean;
  nonPassCause?: SmokeChildWaitNonPassCause | SmokeControlPlaneCause;
  terminalReason?: SmokeLifecycleTerminalReason;
  progress?: ReturnType<typeof inspectSmokeProgress>;
  controlPlaneDiagnostic?: SmokeControlPlaneDiagnostic;
  error?: { code: string; message: string };
}

export function establishSmokePromptDelivery(
  handle: string,
  input: {
    readonly cwd?: string;
    readonly deadlineMs: number;
    readonly absoluteDeadlineMs?: number;
    readonly runBinding: SmokeRunBinding;
    readonly prompt: string;
    readonly preSendBaselineText?: string;
    readonly preSendCursor?: number;
    readonly runner?: NonNullable<Parameters<typeof sendOrcaTerminal>[2]>['runner'];
    readonly now?: () => number;
    readonly sleepMs?: (milliseconds: number) => void;
    readonly allowDefiniteNondeliveryRetry?: boolean;
    readonly abortReason?: () => string | undefined;
  },
): SmokePromptDeliveryResult {
  const now = input.now ?? (() => Date.now());
  const deadline = now() + input.deadlineMs;
  const sleepMs = input.sleepMs ?? sleepSynchronously;
  const terminalInterruption = (): SmokePromptDeliveryResult | undefined => {
    const currentNow = now();
    if (input.absoluteDeadlineMs !== undefined && currentNow >= input.absoluteDeadlineMs) {
      return {
        ok: false,
        terminalReason: 'absolute_safety_ceiling',
        resendCount: 0,
        composerSubmitCount: 0,
      };
    }
    const abortReason = input.abortReason?.();
    if (abortReason) {
      return {
        ok: false,
        terminalReason: 'operator_cancelled',
        resendCount: 0,
        composerSubmitCount: 0,
      };
    }
    return undefined;
  };
  const beforeSendInterruption = terminalInterruption();
  if (beforeSendInterruption) return beforeSendInterruption;

  let resendCount = 0;
  const attemptSend = (): ReturnType<typeof sendOrcaTerminal> => sendOrcaTerminal(
    handle,
    input.prompt,
    { cwd: input.cwd, runner: input.runner },
  );
  let sendResult = attemptSend();
  if (!sendResult.ok) {
    const controlPlane = preserveSmokeControlPlaneCause(sendResult.error?.code);
    if (controlPlane) {
      return {
        ok: false,
        controlPlaneCause: controlPlane,
        controlPlaneDiagnostic: diagnosticFromResponse(sendResult),
        resendCount,
        composerSubmitCount: 0,
      };
    }
    if (input.allowDefiniteNondeliveryRetry && isDefinitePromptNonDelivery(sendResult.error?.code)) {
      const retryInterruption = terminalInterruption();
      if (retryInterruption) return retryInterruption;
      resendCount += 1;
      sendResult = attemptSend();
      if (!sendResult.ok) {
        const retriedControlPlane = preserveSmokeControlPlaneCause(sendResult.error?.code);
        if (retriedControlPlane) {
          return {
            ok: false,
            controlPlaneCause: retriedControlPlane,
            controlPlaneDiagnostic: diagnosticFromResponse(sendResult),
            resendCount,
            composerSubmitCount: 0,
          };
        }
        return { ok: false, cause: 'prompt_delivery_unconfirmed', resendCount, composerSubmitCount: 0 };
      }
    } else {
      return { ok: false, cause: 'prompt_delivery_unconfirmed', resendCount, composerSubmitCount: 0 };
    }
  }

  let composerSubmitCount = 0;
  while (now() < deadline) {
    const interruption = terminalInterruption();
    if (interruption) {
      return { ...interruption, resendCount, composerSubmitCount };
    }
    if (observeSmokeDeliveryEstablished(input.runBinding)) {
      return { ok: true, resendCount, composerSubmitCount };
    }
    const read = readOrcaTerminal(handle, {
      cwd: input.cwd,
      limit: 200,
      runner: input.runner,
    });
    if (!read.ok) {
      const controlPlane = preserveSmokeControlPlaneCause(read.error?.code);
      if (controlPlane) {
        return {
          ok: false,
          controlPlaneCause: controlPlane,
          controlPlaneDiagnostic: diagnosticFromResponse(read),
          resendCount,
          composerSubmitCount,
        };
      }
    } else if (
      !observeSmokeDeliveryEstablished(input.runBinding)
      && observeSmokeUnsubmittedComposerPaste(orcaTerminalReadLines(read.result))
    ) {
      const submit = submitOrcaTerminalComposer(handle, { cwd: input.cwd, runner: input.runner });
      composerSubmitCount += 1;
      if (!submit.ok) {
        const controlPlane = preserveSmokeControlPlaneCause(submit.error?.code);
        if (controlPlane) {
          return {
            ok: false,
            controlPlaneCause: controlPlane,
            controlPlaneDiagnostic: diagnosticFromResponse(submit),
            resendCount,
            composerSubmitCount,
          };
        }
      }
    }
    const remaining = Math.min(
      deadline - now(),
      input.absoluteDeadlineMs === undefined ? Number.POSITIVE_INFINITY : input.absoluteDeadlineMs - now(),
    );
    if (remaining <= 0) {
      break;
    }
    sleepMs(Math.min(SMOKE_AGENT_POLL_MS, remaining));
  }
  const finalInterruption = terminalInterruption();
  if (finalInterruption) return { ...finalInterruption, resendCount, composerSubmitCount };
  return { ok: false, cause: 'prompt_delivery_unconfirmed', resendCount, composerSubmitCount };
}

export function waitForSmokeChildCompletion(
  handle: string,
  input: {
    readonly cwd?: string;
    readonly deadlineMs: number;
    readonly runBinding: SmokeRunBinding;
    readonly ownedChildHandle: string;
    readonly supervisorHandle?: string;
    readonly runner?: NonNullable<Parameters<typeof readOrcaTerminal>[1]>['runner'];
    readonly now?: () => number;
    readonly sleepMs?: (milliseconds: number) => void;
    readonly childStateWitness?: () => SmokeChildStateWitness;
    readonly suppressPtyReads?: boolean;
    readonly scenarioCount?: number;
    readonly lifecycleStartedAtMs?: number;
    readonly stallMs?: number;
    readonly absoluteCeilingMs?: number;
    readonly abortReason?: () => string | undefined;
  },
): SmokeChildCompletionResult {
  const channelCause = classifySmokeChannelBinding({
    supervisedHandle: handle,
    ownedChildHandle: input.ownedChildHandle,
    supervisorHandle: input.supervisorHandle,
  });
  if (channelCause) {
    return {
      ok: false,
      agentActivityObserved: false,
      nonPassCause: channelCause,
      error: { code: channelCause, message: channelCause },
    };
  }

  const now = input.now ?? (() => Date.now());
  const sleepMs = input.sleepMs ?? sleepSynchronously;
  const progressAware = Number.isInteger(input.scenarioCount) && (input.scenarioCount ?? 0) > 0;
  const legacyDeadline = now() + input.deadlineMs;
  const lifecycleStartedAtMs = input.lifecycleStartedAtMs ?? now();
  const absoluteDeadline = lifecycleStartedAtMs
    + (input.absoluteCeilingMs ?? SMOKE_ABSOLUTE_CEILING_MS);
  const stallMs = input.stallMs ?? SMOKE_PROGRESS_STALL_MS;
  let lastAcceptedProgressAt = now();
  let acceptedProgressCount = 0;
  let latestProgress = progressAware
    ? inspectSmokeProgress({
      artifactDir: input.runBinding.artifactDir,
      runId: input.runBinding.runId,
      scenarioCount: input.scenarioCount!,
    })
    : undefined;
  if (latestProgress) {
    acceptedProgressCount = latestProgress.acceptedCount;
  }

  let agentActivityObserved = acceptedProgressCount > 0;
  let completionState = createSmokeCompletionObservationState();
  for (;;) {
    const read = readOrcaTerminal(handle, {
      cwd: input.cwd,
      limit: input.suppressPtyReads ? 0 : 200,
      runner: input.runner,
    });
    if (!read.ok) {
      const controlPlane = preserveSmokeControlPlaneCause(read.error?.code);
      if (controlPlane) {
        return {
          ok: false,
          agentActivityObserved,
          nonPassCause: controlPlane,
          controlPlaneDiagnostic: diagnosticFromResponse(read),
          error: { code: controlPlane, message: read.error?.message ?? controlPlane },
        };
      }
    } else if (!input.suppressPtyReads) {
      const deltaText = orcaTerminalReadLines(read.result).join('\n');
      if (deltaText.trim()) {
        agentActivityObserved = true;
      }
    }

    const currentNow = now();
    const abortReason = input.abortReason?.();
    if (abortReason) {
      return {
        ok: false,
        agentActivityObserved,
        terminalReason: 'operator_cancelled',
        error: { code: 'operator_cancelled', message: abortReason },
        ...(latestProgress ? { progress: latestProgress } : {}),
      };
    }

    if (progressAware) {
      latestProgress = inspectSmokeProgress({
        artifactDir: input.runBinding.artifactDir,
        runId: input.runBinding.runId,
        scenarioCount: input.scenarioCount!,
      });
      if (latestProgress.acceptedCount > acceptedProgressCount) {
        acceptedProgressCount = latestProgress.acceptedCount;
        lastAcceptedProgressAt = currentNow;
        agentActivityObserved = true;
      }
      if (currentNow >= absoluteDeadline) {
        return {
          ok: false,
          agentActivityObserved,
          terminalReason: 'absolute_safety_ceiling',
          progress: latestProgress,
          error: {
            code: 'absolute_safety_ceiling',
            message: 'absolute smoke lifecycle safety ceiling reached',
          },
        };
      }
      if (currentNow - lastAcceptedProgressAt >= stallMs) {
        return {
          ok: false,
          agentActivityObserved,
          terminalReason: 'progress_stall',
          progress: latestProgress,
          error: {
            code: 'progress_stall',
            message: 'no accepted declared-scenario transition before stall deadline',
          },
        };
      }
    }

    const observed = observeSmokeCompletionEvidence(input.runBinding, completionState);
    completionState = observed.state;
    const outcome = classifySmokeChildWaitObservation({
      completion: observed.observation,
      childState: input.childStateWitness?.(),
      deadlineReached: false,
    });
    if (outcome.status === 'completed') {
      return {
        ok: true,
        partial: outcome.partial,
        agentActivityObserved: true,
        ...(latestProgress ? { progress: latestProgress } : {}),
      };
    }
    if (outcome.status === 'non_pass' || outcome.status === 'control_plane') {
      return {
        ok: false,
        agentActivityObserved,
        nonPassCause: outcome.cause,
        error: { code: outcome.cause, message: outcome.cause },
        ...(latestProgress ? { progress: latestProgress } : {}),
      };
    }

    if (progressAware) {
      sleepMs(Math.min(
        SMOKE_AGENT_POLL_MS,
        Math.max(1, absoluteDeadline - currentNow),
        Math.max(1, stallMs - (currentNow - lastAcceptedProgressAt)),
      ));
      continue;
    }

    if (currentNow >= legacyDeadline) {
      break;
    }
    sleepMs(Math.min(SMOKE_AGENT_POLL_MS, legacyDeadline - currentNow));
  }

  const observed = observeSmokeCompletionEvidence(input.runBinding, completionState);
  const outcome = classifySmokeChildWaitObservation({
    completion: observed.observation,
    childState: input.childStateWitness?.(),
    deadlineReached: true,
  });
  if (outcome.status === 'completed') {
    return { ok: true, partial: outcome.partial, agentActivityObserved: true };
  }
  if (outcome.status === 'non_pass') {
    return {
      ok: false,
      agentActivityObserved,
      nonPassCause: outcome.cause,
      error: { code: outcome.cause, message: outcome.cause },
    };
  }
  return {
    ok: false,
    agentActivityObserved,
    nonPassCause: 'agent_report_timeout',
    error: { code: 'agent_report_timeout', message: 'agent_report_timeout' },
  };
}

/** @deprecated PTY completion authority removed in #1115; retained for transitional imports. */
export function waitForSmokeAgentCompletion(
  handle: string,
  options: {
    readonly cwd?: string;
    readonly deadlineMs?: number;
    readonly preSendBaselineText?: string;
    readonly preSendCursor?: number;
    readonly sentPrompt?: string;
    readonly runner?: NonNullable<Parameters<typeof waitOrcaTerminal>[1]>['runner'];
    readonly now?: () => number;
    readonly sleepMs?: (milliseconds: number) => void;
    readonly runBinding?: SmokeRunBinding;
    readonly ownedChildHandle?: string;
  } = {},
): {
  ok: boolean;
  agentActivityObserved: boolean;
  partial?: Partial<SmokeReport> | null;
  error?: { code: string; message: string };
} {
  if (options.runBinding && options.ownedChildHandle) {
    const result = waitForSmokeChildCompletion(handle, {
      cwd: options.cwd,
      deadlineMs: options.deadlineMs ?? LEGACY_SMOKE_AGENT_WAIT_BUDGET_MS,
      runBinding: options.runBinding,
      ownedChildHandle: options.ownedChildHandle,
      runner: options.runner,
      now: options.now,
      sleepMs: options.sleepMs,
    });
    return {
      ok: result.ok,
      agentActivityObserved: result.agentActivityObserved,
      partial: result.partial,
      error: result.error,
    };
  }

  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.deadlineMs ?? LEGACY_SMOKE_AGENT_WAIT_BUDGET_MS);
  const sleepMs = options.sleepMs ?? sleepSynchronously;
  let agentActivityObserved = false;
  const baselineText = options.preSendBaselineText ?? '';
  const sentPrompt = options.sentPrompt ?? '';
  let observedSinceBaseline = '';
  let cursor = options.preSendCursor;
  const initialRead = readOrcaTerminal(handle, {
    cwd: options.cwd,
    cursor,
    limit: 2000,
    runner: options.runner,
  });
  if (initialRead.ok) {
    const initialText = orcaTerminalReadLines(initialRead.result).join('\n');
    if (cursor === undefined) {
      if (smokeAgentTerminalFullActivity(initialText, baselineText, sentPrompt)) {
        agentActivityObserved = true;
      }
    } else {
      if (initialText) {
        observedSinceBaseline += initialText;
      }
      if (smokeAgentTerminalActivityBeyondSentPrompt(observedSinceBaseline, sentPrompt)) {
        agentActivityObserved = true;
      }
    }
    const initialNextCursor = orcaTerminalReadNextCursor(initialRead.result);
    if (initialNextCursor !== undefined) {
      cursor = initialNextCursor;
    }
  }
  while (now() < deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }
    const read = readOrcaTerminal(handle, {
      cwd: options.cwd,
      cursor,
      limit: 2000,
      runner: options.runner,
    });
    if (read.ok) {
      const deltaText = orcaTerminalReadLines(read.result).join('\n');
      if (cursor === undefined) {
        if (smokeAgentTerminalFullActivity(deltaText, baselineText, sentPrompt)) {
          agentActivityObserved = true;
        }
      } else {
        if (deltaText) {
          observedSinceBaseline += deltaText;
        }
        if (smokeAgentTerminalActivityBeyondSentPrompt(observedSinceBaseline, sentPrompt)) {
          agentActivityObserved = true;
        }
      }
      const readNextCursor = orcaTerminalReadNextCursor(read.result);
      if (readNextCursor !== undefined) {
        cursor = readNextCursor;
      }
    }
    sleepMs(Math.min(SMOKE_AGENT_POLL_MS, remaining));
  }
  return {
    ok: false,
    agentActivityObserved,
    error: {
      code: agentActivityObserved ? 'smoke_agent_wait_timeout' : 'smoke_agent_never_started',
      message: agentActivityObserved
        ? 'smoke agent did not reach durable completion before deadline'
        : 'smoke agent produced no observable terminal activity before deadline',
    },
  };
}

function requireProcessOutput(label: string, result: ReturnType<typeof runProcessSync>): string {
  if (!result.ok) {
    const detail = scrubGhFailureMessage(result.stderr || result.error || 'non-zero exit');
    fail(`${label}: ${detail}`);
  }
  return result.stdout;
}

function gitPorcelain(cwd: string): string[] {
  const output = requireProcessOutput('git status --porcelain', runProcessSync({
    command: 'git',
    args: ['status', '--porcelain'],
    cwd,
  }));
  return output.split(/\r?\n/u).filter(Boolean);
}

function hashTrackedPaths(cwd: string, paths: readonly string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    const result = runProcessSync({ command: 'git', args: ['hash-object', path], cwd });
    if (result.ok) {
      hashes[path] = result.stdout.trim();
    }
  }
  return hashes;
}

function fetchPrComments(prNumber: number, repoRoot: string): { body?: string }[] {
  const output = requireProcessOutput('pr-issue-comments', runSmokeGhSync(
    ['api', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '--paginate'],
    repoRoot,
  ));
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [];
}

function publishPrComment(prNumber: number, body: string, repoRoot: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'worker-smoke-comment-'));
  const bodyFile = join(tempDir, 'body.md');
  try {
    writeFileSync(bodyFile, body, 'utf8');
    requireProcessOutput('gh pr comment', runSmokeGhSync(
      ['pr', 'comment', String(prNumber), '--body-file', bodyFile],
      repoRoot,
    ));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveGitHead(cwd: string): string {
  return requireProcessOutput('git rev-parse HEAD', runProcessSync({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd,
  })).trim().toLowerCase();
}

function resolveCiGreen(prNumber: number, headSha: string, repoRoot: string): boolean {
  const prMetaRaw = requireProcessOutput('pr-view-head-base', runSmokeGhSync(
    ['pr', 'view', String(prNumber), '--json', 'headRefOid,baseRefName'],
    repoRoot,
  ));
  const prMeta = JSON.parse(prMetaRaw) as { headRefOid?: string; baseRefName?: string };
  if ((prMeta.headRefOid ?? '').trim().toLowerCase() !== headSha.trim().toLowerCase()) {
    return false;
  }
  const checksRaw = requireProcessOutput('required-ci-checks', runSmokeGhSync(
    ['pr', 'checks', String(prNumber), '--json', 'name,state,bucket,link,startedAt,completedAt,workflow,description'],
    repoRoot,
  ));
  const checks = JSON.parse(checksRaw) as { name?: string; state?: string; bucket?: string }[];
  let requiredCheckNames: string[] = [];
  let requiredCheckLookupFailed = false;
  const baseRef = String(prMeta.baseRefName ?? 'main').trim() || 'main';
  const protection = runSmokeGhSync(
    ['api', `repos/{owner}/{repo}/branches/${baseRef}/protection/required_status_checks`],
    repoRoot,
  );
  if (protection.ok) {
    try {
      const parsed = JSON.parse(protection.stdout) as { contexts?: string[] };
      requiredCheckNames = Array.isArray(parsed.contexts) ? parsed.contexts : [];
    } catch {
      requiredCheckLookupFailed = true;
    }
  }
  return classifyRequiredCiLevel(checks, { requiredCheckNames, requiredCheckLookupFailed }) === 'green';
}

function verifyPublishedSmokeProvenance(report: SmokeReport): boolean {
  return smokeReportHasPackProducer(report) && verifySmokeRunReceipt(report);
}

function attachPackProducerFields<T extends Partial<SmokeReport>>(
  report: T,
  input: { terminalHandle?: string; orcaExecutable?: string },
): T {
  return {
    ...report,
    producer: SMOKE_REPORT_PRODUCER,
    orcaExecutable: input.orcaExecutable ?? resolveOrcaExecutable(),
    terminalHandle: input.terminalHandle ?? report.terminalHandle,
  };
}

function runValidatePlan(options: CliOptions): number {
  const result = checkSmokeTestPlan(readIssueBody(options.issueBodyFile));
  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`worker-smoke-run: ${error}\n`);
    }
    return 1;
  }
  emit({ ok: true, plan: result.plan }, options.json);
  return 0;
}

function runGateCheck(options: CliOptions): number {
  const lifecycle = evaluateSmokeLifecycleCleanliness(options.cwd);
  if (!lifecycle.clean) {
    const result = {
      ok: false,
      allowed: false,
      reason: `smoke_lifecycle_unclean:${lifecycle.reasons[0]}`,
      smokeRequired: true,
      lifecycle,
    };
    emit(result, options.json);
    return 1;
  }
  const issueBody = readIssueBody(options.issueBodyFile);
  const comments = options.prNumber > 0 ? fetchPrComments(options.prNumber, options.repoRoot) : [];
  const worktree = probeOrcaWorktree(options.cwd);
  const pass = options.prNumber > 0
    ? findCurrentHeadSmokePass(comments, options.prNumber, options.headSha, options.issueNumber)
    : null;
  const decision = evaluateWorkerSmokeGate({
    issueBody,
    issueNumber: options.issueNumber,
    prNumber: options.prNumber,
    headSha: options.headSha,
    prComments: comments,
    ciGreen: options.prNumber > 0
      ? resolveCiGreen(options.prNumber, options.headSha, options.repoRoot)
      : false,
    orcaWorktreeOk: worktree.ok,
    ownedTerminalClosed: options.prNumber > 0
      ? ownedSmokeTerminalClosedFromReports(
        comments,
        options.prNumber,
        options.headSha,
        options.issueNumber,
      )
      : false,
    terminalProvenanceOk: pass ? verifyPublishedSmokeProvenance(pass) : false,
  });
  emit({ ok: decision.allowed, ...decision, lifecycle }, options.json);
  return decision.allowed ? 0 : 1;
}

function publishSmokeReport(report: SmokeReport, options: CliOptions): void {
  if (!options.dryRun) {
    publishPrComment(options.prNumber, formatSmokeReportComment(report), options.repoRoot);
    writeWorkerSmokeReceipt(report);
  }
}

function buildOperationalSmokeReport(
  result: SmokeReport['result'],
  options: CliOptions,
  input: {
    action: string;
    expected: string;
    observed: string;
    terminalCleanup?: string;
    limitations?: string[];
    environmentNotes?: string[];
    trackedFilesUnmodified?: boolean;
  },
): SmokeReport {
  return {
    result,
    issueNumber: options.issueNumber,
    prNumber: options.prNumber,
    headSha: options.headSha,
    scenarios: [{
      action: input.action,
      expected: input.expected,
      observed: input.observed,
      outcome: result === 'BLOCKED' ? 'blocked' : 'fail',
    }],
    limitations: input.limitations ?? [],
    trackedFilesUnmodified: input.trackedFilesUnmodified ?? true,
    terminalCleanup: input.terminalCleanup ?? 'not_started',
    environmentNotes: input.environmentNotes ?? [],
  };
}

function buildLifecyclePrompt(
  basePrompt: string,
  binding: SmokeRunBinding,
  scenarioCount: number,
): string {
  return [
    basePrompt,
    '',
    'Lifecycle protocol (child-produced evidence only):',
    `- Progress file: ${smokeProgressPath(binding.artifactDir)}`,
    `- Cancel request: ${smokeCancelRequestPath(binding.artifactDir)}`,
    `- Cancel acknowledgement: ${smokeCancelAcknowledgementPath(binding.artifactDir)}`,
    `- Declared scenario count: ${scenarioCount}`,
    '- Before each declared scenario append exactly one JSON line: {"runId":"<run-id>","scenarioOrdinal":N,"phase":"started"}.',
    '- After that scenario append exactly one JSON line: {"runId":"<run-id>","scenarioOrdinal":N,"phase":"terminal","outcome":"pass|fail|blocked|skipped"}.',
    '- Use declared order only. Never emit heartbeats, milestones, duplicate starts, or parent-authored progress.',
    '- Check cancel-request.json between scenarios, before every new Browser-GPT turn, and immediately after an already-started turn returns.',
    '- When cancellation is observed, start no new scenario or turn; create cancel-acknowledgement.json with {"runId":"<run-id>"}, then publish ordinary sealed completion only if available.',
    '- The supervisor never writes accepted progress or completion artifacts.',
  ].join('\n');
}

function waitForCooperativeShutdown(input: {
  handle: string;
  cwd: string;
  runBinding: SmokeRunBinding;
  now?: () => number;
  sleepMs?: (milliseconds: number) => void;
  shutdownMs?: number;
}): boolean {
  const now = input.now ?? (() => Date.now());
  const sleepMs = input.sleepMs ?? sleepSynchronously;
  const deadline = now() + (input.shutdownMs ?? SMOKE_SHUTDOWN_TIMEOUT_MS);
  let completionState = createSmokeCompletionObservationState();
  while (now() < deadline) {
    if (observeSmokeCancellationAcknowledgement(
      input.runBinding.artifactDir,
      input.runBinding.runId,
    )) {
      return true;
    }
    const observed = observeSmokeCompletionEvidence(input.runBinding, completionState);
    completionState = observed.state;
    if (
      observed.observation.publicationState === 'publish_complete_single'
      || observed.observation.publicationState === 'publish_complete_unfenced'
      || observed.observation.publicationState === 'publish_complete_duplicate'
    ) {
      return true;
    }
    readOrcaTerminal(input.handle, { cwd: input.cwd, limit: 0 });
    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }
    sleepMs(Math.min(SMOKE_AGENT_POLL_MS, remaining));
  }
  return false;
}

async function runSmokeAttempt(options: CliOptions): Promise<number> {
  const issueBody = readIssueBody(options.issueBodyFile);
  const plan = resolveSmokeRequirement(issueBody);
  if (plan.requirement !== 'required') {
    emit({ ok: true, skipped: true, reason: plan.requirement }, options.json);
    return 0;
  }
  if (plan.scenarios.length === 0) {
    const report = buildOperationalSmokeReport('FAIL', options, {
      action: 'parse smoke-test-plan',
      expected: 'at least one executable scenario',
      observed: 'zero_parsed_scenarios',
      environmentNotes: ['smoke agent was not launched'],
    });
    report.nonPassCause = 'zero_parsed_scenarios';
    publishSmokeReport(report, options);
    emit(buildSmokeRunResult(report, !options.dryRun, { terminalCreated: false }), options.json);
    return 1;
  }

  const worktree = probeOrcaWorktree(options.cwd);
  if (!worktree.ok) {
    const diagnostic = createSmokeControlPlaneDiagnostic({
      terminalAcquired: false,
      operation: worktree.operation,
      outcomeCategory: worktree.outcomeCategory,
      controlPlaneCode: worktree.errorCode,
    });
    const report = attachControlPlaneDiagnostic(buildOperationalSmokeReport('BLOCKED', options, {
      action: 'resolve orca worktree',
      expected: 'cwd is Orca-managed',
      observed: diagnostic?.cause ?? worktree.reason,
      environmentNotes: ['smoke agent was not launched'],
    }), diagnostic);
    publishSmokeReport(report, options);
    emit(buildSmokeRunResult(report, !options.dryRun), options.json);
    return 1;
  }

  const headBinding = verifySmokeHeadBinding({
    requestedHeadSha: options.headSha,
    orcaHeadSha: worktree.headSha,
    gitHeadSha: resolveGitHead(options.cwd),
  });
  if (!headBinding.ok) {
    const report = buildOperationalSmokeReport('BLOCKED', options, {
      action: 'bind smoke run to current checkout head',
      expected: `orca/git head equals ${options.headSha}`,
      observed: `${headBinding.reason}:${headBinding.observed}`,
      environmentNotes: ['head binding failed'],
    });
    publishSmokeReport(report, options);
    emit(buildSmokeRunResult(report, !options.dryRun), options.json);
    return 1;
  }

  const beforeStatus = gitPorcelain(options.cwd);
  if (hasPreexistingTrackedDirtiness(beforeStatus)) {
    const report = buildOperationalSmokeReport('BLOCKED', options, {
      action: 'verify clean tracked worktree before smoke',
      expected: 'no pre-existing tracked modifications',
      observed: trackedPorcelainPaths(beforeStatus).join(', ') || 'tracked_dirty',
      environmentNotes: ['tracked worktree dirty before smoke launch'],
    });
    publishSmokeReport(report, options);
    emit(buildSmokeRunResult(report, !options.dryRun), options.json);
    return 1;
  }
  const beforeHashes = hashTrackedPaths(options.cwd, trackedPorcelainPaths(beforeStatus));

  const runId = createSmokeRunIdentity();
  const artifactDir = resolveSmokeRunArtifactDir(options.cwd, runId);
  const admission = preflightSmokeLifecycle({
    repoRoot: options.cwd,
    runId,
    closeBoundHandle: (handle) => closeOwnedSmokeTerminal(handle, options.cwd).terminalCleanup,
  });
  if (!admission.admitted) {
    const report = buildOperationalSmokeReport('BLOCKED', options, {
      action: 'worker-smoke lifecycle preflight',
      expected: 'safe stale state cleaned and one spawn admission granted',
      observed: admission.reason ?? 'lifecycle_preflight_refused',
      environmentNotes: admission.diagnostics,
    });
    publishSmokeReport(report, options);
    emit(buildSmokeRunResult(report, !options.dryRun, { lifecycle: admission }), options.json);
    return 1;
  }

  const lifecycleStartedAtMs = Date.now();
  try {
    ensureSmokeRunArtifactDir(artifactDir);
    createSmokeLifecycleReservation({
      runId,
      artifactDir,
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
      nowMs: lifecycleStartedAtMs,
      createTimeoutMs: SMOKE_CREATE_TIMEOUT_MS,
      scenarioCount: plan.scenarios.length,
    });
    markSmokeCreateInProgress(artifactDir);
  } catch (error) {
    releaseSmokeAdmission(options.cwd, runId);
    const observed = error instanceof Error ? error.message : 'lifecycle_reservation_failed';
    const report = buildOperationalSmokeReport('BLOCKED', options, {
      action: 'reserve worker-smoke lifecycle before terminal creation',
      expected: 'durable current-run reservation before any spawn side effect',
      observed: scrubSmokeOutput(observed),
      environmentNotes: ['terminal was not created'],
    });
    publishSmokeReport(report, options);
    emit(buildSmokeRunResult(report, !options.dryRun, { terminalCreated: false }), options.json);
    return 1;
  }

  let handle = '';
  let terminalCleanup = 'pending';
  let cleanupDiagnostic: SmokeControlPlaneDiagnostic | undefined;
  let cleanupFinished = false;
  let signalReason: string | undefined;
  const onSigint = (): void => { signalReason = 'SIGINT'; };
  const onSigterm = (): void => { signalReason = 'SIGTERM'; };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  const cleanup = (reason: string, requestCancellation: boolean): ReturnType<typeof cleanupSmokeLifecycle> => {
    let acknowledged = false;
    if (requestCancellation && handle) {
      const cancellationRecorded = writeSmokeCancelRequest({ artifactDir, runId, reason });
      if (cancellationRecorded) {
        acknowledged = waitForCooperativeShutdown({
          handle,
          cwd: options.cwd,
          runBinding: { runId, artifactDir },
        });
      }
    }
    const result = cleanupSmokeLifecycle({
      artifactDir,
      runId,
      reason,
      requestCancellation,
      cooperativeAcknowledgementObserved: acknowledged,
      closeBoundHandle: (ownedHandle) => {
        const close = closeOwnedSmokeTerminal(ownedHandle, options.cwd);
        cleanupDiagnostic ??= close.diagnostic;
        return close.terminalCleanup;
      },
    });
    terminalCleanup = result.closeOutcome;
    cleanupFinished = true;
    releaseSmokeAdmission(options.cwd, runId);
    return result;
  };

  try {
    const created = createBoundedOrcaTerminal({
      cwd: options.cwd,
      title: `smoke-${options.issueNumber}`,
      command: 'cursor-agent',
      timeoutMs: SMOKE_CREATE_TIMEOUT_MS,
    });
    if (!created.ok) {
      markSmokeCreateAmbiguous(
        artifactDir,
        scrubSmokeOutput(`${created.errorCode}:${created.reason}`),
      );
      releaseSmokeAdmission(options.cwd, runId);
      const createOutcome = created.errorCode === 'orca_process_launch_failed'
        ? 'process_launch_failed'
        : created.errorCode === 'orca_empty_stdout'
          ? 'empty_stdout'
          : created.errorCode === 'orca_invalid_json'
            ? 'invalid_json'
            : 'supported_operation_failure';
      const diagnostic = createSmokeControlPlaneDiagnostic({
        terminalAcquired: false,
        operation: 'terminal_create',
        outcomeCategory: createOutcome,
        controlPlaneCode: created.errorCode,
      });
      const report = attachControlPlaneDiagnostic(attachPackProducerFields(
        buildOperationalSmokeReport('BLOCKED', options, {
          action: 'create bounded Orca smoke terminal',
          expected: `terminal handle returned within ${SMOKE_CREATE_TIMEOUT_MS}ms and durably bound`,
          observed: diagnostic?.cause ?? `${created.errorCode}:ambiguous_unbound`,
          terminalCleanup: 'ambiguous_unbound',
          environmentNotes: admission.diagnostics,
        }),
        {},
      ), diagnostic);
      publishSmokeReport(report, options);
      emit(buildSmokeRunResult(report, !options.dryRun, {
        lifecycleState: 'ambiguous_unbound',
        createElapsedMs: created.elapsedMs,
      }), options.json);
      return 1;
    }

    handle = created.terminal.handle;
    bindSmokeTerminalHandle(artifactDir, handle);
    const prompt = buildLifecyclePrompt(buildSmokeAgentPrompt({
      issueNumber: options.issueNumber,
      issueBody,
      prNumber: options.prNumber,
      headSha: options.headSha,
      plan,
      runBinding: { runId, artifactDir },
    }), { runId, artifactDir }, plan.scenarios.length);
    const absoluteDeadlineMs = lifecycleStartedAtMs + SMOKE_ABSOLUTE_CEILING_MS;
    const absoluteRemaining = Math.max(0, absoluteDeadlineMs - Date.now());
    const deliveryResult = establishSmokePromptDelivery(handle, {
      cwd: options.cwd,
      deadlineMs: Math.min(SMOKE_DELIVERY_TIMEOUT_MS, absoluteRemaining),
      absoluteDeadlineMs,
      runBinding: { runId, artifactDir },
      prompt,
      abortReason: () => signalReason,
    });
    if (!deliveryResult.ok) {
      const reason = deliveryResult.terminalReason
        ?? deliveryResult.controlPlaneCause
        ?? deliveryResult.cause
        ?? 'prompt_delivery_unconfirmed';
      const cleanupResult = cleanup(reason, true);
      const diagnostic = deliveryResult.controlPlaneDiagnostic;
      const report = attachControlPlaneDiagnostic(buildOperationalSmokeReport(
        diagnostic ? 'BLOCKED' : 'FAIL',
        options,
        {
          action: 'establish smoke prompt delivery',
          expected: 'publish-complete current-run delivery before bounded delivery deadline',
          observed: diagnostic?.cause ?? reason,
          terminalCleanup,
          environmentNotes: [
            `lifecycle-clean=${cleanupResult.clean}`,
            ...admission.diagnostics,
          ],
        },
      ), diagnostic);
      if (!diagnostic && deliveryResult.cause) {
        report.nonPassCause = deliveryResult.cause;
      }
      publishSmokeReport(report, options);
      emit(buildSmokeRunResult(report, !options.dryRun, {
        terminalReason: deliveryResult.terminalReason,
        lifecycleCleanup: cleanupResult,
      }), options.json);
      return 1;
    }

    const waitResult = waitForSmokeChildCompletion(handle, {
      cwd: options.cwd,
      deadlineMs: SMOKE_ABSOLUTE_CEILING_MS,
      runBinding: { runId, artifactDir },
      ownedChildHandle: handle,
      scenarioCount: plan.scenarios.length,
      lifecycleStartedAtMs,
      stallMs: SMOKE_PROGRESS_STALL_MS,
      absoluteCeilingMs: SMOKE_ABSOLUTE_CEILING_MS,
      abortReason: () => signalReason,
    });
    if (!waitResult.ok) {
      const reason = waitResult.terminalReason
        ?? waitResult.nonPassCause
        ?? waitResult.error?.code
        ?? 'child_wait_failed';
      const diagnostic = waitResult.controlPlaneDiagnostic;
      const cleanupResult = cleanup(reason, true);
      const report = attachControlPlaneDiagnostic(buildOperationalSmokeReport(
        diagnostic ? 'BLOCKED' : 'FAIL',
        options,
        {
          action: 'wait for progressing smoke child completion',
          expected: 'legal progress before stall bound and sealed completion before absolute ceiling',
          observed: diagnostic?.cause ?? reason,
          terminalCleanup,
          limitations: waitResult.progress?.invalidEvents.slice(0, 10),
          environmentNotes: [
            `stall-ms=${SMOKE_PROGRESS_STALL_MS}`,
            `absolute-ceiling-ms=${SMOKE_ABSOLUTE_CEILING_MS}`,
            `lifecycle-clean=${cleanupResult.clean}`,
          ],
        },
      ), diagnostic);
      if (!diagnostic && waitResult.nonPassCause) {
        report.nonPassCause = waitResult.nonPassCause;
      }
      publishSmokeReport(report, options);
      emit(buildSmokeRunResult(report, !options.dryRun, {
        terminalReason: waitResult.terminalReason,
        progress: waitResult.progress,
        lifecycleCleanup: cleanupResult,
      }), options.json);
      return 1;
    }

    const partial = waitResult.partial;
    if (!partial) {
      const cleanupResult = cleanup('missing_completion_partial', true);
      const report = buildOperationalSmokeReport('BLOCKED', options, {
        action: 'consume publish-complete smoke child completion',
        expected: 'durable completion artifact with parseable report',
        observed: 'missing_completion_partial',
        terminalCleanup,
        environmentNotes: [`lifecycle-clean=${cleanupResult.clean}`],
      });
      publishSmokeReport(report, options);
      emit(buildSmokeRunResult(report, !options.dryRun), options.json);
      return 1;
    }

    const afterStatus = gitPorcelain(options.cwd);
    const afterHashes = hashTrackedPaths(options.cwd, trackedPorcelainPaths(afterStatus));
    const mutated = detectTrackedImplementationMutation(
      beforeStatus,
      afterStatus,
      beforeHashes,
      afterHashes,
    );
    if (mutated) {
      partial.result = 'FAIL';
      partial.trackedFilesUnmodified = false;
    }

    const normalized = normalizeSmokeReport(attachPackProducerFields({
      ...partial,
      result: partial.result ?? 'FAIL',
      scenarios: partial.scenarios ?? [],
      limitations: partial.limitations ?? [],
      trackedFilesUnmodified: partial.trackedFilesUnmodified ?? !mutated,
      terminalCleanup: partial.terminalCleanup ?? 'pending',
      environmentNotes: partial.environmentNotes ?? [],
    }, { terminalHandle: handle }), {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });

    if (!normalized.ok && partial.result !== 'FAIL' && partial.result !== 'BLOCKED') {
      const cleanupResult = cleanup('invalid_child_report', false);
      const report = attachPackProducerFields(buildOperationalSmokeReport('FAIL', options, {
        action: 'normalize smoke agent report',
        expected: 'valid PASS evidence',
        observed: normalized.reason,
        terminalCleanup,
        environmentNotes: [`lifecycle-clean=${cleanupResult.clean}`],
      }), { terminalHandle: handle });
      const nonPassCause = classifyDeclaredScenarioNonPassCause({
        partial,
        agentActivityObserved: waitResult.agentActivityObserved,
        agentCompleted: true,
      });
      if (nonPassCause) {
        report.nonPassCause = nonPassCause;
      }
      publishSmokeReport(report, options);
      emit(buildSmokeRunResult(report, !options.dryRun), options.json);
      return 1;
    }

    const report: SmokeReport = normalized.ok
      ? attachPackProducerFields(normalized.report, { terminalHandle: handle })
      : attachPackProducerFields({
        result: partial.result === 'BLOCKED' ? 'BLOCKED' : 'FAIL',
        issueNumber: options.issueNumber,
        prNumber: options.prNumber,
        headSha: options.headSha,
        scenarios: partial.scenarios ?? [],
        limitations: partial.limitations ?? [],
        trackedFilesUnmodified: !mutated,
        terminalCleanup: 'pending',
        environmentNotes: partial.environmentNotes ?? [],
      } as SmokeReport, { terminalHandle: handle });

    const cleanupResult = cleanup('child_completed', false);
    report.terminalCleanup = terminalCleanup;
    if (cleanupDiagnostic) {
      attachControlPlaneDiagnostic(report, cleanupDiagnostic);
    }
    if (!cleanupResult.clean || terminalCleanup !== 'closed_owned_handle') {
      if (report.result === 'PASS') {
        report.result = 'FAIL';
      }
      report.scenarios.push({
        action: SMOKE_HARNESS_TERMINAL_CLOSE_ACTION,
        expected: 'owned terminal closes and lifecycle becomes clean',
        observed: `${terminalCleanup};lifecycle-clean=${cleanupResult.clean}`,
        outcome: 'fail',
      });
    }
    if (report.result !== 'PASS' && !report.controlPlaneDiagnostic) {
      const nonPassCause = classifyDeclaredScenarioNonPassCause({
        partial: report,
        agentActivityObserved: waitResult.agentActivityObserved,
        agentCompleted: true,
      });
      if (nonPassCause) {
        report.nonPassCause = nonPassCause;
      }
    }
    publishSmokeReport(report, options);
    emit(buildSmokeRunResult(report, !options.dryRun, {
      orcaExecutable: resolveOrcaExecutable(),
      terminalHandle: handle,
      progress: waitResult.progress,
      lifecycleCleanup: cleanupResult,
    }), options.json);
    return report.result === 'PASS' ? 0 : 1;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'handled_exception';
    if (handle && !cleanupFinished) {
      const cleanupResult = cleanup('handled_exception', true);
      const report = buildOperationalSmokeReport('BLOCKED', options, {
        action: 'handle smoke supervisor exception',
        expected: 'durable cancellation and bound-only cleanup',
        observed: scrubSmokeOutput(reason),
        terminalCleanup,
        environmentNotes: [`lifecycle-clean=${cleanupResult.clean}`],
      });
      publishSmokeReport(report, options);
      emit(buildSmokeRunResult(report, !options.dryRun, { lifecycleCleanup: cleanupResult }), options.json);
    } else if (!handle) {
      try {
        markSmokeCreateAmbiguous(
          artifactDir,
          scrubSmokeOutput(`handled_exception:${reason}`),
        );
      } catch {
        // Reservation write failure is already a blocking preflight condition.
      }
      releaseSmokeAdmission(options.cwd, runId);
      const report = buildOperationalSmokeReport('BLOCKED', options, {
        action: 'handle pre-bind smoke supervisor exception',
        expected: 'preserve ambiguous-unbound state without guessing a terminal handle',
        observed: scrubSmokeOutput(reason),
        terminalCleanup: 'ambiguous_unbound',
      });
      publishSmokeReport(report, options);
      emit(buildSmokeRunResult(report, !options.dryRun, { lifecycleState: 'ambiguous_unbound' }), options.json);
    }
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (handle && !cleanupFinished) {
      try {
        cleanup('finally_cleanup', true);
      } catch {
        // A failed fallback remains blocking through the durable lifecycle registry.
      }
    }
    releaseSmokeAdmission(options.cwd, runId);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  switch (options.command) {
    case 'validate-plan':
      return runValidatePlan(options);
    case 'gate-check':
      return runGateCheck(options);
    case 'run':
      return runSmokeAttempt(options);
    default:
      fail('usage: worker-smoke-run.ts <validate-plan|gate-check|run> [--issue N] [--pr N] [--head-sha SHA] [--issue-body-file path] [--repo-root path] [--cwd path] [--dry-run] [--json]');
  }
}

const isDirectInvocation = import.meta.url === new URL(process.argv[1] ?? '', 'file:').href;

// Keep lifecycle regressions inside the existing classified worker-smoke Vitest module.
if (!isDirectInvocation && (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID)) {
  const [{ describe, expect, it, vi }, { registerWorkerSmokeLifecycleRegressionTests }] =
    await Promise.all([
      import('vitest'),
      import('./lib/worker-smoke-lifecycle-regressions.ts'),
    ]);
  registerWorkerSmokeLifecycleRegressionTests({
    describe,
    expect,
    it,
    vi,
    establishSmokePromptDelivery,
    waitForSmokeChildCompletion,
  });
}

if (isDirectInvocation) {
  main().then((code) => {
    process.exitCode = code;
  });
}
