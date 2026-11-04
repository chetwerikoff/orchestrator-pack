#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  mkdirSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  fsyncSync,
} from 'node:fs';
import { dirname, basename, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
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
import {
  absoluteProfilePathError, boundTargetReadFirstNextAction, configuredProfileKey,
  PROFILE_ABSOLUTE_NEXT_STEP, PROFILE_ABSOLUTE_REQUIRED_CODE, type BoundGithubTarget,
} from './chatgpt-browser-turn/storage-common.ts';
import { launchingTerminalHandle } from './chatgpt-browser-turn/chat-bindings.ts';
import {
  parseObservationHeartbeatLine,
  resolveBrowserTurnLivenessTiming,
} from './chatgpt-browser-turn/liveness-contract.ts';
import { observationRecordPath, readStateLightTurnObservation, type StateLightTurnObservationRecord } from './chatgpt-browser-turn/state-light-turn-observation.ts';
import { loadChromium, normalizeConversationUrl } from './chatgpt-browser-turn/ui-adapter.ts';
import { releaseCdpBrowser } from './chatgpt-browser-turn/browser-session.ts';
import { recoveryMarkerCardinality } from './chatgpt-browser-turn/state-light-turn-recovery.ts';
import {
  listCurrentWorkerAssignmentRecords, resolveWorkerAssignmentStorePath, withCurrentWorkerAssignmentFence,
  type WorkerAssignmentRecord,
} from './lib/worker-assignment-store.ts';

export const COMPLETION_MODE = 'browser-turn-result-v1' as const;
export const HANDOFF_SCHEMA = 'flow-manager-long-running-child-handoff/v1' as const;
export const TERMINAL_SCHEMA = 'flow-manager-long-running-child-terminal/v1' as const;
export const WAIT_SCHEMA = 'flow-manager-long-running-child-wait/v1' as const;
export const REFUSAL_SCHEMA = 'flow-manager-long-running-child-refusal/v1' as const;
// fleet-wake scans terminal envelopes under this root by file name.
export const TERMINAL_ENVELOPE_NAME_SUFFIX = 'terminal.json' as const;
export const DURABLE_ARTIFACT_APP_DIR = 'orchestrator-pack' as const;
const DURABLE_ROOT_NEXT_STEP = 'set HOME to an absolute directory';

/**
 * The single durable root for terminal envelopes, original handoff receipts and receipt
 * locators: `$HOME/.local/state/orchestrator-pack`, independent of XDG_STATE_HOME.
 * Only the existing two-part synthetic fixture gate may redirect it. Never a second root.
 */
export function resolveDurableArtifactRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fixtureRoot = env.OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT;
  if (env.OPK_FM_LONG_CHILD_TEST_GATE === 'fixture-root-v1'
    && typeof fixtureRoot === 'string' && isAbsolute(fixtureRoot)) return resolve(fixtureRoot);
  const home = env.HOME;
  if (typeof home !== 'string' || !home.trim() || !isAbsolute(home)) {
    throw new Error(`durable_root_home_unavailable; nextStep: ${DURABLE_ROOT_NEXT_STEP}`);
  }
  return join(resolve(home), '.local', 'state', DURABLE_ARTIFACT_APP_DIR);
}

function productionRootSnapshot(): string {
  try {
    return resolveDurableArtifactRoot({ ...process.env, OPK_FM_LONG_CHILD_TEST_GATE: undefined });
  } catch {
    return join(homedir(), '.local', 'state', DURABLE_ARTIFACT_APP_DIR);
  }
}

/** Production default at module load (diagnostic/reference only; resolution always calls the resolver). */
export const TERMINAL_ENVELOPE_ROOT = productionRootSnapshot();
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

/**
 * A caller artifact pathname (including a legacy scratch-directory path) contributes only its
 * basename; its directory is never used. Synthetic fixtures under the gated fixture root keep
 * their nested path inside that root.
 */
export function resolveDurableArtifactPath(path: string, root: string = resolveDurableArtifactRoot()): string {
  const name = basename(path);
  if (!name || name === '.' || name === '..' || name.startsWith('.')) {
    throw new Error(`artifact_basename_invalid; nextStep: pass a plain file name such as <project>-issue-<N>-<invocation>-terminal.json`);
  }
  const absolute = resolve(path);
  const testRoot = process.env.OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT;
  if (process.env.OPK_FM_LONG_CHILD_TEST_GATE === 'fixture-root-v1'
    && typeof testRoot === 'string' && isAbsolute(testRoot) && resolve(testRoot) === resolve(root)
    && absolute.startsWith(resolve(testRoot) + sep)) return absolute;
  return join(resolve(root), name);
}

/** Create (0700) or verify the single private durable root; never follow an aliased root. */
export function ensureDurableArtifactRoot(root: string = resolveDurableArtifactRoot()): string {
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink()) throw new Error('durable_root_symlink');
    assertPrivateFile(root, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`durable_root_unsafe: ${message.split(';')[0]}; root ${root}; nextStep: ${DURABLE_ROOT_NEXT_STEP}`);
  }
  return root;
}

/** Read-only verification for readers (fleet-wake, PR-author scan): an absent root is simply empty. */
export function validateDurableArtifactRoot(root: string = resolveDurableArtifactRoot()): string {
  if (existsSync(root)) {
    if (lstatSync(root).isSymbolicLink()) throw new Error('durable_root_symlink');
    assertPrivateFile(root, true);
  }
  return root;
}

/** The same two-part fixture gate used for terminal envelopes; no single-env redirection. */
function effectiveTerminalRoot(): string {
  return resolveDurableArtifactRoot();
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
  expected?: { invocationId?: string; runIdentity?: string; attemptIdentity?: string },
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
    || (expected?.runIdentity !== undefined && value.run_identity !== expected.runIdentity)
    || (expected?.attemptIdentity !== undefined && value.attempt_identity !== expected.attemptIdentity)) {
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
  readonly ownerTaskId?: string;
  readonly ownerDispatchId?: string;
  readonly terminalEnvelopeRoot?: string;
}): { readonly locator: InvocationReceiptLocator; readonly receipt: HandoffReceipt; readonly path: string } {
  const taskBound = input.ownerTaskId !== undefined || input.ownerDispatchId !== undefined;
  // Locator correlation only; owner-wait authority (runWait) separately requires the full pair.
  if (taskBound && (!input.ownerTaskId?.trim()
    || (input.ownerDispatchId !== undefined && !input.ownerDispatchId.trim()))) {
    throw new Error('wait_owner_identity_required');
  }
  // Task-bound recovery requires the caller's independently retained invocation
  // even when a locator path is provided; it is an expectation, not a selector.
  if (taskBound && !input.invocationId?.trim()) throw new Error('wait_invocation_identity_required');
  const root = input.terminalEnvelopeRoot ?? effectiveTerminalRoot();
  if (input.invocationId && input.receiptLocator && !taskBound) throw new Error('wait_locator_selector_ambiguous');
  if (!input.invocationId && !input.receiptLocator) throw new Error('wait_locator_selector_required');
  const path = input.receiptLocator
    ? resolve(input.receiptLocator)
    : invocationReceiptLocatorPath(input.invocationId!, root);
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
  if (taskBound && (receipt.owner_task_id !== input.ownerTaskId
    || (input.ownerDispatchId !== undefined && receipt.owner_dispatch_id !== input.ownerDispatchId))) {
    throw new Error('wait_receipt_owner_mismatch');
  }
  return { locator, receipt, path };

}
/** Resolve an earlier invocation from its own durable locator identity. The
 * caller chooses only the invocation; Run/attempt/owner identity comes from
 * the original private locator and handoff receipt, never the new launch. */
export function readPredecessorReceiptLocator(input: {
  readonly invocationId: string;
  readonly expectedAttemptIdentity?: string;
  readonly terminalEnvelopeRoot?: string;
}): { readonly locator: InvocationReceiptLocator; readonly receipt: HandoffReceipt; readonly path: string } {
  if (!input.invocationId.trim()) throw new Error('predecessor_invocation_required');
  const root = input.terminalEnvelopeRoot ?? effectiveTerminalRoot();
  const path = invocationReceiptLocatorPath(input.invocationId, root);
  const locator = readLocatorIndex(path, root, { invocationId: input.invocationId });
  if (input.expectedAttemptIdentity && locator.attempt_identity !== input.expectedAttemptIdentity) {
    throw new Error('predecessor_attempt_identity_mismatch');
  }
  assertPrivateFile(locator.handoff_receipt_path, false);
  const receipt = readHandoffReceipt(locator.handoff_receipt_path, {
    runIdentity: locator.run_identity, attemptIdentity: locator.attempt_identity,
  });
  if (!receipt || receipt.invocation_id !== input.invocationId
    || !Number.isSafeInteger(receipt.launcher_pid) || (receipt.launcher_pid ?? 0) <= 1
    || typeof receipt.child_cwd !== 'string' || !isAbsolute(receipt.child_cwd)
    || receipt.completion_mode !== COMPLETION_MODE
    // Pre-#2750 managed receipts may carry only the Task; a present Dispatch must be nonempty.
    || !receipt.owner_task_id?.trim()
    || (receipt.owner_dispatch_id !== undefined && !receipt.owner_dispatch_id.trim())) {
    throw new Error('predecessor_owner_bound_handoff_missing_or_mismatched');
  }
  return { locator, receipt, path };
}

export function isWakeableTerminalEnvelopePath(
  path: string,
  root: string = resolveDurableArtifactRoot(),
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
  const durableRoot = resolveDurableArtifactRoot();
  const suggested = join(durableRoot, wakeableName);
  return {
    suggested_path: suggested,
    hint: `fleet-wake scans ${durableRoot}/ and discovers terminal envelopes by a file name ending in ${TERMINAL_ENVELOPE_NAME_SUFFIX}; `
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
  /** Optional observational witnesses (Linux /proc): never an identity-atomic signal capability. */
  readonly launcher_startticks?: string;
  readonly launcher_pid_namespace?: string;
  /** The launcher's own watchdog hard deadline (epoch ms); distinct from the driver's private deadline. */
  readonly launcher_hard_deadline_ms?: number;
  readonly launcher_boot_id?: string;
  /** Optional additive pre-physical-SEND GitHub snapshot written by the driver. */
  readonly github_effect_baseline?: GithubEffectBaseline;
}

export const GITHUB_EFFECT_BASELINE_SCHEMA = 'opk-github-effect-baseline/v1' as const;

export interface GithubEffectBaseline {
  readonly schema: typeof GITHUB_EFFECT_BASELINE_SCHEMA;
  readonly invocation_id: string;
  readonly run_identity: string;
  readonly attempt_identity: string;
  readonly repo: string;
  readonly kind: 'issue' | 'pr';
  readonly number: number;
  /** SHA-256 of the Issue body (kind issue). */
  readonly body_sha256?: string;
  /** PR head SHA (kind pr). */
  readonly head_sha?: string;
  /** #2772 structured pre-SEND tuple: upper-cased REST state (OPEN) for an Issue or PR. */
  readonly state?: string;
  /** PR base/head repository (lower-cased `owner/name`) and ref at the pre-SEND boundary. */
  readonly base_repository?: string;
  readonly base_ref?: string;
  readonly head_repository?: string;
  readonly head_ref?: string;
  readonly captured_at: string;
}

/** Optional additive receipt fields that never change the receipt's immutable launch identity. */
const ADDITIVE_RECEIPT_FIELDS = new Set(['github_effect_baseline']);

/** Compare immutable launch identity, not stale byte-for-byte receipt JSON. */
export function sameHandoffIdentity(left: HandoffReceipt | null | undefined, right: HandoffReceipt | null | undefined): boolean {
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)].filter((key) => !ADDITIVE_RECEIPT_FIELDS.has(key)));
  for (const key of keys) {
    if (JSON.stringify((left as unknown as Record<string, unknown>)[key])
      !== JSON.stringify((right as unknown as Record<string, unknown>)[key])) return false;
  }
  return true;
}

