#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_KEYS = ['BASE_SHA', 'GITHUB_BASE_SHA', 'PR_BASE_SHA'];
const FALLBACK_REFS = ['origin/main', 'refs/remotes/origin/main', 'main'];

function git(repoRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = error?.stderr?.toString?.().trim() || error?.message || String(error);
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
export function resolveMergeStableCiBase(repoRoot, explicitCandidates = []) {
  const root = resolve(repoRoot);
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const candidates = unique([
    ...explicitCandidates,
    ...ENV_KEYS.map((key) => process.env[key]),
    ...FALLBACK_REFS,
  ]);

  for (const candidate of candidates) {
    const candidateCommit = git(root, ['rev-parse', '--verify', `${candidate}^{commit}`], { allowFailure: true });
    if (!candidateCommit) continue;
    const mergeBase = git(root, ['merge-base', 'HEAD', candidateCommit], { allowFailure: true });
    if (mergeBase && mergeBase !== head) {
      return { baseRef: candidate, baseSha: mergeBase, headSha: head, source: 'merge-base' };
    }
  }

  const firstParent = git(root, ['rev-parse', '--verify', 'HEAD^1'], { allowFailure: true });
  if (firstParent && firstParent !== head) {
    return { baseRef: 'HEAD^1', baseSha: firstParent, headSha: head, source: 'first-parent' };
  }
  return null;
}

function parseArgs(argv) {
  const result = { repoRoot: process.cwd(), candidates: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo-root') result.repoRoot = argv[++index];
    else if (arg === '--candidate') result.candidates.push(argv[++index]);
    else if (arg === '--json') result.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirect) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const resolved = resolveMergeStableCiBase(args.repoRoot, args.candidates);
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
