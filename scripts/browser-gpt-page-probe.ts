import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSupportedChatGptConversationUrl } from './chatgpt-browser-turn/state-light-cancellation.ts';
import {
  ASSISTANT_TURN_ACTION_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  CONVERSATION_TURN_SECTION_SELECTOR,
} from './chatgpt-browser-turn/product-page-selectors.ts';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import {
  finalizeStateLightPrimaryPublication,
  readStateLightTurnObservation,
  transitionStateLightTurnObservation,
} from './chatgpt-browser-turn/state-light-turn-observation.ts';
import { recoveryMarkerCardinality } from './chatgpt-browser-turn/state-light-turn-recovery.ts';
import {
  classifyBrowserGptPageTurnStatus,
  ownedPromptMatches,
  publishStateLightReply,
  type StateLightPublicationResult,
} from './chatgpt-browser-turn/state-light-turn.ts';

export const PROBE_SCHEMA = 'browser-gpt-page-probe/v1';
export const MAX_TARGETS = 50;
export const MAX_MESSAGE_SUMMARIES = 100;
export const MAX_TEXT_CODE_POINTS = 160;
export const MAX_NORMALIZED_URL_CODE_POINTS = 2_048;
export const CDP_REQUEST_TIMEOUT_MS = 10_000;
export const ACQUISITION_READINESS_TIMEOUT_MS = 10_000;
export const ACQUISITION_READINESS_INTERVAL_MS = 250;
export const HARVEST_COMPLETION_CONFIRM_INTERVAL_MS = 1_000;
export const LIVENESS_TARGET_TIMEOUT_MS = 2_000;
export const LIVENESS_TOTAL_TIMEOUT_MS = 15_000;
export const LIVENESS_FAN_OUT = MAX_TARGETS;

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const SHA256_RE = /^[0-9a-f]{64}$/;
const TARGET_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const MESSAGE_ID_RE = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const ALLOWLISTED_ATTRIBUTES = [
  'data-message-id',
  'data-message-author-role',
  'data-testid',
  'data-turn-start-message',
  'aria-busy',
  'data-is-streaming',
  'data-state',
] as const;
const ALLOWLISTED_ATTRIBUTE_SET = new Set<string>(ALLOWLISTED_ATTRIBUTES);

export type ProbeOperation = 'list' | 'inspect' | 'export' | 'liveness' | 'harvest';
export type ProbeStatus =
  | 'ok'
  | 'not_found'
  | 'ambiguous'
  | 'stale_node'
  | 'unsafe_output'
  | 'surface_unknown'
  | 'unavailable'
  | 'export_failed'
  | 'cleanup_failed'
  | 'input_invalid';
export type MessageRole = 'user' | 'assistant';
export type TextRepresentation = 'innerText' | 'textContent';

export interface CdpTarget {
  readonly id?: string;
  readonly type?: string;
  readonly url?: string;
  readonly title?: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface CompatibleTarget {
  readonly target_id: string;
  readonly normalized_url: string;
  readonly title: string;
  readonly web_socket_debugger_url?: string;
}

export interface TextSummary {
  readonly byte_length: number;
  readonly code_point_length: number;
  readonly sha256: string;
  readonly head: string;
  readonly tail: string;
}

export interface NodeSummary {
  readonly role: MessageRole;
  readonly ordinal: number;
  readonly document_ordinal: number;
  readonly message_id: string | null;
  readonly message_id_unique: boolean;
  readonly attributes: Readonly<Record<string, string>>;
  readonly innerText: TextSummary;
  readonly textContent: TextSummary;
}

export interface InspectionSnapshot {
  readonly page_url: string;
  readonly ready_state: 'loading' | 'interactive' | 'complete';
  readonly title: string;
  readonly generation_in_progress: boolean | 'unknown';
  readonly observed_user_nodes: number;
  readonly observed_assistant_nodes: number;
  readonly observed_message_nodes: number;
  readonly nodes: readonly NodeSummary[];
  readonly nodes_truncated: boolean;
  readonly last_assistant_text_length: number;
  readonly last_assistant_text_byte_length: number;
  readonly last_assistant_text_head: string;
  readonly last_assistant_sha256: string | null;
}

interface InspectionExpressionResult {
  readonly status: 'ok' | 'surface_unknown';
  readonly reason?: string;
  readonly page_url?: string;
  readonly ready_state?: 'loading' | 'interactive' | 'complete';
  readonly title?: string;
  readonly generation_in_progress?: boolean | 'unknown';
  readonly observed_user_nodes?: number;
  readonly observed_assistant_nodes?: number;
  readonly observed_message_nodes?: number;
  readonly nodes?: readonly NodeSummary[];
  readonly nodes_truncated?: boolean;
  readonly last_assistant_text_length?: number;
  readonly last_assistant_text_byte_length?: number;
  readonly last_assistant_text_head?: string;
  readonly last_assistant_sha256?: string | null;
}

interface ExportExpressionResult {
  readonly status: 'ok' | 'not_found' | 'ambiguous' | 'stale_node' | 'surface_unknown';
  readonly reason?: string;
  readonly page_url?: string;
  readonly title?: string;
  readonly role?: MessageRole;
  readonly ordinal?: number;
  readonly document_ordinal?: number;
  readonly message_id?: string | null;
  readonly representation?: TextRepresentation;
  readonly byte_length?: number;
  readonly sha256?: string;
  readonly text?: string;
}

interface HarvestRow {
  readonly role: MessageRole;
  readonly ordinal: number;
  readonly document_ordinal: number;
  readonly message_id: string | null;
  readonly text: string;
  readonly byte_length: number;
  readonly sha256: string;
  readonly completion_ready: boolean | null;
}

interface HarvestSnapshot {
  readonly page_url: string;
  readonly generation_in_progress: boolean | 'unknown';
  readonly rows: readonly HarvestRow[];
}

export interface ProbeDependencies {
  readonly listTargets: (cdp: string) => Promise<readonly CdpTarget[]>;
  readonly evaluate: (target: CompatibleTarget, expression: string, timeoutMs?: number) => Promise<unknown>;
  readonly publish: (destination: string, bytes: Uint8Array) => Promise<void>;
  readonly publishPrimary?: (
    destination: string,
    invocationId: string,
    reply: string,
  ) => Promise<StateLightPublicationResult> | StateLightPublicationResult;
  readonly createPage?: (cdp: string, conversationUrl: string) => Promise<CdpTarget | readonly CdpTarget[]>;
  readonly closePage?: (cdp: string, targetId: string) => Promise<'closed' | 'already_gone'>;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly now?: () => number;
  readonly sleep?: (delay: number) => Promise<void>;
}

export interface ParsedListArgs {
  readonly operation: 'list';
  readonly cdp: string;
}

export interface ParsedInspectArgs {
  readonly operation: 'inspect';
  readonly cdp: string;
  readonly targetId?: string;
  readonly conversationUrl?: string;
  readonly openIfMissing?: true;
}

export interface ParsedExportArgs {
  readonly operation: 'export';
  readonly cdp: string;
  readonly targetId: string;
  readonly role: MessageRole;
  readonly ordinal: number;
  readonly messageId?: string;
  readonly representation: TextRepresentation;
  readonly expectedByteLength: number;
  readonly expectedSha256: string;
  readonly output: string;
}

export interface ParsedLivenessArgs {
  readonly operation: 'liveness';
  readonly cdp: string;
}

export interface ParsedHarvestArgs {
  readonly operation: 'harvest';
  readonly cdp: string;
  readonly profile: string;
  readonly invocationId: string;
  readonly output: string;
}

export type ParsedArgs = ParsedListArgs | ParsedInspectArgs | ParsedExportArgs | ParsedLivenessArgs | ParsedHarvestArgs;

interface ProbeEnvelope {
  readonly schema: typeof PROBE_SCHEMA;
  readonly operation: ProbeOperation;
  readonly status: ProbeStatus;
  readonly diagnostic_only: boolean;
  readonly workflow_authority: 'none';
  readonly [key: string]: unknown;
}

class ProbeError extends Error {
  readonly status: ProbeStatus;
  readonly reason: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(status: ProbeStatus, reason: string, detail?: string, details?: Readonly<Record<string, unknown>>) {
    super(detail ? `${reason}:${detail}` : reason);
    this.name = 'ProbeError';
    this.status = status;
    this.reason = reason;
    this.details = details;
  }
}

function boundedCodePoints(value: string, limit = MAX_TEXT_CODE_POINTS): string {
  return Array.from(value).slice(0, limit).join('');
}

function boundedTailCodePoints(value: string, limit = MAX_TEXT_CODE_POINTS): string {
  const points = Array.from(value);
  return points.slice(Math.max(0, points.length - limit)).join('');
}

function boundedDetail(value: unknown): string {
  return boundedCodePoints(value instanceof Error ? value.message : String(value), MAX_TEXT_CODE_POINTS);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function summarizeText(value: string): TextSummary {
  const bytes = Buffer.from(value, 'utf8');
  return {
    byte_length: bytes.byteLength,
    code_point_length: Array.from(value).length,
    sha256: hashBytes(bytes),
    head: boundedCodePoints(value),
    tail: boundedTailCodePoints(value),
  };
}

export function normalizeConversationUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) throw new Error('credentials_not_allowed');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported_protocol');
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.toString().replace(/\/$/u, '');
}

export function isCompatibleChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (CHATGPT_HOSTS.has(hostname) || hostname.endsWith('.chatgpt.com'))
      && (url.protocol === 'https:' || url.protocol === 'http:');
  } catch {
    return false;
  }
}

