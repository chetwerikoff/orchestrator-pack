import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  classifyProductWall,
  NEW_CHAT_CONTROL_SELECTORS,
  normalizeConversationUrl,
  productStatusText,
  type BrowserConfig,
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
}

export type StateLightFreshConversationClaimResult = 'claimed' | 'owned' | 'contended';

export type StateLightFreshPrepareResult =
  | { state: 'ready' }
  | { state: 'ui_contract_mismatch'; cause: string }
  | { state: 'wall'; wallState: TurnState; cause: string };

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

function projectGptIdFromUrl(url: string): string | undefined {
  const match = /\/g\/(g-p-[^/]+)/i.exec(normalizeConversationUrl(url));
  return match?.[1]?.toLowerCase();
}

export function projectSurfaceUrlsEquivalent(observedUrl: string, projectUrl: string): boolean {
  if (conversationUuidFromUrl(observedUrl)) return false;
  const observed = normalizeConversationUrl(observedUrl);
  const project = projectConversationPrefix(projectUrl);
  if (observed === project) return true;
  try {
    const observedParsed = new URL(observed);
    const projectParsed = new URL(project);
    if (observedParsed.origin !== projectParsed.origin) return false;
    const observedPath = observedParsed.pathname.replace(/\/+$/, '');
    const projectPath = projectParsed.pathname.replace(/\/+$/, '');
    if (observedPath === projectPath) return true;
    const observedId = projectGptIdFromUrl(observed);
    const projectId = projectGptIdFromUrl(project);
    return observedId !== undefined
      && observedId === projectId
      && !/\/c\//i.test(observedPath);
  } catch {
    return false;
  }
}

export function isBlankProjectSurfaceUrl(observedUrl: string, projectUrl: string): boolean {
  if (!observedUrl.trim()) return false;
  return projectSurfaceUrlsEquivalent(observedUrl, projectUrl);
}

export function conversationUuidFromUrl(value: string): string | undefined {
  const match = /\/c\/([0-9a-f-]{36})$/i.exec(normalizeConversationUrl(value));
  return match?.[1]?.toLowerCase();
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
  const normalized = normalizeConversationUrl(conversationUrl);
  return join(stateLightFreshClaimsDir(profileKey), `${sha256(normalized)}.json`);
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
): { state: TurnState; cause: string } | null {
  const path = stateLightAdvisoryWallPath(profileKey);
  if (!existsSync(path)) return null;
  const record = readStateLightAdvisoryWallRecord(path);
  if (!record) return null;
  const expiresAt = Date.parse(record.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    try { rmSync(path, { force: true }); } catch { /* fail-open */ }
    return null;
  }
  return { state: record.wall_state, cause: record.cause };
}