export function parseGithubEffectBaseline(value: unknown, expected: {
  readonly invocationId?: string; readonly runIdentity: string; readonly attemptIdentity: string;
}): GithubEffectBaseline | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;
  if (body.schema !== GITHUB_EFFECT_BASELINE_SCHEMA
    || body.run_identity !== expected.runIdentity || body.attempt_identity !== expected.attemptIdentity
    || typeof body.invocation_id !== 'string' || (expected.invocationId && body.invocation_id !== expected.invocationId)
    || typeof body.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(body.repo)
    || (body.kind !== 'issue' && body.kind !== 'pr')
    || typeof body.number !== 'number' || !Number.isSafeInteger(body.number) || body.number <= 0
    || typeof body.captured_at !== 'string') return undefined;
  if (body.kind === 'issue' && (typeof body.body_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(body.body_sha256))) return undefined;
  if (body.kind === 'pr' && (typeof body.head_sha !== 'string' || !/^[a-f0-9]{40}$/u.test(body.head_sha))) return undefined;
  // Optional structured fields: absent is a legacy baseline (later effect_unverified); present must be well-formed.
  for (const key of ['state', 'base_repository', 'base_ref', 'head_repository', 'head_ref'] as const) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || !(body[key] as string).trim())) return undefined;
  }
  return body as unknown as GithubEffectBaseline;
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
  readonly next_action?: string;
  readonly owned_target_id?: string;
  readonly owned_prompt_marker?: string;
  readonly owned_target_created?: boolean;
  readonly cleanup_status?: 'cleanup_unconfirmed';
  readonly predecessor_cleanup_status?: 'confirmed' | 'cleanup_unconfirmed';
  readonly predecessor_target_id?: string;
  readonly cooldown_until_ms?: number;
  readonly send_count?: number;
  readonly observed_invocation_id?: string;
  readonly send_slot_holder_invocation_id?: string;
  readonly send_slot_holder_phase?: string;
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
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
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
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(JSON.stringify(body) + '\n', 'utf8');
  const handle = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(handle, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('artifact_write_incomplete');
      offset += written;
    }
    try { fchmodSync(handle, 0o600); } catch { /* Unsupported on some platforms. */ }
    try { fsyncSync(handle); } catch { /* Best effort; publication remains atomic. */ }
  } catch (error) {
    closeSync(handle);
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
  closeSync(handle);
  try {
    // Complete-before-visible exclusive commit: link() never overwrites a competitor.
    linkSync(temporary, target);
  } catch (error) {
    if (isOccupiedPathError(error)) throw new Error('occupied_launcher_owned_path');
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch { /* Target is already a complete independent inode. */ }
  }
  fsyncDirectory(dirname(target));
}

