import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  classifyProductWall,
  NEW_CHAT_CONTROL_SELECTORS,
  normalizeConversationUrl,
  productStatusText,
  projectConversationUrlMatchesProject,
  type BrowserConfig,
  type ProductWallDiagnostic,
} from './ui-adapter.ts';
import type { TurnState } from './contracts.ts';
import { profileDirs, sha256 } from './storage-common.ts';

const STATE_LIGHT_FRESH_CLAIM_SCHEMA = 'state-light-fresh-claim/v1' as const;
const STATE_LIGHT_NEW_CHAT_SEND_SLOT_SCHEMA = 'state-light-new-chat-send-slot/v1' as const;
const STATE_LIGHT_ADVISORY_WALL_SCHEMA = 'state-light-advisory-wall/v1' as const;
const PRODUCT_WALL_PROBE_MS = 5_000;

export const STATE_LIGHT_FRESH_PREPARE_ATTEMPTS = 3;
export const STATE_LIGHT_FRESH_RECOVERY_ATTEMPTS = 2;
export const STATE_LIGHT_MAX_NAVIGATIONS_PER_INVOCATION = 10;
export const STATE_LIGHT_ADVISORY_WALL_TTL_MS = 5 * 60 * 1000;
export const STATE_LIGHT_FRESH_PREPARE_BACKOFF_BASE_MS = 250;
export const STATE_LIGHT_MAX_TIMEOUT_MS = 1_800_000;
/** Shared Playwright navigation budget for launcher-chain ChatGPT page loads. */
export const STATE_LIGHT_NAVIGATION_TIMEOUT_MS = 120_000;
export const STATE_LIGHT_SEND_SLOT_TTL_MS = 2_100_000;
export const STATE_LIGHT_FRESH_CLAIM_GRACE_MS = 300_000;
export const STATE_LIGHT_PASSIVE_FRESH_CLAIM_TTL_MS = 3_900_000;
export const STATE_LIGHT_OWNERSHIP_RECOVERY_ATTEMPTS = 3;

const SEND_SLOT_POLL_MS = 50;
const OWNERSHIP_CLOCK_SKEW_MS = 60_000;
const ADVISORY_WALL_STATES = new Set<TurnState>(['rate_limit', 'quota', 'challenge', 'login']);

interface StateLightFreshClaimRecord {
  readonly schema: typeof STATE_LIGHT_FRESH_CLAIM_SCHEMA;
  readonly version: 1;
  readonly invocation_id: string;
  readonly conversation_id: string;
  readonly pid: number;
  readonly claimed_at: string;
  readonly expires_at?: string;
}

interface StateLightNewChatSendSlotRecord {
  readonly schema: typeof STATE_LIGHT_NEW_CHAT_SEND_SLOT_SCHEMA;
  readonly version: 1;
  readonly invocation_id: string;
  readonly pid: number;
  readonly acquired_at: string;
  readonly expires_at?: string;
}

interface StateLightAdvisoryWallRecord {
  readonly schema: typeof STATE_LIGHT_ADVISORY_WALL_SCHEMA;
  readonly version: 1;
  readonly wall_state: TurnState;
  readonly cause: string;
  readonly recorded_at: string;
  readonly expires_at: string;
  readonly invocation_id?: string;
  readonly matched_text?: string;
  readonly matched_selector?: string;
}

export type StateLightFreshConversationClaimResult = 'claimed' | 'owned' | 'contended';

export type StateLightFreshPrepareResult =
  | { state: 'ready' }
  | { state: 'ui_contract_mismatch'; cause: string };

export class StateLightNavigationCounter {
  readonly gotoCount = { value: 0 };
  readonly newChatClickCount = { value: 0 };
  readonly max: number;

  constructor(max = STATE_LIGHT_MAX_NAVIGATIONS_PER_INVOCATION) {
    this.max = max;
  }

  recordGoto(): void {
    this.gotoCount.value += 1;
    this.assertWithinBudget();
  }

  recordNewChatActivation(): void {
    this.newChatClickCount.value += 1;
    this.assertWithinBudget();
  }

  snapshotGoto(): number {
    return this.gotoCount.value;
  }

  snapshotNewChatClick(): number {
    return this.newChatClickCount.value;
  }

  snapshot(): number {
    return this.gotoCount.value + this.newChatClickCount.value;
  }