export function recordStateLightAdvisoryWall(
  profileKey: string,
  wallState: TurnState,
  cause: string,
  invocationId?: string,
  ttlMs = STATE_LIGHT_ADVISORY_WALL_TTL_MS,
  nowMs = Date.now(),
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
  };
  writeFileSync(stateLightAdvisoryWallPath(profileKey), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function tryClaimStateLightFreshConversation(
  profileKey: string,
  conversationUrl: string,
  invocationId: string,
  acceptedTimeoutMs: number = STATE_LIGHT_MAX_TIMEOUT_MS,
): StateLightFreshConversationClaimResult {
  const normalized = normalizeConversationUrl(conversationUrl);
  const claimPath = stateLightFreshClaimPath(profileKey, normalized);
  const boundedTimeout = Math.min(acceptedTimeoutMs, STATE_LIGHT_MAX_TIMEOUT_MS);
  for (let attempt = 0; attempt < STATE_LIGHT_OWNERSHIP_RECOVERY_ATTEMPTS; attempt++) {
    const nowMs = Date.now();
    if (readCorruptOwnershipArtifact(claimPath, readStateLightFreshClaimRecord)) {
      cleanupReclaimableOwnershipArtifact(claimPath);
    }
    const existing = existsSync(claimPath) ? readStateLightFreshClaimRecord(claimPath) : null;
    if (existing) {
      if (existing.invocation_id === invocationId && !isStateLightFreshClaimRecordExpired(existing, boundedTimeout, nowMs)) {
        return 'owned';
      }
      if (!isFreshClaimRecordReclaimable(existing, invocationId, boundedTimeout, nowMs)) {
        return 'contended';
      }
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
  if (!conversationUrl) return;
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

async function probeProductWall(page: any): Promise<{ state: TurnState; cause: string } | null> {
  const wall = classifyProductWall(await productStatusText(page, PRODUCT_WALL_PROBE_MS));
  if (!wall.state) return null;
  return { state: wall.state, cause: wall.cause ?? `${wall.state}_detected` };
}

export async function openBlankProjectChatSurface(
  page: any,
  projectUrl: string,
  timeoutMs: number,
  navigation?: StateLightNavigationCounter,
): Promise<void> {
  const waitMs = Math.min(30_000, timeoutMs);
  const projectPrefix = projectConversationPrefix(projectUrl);
  let currentUrl = '';
  try {
    currentUrl = normalizeConversationUrl(page.url());
  } catch {
    currentUrl = '';
  }
  if (!isBlankProjectSurfaceUrl(currentUrl, projectUrl)) {
    navigation?.recordGoto();
    await page.goto(projectPrefix, {
      waitUntil: 'domcontentloaded',
      timeout: waitMs,
    });
  }
  for (const selector of NEW_CHAT_CONTROL_SELECTORS) {
    const control = page.locator(selector).first();
    try {
      if (Number(await control.count()) <= 0) continue;
      await control.click({ timeout: 500 });
      navigation?.recordNewChatActivation();
      break;
    } catch {
      // try the next selector
    }
  }
}

export async function prepareStateLightFreshConversation(
  page: any,
  config: BrowserConfig,
  profileKey: string,
  invocationId: string,
  navigation?: StateLightNavigationCounter,
): Promise<StateLightFreshPrepareResult> {
  if (!config.newChat || !config.projectUrl) {
    return { state: 'ui_contract_mismatch', cause: 'project_url_required' };
  }
  for (let attempt = 0; attempt < STATE_LIGHT_FRESH_PREPARE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleepMs(STATE_LIGHT_FRESH_PREPARE_BACKOFF_BASE_MS * (2 ** (attempt - 1)));
    }
    let currentUrl = '';
    try {
      currentUrl = normalizeConversationUrl(page.url());
    } catch {
      currentUrl = '';
    }
    const needsSurface = !currentUrl || !isBlankProjectSurfaceUrl(currentUrl, config.projectUrl);
    if (needsSurface) {
      await openBlankProjectChatSurface(page, config.projectUrl, config.timeoutMs, navigation);
      const wall = await probeProductWall(page);
      if (wall) return { state: 'wall', wallState: wall.state, cause: wall.cause };
      try {
        currentUrl = normalizeConversationUrl(page.url());
      } catch {
        currentUrl = '';
      }
    }
    const conversationUuid = conversationUuidFromUrl(currentUrl);
    if (!conversationUuid) return { state: 'ready' };
    const claimPath = stateLightFreshClaimPath(profileKey, currentUrl);
    if (readCorruptOwnershipArtifact(claimPath, readStateLightFreshClaimRecord)) {
      cleanupReclaimableOwnershipArtifact(claimPath);
    }
    const existing = existsSync(claimPath) ? readStateLightFreshClaimRecord(claimPath) : null;
    if (existing?.invocation_id === invocationId
      && !isStateLightFreshClaimRecordExpired(existing, config.timeoutMs, Date.now())) {
      return { state: 'ready' };
    }
    if (existing
      && existing.invocation_id !== invocationId
      && !isFreshClaimRecordReclaimable(existing, invocationId, config.timeoutMs, Date.now())) {
      continue;
    }
    if (existing) cleanupReclaimableOwnershipArtifact(claimPath);
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
  const projectPrefix = projectConversationPrefix(projectUrl);
  while (Date.now() < deadlineMs) {
    try {
      const currentUrl = normalizeConversationUrl(page.url());
      if (conversationUuidFromUrl(currentUrl) && currentUrl.startsWith(projectPrefix)) {
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
    const projectPrefix = projectConversationPrefix(projectUrl);
    const currentUrl = normalizeConversationUrl(page.url());
    if (conversationUuidFromUrl(currentUrl) && currentUrl.startsWith(projectPrefix)) {
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
  gotoTimeoutMs: number,
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
    timeout: gotoTimeoutMs,
  });
}
