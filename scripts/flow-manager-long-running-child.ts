#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
  fsyncSync,
} from 'node:fs';
import { dirname, basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TURN_STATES, type FailureScope, type TurnResultV1, type TurnState } from './chatgpt-browser-turn/contracts.ts';
import { runProcess, type ProcessResult } from './kernel/subprocess.ts';
import {
  parseBrowserTurnCancellationReceipt,
  isSupportedChatGptConversationUrl,
  readRecoveryAuthoritativeUserMessages,
  type BrowserTurnCancellationAttempt,
  type BrowserTurnCancellationDependencies,
  type BrowserTurnCancellationReceipt,
} from './chatgpt-browser-turn/state-light-cancellation.ts';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import { launchingTerminalHandle } from './chatgpt-browser-turn/chat-bindings.ts';
import {
  parseObservationHeartbeatLine,
  resolveBrowserTurnLivenessTiming,
} from './chatgpt-browser-turn/liveness-contract.ts';
import { observationRecordPath, readStateLightTurnObservation, type StateLightTurnObservationRecord } from './chatgpt-browser-turn/state-light-turn-observation.ts';
import { loadChromium, normalizeConversationUrl } from './chatgpt-browser-turn/ui-adapter.ts';
import { releaseCdpBrowser } from './chatgpt-browser-turn/browser-session.ts';
import { recoveryMarkerCardinality } from './chatgpt-browser-turn/state-light-turn-recovery.ts';

export const COMPLETION_MODE = 'browser-turn-result-v1' as const;
export const HANDOFF_SCHEMA = 'flow-manager-long-running-child-handoff/v1' as const;
export const TERMINAL_SCHEMA = 'flow-manager-long-running-child-terminal/v1' as const;
export const WAIT_SCHEMA = 'flow-manager-long-running-child-wait/v1' as const;
export const REFUSAL_SCHEMA = 'flow-manager-long-running-child-refusal/v1' as const;
// fleet-wake scans terminal envelopes under this root by file name.
export const TERMINAL_ENVELOPE_NAME_SUFFIX = 'terminal.json' as const;
export const TERMINAL_ENVELOPE_ROOT = '/tmp/opencode' as const;
export const RECEIPT_LOCATOR_SCHEMA = 'flow-manager-long-running-child-locator/v1' as const;
export const RECEIPT_LOCATOR_ROOT = join(TERMINAL_ENVELOPE_ROOT, 'browser-gpt-receipts');

export interface InvocationReceiptLocator {
  readonly schema: typeof RECEIPT_LOCATOR_SCHEMA;
  readonly invocation_id: string;
  readonly run_identity: string;
  readonly attempt_identity: string;
  readonly handoff_receipt_path: string;
  readonly terminal_envelope_path: string;
}

/** The same two-part fixture gate already used for terminal envelopes; never redirect production by one env var. */
function effectiveTerminalRoot(): string {
  const fixtureRoot = process.env.OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT;
  return process.env.OPK_FM_LONG_CHILD_TEST_GATE === 'fixture-root-v1'
    && typeof fixtureRoot === 'string' && isAbsolute(fixtureRoot)
    ? resolve(fixtureRoot)
    : TERMINAL_ENVELOPE_ROOT;
}

export function invocationReceiptLocatorPath(
  invocationId: string,
  terminalRoot: string = effectiveTerminalRoot(),
): string {
  if (typeof invocationId !== 'string' || !invocationId.trim()) throw new Error('invocation_id_required');
  return join(resolve(terminalRoot), 'browser-gpt-receipts',
    createHash('sha256').update(invocationId, 'utf8').digest('hex') + '.json');
}

