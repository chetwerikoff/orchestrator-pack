#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
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
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, basename, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TurnResultV1 } from './chatgpt-browser-turn/contracts.ts';

export const COMPLETION_MODE = 'browser-turn-result-v1' as const;
export const HANDOFF_SCHEMA = 'flow-manager-long-running-child-handoff/v1' as const;
export const TERMINAL_SCHEMA = 'flow-manager-long-running-child-terminal/v1' as const;
export const WAIT_SCHEMA = 'flow-manager-long-running-child-wait/v1' as const;
export const REFUSAL_SCHEMA = 'flow-manager-long-running-child-refusal/v1' as const;

export type DeliveryState = 'not-sent' | 'POSSIBLY_DELIVERED' | 'landed';

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

const DEFAULT_CANDIDATE_GRACE_MS = 5_000;
const DEFAULT_NO_CANDIDATE_GRACE_MS = 5_000;
const DIAGNOSTICS_BYTE_CAP = 4_096;

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

function atomicCreateJson(path: string, body: Record<string, unknown>, kind: 'receipt' | 'envelope'): void {
  ensureParentWritable(path);
  if (kind === 'receipt' && process.env.OPK_FM_LONG_CHILD_FORCE_RECEIPT_CREATE_FAIL === '1') {
    throw new Error('forced_receipt_create_failure');
  }
  if (kind === 'envelope' && process.env.OPK_FM_LONG_CHILD_FORCE_ENVELOPE_CREATE_FAIL === '1') {
    throw new Error('forced_envelope_create_failure');
  }
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  const handle = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    writeSync(handle, bytes);
    try {
      fchmodSync(handle, 0o600);
    } catch {
      // unsupported on some platforms
    }
  } finally {
    closeSync(handle);
  }
}