  private assertWithinBudget(): void {
    if (this.snapshot() > this.max) {
      throw new Error('state_light_navigation_budget_exhausted');
    }
  }
}

function claimErrnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function claimPidProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return claimErrnoCode(error) === 'ESRCH';
  }
}

export function projectConversationPrefix(projectUrl: string): string {
  return normalizeConversationUrl(projectUrl).replace(/\/+$/, '');
}

const CANONICAL_UUID_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STABLE_PROJECT_SEGMENT_RE = /^g-p-([0-9a-f]{32})(?:-[^/]+)?$/i;

function stableProjectId(segment: string): string | undefined {
  const match = STABLE_PROJECT_SEGMENT_RE.exec(segment);
  return match ? `g-p-${match[1]!.toLowerCase()}` : undefined;
}

function supportedChatGptUrl(value: string, allowLegacyConversationHost = false): URL | undefined {
  try {
    const url = new URL(normalizeConversationUrl(value));
    return (url.origin === 'https://chatgpt.com'
      || (allowLegacyConversationHost && url.origin === 'https://chat.openai.com'))
      && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

function projectSurfaceIdentity(value: string): string | undefined {
  const url = supportedChatGptUrl(value);
  const segment = url && /^\/g\/(g-p-[^/]+)(?:\/(?:project|draft))?$/i.exec(url.pathname)?.[1];
  return segment ? stableProjectId(segment) : undefined;
}

export function projectSurfaceUrlsEquivalent(observedUrl: string, projectUrl: string): boolean {
  const project = supportedChatGptUrl(projectUrl);
  const observed = supportedChatGptUrl(observedUrl);
  if (!project || !observed || project.origin !== observed.origin) return false;
  const expected = projectSurfaceIdentity(projectUrl);
  return expected !== undefined && projectSurfaceIdentity(observedUrl) === expected;
}

export function isBlankProjectSurfaceUrl(observedUrl: string, projectUrl: string): boolean {
  return observedUrl.trim().length > 0 && projectSurfaceUrlsEquivalent(observedUrl, projectUrl);
}

export function conversationUuidFromUrl(value: string): string | undefined {
  // Existing chat/cancellation receipts may still use the explicitly supported legacy host.
  // Fresh project identity and claim keys continue to require chatgpt.com only.
  const url = supportedChatGptUrl(value, true);
  const match = url && /\/c\/([^/]+)$/i.exec(url.pathname);
  return match && CANONICAL_UUID_PATH_RE.test(match[1]!) ? match[1]!.toLowerCase() : undefined;
}

function canonicalFreshConversationKey(conversationUrl: string): string | undefined {
  const url = supportedChatGptUrl(conversationUrl);
  const match = url && /^\/g\/(g-p-[^/]+)\/c\/([^/]+)$/i.exec(url.pathname);
  if (!match) return undefined;
  const stable = stableProjectId(match[1]!);
  if (!stable || !CANONICAL_UUID_PATH_RE.test(match[2]!)) return undefined;
  return `${url!.origin}/g/${stable}/c/${match[2]!.toLowerCase()}`;
}

export function ownedConversationIdentityMatches(observedUrl: string, targetChatUrl: string): boolean {
  const targetUuid = conversationUuidFromUrl(targetChatUrl);
  const observedUuid = conversationUuidFromUrl(observedUrl);
  if (targetUuid && observedUuid) return targetUuid === observedUuid;
  return normalizeConversationUrl(observedUrl) === normalizeConversationUrl(targetChatUrl);
}


export type StateLightOwnerFenceResult = 'valid' | 'lost';

function parseOwnershipTimestamp(value: string, nowMs: number): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed > nowMs + OWNERSHIP_CLOCK_SKEW_MS) return null;
  return parsed;
}

function parseExpiresAtTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function computeStateLightSendSlotExpiresAtMs(acquiredAtMs: number): number {
  return acquiredAtMs + STATE_LIGHT_SEND_SLOT_TTL_MS;
}

export function computeStateLightFreshClaimExpiresAtMs(
  claimedAtMs: number,
  acceptedTimeoutMs: number,
): number {
  const boundedTimeout = Math.min(acceptedTimeoutMs, STATE_LIGHT_MAX_TIMEOUT_MS);
  const activeTtl = (boundedTimeout * 2) + STATE_LIGHT_FRESH_CLAIM_GRACE_MS;
  return claimedAtMs + Math.min(activeTtl, STATE_LIGHT_PASSIVE_FRESH_CLAIM_TTL_MS);
}