function fsyncDirectory(directory: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(directory, fsConstants.O_RDONLY);
    fsyncSync(handle);
  } catch {
    // Directory fsync is unsupported on some platforms; the link commit stays exclusive.
  } finally {
    if (handle !== undefined) try { closeSync(handle); } catch { /* best effort */ }
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
    if (body.owned_marker_confirmed === true) result.owned_marker_confirmed = true;
    if (body.send_witness === 'owned_marker' || body.send_witness === 'numeric_send_count'
      || body.send_witness === 'none') result.send_witness = body.send_witness;
    if (typeof body.owned_target_id === 'string'
      && /^[A-Za-z0-9._:-]{1,256}$/u.test(body.owned_target_id)) result.owned_target_id = body.owned_target_id;
    if (typeof body.owned_prompt_marker === 'string' && /^OPKTURNV1[a-f0-9]+$/u.test(body.owned_prompt_marker)) {
      result.owned_prompt_marker = body.owned_prompt_marker;
    }
    if (typeof body.owned_target_created === 'boolean') result.owned_target_created = body.owned_target_created;
    if (body.cleanup_status === 'cleanup_unconfirmed') result.cleanup_status = body.cleanup_status;
    if (body.predecessor_cleanup_status === 'confirmed' || body.predecessor_cleanup_status === 'cleanup_unconfirmed') {
      result.predecessor_cleanup_status = body.predecessor_cleanup_status;
    }
    if (typeof body.predecessor_target_id === 'string'
      && /^[A-Za-z0-9._:-]{1,256}$/u.test(body.predecessor_target_id)) {
      result.predecessor_target_id = body.predecessor_target_id;
    }
    if (typeof body.cooldown_until_ms === 'number' && Number.isSafeInteger(body.cooldown_until_ms)) {
      result.cooldown_until_ms = body.cooldown_until_ms;
    }
    if (typeof body.next_action === 'string') result.next_action = body.next_action;
    if (body.cause === 'state_light_new_chat_send_slot_timeout') {
      const validHolder = typeof body.send_slot_holder_invocation_id === 'string'
        && /^[A-Za-z0-9-]{1,128}$/u.test(body.send_slot_holder_invocation_id)
        && typeof body.send_slot_holder_phase === 'string'
        && ['prepared', 'dispatching', 'not_sent', 'sent_unbound', 'sent_unharvested', 'harvested', 'unknown']
          .includes(body.send_slot_holder_phase);
      result.send_slot_holder_invocation_id = validHolder ? body.send_slot_holder_invocation_id as string : 'unknown';
      result.send_slot_holder_phase = validHolder ? body.send_slot_holder_phase as string : 'unknown';
    }
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

function turnTargetEnvelopeFields(
  candidate?: Pick<ParsedTurnResult, 'owned_target_id' | 'owned_prompt_marker'
    | 'owned_target_created' | 'cleanup_status' | 'predecessor_cleanup_status'
    | 'predecessor_target_id' | 'cooldown_until_ms'> | null,
  record?: StateLightTurnObservationRecord,
): Pick<TerminalEnvelope, 'owned_target_id' | 'owned_prompt_marker'
  | 'owned_target_created' | 'cleanup_status' | 'predecessor_cleanup_status'
  | 'predecessor_target_id' | 'cooldown_until_ms'> {
  return {
    ...(record?.owned_target
      ? { owned_target_id: record.owned_target.id,
        owned_prompt_marker: record.marker,
        owned_target_created: record.owned_target.created }
      : candidate?.owned_target_id && candidate.owned_prompt_marker
        ? { owned_target_id: candidate.owned_target_id,
          owned_prompt_marker: candidate.owned_prompt_marker,
          owned_target_created: candidate.owned_target_created }
        : {}),
    ...(candidate?.cleanup_status === 'cleanup_unconfirmed'
      ? { cleanup_status: 'cleanup_unconfirmed' as const } : {}),
    ...(candidate?.predecessor_cleanup_status
      ? { predecessor_cleanup_status: candidate.predecessor_cleanup_status,
        ...(candidate.predecessor_target_id ? { predecessor_target_id: candidate.predecessor_target_id } : {}) }
      : {}),
    ...(candidate?.cooldown_until_ms !== undefined
      ? { cooldown_until_ms: candidate.cooldown_until_ms } : {}),
  };
}

function conversationLocatorFields(
  config: LaunchConfig,
  candidate?: { conversation_id?: string; cause?: string },
): Pick<TerminalEnvelope, 'recovery_available' | 'conversation_locator'> {
  // A redirected original conversation is unavailable: no recoverable (or foreign) locator.
  if (candidate?.cause === 'conversation_unavailable') return { recovery_available: false };
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
  // A unique owned marker proves physical Send independently of whether
  // the assistant output file can be published. Conflict remains the true
  // turn state; it cannot undo already observed user-message delivery.
  if (sendCount === 1 && (result.owned_marker_confirmed === true
    || result.send_witness === 'owned_marker')) return 'landed';
  if (result.state === 'output_conflict') {
    return sendCount === 0 ? 'not-sent' : 'POSSIBLY_DELIVERED';
  }
  // #2772 AC1: an `ok` (including author_effect_pr_head_changed) without the owned-Send witness is never
  // landed from cause or GitHub movement, and a zero count is not affirmative never-dispatched evidence.
  if (result.state === 'ok' && (sendCount === 0 || result.cause === 'author_effect_pr_head_changed')) {
    return 'POSSIBLY_DELIVERED';
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

/**
 * Resolve the predecessor's owner and Run/attempt from its own durable locator.
 * The current launch must independently carry its admitted Task+Dispatch pair.
 * This evidence gate has no cleanup or browser-tab retirement authority.
 */
function verifyOptionalPredecessorHandoff(config: LaunchConfig): PredecessorDisposition {
  const invocation = childOption(config, '--predecessor-invocation-id');
  const attempt = childOption(config, '--predecessor-attempt-identity');
  if (!invocation && !attempt) return 'none';
  if (!invocation || !attempt || !config.ownerTaskId || !config.ownerDispatchId
    || !config.invocationId || !config.profile || !config.cdp
    || invocation === config.invocationId
    || childOption(config, '--invocation-id') !== config.invocationId
    || childOption(config, '--profile') !== config.profile
    || childOption(config, '--cdp') !== config.cdp) {
    throw new Error('predecessor_identity_and_current_owner_required');
  }
  const bound = readPredecessorReceiptLocator({
    invocationId: invocation, expectedAttemptIdentity: attempt,
    terminalEnvelopeRoot: config.terminalEnvelopeRoot,
  });
  const run = bound.locator.run_identity;
  const oldAttempt = bound.locator.attempt_identity;
  const terminal = readTerminalEnvelope(bound.locator.terminal_envelope_path, {
    runIdentity: run, attemptIdentity: oldAttempt,
  });
  const original = readStateLightTurnObservation(
    configuredProfileKey(config.profile, config.cdp), invocation,
  );
  const target = original.owned_target;
  if (!terminal || !target || typeof target.created !== 'boolean'
    || typeof terminal.owned_target_created !== 'boolean') {
    throw new Error('predecessor_terminal_or_target_unproven');
  }
  const settledOk = terminal.lifecycle_outcome === 'success'
    && terminal.delivery === 'landed' && terminal.turn_result_state === 'ok';
  const notCreatedAndNotSent = target.created === false
    && terminal.owned_target_created === false
    && original.phase === 'not_sent'
    && original.transition_reason === 'terminal_pre_send'
    && original.send_count === 0
    && original.send_witness !== 'owned_marker'
    && original.owned_marker_confirmed !== true
    && terminal.delivery === 'not-sent'
    && terminal.send_count === 0;
  const unresolvedOwnedTarget = target.created === true
    && terminal.cleanup_status === 'cleanup_unconfirmed';
  if (terminal.observed_invocation_id !== invocation
    || terminal.handoff_receipt_path !== bound.locator.handoff_receipt_path
    || (!settledOk && !notCreatedAndNotSent && !unresolvedOwnedTarget)
    || !bound.receipt.owner_task_id?.trim() || !bound.receipt.owner_dispatch_id?.trim()
    || original.invocation_id !== invocation
    || target.cdp_sha256 !== createHash('sha256').update(config.cdp, 'utf8').digest('hex')
    || terminal.owned_target_id !== target.id
    || terminal.owned_target_created !== target.created
    || terminal.owned_prompt_marker !== original.marker
    || (!target.created && !notCreatedAndNotSent)
    || (config.conversationLocator !== undefined && terminal.conversation_locator !== undefined
      && normalizeConversationUrl(config.conversationLocator) !== normalizeConversationUrl(terminal.conversation_locator))) {
    throw new Error('predecessor_terminal_owner_profile_or_target_mismatch');
  }
  // A settled ok/landed (or never-created, never-sent) predecessor is a read-only no-op:
  // no Stop, cleanup, resend or old-Task equality. Only an unresolved owned target goes to the driver.
  return settledOk || notCreatedAndNotSent ? 'settled_noop' : 'retire_owned_target';
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

interface FinalObservationProjection {
  readonly record: StateLightTurnObservationRecord;
  readonly cdp: string;
  readonly delivery: DeliveryState;
  readonly replyDiagnostics?: Record<string, unknown>;
}

// One state-light observation and one final-primary integrity check for both terminal paths.
// A parsed result must correlate with both launch-selected identities before using its primary.
function finalObservationProjection(
  config: LaunchConfig,
  heartbeatDiagnostics?: Record<string, unknown>,
  candidate?: Pick<ParsedTurnResult, 'invocation_id' | 'configured_profile_key' | 'send_attempted'>,
): FinalObservationProjection | null {
  const invocationId = childOption(config, '--invocation-id');
  const profile = childOption(config, '--profile');
  const cdp = childOption(config, '--cdp');
  if (!invocationId || !profile || !cdp) return null;
  const profileKey = configuredProfileKey(profile, cdp);
  let record: StateLightTurnObservationRecord;
  try {
    record = readStateLightTurnObservation(profileKey, invocationId);
  } catch {
    return null;
  }
  if (candidate && (
    candidate.invocation_id !== invocationId
    || candidate.invocation_id !== record.invocation_id
    || candidate.configured_profile_key !== profileKey
    || candidate.configured_profile_key !== record.profile_key
  )) return null;

  const harvestedPrimary = record.phase === 'harvested' && Boolean(record.primary);
  const preDispatch = candidate?.send_attempted !== true
    && (record.phase === 'prepared'
      || (record.phase === 'not_sent' && record.transition_reason === 'terminal_pre_send'))
    && (record.send_count === undefined || record.send_count === 0);

  let replyDiagnostics = heartbeatDiagnostics;
  if (record.phase === 'harvested' && (heartbeatDiagnostics || candidate)) {
    // Keep accepted liveness; remove stale reply advisories before checking final bytes.
    // The successful result can receive verified reply length without a heartbeat.
    const retained: Record<string, unknown> = { ...(heartbeatDiagnostics ?? {}) };
    delete retained.last_reply_length;
    delete retained.last_reply_sha256_head;
    let verified = false;
    if (record.primary) {
      try {
        const bytes = readFileSync(record.primary.target);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (bytes.byteLength === record.primary.byte_length && sha256 === record.primary.sha256) {
          const replyLength = bytes.toString('utf8').length;
          retained.last_reply_length = replyLength;
          if (typeof heartbeatDiagnostics?.last_reply_sha256_head === 'string') {
            retained.last_reply_sha256_head = replyLength ? sha256.slice(0, 16) : '';
          }
          verified = true;
        }
      } catch {
        // Committed harvest proves delivery, not continued readability of its target.
      }
    }
    replyDiagnostics = (heartbeatDiagnostics || verified) ? retained : undefined;
  }

  return {
    record, cdp,
    delivery: harvestedPrimary || ((record.send_count ?? 0) === 1
      && (record.owned_marker_confirmed || record.send_witness === 'owned_marker'))
      ? 'landed' : preDispatch ? 'not-sent' : 'POSSIBLY_DELIVERED',
    ...(replyDiagnostics ? { replyDiagnostics } : {}),
  };
}

/** An attempted Send may be declared never-dispatched only with the
 * affirmative pre-actionability cause in BOTH the exact matching terminal
 * result and durable observation. Neither a zero-count attempt nor historical
 * not_sent phases are a sufficient negative witness. */
function affirmativelyNotDispatched(
  candidate: ParsedTurnResult,
  observed: FinalObservationProjection | null,
): boolean {
  const record = observed?.record;
  return candidate.send_attempted === true
    && candidate.cause === 'affirmative_pre_actionability_no_dispatch'
    && candidate.resolved_send_count === 0
    && !candidate.witness
    && candidate.observation_uncertainty_diagnostics?.owned_prompt_seen !== true
    && Boolean(record
      && record.invocation_id === candidate.invocation_id
      && record.profile_key === candidate.configured_profile_key
      && record.phase === 'not_sent'
      && record.transition_reason === 'affirmative_pre_actionability_no_dispatch'
      && record.send_count === 0
      && record.send_witness === 'none'
      && !record.primary);
}

async function persistedTerminalEvidence(
  config: LaunchConfig,
  heartbeatDiagnostics?: Record<string, unknown>,
): Promise<Partial<TerminalEnvelope> | null> {
  const observed = finalObservationProjection(config, heartbeatDiagnostics);
  if (!observed) return null;
  const { record } = observed;
  // Optional owned-tab CDP recovery stays exclusive to no-result incidents.
  const locator = (record.send_count ?? 0) >= 1 ? await provenOwnedTab(config, record, observed.cdp) : undefined;

  return {
    observed_invocation_id: record.invocation_id,
    ...(record.send_count !== undefined ? { send_count: record.send_count } : {}),
    delivery: observed.delivery,
    recovery_available: Boolean(locator),
    ...(locator ? { conversation_locator: locator } : {}),
    ...turnTargetEnvelopeFields(undefined, record),
    ...(record.owned_target?.created ? { cleanup_status: 'cleanup_unconfirmed' as const } : {}),
    diagnostics: {
      persisted_observation: {
        phase: record.phase, ...(record.send_count !== undefined ? { send_count: record.send_count } : {}),
        profile_key: record.profile_key,
      },
      ...(heartbeatDiagnostics && observed.replyDiagnostics ? { last_heartbeat: observed.replyDiagnostics } : {}),
    },
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
  const persisted = await persistedTerminalEvidence(config, heartbeatDiagnostics);
  if (persisted) {
    const projectedHeartbeat = (persisted.diagnostics as { last_heartbeat?: Record<string, unknown> })?.last_heartbeat;
    return {
      delivery: deliveryWithoutTurnResult(spawnFailed), recovery_available: false, ...persisted,
      ...(receiptEvidence ? { turn_result_state: receiptEvidence.state, turn_result_cause: receiptEvidence.cause } : {}),
      diagnostics: boundedDiagnostics({
        ...persisted.diagnostics,
        ...(receiptEvidence ? cancellationDiagnostics(receiptEvidence, projectedHeartbeat) : {}),
      }),
    };
  }
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

/** Optional test fixture clock and parent-ingestion observation; absent in production launches. */
export interface LaunchDeadlineTestControl {
  readonly now: () => number;
  readonly onEvent?: (event: {
    kind: 'initialized' | 'heartbeat' | 'result' | 'child_exit' | 'watchdog';
    observedAt: number;
    deadline: number;
    hardDeadline: number;
    accepted?: boolean;
    exitCode?: number | null;
  }) => void;
  /** A test-controlled watchdog wake barrier; the default remains the real delay loop. */
  readonly awaitWatchdogTurn?: () => Promise<void>;
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
  readonly deadlineTestControl?: LaunchDeadlineTestControl;
  /** Terminal-time GitHub target readers; production uses the pack `scripts/gh` REST readers. */
  readonly githubReaders?: GithubEffectReaders;
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

type CallerPublication =
  | { readonly state: 'published' }
  | { readonly state: 'occupied_exact'; readonly occupant: TerminalEnvelope }
  | { readonly state: 'not_published' };

/**
 * Settled, child-start and watchdog-timeout callers only. `publishEnvelope` stays unchanged and returns
 * false both for a genuinely failed write and for an occupied O_EXCL target. An occupant carrying this
 * launch's schema, run and attempt is already the authoritative event; a wrong or unreadable occupant,
 * or a failed creation, proves no event. The detached launcher discards stderr, so the line below is
 * a truthful in-band diagnostic only: recovery stays the original caller's `wait`/manual re-check.
 */
async function publishEnvelopeAtCaller(config: LaunchConfig, envelope: TerminalEnvelope): Promise<CallerPublication> {
  if (await publishEnvelope(config, envelope)) return { state: 'published' };
  const occupant = readTerminalEnvelope(config.terminalEnvelopePath, {
    runIdentity: config.runIdentity, attemptIdentity: config.attemptIdentity,
  });
  if (occupant) {
    process.stderr.write('flow-manager-long-running-child: terminal_envelope_occupied_by_exact_event\n');
    return { state: 'occupied_exact', occupant };
  }
  process.stderr.write('flow-manager-long-running-child: terminal_envelope_not_published: no event exists for this launch\n');
  return { state: 'not_published' };
}

const TERMINAL_GITHUB_EFFECT_BUDGET_MS = 25_000;

/** #2772 K6: the immutable launch-selected target from the child argv (`--bound-issue` or `--repo`/`--pr`). */
function launchBoundTarget(config: LaunchConfig): BoundGithubTarget | undefined {
  const issue = childOption(config, '--bound-issue');
  if (issue) {
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/u.exec(issue);
    return match ? { kind: 'issue', repo: match[1]!, number: Number(match[2]) } : undefined;
  }
  const repo = childOption(config, '--repo');
  const pr = childOption(config, '--pr');
  if (repo && pr && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo) && /^[1-9][0-9]*$/u.test(pr)) {
    return { kind: 'pr', repo, number: Number(pr) };
  }
  return undefined;
}

function sameBoundTarget(left: BoundGithubTarget, right: BoundGithubTarget): boolean {
  return left.kind === right.kind && left.repo.toLowerCase() === right.repo.toLowerCase() && left.number === right.number;
}

/** #2772 K4: the parsed turn-result names this exact launch-selected invocation and profile. */
function candidateIdentityMatchesLaunch(config: LaunchConfig, candidate: ParsedTurnResult): boolean {
  const invocationId = childOption(config, '--invocation-id');
  const profile = childOption(config, '--profile');
  const cdp = childOption(config, '--cdp');
  // A legacy launch without these selectors has no identity to compare against.
  if (!invocationId || !profile || !cdp) return true;
  if (config.invocationId !== undefined && config.invocationId !== invocationId) return false;
  return candidate.invocation_id === invocationId
    && candidate.configured_profile_key === configuredProfileKey(profile, cdp);
}

/**
 * A candidate may reach the shared effect evaluator only when it is this exact child invocation and
 * profile and the projection matched the original observation record. An absent, unreadable or
 * mismatched record (null projection) never does.
 */
function candidateBoundToInvocation(
  config: LaunchConfig, candidate: ParsedTurnResult, observation: FinalObservationProjection | null,
): boolean {
  const invocationId = childOption(config, '--invocation-id');
  const profile = childOption(config, '--profile');
  const cdp = childOption(config, '--cdp');
  if (!invocationId || !profile || !cdp || (config.invocationId !== undefined && config.invocationId !== invocationId)) return false;
  const profileKey = configuredProfileKey(profile, cdp);
  if (candidate.invocation_id !== invocationId || candidate.configured_profile_key !== profileKey) return false;
  // A missing or unreadable original observation record is never positive correlation (#2772 AC2).
  return observation !== null;
}

/**
 * The shared terminal-time GitHub effect check for candidate and no-candidate paths. It applies only
 * when the re-read original receipt carries a baseline, and only after immutable receipt identity,
 * exact invocation and still-current Task+Dispatch owner are re-established. It never changes
 * lifecycle, incident, exit or delivery.
 */
async function terminalGithubEffect(
  config: LaunchConfig, receipt: HandoffReceipt, candidateBound: boolean,
): Promise<{ readonly classification: GithubEffectClassification; readonly target?: BoundGithubTarget } | undefined> {
  let fresh: HandoffReceipt | null = null;
  try {
    fresh = readHandoffReceipt(config.handoffReceiptPath, {
      runIdentity: config.runIdentity, attemptIdentity: config.attemptIdentity,
    });
  } catch {
    fresh = null;
  }
  // Only the immutable launch selector names the original target; a receipt baseline never does (K6).
  const bound = launchBoundTarget(config);
  const unverified = (evidence: string) => ({
    classification: { class: 'effect_unverified' as const, attribution: 'unverified' as const, evidence },
    ...(bound ? { target: bound } : {}),
  });
  // A bound launch without a baseline still owes a bounded effect and the exact read-first step (K3).
  if (fresh?.github_effect_baseline === undefined) return bound ? unverified('baseline_absent') : undefined;
  const invocationId = childOption(config, '--invocation-id');
  if (!candidateBound) return unverified('candidate_not_bound_to_invocation');
  if (!invocationId || !sameHandoffIdentity(fresh, receipt) || fresh.invocation_id !== invocationId
    || fresh.owner_task_id !== config.ownerTaskId || fresh.owner_dispatch_id !== config.ownerDispatchId) {
    return unverified('receipt_identity_changed');
  }
  // A managed Task+Dispatch owner must be positively current, not merely not replaced (K1).
  if (config.ownerTaskId && config.ownerDispatchId) {
    const owner = observeOwnerCurrency(config.ownerTaskId, config.ownerDispatchId);
    if (owner.state !== 'current') return unverified(owner.state === 'not_current' ? 'owner_not_current' : 'owner_unverified');
  }
  const baseline = parseGithubEffectBaseline(fresh.github_effect_baseline, {
    invocationId, runIdentity: config.runIdentity, attemptIdentity: config.attemptIdentity,
  });
  if (!baseline) return unverified('baseline_absent');
  const target = baselineBoundTarget(baseline);
  if (!bound) return unverified('baseline_target_unbound');
  if (!target || !sameBoundTarget(bound, target)) return unverified('baseline_target_mismatch');
  let readers = config.githubReaders;
  if (!readers) {
    try { readers = await defaultGithubEffectReaders(); } catch { readers = undefined; }
  }
  if (!readers) return { ...unverified('github_reader_unavailable'), ...(target ? { target } : {}) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const classification = await Promise.race([
    classifyGithubEffect(baseline, readers),
    new Promise<GithubEffectClassification>((done) => {
      timer = setTimeout(() => done({
        class: 'effect_unverified', attribution: 'unverified', evidence: 'github_read_timeout',
      }), TERMINAL_GITHUB_EFFECT_BUDGET_MS);
      timer.unref?.();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  return { classification, ...(target ? { target } : {}) };
}

/** Add only the bounded effect diagnostic and the executable exact-target read-only next_action. */
async function withTerminalGithubEffect(
  config: LaunchConfig, receipt: HandoffReceipt, envelope: TerminalEnvelope, candidateBound: boolean,
): Promise<TerminalEnvelope> {
  const effect = await terminalGithubEffect(config, receipt, candidateBound);
  if (!effect) return envelope;
  const readFirst = effect.target
    && (envelope.lifecycle_outcome !== 'success' || envelope.turn_result_cause === 'author_effect_pr_head_changed');
  return {
    ...envelope,
    ...(readFirst ? { next_action: boundTargetReadFirstNextAction(effect.target) } : {}),
    diagnostics: boundedDiagnostics({ ...(envelope.diagnostics ?? {}), github_effect: effect.classification }),
  };
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
  const candidateObservation = finalObservationProjection(config, heartbeatDiagnostics, candidate);
  const provenNoDispatch = affirmativelyNotDispatched(candidate, candidateObservation);
  const candidateBound = candidateBoundToInvocation(config, candidate, candidateObservation);
  const withEffect = (envelope: TerminalEnvelope): Promise<TerminalEnvelope> =>
    withTerminalGithubEffect(config, receipt, envelope, candidateBound);
  const projectedTurnDiagnostics = {
    ...(candidate.cause === 'state_light_new_chat_send_slot_timeout' ? {
      send_slot_holder_invocation_id: candidate.send_slot_holder_invocation_id ?? 'unknown',
      send_slot_holder_phase: candidate.send_slot_holder_phase ?? 'unknown',
    } : {}),
  };
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
    delivery: provenNoDispatch ? 'not-sent' : deriveDelivery(candidate, false),
    child_exit_code: resolvedExitCode,
    child_exit_diagnostic: childExitDiagnostic,
    turn_result_state: candidate.state,
    turn_result_cause: candidate.cause,
    ...(candidate.next_action ? { next_action: candidate.next_action } : {}),
    send_count: candidate.resolved_send_count,
    observed_invocation_id: candidate.invocation_id,
    ...projectedTurnDiagnostics,
    ...(candidate.observed_turn_result_identity
      ? { observed_turn_result_identity: candidate.observed_turn_result_identity }
      : {}),
    ...conversationLocatorFields(config, candidate),
    ...turnTargetEnvelopeFields(candidate, candidateObservation?.record),
  });
  if (!candidateIdentityMatchesLaunch(config, candidate)) {
    // A foreign or misrouted turn-result is never this invocation's outcome (#2772 K4): keep none of its
    // Send witness, count, target or next action, and borrow no harvested primary across the mismatch.
    const foreignKeys = new Set([
      'send_count', 'next_action', 'observed_turn_result_identity',
      ...Object.keys(conversationLocatorFields(config, candidate)),
      ...Object.keys(turnTargetEnvelopeFields(candidate, undefined)),
    ]);
    const base = incidentEnvelope('child_turn_result_identity_mismatch');
    const envelope = Object.fromEntries(
      Object.entries(base).filter(([key]) => !foreignKeys.has(key)),
    ) as unknown as TerminalEnvelope;
    await publishEnvelopeAtCaller(config, await withEffect({
      ...envelope,
      delivery: 'POSSIBLY_DELIVERED',
      next_action: OWNER_RECONCILE_STEP,
    }));
    await abortManagedProcess(controller, runPromise);
    return 1;
  }
  if (capture.duplicateCandidate) {
    await publishEnvelopeAtCaller(config, await withEffect(incidentEnvelope('child_terminal_result_duplicate')));
    await abortManagedProcess(controller, runPromise);
    await delay(100);
    return 1;
  }
  if (candidate.state === 'ok') {
    const observed = candidateObservation;
    const resultDelivery = provenNoDispatch ? 'not-sent' : deriveDelivery(candidate, false);
    const observedDelivery = provenNoDispatch ? 'not-sent' : observed?.delivery;
    // A weaker pre-dispatch observation cannot demote a result's possible send or landing.
    const delivery = resultDelivery === 'landed' || observedDelivery === 'landed' ? 'landed'
      : resultDelivery === 'POSSIBLY_DELIVERED' || observedDelivery === 'POSSIBLY_DELIVERED'
        ? 'POSSIBLY_DELIVERED' : resultDelivery;
    const diagnostics = observed ? observed.replyDiagnostics : heartbeatDiagnostics;
    const publication = await publishEnvelopeAtCaller(config, await withEffect({
      schema: TERMINAL_SCHEMA,
      run_identity: config.runIdentity,
      attempt_identity: config.attemptIdentity,
      completion_mode: COMPLETION_MODE,
      handoff_receipt_path: config.handoffReceiptPath,
      launcher_started_at: launcherStartedAt,
      handoff_committed_at: receipt.handoff_committed_at,
      terminal_at: nowIso(),
      lifecycle_outcome: 'success',
      delivery,
      child_exit_code: resolvedExitCode,
      child_exit_diagnostic: childExitDiagnostic,
      turn_result_state: candidate.state,
      turn_result_cause: candidate.cause,
      ...(candidate.next_action ? { next_action: candidate.next_action } : {}),
      send_count: candidate.resolved_send_count,
      observed_invocation_id: candidate.invocation_id,
      ...projectedTurnDiagnostics,
      ...(candidate.observed_turn_result_identity
        ? { observed_turn_result_identity: candidate.observed_turn_result_identity }
        : {}),
      ...conversationLocatorFields(config, candidate),
      ...turnTargetEnvelopeFields(candidate, candidateObservation?.record),
      ...(diagnostics ? { diagnostics } : {}),
    }));
    await abortManagedProcess(controller, runPromise);
    // An exact occupant is the authoritative event; this launch's success must not outrank its incident.
    return publication.state === 'occupied_exact' && publication.occupant.lifecycle_outcome !== 'success' ? 1 : 0;
  }
  await publishEnvelopeAtCaller(config, await withEffect(incidentEnvelope(`child_turn_state:${candidate.state}`)));
  await abortManagedProcess(controller, runPromise);
  return 1;
}

/** Default executable remediation for each pre-child launcher refusal code (AC13). */
const REFUSAL_NEXT_STEPS: Readonly<Record<string, string>> = {
  durable_artifact_root_invalid: 'set HOME to an absolute home directory, make $HOME/.local/state/orchestrator-pack private (0700) and owned by you, then relaunch',
  predecessor_handoff_unproven: 'reconcile the exact predecessor invocation through its own locator/terminal (wait --invocation-id <old> with its original Run/attempt) before any SEND; do not retry while it is unresolved',
  owner_identity_pair_required: 'pass both --owner-task-id and --owner-dispatch-id from the current upstream-admitted Task+Dispatch, or neither for a legacy direct launch',
  owner_dispatch_not_current: 'the selected assignment store records a different Dispatch for this Task: relaunch only from the currently approved Task+Dispatch owner',
  invalid_cwd: 'pass --cwd <existing worktree directory>',
  terminal_envelope_name_not_wakeable: 'pass a --terminal-envelope basename ending in terminal.json',
  occupied_launcher_owned_path: 'choose fresh handoff/terminal/browser-output basenames (or reconcile the earlier invocation that owns them)',
  preflight_failed: 'make the durable root and browser-output parent private (0700) writable directories with distinct artifact paths, then relaunch',
  liveness_contract_invalid: 'fix the OPK browser-turn liveness timing environment, then relaunch',
  invocation_admission_failed_use_fresh_id: 'relaunch with a fresh --invocation-id; this id is already reserved or its observation exists',
  receipt_create_or_index_readback_failed: 'reconcile the exact original invocation with wait --invocation-id before any new SEND; never resend blindly',
  receipt_create_failed: 'check the durable root permissions, then relaunch with fresh artifact basenames',
  canary_in_receipt: 'remove secret-bearing values from launch arguments, then relaunch with a fresh invocation id',
  [PROFILE_ABSOLUTE_REQUIRED_CODE]: PROFILE_ABSOLUTE_NEXT_STEP,
};

const REFUSAL_REASON_CAP = 160;

/**
 * Bounded, scrubbed original refusal reason (for example `ENOENT` or a proof-failure code) that may reach
 * caller stderr/companion: absolute paths, URLs and long tokens are redacted and the text is capped.
 */
export function boundedRefusalReason(message: unknown): string | undefined {
  if (typeof message !== 'string' || !message.trim()) return undefined;
  const scrubbed = message
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, '<url>')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'",;()]*/gu, (match) => (/[\\/][^\\/]/u.test(match) ? '<path>' : match))
    // Long opaque tokens (digits, capitals or base64 punctuation) are redacted; lower snake_case codes stay.
    .replace(/[A-Za-z0-9_+/=-]{24,}/gu, (match) => (/^[a-z_]+$/u.test(match) ? match : '<redacted>'))
    .replace(/[^\x20-\x7e]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!scrubbed) return undefined;
  return scrubbed.length > REFUSAL_REASON_CAP ? `${scrubbed.slice(0, REFUSAL_REASON_CAP - 3)}...` : scrubbed;
}

function refusalDetails(code: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  const base = typeof details.nextStep === 'string' && details.nextStep.trim()
    ? details.nextStep : REFUSAL_NEXT_STEPS[code] ?? 'reconcile the exact original invocation before any new SEND';
  // The caller sees the genuine bounded cause first, then the executable repair.
  const reason = boundedRefusalReason(details.message);
  const nextStep = reason && !base.startsWith('reason: ') ? `reason: ${reason}; ${base}` : base;
  // The raw message never crosses the caller boundary; only its bounded reason does (#2772 K7).
  const { message: _raw, ...rest } = details;
  return { ...rest, ...(reason ? { message: reason } : {}), nextStep };
}

/** Companion schema for an authenticated detached-launcher pre-SEND refusal (non-authoritative). */
export const REFUSAL_COMPANION_SCHEMA = 'flow-manager-long-running-child-refusal-companion/v1' as const;
export const REFUSAL_COMPANION_ENV = 'OPK_FM_LONG_CHILD_REFUSAL_COMPANION' as const;
export const HANDOFF_RECEIPT_ENV = 'OPK_FM_LONG_CHILD_HANDOFF_RECEIPT' as const;
const COMPANION_BYTE_CAP = 2_048;

export function refusalCompanionPath(handoffReceiptPath: string): string {
  return `${resolve(handoffReceiptPath)}.refusal.json`;
}

export interface RefusalCompanion {
  readonly schema: typeof REFUSAL_COMPANION_SCHEMA;
  readonly run_identity: string;
  readonly attempt_identity: string;
  readonly invocation_id?: string;
  readonly launcher_pid: number;
  readonly code: string;
  readonly nextStep: string;
  readonly physical_send: 'none';
}

/** Detached launcher refusals lose stderr; when the wrapper asks, leave one bounded scrubbed companion. */
function writeRefusalCompanion(config: LaunchConfig, code: string, details: Record<string, unknown>): void {
  if (process.env[REFUSAL_COMPANION_ENV] !== 'v1') return;
  try {
    const nextStep = String(details.nextStep ?? '').slice(0, 512);
    const body: RefusalCompanion = {
      schema: REFUSAL_COMPANION_SCHEMA,
      run_identity: config.runIdentity,
      attempt_identity: config.attemptIdentity,
      ...(config.invocationId ? { invocation_id: config.invocationId } : {}),
      launcher_pid: process.pid,
      code: code.slice(0, 128),
      nextStep,
      physical_send: 'none',
    };
    const json = JSON.stringify(body);
    const canaries = config.secretCanaries ?? [];
    if (json.length > COMPANION_BYTE_CAP || canaries.some((value) => value && json.includes(value))) return;
    if (existsSync(config.handoffReceiptPath)) return;
    atomicCreateJson(refusalCompanionPath(config.handoffReceiptPath), body as unknown as Record<string, unknown>, 'receipt');
  } catch {
    // The companion is best-effort diagnostics; its absence never fabricates a code.
  }
}

export function readRefusalCompanion(handoffReceiptPath: string, expected: {
  readonly runIdentity: string; readonly attemptIdentity: string; readonly invocationId?: string; readonly launcherPid: number;
}): RefusalCompanion | null {
  try {
    const path = refusalCompanionPath(handoffReceiptPath);
    assertPrivateFile(path, false);
    const raw = readFileSync(path, 'utf8');
    if (raw.length > COMPANION_BYTE_CAP) return null;
    const body = JSON.parse(raw) as RefusalCompanion;
    if (body.schema !== REFUSAL_COMPANION_SCHEMA || body.run_identity !== expected.runIdentity
      || body.attempt_identity !== expected.attemptIdentity || body.launcher_pid !== expected.launcherPid
      || body.invocation_id !== expected.invocationId || body.physical_send !== 'none'
      || typeof body.code !== 'string' || !/^[a-z0-9_:-]{1,128}$/u.test(body.code)
      || typeof body.nextStep !== 'string' || !body.nextStep.trim()) return null;
    return body;
  } catch {
    return null;
  }
}

export type OwnerCurrencyState = 'current' | 'not_current' | 'unverified';

/**
 * Existing selected assignment authority (worker-assignments.json) for the upstream-admitted
 * Task+Dispatch pair. `unverified` (store absent/unreadable/Task unknown) stays the named upstream
 * responsibility; only an exact record makes the pair locally `current`.
 */
export function observeOwnerCurrency(
  taskId: string, dispatchId: string, env: NodeJS.ProcessEnv = process.env,
): { readonly state: OwnerCurrencyState; readonly evidence: string } {
  const projectId = env.OPK_PROJECT_ID?.trim() || 'orchestrator-pack';
  let file: string;
  try {
    file = resolveWorkerAssignmentStorePath(projectId, env);
  } catch {
    return { state: 'unverified', evidence: 'assignment_store_path_unresolved' };
  }
  if (!existsSync(file)) return { state: 'unverified', evidence: 'assignment_store_absent' };
  const records = listCurrentWorkerAssignmentRecords(file);
  if (!records) return { state: 'unverified', evidence: 'assignment_store_unreadable' };
  if (records.some((record) => record.taskId === taskId && record.bindingKey === dispatchId)) {
    return { state: 'current', evidence: 'assignment_current' };
  }
  if (records.some((record) => record.taskId === taskId)) return { state: 'not_current', evidence: 'task_dispatch_replaced' };
  return { state: 'unverified', evidence: 'task_not_in_selected_store' };
}

/** Read-only native Orca Dispatch witness (`orca orchestration worker-show --dispatch <id> --json` result). */
export type OwnerDispatchWitness = (dispatchId: string) => Promise<Record<string, unknown> | undefined>;

export async function defaultOwnerDispatchWitness(dispatchId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await runProcess({
      command: 'orca', args: ['orchestration', 'worker-show', '--dispatch', dispatchId, '--full', '--json'],
      timeoutMs: 15_000, inheritParentEnv: true,
    });
    if (!result.ok) return undefined;
    const receipt = JSON.parse(result.stdout) as { ok?: unknown; result?: unknown };
    return receipt.ok === true && receipt.result && typeof receipt.result === 'object'
      ? receipt.result as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export interface OwnerAuthorityInput {
  readonly taskId: string;
  readonly dispatchId: string;
  /** The original receipt's launching terminal, when it recorded one. */
  readonly originalTerminalHandle?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly dispatchWitness?: OwnerDispatchWitness;
  /** The invoking process's own Orca terminal; defaults to ORCA_TERMINAL_HANDLE. */
  readonly invokingTerminalHandle?: string;
}

export type OwnerAuthority =
  | { readonly ok: true; readonly evidence: string; readonly file: string; readonly record: WorkerAssignmentRecord }
  | { readonly ok: false; readonly evidence: string };

/**
 * Effectful owner authority: the selected assignment store holds exactly this Task+Dispatch, the
 * native Dispatch is live and dispatched for that Task, and the invoking process is that Dispatch's
 * own worker terminal. Historical receipt strings or a lingering store row alone never qualify.
 */
export async function verifyCurrentInvokingOwner(input: OwnerAuthorityInput): Promise<OwnerAuthority> {
  const env = input.env ?? process.env;
  const projectId = env.OPK_PROJECT_ID?.trim() || 'orchestrator-pack';
  let file: string;
  try { file = resolveWorkerAssignmentStorePath(projectId, env); }
  catch { return { ok: false, evidence: 'assignment_store_path_unresolved' }; }
  if (!existsSync(file)) return { ok: false, evidence: 'assignment_store_absent' };
  const records = listCurrentWorkerAssignmentRecords(file);
  if (!records) return { ok: false, evidence: 'assignment_store_unreadable' };
  const matches = records.filter((record) => record.taskId === input.taskId && record.bindingKey === input.dispatchId);
  if (matches.length !== 1) {
    return { ok: false, evidence: records.some((record) => record.taskId === input.taskId)
      ? 'task_dispatch_replaced' : 'task_not_in_selected_store' };
  }
  const invoking = input.invokingTerminalHandle?.trim() || launchingTerminalHandle(env);
  if (!invoking) return { ok: false, evidence: 'invoking_terminal_unknown' };
  if (input.originalTerminalHandle && input.originalTerminalHandle !== invoking) {
    return { ok: false, evidence: 'invoking_terminal_not_original_launcher_terminal' };
  }
  let witness: Record<string, unknown> | undefined;
  try { witness = await (input.dispatchWitness ?? defaultOwnerDispatchWitness)(input.dispatchId); }
  catch { witness = undefined; }
  const dispatch = witness?.dispatch as { id?: unknown; taskId?: unknown; status?: unknown } | undefined;
  const observation = witness?.observation as { status?: unknown; exactWorker?: unknown } | undefined;
  const terminal = witness?.terminal as { handle?: unknown } | undefined;
  if (!witness) return { ok: false, evidence: 'native_dispatch_unreadable' };
  if (dispatch?.id !== input.dispatchId || dispatch.taskId !== input.taskId) {
    return { ok: false, evidence: 'native_dispatch_foreign' };
  }
  if (dispatch.status !== 'dispatched' || observation?.status !== 'live' || observation.exactWorker !== true) {
    return { ok: false, evidence: 'native_dispatch_not_live' };
  }
  if (terminal?.handle !== invoking) return { ok: false, evidence: 'invoking_terminal_not_dispatch_worker' };
  return { ok: true, evidence: 'assignment_and_native_dispatch_current', file, record: matches[0]! };
}

const OWNER_FENCE_ATTEMPTS = 40;
const OWNER_FENCE_RETRY_MS = 25;

/**
 * Re-verify owner authority immediately before one bounded effect, then run it inside the existing
 * assignment fence so a reassignment either wins first (effect refused) or waits for it.
 */
export async function withVerifiedOwnerEffect<T>(
  input: OwnerAuthorityInput, action: () => T | Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly evidence: string; readonly actionEntered: boolean }> {
  const authority = await verifyCurrentInvokingOwner(input);
  if (!authority.ok) return { ok: false, evidence: authority.evidence, actionEntered: false };
  // The fence never waits on its lock; a short bounded retry lets concurrent same-owner effects
  // serialize (the loser then observes the winner) instead of failing as busy.
  for (let attempt = 1; ; attempt += 1) {
    const fenced = await withCurrentWorkerAssignmentFence(authority.file, authority.record, action);
    if (fenced.ok) return { ok: true, value: fenced.value };
    if (fenced.reason !== 'assignment_store_busy' || fenced.actionEntered || attempt >= OWNER_FENCE_ATTEMPTS) {
      return { ok: false, evidence: fenced.reason, actionEntered: fenced.actionEntered };
    }
    await delay(OWNER_FENCE_RETRY_MS);
  }
}

type PredecessorDisposition = 'none' | 'settled_noop' | 'retire_owned_target';

export type LaunchPreSpawnValidation =
  | { readonly ok: true; readonly config: LaunchConfig; readonly predecessor: PredecessorDisposition;
    readonly ownerCurrency?: OwnerCurrencyState }
  | { readonly ok: false; readonly code: string; readonly details: Record<string, unknown> };

/**
 * The one production pre-spawn validation, shared in-process by the adapter (before detachment)
 * and by the launcher itself. It reserves nothing: the invocation key is reserved only by runLaunch.
 */
export function validateLaunchPreSpawn(input: LaunchConfig): LaunchPreSpawnValidation {
  const fail = (code: string, details: Record<string, unknown> = {}): LaunchPreSpawnValidation => ({
    ok: false, code, details: refusalDetails(code, details),
  });
  let config = input;
  if (!config.terminalEnvelopeRoot) {
    try {
      const root = resolveDurableArtifactRoot();
      config = {
        ...config,
        terminalEnvelopeRoot: root,
        handoffReceiptPath: resolveDurableArtifactPath(config.handoffReceiptPath, root),
        terminalEnvelopePath: resolveDurableArtifactPath(config.terminalEnvelopePath, root),
      };
    } catch (error) {
      return fail('durable_artifact_root_invalid', { message: error instanceof Error ? error.message : String(error) });
    }
  }
  if ((config.ownerTaskId === undefined) !== (config.ownerDispatchId === undefined)
    || (config.ownerTaskId !== undefined && (!config.ownerTaskId.trim() || !config.ownerDispatchId?.trim()))) {
    return fail('owner_identity_pair_required');
  }
  let ownerCurrency: OwnerCurrencyState | undefined;
  if (config.ownerTaskId && config.ownerDispatchId) {
    const observed = observeOwnerCurrency(config.ownerTaskId, config.ownerDispatchId);
    ownerCurrency = observed.state;
    if (observed.state === 'not_current') return fail('owner_dispatch_not_current', { evidence: observed.evidence });
  }
  // Lexical absolute user-data-dir before any profile key, occupancy hash or observation lookup.
  const profileError = config.profile !== undefined ? absoluteProfilePathError(config.profile) : undefined;
  if (profileError) return fail(PROFILE_ABSOLUTE_REQUIRED_CODE, { message: profileError });
  let predecessor: PredecessorDisposition;
  try {
    predecessor = verifyOptionalPredecessorHandoff(config);
  } catch (error) {
    return fail('predecessor_handoff_unproven', { message: error instanceof Error ? error.message : String(error) });
  }
  if (!existsSync(config.cwd) || !statSync(config.cwd).isDirectory()) return fail('invalid_cwd', { cwd: config.cwd });
  if (!isWakeableTerminalEnvelopePath(config.terminalEnvelopePath, config.terminalEnvelopeRoot)) {
    const hint = unwakeableTerminalEnvelopeHint(config.terminalEnvelopePath);
    return fail('terminal_envelope_name_not_wakeable', {
      path: config.terminalEnvelopePath, required_suffix: TERMINAL_ENVELOPE_NAME_SUFFIX, ...hint, nextStep: hint.hint,
    });
  }
  const launcherArtifacts = [config.handoffReceiptPath, config.terminalEnvelopePath, config.browserOutputPath];
  for (const path of launcherArtifacts) {
    if (existsSync(path)) return fail('occupied_launcher_owned_path', { path });
  }
  try {
    assertPairwiseDistinct(launcherArtifacts);
    if (resolve(config.terminalEnvelopeRoot ?? '') === resolveDurableArtifactRoot()) ensureDurableArtifactRoot();
    ensureParentWritable(config.handoffReceiptPath);
    ensureParentWritable(config.terminalEnvelopePath);
    ensureParentWritable(config.browserOutputPath);
  } catch (error) {
    return fail('preflight_failed', { message: error instanceof Error ? error.message : String(error) });
  }
  try {
    resolveBrowserTurnLivenessTiming();
  } catch (error) {
    return fail('liveness_contract_invalid', { message: error instanceof Error ? error.message : String(error) });
  }
  if (config.invocationId !== undefined) {
    try {
      if (!config.invocationId.trim() || !config.profile?.trim() || !config.cdp?.trim()) {
        throw new Error('indexed_invocation_profile_cdp_required');
      }
      const observationPath = observationRecordPath(configuredProfileKey(config.profile, config.cdp), config.invocationId);
      if (existsSync(observationPath)) throw new Error('invocation_observation_occupied_use_fresh_id');
      if (existsSync(invocationReceiptLocatorPath(config.invocationId, config.terminalEnvelopeRoot ?? effectiveTerminalRoot()))) {
        throw new Error('invocation_locator_occupied_use_fresh_id');
      }
    } catch (error) {
      return fail('invocation_admission_failed_use_fresh_id', { message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (predecessor === 'settled_noop') config = { ...config, childArgs: withoutPredecessorSelector(config.childArgs) };
  return { ok: true, config, predecessor, ...(ownerCurrency ? { ownerCurrency } : {}) };
}

function withoutPredecessorSelector(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--predecessor-invocation-id' || args[index] === '--predecessor-attempt-identity') {
      index += 1;
      continue;
    }
    out.push(args[index]!);
  }
  return out;
}

/** Optional Linux /proc witnesses: observational identity, never a signal capability. */
export interface ProcessWitnessProbe {
  readonly bootId: () => string | undefined;
  readonly pidNamespace: () => string | undefined;
  readonly stat: (pid: number) => { readonly kind: 'ok'; readonly startticks: string; readonly state: string }
    | { readonly kind: 'absent' } | { readonly kind: 'error' };
}

export const procProcessWitnessProbe: ProcessWitnessProbe = {
  bootId: () => {
    try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; } catch { return undefined; }
  },
  pidNamespace: () => {
    try { return readlinkSync('/proc/self/ns/pid'); } catch { return undefined; }
  },
  stat: (pid) => {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      const state = rest[0];
      const startticks = rest[19];
      if (!state || !startticks || !/^[0-9]+$/u.test(startticks)) return { kind: 'error' };
      return { kind: 'ok', startticks, state };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'error' };
    }
  },
};

function selfProcessWitnesses(probe: ProcessWitnessProbe = procProcessWitnessProbe): Partial<HandoffReceipt> {
  const stat = probe.stat(process.pid);
  const namespace = probe.pidNamespace();
  const boot = probe.bootId();
  return {
    ...(stat.kind === 'ok' ? { launcher_startticks: stat.startticks } : {}),
    ...(namespace ? { launcher_pid_namespace: namespace } : {}),
    ...(boot ? { launcher_boot_id: boot } : {}),
  };
}

export type LauncherLiveness = { readonly state: 'alive' | 'dead' | 'unknown'; readonly evidence: string };

/**
 * Positive original-launcher death from receipt witnesses. Unreadable /proc, a missing witness or
 * deadline, or namespace ambiguity is `unknown`; PID-only liveness is never decisive.
 */
export function observeOriginalLauncher(
  receipt: HandoffReceipt, probe: ProcessWitnessProbe = procProcessWitnessProbe,
): LauncherLiveness {
  const pid = receipt.launcher_pid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 1 || !receipt.launcher_startticks
    || !receipt.launcher_pid_namespace || !receipt.launcher_boot_id) return { state: 'unknown', evidence: 'witness_missing' };
  if (!Number.isSafeInteger(receipt.launcher_hard_deadline_ms)) return { state: 'unknown', evidence: 'hard_deadline_missing' };
  const boot = probe.bootId();
  if (!boot) return { state: 'unknown', evidence: 'boot_id_unreadable' };
  if (boot !== receipt.launcher_boot_id) return { state: 'dead', evidence: 'host_rebooted' };
  const namespace = probe.pidNamespace();
  if (!namespace || namespace !== receipt.launcher_pid_namespace) return { state: 'unknown', evidence: 'pid_namespace_unproven' };
  const stat = probe.stat(pid!);
  if (stat.kind === 'absent') return { state: 'dead', evidence: 'pid_absent' };
  if (stat.kind === 'error') return { state: 'unknown', evidence: 'proc_unreadable' };
  if (stat.startticks !== receipt.launcher_startticks) return { state: 'dead', evidence: 'pid_reused_distinct_startticks' };
  if (stat.state === 'Z' || stat.state === 'X') return { state: 'dead', evidence: 'launcher_zombie' };
  return { state: 'alive', evidence: 'launcher_live' };
}

export async function runLaunch(input: LaunchConfig): Promise<number> {
  const canaries = input.secretCanaries ?? [];
  const validation = validateLaunchPreSpawn(input);
  if (!validation.ok) {
    refuse(validation.code, validation.details);
    writeRefusalCompanion(input.terminalEnvelopeRoot ? input : {
      ...input,
      handoffReceiptPath: (() => {
        try { return resolveDurableArtifactPath(input.handoffReceiptPath); } catch { return resolve(input.handoffReceiptPath); }
      })(),
    }, validation.code, validation.details);
    return 2;
  }
  let config = validation.config;
  const launcherArtifacts = [config.handoffReceiptPath, config.terminalEnvelopePath, config.browserOutputPath];
  const refuseAfterValidation = (code: string, details?: Record<string, unknown>): number => {
    const full = refusalDetails(code, details);
    refuse(code, full);
    writeRefusalCompanion(config, code, full);
    return 2;
  };
  const livenessTiming = resolveBrowserTurnLivenessTiming();

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
    ...selfProcessWitnesses(),
    launcher_hard_deadline_ms: Date.now() + hardDeadlineMs(),
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
      return refuseAfterValidation('invocation_admission_failed_use_fresh_id', {
        message: error instanceof Error ? error.message : String(error),
      });
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
    return refuseAfterValidation(indexedPath ? 'receipt_create_or_index_readback_failed' : 'receipt_create_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (scanArtifactForCanaries(config.handoffReceiptPath, canaries).length > 0) {
    return refuseAfterValidation('canary_in_receipt');
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
  const deadlineClock = config.deadlineTestControl?.now ?? Date.now;
  const hardDeadline = deadlineClock() + hardDeadlineMs();
  let deadline = Math.min(deadlineClock() + livenessTiming.startupAllowanceMs, hardDeadline);
  const observed = (
    kind: 'initialized' | 'heartbeat' | 'result' | 'child_exit' | 'watchdog',
    observedAt: number,
    accepted?: boolean,
    exitCode?: number | null,
  ): void => {
    config.deadlineTestControl?.onEvent?.({
      kind, observedAt, deadline, hardDeadline,
      ...(accepted === undefined ? {} : { accepted }),
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  };
  observed('initialized', deadlineClock());

  const observeDeadline = (observedAt: number): boolean => {
    if (observedAt < deadline) return false;
    if (watchdogExpiredAt === null) watchdogExpiredAt = deadline;
    return true;
  };

  const ingestStdoutLine = (line: string, observedAt = deadlineClock()): void => {
    const cancellationReceipt = parseCancellationReceiptLine(line);
    if (cancellationReceipt) {
      if (!capture.cancellationReceipt) capture.cancellationReceipt = cancellationReceipt;
      else capture.duplicateCancellationReceipt = true;
      return;
    }
    const heartbeat = parseObservationHeartbeatLine(line);
    if (heartbeat) {
      if (capture.firstCandidate || observeDeadline(observedAt)) {
        observed('heartbeat', observedAt, false);
        return;
      }
      acceptedHeartbeat = true;
      lastHeartbeatDiagnostics = boundedDiagnostics({
        ...heartbeat,
        accepted_at: new Date(observedAt).toISOString(),
      });
      deadline = Math.min(observedAt + livenessTiming.liveChildIdleWindowMs, hardDeadline);
      observed('heartbeat', observedAt, true);
      return;
    }
    const candidate = parseTurnResult(line);
    if (!candidate) return;
    if (capture.firstCandidate) {
      capture.duplicateCandidate = true;
      observed('result', observedAt, false);
      return;
    }
    if (observeDeadline(observedAt)) {
      observed('result', observedAt, false);
      return;
    }
    capture.firstCandidate = candidate;
    observed('result', observedAt, true);
  };

  const drainStdoutBuffer = (observedAt = deadlineClock()): void => {
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
    const observedAt = lastStdoutObservedAt ?? deadlineClock();
    if (observeDeadline(observedAt)) return;
    capture.firstCandidate = candidate;
  };
  capture.drainStdoutBuffer = () => drainStdoutBuffer();

  let launcherSignal: NodeJS.Signals | undefined;
  let cleanupProcess: Promise<ProcessResult> | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    launcherSignal ??= signal;
    // Forward the launcher signal immediately through the already-owned child tree;
    // publishAbnormal still performs the bounded result drain afterwards.
    controller.abort();
  };
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
      await publishEnvelope(config, await withTerminalGithubEffect(config, receipt, {
        schema: TERMINAL_SCHEMA, run_identity: config.runIdentity, attempt_identity: config.attemptIdentity,
        completion_mode: COMPLETION_MODE, handoff_receipt_path: config.handoffReceiptPath,
        launcher_started_at: launcherStartedAt, handoff_committed_at: receipt.handoff_committed_at,
        terminal_at: nowIso(), lifecycle_outcome: 'incident', incident, child_exit_code: childExitCode,
        ...await terminalNoResultEvidence(config, capture, 'child_terminal_result_missing', false, lastHeartbeatDiagnostics),
      }, true));
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
    // The driver may add the optional pre-SEND github_effect_baseline to this exact receipt.
    env: { [HANDOFF_RECEIPT_ENV]: resolve(config.handoffReceiptPath), [REFUSAL_COMPANION_ENV]: undefined },
    allowEmptyStdout: true,
    signal: controller.signal,
    onStdoutChunk: (chunk) => {
      const observedAt = deadlineClock();
      lastStdoutObservedAt = observedAt;
      capture.stdoutBuffer += chunk;
      drainStdoutBuffer(observedAt);
    },
  }).then((result) => {
    const observedAt = deadlineClock();
    childExitCode = result.exitCode;
    drainStdoutBuffer(observedAt);
    if (!capture.firstCandidate && !observeDeadline(observedAt)) childExitedBeforeCandidate = true;
    observed('child_exit', observedAt, undefined, result.exitCode);
    return result;
  });
  cleanupProcess = runPromise;

  const spawnProbeWaitMs = Math.max(1, Math.min(100, deadline - deadlineClock()));
  const spawnProbe = await Promise.race([
    runPromise.then((result) => ({ kind: 'done' as const, result })),
    delay(spawnProbeWaitMs).then(() => ({ kind: 'pending' as const })),
  ]);
  if (spawnProbe.kind === 'done' && spawnProbe.result.outcome === 'spawn-failure') {
    await publishEnvelopeAtCaller(config, {
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
    const observedAt = deadlineClock();
    observed('watchdog', observedAt);
    const remainingMs = deadline - observedAt;
    if (remainingMs <= 0) {
      observeDeadline(observedAt);
      break;
    }
    if (config.deadlineTestControl?.awaitWatchdogTurn) {
      await config.deadlineTestControl.awaitWatchdogTurn();
    } else {
      await delay(Math.min(20, remainingMs));
    }
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
    await publishEnvelopeAtCaller(config, await withTerminalGithubEffect(config, receipt, {
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
    }, true));
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
    await publishEnvelopeAtCaller(config, await withTerminalGithubEffect(config, receipt, {
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
    }, true));
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

export type GithubEffectClass = 'target_progress_observed' | 'effect_unverified';

/** Structured exact PR tuple read through the pack GitHub REST transport. */
export interface GithubPrTuple {
  readonly repository: string;
  readonly number: number;
  /** Upper-cased REST state, e.g. OPEN or CLOSED. */
  readonly state: string;
  readonly base_repository: string;
  readonly base_ref: string;
  readonly head_repository: string;
  readonly head_ref: string;
  readonly head_oid: string;
}

/** Structured exact Issue tuple read through the pack GitHub REST transport. */
export interface GithubIssueTuple {
  readonly repository: string;
  readonly number: number;
  readonly state: string;
  readonly body_sha256: string;
}

export interface GithubEffectReaders {
  readonly prTuple: (repo: string, pr: number) => Promise<GithubPrTuple | undefined>;
  readonly issueTuple: (repo: string, issue: number) => Promise<GithubIssueTuple | undefined>;
}

async function defaultGithubEffectReaders(): Promise<GithubEffectReaders> {
  const driver = await import('./chatgpt-browser-turn/state-light-turn-base.ts');
  return {
    prTuple: async (repo, pr) => {
      const head = await driver.readPrAuthorHeadViaPackGh({ repo: repo.toLowerCase(), pr });
      return head && head.baseRef !== undefined ? {
        repository: repo.toLowerCase(), number: pr, state: head.state.toUpperCase(),
        base_repository: head.baseRepo, base_ref: head.baseRef,
        head_repository: head.headRepo, head_ref: head.headRef, head_oid: head.sha,
      } : undefined;
    },
    issueTuple: async (repo, issue) => {
      const tuple = await driver.readIssueTupleViaPackGh(repo.toLowerCase(), issue);
      return tuple?.state ? {
        repository: repo.toLowerCase(), number: issue, state: tuple.state, body_sha256: tuple.bodySha256,
      } : undefined;
    },
  };
}

export type GithubEffectClassification = {
  readonly class: GithubEffectClass; readonly attribution: 'unverified'; readonly evidence: string; readonly target?: string;
};

function sameTuple(left: object, right: object): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left as Record<string, unknown>)[key] !== (right as Record<string, unknown>)[key]) return false;
  }
  return true;
}

/**
 * The one shared terminal-time GitHub target-progress evaluator. Two coherent post-SEND reads of the
 * exact baseline-bound structured tuple are compared with the captured pre-SEND baseline. Only a still-OPEN
 * same PR with unchanged base/head repository+ref and an advanced head OID, or a still-OPEN same Issue with a
 * changed body digest, is target_progress_observed; attribution stays unverified (a concurrent same-target
 * writer is not excluded). Everything else is effect_unverified. Neither proves Send, authorship or acceptance.
 */
export async function classifyGithubEffect(
  baseline: GithubEffectBaseline | undefined, readers: GithubEffectReaders,
): Promise<GithubEffectClassification> {
  const unverified = (evidence: string, target?: string) => ({
    class: 'effect_unverified' as const, attribution: 'unverified' as const, evidence, ...(target ? { target } : {}),
  });
  if (!baseline) return unverified('baseline_absent');
  const target = `${baseline.repo}${baseline.kind === 'pr' ? '/pull/' : '#'}${baseline.number}`;
  const repo = baseline.repo.toLowerCase();
  const baselineOpen = baseline.state?.toUpperCase() === 'OPEN';
  try {
    if (baseline.kind === 'pr') {
      if (!baseline.state || !baseline.base_repository || !baseline.base_ref
        || !baseline.head_repository || !baseline.head_ref) return unverified('baseline_tuple_incomplete', target);
      if (!baselineOpen) return unverified('baseline_target_not_open', target);
      const first = await readers.prTuple(baseline.repo, baseline.number);
      const second = first ? await readers.prTuple(baseline.repo, baseline.number) : undefined;
      if (!first || !second) return unverified('pr_head_unreadable', target);
      if (!sameTuple(first, second)) return unverified('pr_head_not_stable', target);
      if (first.repository.toLowerCase() !== repo || first.number !== baseline.number) {
        return unverified('target_identity_changed', target);
      }
      if (first.state.toUpperCase() !== 'OPEN') return unverified('target_not_open', target);
      if (first.base_repository.toLowerCase() !== baseline.base_repository.toLowerCase()
        || first.base_ref !== baseline.base_ref) return unverified('pr_base_retargeted', target);
      if (first.head_repository.toLowerCase() !== baseline.head_repository.toLowerCase()
        || first.head_ref !== baseline.head_ref) return unverified('pr_head_rereferenced', target);
      if (!/^[a-f0-9]{40}$/u.test(first.head_oid)) return unverified('pr_head_unreadable', target);
      if (first.head_oid === baseline.head_sha) return unverified('pr_head_unchanged', target);
      return { class: 'target_progress_observed', attribution: 'unverified', evidence: 'pr_head_advanced_stable', target };
    }
    if (!baseline.state) return unverified('baseline_tuple_incomplete', target);
    if (!baselineOpen) return unverified('baseline_target_not_open', target);
    const first = await readers.issueTuple(baseline.repo, baseline.number);
    const second = first ? await readers.issueTuple(baseline.repo, baseline.number) : undefined;
    if (!first || !second) return unverified('issue_body_unreadable', target);
    if (!sameTuple(first, second)) return unverified('issue_not_stable', target);
    if (first.repository.toLowerCase() !== repo || first.number !== baseline.number) {
      return unverified('target_identity_changed', target);
    }
    if (first.state.toUpperCase() !== 'OPEN') return unverified('target_not_open', target);
    if (!/^[a-f0-9]{64}$/u.test(first.body_sha256)) return unverified('issue_body_unreadable', target);
    if (first.body_sha256 === baseline.body_sha256) return unverified('issue_body_unchanged', target);
    return { class: 'target_progress_observed', attribution: 'unverified', evidence: 'issue_body_digest_changed', target };
  } catch {
    return unverified('github_read_failed', target);
  }
}

/** The trusted original-bound target of an exact invocation-bound baseline (never a guessed target). */
export function baselineBoundTarget(baseline: GithubEffectBaseline | undefined): BoundGithubTarget | undefined {
  return baseline ? { kind: baseline.kind, repo: baseline.repo, number: baseline.number } : undefined;
}

export interface OwnerWaitPageWitness {
  readonly state: 'page_finished' | 'page_unverified' | 'conversation_unavailable';
  readonly evidence: string;
  readonly reply_length?: number;
}

export type OwnerWaitPageReader = (input: {
  readonly record: StateLightTurnObservationRecord; readonly profileKey: string; readonly cdp: string; readonly deadlineMs: number;
}) => Promise<OwnerWaitPageWitness>;

async function defaultOwnerWaitPageReader(input: Parameters<OwnerWaitPageReader>[0]): Promise<OwnerWaitPageWitness> {
  const driver = await import('./chatgpt-browser-turn/state-light-turn-base.ts');
  return await driver.observeOriginalOwnedPageReadOnly(input);
}

export interface OwnerWaitDependencies {
  readonly launcherProbe?: ProcessWitnessProbe;
  readonly githubReaders?: GithubEffectReaders;
  readonly pageReader?: OwnerWaitPageReader;
  readonly ownerEnv?: NodeJS.ProcessEnv;
  readonly dispatchWitness?: OwnerDispatchWitness;
  readonly invokingTerminalHandle?: string;
}

type OwnerWaitOutcome =
  | { readonly effect: 'none'; readonly reason: string; readonly nextStep: string;
    readonly diagnostics?: Record<string, unknown> }
  | { readonly effect: 'published' | 'occupied_by_winner'; readonly envelope: TerminalEnvelope };

const OWNER_RECONCILE_STEP = 'reconcile the exact original invocation from its current Task+Dispatch owner: '
  + 'inspect the original Page and the exact GitHub target; never resend blindly';

/**
 * The only reaper: an owner-run wait for the original managed invocation. It never signals any
 * process and publishes one exclusive uncertainty envelope only when the caller is the currently
 * approved original Task+Dispatch owner and the original launcher is positively gone.
 */
async function ownerWaitReap(input: {
  readonly runIdentity: string; readonly attemptIdentity: string;
  readonly ownerTaskId: string; readonly ownerDispatchId: string;
  readonly handoffReceiptPath: string; readonly terminalEnvelopePath: string;
  readonly receipt: HandoffReceipt;
  readonly profile?: string; readonly cdp?: string;
  readonly deps: OwnerWaitDependencies;
}): Promise<OwnerWaitOutcome> {
  const none = (reason: string, nextStep: string, diagnostics?: Record<string, unknown>): OwnerWaitOutcome => ({
    effect: 'none', reason, nextStep, ...(diagnostics ? { diagnostics } : {}),
  });
  const { receipt } = input;
  if (!receipt.owner_task_id?.trim() || !receipt.owner_dispatch_id?.trim() || !receipt.invocation_id?.trim()) {
    return none('original_receipt_not_managed', OWNER_RECONCILE_STEP);
  }
  const authorityInput: OwnerAuthorityInput = {
    taskId: input.ownerTaskId, dispatchId: input.ownerDispatchId,
    ...(receipt.launching_terminal_handle ? { originalTerminalHandle: receipt.launching_terminal_handle } : {}),
    ...(input.deps.ownerEnv ? { env: input.deps.ownerEnv } : {}),
    ...(input.deps.dispatchWitness ? { dispatchWitness: input.deps.dispatchWitness } : {}),
    ...(input.deps.invokingTerminalHandle ? { invokingTerminalHandle: input.deps.invokingTerminalHandle } : {}),
  };
  const notOwner = (evidence: string) => none(`owner_not_current:${evidence}`,
    'run this wait from the original Task+Dispatch worker terminal while that Dispatch is current and live (worker-show / current assignment), or reconcile the exact invocation on GitHub');
  const owner = await verifyCurrentInvokingOwner(authorityInput);
  if (!owner.ok) return notOwner(owner.evidence);
  const launcher = observeOriginalLauncher(receipt, input.deps.launcherProbe);
  if (launcher.state !== 'dead') {
    return none(`launcher_${launcher.state}:${launcher.evidence}`, launcher.state === 'alive'
      ? 'the original launcher is still live and owns its watchdog/child signal: wait again, or stop it through its exact-owner native supervisor; this wait never signals a PID'
      : 'original launcher death is unproven: reconcile through the exact-owner native supervisor and the original Page/GitHub target; no signal, no publication');
  }
  const existing = readTerminalEnvelope(input.terminalEnvelopePath, {
    runIdentity: input.runIdentity, attemptIdentity: input.attemptIdentity,
  });
  // A terminal committed after the poll loop is the original authority: report it, never replace it.
  if (existing) return { effect: 'occupied_by_winner', envelope: existing };
  const invocationId = receipt.invocation_id;
  let record: StateLightTurnObservationRecord | undefined;
  let page: OwnerWaitPageWitness = { state: 'page_unverified', evidence: 'profile_cdp_not_supplied' };
  if (input.profile && input.cdp) {
    const profileKey = configuredProfileKey(input.profile, input.cdp);
    try {
      record = readStateLightTurnObservation(profileKey, invocationId);
    } catch {
      record = undefined;
    }
    if (!record || record.invocation_id !== invocationId) {
      page = { state: 'page_unverified', evidence: 'original_observation_missing_or_foreign' };
    } else {
      try {
        page = await (input.deps.pageReader ?? defaultOwnerWaitPageReader)({
          record, profileKey, cdp: input.cdp, deadlineMs: Date.now() + 30_000,
        });
      } catch {
        page = { state: 'page_unverified', evidence: 'original_page_unreachable' };
      }
    }
  }
  const freshReceipt = readHandoffReceipt(input.handoffReceiptPath, {
    runIdentity: input.runIdentity, attemptIdentity: input.attemptIdentity,
  });
  if (!sameHandoffIdentity(freshReceipt, receipt)) return none('receipt_identity_changed', OWNER_RECONCILE_STEP);
  const baseline = parseGithubEffectBaseline(freshReceipt!.github_effect_baseline, {
    invocationId, runIdentity: input.runIdentity, attemptIdentity: input.attemptIdentity,
  });
  let readers = input.deps.githubReaders;
  if (!readers && baseline) {
    try { readers = await defaultGithubEffectReaders(); } catch { readers = undefined; }
  }
  const github = readers ? await classifyGithubEffect(baseline, readers)
    : { class: 'effect_unverified' as const, attribution: 'unverified' as const, evidence: baseline ? 'github_reader_unavailable' : 'baseline_absent' };
  // Harvest is the only stronger delivery witness; a dead launcher never proves not-sent.
  let delivery: DeliveryState = 'POSSIBLY_DELIVERED';
  if (record && record.phase === 'harvested' && record.send_count === 1 && record.primary) {
    try {
      const bytes = readFileSync(record.primary.target);
      if (bytes.byteLength === record.primary.byte_length
        && createHash('sha256').update(bytes).digest('hex') === record.primary.sha256) delivery = 'landed';
    } catch { /* unreadable primary stays possible delivery */ }
  }
  const envelope: TerminalEnvelope = {
    schema: TERMINAL_SCHEMA,
    run_identity: input.runIdentity,
    attempt_identity: input.attemptIdentity,
    completion_mode: COMPLETION_MODE,
    handoff_receipt_path: input.handoffReceiptPath,
    launcher_started_at: receipt.launcher_started_at,
    handoff_committed_at: receipt.handoff_committed_at,
    terminal_at: nowIso(),
    lifecycle_outcome: 'incident',
    incident: 'launcher_lost_owner_wait_uncertain',
    delivery,
    observed_invocation_id: invocationId,
    recovery_available: false,
    // Read-first: the exact baseline-bound target, then the original reconciliation; a redirect is
    // never a fresh-chat recommendation and never disproves an earlier Send.
    next_action: (page.state === 'conversation_unavailable'
      ? 'conversation unavailable (redirect; any earlier Send remains possibly delivered, no resend authority). ' : '')
      + boundTargetReadFirstNextAction(baselineBoundTarget(baseline)),
    ...(record ? turnTargetEnvelopeFields(undefined, record) : {}),
    ...(record?.send_count !== undefined ? { send_count: record.send_count } : {}),
    ...(typeof receipt.child_cwd === 'string' ? { cwd: receipt.child_cwd } : {}),
    ...(receipt.launching_terminal_handle ? { terminal_handle: receipt.launching_terminal_handle } : {}),
    diagnostics: boundedDiagnostics({
      owner_wait: { owner: owner.evidence, launcher: launcher.evidence },
      page,
      github_effect: github,
    }),
  };
  // Owner authority is re-proven after the awaited Page/GitHub reads, and the exclusive create runs
  // inside the assignment fence: a Dispatch replaced meanwhile publishes nothing.
  let fenced: Awaited<ReturnType<typeof withVerifiedOwnerEffect<'created'>>>;
  try {
    fenced = await withVerifiedOwnerEffect(authorityInput, () => {
      atomicCreateJson(input.terminalEnvelopePath, envelope as unknown as Record<string, unknown>, 'envelope');
      return 'created' as const;
    });
  } catch {
    fenced = { ok: false, evidence: 'terminal_create_failed', actionEntered: true };
  }
  if (fenced.ok) return { effect: 'published', envelope };
  if (!fenced.actionEntered) return notOwner(fenced.evidence);
  const winner = readTerminalEnvelope(input.terminalEnvelopePath, {
    runIdentity: input.runIdentity, attemptIdentity: input.attemptIdentity,
  });
  if (winner && winner.launcher_started_at === receipt.launcher_started_at
    && winner.handoff_committed_at === receipt.handoff_committed_at
    && (winner.observed_invocation_id === undefined || winner.observed_invocation_id === invocationId)) {
    return { effect: 'occupied_by_winner', envelope: winner };
  }
  return none('terminal_publication_uncertain', 'an unreadable or foreign terminal occupies the original path: reconcile the exact invocation manually; never republish');
}

/** Explicit owner-wait paths may reach the reaper only when the original keyed locator names exactly them. */
function explicitPathsBoundToLocator(
  options: { readonly invocationId?: string; readonly runIdentity: string; readonly attemptIdentity: string;
    readonly ownerTaskId?: string; readonly ownerDispatchId?: string; readonly terminalEnvelopeRoot?: string },
  handoffReceiptPath: string, terminalEnvelopePath: string,
): boolean {
  if (!options.invocationId) return false;
  try {
    const bound = readInvocationReceiptLocator({
      invocationId: options.invocationId, runIdentity: options.runIdentity, attemptIdentity: options.attemptIdentity,
      ...(options.ownerTaskId ? { ownerTaskId: options.ownerTaskId } : {}),
      ...(options.ownerDispatchId ? { ownerDispatchId: options.ownerDispatchId } : {}),
      ...(options.terminalEnvelopeRoot ? { terminalEnvelopeRoot: options.terminalEnvelopeRoot } : {}),
    });
    return resolve(bound.locator.handoff_receipt_path) === resolve(handoffReceiptPath)
      && resolve(bound.locator.terminal_envelope_path) === resolve(terminalEnvelopePath);
  } catch {
    return false;
  }
}

export async function runWait(options: {
  readonly runIdentity: string;
  readonly attemptIdentity: string;
  readonly terminalEnvelopePath?: string;
  readonly handoffReceiptPath?: string;
  readonly invocationId?: string;
  readonly receiptLocator?: string;
  readonly ownerTaskId?: string;
  readonly ownerDispatchId?: string;
  readonly terminalEnvelopeRoot?: string;
  readonly deadlineMs: number;
  /** Read-only original Page reattachment inputs for an authenticated managed owner wait. */
  readonly profile?: string;
  readonly cdp?: string;
  readonly ownerWaitDependencies?: OwnerWaitDependencies;
}): Promise<void> {
  const taskBound = options.ownerTaskId !== undefined || options.ownerDispatchId !== undefined;
  // Task-only correlation stays a legal diagnostic wait; only the full pair can reach the reaper.
  if (taskBound && (!options.ownerTaskId?.trim()
    || (options.ownerDispatchId !== undefined && !options.ownerDispatchId.trim()))) {
    throw new Error('wait_owner_identity_required');
  }
  const explicit = options.terminalEnvelopePath !== undefined || options.handoffReceiptPath !== undefined;
  // With Task-bound explicit paths, the existing invocation ID names the
  // expected receipt invocation rather than selecting an index.
  if (explicit && options.invocationId !== undefined && !taskBound) {
    throw new Error('wait_locator_and_explicit_paths_conflict');
  }
  const indexed = options.receiptLocator !== undefined || (options.invocationId !== undefined && !explicit);
  if (indexed && explicit) throw new Error('wait_locator_and_explicit_paths_conflict');
  if (taskBound && !options.invocationId?.trim()) {
    throw new Error('wait_invocation_identity_required');
  }
  const bound = indexed ? readInvocationReceiptLocator({
    ...(options.invocationId !== undefined ? { invocationId: options.invocationId } : {}),
    ...(options.receiptLocator !== undefined ? { receiptLocator: options.receiptLocator } : {}),
    runIdentity: options.runIdentity,
    attemptIdentity: options.attemptIdentity,
    ...(taskBound ? { ownerTaskId: options.ownerTaskId, ownerDispatchId: options.ownerDispatchId } : {}),
    ...(options.terminalEnvelopeRoot ? { terminalEnvelopeRoot: options.terminalEnvelopeRoot } : {}),
  }) : null;
  const terminalEnvelopePath = bound?.locator.terminal_envelope_path
    ?? (options.terminalEnvelopePath === undefined ? undefined
      : options.terminalEnvelopeRoot ? resolve(options.terminalEnvelopePath)
        : resolveDurableArtifactPath(options.terminalEnvelopePath));
  const handoffReceiptPath = bound?.locator.handoff_receipt_path
    ?? (options.handoffReceiptPath === undefined ? undefined
      : options.terminalEnvelopeRoot ? resolve(options.handoffReceiptPath)
        : resolveDurableArtifactPath(options.handoffReceiptPath));
  if (!terminalEnvelopePath || !handoffReceiptPath) throw new Error('wait_paths_or_locator_required');
  // Task-bound waits bind the original receipt before exposing any result.
  const initialReceipt = taskBound
    ? (bound?.receipt ?? readHandoffReceipt(handoffReceiptPath, {
      runIdentity: options.runIdentity, attemptIdentity: options.attemptIdentity,
    }))
    : null;
  if (taskBound && (!initialReceipt
    || initialReceipt.owner_task_id !== options.ownerTaskId
    || (options.ownerDispatchId !== undefined && initialReceipt.owner_dispatch_id !== options.ownerDispatchId)
    || !initialReceipt.invocation_id?.trim()
    || (!indexed && initialReceipt.invocation_id !== options.invocationId)
    || initialReceipt.completion_mode !== COMPLETION_MODE)) {
    throw new Error('wait_receipt_owner_mismatch');
  }
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
      ...(taskBound ? { ownerTaskId: options.ownerTaskId, ownerDispatchId: options.ownerDispatchId } : {}),
      ...(options.terminalEnvelopeRoot ? { terminalEnvelopeRoot: options.terminalEnvelopeRoot } : {}),
    });
    if (reread.locator.handoff_receipt_path !== handoffReceiptPath
      || reread.locator.terminal_envelope_path !== terminalEnvelopePath
      || !handoff || !sameHandoffIdentity(reread.receipt, handoff)) {
      throw new Error('wait_locator_identity_changed');
    }
  }
  // Relative terminal receipt names are historical; the committed launch
  // identity, not today's cwd, must still match the selected receipt.
  const terminalHandoffMatches = !envelope || (
    (isAbsolute(envelope.handoff_receipt_path)
      ? resolve(envelope.handoff_receipt_path) === resolve(handoffReceiptPath)
      : basename(normalize(envelope.handoff_receipt_path)) === basename(handoffReceiptPath))
    && envelope.launcher_started_at === handoff?.launcher_started_at
    && envelope.handoff_committed_at === handoff?.handoff_committed_at
  );
  // The legacy explicit unbound wait is diagnostic even if its receipt is
  // absent. Indexed and Task-bound waits still require exact launch identity.
  if ((indexed || taskBound) && !terminalHandoffMatches) {
    throw new Error(indexed ? 'wait_locator_identity_changed' : 'wait_receipt_identity_changed');
  }
  if (taskBound && (!handoff || !sameHandoffIdentity(initialReceipt, handoff)
    || handoff.owner_task_id !== options.ownerTaskId
    || (options.ownerDispatchId !== undefined && handoff.owner_dispatch_id !== options.ownerDispatchId)
    || (!indexed && handoff.invocation_id !== options.invocationId)
    || (envelope?.observed_invocation_id !== undefined
      && envelope.observed_invocation_id !== handoff.invocation_id)
    || !terminalHandoffMatches)) {
    throw new Error('wait_receipt_identity_changed');
  }
  // Only a Task-bound wait over a managed original receipt can ever reach the reaper; legacy,
  // direct and unbound waits stay diagnostic-only.
  let ownerWait: OwnerWaitOutcome | undefined;
  if (!envelope && taskBound && handoff && initialReceipt && options.ownerDispatchId === undefined) {
    ownerWait = {
      effect: 'none', reason: 'owner_dispatch_required',
      nextStep: 'rerun this wait with both the original --owner-task-id and --owner-dispatch-id; a Task-only wait is diagnostic-only',
    };
  } else if (!envelope && taskBound && handoff && initialReceipt && !indexed
    && !explicitPathsBoundToLocator(options, handoffReceiptPath, terminalEnvelopePath)) {
    ownerWait = {
      effect: 'none', reason: 'explicit_paths_not_bound_to_locator',
      nextStep: 'rerun the owner wait by --invocation-id (indexed original locator); explicit paths whose original locator does not bind the same receipt and terminal stay diagnostic-only',
    };
  } else if (!envelope && taskBound && handoff && initialReceipt) {
    ownerWait = await ownerWaitReap({
      runIdentity: options.runIdentity, attemptIdentity: options.attemptIdentity,
      ownerTaskId: options.ownerTaskId!, ownerDispatchId: options.ownerDispatchId!,
      handoffReceiptPath, terminalEnvelopePath, receipt: initialReceipt,
      ...(options.profile ? { profile: options.profile } : {}),
      ...(options.cdp ? { cdp: options.cdp } : {}),
      deps: options.ownerWaitDependencies ?? {},
    });
    if (ownerWait.effect !== 'none') envelope = ownerWait.envelope;
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
    ...(ownerWait ? {
      owner_wait: ownerWait.effect === 'none'
        ? { effect: 'none', reason: ownerWait.reason, nextStep: ownerWait.nextStep, no_signal_sent: true }
        : { effect: ownerWait.effect, no_signal_sent: true },
    } : {}),
  }) + '\n');
}

/** The launcher's own `launch` argv parser, shared by the adapter's in-process pre-spawn validation. */
export function launchConfigFromArgv(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): LaunchConfig {
  const parsed = parseCli(argv);
  const options = parsed.options;
  if (options.has('completion-mode') || options.has('authority') || options.has('result-protocol')) {
    throw new Error('forbidden_authority_selector');
  }
  // Only synthetic native CLI fixtures may override the fleet wake root. Either signal alone is inert.
  const fixtureRoot = env.OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT;
  const useFixtureRoot = env.OPK_FM_LONG_CHILD_TEST_GATE === 'fixture-root-v1'
    && typeof fixtureRoot === 'string' && isAbsolute(fixtureRoot);
  return {
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
}

async function launchFromCli(argv: readonly string[]): Promise<number> {
  let config: LaunchConfig;
  try {
    config = launchConfigFromArgv(argv);
  } catch (error) {
    refuse(error instanceof Error && error.message === 'forbidden_authority_selector'
      ? 'forbidden_authority_selector' : 'launch_arguments_invalid', {
      message: error instanceof Error ? error.message : String(error),
    });
    return 2;
  }
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
      ...(options.has('owner-task-id') ? { ownerTaskId: requiredOption(options, 'owner-task-id') } : {}),
      ...(options.has('owner-dispatch-id') ? { ownerDispatchId: requiredOption(options, 'owner-dispatch-id') } : {}),
      ...(options.has('profile') ? { profile: requiredOption(options, 'profile') } : {}),
      ...(options.has('cdp') ? { cdp: requiredOption(options, 'cdp') } : {}),
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