#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
  fsyncSync,
} from 'node:fs';
import { dirname, basename, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TURN_STATES, type FailureScope, type TurnResultV1, type TurnState } from './chatgpt-browser-turn/contracts.ts';
import { runProcess, type ProcessResult } from './kernel/subprocess.ts';
import {
  authorityAbsent,
  parseBrowserTurnCancellationReceipt,
  type BrowserTurnCancellationAttempt,
  type BrowserTurnCancellationDependencies,
  type BrowserTurnCancellationReceipt,
} from './chatgpt-browser-turn/state-light-cancellation.ts';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import {
  defaultGhTransport,
  fetchIssueComments,
  fetchIssueRevision,
  withGhDeadline,
} from './lib/create-issue-stage-record-gh.ts';
import type { GhTransport } from './lib/create-issue-stage-record-types.ts';

export const COMPLETION_MODE = 'browser-turn-result-v1' as const;
export const HANDOFF_SCHEMA = 'flow-manager-long-running-child-handoff/v1' as const;
export const TERMINAL_SCHEMA = 'flow-manager-long-running-child-terminal/v1' as const;
export const WAIT_SCHEMA = 'flow-manager-long-running-child-wait/v1' as const;
export const REFUSAL_SCHEMA = 'flow-manager-long-running-child-refusal/v1' as const;
export const CONCURRENT_BATCH_INCIDENT_SCHEMA = 'flow-manager-concurrent-batch-incident/v1' as const;

export type DeliveryState = 'not-sent' | 'POSSIBLY_DELIVERED' | 'landed';

export type ParsedTurnResult = TurnResultV1 & { readonly resolved_send_count: number };

export interface HandoffReceipt {
  readonly schema: typeof HANDOFF_SCHEMA;
  readonly run_identity: string;
  readonly attempt_identity: string;
  readonly launcher_started_at: string;
  readonly handoff_committed_at: string;
  readonly completion_mode: typeof COMPLETION_MODE;
}

export interface TerminalEnvelope {
  readonly schema: typeof TERMINAL_SCHEMA;
  readonly run_identity: string;
  readonly attempt_identity: string;
  readonly completion_mode: typeof COMPLETION_MODE;
  readonly handoff_receipt_path: string;
  readonly launcher_started_at: string;
  readonly handoff_committed_at: string;
  readonly terminal_at: string;
  readonly lifecycle_outcome: 'success' | 'incident';
  readonly incident?: string;
  readonly delivery: DeliveryState;
  readonly child_exit_code?: number | null;
  readonly turn_result_state?: string;
  readonly turn_result_cause?: string;
  readonly send_count?: number;
  readonly recovery_available: boolean;
  readonly conversation_locator?: string;
  readonly diagnostics?: Record<string, unknown>;
}

export type ReviewerPublicationExpectation = {
  readonly kind: 'reviewer';
  readonly repository: string;
  readonly issueNumber: number;
  readonly sourceRevision: string;
  readonly invocationId: string;
  readonly stage: string;
  readonly sourceSlot: string;
};

export type PublicationExpectation =
  | {
      readonly kind: 'author';
      readonly repository: string;
      readonly issueNumber: number;
      readonly sourceRevision: string;
      readonly exactBodySha256: string;
    }
  | ReviewerPublicationExpectation;

export type PublicationObservation =
  | {
      readonly status: 'published';
      readonly kind: 'author';
      readonly repository: string;
      readonly issueNumber: number;
      readonly sourceRevision: string;
      readonly exactBodySha256: string;
    }
  | {
      readonly status: 'published';
      readonly kind: 'reviewer';
      readonly repository: string;
      readonly issueNumber: number;
      readonly sourceRevision: string;
      readonly invocationId: string;
      readonly stage: string;
      readonly sourceSlot: string;
      readonly commentId: number;
      readonly principal: string;
    }
  | {
      readonly status: 'missing' | 'unavailable' | 'blocked';
      readonly reason: string;
      readonly diagnostics?: readonly string[];
    };

export interface ConcurrentBatchSlotEvidence {
  readonly invocationId: string;
  readonly publication: 'published' | 'missing' | 'unavailable' | 'blocked';
  readonly childHint?: string;
}

export interface ConcurrentBatchSlotAttribution {
  readonly invocationId: string;
  readonly classification: 'actual' | 'possible-or-actual' | 'unproven';
  readonly resendForbidden: boolean;
  readonly settlement: 'published' | 'incident' | 'unsettled';
  readonly childHint?: string;
}

const DEFAULT_CANDIDATE_GRACE_MS = 5_000;
const DEFAULT_NO_CANDIDATE_GRACE_MS = 5_000;
const DIAGNOSTICS_BYTE_CAP = 4_096;
const FAILURE_SCOPES: readonly FailureScope[] = [
  'none',
  'invocation',
  'conversation',
  'profile',
  'machine',
  'blocking_domain',
];

function isTurnState(value: string): value is TurnState {
  return (TURN_STATES as readonly string[]).includes(value);
}

function isFailureScope(value: string): value is FailureScope {
  return FAILURE_SCOPES.includes(value as FailureScope);
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function candidateGraceMs(): number {
  return envMs('OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS', DEFAULT_CANDIDATE_GRACE_MS);
}

function noCandidateGraceMs(): number {
  return envMs('OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS', DEFAULT_NO_CANDIDATE_GRACE_MS);
}

function nowIso(): string {
  return new Date().toISOString();
}

interface ParsedCli {
  readonly options: Map<string, string | true>;
  readonly childArgs: readonly string[];
}

/** Shared `--key value` / `--flag` argv parser for flow-manager launcher CLIs (#1164). */
export function parseFlagArgv(argv: readonly string[]): Map<string, string | true> {
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return options;
}

function parseCli(argv: readonly string[]): ParsedCli {
  const options = new Map<string, string | true>();
  const childArgs: string[] = [];
  let collectingChildArgs = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (collectingChildArgs) {
      childArgs.push(token);
      continue;
    }
    if (token === '--') {
      collectingChildArgs = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return { options, childArgs };
}

function requiredOption(options: Map<string, string | true>, key: string): string {
  const value = options.get(key);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`argument_required:${key}`);
  return value;
}

function isCaseInsensitiveFs(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function foldCase(path: string): string {
  return isCaseInsensitiveFs() ? path.toLowerCase() : path;
}

function existingInodeIdentity(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return `inode:${stat.dev}:${stat.ino}`;
}

export function resolvePlannedIdentity(path: string): string {
  const absolute = resolve(path);
  const inode = existingInodeIdentity(absolute);
  if (inode) return inode;
  let cursor = absolute;
  let suffix = '';
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix = join(basename(cursor), suffix);
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync(cursor) : cursor;
  const planned = suffix ? join(base, suffix) : base;
  return `planned:${foldCase(normalize(planned))}`;
}

export function pathsAlias(left: string, right: string): boolean {
  const leftIdentity = resolvePlannedIdentity(left);
  const rightIdentity = resolvePlannedIdentity(right);
  if (leftIdentity === rightIdentity) return true;
  const leftAbs = foldCase(normalize(resolve(left)));
  const rightAbs = foldCase(normalize(resolve(right)));
  return leftAbs === rightAbs;
}

function assertPairwiseDistinct(paths: readonly string[]): void {
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      if (pathsAlias(paths[i]!, paths[j]!)) {
        throw new Error(`artifact_path_alias:${i}:${j}`);
      }
    }
  }
}

