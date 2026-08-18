#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  parseCliArgs as parsePageProbeArgs,
  runProbe as runPageProbe,
  type ParsedArgs as ParsedProbeArgs,
  type ProbeDependencies,
} from './browser-gpt-page-probe.ts';
import { BEFORE_CDP_BROWSER_RELEASE } from './chatgpt-browser-turn/browser-session.ts';
import {
  ASSISTANT_TURN_ACTION_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  CONTINUE_GENERATING_TESTID_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from './chatgpt-browser-turn/product-page-selectors.ts';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import {
  createDirectPublicationObservationState,
  observeDirectPublicationPayloadTree,
  type DirectPublicationObservationState,
} from './chatgpt-browser-turn/terminal-witness.ts';
import { loadChromium, normalizeConversationUrl } from './chatgpt-browser-turn/ui-adapter.ts';

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
const MAX_CAPTURE_MESSAGE_NODES = 100;
const CDP_TIMEOUT_MS = 10_000;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const TARGET_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/u;
const ELIGIBLE_RECOVERY_CAUSES = new Set([
  'direct_publication_observation_missing',
  'direct_publication_source_invalid',
  'direct_publication_receipt_invalid',
]);
const PROBE_STATUSES = new Set([
  'ok',
  'not_found',
  'ambiguous',
  'stale_node',
  'unsafe_output',
  'surface_unknown',
  'unavailable',
  'export_failed',
  'cleanup_failed',
  'input_invalid',
]);

export interface CausalWitness {
  readonly user_message_id: string;
  readonly assistant_message_id: string;
  readonly relation: 'reply_to';
  readonly source: 'service';
}

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

export type PostSettlementCaptureCause =
  | 'timeout'
  | 'page_detached'
  | 'target_identity_unavailable'
  | 'reply_identity_unavailable'
  | 'surface_incomplete'
  | 'malformed';

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
  readonly openExactTargetChannel: (
    target: Required<Pick<CdpTarget, 'id' | 'url' | 'webSocketDebuggerUrl'>>,
  ) => Promise<ExactTargetChannel>;
  readonly beforeFinalGuard?: () => Promise<void> | void;
}

export interface ParsedCloseArgs {
  readonly turnResult: string;
  readonly probeResult: string;
  readonly harvest: string;
  readonly profile: string;
  readonly cdp: string;
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

class CloseError extends Error {
  readonly status: PostSettlementCloseStatus;

  constructor(status: PostSettlementCloseStatus, reason: string) {
    super(reason);
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

function isBoundedString(value: unknown, maximum = MAX_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= maximum;
}

function boundedReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return Array.from(raw).slice(0, 240).join('');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeUrl(raw: string): string {
  const value = new URL(raw);
  if (value.protocol !== 'http:' && value.protocol !== 'https:') throw new Error('unsupported_url');
  if (value.username || value.password) throw new Error('credentials_not_allowed');
  value.hash = '';
  value.search = '';
  value.hostname = value.hostname.toLowerCase();
  value.pathname = value.pathname.replace(/\/+$/u, '') || '/';
  const normalized = value.toString().replace(/\/$/u, '');
  if (Array.from(normalized).length > MAX_URL_LENGTH) throw new Error('url_too_long');
  return normalized;
}

function resultEnvelope(
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
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !accepted.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new CloseError('input_invalid', 'argument_invalid');
    }
    values.set(name, value);
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

async function readRegularBytes(path: string): Promise<Uint8Array> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES) {
    throw new CloseError('input_invalid', 'input_file_untrusted');
  }
  return await readFile(path);
}

async function readRegularText(path: string): Promise<string> {
  return Buffer.from(await readRegularBytes(path)).toString('utf8');
}

function cdpBase(raw: string): string {
  const value = new URL(raw);
  if (value.protocol !== 'http:' && value.protocol !== 'https:') throw new Error('unsupported_cdp');
  value.hash = '';
  value.search = '';
  value.pathname = '';
  return value.toString().replace(/\/$/u, '');
}

async function listCdpTargets(cdp: string): Promise<readonly CdpTarget[]> {
  const response = await fetch(`${cdpBase(cdp)}/json/list`, {
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`cdp_list_http_${response.status}`);
  const parsed: unknown = await response.json();
  if (!Array.isArray(parsed)) throw new Error('cdp_list_not_array');
  return parsed as readonly CdpTarget[];
}

interface SocketEvent { readonly data?: unknown }
interface SocketLike {
  addEventListener(type: string, listener: (event: SocketEvent) => void, options?: { readonly once?: boolean }): void;
  send(data: string): void;
  close(): void;
}
interface SocketConstructor { new(url: string): SocketLike }
interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

async function openTargetChannel(
  target: Required<Pick<CdpTarget, 'id' | 'url' | 'webSocketDebuggerUrl'>>,
): Promise<ExactTargetChannel> {
  const Constructor = (globalThis as unknown as { WebSocket?: SocketConstructor }).WebSocket;
  if (!Constructor) throw new Error('websocket_unavailable');
  const socket = new Constructor(target.webSocketDebuggerUrl);
  const pending = new Map<number, PendingCommand>();
  let closed = false;
  let nextId = 0;
  let resolveOpen!: () => void;
  let rejectOpen!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  socket.addEventListener('open', () => resolveOpen(), { once: true });
  socket.addEventListener('error', () => rejectOpen(new Error('cdp_websocket_error')), { once: true });
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data)) as {
        readonly id?: number;
        readonly error?: { readonly message?: string };
        readonly result?: {
          readonly exceptionDetails?: { readonly text?: string };
          readonly result?: { readonly value?: unknown };
        };
      };
      if (!message.id) return;
      const command = pending.get(message.id);
      if (!command) return;
      pending.delete(message.id);
      if (message.error) command.reject(new Error(message.error.message ?? 'cdp_command_error'));
      else if (message.result?.exceptionDetails) {
        command.reject(new Error(message.result.exceptionDetails.text ?? 'cdp_expression_exception'));
      } else command.resolve(message.result?.result?.value ?? message.result);
    } catch {
      // Unrelated events cannot create close authority.
    }
  });
  socket.addEventListener('close', () => {
    closed = true;
    for (const command of pending.values()) command.reject(new Error('cdp_websocket_closed'));
    pending.clear();
  }, { once: true });
  await Promise.race([
    opened,
    new Promise<void>((_, reject) => setTimeout(
      () => reject(new Error('cdp_connect_timeout')),
      CDP_TIMEOUT_MS,
    )),
  ]);

  const command = async (method: string, params?: unknown): Promise<unknown> => {
    if (closed) throw new Error('cdp_websocket_closed');
    const id = ++nextId;
    const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    return await Promise.race([
      response,
      new Promise<never>((_, reject) => setTimeout(() => {
        if (pending.delete(id)) reject(new Error('cdp_command_timeout'));
      }, CDP_TIMEOUT_MS)),
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
  readBytes: readRegularBytes,
  listTargets: listCdpTargets,
  openExactTargetChannel: openTargetChannel,
};

function parseJsonRecord(
  text: string,
  status: PostSettlementCloseStatus,
  reason: string,
): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new CloseError(status, reason); }
  if (!isRecord(parsed)) throw new CloseError(status, reason);
  return parsed;
}