export function isConversationUrl(value: string): boolean {
  if (!isCompatibleChatGptUrl(value)) return false;
  try {
    return /(?:^|\/)c\/[^/]+(?:$|\/)/u.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function safeTitle(value: unknown): string {
  return boundedCodePoints(typeof value === 'string' ? value : '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown, maxCodePoints: number): value is string {
  return typeof value === 'string' && Array.from(value).length <= maxCodePoints;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function isDebuggerWebSocketUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || Array.from(value).length > MAX_NORMALIZED_URL_CODE_POINTS) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function malformedSurface(reason = 'malformed_snapshot'): never {
  throw new ProbeError('surface_unknown', reason);
}

function validateTextSummary(value: unknown): TextSummary {
  if (!isRecord(value)
    || !isNonNegativeSafeInteger(value.byte_length)
    || !isNonNegativeSafeInteger(value.code_point_length)
    || !isSha256(value.sha256)
    || !isBoundedString(value.head, MAX_TEXT_CODE_POINTS)
    || !isBoundedString(value.tail, MAX_TEXT_CODE_POINTS)) {
    return malformedSurface();
  }
  const expectedBoundedLength = Math.min(value.code_point_length, MAX_TEXT_CODE_POINTS);
  const headLength = Array.from(value.head).length;
  const tailLength = Array.from(value.tail).length;
  if (headLength !== expectedBoundedLength
    || tailLength !== expectedBoundedLength
    || value.byte_length < value.code_point_length
    || value.byte_length > value.code_point_length * 4) {
    return malformedSurface();
  }
  if (value.code_point_length <= MAX_TEXT_CODE_POINTS) {
    const bytes = Buffer.from(value.head, 'utf8');
    if (value.head !== value.tail
      || bytes.byteLength !== value.byte_length
      || hashBytes(bytes) !== value.sha256) {
      return malformedSurface();
    }
  }
  return {
    byte_length: value.byte_length,
    code_point_length: value.code_point_length,
    sha256: value.sha256,
    head: boundedCodePoints(value.head),
    tail: boundedTailCodePoints(value.tail),
  };
}

function validateAttributes(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return malformedSurface();
  const attributes: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(value)) {
    if (!ALLOWLISTED_ATTRIBUTE_SET.has(name) || !isBoundedString(rawValue, MAX_TEXT_CODE_POINTS)) {
      return malformedSurface();
    }
    attributes[name] = boundedCodePoints(rawValue);
  }
  return attributes;
}

function validateNodeSummary(value: unknown, snapshot: {
  readonly observed_user_nodes: number;
  readonly observed_assistant_nodes: number;
  readonly observed_message_nodes: number;
}): NodeSummary {
  if (!isRecord(value)
    || (value.role !== 'user' && value.role !== 'assistant')
    || !isNonNegativeSafeInteger(value.ordinal)
    || !isNonNegativeSafeInteger(value.document_ordinal)
    || typeof value.message_id_unique !== 'boolean') {
    return malformedSurface();
  }
  if (value.message_id !== null && (typeof value.message_id !== 'string' || !MESSAGE_ID_RE.test(value.message_id))) {
    return malformedSurface();
  }
  if ((value.message_id !== null) !== value.message_id_unique
    || value.ordinal >= (value.role === 'user' ? snapshot.observed_user_nodes : snapshot.observed_assistant_nodes)) {
    return malformedSurface();
  }
  const attributes = validateAttributes(value.attributes);
  if (attributes['data-message-author-role'] !== value.role
    || (value.message_id !== null
      && attributes['data-message-id'] !== boundedCodePoints(value.message_id))) {
    return malformedSurface();
  }
  return {
    role: value.role,
    ordinal: value.ordinal,
    document_ordinal: value.document_ordinal,
    message_id: value.message_id,
    message_id_unique: value.message_id_unique,
    attributes,
    innerText: validateTextSummary(value.innerText),
    textContent: validateTextSummary(value.textContent),
  };
}

function validateInspectionSnapshot(
  value: unknown,
  target: CompatibleTarget,
  requireResolvedUrlMatch: boolean,
): InspectionSnapshot {
  if (!isRecord(value)) return malformedSurface();
  if (value.status === 'surface_unknown') {
    const reason = isBoundedString(value.reason, MAX_TEXT_CODE_POINTS) ? value.reason : 'uninterpretable_surface';
    throw new ProbeError('surface_unknown', reason);
  }
  if (value.status !== 'ok'
    || !isBoundedString(value.page_url, MAX_NORMALIZED_URL_CODE_POINTS)
    || (value.ready_state !== 'loading'
      && value.ready_state !== 'interactive'
      && value.ready_state !== 'complete')
    || !isBoundedString(value.title, MAX_TEXT_CODE_POINTS)
    || (typeof value.generation_in_progress !== 'boolean' && value.generation_in_progress !== 'unknown')
    || !isNonNegativeSafeInteger(value.observed_user_nodes)
    || !isNonNegativeSafeInteger(value.observed_assistant_nodes)
    || !isNonNegativeSafeInteger(value.observed_message_nodes)
    || !Array.isArray(value.nodes)
    || value.nodes.length > MAX_MESSAGE_SUMMARIES
    || typeof value.nodes_truncated !== 'boolean'
    || !isNonNegativeSafeInteger(value.last_assistant_text_length)
    || !isNonNegativeSafeInteger(value.last_assistant_text_byte_length)
    || !isBoundedString(value.last_assistant_text_head, MAX_TEXT_CODE_POINTS)
    || (value.last_assistant_sha256 !== null && !isSha256(value.last_assistant_sha256))) {
    return malformedSurface();
  }
  if (value.observed_message_nodes !== value.observed_user_nodes + value.observed_assistant_nodes
    || (value.nodes_truncated
      ? value.nodes.length !== MAX_MESSAGE_SUMMARIES || value.observed_message_nodes <= value.nodes.length
      : value.nodes.length !== value.observed_message_nodes)) {
    return malformedSurface();
  }
  const nodeContext = {
    observed_user_nodes: value.observed_user_nodes,
    observed_assistant_nodes: value.observed_assistant_nodes,
    observed_message_nodes: value.observed_message_nodes,
  };
  const nodes = value.nodes.map((node) => validateNodeSummary(node, nodeContext));
  let previousDocumentOrdinal = -1;
  const previousRoleOrdinal: Partial<Record<MessageRole, number>> = {};
  for (const node of nodes) {
    if (node.document_ordinal <= previousDocumentOrdinal) return malformedSurface();
    previousDocumentOrdinal = node.document_ordinal;
    const previous = previousRoleOrdinal[node.role];
    if (previous !== undefined && node.ordinal !== previous + 1) return malformedSurface();
    previousRoleOrdinal[node.role] = node.ordinal;
  }
  if (value.observed_assistant_nodes === 0) {
    if (value.last_assistant_text_length !== 0
      || value.last_assistant_text_byte_length !== 0
      || value.last_assistant_text_head !== ''
      || value.last_assistant_sha256 !== null) return malformedSurface();
  } else {
    if (value.last_assistant_sha256 === null) return malformedSurface();
    const expectedHeadLength = Math.min(value.last_assistant_text_length, MAX_TEXT_CODE_POINTS);
    const lastHeadLength = Array.from(value.last_assistant_text_head).length;
    if (lastHeadLength !== expectedHeadLength
      || value.last_assistant_text_byte_length < value.last_assistant_text_length
      || value.last_assistant_text_byte_length > value.last_assistant_text_length * 4) {
      return malformedSurface();
    }
    if (value.last_assistant_text_length <= MAX_TEXT_CODE_POINTS) {
      const lastBytes = Buffer.from(value.last_assistant_text_head, 'utf8');
      if (lastBytes.byteLength !== value.last_assistant_text_byte_length
        || hashBytes(lastBytes) !== value.last_assistant_sha256) {
        return malformedSurface();
      }
    }
  }
  return {
    page_url: requireActualTargetIdentity(target, value.page_url, requireResolvedUrlMatch),
    ready_state: value.ready_state,
    title: boundedCodePoints(value.title),
    generation_in_progress: value.generation_in_progress,
    observed_user_nodes: value.observed_user_nodes,
    observed_assistant_nodes: value.observed_assistant_nodes,
    observed_message_nodes: value.observed_message_nodes,
    nodes,
    nodes_truncated: value.nodes_truncated,
    last_assistant_text_length: value.last_assistant_text_length,
    last_assistant_text_byte_length: value.last_assistant_text_byte_length,
    last_assistant_text_head: boundedCodePoints(value.last_assistant_text_head),
    last_assistant_sha256: value.last_assistant_sha256,
  };
}

export function toCompatibleTargets(targets: readonly CdpTarget[]): CompatibleTarget[] {
  const compatible: CompatibleTarget[] = [];
  for (const target of targets) {
    if (!isRecord(target) || target.type !== 'page'
      || typeof target.id !== 'string'
      || !TARGET_ID_RE.test(target.id)
      || typeof target.url !== 'string'
      || !isCompatibleChatGptUrl(target.url)) continue;
    let normalized: string;
    try {
      normalized = normalizeConversationUrl(target.url);
    } catch {
      continue;
    }
    if (Array.from(normalized).length > MAX_NORMALIZED_URL_CODE_POINTS) continue;
    compatible.push({
      target_id: target.id,
      normalized_url: normalized,
      title: safeTitle(target.title),
      ...(typeof target.webSocketDebuggerUrl === 'string' ? { web_socket_debugger_url: target.webSocketDebuggerUrl } : {}),
    });
  }
  return compatible;
}

function baseEnvelope(operation: ProbeOperation, status: ProbeStatus): ProbeEnvelope {
  return {
    schema: PROBE_SCHEMA,
    operation,
    status,
    diagnostic_only: operation !== 'harvest',
    workflow_authority: 'none',
  };
}

function parseOptionPairs(tokens: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ProbeError('input_invalid', 'invalid_option_shape');
    }
    if (values.has(key)) throw new ProbeError('input_invalid', 'duplicate_option', key);
    values.set(key, value);
  }
  return values;
}

