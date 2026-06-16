/**
 * Corpus-source classifier for read-delegation audit (Issue #309).
 * Imported by docs/read-delegation-audit.mjs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(dirname(fileURLToPath(import.meta.url))));

export const CLASSIFIER_MANIFEST_PATH = join(
  repoRoot,
  'docs',
  'read-delegation-classifier-input.json',
);

export const AUDIT_BLOCKING_STATUSES = {
  CAPTURED_HEAD_MISMATCH: 'captured-head-mismatch',
  SAME_KEY_CONFLICT: 'same-key-conflict',
  MISSING_CAPTURE_FIELD: 'missing-capture-field',
  MANIFEST_INVALID: 'manifest-invalid',
};

export const READ_CLASSIFICATIONS = {
  FENCE: 'fence',
  CODE_CLASS: 'code-class',
  INDEX_SERVED: 'index-served',
  OUT_OF_INDEX: 'out-of-index',
};

const OUT_OF_INDEX_KINDS = new Set(['diff', 'log', 'external', 'fetched']);

/** @type {Record<string, unknown> | null} */
let cachedManifest = null;
/** @type {string | null} */
let cachedManifestHash = null;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Classifier-local path pattern matcher for committed manifest patterns only.
 * @param {string} pattern
 * @param {string} candidate
 */
function globMatches(pattern, candidate) {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const normalizedCandidate = candidate.replace(/\\/g, '/');
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.startsWith('*.')) {
    return normalizedCandidate.endsWith(normalizedPattern.slice(1));
  }
  if (normalizedPattern.includes('*')) {
    const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(normalizedCandidate);
  }
  return normalizedPattern === normalizedCandidate;
}

export function loadClassifierManifest(manifestPath = CLASSIFIER_MANIFEST_PATH) {
  if (cachedManifest && manifestPath === CLASSIFIER_MANIFEST_PATH) {
    return { manifest: cachedManifest, hash: cachedManifestHash };
  }
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  validateManifestShape(manifest);
  const hash = createHash('sha256').update(raw).digest('hex');
  if (manifestPath === CLASSIFIER_MANIFEST_PATH) {
    cachedManifest = manifest;
    cachedManifestHash = hash;
  }
  return { manifest, hash };
}

/**
 * @param {unknown} manifest
 */
export function validateManifestShape(manifest) {
  if (!isRecord(manifest)) {
    throw new Error('classifier manifest must be an object');
  }
  const broad = Array.isArray(manifest.broadRootDenylist) ? manifest.broadRootDenylist : [];
  const roots = Array.isArray(manifest.allowedSourceRoots) ? manifest.allowedSourceRoots : [];
  for (const root of roots) {
    if (typeof root === 'string' && broad.includes(root)) {
      throw new Error(`accidentally broad allowed source root rejected: ${root}`);
    }
  }
}

export function classifierManifestHash(manifestPath = CLASSIFIER_MANIFEST_PATH) {
  return loadClassifierManifest(manifestPath).hash;
}

/**
 * @param {string | undefined} surface
 * @param {Record<string, unknown>} manifest
 */
export function normalizeCursorSurface(surface, manifest) {
  const raw = String(surface ?? '').trim().toLowerCase();
  const table = isRecord(manifest.cursorSurfaces) ? manifest.cursorSurfaces : {};
  for (const [canonical, aliases] of Object.entries(table)) {
    if (!Array.isArray(aliases)) continue;
    if (aliases.some((alias) => String(alias).toLowerCase() === raw)) {
      return canonical;
    }
  }
  return raw || undefined;
}

/**
 * @param {string | undefined} surface
 * @param {Record<string, unknown>} manifest
 */
export function isKnownCursorSurface(surface, manifest) {
  const normalized = normalizeCursorSurface(surface, manifest);
  const table = isRecord(manifest.cursorSurfaces) ? manifest.cursorSurfaces : {};
  return normalized !== undefined && Object.prototype.hasOwnProperty.call(table, normalized);
}

/**
 * @param {string | undefined} filePath
 * @param {string} [root]
 */