function validateTargetWitness(value: unknown): PostSettlementTargetWitness {
  if (!isRecord(value)
    || value.disposition !== 'preserved_after_settlement'
    || !isBoundedString(value.configured_profile_key)
    || !isBoundedString(value.target_id, 256)
    || !TARGET_ID_RE.test(value.target_id)
    || !isBoundedString(value.normalized_url, MAX_URL_LENGTH)
    || !isBoundedString(value.assistant_message_id)
    || (value.representation !== 'innerText' && value.representation !== 'textContent')
    || !isSafeCount(value.byte_length)
    || typeof value.sha256 !== 'string'
    || !SHA256_RE.test(value.sha256)
    || !isSafeCount(value.document_ordinal)
    || !isSafeCount(value.observed_user_nodes)
    || !isSafeCount(value.observed_assistant_nodes)
    || !isSafeCount(value.observed_message_nodes)
    || value.generation_in_progress !== false
    || value.nodes_truncated !== false) {
    throw new CloseError('settlement_untrusted', 'preserved_target_witness_invalid');
  }
  if (value.observed_message_nodes < 1
    || value.observed_message_nodes !== value.observed_user_nodes + value.observed_assistant_nodes
    || value.document_ordinal !== value.observed_message_nodes - 1) {
    throw new CloseError('settlement_untrusted', 'preserved_target_tail_invalid');
  }
  return { ...value, normalized_url: normalizeUrl(value.normalized_url) } as PostSettlementTargetWitness;
}

function isEligibleDirectResult(value: Record<string, unknown>): boolean {
  const normal = value.state === 'ok'
    && value.scope === 'none'
    && value.cause === 'completed_page_only';
  const recovery = value.state === 'recovery_required'
    && value.scope === 'conversation'
    && typeof value.cause === 'string'
    && ELIGIBLE_RECOVERY_CAUSES.has(value.cause);
  return value.schema === 'turn-result/v1' && value.send_count === 1 && (normal || recovery);
}

function validateDirectResult(value: Record<string, unknown>): {
  readonly witness: PostSettlementTargetWitness;
  readonly schema: string;
} {
  if (value.schema === 'flow-manager-long-running-child-terminal/v1') {
    throw new CloseError('settlement_untrusted', 'launcher_envelope_forbidden');
  }
  if (value.cleanup !== 'skipped'
    || Object.prototype.hasOwnProperty.call(value, 'post_settlement_target_capture')) {
    throw new CloseError('settlement_untrusted', 'prior_close_or_capture_failure');
  }
  if (!isEligibleDirectResult(value)
    || !isBoundedString(value.configured_profile_key)
    || !isRecord(value.witness)
    || !isBoundedString(value.witness.user_message_id)
    || !isBoundedString(value.witness.assistant_message_id)
    || value.witness.relation !== 'reply_to'
    || value.witness.source !== 'service') {
    throw new CloseError('settlement_untrusted', 'direct_result_invalid');
  }
  const witness = validateTargetWitness(value.post_settlement_target);
  if (witness.configured_profile_key !== value.configured_profile_key
    || witness.assistant_message_id !== value.witness.assistant_message_id) {
    throw new CloseError('settlement_untrusted', 'terminal_witness_mismatch');
  }
  return { witness, schema: String(value.schema) };
}

interface ValidatedProbe {
  readonly nodeOrdinal: number;
}