function requireOnly(values: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const key of values.keys()) {
    if (!set.has(key)) throw new ProbeError('input_invalid', 'unknown_option', key);
  }
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new ProbeError('input_invalid', 'missing_option', key);
  return value;
}

function parseNonNegativeInteger(value: string, key: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new ProbeError('input_invalid', 'invalid_integer', key);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ProbeError('input_invalid', 'invalid_integer', key);
  return parsed;
}

function validateCdp(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeError('input_invalid', 'invalid_cdp_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProbeError('input_invalid', 'invalid_cdp_url');
  }
  return value;
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const operation = argv[0];
  if (operation !== 'list' && operation !== 'inspect' && operation !== 'export' && operation !== 'liveness' && operation !== 'harvest') {
    throw new ProbeError('input_invalid', 'unknown_operation');
  }
  if ((argv.length - 1) % 2 !== 0) throw new ProbeError('input_invalid', 'invalid_option_shape');
  const values = parseOptionPairs(argv.slice(1));
  const cdp = validateCdp(required(values, '--cdp'));

  if (operation === 'list' || operation === 'liveness') {
    requireOnly(values, ['--cdp']);
    return { operation, cdp };
  }

  if (operation === 'harvest') {
    requireOnly(values, ['--cdp', '--profile', '--invocation-id', '--output']);
    return {
      operation,
      cdp,
      profile: required(values, '--profile'),
      invocationId: required(values, '--invocation-id'),
      output: required(values, '--output'),
    };
  }

  if (operation === 'inspect') {
    requireOnly(values, ['--cdp', '--target-id', '--url', '--open-if-missing']);
    const targetId = values.get('--target-id');
    const conversationUrl = values.get('--url');
    const openIfMissingValue = values.get('--open-if-missing');
    if ((targetId ? 1 : 0) + (conversationUrl ? 1 : 0) !== 1) {
      throw new ProbeError('input_invalid', 'exactly_one_page_selector_required');
    }
    if (targetId && !TARGET_ID_RE.test(targetId)) throw new ProbeError('input_invalid', 'invalid_target_id');
    if (conversationUrl && !isConversationUrl(conversationUrl)) {
      throw new ProbeError('input_invalid', 'invalid_conversation_url');
    }
    if (openIfMissingValue !== undefined && openIfMissingValue !== 'true') {
      throw new ProbeError('input_invalid', 'open_if_missing_must_be_true');
    }
    if (openIfMissingValue === 'true' && targetId) {
      throw new ProbeError('input_invalid', 'open_if_missing_requires_url');
    }
    return {
      operation,
      cdp,
      ...(targetId ? { targetId } : {}),
      ...(conversationUrl ? { conversationUrl } : {}),
      ...(openIfMissingValue === 'true' ? { openIfMissing: true as const } : {}),
    };
  }

  requireOnly(values, [
    '--cdp', '--target-id', '--role', '--ordinal', '--message-id', '--representation',
    '--expected-byte-length', '--expected-sha256', '--output',
  ]);
  const targetId = required(values, '--target-id');
  if (!TARGET_ID_RE.test(targetId)) throw new ProbeError('input_invalid', 'invalid_target_id');
  const role = required(values, '--role');
  if (role !== 'user' && role !== 'assistant') throw new ProbeError('input_invalid', 'invalid_role');
  const representation = required(values, '--representation');
  if (representation !== 'innerText' && representation !== 'textContent') {
    throw new ProbeError('input_invalid', 'invalid_representation');
  }
  const expectedSha256 = required(values, '--expected-sha256').toLowerCase();
  if (!SHA256_RE.test(expectedSha256)) throw new ProbeError('input_invalid', 'invalid_expected_sha256');
  const messageId = values.get('--message-id');
  if (messageId && !MESSAGE_ID_RE.test(messageId)) throw new ProbeError('input_invalid', 'invalid_message_id');
  return {
    operation,
    cdp,
    targetId,
    role,
    ordinal: parseNonNegativeInteger(required(values, '--ordinal'), '--ordinal'),
    ...(messageId ? { messageId } : {}),
    representation,
    expectedByteLength: parseNonNegativeInteger(required(values, '--expected-byte-length'), '--expected-byte-length'),
    expectedSha256,
    output: required(values, '--output'),
  };
}

function cdpBase(cdp: string): string {
  const url = new URL(cdp);
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

async function defaultCreatePage(cdp: string, conversationUrl: string): Promise<CdpTarget> {
  const response = await fetch(`${cdpBase(cdp)}/json/new?${encodeURIComponent(conversationUrl)}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(CDP_REQUEST_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`cdp_create_http_${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error('cdp_create_not_object');
  return value as CdpTarget;
}

async function defaultClosePage(cdp: string, targetId: string): Promise<'closed' | 'already_gone'> {
  const response = await fetch(`${cdpBase(cdp)}/json/close/${encodeURIComponent(targetId)}`, {
    signal: AbortSignal.timeout(CDP_REQUEST_TIMEOUT_MS),
    headers: { accept: 'text/plain' },
  });
  if (response.status === 404) return 'already_gone';
  if (!response.ok) throw new Error(`cdp_close_http_${response.status}`);
  return 'closed';
}

interface WebSocketLike {
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void, options?: { readonly once?: boolean }): void;
  send(data: string): void;
  close(): void;
}

interface WebSocketConstructorLike {
  new(url: string): WebSocketLike;
}

async function defaultEvaluate(target: CompatibleTarget, expression: string, timeoutMs = CDP_REQUEST_TIMEOUT_MS): Promise<unknown> {
  if (!target.web_socket_debugger_url) throw new Error('target_websocket_unavailable');
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: WebSocketConstructorLike }).WebSocket;
  if (!WebSocketCtor) throw new Error('websocket_unavailable');
  const socket = new WebSocketCtor(target.web_socket_debugger_url);
  const commandId = 1;
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finishReject(new Error('cdp_evaluate_timeout')), timeoutMs);
    const finishResolve = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      resolve(value);
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      reject(error);
    };
    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({
          id: commandId,
          method: 'Runtime.evaluate',
          params: {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: false,
          },
        }));
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    }, { once: true });
    socket.addEventListener('error', () => finishReject(new Error('cdp_websocket_error')), { once: true });
    socket.addEventListener('close', () => {
      if (!settled) finishReject(new Error('cdp_websocket_closed'));
    }, { once: true });
    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          readonly id?: number;
          readonly error?: { readonly message?: string };
          readonly result?: {
            readonly exceptionDetails?: { readonly text?: string };
            readonly result?: { readonly value?: unknown };
          };
        };
        if (payload.id !== commandId) return;
        if (payload.error) return finishReject(new Error(payload.error.message ?? 'cdp_evaluate_error'));
        if (payload.result?.exceptionDetails) {
          return finishReject(new Error(payload.result.exceptionDetails.text ?? 'cdp_expression_exception'));
        }
        finishResolve(payload.result?.result?.value);
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export interface PublishOperations {
  readonly lstat: typeof lstat;
  readonly open: typeof open;
  readonly unlink: typeof unlink;
}

export const defaultPublishOperations: PublishOperations = { lstat, open, unlink };

export async function publishExactBytes(
  destination: string,
  bytes: Uint8Array,
  ops: PublishOperations = defaultPublishOperations,
): Promise<void> {
  const parent = dirname(destination);
  let parentStat;
  try {
    parentStat = await ops.lstat(parent);
  } catch {
    throw new ProbeError('unsafe_output', 'parent_unavailable');
  }
  if (!parentStat.isDirectory()) throw new ProbeError('unsafe_output', 'parent_not_directory');

  try {
    await ops.lstat(destination);
    throw new ProbeError('unsafe_output', 'destination_exists');
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new ProbeError('unsafe_output', 'destination_uninspectable', code);
  }

  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await ops.open(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    created = true;
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('created_target_not_regular_file');
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesWritten <= 0) throw new Error('short_write');
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (!created) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ELOOP' || code === 'EISDIR' || code === 'ENOTDIR' || code === 'ENOENT') {
        throw new ProbeError('unsafe_output', 'exclusive_create_refused', code);
      }
      throw new ProbeError('unsafe_output', 'exclusive_create_unavailable', code ?? boundedDetail(error));
    }
    if (handle) {
      try { await handle.close(); } catch { /* cleanup below */ }
    }
    try { await ops.unlink(destination); } catch { /* best effort; never claim validity */ }
    throw new ProbeError('export_failed', 'file_publication_failed', boundedDetail(error));
  }
}

export const defaultDependencies: ProbeDependencies = {
  listTargets: defaultListTargets,
  evaluate: defaultEvaluate,
  publish: publishExactBytes,
  publishPrimary: (destination, invocationId, reply) => publishStateLightReply(destination, invocationId, reply),
  createPage: defaultCreatePage,
  closePage: defaultClosePage,
};

