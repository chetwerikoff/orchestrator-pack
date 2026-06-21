#!/usr/bin/env node
/**
 * Pinned trusted entrypoint for cross-PR legacy-list guard enforcement (Issue #377).
 * Invoked from base-resolved CI; PR-head retargeting via package.json is inert.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEGACY_LIST_REL_PATH } from './contract-evidence-path.mjs';
import {
  AUTHORIZATIONS_REL_PATH,
  GOVERNED_MANIFEST_REL_PATH,
  evaluateLegacyListGuard,
  formatLegacyListGuardVerdict,
  isGuardPresentOnBase,
  loadGovernedManifest,
  validateBaseAndHeadManifestClosure,
} from './contract-evidence-legacy-list-guard.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} repoRoot
 * @param {string} ref
 * @param {string} relPath
 */
function readGitFile(repoRoot, ref, relPath) {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/**
 * @param {string} repoRoot
 * @param {string} baseSha
 * @param {string} headSha
 */
function listChangedFiles(repoRoot, baseSha, headSha) {
  const output = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string} repoRoot
 * @param {string} baseSha
 * @param {string} headSha
 */
function listNameStatus(repoRoot, baseSha, headSha) {
  const output = execFileSync('git', ['diff', '--name-status', `${baseSha}...${headSha}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  /** @type {Array<{ path: string, status: string, previousPath?: string }>} */
  const entries = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R') && parts.length >= 3) {
      entries.push({
        status: status.charAt(0),
        previousPath: parts[1]?.replace(/\\/g, '/'),
        path: parts[2]?.replace(/\\/g, '/'),
      });
      continue;
    }
    entries.push({
      status: status.charAt(0),
      path: parts[1]?.replace(/\\/g, '/'),
    });
  }
  return entries;
}

function main() {
  const trustedRoot = process.env.LEGACY_LIST_GUARD_TRUSTED_ROOT ?? scriptDir;
  const repoRoot = process.env.LEGACY_LIST_GUARD_REPO_ROOT ?? path.dirname(trustedRoot);
  const baseSha = process.env.LEGACY_LIST_GUARD_BASE_SHA ?? '';
  const headSha = process.env.LEGACY_LIST_GUARD_HEAD_SHA ?? '';
  if (!baseSha || !headSha) {
    const verdict = evaluateLegacyListGuard({
      baseSha: baseSha || 'missing',
      headSha: headSha || 'missing',
      changedFiles: [],
      bootstrap: false,
      baseResolvable: false,
    });
    console.error(formatLegacyListGuardVerdict(verdict));
    process.exit(1);
  }

  const guardOnBase = isGuardPresentOnBase(trustedRoot);
  const bootstrap = !guardOnBase;

  /** @type {ReturnType<typeof loadGovernedManifest>} */
  let manifest;
  if (bootstrap) {
    manifest = {
      legacyListPath: LEGACY_LIST_REL_PATH,
      files: [LEGACY_LIST_REL_PATH],
      fixtureRoots: [],
      pinnedEntrypointDependencies: [],
    };
  } else {
    try {
      manifest = loadGovernedManifest(trustedRoot);
    } catch {
      const verdict = evaluateLegacyListGuard({
        baseSha,
        headSha,
        changedFiles: [GOVERNED_MANIFEST_REL_PATH],
        bootstrap: false,
        baseResolvable: false,
      });
      console.error(formatLegacyListGuardVerdict(verdict));
      process.exit(1);
    }

    const closure = validateBaseAndHeadManifestClosure(trustedRoot, repoRoot, manifest);
    if (!closure.ok) {
      const failed = evaluateLegacyListGuard({
        baseSha,
        headSha,
        changedFiles: manifest.files ?? [],
        bootstrap: false,
        baseResolvable: true,
        manifest,
        baseLegacyListContent: readGitFile(repoRoot, baseSha, manifest.legacyListPath ?? LEGACY_LIST_REL_PATH),
        headLegacyListContent: readGitFile(repoRoot, headSha, manifest.legacyListPath ?? LEGACY_LIST_REL_PATH),
        baseAuthorizations: JSON.parse(readGitFile(repoRoot, baseSha, AUTHORIZATIONS_REL_PATH) ?? '{"authorizations":[]}'),
      });
      failed.verdict = 'fail';
      failed.expected = 'fail';
      failed.reason = `governed manifest dependency closure failed: ${closure.errors.join('; ')}`;
      console.error(formatLegacyListGuardVerdict(failed));
      process.exit(1);
    }
    manifest = closure.headManifest ?? manifest;
  }

  let changedFiles = [];
  let nameStatus = [];
  let baseResolvable = true;
  try {
    changedFiles = listChangedFiles(repoRoot, baseSha, headSha);
    nameStatus = listNameStatus(repoRoot, baseSha, headSha);
  } catch {
    baseResolvable = false;
    changedFiles = manifest.files ?? [LEGACY_LIST_REL_PATH];
  }

  const legacyListPath = manifest.legacyListPath ?? LEGACY_LIST_REL_PATH;
  const verdict = evaluateLegacyListGuard({
    baseSha,
    headSha,
    changedFiles,
    nameStatus,
    baseLegacyListContent: readGitFile(repoRoot, baseSha, legacyListPath),
    headLegacyListContent: readGitFile(repoRoot, headSha, legacyListPath),
    baseAuthorizations: JSON.parse(readGitFile(repoRoot, baseSha, AUTHORIZATIONS_REL_PATH) ?? '{"authorizations":[]}'),
    authFileChanged: changedFiles.includes(AUTHORIZATIONS_REL_PATH),
    bootstrap,
    baseResolvable,
    legacyListPath,
    manifest,
  });

  const output = formatLegacyListGuardVerdict(verdict);
  if (verdict.verdict === 'pass') {
    console.log(output);
    process.exit(0);
  }
  console.error(output);
  process.exit(1);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main();
}
