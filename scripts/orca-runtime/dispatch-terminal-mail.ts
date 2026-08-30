import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { runOrcaJson, type OrcaJsonResponse } from './native.ts';
import { resolveDispatchTerminalMailLedgerPath } from '../pr2-foundation/wake-supervisor-state-root.ts';

export const TERMINAL_WORKER_STATES = new Set(['failed', 'succeeded', 'stopped', 'abandoned']);
export const TERMINAL_DISPATCH_STATES = new Set(['completed', 'failed', 'circuit_broken']);
export const DISPATCH_TERMINAL_MAIL_TYPE = 'dispatch_terminal' as const;

export interface DispatchTerminalSnapshot {
  readonly dispatchId: string;
  readonly runId: string;
  readonly state: string;
  readonly stage: string;
  readonly lastError: string | null;
  readonly dispatchStatus: string;
  readonly observationStatus: string;
}

export interface DispatchTerminalMailLedger {
  readonly notified: Record<string, string>;
}

export interface DispatchTerminalMailSendResult {
  readonly dispatchId: string;
  readonly outcome: 'sent' | 'duplicate' | 'skipped' | 'failed';
  readonly reason?: string;
  readonly messageId?: string;
}

export interface DispatchTerminalMailPulseResult {
  readonly examined: number;
  readonly sent: number;
  readonly duplicate: number;
  readonly skipped: number;
  readonly failed: number;
  readonly results: readonly DispatchTerminalMailSendResult[];
}

export interface DispatchTerminalMailDeps {
  readonly ledgerPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runJson?: typeof runOrcaJson;
  readonly nowMs?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = text(value);
  return trimmed || null;
}

export function terminalFingerprint(snapshot: DispatchTerminalSnapshot): string {
  return [
    snapshot.dispatchId,
    snapshot.state,
    snapshot.stage,
    snapshot.dispatchStatus,
    snapshot.observationStatus,
    snapshot.lastError ?? '',
  ].join('\u0000');
}

export function isTerminalDispatchSnapshot(snapshot: DispatchTerminalSnapshot): boolean {
  if (snapshot.observationStatus === 'exited') return true;
  if (TERMINAL_WORKER_STATES.has(snapshot.state)) return true;
  if (TERMINAL_DISPATCH_STATES.has(snapshot.dispatchStatus)) return true;
  return false;
}

export function snapshotFromWorkerShow(
  dispatchId: string,
  shown: unknown,
): DispatchTerminalSnapshot | null {
  if (!isRecord(shown)) return null;
  const dispatch = isRecord(shown.dispatch) ? shown.dispatch : null;
  const worker = isRecord(shown.worker) ? shown.worker : null;
  const observation = isRecord(shown.observation) ? shown.observation : null;
  const runId = text(dispatch?.run_id ?? dispatch?.runId);
  const resolvedDispatchId = text(dispatch?.id) || dispatchId.trim();
  if (!resolvedDispatchId || !runId) return null;
  return {
    dispatchId: resolvedDispatchId,
    runId,
    state: text(worker?.state).toLowerCase(),
    stage: text(worker?.stage).toLowerCase(),
    lastError: nullableText(worker?.last_error ?? worker?.lastError),
    dispatchStatus: text(dispatch?.status).toLowerCase(),
    observationStatus: text(observation?.status).toLowerCase(),
  };
}

function readLedger(file: string): DispatchTerminalMailLedger {
  if (!existsSync(file)) return { notified: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.notified)) return { notified: {} };
    const notified: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.notified)) {
      if (typeof value === 'string' && value.trim()) notified[key] = value.trim();
    }
    return { notified };
  } catch {
    return { notified: {} };
  }
}

function writeLedgerAtomic(file: string, ledger: DispatchTerminalMailLedger): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

function buildPayload(snapshot: DispatchTerminalSnapshot): string {
  return JSON.stringify({
    dispatch_id: snapshot.dispatchId,
    state: snapshot.state,
    stage: snapshot.stage,
    last_error: snapshot.lastError,
  });
}

function extractMessageId(response: OrcaJsonResponse): string {
  const result = response.result;
  if (!isRecord(result)) return '';
  return text(result.message_id ?? result.messageId ?? result.id);
}