function ensureParentWritable(path: string): void {
  const parent = dirname(resolve(path));
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const probe = join(parent, `.opk-write-probe-${process.pid}`);
  const handle = openSync(probe, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  closeSync(handle);
  try {
    unlinkSync(probe);
  } catch {
    // best effort
  }
}

function isOccupiedPathError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EEXIST';
}

function atomicCreateJson(path: string, body: Record<string, unknown>, kind: 'receipt' | 'envelope'): void {
  ensureParentWritable(path);
  if (kind === 'receipt' && process.env.OPK_FM_LONG_CHILD_FORCE_RECEIPT_CREATE_FAIL === '1') {
    throw new Error('forced_receipt_create_failure');
  }
  if (kind === 'envelope' && process.env.OPK_FM_LONG_CHILD_FORCE_ENVELOPE_CREATE_FAIL === '1') {
    throw new Error('forced_envelope_create_failure');
  }
  const target = resolve(path);
  const bytes = Buffer.from(JSON.stringify(body) + '\n', 'utf8');
  let handle: number;
  try {
    handle = openSync(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (error) {
    if (isOccupiedPathError(error)) {
      throw new Error('occupied_launcher_owned_path');
    }
    throw error;
  }
  try {
    writeSync(handle, bytes);
    try {
      fchmodSync(handle, 0o600);
    } catch {
      // unsupported on some platforms
    }
    try {
      fsyncSync(handle);
    } catch {
      // best effort
    }
  } catch (error) {
    try {
      unlinkSync(target);
    } catch {
      // best effort
    }
    throw error;
  } finally {
    closeSync(handle);
  }
}

function refuse(reason: string, details?: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ schema: REFUSAL_SCHEMA, reason, ...(details ?? {}) })}\n`);
  process.exitCode = 2;
}

function resolveSendCount(body: Record<string, unknown>, result: TurnResultV1): number {
  if (typeof body.send_count === 'number' && Number.isFinite(body.send_count)) {
    return body.send_count;
  }
  return result.observation_uncertainty_diagnostics?.send_count ?? 0;
}

function deliveryWithoutTurnResult(spawnFailed: boolean): DeliveryState {
  return spawnFailed ? 'not-sent' : 'POSSIBLY_DELIVERED';
}

function parseTurnResult(line: string): ParsedTurnResult | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    const body = parsed as Record<string, unknown>;
    if (body.schema !== 'turn-result/v1') return null;
    if (typeof body.state !== 'string' || !isTurnState(body.state)) return null;
    if (typeof body.scope !== 'string' || !isFailureScope(body.scope)) return null;
    if (typeof body.cause !== 'string') return null;
    if (typeof body.invocation_id !== 'string') return null;
    if (typeof body.configured_profile_key !== 'string') return null;

    const result: TurnResultV1 = {
      schema: 'turn-result/v1',
      state: body.state,
      scope: body.scope,
      cause: body.cause,
      invocation_id: body.invocation_id,
      configured_profile_key: body.configured_profile_key,
    };

    if (typeof body.legacy_configured_profile_key === 'string') {
      result.legacy_configured_profile_key = body.legacy_configured_profile_key;
    }
    if (typeof body.legacy_namespace_root === 'string') {
      result.legacy_namespace_root = body.legacy_namespace_root;
    }
    if (typeof body.conversation_id === 'string') {
      result.conversation_id = body.conversation_id;
    }
    if (typeof body.provisional_id === 'string') {
      result.provisional_id = body.provisional_id;
    }
    if (typeof body.incident_id === 'string') {
      result.incident_id = body.incident_id;
    }
    if (typeof body.generation === 'number' && Number.isFinite(body.generation)) {
      result.generation = body.generation;
    }
    if (typeof body.driver_diagnostic_id === 'string') {
      result.driver_diagnostic_id = body.driver_diagnostic_id;
    }

    const output = body.output;
    if (
      output &&
      typeof output === 'object' &&
      typeof (output as Record<string, unknown>).byte_length === 'number' &&
      typeof (output as Record<string, unknown>).sha256 === 'string'
    ) {
      result.output = {
        byte_length: (output as { byte_length: number }).byte_length,
        sha256: (output as { sha256: string }).sha256,
      };
    }

    const reviewerSource = body.reviewer_source;
    if (reviewerSource && typeof reviewerSource === 'object') {
      const source = reviewerSource as Record<string, unknown>;
      const kind = source.kind;
      const validKind = kind === 'service-observed-issue-comment/v1' || kind === 'failed-write-final-assistant/v1';
      if (
        validKind
        && Number.isInteger(source.byte_length) && Number(source.byte_length) >= 0
        && typeof source.sha256 === 'string' && /^[0-9a-f]{64}$/.test(source.sha256)
        && typeof source.tool_call_id === 'string' && source.tool_call_id.length > 0
        && typeof source.repository_full_name === 'string' && source.repository_full_name.length > 0
        && Number.isInteger(source.issue_number) && Number(source.issue_number) > 0
        && typeof source.source_revision === 'string' && /^r[0-9]+$/.test(source.source_revision)
        && Number.isInteger(source.finding_count) && Number(source.finding_count) >= 0
        && (source.comment_id === undefined || typeof source.comment_id === 'string')
        && (source.comment_url === undefined || typeof source.comment_url === 'string')
      ) {
        result.reviewer_source = {
          kind: kind as 'service-observed-issue-comment/v1' | 'failed-write-final-assistant/v1',
          byte_length: Number(source.byte_length),
          sha256: source.sha256 as string,
          tool_call_id: source.tool_call_id as string,
          repository_full_name: source.repository_full_name as string,
          issue_number: Number(source.issue_number),
          source_revision: source.source_revision as string,
          finding_count: Number(source.finding_count),
          ...(typeof source.comment_id === 'string' ? { comment_id: source.comment_id } : {}),
          ...(typeof source.comment_url === 'string' ? { comment_url: source.comment_url } : {}),
        };
      }
    }

    const witness = body.witness;
    if (
      witness &&
      typeof witness === 'object' &&
      typeof (witness as Record<string, unknown>).user_message_id === 'string' &&
      typeof (witness as Record<string, unknown>).assistant_message_id === 'string' &&
      (witness as Record<string, unknown>).relation === 'reply_to' &&
      (witness as Record<string, unknown>).source === 'service'
    ) {
      result.witness = {
        user_message_id: (witness as { user_message_id: string }).user_message_id,
        assistant_message_id: (witness as { assistant_message_id: string }).assistant_message_id,
        relation: 'reply_to',
        source: 'service',
      };
    }

    const uncertainty = body.observation_uncertainty_diagnostics;
    if (
      uncertainty &&
      typeof uncertainty === 'object' &&
      typeof (uncertainty as Record<string, unknown>).cause === 'string' &&
      typeof (uncertainty as Record<string, unknown>).send_count === 'number' &&
      typeof (uncertainty as Record<string, unknown>).owned_prompt_seen === 'boolean'
    ) {
      const diag: TurnResultV1['observation_uncertainty_diagnostics'] = {
        cause: (uncertainty as { cause: string }).cause,
        send_count: (uncertainty as { send_count: number }).send_count,
        owned_prompt_seen: (uncertainty as { owned_prompt_seen: boolean }).owned_prompt_seen,
      };
      const observedHeads = (uncertainty as { observed_user_heads?: unknown }).observed_user_heads;
      if (Array.isArray(observedHeads) && observedHeads.every((head) => typeof head === 'string')) {
        diag.observed_user_heads = observedHeads;
      }
      result.observation_uncertainty_diagnostics = diag;
    }

    const resolved_send_count = resolveSendCount(body, result);
    return { ...result, resolved_send_count };
  } catch {
    return null;
  }
}

function parseHeartbeat(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    if (body.schema !== 'observation-heartbeat/v1') return null;
    return {
      poll_count: body.poll_count,
      observation_state: body.observation_state,
      stable_reads: body.stable_reads,
      completion_ready: body.completion_ready,
    };
  } catch {
    return null;
  }
}

function resolveConversationLocator(
  config: LaunchConfig,
  candidate?: { conversation_id?: string },
): string | undefined {
  return config.conversationLocator ?? candidate?.conversation_id ?? undefined;
}

function conversationLocatorFields(
  config: LaunchConfig,
  candidate?: { conversation_id?: string },
): Pick<TerminalEnvelope, 'recovery_available' | 'conversation_locator'> {
  const locator = resolveConversationLocator(config, candidate);
  return {
    recovery_available: Boolean(locator),
    ...(locator ? { conversation_locator: locator } : {}),
  };
}

export function deriveDelivery(result: ParsedTurnResult | null, childStartFailed: boolean): DeliveryState {
  if (childStartFailed) return 'not-sent';
  if (!result) return 'not-sent';
  const sendCount = result.resolved_send_count;
  if (result.state === 'output_conflict') {
    return sendCount === 0 ? 'not-sent' : 'POSSIBLY_DELIVERED';
  }
  if (sendCount === 0) return 'not-sent';
  if (result.witness?.relation === 'reply_to' && (result.conversation_id || result.observation_uncertainty_diagnostics?.owned_prompt_seen)) {
    return 'landed';
  }
  if (sendCount > 0) return 'POSSIBLY_DELIVERED';
  if (result.state === 'ok') return 'POSSIBLY_DELIVERED';
  return 'not-sent';
}

function parseCancellationReceiptLine(line: string): BrowserTurnCancellationReceipt | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return parseBrowserTurnCancellationReceipt(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function cancellationReceiptIsBound(
  config: LaunchConfig,
  receipt: BrowserTurnCancellationReceipt,
): boolean {
  const childArgValue = (flag: string): string | undefined => {
    for (let index = 0; index + 1 < config.childArgs.length; index += 1) {
      if (config.childArgs[index] !== flag) continue;
      const value = config.childArgs[index + 1];
      if (value && !value.startsWith('--')) return value;
    }
    return undefined;
  };
  const invocationId = childArgValue('--invocation-id');
  const profile = childArgValue('--profile');
  const cdp = childArgValue('--cdp');
  if (!invocationId || !profile || !cdp) return false;
  try {
    return receipt.invocation_id === invocationId
      && receipt.configured_profile_key === configuredProfileKey(profile, cdp);
  } catch {
    return false;
  }
}

function identityUnprovenCancellation(): BrowserTurnCancellationAttempt {
  return {
    state: 'driver_error',
    cause: 'child_stdout_eof_timeout_cancellation_receipt_identity_unproven',
    stopOutcome: 'not_attempted_identity_unproven',
    identityProven: false,
  };
}

async function runChildEofCancellation(
  config: LaunchConfig,
  capture: CandidateCapture,
): Promise<BrowserTurnCancellationAttempt> {
  const receipt = capture.cancellationReceipt;
  if (!receipt) {
    return {
      state: 'driver_error',
      cause: 'child_stdout_eof_timeout_cancellation_receipt_missing',
      stopOutcome: 'not_attempted_authority_absent',
      identityProven: false,
    };
  }
  if (!cancellationReceiptIsBound(config, receipt)) {
    return identityUnprovenCancellation();
  }
  if (capture.duplicateCancellationReceipt) {
    return {
      state: 'driver_error',
      cause: 'child_stdout_eof_timeout_cancellation_receipt_duplicate',
      sendCount: 1,
      stopOutcome: 'not_attempted_authority_absent',
      identityProven: false,
      conversationUrl: receipt.conversation_url,
    };
  }
  return authorityAbsent(receipt);
}

function cancellationEnvelopeFields(
  attempt: BrowserTurnCancellationAttempt,
  childStartFailed: boolean,
): Pick<TerminalEnvelope, 'delivery' | 'send_count' | 'recovery_available' | 'conversation_locator'> {
  return {
    delivery: childStartFailed ? 'not-sent' : 'POSSIBLY_DELIVERED',
    ...(attempt.sendCount ? { send_count: attempt.sendCount } : {}),
    recovery_available: Boolean(attempt.conversationUrl),
    ...(attempt.conversationUrl ? { conversation_locator: attempt.conversationUrl } : {}),
  };
}

function cancellationDiagnostics(
  attempt: BrowserTurnCancellationAttempt,
  heartbeatDiagnostics: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return boundedDiagnostics({
    ...(heartbeatDiagnostics ? { last_heartbeat: heartbeatDiagnostics } : {}),
    cancellation: {
      state: attempt.state,
      cause: attempt.cause,
      stop_outcome: attempt.stopOutcome,
      identity_proven: attempt.identityProven,
    },
  });
}

function boundedDiagnostics(input: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(input);
  if (json.length <= DIAGNOSTICS_BYTE_CAP) return input;
  return { truncated: true, byte_length: json.length };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForProcessCompletion(
  runPromise: Promise<ProcessResult>,
  graceMs: number,
): Promise<{ completed: boolean; result?: ProcessResult }> {
  return await Promise.race([
    runPromise.then((result) => ({ completed: true, result })),
    delay(graceMs).then(() => ({ completed: false })),
  ]);
}

async function abortManagedProcess(
  controller: AbortController,
  runPromise: Promise<ProcessResult>,
): Promise<void> {
  controller.abort();
  try {
    await runPromise;
  } catch {
    // process already terminal
  }
}

export interface LaunchConfig {
  readonly runIdentity: string;
  readonly attemptIdentity: string;
  readonly handoffReceiptPath: string;
  readonly terminalEnvelopePath: string;
  readonly browserOutputPath: string;
  readonly reviewerSourceOutputPath?: string;
  readonly cwd: string;
  readonly childCommand: string;
  readonly childArgs: readonly string[];
  readonly conversationLocator?: string;
  readonly secretCanaries?: readonly string[];
  readonly cancellationDependencies?: BrowserTurnCancellationDependencies;
}

function scanArtifactForCanaries(path: string, canaries: readonly string[]): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return canaries.filter((canary) => text.includes(canary));
}

async function publishEnvelope(config: LaunchConfig, envelope: TerminalEnvelope): Promise<boolean> {
  try {
    atomicCreateJson(config.terminalEnvelopePath, envelope as unknown as Record<string, unknown>, 'envelope');
    return true;
  } catch {
    return false;
  }
}

interface CandidateCapture {
  firstCandidate: ParsedTurnResult | null;
  duplicateCandidate: boolean;
  cancellationReceipt: BrowserTurnCancellationReceipt | null;
  duplicateCancellationReceipt: boolean;
  stdoutBuffer: string;
  drainStdoutBuffer: () => void;
}

async function finalizeCandidatePath(
  config: LaunchConfig,
  receipt: HandoffReceipt,
  launcherStartedAt: string,
  capture: CandidateCapture,
  runPromise: Promise<ProcessResult>,
  controller: AbortController,
  childExitCode: number | null,
  heartbeatDiagnostics: Record<string, unknown> | undefined,
): Promise<number> {
  const grace = candidateGraceMs();
  const completion = await waitForProcessCompletion(runPromise, grace);
  capture.drainStdoutBuffer();
  if (capture.stdoutBuffer.trim()) {
    const trailing = parseTurnResult(capture.stdoutBuffer);
    if (trailing) {
      if (!capture.firstCandidate) capture.firstCandidate = trailing;
      else capture.duplicateCandidate = true;
    }
  }
  const candidate = capture.firstCandidate;
  if (!candidate) {
    await abortManagedProcess(controller, runPromise);
    return 1;
  }
  const exited = completion.completed;
  const eof = exited;
  const incidentEnvelope = (incident: string): TerminalEnvelope => ({
    schema: TERMINAL_SCHEMA,
    run_identity: config.runIdentity,
    attempt_identity: config.attemptIdentity,
    completion_mode: COMPLETION_MODE,
    handoff_receipt_path: config.handoffReceiptPath,
    launcher_started_at: launcherStartedAt,
    handoff_committed_at: receipt.handoff_committed_at,
    terminal_at: nowIso(),
    lifecycle_outcome: 'incident',
    incident,
    delivery: deriveDelivery(candidate, false),
    child_exit_code: childExitCode,
    turn_result_state: candidate.state,
    turn_result_cause: candidate.cause,
    send_count: candidate.resolved_send_count,
    ...conversationLocatorFields(config, candidate),
  });
  if (capture.duplicateCandidate) {
    await publishEnvelope(config, incidentEnvelope('child_terminal_result_duplicate'));
    await abortManagedProcess(controller, runPromise);
    await delay(100);
    return 1;
  }
  if (!exited || !eof) {
    await publishEnvelope(config, incidentEnvelope('child_post_result_exit_timeout'));
    await abortManagedProcess(controller, runPromise);
    await delay(100);
    return 1;
  }
  if (candidate.state === 'ok') {
    await publishEnvelope(config, {
      schema: TERMINAL_SCHEMA,
      run_identity: config.runIdentity,
      attempt_identity: config.attemptIdentity,
      completion_mode: COMPLETION_MODE,
      handoff_receipt_path: config.handoffReceiptPath,
      launcher_started_at: launcherStartedAt,
      handoff_committed_at: receipt.handoff_committed_at,
      terminal_at: nowIso(),
      lifecycle_outcome: 'success',
      delivery: deriveDelivery(candidate, false),
      child_exit_code: childExitCode,
      turn_result_state: candidate.state,
      turn_result_cause: candidate.cause,
      send_count: candidate.resolved_send_count,
      ...conversationLocatorFields(config, candidate),
      ...(heartbeatDiagnostics ? { diagnostics: heartbeatDiagnostics } : {}),
    });
    await abortManagedProcess(controller, runPromise);
    return 0;
  }
  await publishEnvelope(config, incidentEnvelope(`child_turn_state:${candidate.state}`));
  await abortManagedProcess(controller, runPromise);
  return 1;
}

export async function runLaunch(config: LaunchConfig): Promise<number> {
  const canaries = config.secretCanaries ?? [];
  if (!existsSync(config.cwd) || !statSync(config.cwd).isDirectory()) {
    refuse('invalid_cwd', { cwd: config.cwd });
    return 2;
  }
  const launcherArtifacts = [
    config.handoffReceiptPath,
    config.terminalEnvelopePath,
    config.browserOutputPath,
    ...(config.reviewerSourceOutputPath ? [config.reviewerSourceOutputPath] : []),
  ];
  for (const path of launcherArtifacts) {
    if (existsSync(path)) {
      refuse('occupied_launcher_owned_path', { path });
      return 2;
    }
  }
  try {
    assertPairwiseDistinct(launcherArtifacts);
    ensureParentWritable(config.handoffReceiptPath);
    ensureParentWritable(config.terminalEnvelopePath);
    ensureParentWritable(config.browserOutputPath);
    if (config.reviewerSourceOutputPath) ensureParentWritable(config.reviewerSourceOutputPath);
  } catch (error) {
    refuse('preflight_failed', { message: error instanceof Error ? error.message : String(error) });
    return 2;
  }

  const launcherStartedAt = nowIso();
  const receipt: HandoffReceipt = {
    schema: HANDOFF_SCHEMA,
    run_identity: config.runIdentity,
    attempt_identity: config.attemptIdentity,
    launcher_started_at: launcherStartedAt,
    handoff_committed_at: nowIso(),
    completion_mode: COMPLETION_MODE,
  };
  try {
    atomicCreateJson(config.handoffReceiptPath, receipt as unknown as Record<string, unknown>, 'receipt');
  } catch (error) {
    refuse('receipt_create_failed', { message: error instanceof Error ? error.message : String(error) });
    return 2;
  }
  if (scanArtifactForCanaries(config.handoffReceiptPath, canaries).length > 0) {
    refuse('canary_in_receipt');
    return 2;
  }

  const controller = new AbortController();
  const capture: CandidateCapture = {
    firstCandidate: null,
    duplicateCandidate: false,
    cancellationReceipt: null,
    duplicateCancellationReceipt: false,
    stdoutBuffer: '',
    drainStdoutBuffer: () => {},
  };
  let lastHeartbeatDiagnostics: Record<string, unknown> | undefined;
  let childExitCode: number | null = null;
  let childExitedBeforeCandidate = false;
  const noCandidateDeadlineMs = noCandidateGraceMs() + candidateGraceMs();
  let deadline = Date.now() + noCandidateDeadlineMs;

  const ingestStdoutLine = (line: string): void => {
    const cancellationReceipt = parseCancellationReceiptLine(line);
    if (cancellationReceipt) {
      if (!capture.cancellationReceipt) capture.cancellationReceipt = cancellationReceipt;
      else capture.duplicateCancellationReceipt = true;
      return;
    }
    const heartbeat = parseHeartbeat(line);
    if (heartbeat) {
      lastHeartbeatDiagnostics = boundedDiagnostics(heartbeat);
      deadline = Date.now() + noCandidateDeadlineMs;
      return;
    }
    const candidate = parseTurnResult(line);
    if (!candidate) return;
    if (!capture.firstCandidate) capture.firstCandidate = candidate;
    else capture.duplicateCandidate = true;
  };

  const drainStdoutBuffer = (): void => {
    let newlineIndex = capture.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = capture.stdoutBuffer.slice(0, newlineIndex);
      capture.stdoutBuffer = capture.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = capture.stdoutBuffer.indexOf('\n');
      ingestStdoutLine(line);
    }
  };
  capture.drainStdoutBuffer = drainStdoutBuffer;

  const runPromise = runProcess({
    command: config.childCommand,
    args: [...config.childArgs],
    cwd: config.cwd,
    inheritParentEnv: true,
    allowEmptyStdout: true,
    signal: controller.signal,
    onStdoutChunk: (chunk) => {
      capture.stdoutBuffer += chunk;
      capture.drainStdoutBuffer();
    },
  }).then((result) => {
    childExitCode = result.exitCode;
    capture.drainStdoutBuffer();
    if (!capture.firstCandidate) childExitedBeforeCandidate = true;
    return result;
  });

  const spawnProbe = await Promise.race([
    runPromise.then((result) => ({ kind: 'done' as const, result })),
    delay(100).then(() => ({ kind: 'pending' as const })),
  ]);
  if (spawnProbe.kind === 'done' && spawnProbe.result.outcome === 'spawn-failure') {
    await publishEnvelope(config, {
      schema: TERMINAL_SCHEMA,
      run_identity: config.runIdentity,
      attempt_identity: config.attemptIdentity,
      completion_mode: COMPLETION_MODE,
      handoff_receipt_path: config.handoffReceiptPath,
      launcher_started_at: launcherStartedAt,
      handoff_committed_at: receipt.handoff_committed_at,
      terminal_at: nowIso(),
      lifecycle_outcome: 'incident',
      incident: 'child_start_failed',
      delivery: deliveryWithoutTurnResult(true),
      recovery_available: Boolean(config.conversationLocator),
      ...(config.conversationLocator ? { conversation_locator: config.conversationLocator } : {}),
    });
    return 1;
  }

  while (!capture.firstCandidate && !childExitedBeforeCandidate && Date.now() < deadline) {
    await delay(20);
  }

  if (capture.stdoutBuffer.trim() && !capture.firstCandidate) {
    const trailing = parseTurnResult(capture.stdoutBuffer);
    if (trailing) capture.firstCandidate = trailing;
  }

  if (capture.firstCandidate) {
    return await finalizeCandidatePath(
      config,
      receipt,
      launcherStartedAt,
      capture,
      runPromise,
      controller,
      childExitCode,
      lastHeartbeatDiagnostics,
    );
  }

  if (childExitedBeforeCandidate || childExitCode !== null) {
    const grace = noCandidateGraceMs();
    const completion = await waitForProcessCompletion(runPromise, grace);
    capture.drainStdoutBuffer();
    if (capture.stdoutBuffer.trim() && !capture.firstCandidate) {
      const trailing = parseTurnResult(capture.stdoutBuffer);
      if (trailing) capture.firstCandidate = trailing;
    }
    if (capture.firstCandidate) {
      return await finalizeCandidatePath(
        config,
        receipt,
        launcherStartedAt,
        capture,
        runPromise,
        controller,
        childExitCode,
        lastHeartbeatDiagnostics,
      );
    }
    const spawnFailed = completion.result?.outcome === 'spawn-failure';
    if (!completion.completed || capture.cancellationReceipt) {
      const cancellation = await runChildEofCancellation(config, capture);
      await publishEnvelope(config, {
        schema: TERMINAL_SCHEMA,
        run_identity: config.runIdentity,
        attempt_identity: config.attemptIdentity,
        completion_mode: COMPLETION_MODE,
        handoff_receipt_path: config.handoffReceiptPath,
        launcher_started_at: launcherStartedAt,
        handoff_committed_at: receipt.handoff_committed_at,
        terminal_at: nowIso(),
        lifecycle_outcome: 'incident',
        incident: 'child_stdout_eof_timeout',
        child_exit_code: childExitCode,
        turn_result_state: cancellation.state,
        turn_result_cause: cancellation.cause,
        ...cancellationEnvelopeFields(cancellation, spawnFailed),
        diagnostics: cancellationDiagnostics(cancellation, lastHeartbeatDiagnostics),
      });
      await abortManagedProcess(controller, runPromise);
      return 1;
    }
    const incident = spawnFailed ? 'child_start_failed' : 'child_terminal_result_missing';
    await publishEnvelope(config, {
      schema: TERMINAL_SCHEMA,
      run_identity: config.runIdentity,
      attempt_identity: config.attemptIdentity,
      completion_mode: COMPLETION_MODE,
      handoff_receipt_path: config.handoffReceiptPath,
      launcher_started_at: launcherStartedAt,
      handoff_committed_at: receipt.handoff_committed_at,
      terminal_at: nowIso(),
      lifecycle_outcome: 'incident',
      incident,
      delivery: deliveryWithoutTurnResult(spawnFailed),
      child_exit_code: childExitCode,
      recovery_available: Boolean(config.conversationLocator),
      ...(config.conversationLocator ? { conversation_locator: config.conversationLocator } : {}),
    });
    await abortManagedProcess(controller, runPromise);
    return 1;
  }

  const cancellation = await runChildEofCancellation(config, capture);
  await publishEnvelope(config, {
    schema: TERMINAL_SCHEMA,
    run_identity: config.runIdentity,
    attempt_identity: config.attemptIdentity,
    completion_mode: COMPLETION_MODE,
    handoff_receipt_path: config.handoffReceiptPath,
    launcher_started_at: launcherStartedAt,
    handoff_committed_at: receipt.handoff_committed_at,
    terminal_at: nowIso(),
    lifecycle_outcome: 'incident',
    incident: 'child_stdout_eof_timeout',
    child_exit_code: childExitCode,
    turn_result_state: cancellation.state,
    turn_result_cause: cancellation.cause,
    ...cancellationEnvelopeFields(cancellation, false),
    diagnostics: cancellationDiagnostics(cancellation, lastHeartbeatDiagnostics),
  });
  await abortManagedProcess(controller, runPromise);
  return 1;
}

export function readTerminalEnvelope(
  path: string,
  expected?: { runIdentity: string; attemptIdentity: string },
): TerminalEnvelope | null {
  if (!existsSync(path)) return null;
  try {
    const body = JSON.parse(readFileSync(path, 'utf8')) as TerminalEnvelope;
    if (body.schema !== TERMINAL_SCHEMA) return null;
    if (
      expected &&
      (body.run_identity !== expected.runIdentity || body.attempt_identity !== expected.attemptIdentity)
    ) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

export function readHandoffReceipt(
  path: string,
  expected?: { runIdentity: string; attemptIdentity: string },
): HandoffReceipt | null {
  if (!existsSync(path)) return null;
  try {
    const body = JSON.parse(readFileSync(path, 'utf8')) as HandoffReceipt;
    if (body.schema !== HANDOFF_SCHEMA) return null;
    if (
      expected &&
      (body.run_identity !== expected.runIdentity || body.attempt_identity !== expected.attemptIdentity)
    ) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

function issueSourceRevision(body: string): string | null {
  const match = body.match(/<!--\s*source-revision:\s*(r[0-9]+)\s*-->/u);
  return match?.[1] ?? null;
}

function sha256Text(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function nonEmptyLines(body: string): readonly string[] {
  return body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function exactLineCount(lines: readonly string[], expected: string): number {
  return lines.filter((line) => line === expected).length;
}

function authenticatedPrincipal(transport: GhTransport): string | null {
  const response = transport.runGh(['gh', 'api', 'user', '--jq', '.login']);
  if (response.exitCode !== 0) return null;
  const login = response.stdout.trim();
  return login || null;
}

interface RejectedPublicationComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly userLogin: string;
}

function fetchRejectedPublicationComments(
  transport: GhTransport,
  repository: string,
  diagnostics: readonly { readonly code: string; readonly commentId?: number }[],
): { readonly comments: readonly RejectedPublicationComment[]; readonly unavailableReason?: string } {
  const rejectedIds = [...new Set(diagnostics
    .filter((item) => (item.code === 'foreign-comment' || item.code === 'edited-comment')
      && Number.isInteger(item.commentId))
    .map((item) => Number(item.commentId)))];
  if (rejectedIds.length === 0) return { comments: [] };
  const [owner, name, extra] = repository.split('/');
  if (!owner || !name || extra) {
    return { comments: [], unavailableReason: 'publication_repository_invalid' };
  }
  const comments: RejectedPublicationComment[] = [];
  for (const id of rejectedIds) {
    const response = transport.runGh(['gh', 'api', `repos/${owner}/${name}/issues/comments/${id}`]);
    if (response.exitCode !== 0) {
      return {
        comments: [],
        unavailableReason: response.stderr.trim() || `publication_rejected_comment_fetch_failed:${id}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.stdout);
    } catch {
      return { comments: [], unavailableReason: `publication_rejected_comment_malformed:${id}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { comments: [], unavailableReason: `publication_rejected_comment_invalid:${id}` };
    }
    const raw = parsed as Record<string, unknown>;
    const user = raw.user as Record<string, unknown> | undefined;
    const body = typeof raw.body === 'string' ? raw.body : '';
    const createdAt = typeof raw.created_at === 'string' ? raw.created_at : '';
    const updatedAt = typeof raw.updated_at === 'string' ? raw.updated_at : '';
    const userLogin = typeof user?.login === 'string' ? user.login : '';
    if (Number(raw.id) !== id || !body || !createdAt || !updatedAt || !userLogin) {
      return { comments: [], unavailableReason: `publication_rejected_comment_trust_fields_missing:${id}` };
    }
    comments.push({ id, body, createdAt, updatedAt, userLogin });
  }
  return { comments };
}

export function observePublishedArtifact(
  expectation: PublicationExpectation,
  transport: GhTransport = defaultGhTransport(),
): PublicationObservation {
  try {
    if (expectation.kind === 'author') {
      const revision = fetchIssueRevision(transport, expectation.repository, expectation.issueNumber);
      const observedRevision = issueSourceRevision(revision.body);
      const observedHash = sha256Text(revision.body);
      if (observedRevision === expectation.sourceRevision
        && observedHash === expectation.exactBodySha256) {
        return {
          status: 'published',
          kind: 'author',
          repository: expectation.repository,
          issueNumber: expectation.issueNumber,
          sourceRevision: expectation.sourceRevision,
          exactBodySha256: observedHash,
        };
      }
      if (observedRevision === expectation.sourceRevision) {
        return {
          status: 'blocked',
          reason: `author_body_hash_mismatch:expected=${expectation.exactBodySha256}:observed=${observedHash}`,
        };
      }
      return {
        status: 'missing',
        reason: `author_revision_not_current:expected=${expectation.sourceRevision}:observed=${observedRevision ?? 'missing'}`,
      };
    }

    const principal = authenticatedPrincipal(transport);
    if (!principal) {
      return { status: 'unavailable', reason: 'publication_principal_unavailable' };
    }
    const fetched = fetchIssueComments(
      transport,
      expectation.repository,
      expectation.issueNumber,
      principal,
      { pageSize: 100, maxPages: 10 },
    );
    const diagnostics = fetched.diagnostics.map((item) => item.message);
    if (!fetched.commentsComplete) {
      return {
        status: 'unavailable',
        reason: fetched.failure?.message || 'publication_comment_census_incomplete',
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      };
    }

    const revisionLine = `Read revision: #${expectation.issueNumber} ${expectation.sourceRevision}`;
    const invocationLine = `INVOCATION_ID_TO_ECHO: ${expectation.invocationId}`;
    const stageLine = `stage: ${expectation.stage}`;
    const slotLine = `source-slot: ${expectation.sourceSlot}`;

    const rejected = fetchRejectedPublicationComments(
      transport,
      expectation.repository,
      fetched.diagnostics,
    );
    if (rejected.unavailableReason) {
      return {
        status: 'unavailable',
        reason: rejected.unavailableReason,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      };
    }
    const matchingRejected = rejected.comments.filter((comment) => {
      const lines = nonEmptyLines(comment.body);
      return lines[0] === revisionLine
        && exactLineCount(lines, invocationLine) === 1
        && exactLineCount(lines, stageLine) === 1
        && exactLineCount(lines, slotLine) === 1;
    });
    if (matchingRejected.length > 0) {
      const comment = matchingRejected[0]!;
      return {
        status: 'blocked',
        reason: comment.userLogin !== principal
          ? 'reviewer_publication_foreign_principal'
          : comment.updatedAt !== comment.createdAt
            ? 'reviewer_publication_edited_comment'
            : 'reviewer_publication_rejected_identity',
        diagnostics: matchingRejected.map((candidate) => `comment:${candidate.id}`),
      };
    }

    const ownedInvocation = fetched.comments.filter((comment) => {
      const lines = nonEmptyLines(comment.body);
      return exactLineCount(lines, invocationLine) === 1;
    });
    if (ownedInvocation.length > 1) {
      return {
        status: 'blocked',
        reason: 'reviewer_publication_duplicate_invocation',
        diagnostics: ownedInvocation.map((comment) => `comment:${comment.id}`),
      };
    }
    if (ownedInvocation.length === 1) {
      const comment = ownedInvocation[0]!;
      const lines = nonEmptyLines(comment.body);
      if (lines[0] !== revisionLine || lines[1] !== invocationLine) {
        return {
          status: 'blocked',
          reason: 'reviewer_publication_binding_header_mismatch',
          diagnostics: [`comment:${comment.id}`],
        };
      }
      if (exactLineCount(lines, stageLine) !== 1 || exactLineCount(lines, slotLine) !== 1) {
        return {
          status: 'blocked',
          reason: 'reviewer_publication_stage_slot_mismatch',
          diagnostics: [`comment:${comment.id}`],
        };
      }
      return {
        status: 'published',
        kind: 'reviewer',
        repository: expectation.repository,
        issueNumber: expectation.issueNumber,
        sourceRevision: expectation.sourceRevision,
        invocationId: expectation.invocationId,
        stage: expectation.stage,
        sourceSlot: expectation.sourceSlot,
        commentId: comment.id,
        principal,
      };
    }

    const boundFrameWithoutInvocation = fetched.comments.filter((comment) => {
      const lines = nonEmptyLines(comment.body);
      return lines[0] === revisionLine
        && exactLineCount(lines, stageLine) === 1
        && exactLineCount(lines, slotLine) === 1;
    });
    if (boundFrameWithoutInvocation.length > 0) {
      return {
        status: 'blocked',
        reason: 'reviewer_publication_invocation_missing_or_mismatch',
        diagnostics: boundFrameWithoutInvocation.map((comment) => `comment:${comment.id}`),
      };
    }
    return {
      status: 'missing',
      reason: 'reviewer_publication_not_visible',
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'publication_observation_failed',
    };
  }
}

