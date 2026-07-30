import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { normalizeConversationUrl, type BrowserConfig } from './ui-adapter.ts';
import { profileDirs, sha256 } from './storage-common.ts';

const STATE_LIGHT_FRESH_CLAIM_SCHEMA = 'state-light-fresh-claim/v1' as const;
const STATE_LIGHT_NEW_CHAT_SEND_SLOT_SCHEMA = 'state-light-new-chat-send-slot/v1' as const;
export const STATE_LIGHT_FRESH_PREPARE_ATTEMPTS = 5;
export const STATE_LIGHT_FRESH_RECOVERY_ATTEMPTS = 3;
const SEND_SLOT_POLL_MS = 50;

interface StateLightFreshClaimRecord {
  readonly schema: typeof STATE_LIGHT_FRESH_CLAIM_SCHEMA;
  readonly version: 1;
  readonly invocation_id: string;
  readonly conversation_id: string;
  readonly pid: number;
  readonly claimed_at: string;
}

interface StateLightNewChatSendSlotRecord {
  readonly schema: typeof STATE_LIGHT_NEW_CHAT_SEND_SLOT_SCHEMA;
  readonly version: 1;
  readonly invocation_id: string;
  readonly pid: number;
  readonly acquired_at: string;
}

export type StateLightFreshConversationClaimResult = 'claimed' | 'owned' | 'contended';

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

function projectConversationPrefix(projectUrl: string): string {
  return normalizeConversationUrl(projectUrl).replace(/\/+$/, '');
}

export function conversationUuidFromUrl(value: string): string | undefined {
  const match = /\/c\/([0-9a-f-]{36})$/i.exec(normalizeConversationUrl(value));
  return match?.[1]?.toLowerCase();
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

function readStateLightFreshClaimRecord(path: string): StateLightFreshClaimRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as StateLightFreshClaimRecord;
    if (value.schema !== STATE_LIGHT_FRESH_CLAIM_SCHEMA
      || value.version !== 1
      || typeof value.invocation_id !== 'string'
      || typeof value.conversation_id !== 'string'
      || !Number.isInteger(value.pid)
      || value.pid <= 0) {
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
      || !Number.isInteger(value.pid)
      || value.pid <= 0) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function newChatSendSlotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPK_STATE_LIGHT_DISABLE_NEW_CHAT_SEND_SLOT !== '1';
}

export function tryClaimStateLightFreshConversation(
  profileKey: string,
  conversationUrl: string,
  invocationId: string,
): StateLightFreshConversationClaimResult {
  const normalized = normalizeConversationUrl(conversationUrl);
  const claimPath = stateLightFreshClaimPath(profileKey, normalized);
  const existing = existsSync(claimPath) ? readStateLightFreshClaimRecord(claimPath) : null;
  if (existing) {
    if (existing.invocation_id === invocationId) return 'owned';
    if (!claimPidProvablyDead(existing.pid)) return 'contended';
    rmSync(claimPath, { force: true });
  }
  const record: StateLightFreshClaimRecord = {
    schema: STATE_LIGHT_FRESH_CLAIM_SCHEMA,
    version: 1,
    invocation_id: invocationId,
    conversation_id: normalized,
    pid: process.pid,
    claimed_at: new Date().toISOString(),
  };
  try {
    const fd = openSync(claimPath, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    } finally {
      closeSync(fd);
    }
    return 'claimed';
  } catch (error) {
    if (claimErrnoCode(error) === 'EEXIST') return 'contended';
    throw error;
  }
}

export function releaseStateLightFreshConversationClaim(
  profileKey: string,
  conversationUrl: string | undefined,
  invocationId: string,
): void {
  if (!conversationUrl) return;
  const claimPath = stateLightFreshClaimPath(profileKey, conversationUrl);
  const existing = existsSync(claimPath) ? readStateLightFreshClaimRecord(claimPath) : null;
  if (existing?.invocation_id === invocationId) rmSync(claimPath, { force: true });
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
    const existing = existsSync(slotPath) ? readStateLightNewChatSendSlotRecord(slotPath) : null;
    if (existing?.invocation_id === invocationId) return;
    if (existing && !claimPidProvablyDead(existing.pid)) {
      await sleepMs(Math.min(SEND_SLOT_POLL_MS, Math.max(1, deadline - Date.now())));
      continue;
    }
    if (existing) rmSync(slotPath, { force: true });
    const record: StateLightNewChatSendSlotRecord = {
      schema: STATE_LIGHT_NEW_CHAT_SEND_SLOT_SCHEMA,
      version: 1,
      invocation_id: invocationId,
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    };
    try {
      const fd = openSync(slotPath, 'wx', 0o600);
      try {
        writeSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if (claimErrnoCode(error) !== 'EEXIST') throw error;
      await sleepMs(Math.min(SEND_SLOT_POLL_MS, Math.max(1, deadline - Date.now())));
    }
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
  if (existing?.invocation_id === invocationId) rmSync(slotPath, { force: true });
}

export async function openBlankProjectChatSurface(
  page: any,
  projectPrefix: string,
  timeoutMs: number,
): Promise<void> {
  const waitMs = Math.min(30_000, timeoutMs);
  await page.goto(projectPrefix, {
    waitUntil: 'domcontentloaded',
    timeout: waitMs,
  });
  const newChatSelectors = [
    '[data-testid="create-new-chat-button"]',
    'a:has-text("New chat")',
    'button:has-text("New chat")',
    '[aria-label="New chat"]',
  ];
  for (const selector of newChatSelectors) {
    const control = page.locator(selector).first();
    try {
      if (Number(await control.count()) <= 0) continue;
      await control.click({ timeout: 500 });
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
): Promise<{ state: 'ready' } | { state: 'ui_contract_mismatch'; cause: string }> {
  if (!config.newChat || !config.projectUrl) {
    return { state: 'ui_contract_mismatch', cause: 'project_url_required' };
  }
  const projectPrefix = projectConversationPrefix(config.projectUrl);
  for (let attempt = 0; attempt < STATE_LIGHT_FRESH_PREPARE_ATTEMPTS; attempt++) {
    let currentUrl = '';
    try {
      currentUrl = normalizeConversationUrl(page.url());
    } catch {
      currentUrl = '';
    }
    if (!currentUrl || currentUrl !== projectPrefix) {
      await openBlankProjectChatSurface(page, projectPrefix, config.timeoutMs);
      try {
        currentUrl = normalizeConversationUrl(page.url());
      } catch {
        currentUrl = '';
      }
    }
    const conversationUuid = conversationUuidFromUrl(currentUrl);
    if (!conversationUuid) return { state: 'ready' };
    const claimPath = stateLightFreshClaimPath(profileKey, currentUrl);
    const existing = existsSync(claimPath) ? readStateLightFreshClaimRecord(claimPath) : null;
    if (existing?.invocation_id === invocationId) return { state: 'ready' };
    if (existing && existing.invocation_id !== invocationId && !claimPidProvablyDead(existing.pid)) {
      await openBlankProjectChatSurface(page, projectPrefix, config.timeoutMs);
      continue;
    }
    await openBlankProjectChatSurface(page, projectPrefix, config.timeoutMs);
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