function sendSlotExpiresAtMs(record: StateLightNewChatSendSlotRecord, nowMs: number): number | null {
  if (record.expires_at) {
    const explicit = parseExpiresAtTimestamp(record.expires_at);
    if (explicit !== null) return explicit;
  }
  const acquiredAt = parseOwnershipTimestamp(record.acquired_at, nowMs);
  if (acquiredAt === null) return null;
  return computeStateLightSendSlotExpiresAtMs(acquiredAt);
}

function freshClaimExpiresAtMs(
  record: StateLightFreshClaimRecord,
  acceptedTimeoutMs: number,
  nowMs: number,
): number | null {
  if (record.expires_at) {
    const explicit = parseExpiresAtTimestamp(record.expires_at);
    if (explicit !== null) return explicit;
  }
  const claimedAt = parseOwnershipTimestamp(record.claimed_at, nowMs);
  if (claimedAt === null) return null;
  return computeStateLightFreshClaimExpiresAtMs(claimedAt, acceptedTimeoutMs);
}

export function isStateLightSendSlotRecordExpired(
  record: StateLightNewChatSendSlotRecord,
  nowMs = Date.now(),
): boolean {
  const expiresAt = sendSlotExpiresAtMs(record, nowMs);
  return expiresAt === null || expiresAt <= nowMs;
}

export function isStateLightFreshClaimRecordExpired(
  record: StateLightFreshClaimRecord,
  acceptedTimeoutMs: number,
  nowMs = Date.now(),
): boolean {
  const expiresAt = freshClaimExpiresAtMs(record, acceptedTimeoutMs, nowMs);
  return expiresAt === null || expiresAt <= nowMs;
}

function isSendSlotRecordReclaimable(
  record: StateLightNewChatSendSlotRecord | null,
  invocationId: string,
  nowMs: number,
): boolean {
  if (!record) return false;
  if (record.invocation_id === invocationId) {
    return isStateLightSendSlotRecordExpired(record, nowMs);
  }
  if (isStateLightSendSlotRecordExpired(record, nowMs)) return true;
  return claimPidProvablyDead(record.pid);
}

function isFreshClaimRecordReclaimable(
  record: StateLightFreshClaimRecord | null,
  invocationId: string,
  acceptedTimeoutMs: number,
  nowMs: number,
): boolean {
  if (!record) return false;
  if (record.invocation_id === invocationId) {
    return isStateLightFreshClaimRecordExpired(record, acceptedTimeoutMs, nowMs);
  }
  if (isStateLightFreshClaimRecordExpired(record, acceptedTimeoutMs, nowMs)) return true;
  return claimPidProvablyDead(record.pid);
}

function atomicWriteOwnershipRecord(path: string, record: object): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readCorruptOwnershipArtifact<T>(
  path: string,
  readRecord: (path: string) => T | null,
): boolean {
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return true;
    JSON.parse(raw);
    return readRecord(path) === null;
  } catch {
    return true;
  }
}

function cleanupReclaimableOwnershipArtifact(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // fail-open cleanup
  }
}

export function verifyStateLightSendSlotOwnerFence(
  profileKey: string,
  invocationId: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): StateLightOwnerFenceResult {
  if (!newChatSendSlotEnabled(env)) return 'valid';
  const slotPath = stateLightNewChatSendSlotPath(profileKey);
  const record = existsSync(slotPath) ? readStateLightNewChatSendSlotRecord(slotPath) : null;
  if (!record) return 'lost';
  if (record.invocation_id !== invocationId || record.pid !== process.pid) return 'lost';
  return isStateLightSendSlotRecordExpired(record, nowMs) ? 'lost' : 'valid';
}

export function verifyStateLightFreshClaimOwnerFence(
  profileKey: string,
  conversationUrl: string,
  invocationId: string,
  acceptedTimeoutMs: number,
  nowMs = Date.now(),
): StateLightOwnerFenceResult {
  if (!canonicalFreshConversationKey(conversationUrl)) return 'lost';
  const claimPath = stateLightFreshClaimPath(profileKey, conversationUrl);
  const record = existsSync(claimPath) ? readStateLightFreshClaimRecord(claimPath) : null;
  if (!record) return 'lost';
  if (record.invocation_id !== invocationId || record.pid !== process.pid) return 'lost';
  return isStateLightFreshClaimRecordExpired(record, acceptedTimeoutMs, nowMs) ? 'lost' : 'valid';
}