function inspectionExpression(): string {
  const attributes = JSON.stringify(ALLOWLISTED_ATTRIBUTES);
  return `(async () => {
    const MAX_NODES = ${MAX_MESSAGE_SUMMARIES};
    const MAX_TEXT = ${MAX_TEXT_CODE_POINTS};
    const ATTRS = ${attributes};
    const points = (value) => Array.from(value);
    const head = (value) => points(value).slice(0, MAX_TEXT).join('');
    const tail = (value) => { const p = points(value); return p.slice(Math.max(0, p.length - MAX_TEXT)).join(''); };
    const digest = async (value) => {
      const bytes = new TextEncoder().encode(value);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return { byte_length: bytes.byteLength, code_point_length: points(value).length, sha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(''), head: head(value), tail: tail(value) };
    };
    const raw = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const roleCounts = { user: 0, assistant: 0 };
    const observed = [];
    for (let documentOrdinal = 0; documentOrdinal < raw.length; documentOrdinal++) {
      const node = raw[documentOrdinal];
      const role = node.getAttribute('data-message-author-role');
      if (role !== 'user' && role !== 'assistant') continue;
      const ordinal = roleCounts[role]++;
      observed.push({ node, documentOrdinal, role, ordinal, rawMessageId: node.getAttribute('data-message-id') });
    }
    if (observed.length === 0) return { status: 'surface_unknown', reason: 'message_nodes_missing', page_url: location.href, ready_state: document.readyState };
    const messageIdCounts = new Map();
    for (const entry of observed) if (entry.rawMessageId) messageIdCounts.set(entry.rawMessageId, (messageIdCounts.get(entry.rawMessageId) || 0) + 1);
    const selected = observed.slice(Math.max(0, observed.length - MAX_NODES));
    const nodes = [];
    for (const entry of selected) {
      const innerText = typeof entry.node.innerText === 'string' ? entry.node.innerText : null;
      const textContent = typeof entry.node.textContent === 'string' ? entry.node.textContent : null;
      if (innerText === null || textContent === null) return { status: 'surface_unknown', reason: 'text_representation_unavailable', page_url: location.href, ready_state: document.readyState };
      const attrs = {};
      for (const name of ATTRS) {
        const value = entry.node.getAttribute(name);
        if (typeof value === 'string') attrs[name] = head(value);
      }
      const unique = Boolean(entry.rawMessageId && messageIdCounts.get(entry.rawMessageId) === 1);
      nodes.push({
        role: entry.role,
        ordinal: entry.ordinal,
        document_ordinal: entry.documentOrdinal,
        message_id: unique ? entry.rawMessageId : null,
        message_id_unique: unique,
        attributes: attrs,
        innerText: await digest(innerText),
        textContent: await digest(textContent),
      });
    }
    const lastAssistant = [...observed].reverse().find((entry) => entry.role === 'assistant');
    let lastDigest = null;
    if (lastAssistant) {
      const lastInnerText = typeof lastAssistant.node.innerText === 'string' ? lastAssistant.node.innerText : null;
      if (lastInnerText === null) return { status: 'surface_unknown', reason: 'last_assistant_text_unavailable', page_url: location.href, ready_state: document.readyState };
      lastDigest = await digest(lastInnerText.replace(/\\s+/gu, ' ').trim());
    }
    let generating = 'unknown';
    try {
      generating = Boolean(
        document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="tool"][data-state="running"], [data-testid*="tool"][data-state="loading"]')
      );
    } catch {
      generating = 'unknown';
    }
    return {
      status: 'ok',
      page_url: location.href,
      ready_state: document.readyState,
      title: head(document.title || ''),
      generation_in_progress: generating,
      observed_user_nodes: roleCounts.user,
      observed_assistant_nodes: roleCounts.assistant,
      observed_message_nodes: observed.length,
      nodes,
      nodes_truncated: observed.length > MAX_NODES,
      last_assistant_text_length: lastDigest ? lastDigest.code_point_length : 0,
      last_assistant_text_byte_length: lastDigest ? lastDigest.byte_length : 0,
      last_assistant_text_head: lastDigest ? lastDigest.head : '',
      last_assistant_sha256: lastDigest ? lastDigest.sha256 : null,
    };
  })()`;
}

export const INSPECTION_EXPRESSION = inspectionExpression();

export const LIVENESS_EXPRESSION = `(() => ({
  status: 'ok',
  ready_state: document.readyState,
  page_url: location.href,
}))()`;

export const HARVEST_EXPRESSION = `(async () => {
  const raw = Array.from(document.querySelectorAll('[data-message-author-role]'));
  const roleCounts = { user: 0, assistant: 0 };
  const rows = [];
  for (let documentOrdinal = 0; documentOrdinal < raw.length; documentOrdinal++) {
    const node = raw[documentOrdinal];
    const role = node.getAttribute('data-message-author-role');
    if (role !== 'user' && role !== 'assistant') continue;
    const text = typeof node.innerText === 'string' ? node.innerText : null;
    if (text === null) return { status: 'surface_unknown', reason: 'text_representation_unavailable', page_url: location.href };
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    let completion_ready = null;
    if (role === 'assistant') {
      try {
        const turn = node.closest(${JSON.stringify(CONVERSATION_TURN_SECTION_SELECTOR)}) || node;
        completion_ready = !turn.querySelector(${JSON.stringify(ASSISTANT_TURN_IN_PROGRESS_SELECTOR)})
          && Boolean(turn.querySelector(${JSON.stringify(ASSISTANT_TURN_ACTION_SELECTOR)}));
      } catch {
        completion_ready = false;
      }
    }
    rows.push({
      role,
      ordinal: roleCounts[role]++,
      document_ordinal: documentOrdinal,
      message_id: node.getAttribute('data-message-id'),
      text,
      byte_length: bytes.byteLength,
      sha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(''),
      completion_ready,
    });
  }
  if (rows.length === 0) return { status: 'surface_unknown', reason: 'message_nodes_missing', page_url: location.href };
  let generation_in_progress = 'unknown';
  try {
    generation_in_progress = Boolean(document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="tool"][data-state="running"], [data-testid*="tool"][data-state="loading"]'));
  } catch {
    generation_in_progress = 'unknown';
  }
  return { status: 'ok', page_url: location.href, generation_in_progress, rows };
})()`;

interface LivenessRow {
  readonly target_id: string;
  readonly normalized_url: string;
  readonly title: string;
  readonly liveness: 'responsive' | 'unresponsive' | 'unavailable';
  readonly reason: string;
}

function clockNow(deps: ProbeDependencies): number {
  return deps.now?.() ?? Date.now();
}

function delay(deps: ProbeDependencies, milliseconds: number): Promise<void> {
  if (deps.sleep) return deps.sleep(milliseconds);
  return new Promise((resolve) => {
    const timer = deps.setTimeout ?? setTimeout;
    timer(resolve, milliseconds);
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  deps: ProbeDependencies,
  reason: string,
): Promise<T> {
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      reject(new ProbeError('unavailable', reason));
    }, milliseconds);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      reject(error);
    });
  });
}

function readinessKey(snapshot: InspectionSnapshot): string {
  return JSON.stringify({
    observed_user_nodes: snapshot.observed_user_nodes,
    user_nodes: snapshot.nodes
      .filter((node) => node.role === 'user')
      .map((node) => ({
        ordinal: node.ordinal,
        document_ordinal: node.document_ordinal,
        message_id: node.message_id,
        innerText_sha256: node.innerText.sha256,
        textContent_sha256: node.textContent.sha256,
      })),
  });
}

function normalizedConversationIdentity(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.page_url !== 'string' || !isConversationUrl(value.page_url)) return undefined;
  try {
    const normalized = normalizeConversationUrl(value.page_url);
    return Array.from(normalized).length <= MAX_NORMALIZED_URL_CODE_POINTS ? normalized : undefined;
  } catch {
    return undefined;
  }
}

async function inspectWithReadiness(
  target: CompatibleTarget,
  requestedIdentity: string,
  deps: ProbeDependencies,
): Promise<InspectionSnapshot> {
  const deadline = clockNow(deps) + ACQUISITION_READINESS_TIMEOUT_MS;
  let previousKey: string | undefined;
  while (clockNow(deps) < deadline) {
    const remaining = deadline - clockNow(deps);
    if (remaining <= 0) break;
    let value: unknown;
    try {
      value = await withTimeout(
        deps.evaluate(target, INSPECTION_EXPRESSION, Math.min(CDP_REQUEST_TIMEOUT_MS, remaining)),
        remaining,
        deps,
        'readiness_sample_timeout',
      );
      if (clockNow(deps) >= deadline) throw new ProbeError('unavailable', 'readiness_sample_timeout');
    } catch (error) {
      if ((error instanceof ProbeError && error.reason === 'readiness_sample_timeout')
        || (error instanceof Error && error.message === 'cdp_evaluate_timeout')) {
        throw new ProbeError('surface_unknown', 'readiness_timeout');
      }
      throw new ProbeError('unavailable', 'target_read_unavailable', boundedDetail(error));
    }
    const actualIdentity = normalizedConversationIdentity(value);
    if (actualIdentity !== undefined && actualIdentity !== requestedIdentity) {
      throw new ProbeError('surface_unknown', 'conversation_identity_mismatch');
    }
    try {
      const snapshot = validateInspectionSnapshot(value, target, false);
      if (snapshot.page_url !== requestedIdentity) {
        throw new ProbeError('surface_unknown', 'conversation_identity_mismatch');
      }
      if (snapshot.ready_state !== 'loading') {
        const key = readinessKey(snapshot);
        if (key === previousKey) return snapshot;
        previousKey = key;
      } else {
        previousKey = undefined;
      }
    } catch (error) {
      if (!(error instanceof ProbeError) || error.status !== 'surface_unknown') throw error;
    }
    if (clockNow(deps) >= deadline) break;
    await delay(deps, Math.min(ACQUISITION_READINESS_INTERVAL_MS, Math.max(0, deadline - clockNow(deps))));
  }
  throw new ProbeError('surface_unknown', 'readiness_timeout');
}

