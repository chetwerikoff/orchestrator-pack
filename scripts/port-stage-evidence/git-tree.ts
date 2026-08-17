import { createHash } from 'node:crypto';
import { runProcess } from '#opk-kernel/subprocess';

export interface MeasuredTreeFile {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly blobSha: string;
  readonly bytes: Buffer;
}

export interface MeasuredTree {
  readonly measuredHead: string;
  readonly files: readonly MeasuredTreeFile[];
  readonly byPath: ReadonlyMap<string, MeasuredTreeFile>;
  readonly inputFactTreeDigest: string;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exactCommit(repoRoot: string, candidate: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/u.test(candidate)) throw new Error('measuredHead must be a full lowercase 40-hex Git SHA');
  const result = await runProcess({
    command: 'git',
    args: ['rev-parse', '--verify', `${candidate}^{commit}`],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
  });
  if (!result.ok) throw new Error(`cannot resolve measuredHead ${candidate}: ${result.stderr || result.error || result.outcome}`);
  const resolved = result.stdout.trim();
  if (resolved !== candidate) throw new Error(`measuredHead did not resolve exactly: requested=${candidate} resolved=${resolved}`);
  return resolved;
}

interface TreeEntry {
  readonly mode: '100644' | '100755';
  readonly blobSha: string;
  readonly path: string;
}

async function listRegularFiles(repoRoot: string, measuredHead: string): Promise<readonly TreeEntry[]> {
  const result = await runProcess({
    command: 'git',
    args: ['ls-tree', '-rz', '--full-tree', measuredHead],
    cwd: repoRoot,
    inheritParentEnv: true,
    encoding: 'latin1',
    allowEmptyStdout: true,
  });
  if (!result.ok) throw new Error(`cannot enumerate measured tree ${measuredHead}: ${result.stderr || result.error || result.outcome}`);
  const entries: TreeEntry[] = [];
  for (const raw of result.stdout.split('\0')) {
    if (!raw) continue;
    const tab = raw.indexOf('\t');
    if (tab < 0) throw new Error('malformed git ls-tree record');
    const header = raw.slice(0, tab);
    const path = normalizePath(raw.slice(tab + 1));
    const match = /^(100644|100755) blob ([0-9a-f]{40})$/u.exec(header);
    if (!match) continue;
    entries.push({ mode: match[1] as TreeEntry['mode'], blobSha: match[2]!, path });
  }
  entries.sort((left, right) => compareOrdinal(left.path, right.path));
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`duplicate regular file in measured tree: ${entry.path}`);
    paths.add(entry.path);
  }
  return entries;
}

function parseBatchOutput(output: string, entries: readonly TreeEntry[]): readonly Buffer[] {
  const bytes = Buffer.from(output, 'latin1');
  const result: Buffer[] = [];
  let cursor = 0;
  for (const entry of entries) {
    const lf = bytes.indexOf(0x0a, cursor);
    if (lf < 0) throw new Error(`git cat-file batch response missing header for ${entry.path}`);
    const header = bytes.subarray(cursor, lf).toString('ascii');
    const match = /^([0-9a-f]{40}) blob ([0-9]+)$/u.exec(header);
    if (!match || match[1] !== entry.blobSha) throw new Error(`git cat-file batch identity mismatch for ${entry.path}: ${header}`);
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid git blob size for ${entry.path}: ${match[2]}`);
    const start = lf + 1;
    const end = start + size;
    if (end >= bytes.length || bytes[end] !== 0x0a) throw new Error(`git cat-file batch truncated blob for ${entry.path}`);
    const blob = Buffer.from(bytes.subarray(start, end));
    result.push(blob);
    cursor = end + 1;
  }
  if (cursor !== bytes.length) throw new Error('git cat-file batch emitted unexpected trailing bytes');
  return result;
}

async function readBlobs(repoRoot: string, entries: readonly TreeEntry[]): Promise<readonly Buffer[]> {
  if (entries.length === 0) return [];
  const result = await runProcess({
    command: 'git',
    args: ['cat-file', '--batch'],
    cwd: repoRoot,
    inheritParentEnv: true,
    input: `${entries.map((entry) => entry.blobSha).join('\n')}\n`,
    encoding: 'latin1',
    allowEmptyStdout: false,
  });
  if (!result.ok) throw new Error(`cannot read measured Git blobs: ${result.stderr || result.error || result.outcome}`);
  return parseBatchOutput(result.stdout, entries);
}

export async function loadMeasuredTree(repoRoot: string, candidateHead: string): Promise<MeasuredTree> {
  const measuredHead = await exactCommit(repoRoot, candidateHead);
  const entries = await listRegularFiles(repoRoot, measuredHead);
  const blobs = await readBlobs(repoRoot, entries);
  const files = entries.map((entry, index): MeasuredTreeFile => ({ ...entry, bytes: blobs[index]! }));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const digestPayload = files.map((file) => `${file.mode} ${file.blobSha}\t${file.path}\n`).join('');
  return { measuredHead, files, byPath, inputFactTreeDigest: sha256(Buffer.from(digestPayload, 'utf8')) };
}

export function assertUntrackedStagePath(tree: MeasuredTree, path: string): void {
  if (tree.byPath.has(normalizePath(path))) throw new Error(`stage projection path must be untracked at measuredHead: ${path}`);
}
