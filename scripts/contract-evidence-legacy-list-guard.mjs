/**
 * Contract-evidence legacy-grandfather list anti-tamper guard (Issue #377).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  LEGACY_LIST_REL_PATH,
  canonicalLegacyDraftPath,
  diffLegacyPathSets,
  loadLegacyPathSet,
} from './contract-evidence-path.mjs';

export const GOVERNED_MANIFEST_REL_PATH = 'scripts/contract-evidence-legacy-governed-manifest.json';
export const AUTHORIZATIONS_REL_PATH = 'scripts/contract-evidence-legacy-authorizations.json';
export const GUARD_MODULE_REL_PATH = 'scripts/contract-evidence-legacy-list-guard.mjs';
export const VERDICT_BINDING_ID = 'orchestrator-pack:legacy-list-guard-verdict';

const LOCAL_IMPORT_RE = /(?:import|export)\s+(?:[^'";]*?from\s+)?['"](\.\.?\/[^'"]+)['"]/g;

/**
 * @param {string} fromRel
 * @param {string} spec
 */
export function resolveRelativeImport(fromRel, spec) {
  const fromDir = path.posix.dirname(fromRel.replace(/\\/g, '/'));
  let resolved = path.posix.normalize(path.posix.join(fromDir, spec.replace(/\\/g, '/')));
  if (!resolved.endsWith('.mjs') && !resolved.endsWith('.json') && !resolved.endsWith('.mts')) {
    resolved = `${resolved}.mjs`;
  }
  return resolved;
}

/**
 * @param {string} trustedRoot
 * @param {string} entrypointRel
 */
export function collectEntrypointDependencyClosure(trustedRoot, entrypointRel) {
  /** @type {Set<string>} */
  const closure = new Set();
  /** @type {string[]} */
  const queue = [entrypointRel.replace(/\\/g, '/')];

  while (queue.length > 0) {
    const rel = queue.pop();
    if (!rel || closure.has(rel)) {
      continue;
    }
    const full = path.join(trustedRoot, rel);
    if (!existsSync(full)) {
      continue;
    }
    closure.add(rel);
    const content = readFileSync(full, 'utf8');
    LOCAL_IMPORT_RE.lastIndex = 0;
    let match = LOCAL_IMPORT_RE.exec(content);
    while (match) {
      const resolved = resolveRelativeImport(rel, match[1] ?? '');
      if (!closure.has(resolved)) {
        queue.push(resolved);
      }
      match = LOCAL_IMPORT_RE.exec(content);
    }
  }

  return closure;
}

/**
 * @typedef {Object} LegacyListGuardVerdict
 * @property {'pass' | 'fail'} verdict
 * @property {'pass' | 'fail'} expected
 * @property {string} bindingId
 * @property {string[]} addedPaths
 * @property {string[]} removedPaths
 * @property {string[]} changedGovernedFiles
 * @property {string} baseSha
 * @property {string} headSha
 * @property {{ type: string, id: string } | null} authorization
 * @property {string} reason
 * @property {boolean} bootstrap
 * @property {boolean} policyPass
 */

/**
 * @param {string} repoRoot
 * @param {string} [manifestRelPath]
 */