function validateProbeExport(
  value: Record<string, unknown>,
  witness: PostSettlementTargetWitness,
): ValidatedProbe {
  const node = isRecord(value.node) ? value.node : undefined;
  const outputIdentity = isRecord(value.output_identity) ? value.output_identity : undefined;
  if (value.schema !== 'browser-gpt-page-probe/v1'
    || value.operation !== 'export'
    || value.status !== 'ok'
    || value.diagnostic_only !== true
    || value.workflow_authority !== 'none'
    || value.configured_profile_key !== witness.configured_profile_key
    || value.target_id !== witness.target_id
    || value.normalized_url !== witness.normalized_url
    || !node
    || node.role !== 'assistant'
    || !isSafeCount(node.ordinal)
    || node.document_ordinal !== witness.document_ordinal
    || node.message_id !== witness.assistant_message_id
    || value.assistant_message_id !== witness.assistant_message_id
    || value.representation !== witness.representation
    || value.byte_length !== witness.byte_length
    || value.sha256 !== witness.sha256
    || !outputIdentity
    || !isBoundedString(outputIdentity.path, MAX_URL_LENGTH)
    || outputIdentity.byte_length !== witness.byte_length
    || outputIdentity.sha256 !== witness.sha256
    || value.observed_user_nodes !== witness.observed_user_nodes
    || value.observed_assistant_nodes !== witness.observed_assistant_nodes
    || value.observed_message_nodes !== witness.observed_message_nodes
    || value.generation_in_progress !== false
    || value.nodes_truncated !== false
    || value.last_assistant !== true
    || value.last_message !== true) {
    throw new CloseError('harvest_untrusted', 'probe_export_evidence_mismatch');
  }
  return { nodeOrdinal: node.ordinal };
}

interface BrowserGuardSelectors {
  readonly stop: string;
  readonly inProgress: string;
  readonly actions: string;
  readonly continueTestId: string;
}

const BROWSER_GUARD_SELECTORS: BrowserGuardSelectors = {
  stop: STOP_BUTTON_SELECTOR,
  inProgress: ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  actions: ASSISTANT_TURN_ACTION_SELECTOR,
  continueTestId: CONTINUE_GENERATING_TESTID_SELECTOR,
};

function finalGuardExpression(witness: PostSettlementTargetWitness, ordinal: number): string {
  const encoded = Buffer.from(JSON.stringify({
    ...witness,
    ordinal,
    selectors: BROWSER_GUARD_SELECTORS,
  }), 'utf8').toString('base64');
  return `(async()=>{const e=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'),c=>c.charCodeAt(0))));const n=r=>{const u=new URL(r);u.hash='';u.search='';u.hostname=u.hostname.toLowerCase();u.pathname=u.pathname.replace(/\\/+$/u,'')||'/';return u.toString().replace(/\\/$/u,'')};const raw=Array.from(document.querySelectorAll('[data-message-author-role]'));const counts={user:0,assistant:0};const nodes=[];for(let d=0;d<raw.length;d++){const node=raw[d],role=node.getAttribute('data-message-author-role');if(role!=='user'&&role!=='assistant')continue;nodes.push({node,role,ordinal:counts[role]++,documentOrdinal:d,messageId:node.getAttribute('data-message-id')})}const matches=nodes.filter(x=>x.messageId===e.assistant_message_id);if(matches.length!==1)return{ok:false,reason:'assistant_message_identity_changed'};const c=matches[0],last=[...nodes].reverse().find(x=>x.role==='assistant');if(c.role!=='assistant'||c.ordinal!==e.ordinal||c.documentOrdinal!==e.document_ordinal||c!==last||c!==nodes[nodes.length-1])return{ok:false,reason:'assistant_tail_changed'};const turn=c.node.closest('section[data-testid^="conversation-turn-"]')||c.node;let continuation=true,completion=false;try{const byTestId=Boolean(document.querySelector(e.selectors.continueTestId));const byName=Array.from(document.querySelectorAll('button')).some(b=>/continue generating/i.test(String(b.getAttribute('aria-label')||b.textContent||'')));continuation=byTestId||byName;const generating=Boolean(document.querySelector(e.selectors.stop)||turn.querySelector(e.selectors.inProgress));completion=Boolean(turn.querySelector(e.selectors.actions));if(generating||continuation||!completion)return{ok:false,reason:generating?'generation_state_changed':continuation?'continuation_available':'assistant_completion_unproven',generation_in_progress:generating,continuation_available:continuation,completion_ready:completion}}catch{return{ok:false,reason:'completion_surface_unavailable'}}const text=e.representation==='innerText'?c.node.innerText:c.node.textContent;if(typeof text!=='string')return{ok:false,reason:'representation_unavailable'};const bytes=new TextEncoder().encode(text),digest=await crypto.subtle.digest('SHA-256',bytes),hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),url=n(location.href);return{ok:url===e.normalized_url&&bytes.byteLength===e.byte_length&&hash===e.sha256&&counts.user===e.observed_user_nodes&&counts.assistant===e.observed_assistant_nodes&&nodes.length===e.observed_message_nodes,normalized_url:url,byte_length:bytes.byteLength,sha256:hash,observed_user_nodes:counts.user,observed_assistant_nodes:counts.assistant,observed_message_nodes:nodes.length,generation_in_progress:false,nodes_truncated:false,assistant_message_id:c.messageId,representation:e.representation,document_ordinal:c.documentOrdinal,ordinal:c.ordinal,last_assistant:c===last,last_message:c===nodes[nodes.length-1],completion_ready:completion,continuation_available:continuation}})()`;
}

function finalGuardMatches(
  value: unknown,
  witness: PostSettlementTargetWitness,
  ordinal: number,
): boolean {
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
    && value.last_message === true
    && value.completion_ready === true
    && value.continuation_available === false;
}