/**
 * Attribute a concurrent manager batch only from REST-visible sibling facts.
 * Child state is copied as a timeout hint and never changes the classification.
 */
export function classifyConcurrentBatchDelivery(
  slots: readonly ConcurrentBatchSlotEvidence[],
): readonly ConcurrentBatchSlotAttribution[] {
  const anyPublished = slots.some((slot) => slot.publication === 'published');
  return slots.map((slot) => {
    if (slot.publication === 'published') {
      return {
        invocationId: slot.invocationId,
        classification: 'actual' as const,
        resendForbidden: true,
        settlement: 'published' as const,
        ...(slot.childHint ? { childHint: slot.childHint } : {}),
      };
    }
    if (slot.publication === 'blocked') {
      return {
        invocationId: slot.invocationId,
        classification: 'unproven' as const,
        resendForbidden: true,
        settlement: 'incident' as const,
        ...(slot.childHint ? { childHint: slot.childHint } : {}),
      };
    }
    if (anyPublished) {
      return {
        invocationId: slot.invocationId,
        classification: 'possible-or-actual' as const,
        resendForbidden: true,
        settlement: 'incident' as const,
        ...(slot.childHint ? { childHint: slot.childHint } : {}),
      };
    }
    return {
      invocationId: slot.invocationId,
      classification: 'unproven' as const,
      resendForbidden: false,
      settlement: 'unsettled' as const,
      ...(slot.childHint ? { childHint: slot.childHint } : {}),
    };
  });
}

