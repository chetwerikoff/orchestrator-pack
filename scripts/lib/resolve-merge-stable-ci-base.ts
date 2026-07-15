#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from '#opk-kernel/subprocess';

const ENV_KEYS = ['BASE_SHA', 'GITHUB_BASE_SHA', 'PR_BASE_SHA'];
const FALLBACK_REFS = ['origin/main', 'refs/remotes/origin/main', 'main'];

export interface MergeStableCiBase {
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly source: 'merge-base' | 'first-parent';
}

async function git(repoRoot: string, args: readonly string[], allowFailure = false): Promise<string | null> {
  const result = await runProcess({
    command: 'git',
    args,
    cwd: repoRoot,
    allowEmptyStdout: true,
  });
  if (result.ok) return result.stdout.trim();
  if (allowFailure) return null;
  const detail = result.stderr.trim() || result.error || `exit ${String(result.exitCode)}`;
  throw new Error(`git ${args.join(' ')} failed: ${detail}`);
}

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

/**
 * Resolve the comparison point immediately before the current change set.
 * A candidate whose merge-base is HEAD is deliberately rejected: on push-to-main
 * origin/main normally points at HEAD, which would otherwise turn the gate into an
 * empty/self comparison. The first parent is the context-neutral final fallback.
 */
export async function resolveMergeStableCiBase(
  repoRoot: string,
  explicitCandidates: readonly string[] = [],
): Promise<MergeStableCiBase | null> {
  const root = resolve(repoRoot);
  const head = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], true);
  if (!head) return null;
  const candidates = unique([
    ...explicitCandidates,
    ...ENV_KEYS.map((key) => process.env[key]),
    ...FALLBACK_REFS,
  ]);

  for (const candidate of candidates) {
    const candidateCommit = await git(root, ['rev-parse', '--verify', `${candidate}^{commit}`], true);
    if (!candidateCommit) continue;
    const mergeBase = await git(root, ['merge-base', 'HEAD', candidateCommit], true);
    if (mergeBase && mergeBase !== head) {
      return { baseRef: candidate, baseSha: mergeBase, headSha: head, source: 'merge-base' };
    }
  }

  const firstParent = await git(root, ['rev-parse', '--verify', 'HEAD^1'], true);
  if (firstParent && firstParent !== head) {
    return { baseRef: 'HEAD^1', baseSha: firstParent, headSha: head, source: 'first-parent' };
  }
  return null;
}

function parseArgs(argv: readonly string[]): { repoRoot: string; candidates: string[]; json: boolean } {
  const result = { repoRoot: process.cwd(), candidates: [] as string[], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo-root') result.repoRoot = argv[++index] ?? result.repoRoot;
    else if (arg === '--candidate') result.candidates.push(argv[++index] ?? '');
    else if (arg === '--json') result.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const resolved = await resolveMergeStableCiBase(args.repoRoot, args.candidates);
    if (!resolved) {
      console.error('[FAIL] unable to resolve a non-self CI comparison base');
      process.exit(1);
    }
    console.log(args.json ? JSON.stringify(resolved) : resolved.baseSha);
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
