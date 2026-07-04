import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MANIFEST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'draft-author-relocation-surfaces.json',
);

/**
 * @typedef {object} CompletionRecord
 * @property {string} [briefIdentity]
 * @property {string} [draftPath]
 * @property {string} [authoringEngine]
 * @property {string} [selectionBasis]
 * @property {string} [tierResult]
 * @property {string} [reviewLoopOutcome]
 * @property {string} [dispositionStatus]
 * @property {string} [disciplineChecks]
 * @property {string} [finalStatus]
 */

/**
 * @typedef {object} DelegateResult
 * @property {number} [exitCode]
 * @property {string} [draftPath]
 * @property {CompletionRecord} [completionRecord]
 * @property {boolean} [draftExists]
 * @property {boolean} [disciplineChecksPass]
 */

const REQUIRED_COMPLETION_FIELDS = [
  'briefIdentity',
  'draftPath',
  'authoringEngine',
  'selectionBasis',
  'tierResult',
  'reviewLoopOutcome',
  'dispositionStatus',
  'disciplineChecks',
  'finalStatus',
];

const ALLOWED_ENGINES = new Set(['cursor', 'codex', 'sonnet-5', 'sonnet5']);
const NON_CURSOR_ENGINES = new Set(['codex', 'sonnet-5', 'sonnet5']);
const DRAFT_PATH_PREFIX = 'docs/issues_drafts/';

/**
 * @param {string | undefined} draftPath
 */
function normalizeDraftPath(draftPath) {
  return String(draftPath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

/**
 * Canonicalize a repo-relative draft path and reject traversals that escape
 * docs/issues_drafts/.
 * @param {string | undefined} draftPath
 * @returns {string | null}
 */
function canonicalizeDraftPath(draftPath) {
  const normalized = normalizeDraftPath(draftPath);
  if (!normalized || path.isAbsolute(normalized)) {
    return null;
  }

  const canonical = path.posix.normalize(normalized);
  if (
    canonical.startsWith('../') ||
    canonical.includes('/../') ||
    canonical === '..' ||
    !canonical.startsWith(DRAFT_PATH_PREFIX) ||
    canonical.length <= DRAFT_PATH_PREFIX.length ||
    !canonical.endsWith('.md')
  ) {
    return null;
  }

  return canonical;
}

/**
 * @param {string | undefined} draftPath
 */
function isExpectedDraftPath(draftPath) {
  return canonicalizeDraftPath(draftPath) !== null;
}

/**
 * @param {CompletionRecord | null | undefined} record
 */
export function validateCompletionRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return { ok: false, errors: ['completion record missing or not an object'] };
  }

  for (const field of REQUIRED_COMPLETION_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      errors.push(`completion record missing required field: ${field}`);
    }
  }

  const engine = String(record.authoringEngine ?? '').toLowerCase();
  const basis = String(record.selectionBasis ?? '').toLowerCase();
  if (!ALLOWED_ENGINES.has(engine)) {
    errors.push(
      `unrecognized authoringEngine "${record.authoringEngine}"; allowed: cursor, codex, sonnet-5`,
    );
  } else if (NON_CURSOR_ENGINES.has(engine) && basis !== 'explicit-request') {
    errors.push(
      `non-Cursor engine "${record.authoringEngine}" requires selectionBasis explicit-request`,
    );
  }

  if (!isExpectedDraftPath(record.draftPath)) {
    errors.push(
      `draftPath must be an authored draft under ${DRAFT_PATH_PREFIX}*.md`,
    );
  }

  if (String(record.disciplineChecks).toLowerCase() !== 'pass') {
    errors.push('disciplineChecks must be pass for a complete run');
  }

  if (String(record.finalStatus).toLowerCase() !== 'complete') {
    errors.push('finalStatus must be complete for a complete run');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Rejects delegate results that exit 0 without draft/completion proof.
 * @param {DelegateResult} result
 * @param {{ repoRoot?: string }} [options]
 */
export function validateDelegateResult(result, options = {}) {
  const errors = [];
  const exitCode = result?.exitCode ?? 1;

  if (exitCode !== 0) {
    return { ok: false, errors: ['delegate exited non-zero'] };
  }

  const draftPath = result?.draftPath;
  if (!draftPath) {
    errors.push('exit 0 but draftPath missing');
  } else if (!isExpectedDraftPath(draftPath)) {
    errors.push(
      `exit 0 but draftPath must be an authored draft under ${DRAFT_PATH_PREFIX}*.md without path traversal`,
    );
  } else {
    const canonical = canonicalizeDraftPath(draftPath);
    const absolute = path.join(options.repoRoot ?? process.cwd(), canonical);
    const exists = result.draftExists ?? existsSync(absolute);
    if (!exists) {
      errors.push(`exit 0 but draft missing at ${draftPath}`);
    }
  }

  if (result.disciplineChecksPass === false) {
    errors.push('exit 0 but discipline checks did not pass');
  }

  const completion = validateCompletionRecord(result.completionRecord);
  if (!completion.ok) {
    errors.push(...completion.errors.map((e) => `exit 0 but ${e}`));
  } else if (result.completionRecord?.draftPath) {
    const delegatePath = canonicalizeDraftPath(draftPath);
    const recordPath = canonicalizeDraftPath(result.completionRecord.draftPath);
    if (!delegatePath || !recordPath || delegatePath !== recordPath) {
      errors.push(
        `exit 0 but draftPath "${draftPath}" does not match completion record draftPath "${result.completionRecord.draftPath}"`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {string} repoRoot
 * @param {string} [manifestPath]
 */
export function checkRelocationContractSurfaces(repoRoot, manifestPath = DEFAULT_MANIFEST) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const errors = [];

  for (const surface of manifest.surfaces) {
    const absolute = path.join(repoRoot, surface.path);
    let content;
    try {
      content = readFileSync(absolute, 'utf8');
    } catch {
      errors.push(`missing surface ${surface.id}: ${surface.path}`);
      continue;
    }
    for (const marker of surface.requiredMarkers) {
      if (!content.includes(marker)) {
        errors.push(`surface ${surface.id} missing marker: ${marker}`);
      }
    }
  }

  for (const rule of manifest.forbiddenPermissivePatterns ?? []) {
    const regex = new RegExp(rule.pattern, 'i');
    for (const rel of rule.surfaces) {
      const absolute = path.join(repoRoot, rel);
      let content;
      try {
        content = readFileSync(absolute, 'utf8');
      } catch {
        errors.push(`missing surface for forbidden pattern ${rule.id}: ${rel}`);
        continue;
      }
      if (regex.test(content)) {
        errors.push(`surface ${rel} contains forbidden permissive pattern (${rule.id})`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function isCliMain() {
  const entry = process.argv[1]?.replace(/\\/g, '/');
  return Boolean(entry?.endsWith('draft-author-relocation-contract.mjs'));
}

export function runCli(argv) {
  const repoRootFlag = argv.indexOf('--repo-root');
  const repoRoot =
    repoRootFlag >= 0
      ? argv[repoRootFlag + 1]
      : path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

  const result = checkRelocationContractSurfaces(repoRoot);
  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`draft-author-relocation: ${error}\n`);
    }
    return 1;
  }
  process.stdout.write('draft-author-relocation contract surfaces: PASS\n');
  return 0;
}

if (isCliMain()) {
  process.exit(runCli(process.argv));
}
