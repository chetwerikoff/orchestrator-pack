/**
 * T3 stage-completeness guard core.
 *
 * Issue #1120 makes the canonical T3 business sequence:
 * competitive -> architectural-review -> Claude lens -> GPT lens.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseComplexityTierFence } from './tier-gate-core.ts';
import { resolveReviewArtifacts } from './tier-gate-floor.ts';

export const GRANDFATHERED_REVIEW_DIR_BASENAMES = new Set([
  '206-ao-010-session-status-readers-migration',
]);

export const COMPETITIVE_WAIVER_FILENAME = 'competitive-stage-waiver.json';
export const ARCHITECT_LENS_WAIVER_FILENAME = 'architect-lens-stage-waiver.json';

const COUNTED_STAGE_TOKENS = new Set([
  'competitive',
  'architectural-review',
  'architectural-lens',
  'architectural',
]);

const CAPTURE_FILENAME_RE =
  /^pass-(\d+)-(competitive|architectural-review|architectural-lens|architectural-final|architectural)\.capture\.txt$/i;
const COUNTED_STAGE_FILENAME_TOKEN_RE =
  /competitive|architectural-review|architectural-lens|architectural-final|architectural/i;

const PARSEABLE_WAIVER_REASONS = new Set(['codex-substitution', 'operator-waiver']);
const PARSEABLE_LENS_WAIVER_REASONS = new Set(['claude-unavailable']);
const CREDITED_LENS_UNAVAILABILITY_KINDS = new Set([
  'quota',
  'rate-limit',
  'provider-unavailable',
  'cli-unavailable',
]);

export interface ParsedCapture {
  passIndex: number;
  stage: string;
  fileName: string;
}

export interface CompetitiveWaiver {
  reason: string;
  recordedAt: string;
  afterPass: number;
}

export interface ArchitectLensWaiver {
  reason: string;
  recordedAt: string;
  afterPass: number;
  unavailability: string;
}

export interface StageCompletenessGuardOptions {
  repoRoot?: string;
  draftPath?: string;
}

export interface StageCompletenessGuardResult {
  ok: boolean;
  errors: string[];
  noop: boolean;
  receipt: {
    tier: string;
    competitiveAnchor: number;
    architecturalReviewPass: number;
    lensMax: number | null;
    lensSkipAnchor: number | null;
    terminalPass: number;
  } | null;
}

const ISO_8601_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isStrictIso8601Timestamp(value: string): boolean {
  return ISO_8601_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));
}

function parseAfterPassAnchor(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export function parseCaptureFileName(fileName: string): ParsedCapture | null {
  const match = CAPTURE_FILENAME_RE.exec(fileName);
  if (!match?.[1] || !match[2]) return null;
  const passIndex = Number.parseInt(match[1], 10);
  if (!Number.isInteger(passIndex) || passIndex < 0) return null;
  return { passIndex, stage: match[2].toLowerCase(), fileName };
}

export function referencesCountedStageFilenameToken(fileName: string): boolean {
  return COUNTED_STAGE_FILENAME_TOKEN_RE.test(fileName);
}

export function parseCompetitiveWaiver(
  reviewDir: string,
): { waiver: CompetitiveWaiver | null; invalid: boolean } {
  const waiverPath = join(reviewDir, COMPETITIVE_WAIVER_FILENAME);
  if (!existsSync(waiverPath)) return { waiver: null, invalid: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(waiverPath, 'utf8'));
  } catch {
    return { waiver: null, invalid: true };
  }
  if (!parsed || typeof parsed !== 'object') return { waiver: null, invalid: true };
  const record = parsed as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const recordedAt = typeof record['recorded-at'] === 'string' ? record['recorded-at'].trim() : '';
  const afterPass = parseAfterPassAnchor(record['after-pass']);
  if (!PARSEABLE_WAIVER_REASONS.has(reason)
    || !recordedAt
    || !isStrictIso8601Timestamp(recordedAt)
    || afterPass === null) {
    return { waiver: null, invalid: true };
  }
  return { waiver: { reason, recordedAt, afterPass }, invalid: false };
}

export function parseArchitectLensWaiver(
  reviewDir: string,
): { waiver: ArchitectLensWaiver | null; invalid: boolean } {
  const waiverPath = join(reviewDir, ARCHITECT_LENS_WAIVER_FILENAME);
  if (!existsSync(waiverPath)) return { waiver: null, invalid: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(waiverPath, 'utf8'));
  } catch {
    return { waiver: null, invalid: true };
  }
  if (!parsed || typeof parsed !== 'object') return { waiver: null, invalid: true };
  const record = parsed as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const recordedAt = typeof record['recorded-at'] === 'string' ? record['recorded-at'].trim() : '';
  const unavailability = typeof record.unavailability === 'string' ? record.unavailability.trim() : '';
  const afterPass = parseAfterPassAnchor(record['after-pass']);
  if (!PARSEABLE_LENS_WAIVER_REASONS.has(reason)
    || !recordedAt
    || !isStrictIso8601Timestamp(recordedAt)
    || !CREDITED_LENS_UNAVAILABILITY_KINDS.has(unavailability)
    || afterPass === null) {
    return { waiver: null, invalid: true };
  }
  return { waiver: { reason, recordedAt, afterPass, unavailability }, invalid: false };
}

function loadReviewCaptures(reviewDir: string): { captures: ParsedCapture[]; errors: string[] } {
  const captures: ParsedCapture[] = [];
  const errors: string[] = [];
  if (!existsSync(reviewDir)) return { captures, errors };
  for (const fileName of readdirSync(reviewDir).sort()) {
    if (!fileName.endsWith('.capture.txt')) continue;
    const parsed = parseCaptureFileName(fileName);
    if (!parsed) {
      if (referencesCountedStageFilenameToken(fileName)) {
        errors.push(`unparseable capture filename: ${fileName}`);
      }
      continue;
    }
    if (!COUNTED_STAGE_TOKENS.has(parsed.stage)) continue;
    const body = readFileSync(join(reviewDir, fileName), 'utf8').trim();
    if (!body) {
      errors.push(`empty capture file: ${fileName}`);
      continue;
    }
    captures.push(parsed);
  }
  return { captures, errors };
}

function capturesFor(captures: readonly ParsedCapture[], stage: string): ParsedCapture[] {
  return captures.filter((capture) => capture.stage === stage);
}

function singlePass(
  captures: readonly ParsedCapture[],
  stage: string,
  errors: string[],
  missingMessage: string,
  duplicateMessage: string,
): number | null {
  const matches = capturesFor(captures, stage);
  if (matches.length === 0) {
    errors.push(missingMessage);
    return null;
  }
  if (matches.length !== 1) {
    errors.push(duplicateMessage);
    return null;
  }
  return matches[0]!.passIndex;
}

export function resolveRepoRootFromDraftPath(draftPath?: string): string {
  if (!draftPath) return process.cwd();
  const normalized = draftPath.replace(/\\/g, '/');
  const marker = '/docs/issues_drafts/';
  const idx = normalized.lastIndexOf(marker);
  return idx >= 0 ? normalized.slice(0, idx) : process.cwd();
}

export function checkStageCompletenessGuard(
  draftText: string,
  options: StageCompletenessGuardOptions = {},
): StageCompletenessGuardResult {
  const fence = parseComplexityTierFence(draftText);
  if (fence.kind !== 'tier-fence' || fence.tier !== 'T3') {
    return { ok: true, errors: [], noop: true, receipt: null };
  }
  if (!options.draftPath) {
    return {
      ok: false,
      errors: ['draft path is required for T3 stage-completeness checks'],
      noop: false,
      receipt: null,
    };
  }

  const repoRoot = options.repoRoot ?? process.cwd();
  const { capturesDir } = resolveReviewArtifacts(options.draftPath, repoRoot);
  if (GRANDFATHERED_REVIEW_DIR_BASENAMES.has(basename(capturesDir))) {
    return { ok: true, errors: [], noop: false, receipt: null };
  }

  const errors: string[] = [];
  const loaded = loadReviewCaptures(capturesDir);
  errors.push(...loaded.errors);
  const captures = loaded.captures;

  const competitive = capturesFor(captures, 'competitive');
  if (competitive.length === 0) errors.push('missing competitive stage');
  if (competitive.length > 3) errors.push('competitive stage ceiling exceeded (maximum three passes allowed)');
  const competitiveAnchor = competitive.length > 0
    ? Math.max(...competitive.map((capture) => capture.passIndex))
    : null;

  // Historical competitive waivers remain parseable audit bytes, but #1120 no longer
  // lets a waiver replace the mandatory real competitive Browser-GPT pass.
  const { invalid: invalidCompetitiveWaiver } = parseCompetitiveWaiver(capturesDir);
  if (invalidCompetitiveWaiver) errors.push('invalid competitive-stage waiver record');

  const architecturalReviewPass = singlePass(
    captures,
    'architectural-review',
    errors,
    'missing architectural-review stage',
    'architectural-review stage ceiling exceeded (exactly one pass allowed)',
  );
  if (competitiveAnchor !== null
    && architecturalReviewPass !== null
    && architecturalReviewPass <= competitiveAnchor) {
    errors.push('architectural-review stage out of order (must be strictly after competitive anchor)');
  }

  const lensCaptures = capturesFor(captures, 'architectural-lens');
  const { waiver: lensWaiver, invalid: invalidLensWaiver } = parseArchitectLensWaiver(capturesDir);
  if (lensCaptures.length > 1) {
    errors.push('architect-lens stage ceiling exceeded (exactly one Claude lens allowed)');
  }
  if (lensCaptures.length > 0 && lensWaiver) {
    errors.push('architect-lens skip record cannot coexist with an architectural-lens capture (skip is not Claude provenance)');
  }

  const lensMax = lensCaptures.length === 1 ? lensCaptures[0]!.passIndex : null;
  let lensSkipAnchor: number | null = null;
  let preTerminalAnchor: number | null = null;
  if (lensMax !== null) {
    preTerminalAnchor = lensMax;
    if (architecturalReviewPass !== null && lensMax <= architecturalReviewPass) {
      errors.push('architect-lens stage out of order (must be strictly after architectural-review)');
    }
  } else if (lensWaiver) {
    lensSkipAnchor = lensWaiver.afterPass;
    preTerminalAnchor = lensSkipAnchor;
    if (architecturalReviewPass !== null && lensSkipAnchor <= architecturalReviewPass) {
      errors.push('claude-unavailable skip anchor out of order (must be strictly after architectural-review)');
    }
  } else {
    if (invalidLensWaiver) errors.push('invalid architect-lens skip record');
    errors.push('missing architect-lens stage (no capture and no valid claude-unavailable skip)');
  }

  const terminalCaptures = capturesFor(captures, 'architectural');
  let terminalPass: number | null = null;
  if (terminalCaptures.length === 0) {
    errors.push('missing terminal architectural stage');
  } else if (terminalCaptures.length !== 1) {
    errors.push('terminal architectural stage ceiling exceeded (exactly one GPT lens allowed)');
  } else {
    terminalPass = terminalCaptures[0]!.passIndex;
    if (preTerminalAnchor !== null && terminalPass <= preTerminalAnchor) {
      errors.push('terminal GPT capture out of order (must be strictly after Claude lens/skip anchor)');
    }
  }

  if (errors.length > 0
    || competitiveAnchor === null
    || architecturalReviewPass === null
    || preTerminalAnchor === null
    || terminalPass === null) {
    return { ok: false, errors, noop: false, receipt: null };
  }

  return {
    ok: true,
    errors: [],
    noop: false,
    receipt: {
      tier: 'T3',
      competitiveAnchor,
      architecturalReviewPass,
      lensMax,
      lensSkipAnchor,
      terminalPass,
    },
  };
}

export function formatStageCompletenessPassMessage(result: StageCompletenessGuardResult): string {
  if (result.noop) return 'stage-completeness guard: PASS (receipt=noop non-T3)';
  if (!result.receipt) return 'stage-completeness guard: PASS (receipt=grandfathered)';
  const {
    competitiveAnchor,
    architecturalReviewPass,
    lensMax,
    lensSkipAnchor,
    terminalPass,
  } = result.receipt;
  const lensReceipt = lensMax !== null ? `lens-max=${lensMax}` : `lens-skip-anchor=${lensSkipAnchor}`;
  return [
    'stage-completeness guard: PASS',
    `(receipt=tier-fence tier=T3 competitive-anchor=${competitiveAnchor} architectural-review-pass=${architecturalReviewPass} ${lensReceipt} terminal-pass=${terminalPass})`,
  ].join(' ');
}
