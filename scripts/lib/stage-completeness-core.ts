/**
 * T3 stage-completeness guard core (Issue #620).
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
  'architectural',
  'architectural-lens',
  'architectural-final',
]);

const CAPTURE_FILENAME_RE =
  /^pass-(\d+)-(competitive|architectural-lens|architectural-final|architectural)\.capture\.txt$/i;

const COUNTED_STAGE_FILENAME_TOKEN_RE =
  /competitive|architectural-lens|architectural-final/i;

const PARSEABLE_WAIVER_REASONS = new Set(['codex-substitution', 'operator-waiver']);
const CREDITED_COMPETITIVE_WAIVER_REASONS = new Set(['operator-waiver']);
const PARSEABLE_LENS_WAIVER_REASONS = new Set(['claude-unavailable']);
const CREDITED_LENS_WAIVER_REASONS = new Set(['claude-unavailable']);
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
    lensMax: number | null;
    lensSkipAnchor: number | null;
    terminalPass: number;
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

export function referencesCountedStageFilenameToken(fileName: string): boolean {
  return COUNTED_STAGE_FILENAME_TOKEN_RE.test(fileName);
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
  if (!PARSEABLE_WAIVER_REASONS.has(reason) || !recordedAt || !isStrictIso8601Timestamp(recordedAt)) {
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

export function parseArchitectLensWaiver(
  reviewDir: string,
): { waiver: ArchitectLensWaiver | null; invalid: boolean } {
  const waiverPath = join(reviewDir, ARCHITECT_LENS_WAIVER_FILENAME);
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
  const unavailability =
    typeof record.unavailability === 'string' ? record.unavailability.trim() : '';
  if (
    !PARSEABLE_LENS_WAIVER_REASONS.has(reason) ||
    !recordedAt ||
    !isStrictIso8601Timestamp(recordedAt) ||
    !CREDITED_LENS_UNAVAILABILITY_KINDS.has(unavailability)
  ) {
    return { waiver: null, invalid: true };
  }

  const afterPass = parseAfterPassAnchor(record['after-pass']);
  if (afterPass === null) {
    return { waiver: null, invalid: true };
  }

  return {
    waiver: { reason, recordedAt, afterPass, unavailability },
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
      if (referencesCountedStageFilenameToken(fileName)) {
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

function creditedCompetitiveWaiver(waiver: CompetitiveWaiver | null): CompetitiveWaiver | null {
  if (waiver === null || !CREDITED_COMPETITIVE_WAIVER_REASONS.has(waiver.reason)) {
    return null;
  }
  return waiver;
}

function creditedArchitectLensWaiver(waiver: ArchitectLensWaiver | null): ArchitectLensWaiver | null {
  if (waiver === null || !CREDITED_LENS_WAIVER_REASONS.has(waiver.reason)) {
    return null;
  }
  return waiver;
}

function resolveTerminalArchitecturalPass(
  captures: ParsedCapture[],
  preTerminalAnchor: number | null,
  anchorLabel: 'architect-lens' | 'claude-unavailable-skip',
): { terminalPass: number | null; orderingErrors: string[] } {
  const orderingErrors: string[] = [];
  if (preTerminalAnchor === null) {
    return { terminalPass: null, orderingErrors };
  }

  const architecturalCaptures = captures.filter((capture) => capture.stage === 'architectural');
  const afterAnchor = architecturalCaptures.filter(
    (capture) => capture.passIndex > preTerminalAnchor,
  );
  const beforeAnchor = architecturalCaptures.filter(
    (capture) => capture.passIndex < preTerminalAnchor,
  );

  if (afterAnchor.length === 0) {
    if (beforeAnchor.length > 0) {
      orderingErrors.push(
        anchorLabel === 'architect-lens'
          ? 'architectural stage out of order (terminal GPT capture must be strictly after architect-lens)'
          : 'architectural stage out of order (terminal GPT capture must be strictly after claude-unavailable skip anchor)',
      );
    }
    orderingErrors.push('missing terminal architectural stage');
    return { terminalPass: null, orderingErrors };
  }

  if (afterAnchor.length > 1) {
    orderingErrors.push(
      anchorLabel === 'architect-lens'
        ? 'terminal architectural stage ceiling exceeded (exactly one pass allowed after lens)'
        : 'terminal architectural stage ceiling exceeded (exactly one pass allowed after claude-unavailable skip anchor)',
    );
    return { terminalPass: null, orderingErrors };
  }

  return { terminalPass: afterAnchor[0]!.passIndex, orderingErrors };
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
  const { waiver: lensWaiver, invalid: invalidLensWaiver } = parseArchitectLensWaiver(capturesDir);

  const hasCompetitive = competitiveMax !== null;
  const creditedWaiver = creditedCompetitiveWaiver(waiver);
  const hasCreditedWaiver = creditedWaiver !== null;

  if (!hasCompetitive && !hasCreditedWaiver) {
    if (invalidWaiver) {
      errors.push('invalid competitive-stage waiver record');
    }
    errors.push('missing competitive stage');
  }

  let competitiveAnchor: number | null = null;
  if (hasCompetitive) {
    competitiveAnchor = competitiveMax;
  } else if (hasCreditedWaiver) {
    competitiveAnchor = creditedWaiver!.afterPass;
  }

  const lensMax = maxPassIndex(captures, 'architectural-lens');
  const creditedLensSkip = creditedArchitectLensWaiver(lensWaiver);
  const hasCreditedLensSkip = creditedLensSkip !== null;

  if (lensMax !== null && hasCreditedLensSkip) {
    errors.push(
      'architect-lens skip record cannot coexist with an architectural-lens capture (skip is not Claude provenance)',
    );
  }

  let preTerminalAnchor: number | null = null;
  let lensSkipAnchor: number | null = null;
  if (lensMax !== null) {
    preTerminalAnchor = lensMax;
    if (competitiveAnchor !== null && lensMax <= competitiveAnchor) {
      errors.push('architect-lens stage out of order (must be strictly after competitive anchor)');
    }
  } else if (hasCreditedLensSkip) {
    lensSkipAnchor = creditedLensSkip!.afterPass;
    preTerminalAnchor = lensSkipAnchor;
    if (competitiveAnchor !== null && lensSkipAnchor <= competitiveAnchor) {
      errors.push(
        'claude-unavailable skip anchor out of order (must be strictly after competitive anchor)',
      );
    }
  } else {
    if (invalidLensWaiver) {
      errors.push('invalid architect-lens skip record');
    }
    errors.push('missing architect-lens stage (no capture and no valid claude-unavailable skip)');
  }

  const { terminalPass, orderingErrors: terminalOrderingErrors } = resolveTerminalArchitecturalPass(
    captures,
    preTerminalAnchor,
    lensMax !== null ? 'architect-lens' : 'claude-unavailable-skip',
  );
  errors.push(...terminalOrderingErrors);

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
      lensMax,
      lensSkipAnchor,
      terminalPass: terminalPass!,
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
  const { competitiveAnchor, lensMax, lensSkipAnchor, terminalPass } = result.receipt;
  const lensReceipt =
    lensMax !== null ? `lens-max=${lensMax}` : `lens-skip-anchor=${lensSkipAnchor}`;
  return [
    'stage-completeness guard: PASS',
    `(receipt=tier-fence tier=T3 competitive-anchor=${competitiveAnchor} ${lensReceipt} terminal-pass=${terminalPass})`,
  ].join(' ');
}