function assertNoSymlinkComponents(path: string): void {
  let cursor = resolve(path);
  for (;;) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('receipt_locator_symlink_escape');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function assertPrivateFile(path: string, directory: boolean): void {
  assertNoSymlinkComponents(path);
  const st = lstatSync(path);
  if ((directory ? !st.isDirectory() : !st.isFile())
    || (process.platform !== 'win32' && (st.mode & 0o077) !== 0)
    || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new Error('receipt_locator_permissions_or_type_invalid');
  }
}

function locatorRoot(terminalRoot: string, create: boolean): string {
  const root = join(resolve(terminalRoot), 'browser-gpt-receipts');
  assertNoSymlinkComponents(root);
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivateFile(root, true);
  return root;
}

function readLocatorIndex(
  path: string,
  terminalRoot: string,
  expected?: { invocationId?: string; runIdentity: string; attemptIdentity: string },
): InvocationReceiptLocator {
  const root = locatorRoot(terminalRoot, false);
  const target = resolve(path);
  if (dirname(target) !== root || !/^[a-f0-9]{64}\.json$/u.test(basename(target))) {
    throw new Error('receipt_locator_outside_discovery_root');
  }
  assertPrivateFile(target, false);
  const value = JSON.parse(readFileSync(target, 'utf8')) as InvocationReceiptLocator;
  if (value.schema !== RECEIPT_LOCATOR_SCHEMA
    || typeof value.invocation_id !== 'string' || !value.invocation_id.trim()
    || invocationReceiptLocatorPath(value.invocation_id, terminalRoot) !== target
    || typeof value.run_identity !== 'string' || !value.run_identity
    || typeof value.attempt_identity !== 'string' || !value.attempt_identity
    || typeof value.handoff_receipt_path !== 'string' || !isAbsolute(value.handoff_receipt_path)
    || resolve(value.handoff_receipt_path) !== value.handoff_receipt_path
    || typeof value.terminal_envelope_path !== 'string' || !isAbsolute(value.terminal_envelope_path)
    || resolve(value.terminal_envelope_path) !== value.terminal_envelope_path
    || (expected?.invocationId && value.invocation_id !== expected.invocationId)
    || (expected && (value.run_identity !== expected.runIdentity
      || value.attempt_identity !== expected.attemptIdentity))) {
    throw new Error('receipt_locator_identity_mismatch');
  }
  assertNoSymlinkComponents(value.handoff_receipt_path);
  assertNoSymlinkComponents(value.terminal_envelope_path);
  assertPairwiseDistinct([target, value.handoff_receipt_path, value.terminal_envelope_path]);
  return value;
}

/** Lookup is evidence only; it neither sends nor turns a timeout into success/retry authority. */
export function readInvocationReceiptLocator(input: {
  readonly invocationId?: string;
  readonly receiptLocator?: string;
  readonly runIdentity: string;
  readonly attemptIdentity: string;
  readonly terminalEnvelopeRoot?: string;
}): { readonly locator: InvocationReceiptLocator; readonly receipt: HandoffReceipt; readonly path: string } {
  const root = input.terminalEnvelopeRoot ?? effectiveTerminalRoot();
  if (input.invocationId && input.receiptLocator) throw new Error('wait_locator_selector_ambiguous');
  if (!input.invocationId && !input.receiptLocator) throw new Error('wait_locator_selector_required');
  const path = input.invocationId
    ? invocationReceiptLocatorPath(input.invocationId, root)
    : resolve(input.receiptLocator!);
  const locator = readLocatorIndex(path, root, {
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    runIdentity: input.runIdentity,
    attemptIdentity: input.attemptIdentity,
  });
  assertPrivateFile(locator.handoff_receipt_path, false);
  const receipt = readHandoffReceipt(locator.handoff_receipt_path, {
    runIdentity: input.runIdentity,
    attemptIdentity: input.attemptIdentity,
  });
  if (!receipt || receipt.invocation_id !== locator.invocation_id
    || !Number.isSafeInteger(receipt.launcher_pid) || (receipt.launcher_pid ?? 0) <= 1
    || typeof receipt.child_cwd !== 'string' || !isAbsolute(receipt.child_cwd)
    || receipt.completion_mode !== COMPLETION_MODE) {
    throw new Error('receipt_locator_handoff_missing_or_mismatched');
  }
  return { locator, receipt, path };
}

export function isWakeableTerminalEnvelopePath(
  path: string,
  root: string = TERMINAL_ENVELOPE_ROOT,
): boolean {
  const absolute = resolve(path);
  return absolute.startsWith(`${resolve(root)}/`)
    && basename(path).endsWith(TERMINAL_ENVELOPE_NAME_SUFFIX);
}

/** Actionable refusal text: tells the caller exactly which path to pass instead. */
export function unwakeableTerminalEnvelopeHint(path: string): { suggested_path: string; hint: string } {
  const name = basename(path);
  const wakeableName = name.endsWith(TERMINAL_ENVELOPE_NAME_SUFFIX)
    ? name
    : `${name.replace(/\.json$/u, '')}-${TERMINAL_ENVELOPE_NAME_SUFFIX}`;
  const suggested = join(TERMINAL_ENVELOPE_ROOT, wakeableName);
  return {
    suggested_path: suggested,
    hint: `fleet-wake scans only ${TERMINAL_ENVELOPE_ROOT}/ and discovers terminal envelopes by a file name ending in ${TERMINAL_ENVELOPE_NAME_SUFFIX}; `
      + `with this location or name the turn would finish and nobody would wake you. Nothing was sent to GPT and no file was written. `
      + `Re-run the same command unchanged except --terminal-envelope ${suggested}`,
  };
}

export type DeliveryState = 'not-sent' | 'POSSIBLY_DELIVERED' | 'landed';

export type ChildExitDiagnostic = 'exited_within_grace' | 'retained_after_result';

export type ParsedTurnResult = TurnResultV1 & {
  readonly resolved_send_count: number;
  readonly observed_turn_result_identity?: string;
};

export interface HandoffReceipt {
  readonly schema: typeof HANDOFF_SCHEMA;
  readonly run_identity: string;
  readonly attempt_identity: string;
  readonly launcher_started_at: string;
  readonly handoff_committed_at: string;
  readonly completion_mode: typeof COMPLETION_MODE;
  readonly invocation_id?: string;
  readonly owner_task_id?: string;
  readonly owner_dispatch_id?: string;
  /** Browser child cwd, never the invoking terminal's worktree. */
  readonly child_cwd?: string;
  readonly launcher_pid?: number;
  /** Optional routing hint, not a terminal incarnation or effect authority. */
  readonly launching_terminal_handle?: string;
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
  readonly child_exit_diagnostic?: ChildExitDiagnostic;
  readonly turn_result_state?: string;
  readonly turn_result_cause?: string;
  readonly send_count?: number;
  readonly observed_invocation_id?: string;
  readonly observed_turn_result_identity?: string;
  readonly recovery_available: boolean;
  readonly conversation_locator?: string;
  readonly diagnostics?: Record<string, unknown>;
  // Launching worktree and agent terminal; fleet-wake wakes that pane on this envelope.
  readonly cwd?: string;
  readonly terminal_handle?: string;
}

const DEFAULT_CANDIDATE_GRACE_MS = 5_000;
const DEFAULT_NO_CANDIDATE_GRACE_MS = 5_000;
const DEFAULT_HARD_DEADLINE_MS = 60 * 60 * 1_000;
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

function hardDeadlineMs(): number {
  return envMs('OPK_FM_LONG_CHILD_HARD_DEADLINE_MS', DEFAULT_HARD_DEADLINE_MS);
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

function atomicCreateJson(path: string, body: Record<string, unknown>, kind: 'receipt' | 'envelope' | 'index'): void {
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
    // An uncertain, partly written index must stay occupied: never reuse the
    // invocation ID after a failed reservation or a short write.
    if (kind !== 'index') {
      try {
        unlinkSync(target);
      } catch {
        // best effort
      }
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

function observedTurnResultIdentity(line: string): string {
  return `sha256:${createHash('sha256').update(line, 'utf8').digest('hex')}:turn-result-v1`;
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

    if (body.send_attempted === true) result.send_attempted = true;
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
    return {
      ...result,
      resolved_send_count,
      observed_turn_result_identity: observedTurnResultIdentity(line),
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
  if (sendCount === 0 && result.send_attempted === true) return 'POSSIBLY_DELIVERED';
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

type TerminalCancellationAttempt = BrowserTurnCancellationAttempt & {
  readonly receiptIdentity?: Pick<BrowserTurnCancellationReceipt, 'invocation_id' | 'marker'>;
};

function receiptEvidenceForTerminalIncident(
  config: LaunchConfig,
  capture: CandidateCapture,
  incident: 'child_startup_timeout' | 'child_liveness_timeout' | 'child_terminal_result_missing',
): TerminalCancellationAttempt | null {
  const receipt = capture.cancellationReceipt;
  if (!receipt) return null;
  if (!cancellationReceiptIsBound(config, receipt)) {
    return {
      state: 'driver_error',
      cause: `${incident}_cancellation_receipt_identity_unproven`,
      stopOutcome: 'not_attempted_identity_unproven',
      identityProven: false,
    };
  }
  if (capture.duplicateCancellationReceipt) {
    return {
      state: 'driver_error',
      cause: `${incident}_cancellation_receipt_duplicate`,
      sendCount: 1,
      stopOutcome: 'not_attempted_authority_absent',
      identityProven: false,
      conversationUrl: receipt.conversation_url,
      receiptIdentity: {
        invocation_id: receipt.invocation_id,
        marker: receipt.marker,
      },
    };
  }
  return {
    state: 'driver_error',
    cause: `${incident}_cancellation_authority_absent`,
    sendCount: 1,
    stopOutcome: 'not_attempted_authority_absent',
    identityProven: false,
    conversationUrl: receipt.conversation_url,
    receiptIdentity: {
      invocation_id: receipt.invocation_id,
      marker: receipt.marker,
    },
  };
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
  attempt: TerminalCancellationAttempt,
  heartbeatDiagnostics: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return boundedDiagnostics({
    ...(heartbeatDiagnostics ? { last_heartbeat: heartbeatDiagnostics } : {}),
    cancellation: {
      state: attempt.state,
      cause: attempt.cause,
      stop_outcome: attempt.stopOutcome,
      identity_proven: attempt.identityProven,
      ...(attempt.receiptIdentity ? { receipt_identity: attempt.receiptIdentity } : {}),
    },
  });
}

function childOption(config: LaunchConfig, flag: string): string | undefined {
  const index = config.childArgs.lastIndexOf(flag);
  const value = index >= 0 ? config.childArgs[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

async function provenOwnedTab(
  config: LaunchConfig, record: StateLightTurnObservationRecord, cdp: string,
): Promise<string | undefined> {
  // Read-only: reconnect to the retained endpoint, never open/reset/stop a page.
  const deps = config.cancellationDependencies ?? {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = async (): Promise<string | undefined> => {
    let browser: any;
    try {
      browser = deps.connect ? await deps.connect(cdp)
        : await loadChromium().connectOverCDP(cdp, { timeout: candidateGraceMs() });
      const contexts = browser.contexts();
      const pages = deps.enumeratePages ? await deps.enumeratePages(browser)
        : Array.isArray(contexts) && contexts.length === 1 ? contexts[0].pages() : [];
      const matches: string[] = [];
      for (const page of pages) {
        if (typeof page.isClosed !== 'function' || page.isClosed()) continue;
        const url = normalizeConversationUrl(String(page.url()));
        if (!isSupportedChatGptConversationUrl(url)) continue;
        if (record.conversation_url && url !== normalizeConversationUrl(record.conversation_url)) continue;
        const observed = deps.readUserMessages ? await deps.readUserMessages(page)
          : await readRecoveryAuthoritativeUserMessages(page);
        if (observed.incomplete) return undefined;
        const count = recoveryMarkerCardinality(observed.messages, record.marker);
        if (count.matchingUserCarrierCount === 1 && count.exactMarkerTokenCount === 1) matches.push(url);
        else if (count.exactMarkerTokenCount > 0) return undefined;
      }
      return matches.length === 1 ? matches[0] : undefined;
    } catch {
      return undefined;
    } finally {
      if (browser) {
        try {
          if (deps.releaseBrowser) await deps.releaseBrowser(browser);
          else await releaseCdpBrowser(browser);
        } catch { /* Disconnect is not tab cleanup or delivery proof. */ }
      }
    }
  };
  try {
    return await Promise.race([probe(), new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), candidateGraceMs());
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function persistedTerminalEvidence(config: LaunchConfig): Promise<Partial<TerminalEnvelope> | null> {
  const invocation = childOption(config, '--invocation-id');
  const profile = childOption(config, '--profile');
  const cdp = childOption(config, '--cdp');
  if (!invocation || !profile || !cdp) return null;
  let record: StateLightTurnObservationRecord;
  try {
    record = readStateLightTurnObservation(configuredProfileKey(profile, cdp), invocation);
  } catch {
    return null;
  }
  const locator = (record.send_count ?? 0) >= 1 ? await provenOwnedTab(config, record, cdp) : undefined;
  return {
    observed_invocation_id: record.invocation_id,
    ...(record.send_count !== undefined ? { send_count: record.send_count } : {}),
    delivery: (record.send_count ?? 0) >= 1 || record.phase === 'dispatching' ? 'POSSIBLY_DELIVERED' : 'not-sent',
    recovery_available: Boolean(locator),
    ...(locator ? { conversation_locator: locator } : {}),
    diagnostics: { persisted_observation: {
      phase: record.phase, ...(record.send_count !== undefined ? { send_count: record.send_count } : {}),
      profile_key: record.profile_key,
    } },
  };
}

async function terminalNoResultEvidence(
  config: LaunchConfig,
  capture: CandidateCapture,
  incident: 'child_startup_timeout' | 'child_liveness_timeout' | 'child_terminal_result_missing',
  spawnFailed: boolean,
  heartbeatDiagnostics: Record<string, unknown> | undefined,
): Promise<Partial<TerminalEnvelope> & Pick<TerminalEnvelope, 'delivery' | 'recovery_available'>> {
  const receiptEvidence = receiptEvidenceForTerminalIncident(config, capture, incident);
  const persisted = await persistedTerminalEvidence(config);
  if (persisted) return {
    delivery: deliveryWithoutTurnResult(spawnFailed), recovery_available: false, ...persisted,
    ...(receiptEvidence ? { turn_result_state: receiptEvidence.state, turn_result_cause: receiptEvidence.cause } : {}),
    diagnostics: boundedDiagnostics({
      ...persisted.diagnostics,
      ...(receiptEvidence ? cancellationDiagnostics(receiptEvidence, heartbeatDiagnostics)
        : heartbeatDiagnostics ? { last_heartbeat: heartbeatDiagnostics } : {}),
    }),
  };
  const invocationId = childOption(config, '--invocation-id');
  if (!receiptEvidence) {
    const postSendObserved = heartbeatDiagnostics?.phase === 'post_send_observation';
    return {
      delivery: deliveryWithoutTurnResult(spawnFailed),
      recovery_available: false,
      ...(invocationId ? { observed_invocation_id: invocationId } : {}),
      ...(postSendObserved ? { send_count: 1 as const } : {}),
      ...(heartbeatDiagnostics
        ? { diagnostics: boundedDiagnostics({ last_heartbeat: heartbeatDiagnostics }) }
        : {}),
    };
  }
  return {
    turn_result_state: receiptEvidence.state,
    turn_result_cause: receiptEvidence.cause,
    ...cancellationEnvelopeFields(receiptEvidence, spawnFailed),
    recovery_available: false,
    conversation_locator: undefined,
    ...(invocationId ? { observed_invocation_id: invocationId } : {}),
    diagnostics: cancellationDiagnostics(receiptEvidence, heartbeatDiagnostics),
  };
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
  /** Disposable caller root; ordinary CLI launch keeps the canonical production default. */
  readonly terminalEnvelopeRoot?: string;
  readonly browserOutputPath: string;
  readonly cwd: string;
  readonly childCommand: string;
  readonly childArgs: readonly string[];
  readonly conversationLocator?: string;
  readonly invocationId?: string;
  readonly ownerTaskId?: string;
  readonly ownerDispatchId?: string;
  /** Supplied selected Browser profile/CDP for pre-spawn durable observation collision checks. */
  readonly profile?: string;
  readonly cdp?: string;
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
    const handle = launchingTerminalHandle();
    const routed: TerminalEnvelope = { ...envelope, cwd: resolve(config.cwd), ...(handle ? { terminal_handle: handle } : {}) };
    atomicCreateJson(config.terminalEnvelopePath, routed as unknown as Record<string, unknown>, 'envelope');
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
  // The turn-result/v1 line is the authoritative outcome. The browser child
  // legitimately retains its page after an ok result, so exit timing is cleanup
  // evidence, not a lifecycle outcome.
  const resolvedExitCode: number | null = exited ? (completion.result?.exitCode ?? childExitCode) : null;
  const childExitDiagnostic: ChildExitDiagnostic = exited ? 'exited_within_grace' : 'retained_after_result';
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
    child_exit_code: resolvedExitCode,
    child_exit_diagnostic: childExitDiagnostic,
    turn_result_state: candidate.state,
    turn_result_cause: candidate.cause,
    send_count: candidate.resolved_send_count,
    observed_invocation_id: candidate.invocation_id,
    ...(candidate.observed_turn_result_identity
      ? { observed_turn_result_identity: candidate.observed_turn_result_identity }
      : {}),
    ...conversationLocatorFields(config, candidate),
  });
  if (capture.duplicateCandidate) {
    await publishEnvelope(config, incidentEnvelope('child_terminal_result_duplicate'));
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
      child_exit_code: resolvedExitCode,
      child_exit_diagnostic: childExitDiagnostic,
      turn_result_state: candidate.state,
      turn_result_cause: candidate.cause,
      send_count: candidate.resolved_send_count,
      observed_invocation_id: candidate.invocation_id,
      ...(candidate.observed_turn_result_identity
        ? { observed_turn_result_identity: candidate.observed_turn_result_identity }
        : {}),
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
  if (!isWakeableTerminalEnvelopePath(config.terminalEnvelopePath, config.terminalEnvelopeRoot)) {
    refuse('terminal_envelope_name_not_wakeable', {
      path: config.terminalEnvelopePath,
      required_suffix: TERMINAL_ENVELOPE_NAME_SUFFIX,
      ...unwakeableTerminalEnvelopeHint(config.terminalEnvelopePath),
    });
    return 2;
  }
  const launcherArtifacts = [
    config.handoffReceiptPath,
    config.terminalEnvelopePath,
    config.browserOutputPath,
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
  } catch (error) {
    refuse('preflight_failed', { message: error instanceof Error ? error.message : String(error) });
    return 2;
  }

  let livenessTiming: ReturnType<typeof resolveBrowserTurnLivenessTiming>;
  try {
    livenessTiming = resolveBrowserTurnLivenessTiming();
  } catch (error) {
    refuse('liveness_contract_invalid', {
      message: error instanceof Error ? error.message : String(error),
    });
    return 2;
  }

  const launcherStartedAt = nowIso();
  const launchHandle = launchingTerminalHandle();
  const receipt: HandoffReceipt = {
    schema: HANDOFF_SCHEMA,
    run_identity: config.runIdentity,
    attempt_identity: config.attemptIdentity,
    launcher_started_at: launcherStartedAt,
    handoff_committed_at: nowIso(),
    completion_mode: COMPLETION_MODE,
    ...(config.invocationId ? { invocation_id: config.invocationId } : {}),
    ...(config.ownerTaskId ? { owner_task_id: config.ownerTaskId } : {}),
    ...(config.ownerDispatchId ? { owner_dispatch_id: config.ownerDispatchId } : {}),
    child_cwd: realpathSync(config.cwd),
    launcher_pid: process.pid,
    ...(launchHandle ? { launching_terminal_handle: launchHandle } : {}),
  };
  // Reserve the single global invocation key before publishing the original receipt or spawning the Browser.
  // A partial reservation is intentionally not recycled: retry with a fresh invocation ID.
  let indexedPath: string | undefined;
  if (config.invocationId !== undefined) {
    try {
      if (!config.invocationId.trim() || !config.profile?.trim() || !config.cdp?.trim()) {
        throw new Error('indexed_invocation_profile_cdp_required');
      }
      const profileKey = configuredProfileKey(config.profile, config.cdp);
      const observationPath = observationRecordPath(profileKey, config.invocationId);
      try {
        lstatSync(observationPath);
        throw new Error('invocation_observation_occupied_use_fresh_id');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const terminalRoot = config.terminalEnvelopeRoot ?? effectiveTerminalRoot();
      indexedPath = invocationReceiptLocatorPath(config.invocationId, terminalRoot);
      assertNoSymlinkComponents(config.handoffReceiptPath);
      assertNoSymlinkComponents(config.terminalEnvelopePath);
      assertNoSymlinkComponents(config.browserOutputPath);
      assertPairwiseDistinct([...launcherArtifacts, indexedPath]);
      locatorRoot(terminalRoot, true);
      const index: InvocationReceiptLocator = {
        schema: RECEIPT_LOCATOR_SCHEMA,
        invocation_id: config.invocationId,
        run_identity: config.runIdentity,
        attempt_identity: config.attemptIdentity,
        handoff_receipt_path: resolve(config.handoffReceiptPath),
        terminal_envelope_path: resolve(config.terminalEnvelopePath),
      };
      if (canaries.some((value) => JSON.stringify(index).includes(value) || JSON.stringify(receipt).includes(value))) {
        throw new Error('canary_in_index_or_receipt');
      }
      atomicCreateJson(indexedPath, index as unknown as Record<string, unknown>, 'index');
      const committed = readLocatorIndex(indexedPath, terminalRoot, {
        invocationId: config.invocationId,
        runIdentity: config.runIdentity,
        attemptIdentity: config.attemptIdentity,
      });
      if (JSON.stringify(committed) !== JSON.stringify(index)) throw new Error('receipt_locator_readback_failed');
    } catch (error) {
      refuse('invocation_admission_failed_use_fresh_id', {
        message: error instanceof Error ? error.message : String(error),
      });
      return 2;
    }
  }
  try {
    atomicCreateJson(config.handoffReceiptPath, receipt as unknown as Record<string, unknown>, 'receipt');
    if (indexedPath) {
      const bound = readInvocationReceiptLocator({
        invocationId: config.invocationId!,
        runIdentity: config.runIdentity,
        attemptIdentity: config.attemptIdentity,
        terminalEnvelopeRoot: config.terminalEnvelopeRoot ?? effectiveTerminalRoot(),
      });
      if (bound.path !== indexedPath || bound.locator.terminal_envelope_path !== resolve(config.terminalEnvelopePath)
        || bound.locator.handoff_receipt_path !== resolve(config.handoffReceiptPath)
        || bound.receipt.launcher_pid !== process.pid
        || bound.receipt.child_cwd !== realpathSync(config.cwd)) {
        throw new Error('receipt_locator_readback_failed');
      }
    }
  } catch (error) {
    refuse(indexedPath ? 'receipt_create_or_index_readback_failed' : 'receipt_create_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
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
  let acceptedHeartbeat = false;
  let childExitCode: number | null = null;
  let childExitedBeforeCandidate = false;
  let watchdogExpiredAt: number | null = null;
  let lastStdoutObservedAt: number | null = null;
  const hardDeadline = Date.now() + hardDeadlineMs();
  let deadline = Math.min(Date.now() + livenessTiming.startupAllowanceMs, hardDeadline);

  const observeDeadline = (observedAt: number): boolean => {
    if (observedAt < deadline) return false;
    if (watchdogExpiredAt === null) watchdogExpiredAt = deadline;
    return true;
  };

  const ingestStdoutLine = (line: string, observedAt = Date.now()): void => {
    const cancellationReceipt = parseCancellationReceiptLine(line);
    if (cancellationReceipt) {
      if (!capture.cancellationReceipt) capture.cancellationReceipt = cancellationReceipt;
      else capture.duplicateCancellationReceipt = true;
      return;
    }
    const heartbeat = parseObservationHeartbeatLine(line);
    if (heartbeat) {
      if (capture.firstCandidate || observeDeadline(observedAt)) return;
      acceptedHeartbeat = true;
      lastHeartbeatDiagnostics = boundedDiagnostics({
        ...heartbeat,
        accepted_at: new Date(observedAt).toISOString(),
      });
      deadline = Math.min(observedAt + livenessTiming.liveChildIdleWindowMs, hardDeadline);
      return;
    }
    const candidate = parseTurnResult(line);
    if (!candidate) return;
    if (capture.firstCandidate) {
      capture.duplicateCandidate = true;
      return;
    }
    if (observeDeadline(observedAt)) return;
    capture.firstCandidate = candidate;
  };

  const drainStdoutBuffer = (observedAt = Date.now()): void => {
    let newlineIndex = capture.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = capture.stdoutBuffer.slice(0, newlineIndex);
      capture.stdoutBuffer = capture.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = capture.stdoutBuffer.indexOf('\n');
      ingestStdoutLine(line, observedAt);
    }
  };
  const ingestTrailingCandidate = (): void => {
    if (!capture.stdoutBuffer.trim() || capture.firstCandidate) return;
    const candidate = parseTurnResult(capture.stdoutBuffer);
    if (!candidate) return;
    const observedAt = lastStdoutObservedAt ?? Date.now();
    if (observeDeadline(observedAt)) return;
    capture.firstCandidate = candidate;
  };
  capture.drainStdoutBuffer = () => drainStdoutBuffer();

  let launcherSignal: NodeJS.Signals | undefined;
  let cleanupProcess: Promise<ProcessResult> | undefined;
  const onSignal = (signal: NodeJS.Signals): void => { launcherSignal ??= signal; };
  const onTerm = (): void => onSignal('SIGTERM');
  const onInt = (): void => onSignal('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const publishAbnormal = async (incident: string): Promise<number> => {
    const existing = readTerminalEnvelope(config.terminalEnvelopePath, { runIdentity: config.runIdentity, attemptIdentity: config.attemptIdentity });
    if (cleanupProcess && !existing) {
      // Use the existing exit grace before abort; a completed result still wins.
      try { await waitForProcessCompletion(cleanupProcess, noCandidateGraceMs()); } catch { /* Rejected process is already terminal. */ }
      capture.drainStdoutBuffer();
      ingestTrailingCandidate();
      if (!capture.firstCandidate) {
        await abortManagedProcess(controller, cleanupProcess);
        capture.drainStdoutBuffer();
        ingestTrailingCandidate();
      }
      if (capture.firstCandidate) {
        return await finalizeCandidatePath(config, receipt, launcherStartedAt, capture, cleanupProcess, controller, childExitCode, lastHeartbeatDiagnostics);
      }
    }
    if (!existing) {
      await publishEnvelope(config, {
        schema: TERMINAL_SCHEMA, run_identity: config.runIdentity, attempt_identity: config.attemptIdentity,
        completion_mode: COMPLETION_MODE, handoff_receipt_path: config.handoffReceiptPath,
        launcher_started_at: launcherStartedAt, handoff_committed_at: receipt.handoff_committed_at,
        terminal_at: nowIso(), lifecycle_outcome: 'incident', incident, child_exit_code: childExitCode,
        ...await terminalNoResultEvidence(config, capture, 'child_terminal_result_missing', false, lastHeartbeatDiagnostics),
      });
    }
    if (cleanupProcess) await abortManagedProcess(controller, cleanupProcess);
    return existing?.lifecycle_outcome === 'success' ? 0 : 1;
  };
  try {

  const runPromise = runProcess({
    command: config.childCommand,
    args: [...config.childArgs],
    cwd: config.cwd,
    inheritParentEnv: true,
    allowEmptyStdout: true,
    signal: controller.signal,
    onStdoutChunk: (chunk) => {
      const observedAt = Date.now();
      lastStdoutObservedAt = observedAt;
      capture.stdoutBuffer += chunk;
      drainStdoutBuffer(observedAt);
    },
  }).then((result) => {
    const observedAt = Date.now();
    childExitCode = result.exitCode;
    drainStdoutBuffer(observedAt);
    if (!capture.firstCandidate && !observeDeadline(observedAt)) childExitedBeforeCandidate = true;
    return result;
  });
  cleanupProcess = runPromise;

  const spawnProbeWaitMs = Math.max(1, Math.min(100, deadline - Date.now()));
  const spawnProbe = await Promise.race([
    runPromise.then((result) => ({ kind: 'done' as const, result })),
    delay(spawnProbeWaitMs).then(() => ({ kind: 'pending' as const })),
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

  while (!capture.firstCandidate && !childExitedBeforeCandidate && !launcherSignal) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      observeDeadline(Date.now());
      break;
    }
    await delay(Math.min(20, remainingMs));
  }

  ingestTrailingCandidate();

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
  if (launcherSignal) return await publishAbnormal(`launcher_signal:${launcherSignal}`);

  const timeoutIncident = acceptedHeartbeat ? 'child_liveness_timeout' : 'child_startup_timeout';
  const publishWatchdogTimeout = async (): Promise<number> => {
    // Quiesce before reading final send evidence; never classify a live pre-send snapshot.
    await abortManagedProcess(controller, runPromise);
    capture.drainStdoutBuffer();
    ingestTrailingCandidate();
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
      incident: timeoutIncident,
      child_exit_code: null,
      ...await terminalNoResultEvidence(
        config,
        capture,
        timeoutIncident,
        false,
        lastHeartbeatDiagnostics,
      ),
    });
    await abortManagedProcess(controller, runPromise);
    return 1;
  };

  if (watchdogExpiredAt !== null) {
    return await publishWatchdogTimeout();
  }

  if (childExitedBeforeCandidate || childExitCode !== null) {
    const grace = noCandidateGraceMs();
    const completion = await waitForProcessCompletion(runPromise, grace);
    capture.drainStdoutBuffer();
    ingestTrailingCandidate();
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
    const incident = spawnFailed ? 'child_start_failed' : 'child_terminal_result_missing';
    const evidence = spawnFailed
      ? { delivery: deliveryWithoutTurnResult(true), ...conversationLocatorFields(config) }
      : await terminalNoResultEvidence(config, capture, 'child_terminal_result_missing', false, lastHeartbeatDiagnostics);
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
      child_exit_code: childExitCode,
      ...evidence,
      diagnostics: boundedDiagnostics({
        ...evidence.diagnostics,
        child_exit: { outcome: completion.result?.outcome, signal: completion.result?.signal },
      }),
    });
    await abortManagedProcess(controller, runPromise);
    return 1;
  }

  return await publishWatchdogTimeout();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`flow-manager-long-running-child: ${message}\n`);
    return await publishAbnormal('launcher_exception');
  } finally {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
  }
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

export async function runWait(options: {
  readonly runIdentity: string;
  readonly attemptIdentity: string;
  readonly terminalEnvelopePath?: string;
  readonly handoffReceiptPath?: string;
  readonly invocationId?: string;
  readonly receiptLocator?: string;
  readonly terminalEnvelopeRoot?: string;
  readonly deadlineMs: number;
}): Promise<void> {
  const indexed = options.invocationId !== undefined || options.receiptLocator !== undefined;
  if (indexed && (options.terminalEnvelopePath !== undefined || options.handoffReceiptPath !== undefined)) {
    throw new Error('wait_locator_and_explicit_paths_conflict');
  }
  const bound = indexed ? readInvocationReceiptLocator({
    ...(options.invocationId !== undefined ? { invocationId: options.invocationId } : {}),
    ...(options.receiptLocator !== undefined ? { receiptLocator: options.receiptLocator } : {}),
    runIdentity: options.runIdentity,
    attemptIdentity: options.attemptIdentity,
    ...(options.terminalEnvelopeRoot ? { terminalEnvelopeRoot: options.terminalEnvelopeRoot } : {}),
  }) : null;
  const terminalEnvelopePath = bound?.locator.terminal_envelope_path ?? options.terminalEnvelopePath;
  const handoffReceiptPath = bound?.locator.handoff_receipt_path ?? options.handoffReceiptPath;
  if (!terminalEnvelopePath || !handoffReceiptPath) throw new Error('wait_paths_or_locator_required');
  const started = Date.now();
  let envelope: TerminalEnvelope | null = null;
  while (Date.now() - started < options.deadlineMs) {
    envelope = readTerminalEnvelope(terminalEnvelopePath, {
      runIdentity: options.runIdentity,
      attemptIdentity: options.attemptIdentity,
    });
    if (envelope) break;
    await delay(50);
  }
  const handoff = readHandoffReceipt(handoffReceiptPath, {
    runIdentity: options.runIdentity,
    attemptIdentity: options.attemptIdentity,
  });
  if (indexed) {
    const reread = readInvocationReceiptLocator({
      ...(options.invocationId !== undefined ? { invocationId: options.invocationId } : {}),
      ...(options.receiptLocator !== undefined ? { receiptLocator: options.receiptLocator } : {}),
      runIdentity: options.runIdentity,
      attemptIdentity: options.attemptIdentity,
      ...(options.terminalEnvelopeRoot ? { terminalEnvelopeRoot: options.terminalEnvelopeRoot } : {}),
    });
    // An older terminal preserves the caller's relative handoff spelling. The
    // wait caller may now have a different cwd, so resolving that spelling here
    // would resolve against the wrong directory. The locator owns the absolute
    // original receipt; match the relative filename plus the receipt's original
    // committed launch identity instead of guessing the launching cwd.
    const terminalHandoffMatches = !envelope || (
      (isAbsolute(envelope.handoff_receipt_path)
        ? resolve(envelope.handoff_receipt_path) === handoffReceiptPath
        : basename(normalize(envelope.handoff_receipt_path)) === basename(handoffReceiptPath))
      && envelope.launcher_started_at === handoff?.launcher_started_at
      && envelope.handoff_committed_at === handoff?.handoff_committed_at
    );
    if (reread.locator.handoff_receipt_path !== handoffReceiptPath
      || reread.locator.terminal_envelope_path !== terminalEnvelopePath
      || !handoff || JSON.stringify(reread.receipt) !== JSON.stringify(handoff)
      || !terminalHandoffMatches) {
      throw new Error('wait_locator_identity_changed');
    }
  }
  process.stdout.write(JSON.stringify({
    schema: WAIT_SCHEMA,
    run_identity: options.runIdentity,
    attempt_identity: options.attemptIdentity,
    terminal: envelope !== null,
    envelope_absent: envelope === null,
    non_terminal: envelope === null,
    no_success_authority: envelope?.lifecycle_outcome !== 'success',
    no_retry_authority: true,
    handoff_receipt_observed: handoff !== null,
    ...(envelope ? { envelope } : {}),
  }) + '\n');
}

async function launchFromCli(argv: readonly string[]): Promise<number> {
  const parsed = parseCli(argv);
  const options = parsed.options;
  if (options.has('completion-mode') || options.has('authority') || options.has('result-protocol')) {
    refuse('forbidden_authority_selector');
    return 2;
  }
  // Only synthetic native CLI fixtures may override the fleet wake root. Either signal alone is inert.
  const fixtureRoot = process.env.OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT;
  const useFixtureRoot = process.env.OPK_FM_LONG_CHILD_TEST_GATE === 'fixture-root-v1'
    && typeof fixtureRoot === 'string' && isAbsolute(fixtureRoot);
  const config: LaunchConfig = {
    ...(useFixtureRoot && fixtureRoot ? { terminalEnvelopeRoot: fixtureRoot } : {}),
    runIdentity: requiredOption(options, 'run-identity'),
    attemptIdentity: requiredOption(options, 'attempt-identity'),
    handoffReceiptPath: requiredOption(options, 'handoff-receipt'),
    terminalEnvelopePath: requiredOption(options, 'terminal-envelope'),
    browserOutputPath: requiredOption(options, 'browser-output'),
    cwd: requiredOption(options, 'cwd'),
    childCommand: requiredOption(options, 'child-command'),
    childArgs: parsed.childArgs,
    ...(typeof options.get('conversation-locator') === 'string'
      ? { conversationLocator: options.get('conversation-locator') as string }
      : {}),
    ...(options.has('invocation-id') ? { invocationId: requiredOption(options, 'invocation-id') } : {}),
    ...(options.has('owner-task-id') ? { ownerTaskId: requiredOption(options, 'owner-task-id') } : {}),
    ...(options.has('owner-dispatch-id') ? { ownerDispatchId: requiredOption(options, 'owner-dispatch-id') } : {}),
    ...(options.has('profile') ? { profile: requiredOption(options, 'profile') } : {}),
    ...(options.has('cdp') ? { cdp: requiredOption(options, 'cdp') } : {}),
  };
  return await runLaunch(config);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'wait') {
    const parsed = parseCli(rest);
    const options = parsed.options;
    await runWait({
      runIdentity: requiredOption(options, 'run-identity'),
      attemptIdentity: requiredOption(options, 'attempt-identity'),
      ...(options.has('terminal-envelope') ? { terminalEnvelopePath: requiredOption(options, 'terminal-envelope') } : {}),
      ...(options.has('handoff-receipt') ? { handoffReceiptPath: requiredOption(options, 'handoff-receipt') } : {}),
      ...(options.has('invocation-id') ? { invocationId: requiredOption(options, 'invocation-id') } : {}),
      ...(options.has('receipt-locator') ? { receiptLocator: requiredOption(options, 'receipt-locator') } : {}),
      ...(process.env.OPK_FM_LONG_CHILD_TEST_GATE === 'fixture-root-v1'
        && process.env.OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT
        && isAbsolute(process.env.OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT)
        ? { terminalEnvelopeRoot: resolve(process.env.OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT) }
        : {}),
      deadlineMs: Number(requiredOption(options, 'deadline-ms')),
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