function resolveExactTarget(
  targets: readonly CdpTarget[],
  witness: PostSettlementTargetWitness,
): Required<Pick<CdpTarget, 'id' | 'url' | 'webSocketDebuggerUrl'>> | undefined {
  const matches = targets.filter((target) => target.type === 'page' && target.id === witness.target_id);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw new CloseError('target_identity_mismatch', 'target_identity_ambiguous');
  const target = matches[0]!;
  if (!isBoundedString(target.url, MAX_URL_LENGTH)
    || normalizeUrl(target.url) !== witness.normalized_url
    || !isBoundedString(target.webSocketDebuggerUrl, MAX_URL_LENGTH)) {
    throw new CloseError('target_identity_mismatch', 'target_identity_changed');
  }
  return { id: target.id!, url: target.url, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

export async function runPostSettlementClose(
  args: ParsedCloseArgs,
  dependencies: PostSettlementCloseDependencies = defaultPostSettlementCloseDependencies,
): Promise<PostSettlementCloseResult> {
  let profileKey = 'profile-unresolved';
  let evidenceSchema = 'unresolved';
  let witness: PostSettlementTargetWitness | undefined;
  let closeAttempted = false;
  try {
    profileKey = configuredProfileKey(args.profile, args.cdp);
    const direct = parseJsonRecord(
      await dependencies.readText(args.turnResult),
      'settlement_untrusted',
      'turn_result_invalid_json',
    );
    const validated = validateDirectResult(direct);
    witness = validated.witness;
    evidenceSchema = validated.schema;
    if (witness.configured_profile_key !== profileKey) {
      throw new CloseError('settlement_untrusted', 'configured_profile_namespace_mismatch');
    }
    const probe = validateProbeExport(
      parseJsonRecord(
        await dependencies.readText(args.probeResult),
        'harvest_untrusted',
        'probe_result_invalid_json',
      ),
      witness,
    );
    const harvest = await dependencies.readBytes(args.harvest);
    if (harvest.byteLength !== witness.byte_length || sha256(harvest) !== witness.sha256) {
      throw new CloseError('harvest_untrusted', 'harvest_file_mismatch');
    }

    const target = resolveExactTarget(await dependencies.listTargets(args.cdp), witness);
    if (!target) return resultEnvelope('already_absent', profileKey, evidenceSchema, witness);
    const channel = await dependencies.openExactTargetChannel(target);
    try {
      const expression = finalGuardExpression(witness, probe.nodeOrdinal);
      const initial = await channel.evaluate(expression);
      if (!finalGuardMatches(initial, witness, probe.nodeOrdinal)) {
        return resultEnvelope(
          'stale_harvest', profileKey, evidenceSchema, witness, 0, 'initial_guard_failed',
        );
      }
      await dependencies.beforeFinalGuard?.();
      const final = await channel.evaluate(expression);
      if (!finalGuardMatches(final, witness, probe.nodeOrdinal)) {
        return resultEnvelope(
          'stale_harvest', profileKey, evidenceSchema, witness, 0, 'final_guard_failed',
        );
      }
      // The next mutable-page action is the sole exact-target close dispatch.
      closeAttempted = true;
      try { await channel.close(); } catch { /* absence proof remains authoritative */ }
    } finally {
      channel.disconnect();
    }
    const remaining = await dependencies.listTargets(args.cdp);
    const absent = !remaining.some((candidate) => (
      candidate.type === 'page' && candidate.id === witness!.target_id
    ));
    return resultEnvelope(
      absent ? 'closed' : 'close_unconfirmed',
      profileKey,
      evidenceSchema,
      witness,
      1,
      absent ? undefined : 'target_still_present',
    );
  } catch (error) {
    if (closeAttempted) {
      return resultEnvelope(
        'close_unconfirmed',
        profileKey,
        evidenceSchema,
        witness,
        1,
        boundedReason(error),
      );
    }
    const status = error instanceof CloseError ? error.status : 'unavailable';
    return resultEnvelope(status, profileKey, evidenceSchema, witness, 0, boundedReason(error));
  }
}

function closeExitCode(status: PostSettlementCloseStatus): number {
  if (status === 'closed' || status === 'already_absent') return 0;
  if (status === 'input_invalid') return 10;
  if (status === 'settlement_untrusted'
    || status === 'harvest_untrusted'
    || status === 'target_identity_mismatch'
    || status === 'stale_harvest') return 11;
  return 12;
}

export async function runPostSettlementCloseCli(
  argv = process.argv.slice(2),
  dependencies: PostSettlementCloseDependencies = defaultPostSettlementCloseDependencies,
): Promise<number> {
  let result: PostSettlementCloseResult;
  try {
    result = await runPostSettlementClose(parsePostSettlementCloseArgs(argv), dependencies);
  } catch (error) {
    result = resultEnvelope(
      error instanceof CloseError ? error.status : 'input_invalid',
      'profile-unresolved',
      'unresolved',
      undefined,
      0,
      boundedReason(error),
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return closeExitCode(result.status);
}

export interface EnhancedProbeDependencies {
  readonly runProbe: (args: ParsedProbeArgs, dependencies?: ProbeDependencies) => Promise<unknown>;
  readonly probeDependencies?: ProbeDependencies;
}

function splitProfileArgument(argv: readonly string[]): {
  readonly profile?: string;
  readonly probeArgv: string[];
} {
  const probeArgv: string[] = [];
  let profile: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value !== '--profile') {
      probeArgv.push(value);
      continue;
    }
    const candidate = argv[++index];
    if (!candidate || candidate.startsWith('--') || profile) throw new Error('profile_argument_invalid');
    profile = candidate;
  }
  if (probeArgv[0] === 'harvest' && profile) {
    probeArgv.push('--profile', profile);
  }
  return { profile, probeArgv };
}

function probeStatus(error: unknown): string {
  if (isRecord(error) && typeof error.status === 'string' && PROBE_STATUSES.has(error.status)) {
    return error.status;
  }
  return 'unavailable';
}

function probeReason(error: unknown): string {
  if (isRecord(error) && isBoundedString(error.reason, 240)) return error.reason;
  return boundedReason(error);
}

function probeExitCode(status: string): number {
  switch (status) {
    case 'ok': return 0;
    case 'not_found': return 2;
    case 'ambiguous': return 3;
    case 'stale_node': return 4;
    case 'unsafe_output': return 5;
    case 'surface_unknown': return 6;
    case 'unavailable': return 7;
    case 'export_failed': return 8;
    case 'input_invalid': return 9;
    case 'cleanup_failed': return 10;
    default: return 7;
  }
}

function probeFailure(operation: string, status: string, reason: string): Record<string, unknown> {
  return {
    schema: 'browser-gpt-page-probe/v1',
    operation,
    status,
    diagnostic_only: true,
    workflow_authority: 'none',
    reason,
  };
}

function enrichExportEvidence(
  exported: Record<string, unknown>,
  inspected: Record<string, unknown>,
  profile: string,
  cdp: string,
): Record<string, unknown> {
  const exportedNode = isRecord(exported.node) ? exported.node : undefined;
  const snapshot = isRecord(inspected.snapshot) ? inspected.snapshot : undefined;
  if (exported.schema !== 'browser-gpt-page-probe/v1'
    || exported.operation !== 'export'
    || exported.status !== 'ok'
    || !exportedNode
    || exportedNode.role !== 'assistant'
    || !isBoundedString(exportedNode.message_id)
    || !isSafeCount(exportedNode.ordinal)
    || !isSafeCount(exportedNode.document_ordinal)
    || !isSafeCount(exported.byte_length)
    || typeof exported.sha256 !== 'string'
    || !SHA256_RE.test(exported.sha256)
    || !isBoundedString(exported.target_id, 256)
    || !isBoundedString(exported.output, MAX_URL_LENGTH)
    || (exported.representation !== 'innerText' && exported.representation !== 'textContent')
    || inspected.schema !== 'browser-gpt-page-probe/v1'
    || inspected.operation !== 'inspect'
    || inspected.status !== 'ok'
    || inspected.target_id !== exported.target_id
    || !snapshot) {
    return probeFailure('export', 'stale_node', 'extended_export_evidence_unavailable');
  }
  if (!Array.isArray(snapshot.nodes)
    || snapshot.nodes_truncated !== false
    || snapshot.generation_in_progress !== false
    || !isSafeCount(snapshot.observed_user_nodes)
    || !isSafeCount(snapshot.observed_assistant_nodes)
    || !isSafeCount(snapshot.observed_message_nodes)
    || snapshot.observed_message_nodes !== snapshot.observed_user_nodes + snapshot.observed_assistant_nodes
    || snapshot.nodes.length !== snapshot.observed_message_nodes
    || !isBoundedString(snapshot.page_url, MAX_URL_LENGTH)) {
    return probeFailure('export', 'surface_unknown', 'extended_export_surface_incomplete');
  }
  const nodes = snapshot.nodes.filter(isRecord);
  const selectedId = exportedNode.message_id;
  const selected = nodes.filter((node) => node.message_id === selectedId);
  const candidate = selected.length === 1 ? selected[0] : undefined;
  const assistants = nodes.filter((node) => node.role === 'assistant');
  const representation = exported.representation;
  const summary = candidate && isRecord(candidate[representation])
    ? candidate[representation]
    : undefined;
  if (!candidate
    || candidate.role !== 'assistant'
    || candidate.ordinal !== exportedNode.ordinal
    || candidate.document_ordinal !== exportedNode.document_ordinal
    || candidate !== assistants.at(-1)
    || candidate !== nodes.at(-1)
    || !summary
    || summary.byte_length !== exported.byte_length
    || summary.sha256 !== exported.sha256) {
    return probeFailure('export', 'stale_node', 'extended_export_witness_mismatch');
  }
  return {
    ...exported,
    configured_profile_key: configuredProfileKey(profile, cdp),
    normalized_url: normalizeConversationUrl(snapshot.page_url),
    assistant_message_id: selectedId,
    output_identity: {
      path: exported.output,
      byte_length: exported.byte_length,
      sha256: exported.sha256,
    },
    observed_user_nodes: snapshot.observed_user_nodes,
    observed_assistant_nodes: snapshot.observed_assistant_nodes,
    observed_message_nodes: snapshot.observed_message_nodes,
    generation_in_progress: false,
    nodes_truncated: false,
    last_assistant: true,
    last_message: true,
  };
}

export async function runEnhancedPageProbeCli(
  argv: readonly string[],
  dependencies: EnhancedProbeDependencies = { runProbe: runPageProbe },
): Promise<number> {
  let operation = argv[0] ?? 'list';
  let result: Record<string, unknown>;
  try {
    const split = splitProfileArgument(argv);
    const parsed = parsePageProbeArgs(split.probeArgv);
    operation = parsed.operation;
    const raw = await dependencies.runProbe(parsed, dependencies.probeDependencies);
    result = isRecord(raw) ? raw : probeFailure(operation, 'unavailable', 'malformed_probe_result');
    if (parsed.operation === 'export' && result.status === 'ok') {
      if (!split.profile) {
        result = probeFailure('export', 'input_invalid', 'profile_required_for_export');
      } else {
        const inspectArgs: ParsedProbeArgs = {
          operation: 'inspect',
          cdp: parsed.cdp,
          targetId: parsed.targetId,
        };
        const inspectedRaw = await dependencies.runProbe(inspectArgs, dependencies.probeDependencies);
        result = isRecord(inspectedRaw)
          ? enrichExportEvidence(result, inspectedRaw, split.profile, parsed.cdp)
          : probeFailure('export', 'unavailable', 'malformed_inspect_result');
      }
    }
  } catch (error) {
    const status = probeStatus(error);
    result = probeFailure(operation, status, probeReason(error));
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return probeExitCode(String(result.status ?? 'unavailable'));
}

interface DirectCaptureConfig {
  readonly profile: string;
  readonly cdp: string;
  readonly profileKey: string;
  readonly repositoryFullName: string;
  readonly issueNumber: number;
}

interface TrackedPage {
  readonly page: any;
  closeAttempted: boolean;
}

interface CaptureState {
  readonly config: DirectCaptureConfig;
  readonly observation: DirectPublicationObservationState;
  readonly pages: TrackedPage[];
  causalWitness?: CausalWitness;
  targetWitness?: PostSettlementTargetWitness;
  captureCause?: PostSettlementCaptureCause;
  capturePromise?: Promise<void>;
}

function parseTurnOptions(argv: readonly string[]): Map<string, string | true> {
  const options = new Map<string, string | true>();
  const args = argv[0] === 'turn' ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!name?.startsWith('--')) continue;
    if (name === '--new-chat') {
      options.set('new-chat', true);
      continue;
    }
    const value = args[++index];
    if (value) options.set(name.slice(2), value);
  }
  return options;
}

function directCaptureConfig(argv: readonly string[]): DirectCaptureConfig | undefined {
  const options = parseTurnOptions(argv);
  if (!options.has('reviewer-source-output')) return undefined;
  const profile = options.get('profile');
  const cdp = options.get('cdp');
  const repositoryFullName = options.get('repository');
  const issueNumber = options.get('issue-number');
  if (typeof profile !== 'string'
    || typeof cdp !== 'string'
    || typeof repositoryFullName !== 'string'
    || typeof issueNumber !== 'string'
    || !/^[1-9][0-9]*$/u.test(issueNumber)) return undefined;
  return {
    profile,
    cdp,
    profileKey: configuredProfileKey(profile, cdp),
    repositoryFullName,
    issueNumber: Number(issueNumber),
  };
}

function observeServiceTraffic(page: any, observation: DirectPublicationObservationState): void {
  const consume = (payload: string): void => {
    if (payload) observeDirectPublicationPayloadTree(observation, payload);
  };
  page.on?.('response', async (response: any) => {
    try { consume(await response.text()); } catch { /* opaque body */ }
  });
  page.on?.('websocket', (socket: any) => {
    socket.on?.('framereceived', (frame: { readonly payload?: string }) => consume(frame.payload ?? ''));
  });
}

function resolveCausalWitness(state: CaptureState): CausalWitness | undefined {
  const invocations = state.observation.invocations.filter((entry) => (
    entry.repositoryFullName === state.config.repositoryFullName
    && entry.issueNumber === state.config.issueNumber
  ));
  if (invocations.length !== 1) return undefined;
  const invocation = invocations[0]!;
  const results = state.observation.results.filter((entry) => (
    entry.repositoryFullName === state.config.repositoryFullName
    && entry.issueNumber === state.config.issueNumber
    && entry.toolCallId === invocation.toolCallId
  ));
  if (results.length > 1) return undefined;
  const result = results[0];
  const parentIds = new Set(
    [invocation.parentUserMessageId, result?.parentUserMessageId]
      .filter((value): value is string => isBoundedString(value)),
  );
  const assistantIds = new Set(
    [invocation.assistantMessageId, result?.assistantMessageId]
      .filter((value): value is string => isBoundedString(value)),
  );
  if (parentIds.size !== 1 || assistantIds.size !== 1) return undefined;
  return {
    user_message_id: [...parentIds][0]!,
    assistant_message_id: [...assistantIds][0]!,
    relation: 'reply_to',
    source: 'service',
  };
}

function classifyCaptureFailure(error: unknown): PostSettlementCaptureCause {
  const reason = boundedReason(error);
  if (reason === 'post_settlement_capture_timeout') return 'timeout';
  if (/closed|detached/iu.test(reason)) return 'page_detached';
  if (/target/iu.test(reason)) return 'target_identity_unavailable';
  if (/assistant|reply|witness/iu.test(reason)) return 'reply_identity_unavailable';
  if (/surface|generation|tail|truncated|count|completion|continuation/iu.test(reason)) return 'surface_incomplete';
  return 'malformed';
}

async function withCaptureTimeout<T>(operation: Promise<T>): Promise<T> {
  return await Promise.race([
    operation,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error('post_settlement_capture_timeout')),
      CDP_TIMEOUT_MS,
    )),
  ]);
}

