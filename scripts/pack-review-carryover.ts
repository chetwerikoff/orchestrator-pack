import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256, stableJson } from './pack-review-state.ts';

export const PACK_REVIEW_CARRYOVER_HELPER_VERSION = 'pack-review-carryover/v2';
export const MERGE_RESOLUTION_BUNDLE_SCHEMA = 'merge-resolution-bundle/v2';

export interface GitTreeEntry {
  mode: string;
  oid: string;
}

export interface ReplayConflictEntry {
  pathUtf8: string;
  pathBytesBase64: string;
  stage1: GitTreeEntry;
  stage2: GitTreeEntry;
  stage3: GitTreeEntry;
  resolved: GitTreeEntry & { bytesBase64: string; byteLength: number };
}

export interface MergeResolutionBundleV2 {
  schema: typeof MERGE_RESOLUTION_BUNDLE_SCHEMA;
  helperVersion: typeof PACK_REVIEW_CARRYOVER_HELPER_VERSION;
  sourceHeadSha: string;
  mainSha: string;
  targetHeadSha: string;
  mergeBaseSha: string;
  orderedParentShas: [string, string];
  gitVersion: string;
  replayConfigDigest: string;
  replayDigest: string;
  conflictCount: number;
  conflicts: ReplayConflictEntry[];
  framedBytesBase64: string;
  bundleDigest: string;
}

export interface CarryoverReplayResult {
  kind: 'conflict_free_carryover' | 'merge_composite';
  sourceHeadSha: string;
  mainSha: string;
  targetHeadSha: string;
  mergeBaseSha: string;
  replayTreeSha: string;
  replayDigest: string;
  bundle?: MergeResolutionBundleV2;
}

export class PackReviewCarryoverError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = 'PackReviewCarryoverError';
  }
}

function fullSha(value: unknown, label: string): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new PackReviewCarryoverError('carryover_input_invalid', `${label} must be full 40-hex`);
  }
  return sha;
}

function runGit(
  repoRoot: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; encoding?: BufferEncoding | 'buffer' } = {},
): string | Buffer {
  const encoding = options.encoding ?? 'utf8';
  const result = spawnSync('git', [...args], {
    cwd: repoRoot,
    env: { ...process.env, ...options.env },
    encoding: encoding === 'buffer' ? null : encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new PackReviewCarryoverError('carryover_git_failed', result.error.message);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr ?? '');
    throw new PackReviewCarryoverError(
      'carryover_git_failed',
      `git ${args.join(' ')} exited ${String(result.status)}: ${stderr.trim()}`,
    );
  }
  return encoding === 'buffer'
    ? Buffer.from(result.stdout as Buffer)
    : String(result.stdout ?? '').trim();
}

function resolveCommit(repoRoot: string, value: string, label: string): string {
  return fullSha(runGit(repoRoot, ['rev-parse', '--verify', `${value}^{commit}`]), label);
}

