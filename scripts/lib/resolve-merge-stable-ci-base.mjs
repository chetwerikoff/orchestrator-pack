#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const ENV_KEYS = ['BASE_SHA', 'GITHUB_BASE_SHA', 'PR_BASE_SHA'];
const FALLBACK_REFS = ['origin/main', 'refs/remotes/origin/main', 'main'];
const execFileAsync = promisify(execFile);

async function git(repoRoot, args, allowFailure = false) {
  try {
    const result = await execFileAsync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    return result.stdout.trim();
  } catch (error) {
    if (allowFailure) return null;
    const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr).trim() : '';
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'unknown';
    const detail = stderr || (error instanceof Error ? error.message : `exit ${code}`);
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function unique(values) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean))];
}

/**
 * Resolve the comparison point immediately before the current change set.
 * A candidate whose merge-base is HEAD is deliberately rejected: on push-to-main
 * origin/main normally points at HEAD, which would otherwise turn the gate into an
 * empty/self comparison. The first parent is the context-neutral final fallback.
 */
export async function resolveMergeStableCiBase(repoRoot, explicitCandidates = []) {
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

function parseArgs(argv) {
  const result = { repoRoot: process.cwd(), candidates: [], json: false };
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