export function maybeNotifyRunOnTerminalDispatch(
  snapshot: DispatchTerminalSnapshot,
  deps: DispatchTerminalMailDeps = {},
): DispatchTerminalMailSendResult {
  const dispatchId = snapshot.dispatchId.trim();
  if (!dispatchId || !snapshot.runId.trim()) {
    return { dispatchId, outcome: 'skipped', reason: 'binding_incomplete' };
  }
  if (!isTerminalDispatchSnapshot(snapshot)) {
    return { dispatchId, outcome: 'skipped', reason: 'not_terminal' };
  }

  const ledgerPath = deps.ledgerPath ?? resolveDispatchTerminalMailLedgerPath({ env: deps.env });
  const fingerprint = terminalFingerprint(snapshot);
  const ledger = readLedger(ledgerPath);
  const prior = ledger.notified[dispatchId];
  if (prior === fingerprint) {
    return { dispatchId, outcome: 'duplicate', reason: 'terminal_already_notified' };
  }

  const runJson = deps.runJson ?? runOrcaJson;
  const response = runJson<{ message_id?: string; messageId?: string; id?: string }>([
    'orchestration', 'send',
    '--run', snapshot.runId,
    '--type', DISPATCH_TERMINAL_MAIL_TYPE,
    '--subject', `Worker dispatch terminal: ${snapshot.state || snapshot.dispatchStatus || 'inactive'}`,
    '--body', 'A supervised worker Dispatch reached a terminal lifecycle state.',
    '--dispatch-id', dispatchId,
    '--payload', buildPayload(snapshot),
    '--json',
  ], { env: deps.env, inheritParentEnv: true, allowEmptyStdout: false });

  if (!response.ok) {
    return {
      dispatchId,
      outcome: 'failed',
      reason: text(response.error?.code) || text(response.error?.message) || 'send_failed',
    };
  }

  const messageId = extractMessageId(response);
  writeLedgerAtomic(ledgerPath, {
    notified: {
      ...ledger.notified,
      [dispatchId]: fingerprint,
    },
  });
  return {
    dispatchId,
    outcome: 'sent',
    ...(messageId ? { messageId } : {}),
  };
}

export function observeWorkerShowTerminalMail(
  dispatchId: string,
  deps: DispatchTerminalMailDeps = {},
): DispatchTerminalMailSendResult {
  const bindingKey = dispatchId.trim();
  if (!bindingKey) return { dispatchId: '', outcome: 'skipped', reason: 'dispatch_id_missing' };
  const runJson = deps.runJson ?? runOrcaJson;
  const shown = runJson(['orchestration', 'worker-show', '--dispatch', bindingKey], {
    env: deps.env,
    inheritParentEnv: true,
    allowEmptyStdout: false,
  });
  if (!shown.ok) {
    return {
      dispatchId: bindingKey,
      outcome: 'failed',
      reason: text(shown.error?.code) || text(shown.error?.message) || 'worker_show_failed',
    };
  }
  const snapshot = snapshotFromWorkerShow(bindingKey, shown.result);
  if (!snapshot) {
    return { dispatchId: bindingKey, outcome: 'skipped', reason: 'worker_show_binding_incomplete' };
  }
  return maybeNotifyRunOnTerminalDispatch(snapshot, deps);
}

export function runDispatchTerminalMailPulse(input: {
  readonly dispatchIds: readonly string[];
  readonly deps?: DispatchTerminalMailDeps;
}): DispatchTerminalMailPulseResult {
  const deps = input.deps ?? {};
  const results: DispatchTerminalMailSendResult[] = [];
  let sent = 0;
  let duplicate = 0;
  let skipped = 0;
  let failed = 0;
  for (const dispatchId of input.dispatchIds) {
    const result = observeWorkerShowTerminalMail(dispatchId, deps);
    results.push(result);
    switch (result.outcome) {
      case 'sent': sent += 1; break;
      case 'duplicate': duplicate += 1; break;
      case 'skipped': skipped += 1; break;
      case 'failed': failed += 1; break;
      default: break;
    }
  }
  return {
    examined: input.dispatchIds.length,
    sent,
    duplicate,
    skipped,
    failed,
    results,
  };
}