function validateCreatedTarget(
  value: unknown,
  requestedIdentity: string,
  preExistingTargetIds: ReadonlySet<string>,
): CompatibleTarget {
  if (Array.isArray(value)) throw new ProbeError('unavailable', 'create_result_ambiguous');
  if (!isRecord(value)) throw new ProbeError('unavailable', 'create_result_malformed');
  const rawTarget = value as CdpTarget;
  if (rawTarget.type !== 'page'
    || typeof rawTarget.id !== 'string'
    || !TARGET_ID_RE.test(rawTarget.id)
    || preExistingTargetIds.has(rawTarget.id)) {
    throw new ProbeError('unavailable', preExistingTargetIds.has(rawTarget.id ?? '') ? 'create_result_contradictory' : 'create_result_malformed');
  }
  if (!isDebuggerWebSocketUrl(rawTarget.webSocketDebuggerUrl)) {
    throw new ProbeError('unavailable', 'create_target_websocket_unavailable');
  }
  let normalizedUrl = requestedIdentity;
  if (typeof rawTarget.url === 'string' && isCompatibleChatGptUrl(rawTarget.url)) {
    try {
      normalizedUrl = normalizeConversationUrl(rawTarget.url);
    } catch {
      normalizedUrl = requestedIdentity;
    }
  }
  return {
    target_id: rawTarget.id,
    normalized_url: normalizedUrl,
    title: safeTitle(rawTarget.title),
    web_socket_debugger_url: rawTarget.webSocketDebuggerUrl,
  };
}

async function inspectAcquiredUrl(
  args: ParsedInspectArgs,
  deps: ProbeDependencies,
): Promise<ProbeEnvelope> {
  const requestedIdentity = normalizeConversationUrl(args.conversationUrl!);
  const rawTargets = await listTargetCensus(args.cdp, deps);
  const targets = toCompatibleTargets(rawTargets);
  const preExistingTargetIds = new Set(
    rawTargets
      .filter((target) => typeof target.id === 'string' && TARGET_ID_RE.test(target.id))
      .map((target) => target.id as string),
  );
  const matches = targets.filter((target) => target.normalized_url === requestedIdentity);
  if (matches.length > 1) throw new ProbeError('ambiguous', 'target_url_ambiguous');
  if (matches.length === 1) {
    const target = matches[0]!;
    if (!target.web_socket_debugger_url) throw new ProbeError('unavailable', 'target_attach_unavailable');
    let value: unknown;
    try {
      value = await deps.evaluate(target, INSPECTION_EXPRESSION);
    } catch (error) {
      throw new ProbeError('unavailable', 'target_read_unavailable', boundedDetail(error));
    }
    const snapshot = validateInspectionSnapshot(value, target, true);
    return { ...baseEnvelope('inspect', 'ok'), target_id: target.target_id, acquisition: 'reused', snapshot };
  }
  if (!args.openIfMissing) throw new ProbeError('not_found', 'target_not_found');
  if (!deps.createPage) throw new ProbeError('unavailable', 'page_create_unavailable');

  let ownedTarget: CompatibleTarget;
  try {
    const created = await withTimeout(
      deps.createPage(args.cdp, requestedIdentity),
      CDP_REQUEST_TIMEOUT_MS,
      deps,
      'page_create_timeout',
    );
    ownedTarget = validateCreatedTarget(created, requestedIdentity, preExistingTargetIds);
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('unavailable', 'page_create_failed', boundedDetail(error));
  }

  let primaryError: ProbeError | undefined;
  let snapshot: InspectionSnapshot | undefined;
  try {
    snapshot = await inspectWithReadiness(ownedTarget, requestedIdentity, deps);
  } catch (error) {
    primaryError = error instanceof ProbeError
      ? error
      : new ProbeError('unavailable', 'target_read_unavailable', boundedDetail(error));
  }

  let cleanup: 'closed' | 'already_gone' | 'cleanup_failed';
  let cleanupDetail: string | undefined;
  try {
    if (!deps.closePage) throw new Error('page_close_unavailable');
    const result = await withTimeout(
      deps.closePage(args.cdp, ownedTarget.target_id),
      CDP_REQUEST_TIMEOUT_MS,
      deps,
      'page_close_timeout',
    );
    if (result !== 'closed' && result !== 'already_gone') throw new Error('invalid_close_result');
    cleanup = result;
  } catch (error) {
    cleanup = 'cleanup_failed';
    cleanupDetail = boundedDetail(error);
  }

  const details = {
    acquisition: 'created',
    owned_target_id: ownedTarget.target_id,
    readiness_timeout_ms: ACQUISITION_READINESS_TIMEOUT_MS,
    readiness_interval_ms: ACQUISITION_READINESS_INTERVAL_MS,
    cleanup,
    ...(cleanupDetail ? { cleanup_detail: cleanupDetail } : {}),
  };
  if (primaryError) {
    throw new ProbeError(primaryError.status, primaryError.reason, primaryError.message, details);
  }
  if (cleanup === 'cleanup_failed') {
    throw new ProbeError('cleanup_failed', 'cleanup_failed', cleanupDetail, details);
  }
  return {
    ...baseEnvelope('inspect', 'ok'),
    target_id: ownedTarget.target_id,
    acquisition: 'created',
    owned_target_id: ownedTarget.target_id,
    readiness_timeout_ms: ACQUISITION_READINESS_TIMEOUT_MS,
    readiness_interval_ms: ACQUISITION_READINESS_INTERVAL_MS,
    cleanup,
    snapshot,
  };
}

function livenessRow(
  target: CompatibleTarget,
  liveness: LivenessRow['liveness'],
  reason: string,
): LivenessRow {
  return {
    target_id: target.target_id,
    normalized_url: target.normalized_url,
    title: target.title,
    liveness,
    reason: boundedCodePoints(reason),
  };
}

async function settleLivenessTarget(target: CompatibleTarget, deps: ProbeDependencies): Promise<LivenessRow> {
  if (!target.web_socket_debugger_url) {
    return livenessRow(target, 'unavailable', 'target_websocket_unavailable');
  }
  try {
    const value = await withTimeout(
      deps.evaluate(target, LIVENESS_EXPRESSION, LIVENESS_TARGET_TIMEOUT_MS),
      LIVENESS_TARGET_TIMEOUT_MS,
      deps,
      'liveness_target_timeout',
    );
    if (!isRecord(value)
      || value.status !== 'ok'
      || (value.ready_state !== 'loading' && value.ready_state !== 'interactive' && value.ready_state !== 'complete')) {
      return livenessRow(target, 'unavailable', 'invalid_liveness_response');
    }
    return livenessRow(target, 'responsive', 'target_probe_ok');
  } catch (error) {
    if ((error instanceof ProbeError && error.reason === 'liveness_target_timeout')
      || (error instanceof Error && error.message === 'cdp_evaluate_timeout')) {
      return livenessRow(target, 'unresponsive', 'liveness_target_timeout');
    }
    return livenessRow(target, 'unavailable', boundedDetail(error));
  }
}

async function runLiveness(args: ParsedLivenessArgs, deps: ProbeDependencies): Promise<ProbeEnvelope> {
  if (CDP_REQUEST_TIMEOUT_MS + LIVENESS_TARGET_TIMEOUT_MS >= LIVENESS_TOTAL_TIMEOUT_MS) {
    throw new ProbeError('unavailable', 'invalid_liveness_deadline_constants');
  }
  const startedAt = clockNow(deps);
  let targets: CompatibleTarget[];
  try {
    const rawTargets = await withTimeout(
      deps.listTargets(args.cdp),
      CDP_REQUEST_TIMEOUT_MS,
      deps,
      'liveness_census_timeout',
    );
    targets = toCompatibleTargets(rawTargets);
  } catch (error) {
    if (error instanceof ProbeError && error.reason === 'liveness_census_timeout') throw error;
    throw new ProbeError('unavailable', 'cdp_unavailable', boundedDetail(error));
  }
  const admitted = targets.slice(0, LIVENESS_FAN_OUT);
  const rows = await Promise.all(admitted.map((target) => settleLivenessTarget(target, deps)));
  const elapsed = clockNow(deps) - startedAt;
  return {
    ...baseEnvelope('liveness', 'ok'),
    targets: rows,
    targets_truncated: targets.length > LIVENESS_FAN_OUT,
    observed_compatible_targets: targets.length,
    unresponsive_target_ids: rows.filter((row) => row.liveness === 'unresponsive').map((row) => row.target_id),
    liveness_fan_out: LIVENESS_FAN_OUT,
    liveness_target_timeout_ms: LIVENESS_TARGET_TIMEOUT_MS,
    liveness_total_timeout_ms: LIVENESS_TOTAL_TIMEOUT_MS,
    liveness_elapsed_ms: Math.max(0, elapsed),
    liveness_total_deadline_exceeded: elapsed > LIVENESS_TOTAL_TIMEOUT_MS,
  };
}

