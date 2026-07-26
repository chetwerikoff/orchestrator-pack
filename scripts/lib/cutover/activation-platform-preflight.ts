import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface PlatformPreflightInput {
  repoRoot: string;
  installedCommitSha: string;
  oldInstalledRevisionRoot: string;
  targetRegistryPath: string;
  projectedRegistryPath: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
}

export interface PlatformPreflightResult {
  result: 'node22-linux-wsl2-preflight-pass';
  repoRoot: string;
  oldInstalledRevisionRoot: string;
  platform: 'linux';
  nodeMajor: 22;
}

export function runActivationPlatformPreflight(input: PlatformPreflightInput): PlatformPreflightResult {
  const platform = input.platform ?? process.platform;
  if (platform !== 'linux') throw new Error('unsupported_platform');
  const version = input.nodeVersion ?? process.versions.node;
  const major = Number(version.split('.')[0]);
  if (major !== 22) throw new Error('node22_required');
  if (!existsSync(input.repoRoot) || !existsSync(input.oldInstalledRevisionRoot)) throw new Error('installed_revision_missing');
  const repoRoot = realpathSync(input.repoRoot);
  const oldInstalledRevisionRoot = realpathSync(input.oldInstalledRevisionRoot);
  const actualHead = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actualHead.toLowerCase() !== input.installedCommitSha.toLowerCase()) throw new Error('installed_commit_unbound');

  const targetParent = realpathSync(path.dirname(input.targetRegistryPath));
  const projectionParent = realpathSync(path.dirname(input.projectedRegistryPath));
  if (statSync(targetParent).dev !== statSync(projectionParent).dev) throw new Error('registry_cross_device_projection');

  const probeRoot = mkdtempSync(path.join(projectionParent, '.cutover-fsync-probe-'));
  try {
    const before = path.join(probeRoot, 'before');
    const after = path.join(probeRoot, 'after');
    const fd = openSync(before, 'wx', 0o600);
    try { writeFileSync(fd, 'probe'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(before, after);
    const dirFd = openSync(probeRoot, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }

  return { result: 'node22-linux-wsl2-preflight-pass', repoRoot, oldInstalledRevisionRoot, platform: 'linux', nodeMajor: 22 };
}

export function localHostId(): string {
  return os.hostname().trim();
}
