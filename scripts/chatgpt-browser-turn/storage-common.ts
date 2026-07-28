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

function toPortableProfilePath(profile: string): string {
  let portable = profile.trim().replaceAll('\\', '/');
  const drive = /^([A-Za-z]):(.*)$/.exec(portable);
  if (drive?.[1] !== undefined && process.platform !== 'win32') {
    portable = `/mnt/${drive[1].toLowerCase()}${drive[2] ?? ''}`;
  }
  return resolve(portable);
}

export function isWindowsBackedProfilePath(absolutePath: string): boolean {
  return /^\/mnt\/[a-z]\//i.test(absolutePath.replaceAll('\\', '/'));
}

function usesCaseInsensitiveProfileIdentity(absolutePath: string): boolean {
  if (process.platform === 'win32') return true;
  return isWindowsBackedProfilePath(absolutePath);
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
  return nativeLinuxCaseDistinctSiblingExists(profile);
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