export function canonicalizeRepoPath(filePath, root = repoRoot) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false, path: undefined, reason: 'empty-path' };
  }
  let candidate = filePath.trim().replace(/\\/g, '/');
  const wslMatch = candidate.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (wslMatch) {
    candidate = `${wslMatch[1].toUpperCase()}:/${wslMatch[2]}`;
  }
  try {
    const absolute = resolve(root, candidate);
    let canonical = absolute;
    if (existsSync(absolute)) {
      canonical = realpathSync(absolute);
    }
    const rel = relative(root, canonical).replace(/\\/g, '/');
    if (rel.startsWith('..') || rel.includes('/../')) {
      return { ok: false, path: rel, reason: 'escapes-repo-root' };
    }
    return { ok: true, path: rel, reason: undefined };
  } catch {
    const normalized = normalize(candidate).replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (normalized.includes('..')) {
      return { ok: false, path: normalized, reason: 'uncanonicalizable' };
    }
    return { ok: true, path: normalized, reason: undefined };
  }
}

const GIT_COMMIT_REF_PATTERN = /^(?:HEAD|[0-9a-fA-F]{7,40})$/;

/**
 * @param {string | undefined} commit
 */
export function isSafeGitCommitRef(commit) {
  return typeof commit === 'string' && GIT_COMMIT_REF_PATTERN.test(commit.trim());
}

/**
 * @param {string} commit
 * @param {Set<string>} [override]
 */
