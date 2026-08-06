#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';

export const POST_SETTLEMENT_CLOSE_SCHEMA = 'browser-gpt-post-settlement-close/v1' as const;
export const POST_SETTLEMENT_CLOSE_STATUSES = [
  'closed',
  'already_absent',
  'input_invalid',
  'settlement_untrusted',
  'harvest_untrusted',
  'target_identity_mismatch',
  'stale_harvest',
  'close_unconfirmed',
  'unavailable',
] as const;
export type PostSettlementCloseStatus = (typeof POST_SETTLEMENT_CLOSE_STATUSES)[number];

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_ID_LENGTH = 512;
const MAX_URL_LENGTH = 2_048;
const CDP_REQUEST_TIMEOUT_MS = 10_000;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const TARGET_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/u;
const ELIGIBLE_RECOVERY_CAUSES = new Set([
  'direct_publication_observation_missing',
  'direct_publication_source_invalid',
  'direct_publication_receipt_invalid',
]);

export interface PostSettlementTargetWitness {
  readonly disposition: 'preserved_after_settlement';
  readonly configured_profile_key: string;
  readonly target_id: string;
  readonly normalized_url: string;
  readonly assistant_message_id: string;
  readonly representation: 'innerText' | 'textContent';
  readonly byte_length: number;
  readonly sha256: string;
  readonly document_ordinal: number;
  readonly observed_user_nodes: number;
  readonly observed_assistant_nodes: number;
  readonly observed_message_nodes: number;
  readonly generation_in_progress: false;
  readonly nodes_truncated: false;
}

export interface ProbeExportEvidence {
  readonly schema: 'browser-gpt-page-probe/v1';
  readonly operation: 'export';
  readonly status: 'ok';
  readonly diagnostic_only: true;
  readonly workflow_authority: 'none';
  readonly configured_profile_key: string;
  readonly target_id: string;
  readonly normalized_url: string;
  readonly page_url?: string;
  readonly node: {
    readonly role: 'assistant';
    readonly ordinal: number;
    readonly document_ordinal: number;
    readonly message_id: string;
  };
  readonly assistant_message_id: string;
  readonly representation: 'innerText' | 'textContent';
  readonly byte_length: number;
  readonly sha256: string;
  readonly observed_user_nodes: number;
  readonly observed_assistant_nodes: number;
  readonly observed_message_nodes: number;
  readonly generation_in_progress: false;
  readonly nodes_truncated: false;
  readonly last_assistant: true;
  readonly last_message: true;
}

export interface PostSettlementCloseResult {
  readonly schema: typeof POST_SETTLEMENT_CLOSE_SCHEMA;
  readonly status: PostSettlementCloseStatus;
  readonly close_attempt_count: 0 | 1;
  readonly configured_profile_key: string;
  readonly target_id?: string;
  readonly normalized_url?: string;
  readonly terminal_evidence_schema: string;
  readonly resend_authority: 'none';
  readonly reason?: string;
  readonly proof?: Readonly<Record<string, unknown>>;
}

export interface CdpTarget {
  readonly id?: string;
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface ExactTargetChannel {
  readonly evaluate: (expression: string) => Promise<unknown>;
  readonly close: () => Promise<'acknowledged' | 'dispatched'>;
  readonly disconnect: () => void;
}

export interface PostSettlementCloseDependencies {
  readonly readText: (path: string) => Promise<string>;
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly listTargets: (cdp: string) => Promise<readonly CdpTarget[]>;
  readonly openExactTargetChannel: (target: Required<Pick<CdpTarget, 'id' | 'url' | 'webSocketDebuggerUrl'>>) => Promise<ExactTargetChannel>;
  readonly beforeFinalGuard?: () => Promise<void> | void;
}

export interface ParsedCloseArgs {
  readonly turnResult: string;
  readonly probeResult: string;
  readonly harvest: string;
  readonly profile: string;
  readonly cdp: string;
}

class CloseError extends Error {
  readonly status: PostSettlementCloseStatus;
  constructor(status: PostSettlementCloseStatus, message: string) {
    super(message);
    this.name = 'CloseError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown, max = MAX_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= max;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported_url');
  if (url.username || url.password) throw new Error('credentials_not_allowed');
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  const normalized = url.toString().replace(/\/$/u, '');
  if (Array.from(normalized).length > MAX_URL_LENGTH) throw new Error('url_too_long');
  return normalized;
}

function boundedReason(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return Array.from(value).slice(0, 240).join('');
}

function baseResult(
  status: PostSettlementCloseStatus,
  profileKey: string,
  evidenceSchema: string,
  witness?: Partial<PostSettlementTargetWitness>,
  closeAttemptCount: 0 | 1 = 0,
  reason?: string,
  proof?: Readonly<Record<string, unknown>>,
): PostSettlementCloseResult {
  return {
    schema: POST_SETTLEMENT_CLOSE_SCHEMA,
    status,
    close_attempt_count: closeAttemptCount,
    configured_profile_key: profileKey,
    ...(witness?.target_id ? { target_id: witness.target_id } : {}),
    ...(witness?.normalized_url ? { normalized_url: witness.normalized_url } : {}),
    terminal_evidence_schema: evidenceSchema,
    resend_authority: 'none',
    ...(reason ? { reason } : {}),
    ...(proof ? { proof } : {}),
  };
}

export function parsePostSettlementCloseArgs(argv: readonly string[]): ParsedCloseArgs {
  const accepted = new Set(['--turn-result', '--probe-result', '--harvest', '--profile', '--cdp']);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !accepted.has(key) || !value || value.startsWith('--') || values.has(key)) {
      throw new CloseError('input_invalid', 'argument_invalid');
    }
    values.set(key, value);
  }
  if (argv.length !== accepted.size * 2 || values.size !== accepted.size) {
    throw new CloseError('input_invalid', 'argument_set_invalid');
  }
  return {
    turnResult: values.get('--turn-result')!,
    probeResult: values.get('--probe-result')!,
    harvest: values.get('--harvest')!,
    profile: values.get('--profile')!,
    cdp: values.get('--cdp')!,
  };
}

