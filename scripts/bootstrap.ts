#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from './kernel/subprocess.ts';
import { main as verifyMain } from './verify.ts';

export const PACK_AGENTS_START = '<!-- orchestrator-pack:start -->';
export const PACK_AGENTS_END = '<!-- orchestrator-pack:end -->';

export type TargetAgentsAdoption =
  | { ok: true; message: string }
  | { ok: false; message: string };

function has(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}
function value(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function packCheckoutRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function refuse(targetPath: string, problem: string): TargetAgentsAdoption {
  return { ok: false, message: `Refusing to update target AGENTS.md at ${targetPath}: ${problem}` };
}

function countLiteral(haystack: Buffer, literal: string): number {
  const needle = Buffer.from(literal);
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + literal.length;
  }
  return count;
}

function withTrailingNewline(source: Buffer): Buffer {
  if (source.length > 0 && source[source.length - 1] === 0x0a) return source;
  return Buffer.concat([source, Buffer.from('\n')]);
}

function managedInterior(source: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${PACK_AGENTS_START}\n`),
    withTrailingNewline(source),
    Buffer.from(PACK_AGENTS_END),
  ]);
}

function managedBlock(source: Buffer): Buffer {
  return Buffer.concat([managedInterior(source), Buffer.from('\n')]);
}

function writeBytes(path: string, data: Buffer, create: boolean): void {
  const flags = create
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o666);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function readRegularFile(path: string): Buffer | undefined {
  const stat = lstatSync(path);
  if (!stat.isFile()) return undefined;
  return readFileSync(path);
}

/**
 * Place the complete current pack AGENTS.md in one managed block of the target
 * root AGENTS.md. Project-owned bytes outside the markers are preserved.
 * Every rejection happens before a target write.
 */
export function adoptTargetAgentsMd(input: {
  packRoot: string;
  targetRoot: string;
}): TargetAgentsAdoption {
  const packRootPath = resolve(input.packRoot);
  const targetRootPath = resolve(input.targetRoot);
  const targetPath = join(targetRootPath, 'AGENTS.md');
  const sourcePath = join(packRootPath, 'AGENTS.md');

  const packReal = tryRealpath(packRootPath);
  const targetReal = tryRealpath(targetRootPath);
  if (!packReal) return refuse(targetPath, `pack checkout root does not exist: ${packRootPath}`);
  if (!targetReal) return refuse(targetPath, `target repository root does not exist: ${targetRootPath}`);
  if (packReal === targetReal) {
    return refuse(targetPath, `target repository root resolves to the pack checkout at ${packReal}`);
  }

  let targetStat: BigIntStats | undefined;
  try {
    targetStat = lstatSync(targetPath, { bigint: true });
  } catch (error) {
    if (!isEnoent(error)) {
      const detail = error instanceof Error ? error.message : String(error);
      return refuse(targetPath, detail);
    }
  }

  if (targetStat?.isSymbolicLink()) {
    return refuse(targetPath, 'path is a symlink, not a regular file');
  }
  if (targetStat && !targetStat.isFile()) {
    return refuse(targetPath, 'path is not a regular file');
  }

  let sourceStat: BigIntStats;
  try {
    sourceStat = lstatSync(sourcePath, { bigint: true });
  } catch (error) {
    if (isEnoent(error)) return refuse(targetPath, `source pack AGENTS.md is missing at ${sourcePath}`);
    const detail = error instanceof Error ? error.message : String(error);
    return refuse(targetPath, `source pack AGENTS.md at ${sourcePath} could not be read: ${detail}`);
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    return refuse(targetPath, `source pack AGENTS.md at ${sourcePath} is not a regular file`);
  }
  if (targetStat && targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino) {
    return refuse(targetPath, `path identifies the source pack AGENTS.md at ${sourcePath}`);
  }
  const sourceReal = tryRealpath(sourcePath);
  const targetFileReal = targetStat ? tryRealpath(targetPath) : undefined;
  if (sourceReal && targetFileReal && sourceReal === targetFileReal) {
    return refuse(targetPath, `path resolves to the source pack AGENTS.md at ${sourcePath}`);
  }

  const source = readRegularFile(sourcePath);
  if (!source) return refuse(targetPath, `source pack AGENTS.md at ${sourcePath} is not a regular file`);
  if (source.includes(PACK_AGENTS_START) || source.includes(PACK_AGENTS_END)) {
    return refuse(
      targetPath,
      `source pack AGENTS.md at ${sourcePath} contains a managed marker`,
    );
  }

  const block = managedBlock(source);
  if (!targetStat) {
    writeBytes(targetPath, block, true);
    return { ok: true, message: `Created target AGENTS.md with one pack-managed block: ${targetPath}` };
  }

  const target = readFileSync(targetPath);
  const starts = countLiteral(target, PACK_AGENTS_START);
  const ends = countLiteral(target, PACK_AGENTS_END);
  if (starts === 0 && ends === 0) {
    const separator = target.length > 0 && target[target.length - 1] !== 0x0a
      ? Buffer.from('\n')
      : Buffer.alloc(0);
    const next = Buffer.concat([target, separator, block]);
    if (!next.equals(target)) writeBytes(targetPath, next, false);
    return { ok: true, message: `Appended one pack-managed block to target AGENTS.md: ${targetPath}` };
  }

  const markerProblem = markerOwnershipProblem(starts, ends);
  if (markerProblem) return refuse(targetPath, markerProblem);

  const startAt = target.indexOf(PACK_AGENTS_START);
  const endAt = target.indexOf(PACK_AGENTS_END);
  if (endAt < startAt + PACK_AGENTS_START.length) {
    return refuse(targetPath, 'managed markers are reversed or do not form one valid interval');
  }

  const next = Buffer.concat([
    target.subarray(0, startAt),
    managedInterior(source),
    target.subarray(endAt + PACK_AGENTS_END.length),
  ]);
  if (!next.equals(target)) writeBytes(targetPath, next, false);
  const verb = next.equals(target) ? 'already matches the pack source' : 'updated the pack-managed block';
  return { ok: true, message: `Target AGENTS.md ${verb}: ${targetPath}` };
}

function markerOwnershipProblem(starts: number, ends: number): string | undefined {
  if (starts === 1 && ends === 1) return undefined;
  if (starts === 0 && ends === 1) return 'only the end marker is present';
  if (starts === 1 && ends === 0) return 'only the start marker is present';
  if (starts === 0 && ends === 0) return undefined;
  if (starts > 1 && ends > 1) return 'more than one start marker and more than one end marker are present';
  if (starts > 1) return 'more than one start marker is present';
  if (ends > 1) return 'more than one end marker is present';
  return 'managed markers do not form one valid interval';
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  process.stdout.write('== orchestrator-pack bootstrap ==\n');
  process.stdout.write('This helper does not read or print secrets, start a runtime, mutate user configuration, or create orchestration state.\n');

  const verifyArgs: string[] = [];
  if (has(argv, '--strict-prereqs')) verifyArgs.push('--strict-prereqs');
  if (has(argv, '--test-backed-smoke')) verifyArgs.push('--test-backed-smoke');
  const verifyCode = await verifyMain(verifyArgs);
  if (verifyCode !== 0) return verifyCode;

  if (has(argv, '--install-dependencies')) {
    const install = runProcessSync({
      command: 'npm',
      args: ['ci', '--include=dev'],
      cwd: process.cwd(),
      inheritParentEnv: true,
    });
    if (install.stdout) process.stdout.write(install.stdout);
    if (install.stderr) process.stderr.write(install.stderr);
    if (!install.ok) return install.exitCode ?? 1;
    const major = runProcessSync({
      command: 'npm',
      args: ['run', 'check:node-major', '--silent'],
      cwd: process.cwd(),
      inheritParentEnv: true,
    });
    if (!major.ok) return major.exitCode ?? 1;
    process.stdout.write('[PASS] frozen workspace dependencies installed.\n');
  } else {
    process.stdout.write('Dependency installation was not requested. Use --install-dependencies when needed.\n');
  }

  const target = value(argv, '--target-repo');
  process.stdout.write('== Runtime-neutral next step ==\n');
  if (!target) {
    process.stdout.write('No target repository was supplied; no target-side action was attempted.\n');
  } else {
    process.stdout.write(`Target repository: ${target}\n`);
    const adoption = adoptTargetAgentsMd({
      packRoot: packCheckoutRoot(),
      targetRoot: target,
    });
    if (!adoption.ok) {
      process.stderr.write(`${adoption.message}\n`);
      return 1;
    }
    process.stdout.write(`${adoption.message}\n`);
  }
  process.stdout.write('Resolve the exact registered adapter and composite identity before effects.\n');
  process.stdout.write('Use scripts/runtime/runtime-cli.ts and the registered RuntimeAdapter for runtime operations.\n');
  process.stdout.write('[PASS] bootstrap completed without host-runtime mutation.\n');
  return 0;
}

if (import.meta.main) process.exitCode = await main();
