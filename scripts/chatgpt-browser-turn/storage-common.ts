import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface ProfileDirs {
  readonly root: string;
  readonly records: string;
  readonly quarantine: string;
  readonly tombstones: string;
  readonly resolved: string;
  readonly publications: string;
  readonly capability: string;
  readonly locks: string;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function configuredProfileKey(profile: string, cdp: string): string {
  const normalizedProfile = process.platform === 'win32' ? resolve(profile).toLowerCase() : resolve(profile);
  const endpoint = new URL(cdp);
  endpoint.hash = '';
  endpoint.search = '';
  const normalizedCdp = endpoint.toString().replace(/\/$/, '').toLowerCase();
  return `profile-${sha256(`${normalizedProfile}\n${normalizedCdp}`).slice(0, 32)}`;
}

function storeRoot(): string {
  return process.env.CHATGPT_BROWSER_TURN_STATE_DIR
    ? resolve(process.env.CHATGPT_BROWSER_TURN_STATE_DIR)
    : join(homedir(), '.local', 'state', 'orchestrator-pack', 'chatgpt-browser-turn');
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
