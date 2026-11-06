import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface ProfileDirs {
  readonly root: string;
  readonly records: string;
  readonly quarantine: string;
  readonly tombstones: string;
  readonly resolved: string;
  readonly publications: string;
  readonly diagnostics: string;
  readonly capability: string;
  readonly locks: string;
}

export interface ResolvedConfiguredProfile {
  readonly profile: string;
  readonly cdp: string;
  readonly profileKey: string;
  readonly legacyProfileKey: string;
  readonly keysDiffer: boolean;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Fixable pre-SEND refusal for a configured profile that is not an absolute user-data-dir. */
export const PROFILE_ABSOLUTE_REQUIRED_CODE = 'profile_absolute_user_data_dir_required' as const;
export const PROFILE_ABSOLUTE_NEXT_STEP = 'pass --profile <absolute-user-data-dir> (POSIX /path or WSL /mnt/c/path, '
  + 'Windows C:\\path or C:/path, or on Windows a full \\\\server\\share\\path), then relaunch with a fresh invocation id; nothing was sent';

/**
 * The single lexical absolute-profile validator, applied before any cwd-dependent resolution,
 * occupancy hashing, profile key or state allocation. Returns the refusal reason, or undefined.
 */
export function absoluteProfilePathError(profile: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const value = profile.trim();
  if (!value) return 'profile_empty';
  if (/^[\\/]{2}/u.test(value)) {
    if (platform !== 'win32') return 'profile_unc_unsupported_on_platform';
    const parts = value.slice(2).split(/[\\/]+/u);
    return parts.length >= 2 && parts[0] && parts[1] && parts[0] !== '.' && parts[0] !== '?'
      ? undefined : 'profile_unc_server_share_required';
  }
  if (/^[A-Za-z]:/u.test(value)) return /^[A-Za-z]:[\\/]/u.test(value) ? undefined : 'profile_drive_relative';
  // A single leading backslash is a Windows root-relative path on every platform, never POSIX absolute.
  if (value.startsWith('\\')) return 'profile_rootless_windows_path';
  if (value.startsWith('/')) return platform === 'win32' ? 'profile_rootless_windows_path' : undefined;
  return 'profile_relative';
}

/** Throw the fixable pre-SEND profile refusal; never resolve a relative or ambiguous profile. */
export function assertAbsoluteProfilePath(profile: string): void {
  const reason = absoluteProfilePathError(profile);
  if (reason) throw new Error(`${PROFILE_ABSOLUTE_REQUIRED_CODE}:${reason}`);
}

/** A trusted original-bound GitHub target from the exact launch selector or receipt baseline. */
export interface BoundGithubTarget {
  readonly kind: 'issue' | 'pr';
  readonly repo: string;
  readonly number: number;
}

/** The inventory-listed read-only `scripts/gh` view of an exact bound Issue or PR. */
export function boundTargetReadOnlyArgv(target: BoundGithubTarget): string[] {
  return target.kind === 'pr'
    ? ['scripts/gh', 'pr', 'view', String(target.number), '--repo', target.repo,
      '--json', 'number,state,headRefOid,headRefName,headRepository']
    : ['scripts/gh', 'issue', 'view', String(target.number), '--repo', target.repo,
      '--json', 'state,title,body,closedAt'];
}

/**
 * Shared read-first continuation: from the still-current original Task+Dispatch owner, read the exact
 * bound target first, then reconcile the original locator/Page/receipt. Unbound: inspect read-only.
 * Never a Send, a replay or a fresh-chat recommendation.
 */
export function boundTargetReadFirstNextAction(target: BoundGithubTarget | undefined): string {
  const tail = 'then reconcile the exact original invocation (owner wait on its locator/receipt, original Page) from the '
    + 'still-current original Task+Dispatch owner. Unchanged GitHub state is no observed progress, not proof of no Send; '
    + 'no resend or replacement of a possibly delivered request; a distinct new intent is only the current owner\'s separate decision.';
  return target
    ? `read-only first: ${boundTargetReadOnlyArgv(target).join(' ')}; ${tail}`
    : `read-only first: no trusted original-bound GitHub target; inspect the exact original invocation read-only; ${tail}`;
}

/** Owner-evaluated recovery for named predecessor/receipt refusals and post-SEND uncertainty only. */
export function githubFirstOwnerRecoveryNextAction(target: BoundGithubTarget | undefined): string {
  const first = target ? `read-only first: ${boundTargetReadOnlyArgv(target).join(' ')}; `
    : 'read-only first: still-current owner must identify and inspect the live GitHub target; ';
  return first + 'body/head progress has unverified attribution, not intended-effect or physical Send proof. '
    + 'Still-current owner: manually inspect comments/new PR/other commits and ambiguous body/head changes on GitHub against original intent; '
    + 'incomplete coverage or failed read means effect unknown. '
    + 'Only if owner confirms relevant effect: one separate authorized new-chat continuation from live Issue/PR/commit head, --new-chat. '
    + 'Only if owner completes relevant kind-specific inspection confirming no expected effect AND independently has original reported Send time '
    + 'with at least 20 minutes elapsed: owner may admit a fresh turn as new work from live head, --new-chat. '
    + 'Both choices require current Task+Dispatch/send admission and neither --predecessor-invocation-id nor --predecessor-attempt-identity; '
    + 'no original-prompt replay or automatic resend. Missing time, under 20 minutes, incomplete inspection, ambiguous intent/effect or ownership: '
    + 'further supported GitHub inspection/manual current-owner decision; no observed progress is not no Send, reported Send is not physical proof.';
}

function toPortableProfilePath(profile: string): string {
  let portable = profile.trim().replaceAll('\\', '/');
  const drive = /^([A-Za-z]):(.*)$/.exec(portable);
  if (drive?.[1] !== undefined && process.platform !== 'win32') {
    portable = `/mnt/${drive[1].toLowerCase()}${drive[2] ?? ''}`;
  }
  return resolve(portable);
}

export function isWindowsBackedProfilePath(_absolutePath: string): boolean {
  // DrvFs/9p case semantics cannot be inferred from /mnt/<drive>/ pathname shape on Linux.
  return process.platform === 'win32';
}

function usesCaseInsensitiveProfileIdentity(_absolutePath: string): boolean {
  return process.platform === 'win32';
}

function normalizeProfileIdentityString(path: string, caseInsensitive: boolean): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function resolveConfiguredProfileAbsolute(profile: string): { absolute: string; realpathResolved: boolean } {
  const absolute = toPortableProfilePath(profile);
  try {
    return { absolute: realpathSync.native(absolute), realpathResolved: true };
  } catch {
    return { absolute, realpathResolved: false };
  }
}

export function configuredProfileIdentity(profile: string): string {
  const { absolute } = resolveConfiguredProfileAbsolute(profile);
  const portable = absolute.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalizeProfileIdentityString(portable, usesCaseInsensitiveProfileIdentity(portable));
}

export function legacyConfiguredProfileIdentity(profile: string): string {
  let portable = profile.trim().replaceAll('\\', '/');
  const drive = /^([A-Za-z]):(.*)$/.exec(portable);
  if (drive?.[1] !== undefined) portable = `/mnt/${drive[1].toLowerCase()}${drive[2] ?? ''}`;
  const absolute = resolve(portable);
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // Preserve the exact pre-upgrade lexical fallback.
  }
  return canonical.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function normalizeCdpEndpoint(cdp: string): string {
  const endpoint = new URL(cdp);
  endpoint.hash = '';
  endpoint.search = '';
  return endpoint.toString().replace(/\/$/, '').toLowerCase();
}

export function configuredProfileKey(profile: string, cdp: string): string {
  const normalizedProfile = configuredProfileIdentity(profile);
  const normalizedCdp = normalizeCdpEndpoint(cdp);
  return `profile-${sha256(`${normalizedProfile}\n${normalizedCdp}`).slice(0, 32)}`;
}

export function legacyConfiguredProfileKey(profile: string, cdp: string): string {
  const normalizedProfile = legacyConfiguredProfileIdentity(profile);
  const normalizedCdp = normalizeCdpEndpoint(cdp);
  return `profile-${sha256(`${normalizedProfile}\n${normalizedCdp}`).slice(0, 32)}`;
}

export function resolveConfiguredProfile(profile: string, cdp: string): ResolvedConfiguredProfile {
  const profileKey = configuredProfileKey(profile, cdp);
  const legacyProfileKey = legacyConfiguredProfileKey(profile, cdp);
  return {
    profile,
    cdp,
    profileKey,
    legacyProfileKey,
    keysDiffer: profileKey !== legacyProfileKey,
  };
}

export function nativeLinuxCaseDistinctSiblingExists(profile: string): boolean {
  if (process.platform === 'win32') return false;
  const { absolute, realpathResolved } = resolveConfiguredProfileAbsolute(profile);
  if (usesCaseInsensitiveProfileIdentity(absolute)) return false;
  const portable = absolute.replaceAll('\\', '/');
  const parent = dirname(portable);
  const leaf = basename(portable);
  if (!leaf || leaf === '.' || leaf === '/') return false;
  let siblings: string[];
  try {
    siblings = readdirSync(parent).filter((name) => name !== leaf && name.toLowerCase() === leaf.toLowerCase());
  } catch {
    return false;
  }
  for (const siblingName of siblings) {
    const sibling = join(parent, siblingName);
    try {
      const siblingReal = realpathSync.native(sibling);
      if (realpathResolved) {
        if (siblingReal !== absolute) return true;
        continue;
      }
      if (siblingReal.replaceAll('\\', '/').replace(/\/+$/, '') !== portable.replace(/\/+$/, '')) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function legacyProfileKeyAmbiguous(profile: string): boolean {
  if (process.platform === 'win32') return false;
  const { absolute } = resolveConfiguredProfileAbsolute(profile);
  if (usesCaseInsensitiveProfileIdentity(absolute)) return false;
  let current = absolute;
  for (;;) {
    if (nativeLinuxCaseDistinctSiblingExists(current)) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function storeRoot(): string {
  return process.env.CHATGPT_BROWSER_TURN_STATE_DIR
    ? resolve(process.env.CHATGPT_BROWSER_TURN_STATE_DIR)
    : join(homedir(), '.local', 'state', 'orchestrator-pack', 'chatgpt-browser-turn');
}

export function profileStoreRoot(profileKey: string): string {
  return join(storeRoot(), profileKey);
}

export function profileDiagnosticsDir(profileKey: string): string {
  const dir = join(storeRoot(), profileKey, 'diagnostics');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function profileDiagnosticsFilePath(profileKey: string, identity: string): string {
  return join(join(storeRoot(), profileKey, 'diagnostics'), `${identity}.json`);
}

export function profileStatePaths(profileKey: string): ProfileDirs {
  const root = join(storeRoot(), profileKey);
  return {
    root,
    records: join(root, 'records'),
    quarantine: join(root, 'quarantine'),
    tombstones: join(root, 'tombstones'),
    resolved: join(root, 'resolved'),
    publications: join(root, 'publications'),
    diagnostics: join(root, 'diagnostics'),
    capability: join(root, 'capability.json'),
    locks: join(root, 'locks'),
  };
}

export function profileNamespaceExists(profileKey: string): boolean {
  return existsSync(profileStatePaths(profileKey).root);
}

export function profileDirs(profileKey: string): ProfileDirs {
  const root = join(storeRoot(), profileKey);
  const result: ProfileDirs = {
    root,
    records: join(root, 'records'),
    quarantine: join(root, 'quarantine'),
    tombstones: join(root, 'tombstones'),
    resolved: join(root, 'resolved'),
    publications: join(root, 'publications'),
    diagnostics: join(root, 'diagnostics'),
    capability: join(root, 'capability.json'),
    locks: join(root, 'locks'),
  };
  for (const path of [
    result.root,
    result.records,
    result.quarantine,
    result.tombstones,
    result.resolved,
    result.publications,
    result.diagnostics,
    result.locks,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return result;
}

export function fsyncDirectory(path: string): void {
  const directoryFlag = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
  const fd = openSync(path, constants.O_RDONLY | directoryFlag);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDirectory(parent);
}
