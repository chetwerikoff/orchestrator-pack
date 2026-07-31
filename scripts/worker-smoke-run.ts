#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { classifyRequiredCiLevel } from '../docs/review-ready-stuck-guard.mjs';
import { runProcessSync } from './kernel/subprocess.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeOrcaTerminal,
  createOrcaTerminal,
  probeOrcaWorktree,
  readOrcaTerminal,
  resolveOrcaExecutable,
  sendOrcaTerminal,
  submitOrcaTerminalComposer,
  waitOrcaTerminal,
  type OrcaJsonResponse,
  type OrcaOperationName,
} from './lib/orca-cli.ts';
import {
  buildSmokeAgentPrompt,
  buildSmokeGhChildEnv,
  checkSmokeTestPlan,
  classifyDeclaredScenarioNonPassCause,
  classifySmokeChannelBinding,
  classifySmokeChildWaitObservation,
  classifySmokeNonPassCause,
  createSmokeControlPlaneDiagnostic,
  createSmokeRunIdentity,
  ensureSmokeRunArtifactDir,
  isSmokeControlPlaneCause,
  isDefinitePromptNonDelivery,
  preserveSmokeControlPlaneCause,
  createSmokeCompletionObservationState,
  observeSmokeCompletionEvidence,
  observeSmokeDeliveryEstablished,
  observeSmokeUnsubmittedComposerPaste,
  resolveSmokeRunArtifactDir,
  type SmokeChildWaitNonPassCause,
  type SmokeControlPlaneCause,
  type SmokeControlPlaneDiagnostic,
  SMOKE_HARNESS_TERMINAL_CLOSE_ACTION,
  detectTrackedImplementationMutation,
  hasPreexistingTrackedDirtiness,
  trackedPorcelainPaths,
  evaluateWorkerSmokeGate,
  findCurrentHeadSmokePass,
  formatSmokeReportComment,
  normalizeSmokeReport,
  orcaTerminalReadLines,
  orcaTerminalReadNextCursor,
  ownedSmokeTerminalClosedFromReports,
  parseSmokeAgentReport,
  smokeAgentTerminalActivityBeyondSentPrompt,
  smokeAgentTerminalDeltaActivity,
  smokeAgentTerminalFullActivity,
  scrubForwardedGhSecrets,
  smokeReportHasPackProducer,
  SMOKE_REPORT_PRODUCER,
  verifySmokeHeadBinding,
  resolveSmokeRequirement,
  scrubSmokeOutput,
  stripLeadingSmokeAgentPrompt,
  type SmokeNonPassCause,
  type SmokeReport,
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
    return;
  }
  if (typeof result === 'string') {
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

const SMOKE_AGENT_WAIT_BUDGET_MS = 30 * 60 * 1000;
const SMOKE_AGENT_POLL_MS = 250;

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

function smokeAgentTerminalHasReport(
  terminalText: string,
  sentPrompt: string,
  baselineText = '',
): boolean {
  const observedSinceBaseline = terminalText.startsWith(baselineText)
    ? terminalText.slice(baselineText.length)
    : terminalText;
  const remainder = stripLeadingSmokeAgentPrompt(observedSinceBaseline, sentPrompt);
  if (!remainder.trim()) {
    return false;
  }
  return parseSmokeAgentReport(remainder) !== null;
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
  if (!diagnostic) {
    return report;
  }
  report.nonPassCause = diagnostic.cause;
  report.controlPlaneDiagnostic = diagnostic;
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
    terminalCleanup: `close_failed:${closeResult.outcomeCategory ?? 'supported_operation_failure'}`,
    diagnostic: diagnosticFromResponse(closeResult),
  };
}

export interface SmokePromptDeliveryResult {
  ok: boolean;
  cause?: SmokeChildWaitNonPassCause;
  controlPlaneCause?: SmokeControlPlaneCause;
  controlPlaneDiagnostic?: SmokeControlPlaneDiagnostic;
  resendCount: number;
  composerSubmitCount: number;
}

export interface SmokeChildCompletionResult {
  ok: boolean;
  partial?: Partial<import('./lib/worker-smoke-core.ts').SmokeReport> | null;
  agentActivityObserved: boolean;
  nonPassCause?: SmokeChildWaitNonPassCause | SmokeControlPlaneCause;
  controlPlaneDiagnostic?: SmokeControlPlaneDiagnostic;
  error?: { code: string; message: string };
}