function refuse(reason: string, details?: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ schema: REFUSAL_SCHEMA, reason, ...(details ?? {}) })}\n`);
  process.exitCode = 2;
}

function parseTurnResult(line: string): TurnResultV1 | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    if (body.schema !== 'turn-result/v1') return null;
    if (typeof body.state !== 'string' || typeof body.cause !== 'string') return null;
    if (typeof body.invocation_id !== 'string' || typeof body.configured_profile_key !== 'string') return null;
    if (typeof body.scope !== 'string') return null;
    return body as TurnResultV1;
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

export function deriveDelivery(result: TurnResultV1 | null, childStartFailed: boolean): DeliveryState {
  if (childStartFailed) return 'not-sent';
  if (!result) return 'not-sent';
  if (result.state === 'output_conflict') {
    return (result.observation_uncertainty_diagnostics?.send_count ?? 0) === 0 ? 'not-sent' : 'POSSIBLY_DELIVERED';
  }
  const sendCount = result.observation_uncertainty_diagnostics?.send_count;
  if (sendCount === 0) return 'not-sent';
  if (result.witness?.relation === 'reply_to' && (result.conversation_id || result.observation_uncertainty_diagnostics?.owned_prompt_seen)) {
    return 'landed';
  }
  if (sendCount === 1 || (sendCount !== undefined && sendCount > 0)) return 'POSSIBLY_DELIVERED';
  if (result.state === 'ok') return 'POSSIBLY_DELIVERED';
  return 'not-sent';
}

function boundedDiagnostics(input: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(input);
  if (json.length <= DIAGNOSTICS_BYTE_CAP) return input;
  return { truncated: true, byte_length: json.length };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForChildExit(child: ChildProcess, graceMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), graceMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

async function waitForStdoutEof(stream: NodeJS.ReadableStream | null | undefined, graceMs: number): Promise<boolean> {
  if (!stream) return true;
  if (stream.readableEnded) return true;
  return await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), graceMs);
    const finish = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    stream.once('end', finish);
    stream.once('close', finish);
  });
}

function killChildTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
    else process.kill(pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

export interface LaunchConfig {
  readonly runIdentity: string;
  readonly attemptIdentity: string;
  readonly handoffReceiptPath: string;
  readonly terminalEnvelopePath: string;
  readonly browserOutputPath: string;
  readonly cwd: string;
  readonly childCommand: string;
  readonly childArgs: readonly string[];
  readonly conversationLocator?: string;
  readonly secretCanaries?: readonly string[];
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

async function finalizeCandidatePath(
  config: LaunchConfig,
  receipt: HandoffReceipt,
  launcherStartedAt: string,
  candidate: TurnResultV1,
  duplicateCandidate: boolean,
  child: ChildProcess,
  childExitCode: number | null,
  heartbeatDiagnostics: Record<string, unknown> | undefined,
): Promise<number> {
  const grace = candidateGraceMs();
  const exited = await waitForChildExit(child, grace);
  const eof = await waitForStdoutEof(child.stdout, grace);
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
    send_count: candidate.observation_uncertainty_diagnostics?.send_count,
    recovery_available: Boolean(config.conversationLocator || candidate.conversation_id),
    ...(config.conversationLocator ? { conversation_locator: config.conversationLocator } : {}),
  });
  if (duplicateCandidate) {
    await publishEnvelope(config, incidentEnvelope('child_terminal_result_duplicate'));
    killChildTree(child);
    await delay(100);
    return 1;
  }
  if (!exited || !eof) {
    await publishEnvelope(config, incidentEnvelope('child_post_result_exit_timeout'));
    killChildTree(child);
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
      send_count: candidate.observation_uncertainty_diagnostics?.send_count,
      recovery_available: Boolean(config.conversationLocator || candidate.conversation_id),
      ...(config.conversationLocator ? { conversation_locator: config.conversationLocator } : {}),
      ...(candidate.conversation_id ? { conversation_locator: candidate.conversation_id } : {}),
      ...(heartbeatDiagnostics ? { diagnostics: heartbeatDiagnostics } : {}),
    });
    killChildTree(child);
    return 0;
  }
  await publishEnvelope(config, incidentEnvelope(`child_turn_state:${candidate.state}`));
  killChildTree(child);
  return 1;
}

export async function runLaunch(config: LaunchConfig): Promise<number> {
  const canaries = config.secretCanaries ?? [];
  if (!existsSync(config.cwd) || !statSync(config.cwd).isDirectory()) {
    refuse('invalid_cwd', { cwd: config.cwd });
    return 2;
  }
  for (const path of [config.handoffReceiptPath, config.terminalEnvelopePath]) {
    if (existsSync(path) && statSync(path).size > 0) {
      refuse('occupied_launcher_owned_path', { path });
      return 2;
    }
  }
  try {
    assertPairwiseDistinct([config.handoffReceiptPath, config.terminalEnvelopePath, config.browserOutputPath]);
    ensureParentWritable(config.handoffReceiptPath);
    ensureParentWritable(config.terminalEnvelopePath);
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

  let child: ChildProcess | undefined;
  try {
    child = spawn(config.childCommand, [...config.childArgs], {
      cwd: config.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    });
  } catch {
    child = undefined;
  }

  if (!child?.pid) {
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
      delivery: 'not-sent',
      recovery_available: Boolean(config.conversationLocator),
      ...(config.conversationLocator ? { conversation_locator: config.conversationLocator } : {}),
    });
    return 1;
  }

  let stdoutBuffer = '';
  let firstCandidate: TurnResultV1 | null = null;
  let duplicateCandidate = false;
  let lastHeartbeatDiagnostics: Record<string, unknown> | undefined;
  let childExitCode: number | null = null;
  let childExitedBeforeCandidate = false;
  const stdout = child.stdout;

  const ingestStdoutLine = (line: string): void => {
    const heartbeat = parseHeartbeat(line);
    if (heartbeat) {
      lastHeartbeatDiagnostics = boundedDiagnostics(heartbeat);
      return;
    }
    const candidate = parseTurnResult(line);
    if (!candidate) return;
    if (!firstCandidate) firstCandidate = candidate;
    else duplicateCandidate = true;
  };

  const drainStdoutBuffer = (): void => {
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf('\n');
      ingestStdoutLine(line);
    }
  };

  stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    drainStdoutBuffer();
  });

  child.once('exit', (code) => {
    childExitCode = code;
    drainStdoutBuffer();
    if (!firstCandidate) childExitedBeforeCandidate = true;
  });

  const deadline = Date.now() + noCandidateGraceMs() + candidateGraceMs();
  while (!firstCandidate && !childExitedBeforeCandidate && Date.now() < deadline) {
    await delay(20);
  }

  if (stdoutBuffer.trim() && !firstCandidate) {
    const trailing = parseTurnResult(stdoutBuffer);
    if (trailing) firstCandidate = trailing;
  }

  if (firstCandidate) {
    return await finalizeCandidatePath(
      config, receipt, launcherStartedAt, firstCandidate, duplicateCandidate, child, childExitCode, lastHeartbeatDiagnostics,
    );
  }

  if (childExitedBeforeCandidate || childExitCode !== null) {
    const grace = noCandidateGraceMs();
    const eof = await waitForStdoutEof(stdout, grace);
    const incident = eof ? 'child_terminal_result_missing' : 'child_stdout_eof_timeout';
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
      delivery: 'not-sent',
      child_exit_code: childExitCode,
      recovery_available: Boolean(config.conversationLocator),
      ...(config.conversationLocator ? { conversation_locator: config.conversationLocator } : {}),
    });
    killChildTree(child);
    return 1;
  }

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
    delivery: 'not-sent',
    child_exit_code: childExitCode,
    recovery_available: Boolean(config.conversationLocator),
    ...(config.conversationLocator ? { conversation_locator: config.conversationLocator } : {}),
  });
  killChildTree(child);
  return 1;
}

export function readTerminalEnvelope(path: string): TerminalEnvelope | null {
  if (!existsSync(path)) return null;
  try {
    const body = JSON.parse(readFileSync(path, 'utf8')) as TerminalEnvelope;
    if (body.schema !== TERMINAL_SCHEMA) return null;
    return body;
  } catch {
    return null;
  }
}

export function readHandoffReceipt(path: string): HandoffReceipt | null {
  if (!existsSync(path)) return null;
  try {
    const body = JSON.parse(readFileSync(path, 'utf8')) as HandoffReceipt;
    if (body.schema !== HANDOFF_SCHEMA) return null;
    return body;
  } catch {
    return null;
  }
}

export async function runWait(options: {
  readonly runIdentity: string;
  readonly attemptIdentity: string;
  readonly terminalEnvelopePath: string;
  readonly handoffReceiptPath: string;
  readonly deadlineMs: number;
}): Promise<void> {
  const started = Date.now();
  let envelope: TerminalEnvelope | null = null;
  while (Date.now() - started < options.deadlineMs) {
    envelope = readTerminalEnvelope(options.terminalEnvelopePath);
    if (envelope) break;
    await delay(50);
  }
  const handoff = readHandoffReceipt(options.handoffReceiptPath);
  process.stdout.write(`${JSON.stringify({
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
  })}\n`);
}

async function launchFromCli(argv: readonly string[]): Promise<number> {
  const parsed = parseCli(argv);
  const options = parsed.options;
  if (options.has('completion-mode') || options.has('authority') || options.has('result-protocol')) {
    refuse('forbidden_authority_selector');
    return 2;
  }
  const config: LaunchConfig = {
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
      terminalEnvelopePath: requiredOption(options, 'terminal-envelope'),
      handoffReceiptPath: requiredOption(options, 'handoff-receipt'),
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
