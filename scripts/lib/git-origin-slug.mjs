import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
  const trimmed = url.trim();
  const ssh = /^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh) {
    return ssh[1];
  }
  const https = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (https) {
    return https[1];
  }
  const generic = /[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  return generic ? generic[1] : null;
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
      return gitdir.startsWith('/') ? gitdir : join(repoRoot, gitdir);
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