export interface ExportWitness {
  readonly role: MessageRole;
  readonly ordinal: number;
  readonly messageId?: string;
  readonly representation: TextRepresentation;
  readonly expectedByteLength: number;
  readonly expectedSha256: string;
}

export function buildExportExpression(witness: ExportWitness): string {
  const encoded = Buffer.from(JSON.stringify(witness), 'utf8').toString('base64');
  return `(async () => {
    const witness = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'), (c) => c.charCodeAt(0))));
    const raw = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const roleCounts = { user: 0, assistant: 0 };
    const nodes = raw.map((node, documentOrdinal) => {
      const role = node.getAttribute('data-message-author-role');
      if (role !== 'user' && role !== 'assistant') return null;
      const ordinal = roleCounts[role]++;
      return { node, role, ordinal, documentOrdinal, messageId: node.getAttribute('data-message-id') };
    }).filter(Boolean);
    if (nodes.length === 0) return { status: 'surface_unknown', reason: 'message_nodes_missing' };
    const idCounts = new Map();
    for (const entry of nodes) if (entry.messageId) idCounts.set(entry.messageId, (idCounts.get(entry.messageId) || 0) + 1);
    let candidates;
    if (witness.messageId) {
      candidates = nodes.filter((entry) => entry.messageId === witness.messageId);
      if (candidates.length === 0) return { status: 'not_found', reason: 'message_id_not_found' };
      if (candidates.length > 1) return { status: 'ambiguous', reason: 'message_id_ambiguous' };
    } else {
      candidates = nodes.filter((entry) => entry.role === witness.role && entry.ordinal === witness.ordinal);
      if (candidates.length === 0) return { status: 'not_found', reason: 'role_ordinal_not_found' };
      if (candidates.length > 1) return { status: 'ambiguous', reason: 'role_ordinal_ambiguous' };
    }
    const candidate = candidates[0];
    if (candidate.role !== witness.role || candidate.ordinal !== witness.ordinal) return { status: 'stale_node', reason: 'role_ordinal_changed' };
    if (witness.messageId && candidate.messageId !== witness.messageId) return { status: 'stale_node', reason: 'message_id_changed' };
    if (!witness.messageId && candidate.messageId && idCounts.get(candidate.messageId) === 1) return { status: 'stale_node', reason: 'message_id_required' };
    const text = witness.representation === 'innerText'
      ? (typeof candidate.node.innerText === 'string' ? candidate.node.innerText : null)
      : (typeof candidate.node.textContent === 'string' ? candidate.node.textContent : null);
    if (text === null) return { status: 'surface_unknown', reason: 'text_representation_unavailable' };
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== witness.expectedByteLength || sha256 !== witness.expectedSha256) return { status: 'stale_node', reason: 'representation_witness_mismatch' };
    return {
      status: 'ok',
      page_url: location.href,
      title: Array.from(document.title || '').slice(0, ${MAX_TEXT_CODE_POINTS}).join(''),
      role: candidate.role,
      ordinal: candidate.ordinal,
      document_ordinal: candidate.documentOrdinal,
      message_id: witness.messageId || null,
      representation: witness.representation,
      byte_length: bytes.byteLength,
      sha256,
      text,
    };
  })()`;
}

function resolveTargetById(targets: readonly CompatibleTarget[], targetId: string): CompatibleTarget {
  const matches = targets.filter((target) => target.target_id === targetId);
  if (matches.length === 0) throw new ProbeError('not_found', 'target_not_found');
  if (matches.length > 1) throw new ProbeError('ambiguous', 'target_id_ambiguous');
  return matches[0]!;
}

function resolveTargetByUrl(targets: readonly CompatibleTarget[], conversationUrl: string): CompatibleTarget {
  const normalized = normalizeConversationUrl(conversationUrl);
  const matches = targets.filter((target) => target.normalized_url === normalized);
  if (matches.length === 0) throw new ProbeError('not_found', 'target_not_found');
  if (matches.length > 1) throw new ProbeError('ambiguous', 'target_url_ambiguous');
  return matches[0]!;
}

async function listTargetCensus(cdp: string, deps: ProbeDependencies): Promise<readonly CdpTarget[]> {
  try {
    return await withTimeout(deps.listTargets(cdp), CDP_REQUEST_TIMEOUT_MS, deps, 'target_census_timeout');
  } catch (error) {
    throw new ProbeError('unavailable', 'cdp_unavailable', boundedDetail(error));
  }
}

async function availableTargets(cdp: string, deps: ProbeDependencies): Promise<CompatibleTarget[]> {
  return toCompatibleTargets(await listTargetCensus(cdp, deps));
}

function requireActualTargetIdentity(
  target: CompatibleTarget,
  rawPageUrl: string | undefined,
  requireResolvedUrlMatch: boolean,
): string {
  if (!rawPageUrl || !isCompatibleChatGptUrl(rawPageUrl)) {
    throw new ProbeError('surface_unknown', 'page_url_unavailable');
  }
  const actual = normalizeConversationUrl(rawPageUrl);
  if (Array.from(actual).length > MAX_NORMALIZED_URL_CODE_POINTS) {
    throw new ProbeError('surface_unknown', 'page_url_too_long');
  }
  if (requireResolvedUrlMatch && actual !== target.normalized_url) {
    throw new ProbeError('not_found', 'target_url_changed');
  }
  return actual;
}

function validateHarvestSnapshot(value: unknown, target: CompatibleTarget): HarvestSnapshot {
  if (!isRecord(value)) return malformedSurface('malformed_harvest_snapshot');
  if (value.status === 'surface_unknown') {
    throw new ProbeError('surface_unknown', typeof value.reason === 'string' ? value.reason : 'harvest_surface_unknown');
  }
  if (value.status !== 'ok'
    || typeof value.page_url !== 'string'
    || (typeof value.generation_in_progress !== 'boolean' && value.generation_in_progress !== 'unknown')
    || !Array.isArray(value.rows)) {
    return malformedSurface('malformed_harvest_snapshot');
  }
  const pageUrl = requireActualTargetIdentity(target, value.page_url, false);
  const rows: HarvestRow[] = [];
  let previousDocumentOrdinal = -1;
  for (const raw of value.rows) {
    if (!isRecord(raw)
      || (raw.role !== 'user' && raw.role !== 'assistant')
      || !isNonNegativeSafeInteger(raw.ordinal)
      || !isNonNegativeSafeInteger(raw.document_ordinal)
      || raw.document_ordinal <= previousDocumentOrdinal
      || (raw.message_id !== null && (typeof raw.message_id !== 'string' || !MESSAGE_ID_RE.test(raw.message_id)))
      || typeof raw.text !== 'string'
      || !isNonNegativeSafeInteger(raw.byte_length)
      || !isSha256(raw.sha256)
      || (raw.role === 'assistant' ? typeof raw.completion_ready !== 'boolean' : raw.completion_ready !== null)) {
      return malformedSurface('malformed_harvest_snapshot');
    }
    const bytes = Buffer.from(raw.text, 'utf8');
    if (bytes.byteLength !== raw.byte_length || hashBytes(bytes) !== raw.sha256) {
      throw new ProbeError('stale_node', 'harvest_page_host_witness_mismatch');
    }
    previousDocumentOrdinal = raw.document_ordinal;
    rows.push({
      role: raw.role,
      ordinal: raw.ordinal,
      document_ordinal: raw.document_ordinal,
      message_id: raw.message_id,
      text: raw.text,
      byte_length: raw.byte_length,
      sha256: raw.sha256,
      completion_ready: raw.completion_ready as boolean | null,
    });
  }
  return {
    page_url: pageUrl,
    generation_in_progress: value.generation_in_progress,
    rows,
  };
}

async function readHarvestSnapshot(target: CompatibleTarget, deps: ProbeDependencies): Promise<HarvestSnapshot> {
  if (!target.web_socket_debugger_url) throw new ProbeError('unavailable', 'target_attach_unavailable');
  let value: unknown;
  try {
    value = await deps.evaluate(target, HARVEST_EXPRESSION);
  } catch (error) {
    throw new ProbeError('unavailable', 'target_read_unavailable', boundedDetail(error));
  }
  return validateHarvestSnapshot(value, target);
}

function ownedHarvestWindow(snapshot: HarvestSnapshot, marker: string): {
  readonly owned: HarvestRow;
  readonly assistants: readonly HarvestRow[];
} | null {
  const markerCardinality = recoveryMarkerCardinality(snapshot.rows, marker);
  if (markerCardinality.matchingUserCarrierCount > 1 || markerCardinality.exactMarkerTokenCount > 1) {
    throw new ProbeError('ambiguous', 'owned_turn_marker_ambiguous');
  }
  const owned = snapshot.rows.filter((row) => row.role === 'user' && ownedPromptMatches(row.text, marker));
  if (owned.length === 0) return null;
  if (owned.length > 1 || markerCardinality.exactMarkerTokenCount !== 1) {
    throw new ProbeError('ambiguous', 'owned_turn_marker_ambiguous');
  }
  const index = snapshot.rows.indexOf(owned[0]!);
  const suffix = snapshot.rows.slice(index + 1);
  const nextUser = suffix.findIndex((row) => row.role === 'user');
  const window = nextUser >= 0 ? suffix.slice(0, nextUser) : suffix;
  return { owned: owned[0]!, assistants: window.filter((row) => row.role === 'assistant') };
}