export function loadGovernedManifest(repoRoot, manifestRelPath = GOVERNED_MANIFEST_REL_PATH) {
  const manifestPath = path.join(repoRoot, manifestRelPath);
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/**
 * @param {ReturnType<typeof loadGovernedManifest>} manifest
 */
export function unionGovernedSurfacePaths(...manifests) {
  /** @type {Set<string>} */
  const paths = new Set();
  for (const manifest of manifests) {
    if (!manifest) {
      continue;
    }
    for (const entry of governedSurfacePaths(manifest)) {
      paths.add(entry);
    }
  }
  return paths;
}

export function governedSurfacePaths(manifest) {
  /** @type {Set<string>} */
  const paths = new Set();
  for (const entry of manifest.files ?? []) {
    paths.add(String(entry).replace(/\\/g, '/'));
  }
  for (const root of manifest.fixtureRoots ?? []) {
    paths.add(String(root).replace(/\\/g, '/'));
  }
  return paths;
}

/**
 * @param {string} trustedRoot
 * @param {ReturnType<typeof loadGovernedManifest>} manifest
 */
export function validateManifestClosure(trustedRoot, manifest) {
  /** @type {string[]} */
  const errors = [];
  const governed = governedSurfacePaths(manifest);
  for (const rel of governed) {
    const full = path.join(trustedRoot, rel);
    if (!existsSync(full)) {
      errors.push(`governed manifest entry missing on disk: ${rel}`);
    }
  }
  for (const rel of manifest.pinnedEntrypointDependencies ?? []) {
    const normalized = String(rel).replace(/\\/g, '/');
    if (!governed.has(normalized)) {
      errors.push(`pinned entrypoint dependency is not listed in governed files: ${normalized}`);
    }
    const full = path.join(trustedRoot, normalized);
    if (!existsSync(full)) {
      errors.push(`pinned entrypoint dependency missing on disk: ${normalized}`);
    }
  }
  const entrypoint = String(manifest.pinnedEntrypoint ?? '').replace(/\\/g, '/');
  if (entrypoint && !governed.has(entrypoint)) {
    errors.push(`pinned entrypoint is not listed in governed files: ${entrypoint}`);
  }
  if (entrypoint) {
    const actualClosure = collectEntrypointDependencyClosure(trustedRoot, entrypoint);
    for (const rel of actualClosure) {
      if (!governed.has(rel)) {
        errors.push(`entrypoint dependency is not listed in governed files: ${rel}`);
      }
    }
    const declaredDeps = new Set(
      (manifest.pinnedEntrypointDependencies ?? []).map((rel) => String(rel).replace(/\\/g, '/')),
    );
    for (const rel of actualClosure) {
      if (rel !== entrypoint && !declaredDeps.has(rel)) {
        errors.push(`entrypoint dependency missing from pinnedEntrypointDependencies: ${rel}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}


/**
 * @param {string} trustedRoot
 * @param {string} headRoot
 * @param {ReturnType<typeof loadGovernedManifest>} baseManifest
 */
export function validateBaseAndHeadManifestClosure(trustedRoot, headRoot, baseManifest) {
  /** @type {string[]} */
  const errors = [];
  const baseClosure = validateManifestClosure(trustedRoot, baseManifest);
  if (!baseClosure.ok) {
    errors.push(...baseClosure.errors.map((entry) => `base: ${entry}`));
  }
  let headManifest;
  try {
    headManifest = loadGovernedManifest(headRoot);
  } catch {
    errors.push('head governed manifest unavailable');
    return { ok: false, errors };
  }
  const headClosure = validateManifestClosure(headRoot, headManifest);
  if (!headClosure.ok) {
    errors.push(...headClosure.errors.map((entry) => `head: ${entry}`));
  }
  return { ok: errors.length === 0, errors, headManifest };
}

/**
 * @param {string} trustedRoot
 */
export function isGuardPresentOnBase(trustedRoot) {
  return existsSync(path.join(trustedRoot, GUARD_MODULE_REL_PATH))
    && existsSync(path.join(trustedRoot, GOVERNED_MANIFEST_REL_PATH));
}

/**
 * @param {string[]} changedFiles
 * @param {Set<string>} governed
 */
export function computeChangedGovernedFiles(changedFiles, governed) {
  /** @type {string[]} */
  const changed = [];
  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, '/');
    if (governed.has(normalized)) {
      changed.push(normalized);
      continue;
    }
    for (const governedPath of governed) {
      if (governedPath.endsWith('/') && normalized.startsWith(governedPath)) {
        changed.push(normalized);
        break;
      }
      if (!governedPath.endsWith('/') && normalized.startsWith(`${governedPath}/`)) {
        changed.push(normalized);
        break;
      }
    }
  }
  return [...new Set(changed)].sort();
}

/**
 * @param {Array<{ path: string, status: string, previousPath?: string }>} nameStatus
 * @param {string} legacyListPath
 */
export function detectLegacyListRelocation(nameStatus, legacyListPath) {
  for (const entry of nameStatus) {
    if (entry.path === legacyListPath && (entry.status === 'D' || entry.status === 'R')) {
      return true;
    }
    if (entry.status === 'R' && entry.previousPath === legacyListPath) {
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown} store
 */
export function parseAuthorizationStore(store) {
  const authorizations = Array.isArray(store?.authorizations) ? store.authorizations : [];
  return authorizations;
}

/**
 * @param {Array<Record<string, unknown>>} authorizations
 * @param {{ baseSha: string, headSha: string, addedPaths: string[], changedGovernedFiles: string[] }} scope
 */
export function findMatchingAuthorization(authorizations, scope) {
  const wantAdded = [...scope.addedPaths].map((entry) => canonicalLegacyDraftPath(entry) ?? entry).sort();
  const wantChanged = [...scope.changedGovernedFiles].sort();
  for (const auth of authorizations) {
    const authBaseSha = String(auth.baseSha ?? '').trim();
    if (!authBaseSha || authBaseSha !== scope.baseSha) {
      continue;
    }
    const authHeadSha = String(auth.headSha ?? '').trim();
    if (!authHeadSha || authHeadSha !== scope.headSha) {
      continue;
    }
    const authAdded = [...(Array.isArray(auth.addedPaths) ? auth.addedPaths : [])]
      .map((entry) => canonicalLegacyDraftPath(String(entry)) ?? String(entry))
      .sort();
    const authChanged = [...(Array.isArray(auth.changedGovernedFiles) ? auth.changedGovernedFiles : [])]
      .map((entry) => String(entry).replace(/\\/g, '/'))
      .sort();
    if (authAdded.join('\0') !== wantAdded.join('\0')) {
      continue;
    }
    if (authChanged.join('\0') !== wantChanged.join('\0')) {
      continue;
    }
    const source = auth.source && typeof auth.source === 'object'
      ? {
          type: String(/** @type {{ type?: string }} */ (auth.source).type ?? ''),
          id: String(/** @type {{ id?: string }} */ (auth.source).id ?? ''),
        }
      : { type: '', id: '' };
    return {
      authorization: source,
      reason: String(auth.reason ?? ''),
      id: String(auth.id ?? source.id ?? ''),
    };
  }
  return null;
}

/**
 * @param {Object} options
 * @param {string} options.baseSha
 * @param {string} options.headSha
 * @param {string[]} options.changedFiles
 * @param {Array<{ path: string, status: string, previousPath?: string }>} [options.nameStatus]
 * @param {string | null} [options.baseLegacyListContent]
 * @param {string | null} [options.headLegacyListContent]
 * @param {unknown} [options.baseAuthorizations]
 * @param {boolean} [options.authFileChanged]
 * @param {boolean} [options.bootstrap]
 * @param {boolean} [options.baseResolvable]
 * @param {string} [options.legacyListPath]
 * @param {ReturnType<typeof loadGovernedManifest>} [options.manifest]
 * @param {ReturnType<typeof loadGovernedManifest>} [options.headManifest]
 */
export function evaluateLegacyListGuard(options) {
  const legacyListPath = (options.legacyListPath ?? LEGACY_LIST_REL_PATH).replace(/\\/g, '/');
  const manifest = options.manifest ?? {
    legacyListPath,
    files: [legacyListPath],
    fixtureRoots: [],
    pinnedEntrypointDependencies: [],
  };
  const headManifest = options.headManifest ?? manifest;
  const governed = unionGovernedSurfacePaths(manifest, headManifest);
  const changedGovernedFiles = computeChangedGovernedFiles(options.changedFiles ?? [], governed);
  const bootstrap = options.bootstrap === true;
  const baseResolvable = options.baseResolvable !== false;

  /** @type {LegacyListGuardVerdict} */
  const baseVerdict = {
    verdict: 'fail',
    expected: 'fail',
    bindingId: VERDICT_BINDING_ID,
    addedPaths: [],
    removedPaths: [],
    changedGovernedFiles,
    baseSha: options.baseSha,
    headSha: options.headSha,
    authorization: null,
    reason: '',
    bootstrap,
    policyPass: false,
  };

  if (bootstrap) {
    return {
      ...baseVerdict,
      verdict: 'pass',
      expected: 'pass',
      reason: 'bootstrap: guard absent on merge base; fixture/e2e mode only (no live policy verdict)',
      policyPass: true,
    };
  }

  if (!baseResolvable) {
    return {
      ...baseVerdict,
      reason: 'comparison base is stale or unresolvable; fail-closed for gated changes',
    };
  }

  if (changedGovernedFiles.length === 0) {
    return {
      ...baseVerdict,
      verdict: 'pass',
      expected: 'pass',
      reason: 'policy-pass: PR touches none of the governed surface',
      policyPass: true,
    };
  }

  if (options.nameStatus && detectLegacyListRelocation(options.nameStatus, legacyListPath)) {
    const scope = {
      baseSha: options.baseSha,
      headSha: options.headSha,
      addedPaths: [],
      changedGovernedFiles,
    };
    const authorizations = parseAuthorizationStore(options.baseAuthorizations);
    const match = findMatchingAuthorization(authorizations, scope);
    if (!match) {
      return {
        ...baseVerdict,
        reason: 'legacy list relocation away from canonical path requires owner authorization',
      };
    }
    return {
      ...baseVerdict,
      verdict: 'pass',
      expected: 'pass',
      authorization: match.authorization,
      reason: match.reason || 'authorized legacy list relocation',
      policyPass: false,
    };
  }

  const baseContent = options.baseLegacyListContent;
  const headContent = options.headLegacyListContent;
  if (baseContent == null || headContent == null) {
    return {
      ...baseVerdict,
      reason: 'legacy list content unavailable at base or head; fail-closed',
    };
  }

  const baseSet = loadLegacyPathSet(baseContent);
  const headSet = loadLegacyPathSet(headContent);
  if (!headSet.ok || !headSet.paths) {
    return {
      ...baseVerdict,
      reason: headSet.errors[0] ?? 'head legacy list is malformed',
    };
  }
  if (!baseSet.ok || !baseSet.paths) {
    return {
      ...baseVerdict,
      reason: baseSet.errors[0] ?? 'base legacy list is malformed',
    };
  }

  const { added, removed } = diffLegacyPathSets(baseSet.paths, headSet.paths);
  const authFileChanged = options.authFileChanged === true
    || changedGovernedFiles.includes(AUTHORIZATIONS_REL_PATH);

  if (added.length > 0 && authFileChanged) {
    return {
      ...baseVerdict,
      addedPaths: added,
      removedPaths: removed,
      reason: 'self-authorization rejected: authorization source changed in the same diff as path additions',
    };
  }

  const nonListGovernedChanged = changedGovernedFiles.filter((entry) => entry !== legacyListPath);
  const listOnlyChange = changedGovernedFiles.length > 0
    && nonListGovernedChanged.length === 0
    && changedGovernedFiles.every((entry) => entry === legacyListPath);

  if (listOnlyChange && added.length === 0) {
    return {
      ...baseVerdict,
      verdict: 'pass',
      expected: 'pass',
      addedPaths: added,
      removedPaths: removed,
      reason: removed.length > 0
        ? 'path removal from legacy list is permitted without owner authorization'
        : 'legacy list reorder/reformat with identical normalized path set',
      policyPass: false,
    };
  }

  const needsAuthorization = added.length > 0 || nonListGovernedChanged.length > 0;
  if (!needsAuthorization) {
    return {
      ...baseVerdict,
      verdict: 'pass',
      expected: 'pass',
      addedPaths: added,
      removedPaths: removed,
      reason: 'governed-surface diff requires no authorization',
      policyPass: false,
    };
  }

  const scope = {
    baseSha: options.baseSha,
    headSha: options.headSha,
    addedPaths: added,
    changedGovernedFiles,
  };
  const authorizations = parseAuthorizationStore(options.baseAuthorizations);
  const match = findMatchingAuthorization(authorizations, scope);
  if (!match) {
    const reason = added.length > 0
      ? `unauthorized legacy path addition: ${added.join(', ')}`
      : `unauthorized governed-surface modification: ${changedGovernedFiles.join(', ')}`;
    return {
      ...baseVerdict,
      verdict: 'fail',
      expected: 'fail',
      addedPaths: added,
      removedPaths: removed,
      reason,
    };
  }

  return {
    ...baseVerdict,
    verdict: 'pass',
    expected: 'pass',
    addedPaths: added,
    removedPaths: removed,
    authorization: match.authorization,
    reason: match.reason || 'owner-authorized governed change',
    policyPass: false,
  };
}

/**
 * @param {LegacyListGuardVerdict} verdict
 */
export function formatLegacyListGuardVerdict(verdict) {
  return JSON.stringify(verdict, null, 2);
}