function sameReviewerExpectation(
  left: ReviewerPublicationExpectation,
  right: ReviewerPublicationExpectation,
): boolean {
  return left.repository === right.repository
    && left.issueNumber === right.issueNumber
    && left.sourceRevision === right.sourceRevision
    && left.invocationId === right.invocationId
    && left.stage === right.stage
    && left.sourceSlot === right.sourceSlot;
}

export async function runWait(options: {
  readonly runIdentity: string;
  readonly attemptIdentity: string;
  readonly terminalEnvelopePath: string;
  readonly handoffReceiptPath: string;
  readonly deadlineMs: number;
  readonly publicationExpectation?: PublicationExpectation;
  readonly concurrentBatchExpectations?: readonly ReviewerPublicationExpectation[];
  readonly transport?: GhTransport;
}): Promise<void> {
  const started = Date.now();
  const deadlineAt = started + options.deadlineMs;
  let envelope: TerminalEnvelope | null = null;
  let publication: PublicationObservation | undefined;
  let batchAttribution: readonly ConcurrentBatchSlotAttribution[] | undefined;
  let currentBatchAttribution: ConcurrentBatchSlotAttribution | undefined;
  const currentReviewerExpectation = options.publicationExpectation?.kind === 'reviewer'
    ? options.publicationExpectation
    : undefined;
  const publicationTransport = options.publicationExpectation || options.concurrentBatchExpectations
    ? withGhDeadline(options.transport ?? defaultGhTransport(), deadlineAt)
    : undefined;
  while (Date.now() - started < options.deadlineMs) {
    envelope = readTerminalEnvelope(options.terminalEnvelopePath, {
      runIdentity: options.runIdentity,
      attemptIdentity: options.attemptIdentity,
    });
    if (options.publicationExpectation && publicationTransport) {
      publication = observePublishedArtifact(options.publicationExpectation, publicationTransport);
      if (options.concurrentBatchExpectations && currentReviewerExpectation) {
        const evidence = options.concurrentBatchExpectations.map((expectation): ConcurrentBatchSlotEvidence => {
          const isCurrent = sameReviewerExpectation(expectation, currentReviewerExpectation);
          const observed = isCurrent
            ? publication!
            : observePublishedArtifact(expectation, publicationTransport);
          return {
            invocationId: expectation.invocationId,
            publication: observed.status,
            ...(isCurrent && envelope?.incident ? { childHint: envelope.incident } : {}),
          };
        });
        batchAttribution = classifyConcurrentBatchDelivery(evidence);
        currentBatchAttribution = batchAttribution.find((slot) =>
          slot.invocationId === currentReviewerExpectation.invocationId);
      }
      if (publication.status === 'published' || publication.status === 'blocked') break;
      if (currentBatchAttribution?.settlement === 'incident' && currentBatchAttribution.resendForbidden) break;
      await delay(250);
      continue;
    }
    if (envelope) break;
    await delay(50);
  }
  const handoff = readHandoffReceipt(options.handoffReceiptPath, {
    runIdentity: options.runIdentity,
    attemptIdentity: options.attemptIdentity,
  });
  const publicationExpected = options.publicationExpectation !== undefined;
  const publicationPublished = publication?.status === 'published';
  const publicationBlocked = publication?.status === 'blocked';
  const batchIncidentSettled = currentBatchAttribution?.settlement === 'incident'
    && currentBatchAttribution.resendForbidden;
  const nonTerminal = publicationExpected
    ? !publicationPublished && !publicationBlocked && !batchIncidentSettled
    : envelope === null;
  const noSuccessAuthority = publicationExpected
    ? !publicationPublished
    : envelope?.lifecycle_outcome !== 'success';
  const currentBatchInvocationId = currentBatchAttribution?.invocationId;
  const publishedSiblingInvocationIds = currentBatchInvocationId
    ? (batchAttribution ?? [])
        .filter((slot) => slot.classification === 'actual' && slot.invocationId !== currentBatchInvocationId)
        .map((slot) => slot.invocationId)
    : [];
  const concurrentBatchIncident = batchIncidentSettled && currentBatchAttribution
    ? {
        schema: CONCURRENT_BATCH_INCIDENT_SCHEMA,
        invocation_id: currentBatchAttribution.invocationId,
        classification: currentBatchAttribution.classification,
        resend_forbidden: currentBatchAttribution.resendForbidden,
        settlement: currentBatchAttribution.settlement,
        published_sibling_invocation_ids: publishedSiblingInvocationIds,
        ...(currentBatchAttribution.childHint ? { child_hint: currentBatchAttribution.childHint } : {}),
      }
    : undefined;
  process.stdout.write(`${JSON.stringify({
    schema: WAIT_SCHEMA,
    run_identity: options.runIdentity,
    attempt_identity: options.attemptIdentity,
    terminal: envelope !== null,
    envelope_absent: envelope === null,
    non_terminal: nonTerminal,
    no_success_authority: noSuccessAuthority,
    no_retry_authority: true,
    handoff_receipt_observed: handoff !== null,
    ...(publicationExpected ? {
      completion_authority: publicationPublished
        ? 'published_artifact'
        : batchIncidentSettled
          ? 'concurrent_batch_publication'
          : 'publication_unproven',
      publication_terminal: publicationPublished,
      publication_blocked: publicationBlocked,
      publication_observation: publication ?? {
        status: 'unavailable',
        reason: 'publication_observation_not_run',
      },
    } : {}),
    ...(batchAttribution ? {
      concurrent_batch_attribution: batchAttribution,
      batch_settlement_terminal: Boolean(batchIncidentSettled),
      ...(concurrentBatchIncident ? { concurrent_batch_incident: concurrentBatchIncident } : {}),
    } : {}),
    ...(envelope ? { envelope } : {}),
  })}\n`);
}