function resolveTree(repoRoot: string, commit: string): string {
  return fullSha(runGit(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`]), 'treeSha');
}

function repositoryConfigCapture(repoRoot: string, sourceHeadSha: string, mainSha: string): unknown {
  const gitVersion = String(runGit(repoRoot, ['--version']));
  const attrs = [sourceHeadSha, mainSha].map((commit) => {
    const result = spawnSync('git', ['show', `${commit}:.gitattributes`], {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      commit,
      exists: result.status === 0,
      digest: result.status === 0 ? sha256(Buffer.from(result.stdout)) : null,
    };
  });
  const configNames = [
    'core.autocrlf',
    'core.eol',
    'core.safecrlf',
    'merge.renormalize',
    'merge.conflictstyle',
  ];
  const config = Object.fromEntries(configNames.map((name) => {
    const result = spawnSync('git', ['config', '--local', '--get-all', name], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return [name, result.status === 0
      ? String(result.stdout).split(/\r?\n/).filter(Boolean)
      : []];
  }));
  return { gitVersion, attrs, config };
}

function parseUnmergedEntries(bytes: Buffer): Map<string, Map<number, GitTreeEntry>> {
  const entries = new Map<string, Map<number, GitTreeEntry>>();
  for (const record of bytes.toString('utf8').split('\0')) {
    if (!record) continue;
    const match = /^(\d{6}) ([0-9a-f]{40}) ([123])\t([\s\S]+)$/.exec(record);
    if (!match) {
      throw new PackReviewCarryoverError('carryover_replay_invalid', `unparseable index row ${record}`);
    }
    const [, mode, oid, stageText, path] = match;
    const stage = Number(stageText);
    const stages = entries.get(path!) ?? new Map<number, GitTreeEntry>();
    stages.set(stage, { mode: mode!, oid: oid! });
    entries.set(path!, stages);
  }
  return entries;
}

function parseLsTreeEntry(bytes: Buffer, expectedPath: string): GitTreeEntry | null {
  const text = bytes.toString('utf8');
  if (!text) return null;
  const records = text.split('\0').filter(Boolean);
  if (records.length !== 1) {
    throw new PackReviewCarryoverError('carryover_replay_invalid', `ambiguous tree path ${expectedPath}`);
  }
  const match = /^(\d{6}) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(records[0]!);
  if (!match || match[3] !== expectedPath) {
    throw new PackReviewCarryoverError('carryover_object_unsupported', `unsupported tree entry ${expectedPath}`);
  }
  return { mode: match[1]!, oid: match[2]! };
}

function assertSupportedResolvedBlob(repoRoot: string, path: string, entry: GitTreeEntry): Buffer {
  if (!['100644', '100755'].includes(entry.mode)) {
    throw new PackReviewCarryoverError(
      'carryover_object_unsupported',
      `${path} mode ${entry.mode}`,
    );
  }
  const bytes = runGit(repoRoot, ['cat-file', 'blob', entry.oid], { encoding: 'buffer' }) as Buffer;
  if (bytes.includes(0)) {
    throw new PackReviewCarryoverError('carryover_object_unsupported', `${path} is binary`);
  }
  if (bytes.subarray(0, 64).toString('utf8').startsWith('version https://git-lfs.github.com/spec/')) {
    throw new PackReviewCarryoverError('carryover_object_unsupported', `${path} is Git LFS pointer`);
  }
  return bytes;
}

function frameField(name: string, value: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(nameBytes.length, 0);
  header.writeUInt32BE(value.length, 4);
  return Buffer.concat([header, nameBytes, value]);
}

function frameBundle(input: Omit<MergeResolutionBundleV2, 'framedBytesBase64' | 'bundleDigest'>): Buffer {
  const frames: Buffer[] = [
    frameField('schema', Buffer.from(input.schema, 'utf8')),
    frameField('sourceHeadSha', Buffer.from(input.sourceHeadSha, 'ascii')),
    frameField('mainSha', Buffer.from(input.mainSha, 'ascii')),
    frameField('targetHeadSha', Buffer.from(input.targetHeadSha, 'ascii')),
    frameField('mergeBaseSha', Buffer.from(input.mergeBaseSha, 'ascii')),
    frameField('replayDigest', Buffer.from(input.replayDigest, 'ascii')),
  ];
  for (const conflict of input.conflicts) {
    frames.push(frameField('path', Buffer.from(conflict.pathBytesBase64, 'base64')));
    for (const stage of ['stage1', 'stage2', 'stage3'] as const) {
      frames.push(frameField(`${stage}.mode`, Buffer.from(conflict[stage].mode, 'ascii')));
      frames.push(frameField(`${stage}.oid`, Buffer.from(conflict[stage].oid, 'ascii')));
    }
    frames.push(frameField('resolved.mode', Buffer.from(conflict.resolved.mode, 'ascii')));
    frames.push(frameField('resolved.oid', Buffer.from(conflict.resolved.oid, 'ascii')));
    frames.push(frameField('resolved.bytes', Buffer.from(conflict.resolved.bytesBase64, 'base64')));
  }
  return Buffer.concat(frames);
}

export function replayMergeForCarryover(input: {
  repoRoot: string;
  sourceHeadSha: string;
  mainSha: string;
  targetHeadSha: string;
}): CarryoverReplayResult {
  const repoRoot = resolve(input.repoRoot);
  const sourceHeadSha = resolveCommit(repoRoot, input.sourceHeadSha, 'sourceHeadSha');
  const mainSha = resolveCommit(repoRoot, input.mainSha, 'mainSha');
  const targetHeadSha = resolveCommit(repoRoot, input.targetHeadSha, 'targetHeadSha');
  const parentLine = String(runGit(repoRoot, ['rev-list', '--parents', '-n', '1', targetHeadSha]));
  const parents = parentLine.split(/\s+/).slice(1);
  if (parents.length !== 2 || parents[0] !== sourceHeadSha || parents[1] !== mainSha) {
    throw new PackReviewCarryoverError(
      'carryover_topology_invalid',
      `expected ordered parents ${sourceHeadSha} ${mainSha}; got ${parents.join(' ')}`,
    );
  }
  const mergeBaseSha = fullSha(runGit(repoRoot, ['merge-base', sourceHeadSha, mainSha]), 'mergeBaseSha');
  const configCapture = repositoryConfigCapture(repoRoot, sourceHeadSha, mainSha);
  const replayConfigDigest = sha256(stableJson(configCapture));
  const gitVersion = String((configCapture as { gitVersion: string }).gitVersion);
  const scratch = mkdtempSync(join(tmpdir(), 'pack-review-carryover-'));
  const indexPath = join(scratch, 'index');
  writeFileSync(indexPath, Buffer.alloc(0));
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: indexPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
  };
  try {
    runGit(repoRoot, ['read-tree', '--empty'], { env });
    runGit(repoRoot, ['read-tree', '-i', '-m', mergeBaseSha, sourceHeadSha, mainSha], { env });
    const unmergedBytes = runGit(repoRoot, ['ls-files', '-u', '-z'], {
      env,
      encoding: 'buffer',
    }) as Buffer;
    const unmerged = parseUnmergedEntries(unmergedBytes);
    const conflictPaths = [...unmerged.keys()].sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
    );
    const conflicts: ReplayConflictEntry[] = [];
    for (const path of conflictPaths) {
      const stages = unmerged.get(path)!;
      const stage1 = stages.get(1);
      const stage2 = stages.get(2);
      const stage3 = stages.get(3);
      if (!stage1 || !stage2 || !stage3) {
        throw new PackReviewCarryoverError(
          'carryover_object_unsupported',
          `${path} lacks complete stage-1/2/3 entries`,
        );
      }
      for (const [label, entry] of [['stage1', stage1], ['stage2', stage2], ['stage3', stage3]] as const) {
        if (!['100644', '100755'].includes(entry.mode)) {
          throw new PackReviewCarryoverError(
            'carryover_object_unsupported',
            `${path} ${label} mode ${entry.mode}`,
          );
        }
      }
      const resolvedEntry = parseLsTreeEntry(
        runGit(repoRoot, ['ls-tree', '-z', targetHeadSha, '--', path], { encoding: 'buffer' }) as Buffer,
        path,
      );
      if (!resolvedEntry) {
        throw new PackReviewCarryoverError(
          'carryover_object_unsupported',
          `${path} resolved deletion is unsupported`,
        );
      }
      const resolvedBytes = assertSupportedResolvedBlob(repoRoot, path, resolvedEntry);
      runGit(repoRoot, ['update-index', '--add', '--cacheinfo', `${resolvedEntry.mode},${resolvedEntry.oid},${path}`], { env });
      const pathBytes = Buffer.from(path, 'utf8');
      conflicts.push({
        pathUtf8: path,
        pathBytesBase64: pathBytes.toString('base64'),
        stage1,
        stage2,
        stage3,
        resolved: {
          ...resolvedEntry,
          bytesBase64: resolvedBytes.toString('base64'),
          byteLength: resolvedBytes.length,
        },
      });
    }
    const replayTreeSha = fullSha(runGit(repoRoot, ['write-tree'], { env }), 'replayTreeSha');
    const targetTreeSha = resolveTree(repoRoot, targetHeadSha);
    if (replayTreeSha !== targetTreeSha) {
      throw new PackReviewCarryoverError(
        'carryover_replay_drift',
        `replayed tree ${replayTreeSha} != target tree ${targetTreeSha}`,
      );
    }
    const replayDigest = sha256(stableJson({
      helperVersion: PACK_REVIEW_CARRYOVER_HELPER_VERSION,
      sourceHeadSha,
      mainSha,
      targetHeadSha,
      mergeBaseSha,
      replayTreeSha,
      replayConfigDigest,
      conflicts: conflicts.map(({ pathUtf8, stage1, stage2, stage3, resolved }) => ({
        pathUtf8,
        stage1,
        stage2,
        stage3,
        resolved: { mode: resolved.mode, oid: resolved.oid },
      })),
    }));
    if (conflicts.length === 0) {
      return {
        kind: 'conflict_free_carryover',
        sourceHeadSha,
        mainSha,
        targetHeadSha,
        mergeBaseSha,
        replayTreeSha,
        replayDigest,
      };
    }
    const bundleWithoutFrame: Omit<MergeResolutionBundleV2, 'framedBytesBase64' | 'bundleDigest'> = {
      schema: MERGE_RESOLUTION_BUNDLE_SCHEMA,
      helperVersion: PACK_REVIEW_CARRYOVER_HELPER_VERSION,
      sourceHeadSha,
      mainSha,
      targetHeadSha,
      mergeBaseSha,
      orderedParentShas: [sourceHeadSha, mainSha],
      gitVersion,
      replayConfigDigest,
      replayDigest,
      conflictCount: conflicts.length,
      conflicts,
    };
    const framed = frameBundle(bundleWithoutFrame);
    const bundle: MergeResolutionBundleV2 = {
      ...bundleWithoutFrame,
      framedBytesBase64: framed.toString('base64'),
      bundleDigest: sha256(framed),
    };
    return {
      kind: 'merge_composite',
      sourceHeadSha,
      mainSha,
      targetHeadSha,
      mergeBaseSha,
      replayTreeSha,
      replayDigest,
      bundle,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function validateFocusedResolutionReview(input: {
  replay: CarryoverReplayResult;
  reviewedTargetHeadSha: string;
  reviewedBundleDigest: string;
  verdict: 'clean' | 'findings';
  findingCount: number;
}): { clean: true; targetHeadSha: string; bundleDigest: string } {
  if (input.replay.kind !== 'merge_composite' || !input.replay.bundle) {
    throw new PackReviewCarryoverError('focused_review_invalid', 'no conflict bundle');
  }
  const targetHeadSha = fullSha(input.reviewedTargetHeadSha, 'reviewedTargetHeadSha');
  if (targetHeadSha !== input.replay.targetHeadSha) {
    throw new PackReviewCarryoverError('focused_review_invalid', 'review target does not match exact H1');
  }
  if (input.reviewedBundleDigest !== input.replay.bundle.bundleDigest) {
    throw new PackReviewCarryoverError('focused_review_invalid', 'bundle digest mismatch');
  }
  if (input.verdict !== 'clean' || input.findingCount !== 0) {
    throw new PackReviewCarryoverError('focused_review_findings', 'focused review is not clean');
  }
  return { clean: true, targetHeadSha, bundleDigest: input.reviewedBundleDigest };
}