export function loadGitTrackedPaths(commit, override) {
  if (override) {
    return override;
  }
  const ref = String(commit ?? '').trim();
  if (!isSafeGitCommitRef(ref)) {
    return new Set();
  }
  try {
    const output = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(
      output
        .split('\n')
        .map((line) => line.trim().replace(/\\/g, '/'))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function currentGitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * @param {string | undefined} left
 * @param {string | undefined} right
 */
export function gitCommitRefsEquivalent(left, right) {
  if (!left || !right) {
    return left === right;
  }
  if (left === right) {
    return true;
  }
  try {
    const resolvedLeft = execFileSync('git', ['rev-parse', left], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const resolvedRight = execFileSync('git', ['rev-parse', right], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return resolvedLeft === resolvedRight;
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, unknown>} row
 * @returns {import('./read-delegation-audit.d.mts').ReadEntry}
 */
function normalizeClassifierRead(row) {
  const kind =
    row.kind === 'diff' || row.kind === 'log' || row.kind === 'external' || row.kind === 'fetched'
      ? row.kind
      : 'file';
  return {
    path: typeof row.path === 'string' ? row.path : undefined,
    lines: Math.max(0, Number(row.lines) || 0),
    kind,
    isCodeClass: row.isCodeClass === true,
    fenceSignal: row.fenceSignal === true,
    capturedCommit: typeof row.capturedCommit === 'string' ? row.capturedCommit : undefined,
    classifierManifestHash:
      typeof row.classifierManifestHash === 'string' ? row.classifierManifestHash : undefined,
    surface: typeof row.surface === 'string' ? row.surface : undefined,
    readDiscriminator:
      typeof row.readDiscriminator === 'string' ? row.readDiscriminator : undefined,
    canonicalPath: typeof row.canonicalPath === 'string' ? row.canonicalPath : undefined,
    unitKey: typeof row.unitKey === 'string' ? row.unitKey : undefined,
  };
}

/**
 * @param {import('./read-delegation-audit.d.mts').CapturedReadEntry} read
 */
export function buildPerReadIdentity(unitKey, read, readDiscriminator) {
  const canonical = read.canonicalPath ?? read.path ?? '';
  const kind = read.kind ?? 'file';
  return `${unitKey}:${readDiscriminator}:${canonical}:${kind}`;
}

const VERDICT_AFFECTING_FIELDS = [
  'fenceSignal',
  'isCodeClass',
  'surface',
  'capturedCommit',
  'classifierManifestHash',
  'path',
  'lines',
  'kind',
];

/**
 * @param {import('./read-delegation-audit.d.mts').CapturedReadEntry} read
 */
export function validateCaptureFields(read) {
  const missing = [];
  for (const field of VERDICT_AFFECTING_FIELDS) {
    if (field === 'fenceSignal' || field === 'isCodeClass') {
      if (read[field] === undefined) {
        continue;
      }
    }
    const value = read[field];
    if (value === undefined || value === null) {
      missing.push(field);
      continue;
    }
    if (field === 'lines' && (typeof value !== 'number' || Number.isNaN(value))) {
      missing.push(field);
    }
    if ((field === 'path' || field === 'kind') && typeof value !== 'string') {
      missing.push(field);
    }
  }
  return missing;
}

/**
 * @param {import('./read-delegation-audit.d.mts').CapturedReadEntry} read
 * @param {Record<string, unknown>} manifest
 * @param {{ surface: string, repoRoot?: string, trackedPaths?: Set<string>, checkoutCommit?: string }} ctx
 */
export function classifyReadPhaseA(read, manifest, ctx) {
  if (read.fenceSignal === true) {
    return {
      classification: READ_CLASSIFICATIONS.FENCE,
      branch: 'phase-a-fence',
      indexServedEligible: false,
      record: {
        fenceSignal: true,
        canonicalPath: read.canonicalPath ?? read.path,
        capturedCommit: read.capturedCommit,
        classifierManifestHash: read.classifierManifestHash,
      },
    };
  }

  const usesClassifierCapture = ctx.usesClassifierCapture === true;
  if (usesClassifierCapture) {
    const missing = validateCaptureFields(read);
    if (missing.length > 0) {
      return {
        blocking: true,
        status: AUDIT_BLOCKING_STATUSES.MISSING_CAPTURE_FIELD,
        missingFields: missing,
        artifact: { readPath: read.path, missingFields: missing },
      };
    }
    if (read.classifierManifestHash !== classifierManifestHash()) {
      return {
        blocking: true,
        status: AUDIT_BLOCKING_STATUSES.MANIFEST_INVALID,
        artifact: {
          expected: classifierManifestHash(),
          observed: read.classifierManifestHash,
        },
      };
    }
    const checkout = ctx.checkoutCommit ?? currentGitHead();
    if (
      checkout &&
      read.capturedCommit &&
      !gitCommitRefsEquivalent(read.capturedCommit, checkout)
    ) {
      return {
        blocking: true,
        status: AUDIT_BLOCKING_STATUSES.CAPTURED_HEAD_MISMATCH,
        artifact: {
          capturedCommit: read.capturedCommit,
          checkoutCommit: checkout,
        },
      };
    }
  }

  const readSurface = read.surface ?? ctx.surface;
  const cursorKnown = isKnownCursorSurface(readSurface, manifest);
  return {
    classification: undefined,
    branch: 'phase-a-pass',
    indexServedEligible: cursorKnown,
    normalizedSurface: normalizeCursorSurface(readSurface, manifest),
    cursorKnown,
  };
}

/**
 * @param {import('./read-delegation-audit.d.mts').CapturedReadEntry} read
 * @param {Record<string, unknown>} manifest
 * @param {{ trackedPaths: Set<string>, indexServedEligible: boolean }} ctx
 */
export function classifyReadPhaseB(read, manifest, ctx) {
  const canonicalResult = canonicalizeRepoPath(read.path);
  const canonicalPath = canonicalResult.ok ? canonicalResult.path : read.path;

  const kind = read.kind ?? 'file';
  if (OUT_OF_INDEX_KINDS.has(kind)) {
    return {
      classification: READ_CLASSIFICATIONS.OUT_OF_INDEX,
      branch: 'kind-short-circuit',
      canonicalPath,
      kind,
      record: {
        classification: READ_CLASSIFICATIONS.OUT_OF_INDEX,
        branch: 'kind-short-circuit',
        canonicalPath,
        kind,
      },
    };
  }

  const denyPatterns = Array.isArray(manifest.denyPatterns) ? manifest.denyPatterns : [];
  for (const pattern of denyPatterns) {
    if (globMatches(String(pattern), String(canonicalPath))) {
      return {
        classification: READ_CLASSIFICATIONS.OUT_OF_INDEX,
        branch: 'deny-pattern',
        canonicalPath,
        matchedDenyPattern: pattern,
        record: {
          classification: READ_CLASSIFICATIONS.OUT_OF_INDEX,
          branch: 'deny-pattern',
          canonicalPath,
          matchedDenyPattern: pattern,
        },
      };
    }
  }

  if (ctx.indexServedEligible && kind === 'file') {
    const indexResult = classifyIndexServed(read, manifest, ctx, canonicalPath);
    if (indexResult) {
      return indexResult;
    }
  }

  if (read.isCodeClass === true) {
    return {
      classification: READ_CLASSIFICATIONS.CODE_CLASS,
      branch: 'code-class-gate',
      canonicalPath,
      gitTracked: ctx.trackedPaths.has(String(canonicalPath)),
      record: buildIndexServedStyleRecord(read, manifest, ctx, {
        classification: READ_CLASSIFICATIONS.CODE_CLASS,
        branch: 'code-class-gate',
        canonicalPath,
        isCodeClass: true,
      }),
    };
  }

  return {
    classification: READ_CLASSIFICATIONS.OUT_OF_INDEX,
    branch: 'ordinary-out-of-index',
    canonicalPath,
    record: {
      classification: READ_CLASSIFICATIONS.OUT_OF_INDEX,
      branch: 'ordinary-out-of-index',
      canonicalPath,
    },
  };
}

/**
 * @param {import('./read-delegation-audit.d.mts').CapturedReadEntry} read
 * @param {Record<string, unknown>} manifest
 * @param {{ trackedPaths: Set<string> }} ctx
 * @param {string | undefined} canonicalPath
 */
function classifyIndexServed(read, manifest, ctx, canonicalPath) {
  if (!canonicalPath) {
    return undefined;
  }
  if (isSubmoduleOrGitlink(canonicalPath, ctx.trackedPaths)) {
    return {
      classification: READ_CLASSIFICATIONS.OUT_OF_INDEX,
      branch: 'submodule-gitlink',
      canonicalPath,
      record: buildIndexServedStyleRecord(read, manifest, ctx, {
        classification: READ_CLASSIFICATIONS.OUT_OF_INDEX,
        branch: 'submodule-gitlink',
        canonicalPath,
        submoduleRejected: true,
      }),
    };
  }

  const gitTracked = ctx.trackedPaths.has(canonicalPath);
  const allowedRoot = matchAllowedRoot(canonicalPath, manifest);
  const sourceCodeMatch = isSourceCodePath(canonicalPath, manifest);
  const indexIgnored = isCursorIndexIgnored(canonicalPath, manifest);

  const eligible =
    gitTracked && allowedRoot !== undefined && sourceCodeMatch && !indexIgnored;

  if (eligible) {
    return {
      classification: READ_CLASSIFICATIONS.INDEX_SERVED,
      branch: 'index-served',
      canonicalPath,
      gitTracked,
      allowedRoot,
      sourceCodeMatch,
      indexIgnored,
      record: buildIndexServedStyleRecord(read, manifest, ctx, {
        classification: READ_CLASSIFICATIONS.INDEX_SERVED,
        branch: 'index-served',
        canonicalPath,
        gitTracked,
        matchedAllowedRoot: allowedRoot,
        sourceCodeClassifierMatch: sourceCodeMatch,
        cursorIndexIgnoreExcluded: indexIgnored,
        submoduleRejected: false,
        denominatorImpact: 'excluded',
        excludedLineCount: read.lines,
      }),
    };
  }

  return undefined;
}

/**
 * @param {string} canonicalPath
 * @param {Set<string>} trackedPaths
 */
function isSubmoduleOrGitlink(canonicalPath, trackedPaths) {
  if (canonicalPath.includes('.git/modules/')) {
    return true;
  }
  return canonicalPath.split('/').some((segment) => segment.endsWith('.git'));
}

/**
 * @param {string} canonicalPath
 * @param {Record<string, unknown>} manifest
 */
function matchAllowedRoot(canonicalPath, manifest) {
  const roots = Array.isArray(manifest.allowedSourceRoots) ? manifest.allowedSourceRoots : [];
  for (const root of roots) {
    if (globMatches(String(root), canonicalPath)) {
      return root;
    }
  }
  return undefined;
}

/**
 * @param {string} canonicalPath
 * @param {Record<string, unknown>} manifest
 */
export function isSourceCodePath(canonicalPath, manifest) {
  const lower = canonicalPath.toLowerCase();
  const extensions = Array.isArray(manifest.sourceCodeExtensions)
    ? manifest.sourceCodeExtensions
    : [];
  for (const ext of extensions) {
    if (lower.endsWith(String(ext).toLowerCase())) {
      return true;
    }
  }
  const base = basename(canonicalPath);
  const extensionless = Array.isArray(manifest.extensionlessSourceFilenames)
    ? manifest.extensionlessSourceFilenames
    : [];
  return extensionless.some((name) => base === name || base.toLowerCase() === String(name).toLowerCase());
}

/**
 * @param {string} canonicalPath
 * @param {Record<string, unknown>} manifest
 */
function isCursorIndexIgnored(canonicalPath, manifest) {
  const patterns = Array.isArray(manifest.cursorIndexIgnorePatterns)
    ? manifest.cursorIndexIgnorePatterns
    : [];
  return patterns.some((pattern) => globMatches(String(pattern), canonicalPath));
}

function buildIndexServedStyleRecord(read, manifest, ctx, fields) {
  return {
    perReadIdentity: buildPerReadIdentity(
      read.unitKey ?? 'unit',
      read,
      read.readDiscriminator ?? '0',
    ),
    capturedCommit: read.capturedCommit,
    classifierManifestHash: read.classifierManifestHash ?? classifierManifestHash(),
    surfaceNormalization: normalizeCursorSurface(read.surface ?? ctx.surface, manifest),
    ...fields,
  };
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 * @param {{ surface: string, checkoutCommit?: string, trackedPathsOverride?: Set<string> }} session
 */
export function classifyUnitReads(unit, session) {
  const { manifest } = loadClassifierManifest();
  const reads = Array.isArray(unit.reads) ? unit.reads : [];
  const capturedCommit = unit.capturedCommit ?? reads.find((r) => r.capturedCommit)?.capturedCommit;
  const trackedPaths = loadGitTrackedPaths(
    String(capturedCommit ?? currentGitHead() ?? 'HEAD'),
    session.trackedPathsOverride,
  );

  /** @type {import('./read-delegation-audit.d.mts').ReadClassificationResult[]} */
  const results = [];
  /** @type {import('./read-delegation-audit.d.mts').AuditBlockingFailure | undefined} */
  let blocking;

  const identityMap = new Map();

  reads.forEach((read, index) => {
    const raw = isRecord(read) ? read : {};
    const enrichedForValidation = {
      ...raw,
      unitKey: unit.key,
      readDiscriminator: raw.readDiscriminator ?? String(index),
      surface: raw.surface ?? session.surface,
      capturedCommit: raw.capturedCommit ?? unit.capturedCommit,
      classifierManifestHash: raw.classifierManifestHash ?? unit.classifierManifestHash,
    };

    const phaseA = classifyReadPhaseA(enrichedForValidation, manifest, {
      surface: session.surface,
      checkoutCommit: session.checkoutCommit,
      usesClassifierCapture:
        enrichedForValidation.capturedCommit !== undefined ||
        enrichedForValidation.classifierManifestHash !== undefined,
    });
    if (phaseA.blocking) {
      blocking = {
        status: phaseA.status,
        artifact: phaseA.artifact,
      };
      return;
    }

    const enriched = normalizeClassifierRead(enrichedForValidation);

    if (phaseA.classification === READ_CLASSIFICATIONS.FENCE) {
      results.push({
        read: enriched,
        classification: READ_CLASSIFICATIONS.FENCE,
        exclusionRecord: phaseA.record,
        delegable: false,
        excludedFromDenominator: true,
      });
      return;
    }

    const phaseB = classifyReadPhaseB(enriched, manifest, {
      trackedPaths,
      indexServedEligible: phaseA.indexServedEligible === true,
    });

    const identity = buildPerReadIdentity(unit.key, enriched, enriched.readDiscriminator);
    const prior = identityMap.get(identity);
    if (prior) {
      const conflict = VERDICT_AFFECTING_FIELDS.some(
        (field) => prior.read[field] !== enriched[field],
      );
      if (conflict) {
        blocking = {
          status: AUDIT_BLOCKING_STATUSES.SAME_KEY_CONFLICT,
          artifact: { perReadIdentity: identity, fields: VERDICT_AFFECTING_FIELDS },
        };
        return;
      }
    } else {
      identityMap.set(identity, { read: enriched });
    }

    const classification = phaseB.classification ?? READ_CLASSIFICATIONS.OUT_OF_INDEX;
    const excluded =
      classification === READ_CLASSIFICATIONS.CODE_CLASS ||
      classification === READ_CLASSIFICATIONS.INDEX_SERVED ||
      classification === READ_CLASSIFICATIONS.FENCE;
    results.push({
      read: enriched,
      classification,
      exclusionRecord: phaseB.record,
      delegable: classification === READ_CLASSIFICATIONS.OUT_OF_INDEX,
      excludedFromDenominator: excluded,
    });
  });

  return { results, blocking, manifestHash: classifierManifestHash() };
}

/**
 * @param {import('./read-delegation-audit.d.mts').ReadClassificationResult[]} classifications
 */
export function delegableReadsFromClassifications(classifications) {
  return classifications.filter((row) => row.delegable).map((row) => row.read);
}

/**
 * @param {import('./read-delegation-audit.d.mts').ReadClassificationResult[]} classifications
 */
export function indexServedExcludedVolume(classifications) {
  return classifications
    .filter((row) => row.classification === READ_CLASSIFICATIONS.INDEX_SERVED)
    .reduce((sum, row) => sum + (row.read.lines ?? 0), 0);
}

export { repoRoot as classifierRepoRoot };