export function establishSmokePromptDelivery(
  handle: string,
  input: {
    readonly cwd?: string;
    readonly deadlineMs: number;
    readonly runBinding: import('./lib/worker-smoke-core.ts').SmokeRunBinding;
    readonly prompt: string;
    readonly preSendBaselineText?: string;
    readonly preSendCursor?: number;
    readonly runner?: NonNullable<Parameters<typeof sendOrcaTerminal>[2]>['runner'];
    readonly now?: () => number;
    readonly sleepMs?: (milliseconds: number) => void;
    readonly allowDefiniteNondeliveryRetry?: boolean;
  },
): SmokePromptDeliveryResult {
  const now = input.now ?? (() => Date.now());
  const deadline = now() + input.deadlineMs;
  const sleepMs = input.sleepMs ?? ((milliseconds: number) => {
    if (milliseconds <= 0) {
      return;
    }
    runProcessSync({
      command: process.platform === 'win32' ? 'powershell' : 'sleep',
      args: process.platform === 'win32'
        ? ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${milliseconds}`]
        : [String(Math.max(1, Math.ceil(milliseconds / 1000)))],
    });
  });

  let resendCount = 0;
  const attemptSend = (): ReturnType<typeof sendOrcaTerminal> => {
    return sendOrcaTerminal(handle, input.prompt, { cwd: input.cwd, runner: input.runner });
  };

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
    } else {
      const lines = orcaTerminalReadLines(read.result);
      if (
        !observeSmokeDeliveryEstablished(input.runBinding)
        && observeSmokeUnsubmittedComposerPaste(lines)
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
        if (observeSmokeDeliveryEstablished(input.runBinding)) {
          return { ok: true, resendCount, composerSubmitCount };
        }
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }
    sleepMs(Math.min(SMOKE_AGENT_POLL_MS, remaining));
  }

  return { ok: false, cause: 'prompt_delivery_unconfirmed', resendCount, composerSubmitCount };
}

export function waitForSmokeChildCompletion(
  handle: string,
  input: {
    readonly cwd?: string;
    readonly deadlineMs: number;
    readonly runBinding: import('./lib/worker-smoke-core.ts').SmokeRunBinding;
    readonly ownedChildHandle: string;
    readonly supervisorHandle?: string;
    readonly runner?: NonNullable<Parameters<typeof readOrcaTerminal>[1]>['runner'];
    readonly now?: () => number;
    readonly sleepMs?: (milliseconds: number) => void;
    readonly childStateWitness?: () => import('./lib/worker-smoke-core.ts').SmokeChildStateWitness;
    readonly suppressPtyReads?: boolean;
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
  const deadline = now() + input.deadlineMs;
  const sleepMs = input.sleepMs ?? ((milliseconds: number) => {
    if (milliseconds <= 0) {
      return;
    }
    runProcessSync({
      command: process.platform === 'win32' ? 'powershell' : 'sleep',
      args: process.platform === 'win32'
        ? ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${milliseconds}`]
        : [String(Math.max(1, Math.ceil(milliseconds / 1000)))],
    });
  });

  let agentActivityObserved = false;
  let completionState = createSmokeCompletionObservationState();
  while (now() < deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }

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

    const observed = observeSmokeCompletionEvidence(input.runBinding, completionState);
    completionState = observed.state;
    const outcome = classifySmokeChildWaitObservation({
      completion: observed.observation,
      childState: input.childStateWitness?.(),
      deadlineReached: false,
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
    if (outcome.status === 'control_plane') {
      return {
        ok: false,
        agentActivityObserved,
        nonPassCause: outcome.cause,
        error: { code: outcome.cause, message: outcome.cause },
      };
    }

    sleepMs(Math.min(SMOKE_AGENT_POLL_MS, remaining));
  }

  const observed = observeSmokeCompletionEvidence(input.runBinding, completionState);
  completionState = observed.state;
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
    readonly runBinding?: import('./lib/worker-smoke-core.ts').SmokeRunBinding;
    readonly ownedChildHandle?: string;
  } = {},
): {
  ok: boolean;
  agentActivityObserved: boolean;
  partial?: Partial<import('./lib/worker-smoke-core.ts').SmokeReport> | null;
  error?: { code: string; message: string };
} {
  if (options.runBinding && options.ownedChildHandle) {
    const result = waitForSmokeChildCompletion(handle, {
      cwd: options.cwd,
      deadlineMs: options.deadlineMs ?? SMOKE_AGENT_WAIT_BUDGET_MS,
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
  const deadline = now() + (options.deadlineMs ?? SMOKE_AGENT_WAIT_BUDGET_MS);
  const sleepMs = options.sleepMs ?? ((milliseconds: number) => {
    if (milliseconds <= 0) {
      return;
    }
    runProcessSync({
      command: process.platform === 'win32' ? 'powershell' : 'sleep',
      args: process.platform === 'win32'
        ? ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${milliseconds}`]
        : [String(Math.max(1, Math.ceil(milliseconds / 1000)))],
    });
  });

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
    const result = runProcessSync({
      command: 'git',
      args: ['hash-object', path],
      cwd,
    });
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
  const normalizedHead = headSha.trim().toLowerCase();
  if ((prMeta.headRefOid ?? '').trim().toLowerCase() !== normalizedHead) {
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
  const markdown = readIssueBody(options.issueBodyFile);
  const result = checkSmokeTestPlan(markdown);
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
    ciGreen: options.prNumber > 0 ? resolveCiGreen(options.prNumber, options.headSha, options.repoRoot) : false,
    orcaWorktreeOk: worktree.ok,
    ownedTerminalClosed: options.prNumber > 0
      ? ownedSmokeTerminalClosedFromReports(comments, options.prNumber, options.headSha, options.issueNumber)
      : false,
    terminalProvenanceOk: pass ? verifyPublishedSmokeProvenance(pass) : false,
  });
  emit({ ok: decision.allowed, ...decision }, options.json);
  return decision.allowed ? 0 : 1;
}


function publishSmokeReport(
  report: SmokeReport,
  options: CliOptions,
): void {
  const comment = formatSmokeReportComment(report);
  if (!options.dryRun) {
    publishPrComment(options.prNumber, comment, options.repoRoot);
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

async function runSmokeAttempt(options: CliOptions): Promise<number> {
  const issueBody = readIssueBody(options.issueBodyFile);
  const plan = resolveSmokeRequirement(issueBody);
  if (plan.requirement !== 'required') {
    emit({ ok: true, skipped: true, reason: plan.requirement }, options.json);
    return 0;
  }

  if (plan.scenarios.length === 0) {
    const report: SmokeReport = {
      result: 'FAIL',
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
      scenarios: [{
        action: 'parse smoke-test-plan',
        expected: 'at least one executable scenario',
        observed: 'zero_parsed_scenarios',
        outcome: 'fail',
      }],
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'not_started',
      environmentNotes: ['smoke agent was not launched'],
      nonPassCause: 'zero_parsed_scenarios',
    };
    publishSmokeReport(report, options);
    emit({
      ok: false,
      nonPassCause: 'zero_parsed_scenarios' satisfies SmokeNonPassCause,
      reason: 'zero_parsed_scenarios',
      terminalCreated: false,
      published: !options.dryRun,
      report,
    }, options.json);
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
    const blocked: Partial<SmokeReport> = {
      result: 'BLOCKED',
      scenarios: [{
        action: 'resolve orca worktree',
        expected: 'cwd is Orca-managed',
        observed: diagnostic?.cause ?? worktree.reason ?? 'blocked',
        outcome: 'blocked',
      }],
      trackedFilesUnmodified: true,
      terminalCleanup: 'not_started',
      limitations: [],
      environmentNotes: [diagnostic ? 'orca control-plane preflight unavailable' : 'orca worktree current failed'],
      nonPassCause: diagnostic?.cause,
      controlPlaneDiagnostic: diagnostic,
    };
    const normalized = normalizeSmokeReport(blocked, {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    if (!normalized.ok) {
      fail(normalized.reason);
    }
    publishSmokeReport(normalized.report, options);
    emit(buildSmokeRunResult(normalized.report, !options.dryRun), options.json);
    return 1;
  }

  const gitHeadSha = resolveGitHead(options.cwd);
  const headBinding = verifySmokeHeadBinding({
    requestedHeadSha: options.headSha,
    orcaHeadSha: worktree.headSha,
    gitHeadSha,
  });
  if (!headBinding.ok) {
    const blocked: Partial<SmokeReport> = {
      result: 'BLOCKED',
      scenarios: [{
        action: 'bind smoke run to current checkout head',
        expected: `orca/git head equals ${options.headSha}`,
        observed: `${headBinding.reason}:${headBinding.observed}`,
        outcome: 'blocked',
      }],
      trackedFilesUnmodified: true,
      terminalCleanup: 'not_started',
      limitations: [],
      environmentNotes: ['head binding failed'],
    };
    const normalized = normalizeSmokeReport(blocked, {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    if (!normalized.ok) {
      fail(normalized.reason);
    }
    publishSmokeReport(normalized.report, options);
    emit(buildSmokeRunResult(normalized.report, !options.dryRun), options.json);
    return 1;
  }

  const beforeStatus = gitPorcelain(options.cwd);
  if (hasPreexistingTrackedDirtiness(beforeStatus)) {
    const blocked: Partial<SmokeReport> = {
      result: 'BLOCKED',
      scenarios: [{
        action: 'verify clean tracked worktree before smoke',
        expected: 'no pre-existing tracked modifications',
        observed: trackedPorcelainPaths(beforeStatus).join(', ') || 'tracked_dirty',
        outcome: 'blocked',
      }],
      trackedFilesUnmodified: true,
      terminalCleanup: 'not_started',
      limitations: [],
      environmentNotes: ['tracked worktree dirty before smoke launch'],
    };
    const normalized = normalizeSmokeReport(blocked, {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    if (!normalized.ok) {
      fail(normalized.reason);
    }
    publishSmokeReport(normalized.report, options);
    emit(buildSmokeRunResult(normalized.report, !options.dryRun), options.json);
    return 1;
  }
  const beforeHashes = hashTrackedPaths(options.cwd, trackedPorcelainPaths(beforeStatus));
  const created = createOrcaTerminal({
    cwd: options.cwd,
    title: `smoke-${options.issueNumber}`,
    command: 'cursor-agent',
  });
  if (!created.ok) {
    const diagnostic = createSmokeControlPlaneDiagnostic({
      terminalAcquired: false,
      operation: created.operation,
      outcomeCategory: created.outcomeCategory,
      controlPlaneCode: created.errorCode,
    });
    const blocked: Partial<SmokeReport> = {
      result: 'BLOCKED',
      scenarios: [{
        action: 'create Orca smoke terminal',
        expected: 'terminal create succeeds',
        observed: diagnostic?.cause ?? created.reason,
        outcome: 'blocked',
      }],
      trackedFilesUnmodified: true,
      terminalCleanup: 'not_started',
      limitations: [],
      environmentNotes: [diagnostic ? 'orca control-plane preflight unavailable' : 'orca terminal create failed'],
      nonPassCause: diagnostic?.cause,
      controlPlaneDiagnostic: diagnostic,
    };
    const normalized = normalizeSmokeReport(blocked, {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    if (!normalized.ok) {
      fail(normalized.reason);
    }
    const report = attachPackProducerFields(normalized.report, {});
    publishSmokeReport(report, options);
    emit(buildSmokeRunResult(report, !options.dryRun), options.json);
    return 1;
  }

  const handle = created.terminal.handle;
  const runId = createSmokeRunIdentity();
  const artifactDir = resolveSmokeRunArtifactDir(options.cwd, runId);
  ensureSmokeRunArtifactDir(artifactDir);
  const terminalPhaseStartedAt = Date.now();
  let terminalCleanup = 'pending';
  try {
    const prompt = buildSmokeAgentPrompt({
      issueNumber: options.issueNumber,
      issueBody,
      prNumber: options.prNumber,
      headSha: options.headSha,
      plan,
      runBinding: { runId, artifactDir },
    });
    const remainingTerminalBudgetMs = Math.max(
      0,
      SMOKE_AGENT_WAIT_BUDGET_MS - (Date.now() - terminalPhaseStartedAt),
    );
    const deliveryResult = establishSmokePromptDelivery(handle, {
      cwd: options.cwd,
      deadlineMs: remainingTerminalBudgetMs,
      runBinding: { runId, artifactDir },
      prompt,
    });
    if (!deliveryResult.ok) {
      const close = closeOwnedSmokeTerminal(handle, options.cwd);
      terminalCleanup = close.terminalCleanup;
      const diagnostic = deliveryResult.controlPlaneDiagnostic ?? close.diagnostic;
      const observed = diagnostic?.cause
        ?? deliveryResult.cause
        ?? 'prompt_delivery_unconfirmed';
      const report = attachControlPlaneDiagnostic(buildOperationalSmokeReport(
        diagnostic ? 'BLOCKED' : 'FAIL',
        options,
        {
          action: 'establish smoke prompt delivery',
          expected: 'publish-complete durable delivery evidence for current run',
          observed,
          terminalCleanup,
          environmentNotes: ['completion wait was not started'],
        },
      ), diagnostic);
      if (!diagnostic && deliveryResult.cause) {
        report.nonPassCause = deliveryResult.cause;
      }
      publishSmokeReport(report, options);
      emit(buildSmokeRunResult(report, !options.dryRun), options.json);
      return 1;
    }

    const completionBudgetMs = Math.max(
      0,
      SMOKE_AGENT_WAIT_BUDGET_MS - (Date.now() - terminalPhaseStartedAt),
    );
    const waitResult = waitForSmokeChildCompletion(handle, {
      cwd: options.cwd,
      deadlineMs: completionBudgetMs,
      runBinding: { runId, artifactDir },
      ownedChildHandle: handle,
    });
    if (!waitResult.ok) {
      const close = closeOwnedSmokeTerminal(handle, options.cwd);
      terminalCleanup = close.terminalCleanup;
      const diagnostic = waitResult.controlPlaneDiagnostic ?? close.diagnostic;
      const observed = diagnostic?.cause
        ?? waitResult.nonPassCause
        ?? scrubGhFailureMessage(waitResult.error?.message ?? 'child_wait_failed');
      const report = attachControlPlaneDiagnostic(buildOperationalSmokeReport(
        diagnostic ? 'BLOCKED' : 'FAIL',
        options,
        {
          action: 'wait for publish-complete smoke child completion',
          expected: 'one sealed durable completion artifact for current run',
          observed,
          terminalCleanup,
        },
      ), diagnostic);
      if (!diagnostic && waitResult.nonPassCause) {
        report.nonPassCause = waitResult.nonPassCause;
      }
      publishSmokeReport(report, options);
      emit(buildSmokeRunResult(report, !options.dryRun), options.json);
      return 1;
    }

    const partial = waitResult.partial;
    if (!partial) {
      const close = closeOwnedSmokeTerminal(handle, options.cwd);
      terminalCleanup = close.terminalCleanup;
      const report = attachControlPlaneDiagnostic(buildOperationalSmokeReport('BLOCKED', options, {
        action: 'consume publish-complete smoke child completion',
        expected: 'durable completion artifact with parseable fenced report',
        observed: close.diagnostic?.cause ?? 'missing_completion_partial',
        terminalCleanup,
      }), close.diagnostic);
      publishSmokeReport(report, options);
      emit(buildSmokeRunResult(report, !options.dryRun), options.json);
      return 1;
    }
    const afterStatus = gitPorcelain(options.cwd);
    const afterHashes = hashTrackedPaths(options.cwd, trackedPorcelainPaths(afterStatus));
    const mutated = detectTrackedImplementationMutation(beforeStatus, afterStatus, beforeHashes, afterHashes);

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
      const close = closeOwnedSmokeTerminal(handle, options.cwd);
      terminalCleanup = close.terminalCleanup;
      const report = attachControlPlaneDiagnostic(attachPackProducerFields(buildOperationalSmokeReport(
        close.diagnostic ? 'BLOCKED' : 'FAIL',
        options,
        {
          action: 'normalize smoke agent report',
          expected: 'valid PASS evidence',
          observed: close.diagnostic?.cause ?? normalized.reason,
          terminalCleanup,
        },
      ), { terminalHandle: handle }), close.diagnostic);
      const nonPassCause = classifyDeclaredScenarioNonPassCause({
        partial,
        agentActivityObserved: waitResult.agentActivityObserved,
        agentCompleted: true,
      });
      if (!close.diagnostic && nonPassCause) {
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

    const close = closeOwnedSmokeTerminal(handle, options.cwd);
    terminalCleanup = close.terminalCleanup;
    report.terminalCleanup = terminalCleanup;
    const establishedDiagnostic = report.controlPlaneDiagnostic ?? close.diagnostic;
    if (terminalCleanup !== 'closed_owned_handle') {
      if (report.result === 'PASS' || close.diagnostic) {
        report.result = close.diagnostic ? 'BLOCKED' : 'FAIL';
      }
      report.scenarios.push({
        action: SMOKE_HARNESS_TERMINAL_CLOSE_ACTION,
        expected: 'terminal close succeeds',
        observed: close.diagnostic?.cause ?? terminalCleanup,
        outcome: 'fail',
      });
    }
    attachControlPlaneDiagnostic(report, establishedDiagnostic);

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
    }), options.json);
    return report.result === 'PASS' ? 0 : 1;
  } finally {
    if (terminalCleanup === 'pending') {
      terminalCleanup = closeOwnedSmokeTerminal(handle, options.cwd).terminalCleanup;
    }
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

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