function stateLightFreshClaimsDir(profileKey: string): string {
  const dir = join(profileDirs(profileKey).root, 'state-light-fresh-claims');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function stateLightFreshClaimPath(profileKey: string, conversationUrl: string): string {
  const key = canonicalFreshConversationKey(conversationUrl);
  // Invalid URLs cannot claim; the defensive path fallback is read-only for older callers.
  return join(stateLightFreshClaimsDir(profileKey), `${sha256(key ?? normalizeConversationUrl(conversationUrl))}.json`);
}

function equivalentLegacyClaimBlocks(
  profileKey: string,
  conversationUrl: string,
  invocationId: string,
  acceptedTimeoutMs: number,
  nowMs: number,
): boolean {
  const canonical = canonicalFreshConversationKey(conversationUrl);
  if (!canonical) return true;
  const directory = stateLightFreshClaimsDir(profileKey);
  const canonicalPath = stateLightFreshClaimPath(profileKey, canonical);
  const suppliedLegacyPath = join(directory, `${sha256(normalizeConversationUrl(conversationUrl))}.json`);
  let entries: string[];
  try {
    entries = readdirSync(directory).filter((name) => /^[0-9a-f]{64}\.json$/i.test(name));
  } catch {
    return true; // Unable to establish exclusion.
  }
  for (const filename of entries) {
    const path = join(directory, filename);
    if (path === canonicalPath) continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      // An unrelated corrupt claim is not an alias witness; a known URL key is.
      if (path === suppliedLegacyPath) return true;
      continue;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      if (path === suppliedLegacyPath) return true;
      continue;
    }
    const legacyUrl = (candidate as { conversation_id?: unknown }).conversation_id;
    const relevant = typeof legacyUrl === 'string'
      && canonicalFreshConversationKey(legacyUrl) === canonical;
    if (!relevant) {
      if (path === suppliedLegacyPath) return true;
      continue;
    }
    const record = readStateLightFreshClaimRecord(path);
    if (!record
      || filename !== `${sha256(normalizeConversationUrl(legacyUrl))}.json`) {
      return true; // Relevant conflicting or malformed evidence fails closed.
    }
    if (record.invocation_id !== invocationId
      && !isFreshClaimRecordReclaimable(record, invocationId, acceptedTimeoutMs, nowMs)) {
      return true;
    }
    // The old record is left untouched, even when expired or owned by this invocation.
  }
  return false;
}

function stateLightNewChatSendSlotPath(profileKey: string): string {
  return join(profileDirs(profileKey).locks, 'state-light-new-chat-send.slot');
}

function stateLightAdvisoryWallPath(profileKey: string): string {
  return join(profileDirs(profileKey).root, 'state-light-advisory-wall.json');
}

