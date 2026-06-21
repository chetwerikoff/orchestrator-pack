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
  compareAuthorizedRevisionContent,
  evaluateLegacyListGuard,
  formatLegacyListGuardVerdict,
  isGuardPresentOnBase,
  loadGovernedManifest,
  validateBaseAndHeadManifestClosure,
  validateManifestClosure,
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
  let baseManifest;
  /** @type {ReturnType<typeof loadGovernedManifest> | undefined} */
  let headManifest;
  let baseParentSha = '';
  try {
    baseParentSha = execFileSync('git', ['rev-parse', `${baseSha}^`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    baseParentSha = '';
  }

  if (bootstrap) {
    try {
      baseManifest = loadGovernedManifest(repoRoot);
    } catch {
      const verdict = evaluateLegacyListGuard({
        baseSha,
        headSha,
        changedFiles: [GOVERNED_MANIFEST_REL_PATH],
        bootstrap: true,
        baseResolvable: false,
      });
      console.error(formatLegacyListGuardVerdict(verdict));
      process.exit(1);
    }
    const bootstrapClosure = validateManifestClosure(repoRoot, baseManifest);
    if (!bootstrapClosure.ok) {
      const failed = evaluateLegacyListGuard({
        baseSha,
        headSha,
        changedFiles: baseManifest.files ?? [],
        bootstrap: true,
        baseResolvable: true,
        manifest: baseManifest,
      });
      failed.verdict = 'fail';
      failed.expected = 'fail';
      failed.reason = `bootstrap governed manifest dependency closure failed: ${bootstrapClosure.errors.join('; ')}`;
      console.error(formatLegacyListGuardVerdict(failed));
      process.exit(1);
    }
    headManifest = baseManifest;
  } else {
    try {
      baseManifest = loadGovernedManifest(trustedRoot);
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

    const closure = validateBaseAndHeadManifestClosure(trustedRoot, repoRoot, baseManifest);
    if (!closure.ok) {
      const failed = evaluateLegacyListGuard({
        baseSha,
        headSha,
        changedFiles: baseManifest.files ?? [],
        bootstrap: false,
        baseResolvable: true,
        manifest: baseManifest,
        baseLegacyListContent: readGitFile(repoRoot, baseSha, baseManifest.legacyListPath ?? LEGACY_LIST_REL_PATH),
        headLegacyListContent: readGitFile(repoRoot, headSha, baseManifest.legacyListPath ?? LEGACY_LIST_REL_PATH),
        baseAuthorizations: JSON.parse(readGitFile(repoRoot, baseSha, AUTHORIZATIONS_REL_PATH) ?? '{"authorizations":[]}'),
      });
      failed.verdict = 'fail';
      failed.expected = 'fail';
      failed.reason = `governed manifest dependency closure failed: ${closure.errors.join('; ')}`;
      console.error(formatLegacyListGuardVerdict(failed));
      process.exit(1);
    }
    headManifest = closure.headManifest;
  }

  let changedFiles = [];
  let nameStatus = [];
  let baseResolvable = true;
  try {
    changedFiles = listChangedFiles(repoRoot, baseSha, headSha);
    nameStatus = listNameStatus(repoRoot, baseSha, headSha);
  } catch {
    baseResolvable = false;
    changedFiles = baseManifest.files ?? [LEGACY_LIST_REL_PATH];
  }

  if (!bootstrap && !headManifest) {
    try {
      headManifest = loadGovernedManifest(repoRoot);
    } catch {
      headManifest = baseManifest;
    }
  }
  const legacyListPath = baseManifest.legacyListPath ?? LEGACY_LIST_REL_PATH;
  const verifyAuthorizedRevision = (auth, scope) => compareAuthorizedRevisionContent(
    auth,
    scope,
    (ref, relPath) => readGitFile(repoRoot, ref, relPath),
  );
  const verdict = evaluateLegacyListGuard({
    baseSha,
    headSha,
    changedFiles,
    nameStatus,
    baseLegacyListContent: readGitFile(repoRoot, baseSha, legacyListPath),
    headLegacyListContent: readGitFile(repoRoot, headSha, legacyListPath),
    baseAuthorizations: JSON.parse(readGitFile(repoRoot, baseSha, AUTHORIZATIONS_REL_PATH) ?? '{"authorizations":[]}'),
    headAuthorizationsContent: readGitFile(repoRoot, headSha, AUTHORIZATIONS_REL_PATH),
    authFileChanged: changedFiles.includes(AUTHORIZATIONS_REL_PATH),
    bootstrap,
    baseResolvable,
    legacyListPath,
    manifest: baseManifest,
    headManifest,
    baseParentSha,
    verifyAuthorizedRevision,
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