interface BrowserGuardSelectors {
  readonly stop: string;
  readonly inProgress: string;
  readonly actions: string;
  readonly continueTestId: string;
}

async function capturePreservedPage(state: CaptureState, tracked: TrackedPage): Promise<void> {
  const page = tracked.page;
  if (tracked.closeAttempted || page.isClosed?.() === true) throw new Error('page_detached');
  const causal = resolveCausalWitness(state);
  if (!causal) throw new Error('reply_witness_unavailable');
  const session = await page.context().newCDPSession(page);
  let targetInfo: Record<string, unknown>;
  try {
    const response: unknown = await session.send('Target.getTargetInfo');
    if (!isRecord(response) || !isRecord(response.targetInfo)) throw new Error('target_info_malformed');
    targetInfo = response.targetInfo;
  } finally {
    await session.detach().catch(() => undefined);
  }
  const pageUrl = normalizeUrl(String(page.url()));
  if (!isBoundedString(targetInfo.targetId, 256)
    || !TARGET_ID_RE.test(targetInfo.targetId)
    || targetInfo.type !== 'page'
    || !isBoundedString(targetInfo.url, MAX_URL_LENGTH)
    || normalizeUrl(targetInfo.url) !== pageUrl) {
    throw new Error('target_identity_unavailable');
  }
  const surface: unknown = await page.evaluate(async ({
    assistantMessageId,
    maximumNodes,
    selectors,
  }: {
    readonly assistantMessageId: string;
    readonly maximumNodes: number;
    readonly selectors: BrowserGuardSelectors;
  }) => {
    const raw = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const counts = { user: 0, assistant: 0 };
    const nodes: Array<{
      readonly node: Element;
      readonly role: 'user' | 'assistant';
      readonly ordinal: number;
      readonly documentOrdinal: number;
      readonly messageId: string | null;
    }> = [];
    for (let documentOrdinal = 0; documentOrdinal < raw.length; documentOrdinal++) {
      const node = raw[documentOrdinal]!;
      const role = node.getAttribute('data-message-author-role');
      if (role !== 'user' && role !== 'assistant') continue;
      nodes.push({
        node,
        role,
        ordinal: counts[role]++,
        documentOrdinal,
        messageId: node.getAttribute('data-message-id'),
      });
    }
    if (nodes.length === 0 || nodes.length > maximumNodes) {
      return { ok: false, reason: 'surface_count_invalid' };
    }
    const matches = nodes.filter((entry) => entry.messageId === assistantMessageId);
    const candidate = matches.length === 1 ? matches[0] : undefined;
    const lastAssistant = [...nodes].reverse().find((entry) => entry.role === 'assistant');
    if (!candidate
      || candidate.role !== 'assistant'
      || candidate !== lastAssistant
      || candidate !== nodes[nodes.length - 1]) {
      return { ok: false, reason: 'assistant_tail_invalid' };
    }
    const turn = candidate.node.closest('section[data-testid^="conversation-turn-"]') ?? candidate.node;
    let generationInProgress: boolean | 'unknown' = 'unknown';
    let continuationAvailable: boolean | 'unknown' = 'unknown';
    let completionReady: boolean | 'unknown' = 'unknown';
    try {
      const continueByTestId = Boolean(document.querySelector(selectors.continueTestId));
      const continueByName = Array.from(document.querySelectorAll('button')).some((button) => (
        /continue generating/i.test(String(button.getAttribute('aria-label') ?? button.textContent ?? ''))
      ));
      continuationAvailable = continueByTestId || continueByName;
      generationInProgress = Boolean(
        document.querySelector(selectors.stop)
        || turn.querySelector(selectors.inProgress),
      );
      completionReady = Boolean(turn.querySelector(selectors.actions));
    } catch {
      return { ok: false, reason: 'completion_surface_unavailable' };
    }
    if (generationInProgress !== false) {
      return { ok: false, reason: 'generation_state_unknown_or_active' };
    }
    if (continuationAvailable !== false) {
      return { ok: false, reason: 'continuation_available' };
    }
    if (completionReady !== true) {
      return { ok: false, reason: 'assistant_completion_unproven' };
    }
    const element = candidate.node as HTMLElement;
    const text = typeof element.innerText === 'string' ? element.innerText : undefined;
    if (text === undefined) return { ok: false, reason: 'assistant_representation_unavailable' };
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    return {
      ok: true,
      normalized_url: location.href,
      assistant_message_id: assistantMessageId,
      representation: 'innerText',
      byte_length: bytes.byteLength,
      sha256: hash,
      document_ordinal: candidate.documentOrdinal,
      observed_user_nodes: counts.user,
      observed_assistant_nodes: counts.assistant,
      observed_message_nodes: nodes.length,
      generation_in_progress: false,
      nodes_truncated: false,
      completion_ready: true,
      continuation_available: false,
    };
  }, {
    assistantMessageId: causal.assistant_message_id,
    maximumNodes: MAX_CAPTURE_MESSAGE_NODES,
    selectors: BROWSER_GUARD_SELECTORS,
  });
  if (!isRecord(surface)
    || surface.ok !== true
    || surface.assistant_message_id !== causal.assistant_message_id
    || surface.representation !== 'innerText'
    || !isSafeCount(surface.byte_length)
    || typeof surface.sha256 !== 'string'
    || !SHA256_RE.test(surface.sha256)
    || !isSafeCount(surface.document_ordinal)
    || !isSafeCount(surface.observed_user_nodes)
    || !isSafeCount(surface.observed_assistant_nodes)
    || !isSafeCount(surface.observed_message_nodes)
    || surface.observed_message_nodes !== surface.observed_user_nodes + surface.observed_assistant_nodes
    || surface.document_ordinal !== surface.observed_message_nodes - 1
    || surface.generation_in_progress !== false
    || surface.nodes_truncated !== false
    || surface.completion_ready !== true
    || surface.continuation_available !== false
    || !isBoundedString(surface.normalized_url, MAX_URL_LENGTH)
    || normalizeUrl(surface.normalized_url) !== pageUrl) {
    throw new Error(isRecord(surface) && typeof surface.reason === 'string'
      ? surface.reason
      : 'surface_incomplete');
  }
  state.captureCause = undefined;
  state.causalWitness = causal;
  state.targetWitness = {
    disposition: 'preserved_after_settlement',
    configured_profile_key: state.config.profileKey,
    target_id: targetInfo.targetId,
    normalized_url: pageUrl,
    assistant_message_id: causal.assistant_message_id,
    representation: 'innerText',
    byte_length: surface.byte_length,
    sha256: surface.sha256,
    document_ordinal: surface.document_ordinal,
    observed_user_nodes: surface.observed_user_nodes,
    observed_assistant_nodes: surface.observed_assistant_nodes,
    observed_message_nodes: surface.observed_message_nodes,
    generation_in_progress: false,
    nodes_truncated: false,
  };
}