function readStateLightFreshClaimRecord(path: string): StateLightFreshClaimRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as StateLightFreshClaimRecord;
    if (value.schema !== STATE_LIGHT_FRESH_CLAIM_SCHEMA
      || value.version !== 1
      || typeof value.invocation_id !== 'string'
      || value.invocation_id.length === 0
      || typeof value.conversation_id !== 'string'
      || !Number.isInteger(value.pid)
      || value.pid <= 0
      || typeof value.claimed_at !== 'string'
      || parseOwnershipTimestamp(value.claimed_at, Date.now()) === null) {
      return null;
    }
    if (value.expires_at !== undefined
      && (typeof value.expires_at !== 'string'
        || parseExpiresAtTimestamp(value.expires_at) === null)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function readStateLightNewChatSendSlotRecord(path: string): StateLightNewChatSendSlotRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as StateLightNewChatSendSlotRecord;
    if (value.schema !== STATE_LIGHT_NEW_CHAT_SEND_SLOT_SCHEMA
      || value.version !== 1
      || typeof value.invocation_id !== 'string'
      || value.invocation_id.length === 0
      || !Number.isInteger(value.pid)
      || value.pid <= 0
      || typeof value.acquired_at !== 'string'
      || parseOwnershipTimestamp(value.acquired_at, Date.now()) === null) {
      return null;
    }
    if (value.expires_at !== undefined
      && (typeof value.expires_at !== 'string'
        || parseExpiresAtTimestamp(value.expires_at) === null)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function readStateLightAdvisoryWallRecord(path: string): StateLightAdvisoryWallRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as StateLightAdvisoryWallRecord;
    if (value.schema !== STATE_LIGHT_ADVISORY_WALL_SCHEMA
      || value.version !== 1
      || typeof value.wall_state !== 'string'
      || typeof value.cause !== 'string'
      || typeof value.recorded_at !== 'string'
      || typeof value.expires_at !== 'string'
      || !ADVISORY_WALL_STATES.has(value.wall_state)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function newChatSendSlotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OPK_STATE_LIGHT_DISABLE_NEW_CHAT_SEND_SLOT !== '1') return true;
  if (env.OPK_STATE_LIGHT_ALLOW_SEND_SLOT_DISABLE !== '1') return true;
  return String(env.OPK_STATE_LIGHT_SEND_SLOT_DISABLE_REASON ?? '').trim().length > 0
    ? false
    : true;
}

export function readStateLightAdvisoryWall(
  profileKey: string,
  nowMs = Date.now(),
): { state: TurnState; cause: string; matched_text: string; matched_selector: string } | null {
  const path = stateLightAdvisoryWallPath(profileKey);
  if (!existsSync(path)) return null;
  const record = readStateLightAdvisoryWallRecord(path);
  if (!record) return null;
  const expiresAt = Date.parse(record.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    try { rmSync(path, { force: true }); } catch { /* fail-open */ }
    return null;
  }
  return { state: record.wall_state, cause: record.cause, matched_text: record.matched_text ?? 'none', matched_selector: record.matched_selector ?? 'none' };
}

export function recordStateLightAdvisoryWall(
  profileKey: string,
  wallState: TurnState,
  cause: string,
  invocationId?: string,
  ttlMs = STATE_LIGHT_ADVISORY_WALL_TTL_MS,
  nowMs = Date.now(),
  diagnostic?: ProductWallDiagnostic,
): void {
  if (!ADVISORY_WALL_STATES.has(wallState)) return;
  const dir = profileDirs(profileKey).root;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record: StateLightAdvisoryWallRecord = {
    schema: STATE_LIGHT_ADVISORY_WALL_SCHEMA,
    version: 1,
    wall_state: wallState,
    cause,
    recorded_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    ...(invocationId ? { invocation_id: invocationId } : {}),
    matched_text: diagnostic?.matched_text ?? 'none',
    matched_selector: diagnostic?.matched_selector ?? 'none',
  };
  writeFileSync(stateLightAdvisoryWallPath(profileKey), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function tryClaimStateLightFreshConversation(
  profileKey: string,
  conversationUrl: string,
  invocationId: string,
  acceptedTimeoutMs: number = STATE_LIGHT_MAX_TIMEOUT_MS,
): StateLightFreshConversationClaimResult {
  if (!canonicalFreshConversationKey(conversationUrl)) return 'contended';
  const normalized = normalizeConversationUrl(conversationUrl);
  const claimPath = stateLightFreshClaimPath(profileKey, normalized);
  const boundedTimeout = Math.min(acceptedTimeoutMs, STATE_LIGHT_MAX_TIMEOUT_MS);
  for (let attempt = 0; attempt < STATE_LIGHT_OWNERSHIP_RECOVERY_ATTEMPTS; attempt++) {
    const nowMs = Date.now();
    if (equivalentLegacyClaimBlocks(profileKey, normalized, invocationId, boundedTimeout, nowMs)) {
      return 'contended';
    }
    // A malformed canonical claim must never be silently discarded or replaced.
    if (readCorruptOwnershipArtifact(claimPath, readStateLightFreshClaimRecord)) return 'contended';
    const existing = existsSync(claimPath) ? readStateLightFreshClaimRecord(claimPath) : null;
    if (existing) {
      if (existing.invocation_id === invocationId && !isStateLightFreshClaimRecordExpired(existing, boundedTimeout, nowMs)) {
        return 'owned';
      }
      if (!isFreshClaimRecordReclaimable(existing, invocationId, boundedTimeout, nowMs)) return 'contended';
      cleanupReclaimableOwnershipArtifact(claimPath);
    }
    const claimedAtMs = nowMs;
    const expiresAtMs = computeStateLightFreshClaimExpiresAtMs(claimedAtMs, boundedTimeout);
    const record: StateLightFreshClaimRecord = {
      schema: STATE_LIGHT_FRESH_CLAIM_SCHEMA,
      version: 1,
      invocation_id: invocationId,
      conversation_id: normalized,
      pid: process.pid,
      claimed_at: new Date(claimedAtMs).toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
    };
    try {
      atomicWriteOwnershipRecord(claimPath, record);
    } catch (error) {
      if (claimErrnoCode(error) === 'EEXIST') continue;
      throw error;
    }
    const reread = existsSync(claimPath) ? readStateLightFreshClaimRecord(claimPath) : null;
    if (reread?.invocation_id === invocationId
      && reread.pid === process.pid
      && !isStateLightFreshClaimRecordExpired(reread, boundedTimeout, Date.now())) {
      return 'claimed';
    }
  }
  return 'contended';
}

export function releaseStateLightFreshConversationClaim(
  profileKey: string,
  conversationUrl: string | undefined,
  invocationId: string,
  acceptedTimeoutMs: number = STATE_LIGHT_MAX_TIMEOUT_MS,
): void {
  if (!conversationUrl || !canonicalFreshConversationKey(conversationUrl)) return;
  const claimPath = stateLightFreshClaimPath(profileKey, normalizeConversationUrl(conversationUrl));
  const existing = existsSync(claimPath) ? readStateLightFreshClaimRecord(claimPath) : null;
  if (!existing) return;
  if (existing.invocation_id !== invocationId) return;
  if (isStateLightFreshClaimRecordExpired(existing, acceptedTimeoutMs, Date.now())) return;
  cleanupReclaimableOwnershipArtifact(claimPath);
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function acquireStateLightNewChatSendSlot(
  profileKey: string,
  invocationId: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!newChatSendSlotEnabled(env)) return;
  const slotPath = stateLightNewChatSendSlotPath(profileKey);
  const deadline = Date.now() + Math.min(timeoutMs, 120_000);
  while (Date.now() < deadline) {
    for (let attempt = 0; attempt < STATE_LIGHT_OWNERSHIP_RECOVERY_ATTEMPTS; attempt++) {
      const nowMs = Date.now();
      if (readCorruptOwnershipArtifact(slotPath, readStateLightNewChatSendSlotRecord)) {
        cleanupReclaimableOwnershipArtifact(slotPath);
      }
      const existing = existsSync(slotPath) ? readStateLightNewChatSendSlotRecord(slotPath) : null;
      if (existing?.invocation_id === invocationId && !isStateLightSendSlotRecordExpired(existing, nowMs)) {
        return;
      }
      if (existing && !isSendSlotRecordReclaimable(existing, invocationId, nowMs)) {
        break;
      }
      if (existing) cleanupReclaimableOwnershipArtifact(slotPath);
      const acquiredAtMs = nowMs;
      const record: StateLightNewChatSendSlotRecord = {
        schema: STATE_LIGHT_NEW_CHAT_SEND_SLOT_SCHEMA,
        version: 1,
        invocation_id: invocationId,
        pid: process.pid,
        acquired_at: new Date(acquiredAtMs).toISOString(),
        expires_at: new Date(computeStateLightSendSlotExpiresAtMs(acquiredAtMs)).toISOString(),
      };
      try {
        atomicWriteOwnershipRecord(slotPath, record);
      } catch (error) {
        if (claimErrnoCode(error) === 'EEXIST') break;
        throw error;
      }
      const reread = existsSync(slotPath) ? readStateLightNewChatSendSlotRecord(slotPath) : null;
      if (reread?.invocation_id === invocationId
        && reread.pid === process.pid
        && !isStateLightSendSlotRecordExpired(reread, Date.now())) {
        return;
      }
    }
    await sleepMs(Math.min(SEND_SLOT_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error('state_light_new_chat_send_slot_timeout');
}

export function releaseStateLightNewChatSendSlot(
  profileKey: string,
  invocationId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!newChatSendSlotEnabled(env)) return;
  const slotPath = stateLightNewChatSendSlotPath(profileKey);
  const existing = existsSync(slotPath) ? readStateLightNewChatSendSlotRecord(slotPath) : null;
  if (!existing) return;
  if (existing.invocation_id !== invocationId) return;
  if (isStateLightSendSlotRecordExpired(existing, Date.now())) return;
  cleanupReclaimableOwnershipArtifact(slotPath);
}

const FRESH_PREPARATION_DEADLINE_EXHAUSTED = 'fresh_preparation_deadline_exhausted';

function freshPreparationRemainingMs(deadlineMs: number | undefined, now: () => number): number {
  return deadlineMs === undefined ? Infinity : deadlineMs - now();
}

function requireFreshPreparationTime(deadlineMs: number | undefined, now: () => number): number {
  const remaining = freshPreparationRemainingMs(deadlineMs, now);
  if (remaining <= 0) throw new Error(FRESH_PREPARATION_DEADLINE_EXHAUSTED);
  return remaining;
}

/** A locator count() can hang without accepting a Playwright timeout. */
async function boundedFreshPreparation<T>(
  operation: () => Promise<T>,
  deadlineMs: number | undefined,
  now: () => number,
): Promise<T> {
  const remaining = requireFreshPreparationTime(deadlineMs, now);
  if (!Number.isFinite(remaining)) return operation();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(FRESH_PREPARATION_DEADLINE_EXHAUSTED)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeProductWall(
  page: any,
  deadlineMs?: number,
  now: () => number = Date.now,
): Promise<ProductWallDiagnostic> {
  const none: ProductWallDiagnostic = { wall_kind: 'none', matched_text: 'none', matched_selector: 'none' };
  try {
    const timeoutMs = Math.min(PRODUCT_WALL_PROBE_MS, 250, requireFreshPreparationTime(deadlineMs, now));
    const wall = classifyProductWall(await boundedFreshPreparation(
      () => productStatusText(page, timeoutMs), deadlineMs, now,
    ));
    return 'wall_kind' in wall ? wall : none;
  } catch {
    // Failed/late status probes are not fresh-conversation preparation failures.
    return none;
  }
}

export async function openBlankProjectChatSurface(
  page: any,
  projectUrl: string,
  navigation?: StateLightNavigationCounter,
  deadlineMs?: number,
  now: () => number = Date.now,
): Promise<void> {
  requireFreshPreparationTime(deadlineMs, now);
  const projectPrefix = projectConversationPrefix(projectUrl);
  let currentUrl = '';
  try {
    currentUrl = normalizeConversationUrl(page.url());
  } catch {
    currentUrl = '';
  }
  if (!isBlankProjectSurfaceUrl(currentUrl, projectUrl)) {
    const navigationMs = Math.min(STATE_LIGHT_NAVIGATION_TIMEOUT_MS, requireFreshPreparationTime(deadlineMs, now));
    navigation?.recordGoto();
    await boundedFreshPreparation(
      () => page.goto(projectPrefix, { waitUntil: 'commit', timeout: navigationMs }),
      deadlineMs,
      now,
    );
  }
  for (const selector of NEW_CHAT_CONTROL_SELECTORS) {
    requireFreshPreparationTime(deadlineMs, now);
    const control = page.locator(selector).first();
    try {
      if (Number(await boundedFreshPreparation(() => control.count(), deadlineMs, now)) <= 0) continue;
      const clickMs = Math.min(500, requireFreshPreparationTime(deadlineMs, now));
      await boundedFreshPreparation(() => control.click({ timeout: clickMs }), deadlineMs, now);
      navigation?.recordNewChatActivation();
      break;
    } catch (error) {
      if ((error instanceof Error && error.message === FRESH_PREPARATION_DEADLINE_EXHAUSTED)
        || freshPreparationRemainingMs(deadlineMs, now) <= 0) {
        throw new Error(FRESH_PREPARATION_DEADLINE_EXHAUSTED);
      }
      // Keep the existing opportunistic selector fallback while the deadline is open.
    }
  }
}

export async function prepareStateLightFreshConversation(
  page: any,
  config: BrowserConfig,
  profileKey: string,
  invocationId: string,
  navigation?: StateLightNavigationCounter,
  deadlineMs?: number,
  now: () => number = Date.now,
  onProductWall?: (diagnostic: ProductWallDiagnostic) => void,
): Promise<StateLightFreshPrepareResult> {
  if (!config.newChat || !config.projectUrl) {
    return { state: 'ui_contract_mismatch', cause: 'project_url_required' };
  }
  try {
    for (let attempt = 0; attempt < STATE_LIGHT_FRESH_PREPARE_ATTEMPTS; attempt++) {
      requireFreshPreparationTime(deadlineMs, now);
      if (attempt > 0) {
        await boundedFreshPreparation(
          () => sleepMs(STATE_LIGHT_FRESH_PREPARE_BACKOFF_BASE_MS * (2 ** (attempt - 1))),
          deadlineMs,
          now,
        );
      }
      requireFreshPreparationTime(deadlineMs, now);
    let currentUrl = '';
    try {
      currentUrl = normalizeConversationUrl(page.url());
    } catch {
      currentUrl = '';
    }
    const needsSurface = !currentUrl || !isBlankProjectSurfaceUrl(currentUrl, config.projectUrl);
    if (needsSurface) {
      await openBlankProjectChatSurface(page, config.projectUrl, navigation, deadlineMs, now);
      onProductWall?.(await probeProductWall(page, deadlineMs, now));
      try {
        currentUrl = normalizeConversationUrl(page.url());
      } catch {
        currentUrl = '';
      }
    }
    requireFreshPreparationTime(deadlineMs, now);
    const conversationUuid = conversationUuidFromUrl(currentUrl);
    if (!conversationUuid) {
      if (isBlankProjectSurfaceUrl(currentUrl, config.projectUrl)) return { state: 'ready' };
      continue;
    }
    // Navigation may redirect back to a conversation; it is not a blank composer.
    // Never inspect/clean claims belonging to foreign or unsupported surfaces.
    if (!projectConversationUrlMatchesProject(currentUrl, config.projectUrl)) continue;
    const claimPath = stateLightFreshClaimPath(profileKey, currentUrl);
    if (readCorruptOwnershipArtifact(claimPath, readStateLightFreshClaimRecord)) {
      // A concurrent wx writer may still be filling this canonical fence.
      return { state: 'ui_contract_mismatch', cause: 'fresh_conversation_surface_unavailable' };
    }
    const existing = existsSync(claimPath) ? readStateLightFreshClaimRecord(claimPath) : null;
    if (existing?.invocation_id === invocationId
      && !isStateLightFreshClaimRecordExpired(existing, config.timeoutMs, Date.now())) {
      // Even our own active claim does not turn an existing conversation into a blank composer.
      continue;
    }
    if (existing
      && existing.invocation_id !== invocationId
      && !isFreshClaimRecordReclaimable(existing, invocationId, config.timeoutMs, Date.now())) {
      continue;
    }
    if (existing) cleanupReclaimableOwnershipArtifact(claimPath);
    }
  } catch (error) {
    if (!(error instanceof Error && error.message === FRESH_PREPARATION_DEADLINE_EXHAUSTED)) throw error;
  }
  return { state: 'ui_contract_mismatch', cause: 'fresh_conversation_surface_unavailable' };
}

export async function waitForConversationUrlAfterSend(
  page: any,
  projectUrl: string,
  deadlineMs: number,
  sleep: (page: any, ms: number) => Promise<void>,
  pollMs: number,
): Promise<string | undefined> {
  while (Date.now() < deadlineMs) {
    try {
      const currentUrl = normalizeConversationUrl(page.url());
      if (conversationUuidFromUrl(currentUrl)
        && projectConversationUrlMatchesProject(currentUrl, projectUrl)) {
        return currentUrl;
      }
    } catch {
      // keep polling
    }
    await sleep(page, Math.min(pollMs, Math.max(1, deadlineMs - Date.now())));
  }
  return undefined;
}


export function readProjectConversationUrl(page: any, projectUrl: string): string | undefined {
  try {
    const currentUrl = normalizeConversationUrl(page.url());
    if (conversationUuidFromUrl(currentUrl)
      && projectConversationUrlMatchesProject(currentUrl, projectUrl)) {
      return currentUrl;
    }
  } catch {
    // keep polling
  }
  return undefined;
}

export async function navigateToProjectConversationIfNeeded(
  page: any,
  conversationUrl: string,
  navigation: StateLightNavigationCounter,
): Promise<void> {
  const target = normalizeConversationUrl(conversationUrl);
  if (!conversationUuidFromUrl(target)) return;
  let currentUrl = '';
  try {
    currentUrl = normalizeConversationUrl(page.url());
  } catch {
    currentUrl = '';
  }
  if (ownedConversationIdentityMatches(currentUrl, target)) return;
  navigation.recordGoto();
  await page.goto(target, {
    waitUntil: 'domcontentloaded',
    timeout: STATE_LIGHT_NAVIGATION_TIMEOUT_MS,
  });
}
