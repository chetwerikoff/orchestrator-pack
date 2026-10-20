import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Git argv shapes issued by gh-repo-resolve — guard must keep these read-only. */
export const RESOLVER_GIT_ARGV = Object.freeze([
  Object.freeze(['rev-parse', '--show-toplevel']),
  Object.freeze(['config', '--get', 'remote.origin.url']),
]);

/**
 * @param {string} url
 * @returns {string | null}
 */
export function parseRemoteSlug(url) {
  const remote = String(url ?? '').trim();
  // Only GitHub-hosted HTTPS and authenticated git SSH remotes confer
  // repository identity. No generic owner/repo or foreign-host fallback.
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu.exec(remote);
  if (!match) return null;
  const owner = match[1];
  const repository = match[2];
  if (!/^[A-Za-z0-9-]+$/u.test(owner)
    || !/^[A-Za-z0-9._-]+$/u.test(repository)
    || repository === '.' || repository === '..'
    || owner.startsWith('-') || owner.endsWith('-')) {
    return null;
  }
  // Preserve GitHub's original casing; only equality checks case-fold.
  return owner + '/' + repository;
}

/**
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function resolveGitCommonDir(repoRoot) {
  const dotGit = join(repoRoot, '.git');
  if (!existsSync(dotGit)) {
    return null;
  }
  if (statSync(dotGit).isFile()) {
    const pointer = readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/m.exec(pointer);
    if (match) {
      const gitdir = match[1].trim();
      const resolvedGitDir = gitdir.startsWith('/') ? gitdir : join(repoRoot, gitdir);
      const commonDirPointer = join(resolvedGitDir, 'commondir');
      if (existsSync(commonDirPointer)) {
        const commonRel = readFileSync(commonDirPointer, 'utf8').trim();
        return commonRel.startsWith('/') ? commonRel : resolve(resolvedGitDir, commonRel);
      }
      return resolvedGitDir;
    }
  }
  return dotGit;
}

/**
 * Read remote.origin.url directly from git config — no git subprocess.
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function readOriginUrlFromGitConfig(repoRoot) {
  const gitDir = resolveGitCommonDir(repoRoot);
  if (!gitDir) {
    return null;
  }
  const configPath = join(gitDir, 'config');
  if (!existsSync(configPath)) {
    return null;
  }
  const content = readFileSync(configPath, 'utf8');
  const sectionMatch = /\[remote "origin"\]([\s\S]*?)(?=\n\[|\s*$)/i.exec(content);
  if (!sectionMatch) {
    return null;
  }
  const urlMatch = /^\s*url\s*=\s*(.+)\s*$/im.exec(sectionMatch[1]);
  return urlMatch ? urlMatch[1].trim() : null;
}

/**
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function originSlugFromGitConfig(repoRoot) {
  const url = readOriginUrlFromGitConfig(repoRoot);
  return url ? parseRemoteSlug(url) : null;
}