function harvestReadinessKey(snapshot: HarvestSnapshot, marker: string): string | undefined {
  const window = ownedHarvestWindow(snapshot, marker);
  if (!window) return undefined;
  return JSON.stringify({
    page_url: snapshot.page_url,
    owned: {
      ordinal: window.owned.ordinal,
      document_ordinal: window.owned.document_ordinal,
      message_id: window.owned.message_id,
      byte_length: window.owned.byte_length,
      sha256: window.owned.sha256,
    },
  });
}

function sameHarvestRow(left: HarvestRow, right: HarvestRow): boolean {
  return left.role === right.role
    && left.ordinal === right.ordinal
    && left.document_ordinal === right.document_ordinal
    && left.message_id === right.message_id
    && left.byte_length === right.byte_length
    && left.sha256 === right.sha256
    && left.text === right.text
    && left.completion_ready === right.completion_ready;
}

async function confirmStableHarvestCompletion(
  target: CompatibleTarget,
  marker: string,
  initialSnapshot: HarvestSnapshot,
  initialWindow: { readonly owned: HarvestRow; readonly assistants: readonly HarvestRow[] },
  deps: ProbeDependencies,
): Promise<HarvestRow> {
  const initialAssistant = initialWindow.assistants.at(-1);
  if (!initialAssistant || initialAssistant.text.trim().length === 0) {
    throw new ProbeError('surface_unknown', 'harvest_completion_empty');
  }
  if (initialSnapshot.generation_in_progress !== false || initialAssistant.completion_ready !== true) {
    throw new ProbeError('surface_unknown', 'harvest_completion_unproven');
  }

  await delay(deps, HARVEST_COMPLETION_CONFIRM_INTERVAL_MS);
  const confirmedSnapshot = await readHarvestSnapshot(target, deps);
  const confirmedWindow = ownedHarvestWindow(confirmedSnapshot, marker);
  if (!confirmedWindow) throw new ProbeError('surface_unknown', 'harvest_completion_ownership_changed');
  const confirmedClassifier = classifyBrowserGptPageTurnStatus(
    confirmedSnapshot.generation_in_progress,
    confirmedWindow.assistants.length,
  );
  const confirmedAssistant = confirmedWindow.assistants.at(-1);
  if (confirmedClassifier !== 'completed'
    || !confirmedAssistant
    || confirmedAssistant.completion_ready !== true
    || confirmedAssistant.text.trim().length === 0
    || confirmedSnapshot.page_url !== initialSnapshot.page_url
    || !sameHarvestRow(initialWindow.owned, confirmedWindow.owned)
    || !sameHarvestRow(initialAssistant, confirmedAssistant)) {
    throw new ProbeError('surface_unknown', 'harvest_completion_unstable', undefined, {
      confirmed_classifier: confirmedClassifier,
    });
  }
  return confirmedAssistant;
}

async function harvestWithReadiness(
  target: CompatibleTarget,
  requestedIdentity: string,
  marker: string,
  deps: ProbeDependencies,
): Promise<HarvestSnapshot> {
  const deadline = clockNow(deps) + ACQUISITION_READINESS_TIMEOUT_MS;
  let previousKey: string | undefined;
  while (clockNow(deps) < deadline) {
    const remaining = deadline - clockNow(deps);
    if (remaining <= 0) break;
    let value: unknown;
    try {
      value = await withTimeout(
        deps.evaluate(target, HARVEST_EXPRESSION, Math.min(CDP_REQUEST_TIMEOUT_MS, remaining)),
        remaining,
        deps,
        'harvest_readiness_sample_timeout',
      );
      if (clockNow(deps) >= deadline) throw new ProbeError('unavailable', 'harvest_readiness_sample_timeout');
    } catch (error) {
      if ((error instanceof ProbeError && error.reason === 'harvest_readiness_sample_timeout')
        || (error instanceof Error && error.message === 'cdp_evaluate_timeout')) {
        throw new ProbeError('surface_unknown', 'harvest_readiness_timeout');
      }
      throw new ProbeError('unavailable', 'target_read_unavailable', boundedDetail(error));
    }
    const actualIdentity = normalizedConversationIdentity(value);
    if (actualIdentity !== undefined && actualIdentity !== requestedIdentity) {
      throw new ProbeError('surface_unknown', 'conversation_identity_mismatch');
    }
    try {
      const snapshot = validateHarvestSnapshot(value, target);
      if (snapshot.page_url === requestedIdentity) {
        const key = harvestReadinessKey(snapshot, marker);
        if (key !== undefined && key === previousKey) return snapshot;
        previousKey = key;
      } else {
        previousKey = undefined;
      }
    } catch (error) {
      if (!(error instanceof ProbeError) || error.status !== 'surface_unknown') throw error;
      previousKey = undefined;
    }
    if (clockNow(deps) >= deadline) break;
    await delay(deps, Math.min(ACQUISITION_READINESS_INTERVAL_MS, Math.max(0, deadline - clockNow(deps))));
  }
  throw new ProbeError('surface_unknown', 'harvest_readiness_timeout');
}

async function resolveHarvestTarget(
  args: ParsedHarvestArgs,
  marker: string,
  conversationUrl: string | null,
  deps: ProbeDependencies,
): Promise<{ target: CompatibleTarget; snapshot: HarvestSnapshot }> {
  const rawTargets = await listTargetCensus(args.cdp, deps);
  const targets = toCompatibleTargets(rawTargets);
  if (conversationUrl) {
    const normalized = normalizeConversationUrl(conversationUrl);
    const matches = targets.filter((target) => target.normalized_url === normalized);
    if (matches.length > 1) throw new ProbeError('ambiguous', 'owned_turn_url_ambiguous');
    if (matches.length === 1) {
      const target = matches[0]!;
      const snapshot = await readHarvestSnapshot(target, deps);
      if (snapshot.page_url !== normalized) {
        throw new ProbeError('surface_unknown', 'conversation_identity_mismatch');
      }
      return { target, snapshot };
    }
    if (!deps.createPage) throw new ProbeError('unavailable', 'page_create_unavailable');
    const preExistingTargetIds = new Set(rawTargets.flatMap((target) => typeof target.id === 'string' ? [target.id] : []));
    let created: CdpTarget | readonly CdpTarget[];
    try {
      created = await deps.createPage(args.cdp, normalized);
    } catch (error) {
      throw new ProbeError('unavailable', 'page_create_failed', boundedDetail(error));
    }
    const target = validateCreatedTarget(created, normalized, preExistingTargetIds);
    // Harvest never derives cleanup authority. A recovery-opened page is left
    // untouched for the caller/operator after this bounded readiness observation.
    return { target, snapshot: await harvestWithReadiness(target, normalized, marker, deps) };
  }

  const candidates: Array<{ target: CompatibleTarget; snapshot: HarvestSnapshot }> = [];
  for (const target of targets) {
    if (!target.web_socket_debugger_url) continue;
    let snapshot: HarvestSnapshot;
    try {
      snapshot = await readHarvestSnapshot(target, deps);
    } catch {
      continue;
    }
    if (ownedHarvestWindow(snapshot, marker)) candidates.push({ target, snapshot });
  }
  if (candidates.length === 0) throw new ProbeError('not_found', 'owned_turn_unbound_not_found');
  if (candidates.length > 1) throw new ProbeError('ambiguous', 'owned_turn_marker_ambiguous');
  return candidates[0]!;
}