function parsePublicationExpectation(options: Map<string, string | true>): PublicationExpectation | undefined {
  const kind = options.get('publication-kind');
  if (kind === undefined) return undefined;
  if (kind !== 'author' && kind !== 'reviewer') throw new Error('publication_kind_invalid');
  const repository = requiredOption(options, 'repository').trim().toLowerCase();
  const issueNumber = Number(requiredOption(options, 'issue-number'));
  const sourceRevision = requiredOption(options, 'source-revision');
  if (!repository || !Number.isInteger(issueNumber) || issueNumber <= 0 || !/^r[0-9]+$/u.test(sourceRevision)) {
    throw new Error('publication_identity_invalid');
  }
  if (kind === 'author') {
    const exactBodySha256 = requiredOption(options, 'body-sha256').toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(exactBodySha256)) throw new Error('publication_body_sha256_invalid');
    return { kind, repository, issueNumber, sourceRevision, exactBodySha256 };
  }
  return {
    kind,
    repository,
    issueNumber,
    sourceRevision,
    invocationId: requiredOption(options, 'invocation-id'),
    stage: requiredOption(options, 'stage'),
    sourceSlot: requiredOption(options, 'source-slot'),
  };
}

function parseConcurrentBatchExpectations(
  options: Map<string, string | true>,
  current: PublicationExpectation | undefined,
): readonly ReviewerPublicationExpectation[] | undefined {
  const raw = options.get('publication-batch-json');
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || current?.kind !== 'reviewer') {
    throw new Error('publication_batch_requires_reviewer_expectation');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('publication_batch_json_invalid');
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 32) {
    throw new Error('publication_batch_shape_invalid');
  }
  const expectations: ReviewerPublicationExpectation[] = parsed.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('publication_batch_entry_invalid');
    }
    const row = value as Record<string, unknown>;
    const repository = String(row.repository ?? '').trim().toLowerCase();
    const issueNumber = Number(row.issue_number);
    const sourceRevision = String(row.source_revision ?? '');
    const invocationId = String(row.invocation_id ?? '');
    const stage = String(row.stage ?? '');
    const sourceSlot = String(row.source_slot ?? '');
    if (!repository || !Number.isInteger(issueNumber) || issueNumber <= 0
      || !/^r[0-9]+$/u.test(sourceRevision) || !invocationId || !stage || !sourceSlot) {
      throw new Error('publication_batch_entry_invalid');
    }
    return {
      kind: 'reviewer',
      repository,
      issueNumber,
      sourceRevision,
      invocationId,
      stage,
      sourceSlot,
    };
  });
  if (new Set(expectations.map((item) => item.invocationId)).size !== expectations.length) {
    throw new Error('publication_batch_invocation_duplicate');
  }
  if (!expectations.some((item) => sameReviewerExpectation(item, current))) {
    throw new Error('publication_batch_current_invocation_missing');
  }
  if (expectations.some((item) => item.repository !== current.repository
    || item.issueNumber !== current.issueNumber
    || item.sourceRevision !== current.sourceRevision
    || item.stage !== current.stage)) {
    throw new Error('publication_batch_scope_mismatch');
  }
  return expectations;
}