async function captureBeforeDisconnectOnce(state: CaptureState): Promise<void> {
  const candidates = state.pages.filter((entry) => (
    !entry.closeAttempted && entry.page.isClosed?.() !== true
  ));
  if (candidates.length !== 1) {
    state.captureCause = candidates.length === 0 ? 'page_detached' : 'target_identity_unavailable';
    return;
  }
  try {
    await withCaptureTimeout(capturePreservedPage(state, candidates[0]!));
  } catch (error) {
    state.causalWitness = undefined;
    state.targetWitness = undefined;
    state.captureCause = classifyCaptureFailure(error);
  }
}

async function ensureCaptureBeforeDisconnect(state: CaptureState): Promise<void> {
  state.capturePromise ??= captureBeforeDisconnectOnce(state);
  await state.capturePromise;
}

function instrumentPage(state: CaptureState, page: any): void {
  const tracked: TrackedPage = { page, closeAttempted: false };
  state.pages.push(tracked);
  observeServiceTraffic(page, state.observation);
  const originalClose = page.close?.bind(page);
  if (typeof originalClose === 'function') {
    page.close = async (...args: unknown[]) => {
      tracked.closeAttempted = true;
      return await originalClose(...args);
    };
  }
}

function instrumentBrowser(state: CaptureState, browser: any): void {
  for (const context of browser.contexts?.() ?? []) {
    const originalNewPage = context.newPage?.bind(context);
    if (typeof originalNewPage === 'function') {
      context.newPage = async (...args: unknown[]) => {
        const page = await originalNewPage(...args);
        instrumentPage(state, page);
        return page;
      };
    }
  }
  const beforeRelease = async (): Promise<void> => await ensureCaptureBeforeDisconnect(state);
  try {
    Object.defineProperty(browser, BEFORE_CDP_BROWSER_RELEASE, {
      configurable: true,
      value: beforeRelease,
    });
  } catch {
    // The close wrapper below remains the same bounded production path.
  }
  const originalClose = browser.close?.bind(browser);
  if (typeof originalClose === 'function') {
    browser.close = async (...args: unknown[]) => {
      await beforeRelease();
      return await originalClose(...args);
    };
  }
}

