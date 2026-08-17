import { posix } from 'node:path';

function normalizeToken(token: string): string {
  return token.replaceAll('\\', '/');
}

function normalizeRepoCandidate(candidate: string): string | undefined {
  if (candidate.startsWith('/') || /^[A-Za-z]:\//u.test(candidate)) return undefined;
  const normalized = posix.normalize(candidate).replace(/^\.\//u, '');
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.' || normalized === '') return undefined;
  return normalized;
}

export interface ScriptTargetResolver {
  readonly resolvesWholePath: (sourcePath: string, candidate: string) => boolean;
  readonly resolve: (sourcePath: string, token: string) => string | undefined;
}

export function createScriptTargetResolver(trackedPs1: readonly string[]): ScriptTargetResolver {
  const tracked = [...new Set(trackedPs1.map((path) => normalizeToken(path).replace(/^\.\//u, '')))];
  const lower = new Map<string, string[]>();
  for (const path of tracked) {
    const key = path.toLowerCase();
    const matches = lower.get(key) ?? [];
    matches.push(path);
    lower.set(key, matches);
  }

  const exactTracked = (candidate: string): readonly string[] => {
    const normalized = normalizeRepoCandidate(candidate);
    return normalized ? (lower.get(normalized.toLowerCase()) ?? []) : [];
  };

  const resolve = (sourcePath: string, token: string): string | undefined => {
    const sourceDir = posix.dirname(normalizeToken(sourcePath));
    const normalizedToken = normalizeToken(token);
    const candidates: string[] = [];
    const psscriptRoot = /^(?:\$PSScriptRoot|\$\{PSScriptRoot\})(?:\/|$)(.*)$/iu.exec(normalizedToken);
    if (psscriptRoot) {
      candidates.push(posix.join(sourceDir, psscriptRoot[1] ?? ''));
    } else if (normalizedToken.startsWith('./') || normalizedToken.startsWith('../')) {
      candidates.push(posix.join(sourceDir, normalizedToken));
    } else {
      candidates.push(normalizedToken, posix.join(sourceDir, normalizedToken));
    }
    const distinct = new Set<string>();
    for (const candidate of candidates) for (const path of exactTracked(candidate)) distinct.add(path);
    return distinct.size === 1 ? [...distinct][0] : undefined;
  };

  return {
    resolve,
    resolvesWholePath: (sourcePath, candidate) => resolve(sourcePath, candidate) !== undefined,
  };
}
