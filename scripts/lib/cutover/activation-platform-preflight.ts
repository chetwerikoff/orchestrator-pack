import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname, release } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface PlatformProof {
  nodeMajor: 22;
  platform: 'linux' | 'wsl2';
  hostId: string;
  repoRoot: string;
  sameDevice: true;
}

export function detectPlatform(): 'linux' | 'wsl2' {
  if (process.platform !== 'linux') throw new Error('cutover_platform_unsupported');
  return /microsoft|wsl/i.test(release()) || process.env.WSL_DISTRO_NAME ? 'wsl2' : 'linux';
}

export function assertNode22(): void {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('cutover_node22_required');
}

export function processStartTime(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('process_pid_invalid');
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = text.lastIndexOf(')');
  if (close < 0) throw new Error('process_stat_invalid');
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const startTimeTicks = fields[19];
  if (!startTimeTicks) throw new Error('process_start_time_missing');
  return startTimeTicks;
}

export function provePlatform(input: { repoRoot: string; stagedRegistryPath: string; projectionPath: string; hostId?: string }): PlatformProof {
  assertNode22();
  const platform = detectPlatform();
  const repoRoot = realpathSync(resolve(input.repoRoot));
  accessSync(repoRoot, constants.R_OK | constants.X_OK);
  const staged = realpathSync(resolve(input.stagedRegistryPath));
  const projectionParent = realpathSync(dirname(resolve(input.projectionPath)));
  if (statSync(staged).dev !== statSync(projectionParent).dev) throw new Error('cutover_projection_cross_device');
  return {
    nodeMajor: 22,
    platform,
    hostId: input.hostId?.trim() || hostname(),
    repoRoot,
    sameDevice: true,
  };
}