async function readRegularFile(path: string): Promise<Uint8Array> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES) {
    throw new CloseError('input_invalid', 'input_file_untrusted');
  }
  return await readFile(path);
}

async function readRegularText(path: string): Promise<string> {
  return Buffer.from(await readRegularFile(path)).toString('utf8');
}

function cdpBase(cdp: string): string {
  const url = new URL(cdp);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported_cdp');
  url.hash = '';
  url.search = '';
  url.pathname = '';
  return url.toString().replace(/\/$/u, '');
}

async function defaultListTargets(cdp: string): Promise<readonly CdpTarget[]> {
  const response = await fetch(`${cdpBase(cdp)}/json/list`, {
    signal: AbortSignal.timeout(CDP_REQUEST_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`cdp_list_http_${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) throw new Error('cdp_list_not_array');
  return value as readonly CdpTarget[];
}

interface WebSocketLike {
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void, options?: { readonly once?: boolean }): void;
  send(data: string): void;
  close(): void;
}

interface WebSocketConstructorLike {
  new(url: string): WebSocketLike;
}

async function defaultOpenExactTargetChannel(
  target: Required<Pick<CdpTarget, 'id' | 'url' | 'webSocketDebuggerUrl'>>,
): Promise<ExactTargetChannel> {
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: WebSocketConstructorLike }).WebSocket;
  if (!WebSocketCtor) throw new Error('websocket_unavailable');
  const socket = new WebSocketCtor(target.webSocketDebuggerUrl);
  let commandId = 0;
  let openedResolve!: () => void;
  let openedReject!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    openedResolve = resolve;
    openedReject = reject;
  });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let closed = false;
  socket.addEventListener('open', () => openedResolve(), { once: true });
  socket.addEventListener('error', () => openedReject(new Error('cdp_websocket_error')), { once: true });
  socket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as {
        readonly id?: number;
        readonly error?: { readonly message?: string };
        readonly result?: { readonly exceptionDetails?: { readonly text?: string }; readonly result?: { readonly value?: unknown } };
      };
      if (!payload.id) return;
      const waiter = pending.get(payload.id);
      if (!waiter) return;
      pending.delete(payload.id);
      if (payload.error) waiter.reject(new Error(payload.error.message ?? 'cdp_command_error'));
      else if (payload.result?.exceptionDetails) waiter.reject(new Error(payload.result.exceptionDetails.text ?? 'cdp_expression_exception'));
      else waiter.resolve(payload.result?.result?.value ?? payload.result);
    } catch {
      // Ignore unrelated malformed events; the command timeout remains authoritative.
    }
  });
  socket.addEventListener('close', () => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(new Error('cdp_websocket_closed'));
    pending.clear();
  }, { once: true });
  await Promise.race([
    opened,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('cdp_connect_timeout')), CDP_REQUEST_TIMEOUT_MS)),
  ]);

  const command = async (method: string, params?: unknown): Promise<unknown> => {
    if (closed) throw new Error('cdp_websocket_closed');
    const id = ++commandId;
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => setTimeout(() => {
        if (pending.delete(id)) reject(new Error('cdp_command_timeout'));
      }, CDP_REQUEST_TIMEOUT_MS)),
    ]);
  };

  return {
    evaluate: async (expression) => await command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    }),
    close: async () => {
      try {
        await command('Page.close');
        return 'acknowledged';
      } catch (error) {
        if (closed || boundedReason(error) === 'cdp_websocket_closed') return 'dispatched';
        throw error;
      }
    },
    disconnect: () => {
      try { socket.close(); } catch { /* best effort */ }
    },
  };
}

export const defaultPostSettlementCloseDependencies: PostSettlementCloseDependencies = {
  readText: readRegularText,
  readBytes: readRegularFile,
  listTargets: defaultListTargets,
  openExactTargetChannel: defaultOpenExactTargetChannel,
};

function parseJson(text: string, status: PostSettlementCloseStatus, reason: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new CloseError(status, reason); }
  if (!isRecord(value)) throw new CloseError(status, reason);
  return value;
}

function validateWitness(value: unknown): PostSettlementTargetWitness {
  if (!isRecord(value)
    || value.disposition !== 'preserved_after_settlement'
    || !isBoundedString(value.configured_profile_key)
    || !isBoundedString(value.target_id, 256)
    || !TARGET_ID_RE.test(value.target_id)
    || !isBoundedString(value.normalized_url, MAX_URL_LENGTH)
    || !isBoundedString(value.assistant_message_id)
    || (value.representation !== 'innerText' && value.representation !== 'textContent')
    || !isSafeCount(value.byte_length)
    || typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)
    || !isSafeCount(value.document_ordinal)
    || !isSafeCount(value.observed_user_nodes)
    || !isSafeCount(value.observed_assistant_nodes)
    || !isSafeCount(value.observed_message_nodes)
    || value.generation_in_progress !== false
    || value.nodes_truncated !== false) {
    throw new CloseError('settlement_untrusted', 'preserved_target_witness_invalid');
  }
  if (value.observed_message_nodes !== value.observed_user_nodes + value.observed_assistant_nodes
    || value.document_ordinal !== value.observed_message_nodes - 1) {
    throw new CloseError('settlement_untrusted', 'preserved_target_tail_invalid');
  }
  return { ...value, normalized_url: normalizeUrl(value.normalized_url) } as PostSettlementTargetWitness;
}

function validateDirectResult(value: Record<string, unknown>): { witness: PostSettlementTargetWitness; schema: string } {
  if (value.schema === 'flow-manager-long-running-child-terminal/v1') {
    throw new CloseError('settlement_untrusted', 'launcher_envelope_forbidden');
  }
  if (value.schema !== 'turn-result/v1'
    || value.send_count !== 1
    || !isBoundedString(value.configured_profile_key)
    || !isRecord(value.witness)
    || !isBoundedString(value.witness.assistant_message_id)
    || value.witness.relation !== 'reply_to'
    || value.witness.source !== 'service') {
    throw new CloseError('settlement_untrusted', 'direct_result_invalid');
  }
  const eligibleOk = value.state === 'ok'
    && value.scope === 'none'
    && value.cause === 'completed_page_only';
  const eligibleRecovery = value.state === 'recovery_required'
    && value.scope === 'conversation'
    && typeof value.cause === 'string'
    && ELIGIBLE_RECOVERY_CAUSES.has(value.cause);
  if (!eligibleOk && !eligibleRecovery) throw new CloseError('settlement_untrusted', 'terminal_state_ineligible');
  const witness = validateWitness(value.post_settlement_target);
  if (witness.configured_profile_key !== value.configured_profile_key
    || witness.assistant_message_id !== value.witness.assistant_message_id) {
    throw new CloseError('settlement_untrusted', 'terminal_witness_mismatch');
  }
  return { witness, schema: value.schema };
}

function validateProbe(value: Record<string, unknown>, witness: PostSettlementTargetWitness): ProbeExportEvidence {
  if (value.schema !== 'browser-gpt-page-probe/v1'
    || value.operation !== 'export'
    || value.status !== 'ok'
    || value.diagnostic_only !== true
    || value.workflow_authority !== 'none'
    || value.configured_profile_key !== witness.configured_profile_key
    || value.target_id !== witness.target_id
    || value.normalized_url !== witness.normalized_url
    || !isRecord(value.node)
    || value.node.role !== 'assistant'
    || !isSafeCount(value.node.ordinal)
    || value.node.document_ordinal !== witness.document_ordinal
    || value.node.message_id !== witness.assistant_message_id
    || value.assistant_message_id !== witness.assistant_message_id
    || value.representation !== witness.representation
    || value.byte_length !== witness.byte_length
    || value.sha256 !== witness.sha256
    || value.observed_user_nodes !== witness.observed_user_nodes
    || value.observed_assistant_nodes !== witness.observed_assistant_nodes
    || value.observed_message_nodes !== witness.observed_message_nodes
    || value.generation_in_progress !== false
    || value.nodes_truncated !== false
    || value.last_assistant !== true
    || value.last_message !== true) {
    throw new CloseError('harvest_untrusted', 'probe_export_evidence_mismatch');
  }
  return value as unknown as ProbeExportEvidence;
}

function guardExpression(witness: PostSettlementTargetWitness, ordinal: number): string {
  const encoded = Buffer.from(JSON.stringify({ ...witness, ordinal }), 'utf8').toString('base64');
  return `(async () => {
    const expected = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'), (c) => c.charCodeAt(0))));
    const normalizeUrl = (raw) => { const url = new URL(raw); url.hash = ''; url.search = ''; url.hostname = url.hostname.toLowerCase(); url.pathname = url.pathname.replace(/\\/+$/u, '') || '/'; return url.toString().replace(/\\/$/u, ''); };
    const raw = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const counts = { user: 0, assistant: 0 };
    const nodes = [];
    for (let documentOrdinal = 0; documentOrdinal < raw.length; documentOrdinal++) {
      const node = raw[documentOrdinal];
      const role = node.getAttribute('data-message-author-role');
      if (role !== 'user' && role !== 'assistant') continue;
      nodes.push({ node, role, ordinal: counts[role]++, documentOrdinal, messageId: node.getAttribute('data-message-id') });
    }
    const idMatches = nodes.filter((entry) => entry.messageId === expected.assistant_message_id);
    if (idMatches.length !== 1) return { ok: false, reason: 'assistant_message_identity_changed' };
    const candidate = idMatches[0];
    const lastAssistant = [...nodes].reverse().find((entry) => entry.role === 'assistant');
    if (candidate.role !== 'assistant' || candidate.ordinal !== expected.ordinal || candidate.documentOrdinal !== expected.document_ordinal || candidate !== lastAssistant || candidate !== nodes[nodes.length - 1]) return { ok: false, reason: 'assistant_tail_changed' };
    let generating = 'unknown';
    try { generating = Boolean(document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="tool"][data-state="running"], [data-testid*="tool"][data-state="loading"]')); } catch { generating = 'unknown'; }
    if (generating !== false) return { ok: false, reason: 'generation_state_changed' };
    const text = expected.representation === 'innerText' ? candidate.node.innerText : candidate.node.textContent;
    if (typeof text !== 'string') return { ok: false, reason: 'representation_unavailable' };
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const currentUrl = normalizeUrl(location.href);
    return {
      ok: currentUrl === expected.normalized_url
        && bytes.byteLength === expected.byte_length
        && sha256 === expected.sha256
        && counts.user === expected.observed_user_nodes
        && counts.assistant === expected.observed_assistant_nodes
        && nodes.length === expected.observed_message_nodes,
      normalized_url: currentUrl,
      byte_length: bytes.byteLength,
      sha256,
      observed_user_nodes: counts.user,
      observed_assistant_nodes: counts.assistant,
      observed_message_nodes: nodes.length,
      generation_in_progress: generating,
      nodes_truncated: false,
      assistant_message_id: candidate.messageId,
      representation: expected.representation,
      document_ordinal: candidate.documentOrdinal,
      ordinal: candidate.ordinal,
      last_assistant: candidate === lastAssistant,
      last_message: candidate === nodes[nodes.length - 1],
    };
  })()`;
}

function guardMatches(value: unknown, witness: PostSettlementTargetWitness, ordinal: number): boolean {
  return isRecord(value)
    && value.ok === true
    && value.normalized_url === witness.normalized_url
    && value.byte_length === witness.byte_length
    && value.sha256 === witness.sha256
    && value.observed_user_nodes === witness.observed_user_nodes
    && value.observed_assistant_nodes === witness.observed_assistant_nodes
    && value.observed_message_nodes === witness.observed_message_nodes
    && value.generation_in_progress === false
    && value.nodes_truncated === false
    && value.assistant_message_id === witness.assistant_message_id
    && value.representation === witness.representation
    && value.document_ordinal === witness.document_ordinal
    && value.ordinal === ordinal
    && value.last_assistant === true
    && value.last_message === true;
}

function exactTarget(
  targets: readonly CdpTarget[],
  witness: PostSettlementTargetWitness,
): Required<Pick<CdpTarget, 'id' | 'url' | 'webSocketDebuggerUrl'>> | undefined {
  const identityMatches = targets.filter((target) => target.type === 'page' && target.id === witness.target_id);
  if (identityMatches.length === 0) return undefined;
  if (identityMatches.length !== 1) throw new CloseError('target_identity_mismatch', 'target_identity_ambiguous');
  const target = identityMatches[0]!;
  if (!isBoundedString(target.url, MAX_URL_LENGTH)
    || normalizeUrl(target.url) !== witness.normalized_url
    || !isBoundedString(target.webSocketDebuggerUrl, MAX_URL_LENGTH)) {
    throw new CloseError('target_identity_mismatch', 'target_identity_changed');
  }
  return { id: target.id!, url: target.url, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

export async function runPostSettlementClose(
  args: ParsedCloseArgs,
  deps: PostSettlementCloseDependencies = defaultPostSettlementCloseDependencies,
): Promise<PostSettlementCloseResult> {
  let profileKey = 'profile-unresolved';
  let evidenceSchema = 'unresolved';
  let witness: PostSettlementTargetWitness | undefined;
  try {
    profileKey = configuredProfileKey(args.profile, args.cdp);
    const direct = parseJson(await deps.readText(args.turnResult), 'settlement_untrusted', 'turn_result_invalid_json');
    const validated = validateDirectResult(direct);
    witness = validated.witness;
    evidenceSchema = validated.schema;
    if (profileKey !== witness.configured_profile_key) {
      throw new CloseError('settlement_untrusted', 'configured_profile_namespace_mismatch');
    }
    const probe = validateProbe(
      parseJson(await deps.readText(args.probeResult), 'harvest_untrusted', 'probe_result_invalid_json'),
      witness,
    );
    const bytes = await deps.readBytes(args.harvest);
    if (bytes.byteLength !== witness.byte_length || hashBytes(bytes) !== witness.sha256) {
      throw new CloseError('harvest_untrusted', 'harvest_file_mismatch');
    }

    const target = exactTarget(await deps.listTargets(args.cdp), witness);
    if (!target) return baseResult('already_absent', profileKey, evidenceSchema, witness);
    const channel = await deps.openExactTargetChannel(target);
    try {
      const expression = guardExpression(witness, probe.node.ordinal);
      const initial = await channel.evaluate(expression);
      if (!guardMatches(initial, witness, probe.node.ordinal)) {
        return baseResult('stale_harvest', profileKey, evidenceSchema, witness, 0, 'initial_guard_failed');
      }
      await deps.beforeFinalGuard?.();
      const final = await channel.evaluate(expression);
      if (!guardMatches(final, witness, probe.node.ordinal)) {
        return baseResult('stale_harvest', profileKey, evidenceSchema, witness, 0, 'final_guard_failed');
      }
      // No target census, DOM read, navigation, sleep or timer wait may intervene
      // between this final same-channel observation and the one exact Page.close.
      await channel.close();
    } finally {
      channel.disconnect();
    }

    const remaining = await deps.listTargets(args.cdp);
    const absent = !remaining.some((target) => target.type === 'page' && target.id === witness!.target_id);
    return baseResult(absent ? 'closed' : 'close_unconfirmed', profileKey, evidenceSchema, witness, 1,
      absent ? undefined : 'target_still_present');
  } catch (error) {
    const status = error instanceof CloseError ? error.status : 'unavailable';
    return baseResult(status, profileKey, evidenceSchema, witness, 0, boundedReason(error));
  }
}

function exitCode(status: PostSettlementCloseStatus): number {
  if (status === 'closed' || status === 'already_absent') return 0;
  if (status === 'input_invalid') return 10;
  if (status === 'settlement_untrusted' || status === 'harvest_untrusted' || status === 'target_identity_mismatch' || status === 'stale_harvest') return 11;
  return 12;
}

export async function runPostSettlementCloseCli(
  argv = process.argv.slice(2),
  deps: PostSettlementCloseDependencies = defaultPostSettlementCloseDependencies,
): Promise<number> {
  let result: PostSettlementCloseResult;
  try {
    result = await runPostSettlementClose(parsePostSettlementCloseArgs(argv), deps);
  } catch (error) {
    result = baseResult(
      error instanceof CloseError ? error.status : 'input_invalid',
      'profile-unresolved',
      'unresolved',
      undefined,
      0,
      boundedReason(error),
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return exitCode(result.status);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await runPostSettlementCloseCli();