async function launchFromCli(argv: readonly string[]): Promise<number> {
  const parsed = parseCli(argv);
  const options = parsed.options;
  if (options.has('completion-mode') || options.has('authority') || options.has('result-protocol')) {
    refuse('forbidden_authority_selector');
    return 2;
  }
  const childUsesReviewerSource = parsed.childArgs.some((arg) => arg === '--reviewer-source-output');
  if (childUsesReviewerSource && typeof options.get('reviewer-source-output') !== 'string') {
    refuse('reviewer_source_output_required_for_direct_mode');
    return 2;
  }
  const config: LaunchConfig = {
    runIdentity: requiredOption(options, 'run-identity'),
    attemptIdentity: requiredOption(options, 'attempt-identity'),
    handoffReceiptPath: requiredOption(options, 'handoff-receipt'),
    terminalEnvelopePath: requiredOption(options, 'terminal-envelope'),
    browserOutputPath: requiredOption(options, 'browser-output'),
    ...(typeof options.get('reviewer-source-output') === 'string'
      ? { reviewerSourceOutputPath: options.get('reviewer-source-output') as string }
      : {}),
    cwd: requiredOption(options, 'cwd'),
    childCommand: requiredOption(options, 'child-command'),
    childArgs: parsed.childArgs,
    ...(typeof options.get('conversation-locator') === 'string'
      ? { conversationLocator: options.get('conversation-locator') as string }
      : {}),
  };
  return await runLaunch(config);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'wait') {
    const parsed = parseCli(rest);
    const options = parsed.options;
    const publicationExpectation = parsePublicationExpectation(options);
    const concurrentBatchExpectations = parseConcurrentBatchExpectations(options, publicationExpectation);
    await runWait({
      runIdentity: requiredOption(options, 'run-identity'),
      attemptIdentity: requiredOption(options, 'attempt-identity'),
      terminalEnvelopePath: requiredOption(options, 'terminal-envelope'),
      handoffReceiptPath: requiredOption(options, 'handoff-receipt'),
      deadlineMs: Number(requiredOption(options, 'deadline-ms')),
      ...(publicationExpectation ? { publicationExpectation } : {}),
      ...(concurrentBatchExpectations ? { concurrentBatchExpectations } : {}),
    });
    return;
  }
  if (command === 'launch') {
    process.exitCode = await launchFromCli(rest);
    return;
  }
  refuse('usage', { expected: 'launch|wait' });
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entryPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
