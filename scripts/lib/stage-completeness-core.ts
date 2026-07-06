/**
 * T3 stage-completeness guard core (Issue #620).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseComplexityTierFence } from './tier-gate-core.js';
import { resolveReviewArtifacts } from './tier-gate-floor.js';

export const GRANDFATHERED_REVIEW_DIR_BASENAMES = new Set([
  '206-ao-010-session-status-readers-migration',
]);

export const COMPETITIVE_WAIVER_FILENAME = 'competitive-stage-waiver.json';

const COUNTED_STAGE_TOKENS = new Set([
  'competitive',
  'architectural-lens',
  'architectural-final',
]);

const CAPTURE_FILENAME_RE =
  /^pass-(\d+)-(competitive|architectural-lens|architectural-final|architectural)\.capture\.txt$/i;

const PASS_LIKE_CAPTURE_RE = /^pass-.+\.capture\.txt$/i;

const WAIVER_REASONS = new Set(['codex-substitution', 'operator-waiver']);

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
    lensMax: number;
    finalPass: number;
  } | null;
}

const ISO_8601_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isStrictIso8601Timestamp(value: string): boolean {
  if (!ISO_8601_TIMESTAMP_RE.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function parseAfterPassAnchor(value: unknown): number | null {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

export function parseCaptureFileName(fileName: string): ParsedCapture | null {
  const match = fileName.match(CAPTURE_FILENAME_RE);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const passIndex = Number.parseInt(match[1], 10);
  if (!Number.isInteger(passIndex) || passIndex < 0) {
    return null;
  }
  return {
    passIndex,
    stage: match[2].toLowerCase(),
    fileName,
  };
}

export function parseCompetitiveWaiver(
  reviewDir: string,
): { waiver: CompetitiveWaiver | null; invalid: boolean } {
  const waiverPath = join(reviewDir, COMPETITIVE_WAIVER_FILENAME);
  if (!existsSync(waiverPath)) {
    return { waiver: null, invalid: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(waiverPath, 'utf8'));
  } catch {
    return { waiver: null, invalid: true };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { waiver: null, invalid: true };
  }

  const record = parsed as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const recordedAt = typeof record['recorded-at'] === 'string' ? record['recorded-at'].trim() : '';
  if (!WAIVER_REASONS.has(reason) || !recordedAt || !isStrictIso8601Timestamp(recordedAt)) {
    return { waiver: null, invalid: true };
  }

  const afterPass = parseAfterPassAnchor(record['after-pass']);
  if (afterPass === null) {
    return { waiver: null, invalid: true };
  }

  return {
    waiver: { reason, recordedAt, afterPass },
    invalid: false,
  };
}

function loadReviewCaptures(reviewDir: string): {
  captures: ParsedCapture[];
  errors: string[];
} {
  const captures: ParsedCapture[] = [];
  const errors: string[] = [];

  if (!existsSync(reviewDir)) {
    return { captures, errors };
  }

  for (const fileName of readdirSync(reviewDir).sort()) {
    if (!fileName.endsWith('.capture.txt')) {
      continue;
    }

    const parsed = parseCaptureFileName(fileName);
    if (!parsed) {
      if (PASS_LIKE_CAPTURE_RE.test(fileName)) {
        errors.push(`unparseable capture filename: ${fileName}`);
      }
      continue;
    }

    if (!COUNTED_STAGE_TOKENS.has(parsed.stage)) {
      continue;
    }

    const body = readFileSync(join(reviewDir, fileName), 'utf8').trim();
    if (!body) {
      errors.push(`empty capture file: ${fileName}`);
      continue;
    }

    captures.push(parsed);
  }

  return { captures, errors };
}

function maxPassIndex(captures: ParsedCapture[], stage: string): number | null {
  const matches = captures.filter((capture) => capture.stage === stage);
  if (matches.length === 0) {
    return null;
  }
  return Math.max(...matches.map((capture) => capture.passIndex));
}

export function resolveRepoRootFromDraftPath(draftPath?: string): string {
  if (!draftPath) {
    return process.cwd();
  }
  const normalized = draftPath.replace(/\\/g, '/');
  const marker = '/docs/issues_drafts/';
  const idx = normalized.lastIndexOf(marker);
  if (idx >= 0) {
    return normalized.slice(0, idx);
  }
  return process.cwd();
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
  const reviewBasename = basename(capturesDir);

  if (GRANDFATHERED_REVIEW_DIR_BASENAMES.has(reviewBasename)) {
    return { ok: true, errors: [], noop: false, receipt: null };
  }

  const errors: string[] = [];
  const { captures, errors: structuralErrors } = loadReviewCaptures(capturesDir);
  errors.push(...structuralErrors);

  const competitiveMax = maxPassIndex(captures, 'competitive');
  const { waiver, invalid: invalidWaiver } = parseCompetitiveWaiver(capturesDir);

  const hasCompetitive = competitiveMax !== null;
  const hasValidWaiver = waiver !== null;

  if (!hasCompetitive && !hasValidWaiver) {
    if (invalidWaiver) {
      errors.push('invalid competitive-stage waiver record');
    }
    errors.push('missing competitive stage');
  }

  let competitiveAnchor: number | null = null;
  if (hasCompetitive) {
    competitiveAnchor = competitiveMax;
  } else if (hasValidWaiver) {
    competitiveAnchor = waiver!.afterPass;
  }

  const lensMax = maxPassIndex(captures, 'architectural-lens');
  if (lensMax === null) {
    errors.push('missing architect-lens stage');
  } else if (competitiveAnchor !== null && lensMax <= competitiveAnchor) {
    errors.push('architect-lens stage out of order (must be strictly after competitive anchor)');
  }

  const finalCaptures = captures.filter((capture) => capture.stage === 'architectural-final');
  const countedFinals =
    lensMax === null
      ? []
      : finalCaptures.filter((capture) => capture.passIndex > lensMax);

  if (countedFinals.length === 0) {
    errors.push('missing final architectural stage');
  } else if (countedFinals.length > 1) {
    errors.push('final architectural stage ceiling exceeded (exactly one pass allowed after lens)');
  } else if (lensMax !== null && countedFinals[0]!.passIndex <= lensMax) {
    errors.push('final architectural stage out of order (must be strictly after architect-lens)');
  }

  if (errors.length > 0) {
    return { ok: false, errors, noop: false, receipt: null };
  }

  return {
    ok: true,
    errors: [],
    noop: false,
    receipt: {
      tier: 'T3',
      competitiveAnchor: competitiveAnchor!,
      lensMax: lensMax!,
      finalPass: countedFinals[0]!.passIndex,
    },
  };
}

export function formatStageCompletenessPassMessage(result: StageCompletenessGuardResult): string {
  if (result.noop) {
    return 'stage-completeness guard: PASS (receipt=noop non-T3)';
  }
  if (!result.receipt) {
    return 'stage-completeness guard: PASS (receipt=grandfathered)';
  }
  const { competitiveAnchor, lensMax, finalPass } = result.receipt;
  return [
    'stage-completeness guard: PASS',
    `(receipt=tier-fence tier=T3 competitive-anchor=${competitiveAnchor} lens-max=${lensMax} final-pass=${finalPass})`,
  ].join(' ');
}