export function rewritePreservedTurnResult(
  value: Record<string, unknown>,
  state: Pick<CaptureState, 'config' | 'causalWitness' | 'targetWitness' | 'captureCause'>,
): Record<string, unknown> {
  if (!isEligibleDirectResult(value)
    || value.cleanup !== 'skipped'
    || Object.prototype.hasOwnProperty.call(value, 'post_settlement_target_capture')
    || value.configured_profile_key !== state.config.profileKey) {
    return value;
  }
  if (state.causalWitness && state.targetWitness) {
    return {
      ...value,
      witness: state.causalWitness,
      post_settlement_target: state.targetWitness,
    };
  }
  if (state.captureCause) {
    return {
      ...value,
      post_settlement_target_capture: { status: 'unavailable', cause: state.captureCause },
    };
  }
  return value;
}

function installTurnResultRewrite(state: CaptureState): void {
  const output = process.stdout as unknown as {
    write: (chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: () => void) => boolean;
  };
  const originalWrite = output.write.bind(process.stdout);
  output.write = (chunk, encoding, callback) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding ?? 'utf8');
    if (text.endsWith('\n') && text.indexOf('\n') === text.length - 1) {
      try {
        const parsed: unknown = JSON.parse(text.slice(0, -1));
        if (isRecord(parsed) && parsed.schema === 'turn-result/v1') {
          return originalWrite(
            `${JSON.stringify(rewritePreservedTurnResult(parsed, state))}\n`,
            encoding,
            callback,
          );
        }
      } catch {
        // Non-result stdout is untouched.
      }
    }
    return originalWrite(chunk, encoding, callback);
  };
}

export function installStateLightPostSettlementCapture(argv: readonly string[]): boolean {
  const config = directCaptureConfig(argv);
  if (!config) return false;
  const state: CaptureState = {
    config,
    observation: createDirectPublicationObservationState(),
    pages: [],
  };
  installTurnResultRewrite(state);
  try {
    const chromium = loadChromium();
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args: unknown[]) => {
      const browser = await connect(...args);
      instrumentBrowser(state, browser);
      return browser;
    };
    return true;
  } catch {
    state.captureCause = 'malformed';
    return false;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
const entryPath = process.argv[1]?.replaceAll('\\', '/');
if (invokedPath !== import.meta.url
  && entryPath?.endsWith('/scripts/chatgpt-browser-turn/state-light-entry.ts')) {
  installStateLightPostSettlementCapture(process.argv.slice(2));
}

if (invokedPath === import.meta.url) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'probe') process.exitCode = await runEnhancedPageProbeCli(rest);
  else if (mode === 'close') process.exitCode = await runPostSettlementCloseCli(rest);
  else process.exitCode = await runPostSettlementCloseCli(process.argv.slice(2));
}