async function runHarvest(args: ParsedHarvestArgs, deps: ProbeDependencies): Promise<ProbeEnvelope> {
  const profileKey = configuredProfileKey(args.profile, args.cdp);
  let record;
  try {
    record = readStateLightTurnObservation(profileKey, args.invocationId);
  } catch (error) {
    throw new ProbeError('not_found', 'observation_not_found', boundedDetail(error));
  }
  if (record.phase === 'not_sent') {
    throw new ProbeError('not_found', 'owned_turn_not_sent', undefined, { observation_phase: record.phase });
  }
  if (record.primary && record.primary.target !== resolve(args.output)) {
    throw new ProbeError('unsafe_output', 'primary_binding_target_conflict', undefined, {
      bound_target: record.primary.target,
      requested_target: resolve(args.output),
    });
  }

  const resolved = await resolveHarvestTarget(args, record.marker, record.conversation_url, deps);
  const window = ownedHarvestWindow(resolved.snapshot, record.marker);
  if (!window) throw new ProbeError('not_found', 'owned_turn_marker_not_found');
  const classifier = classifyBrowserGptPageTurnStatus(
    resolved.snapshot.generation_in_progress,
    window.assistants.length,
  );

  const recoveredConversationUrl = isSupportedChatGptConversationUrl(resolved.snapshot.page_url)
    ? resolved.snapshot.page_url
    : undefined;
  if (record.phase === 'dispatching') {
    transitionStateLightTurnObservation({
      profileKey,
      invocationId: args.invocationId,
      phase: record.conversation_url !== null || recoveredConversationUrl !== undefined
        ? 'sent_unharvested'
        : 'sent_unbound',
      reason: record.conversation_url === null && recoveredConversationUrl !== undefined
        ? 'harvest_marker_locator_bound'
        : 'harvest_marker_send_recovered',
      sendWitness: record.send_witness === 'numeric_send_count' ? undefined : 'owned_marker',
      ...(record.conversation_url === null && recoveredConversationUrl !== undefined
        ? { conversationUrl: recoveredConversationUrl }
        : {}),
    });
    record = readStateLightTurnObservation(profileKey, args.invocationId);
  } else if (record.conversation_url === null && recoveredConversationUrl !== undefined) {
    transitionStateLightTurnObservation({
      profileKey,
      invocationId: args.invocationId,
      phase: 'sent_unharvested',
      reason: 'harvest_marker_locator_bound',
      sendWitness: record.send_witness === 'numeric_send_count' ? undefined : 'owned_marker',
      conversationUrl: recoveredConversationUrl,
    });
    record = readStateLightTurnObservation(profileKey, args.invocationId);
  }

  if (classifier === 'dead') {
    throw new ProbeError('not_found', 'owned_turn_dead', undefined, {
      classifier,
      observation_phase: record.phase,
      conversation_url: record.conversation_url,
    });
  }
  if (classifier === 'long_running' || classifier === 'unknown') {
    return {
      ...baseEnvelope('harvest', 'ok'),
      classifier,
      harvested: false,
      observation_phase: record.phase,
      conversation_url: record.conversation_url,
      target_id: resolved.target.target_id,
    };
  }

  const assistant = await confirmStableHarvestCompletion(
    resolved.target,
    record.marker,
    resolved.snapshot,
    window,
    deps,
  );
  const bytes = Buffer.from(assistant.text, 'utf8');
  if (bytes.byteLength !== assistant.byte_length || hashBytes(bytes) !== assistant.sha256) {
    throw new ProbeError('stale_node', 'harvest_page_host_witness_mismatch');
  }

  const finalized = await finalizeStateLightPrimaryPublication({
    profileKey,
    invocationId: args.invocationId,
    target: args.output,
    bytes,
    publish: async () => {
      if (deps.publishPrimary) {
        try {
          return await deps.publishPrimary(args.output, args.invocationId, assistant.text);
        } catch (error) {
          return { state: 'error' as const, cause: boundedDetail(error) };
        }
      }
      try {
        await deps.publish(args.output, bytes);
        return {
          state: 'committed_ok' as const,
          output_bytes: bytes.byteLength,
          output_sha256: hashBytes(bytes),
        };
      } catch (error) {
        if (error instanceof ProbeError
          && (error.reason === 'destination_exists'
            || (error.reason === 'exclusive_create_refused' && /EEXIST/u.test(error.message)))) {
          return { state: 'conflict' as const, cause: 'output_exists' };
        }
        return { state: 'error' as const, cause: boundedDetail(error) };
      }
    },
  });
  if (finalized.state !== 'committed_ok') {
    throw new ProbeError(
      finalized.state === 'conflict' ? 'unsafe_output' : 'export_failed',
      finalized.cause ?? 'harvest_publication_failed',
      undefined,
      {
        expected_byte_length: finalized.expected_byte_length,
        expected_sha256: finalized.expected_sha256,
        ...(finalized.observed_byte_length !== undefined ? { observed_byte_length: finalized.observed_byte_length } : {}),
        ...(finalized.observed_sha256 !== undefined ? { observed_sha256: finalized.observed_sha256 } : {}),
        ...(finalized.retirement_cleanup_required ? { retirement_cleanup_required: true } : {}),
      },
    );
  }
  const harvested = readStateLightTurnObservation(profileKey, args.invocationId);
  return {
    ...baseEnvelope('harvest', 'ok'),
    classifier,
    harvested: true,
    observation_phase: harvested.phase,
    conversation_url: harvested.conversation_url,
    target_id: resolved.target.target_id,
    node: {
      role: assistant.role,
      ordinal: assistant.ordinal,
      document_ordinal: assistant.document_ordinal,
      message_id: assistant.message_id,
    },
    output: resolve(args.output),
    byte_length: bytes.byteLength,
    sha256: hashBytes(bytes),
    converged: finalized.converged === true,
    ...(finalized.retirement_cleanup_required ? { retirement_cleanup_required: true } : {}),
    workflow_authority: 'none',
  };
}

export async function runProbe(args: ParsedArgs, deps: ProbeDependencies = defaultDependencies): Promise<ProbeEnvelope> {
  if (args.operation === 'list') {
    const targets = await availableTargets(args.cdp, deps);
    const truncated = targets.length > MAX_TARGETS;
    return {
      ...baseEnvelope('list', 'ok'),
      targets: targets.slice(0, MAX_TARGETS).map(({ target_id, normalized_url, title }) => ({ target_id, normalized_url, title })),
      targets_truncated: truncated,
      observed_compatible_targets: targets.length,
    };
  }

  if (args.operation === 'liveness') return runLiveness(args, deps);
  if (args.operation === 'harvest') return runHarvest(args, deps);
  if (args.operation === 'inspect' && args.conversationUrl && args.openIfMissing) {
    return inspectAcquiredUrl(args, deps);
  }

  const targets = await availableTargets(args.cdp, deps);
  const resolvedByUrl = args.operation === 'inspect' && !args.targetId;
  const target = args.operation === 'inspect'
    ? (args.targetId ? resolveTargetById(targets, args.targetId) : resolveTargetByUrl(targets, args.conversationUrl!))
    : resolveTargetById(targets, args.targetId);
  if (!target.web_socket_debugger_url) throw new ProbeError('unavailable', 'target_attach_unavailable');

  if (args.operation === 'inspect') {
    let value: unknown;
    try {
      value = await deps.evaluate(target, INSPECTION_EXPRESSION);
    } catch (error) {
      throw new ProbeError('unavailable', 'target_read_unavailable', boundedDetail(error));
    }
    const result = validateInspectionSnapshot(value, target, resolvedByUrl);
    return { ...baseEnvelope('inspect', 'ok'), target_id: target.target_id, snapshot: result };
  }

  const witness: ExportWitness = {
    role: args.role,
    ordinal: args.ordinal,
    ...(args.messageId ? { messageId: args.messageId } : {}),
    representation: args.representation,
    expectedByteLength: args.expectedByteLength,
    expectedSha256: args.expectedSha256,
  };
  let value: unknown;
  try {
    value = await deps.evaluate(target, buildExportExpression(witness));
  } catch (error) {
    throw new ProbeError('unavailable', 'target_read_unavailable', boundedDetail(error));
  }
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new ProbeError('surface_unknown', 'malformed_export_snapshot');
  }
  const allowedFailureStatuses = new Set(['not_found', 'ambiguous', 'stale_node', 'surface_unknown']);
  if (value.status !== 'ok') {
    if (!allowedFailureStatuses.has(value.status)) {
      throw new ProbeError('surface_unknown', 'malformed_export_snapshot');
    }
    const reason = isBoundedString(value.reason, MAX_TEXT_CODE_POINTS) ? value.reason : 'export_selection_failed';
    throw new ProbeError(value.status as Extract<ProbeStatus, 'not_found' | 'ambiguous' | 'stale_node' | 'surface_unknown'>, reason);
  }
  if (!isBoundedString(value.page_url, MAX_NORMALIZED_URL_CODE_POINTS)
    || value.role !== args.role
    || value.ordinal !== args.ordinal
    || !isNonNegativeSafeInteger(value.document_ordinal)
    || value.message_id !== (args.messageId ?? null)
    || value.representation !== args.representation
    || value.byte_length !== args.expectedByteLength
    || value.sha256 !== args.expectedSha256
    || typeof value.text !== 'string') {
    throw new ProbeError('stale_node', 'inspection_witness_mismatch');
  }
  const pageUrl = requireActualTargetIdentity(target, value.page_url, false);
  const bytes = Buffer.from(value.text, 'utf8');
  const hostSha256 = hashBytes(bytes);
  if (bytes.byteLength !== args.expectedByteLength || hostSha256 !== args.expectedSha256) {
    throw new ProbeError('stale_node', 'inspection_witness_mismatch');
  }
  try {
    await deps.publish(args.output, bytes);
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('export_failed', 'file_publication_failed', boundedDetail(error));
  }
  return {
    ...baseEnvelope('export', 'ok'),
    target_id: target.target_id,
    page_url: pageUrl,
    node: {
      role: args.role,
      ordinal: args.ordinal,
      document_ordinal: value.document_ordinal,
      message_id: args.messageId ?? null,
    },
    representation: args.representation,
    inspection_witness: {
      expected_byte_length: args.expectedByteLength,
      expected_sha256: args.expectedSha256,
    },
    output: args.output,
    byte_length: bytes.byteLength,
    sha256: hostSha256,
    sensitive_caller_owned_output: true,
  };
}

function statusExitCode(status: ProbeStatus): number {
  return ({
    ok: 0,
    not_found: 2,
    ambiguous: 3,
    stale_node: 4,
    unsafe_output: 5,
    surface_unknown: 6,
    unavailable: 7,
    export_failed: 8,
    input_invalid: 9,
    cleanup_failed: 10,
  } satisfies Record<ProbeStatus, number>)[status];
}

export async function main(argv = process.argv.slice(2), deps: ProbeDependencies = defaultDependencies): Promise<number> {
  let operation: ProbeOperation = argv[0] === 'list'
    || argv[0] === 'inspect'
    || argv[0] === 'export'
    || argv[0] === 'liveness'
    || argv[0] === 'harvest'
    ? argv[0]
    : 'list';
  try {
    const parsed = parseCliArgs(argv);
    operation = parsed.operation;
    const result = await runProbe(parsed, deps);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return statusExitCode(result.status);
  } catch (error) {
    const probeError = error instanceof ProbeError
      ? error
      : new ProbeError('unavailable', 'unexpected_failure', boundedDetail(error));
    const result = {
      ...baseEnvelope(operation, probeError.status),
      reason: probeError.reason,
      detail: boundedDetail(probeError.message),
      ...(probeError.details ?? {}),
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return statusExitCode(probeError.status);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}