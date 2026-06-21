/**
 * Shared byte-exact, case-sensitive POSIX path canonicalization for the
 * contract-evidence legacy-grandfather list (Issues #366, #377).
 */

import path from 'node:path';

export const LEGACY_LIST_REL_PATH = 'scripts/contract-evidence-legacy-drafts.json';

/**
 * @param {string} input
 * @returns {string | null}
 */
export function canonicalLegacyDraftPath(input) {
  if (typeof input !== 'string') {
    return null;
  }
  let normalized = input.replace(/\\/g, '/').trim();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/, '');
  }
  if (!normalized || normalized === '.') {
    return null;
  }
  return normalized;
}

/**
 * @param {string} content
 */
export function parseLegacyListContent(content) {
  const parsed = JSON.parse(content);
  const rawPaths = Array.isArray(parsed.paths) ? parsed.paths : [];
  /** @type {string[]} */
  const canonicalPaths = [];
  /** @type {string[]} */
  const malformed = [];
  /** @type {string[]} */
  const duplicateEquivalent = [];
  const seen = new Set();

  for (const entry of rawPaths) {
    if (typeof entry !== 'string') {
      malformed.push(String(entry));
      continue;
    }
    const posix = entry.replace(/\\/g, '/');
    const canon = canonicalLegacyDraftPath(posix);
    if (!canon) {
      malformed.push(entry);
      continue;
    }
    if (posix !== canon) {
      malformed.push(entry);
      continue;
    }
    if (seen.has(canon)) {
      duplicateEquivalent.push(entry);
      continue;
    }
    seen.add(canon);
    canonicalPaths.push(canon);
  }

  return {
    paths: canonicalPaths,
    malformed,
    duplicateEquivalent,
    rawPaths,
  };
}

/**
 * @param {string} content
 */
export function loadLegacyPathSet(content) {
  let parsed;
  try {
    parsed = parseLegacyListContent(content);
  } catch (error) {
    return {
      ok: false,
      paths: null,
      errors: [`legacy list is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      malformed: [],
      duplicateEquivalent: [],
    };
  }

  /** @type {string[]} */
  const errors = [];
  if (parsed.malformed.length > 0) {
    errors.push(`legacy list contains malformed paths: ${parsed.malformed.join(', ')}`);
  }
  if (parsed.duplicateEquivalent.length > 0) {
    errors.push(`legacy list contains duplicate-equivalent paths: ${parsed.duplicateEquivalent.join(', ')}`);
  }
  if (errors.length > 0) {
    return {
      ok: false,
      paths: null,
      errors,
      malformed: parsed.malformed,
      duplicateEquivalent: parsed.duplicateEquivalent,
    };
  }

  return {
    ok: true,
    paths: new Set(parsed.paths),
    errors: [],
    malformed: [],
    duplicateEquivalent: [],
  };
}

/**
 * @param {Set<string>} baseSet
 * @param {Set<string>} headSet
 */
export function diffLegacyPathSets(baseSet, headSet) {
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const removed = [];
  for (const pathValue of headSet) {
    if (!baseSet.has(pathValue)) {
      added.push(pathValue);
    }
  }
  for (const pathValue of baseSet) {
    if (!headSet.has(pathValue)) {
      removed.push(pathValue);
    }
  }
  added.sort();
  removed.sort();
  return { added, removed };
}

/**
 * @param {string} repoRoot
 * @param {string | undefined} legacyListPath
 */
export function resolveLegacyListPath(repoRoot, legacyListPath) {
  const candidate = legacyListPath ?? LEGACY_LIST_REL_PATH;
  if (!candidate) {
    return null;
  }
  return path.isAbsolute(candidate) ? candidate : path.join(repoRoot, candidate);
}
