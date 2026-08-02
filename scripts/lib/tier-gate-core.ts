/**
 * Tier gate core: fence parsing, stage selection, and Issue-bound tier provenance.
 *
 * Issue #1142 retires writable post-review demotion. Fresh tasks may make one
 * adjacent correction before the first canonical reviewer capture. A frozen
 * read-old/write-none census is the only legacy demotion compatibility surface.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { checkNeverSkippedFloors } from './tier-gate-floor.ts';
import { canonicalReviewStateRoot, resolveReviewDirectories } from './canonical-review-directory.ts';

export { checkWorkerSafetyFloor } from './tier-gate-floor.ts';

export const VALID_TIERS = new Set(['T1', 'T2', 'T3']);
export const FLOOR_CHECKS = [
  'worker-safety',
  'contract-evidence',
  'behavior-kind',
  'finding-ledger-carve-out',
] as const;

/**
 * Frozen Issue #1142 compatibility census. It is intentionally empty: no fully
 * completed old transition was in flight at cutover. Runtime code must never
 * discover, infer, append, or otherwise extend this list.
 */
export const PRE_1142_COMPLETED_DEMOTION_IDENTITIES = Object.freeze([] as string[]);

export type Tier = 'T1' | 'T2' | 'T3';
export type L4Status = 'not-applicable' | 'clear' | 'active' | 'ambiguous' | 'missing' | 'stale';
export type TierProvenanceProducer = string;

export const TIER_RUBRIC_CLASSES = new Set([
  'failure-type:text-cosmetics',
  'failure-type:local-behavior',
  'failure-type:subsystem-or-system-guarantee',
  'size:small-obvious-self-contained',
  'size:single-component-design-judgment',
  'fail-up:doubt',
]);

const FENCE_RE = /```complexity-tier\s*\n([\s\S]*?)```/i;
const REVISION_RE = /^r(\d+)$/i;
const LEGACY_EVENT_RE = /```tier-demotion-event\s*\n([\s\S]*?)```/gi;
const LEGACY_REVALIDATION_RE = /```tier-demotion-revalidation\s*\n([\s\S]*?)```/gi;

function asProducer(value: unknown): TierProvenanceProducer | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asTier(value: unknown): Tier | null {
  const normalized = typeof value === 'string' ? value.toUpperCase() : '';
  return VALID_TIERS.has(normalized) ? normalized as Tier : null;
}

function tierRank(tier: Tier): number {
  return tier === 'T1' ? 1 : tier === 'T2' ? 2 : 3;
}

function revisionNumber(revision: string): number {
  const match = revision.match(REVISION_RE);
  return match?.[1] ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    return null;
  }
  const entries = value.map(String);
  return new Set(entries).size === entries.length ? entries : null;
}

export type ComplexityTierFence =
  | {
      kind: 'tier-fence';
      tier: string;
      advisoryPrior?: string;
      riskNote?: string;
      /** Read-only legacy syntax. Fresh progression rejects these fields. */
      demotionFrom?: string;
      demotionEvent?: string;
      skipLine: false;
    }
  | { kind: 'no-tier'; skipLine: true }
  | { kind: 'unparseable'; reason: string };

export interface TierDecisionReceiptRecord {
  schema: 'tier-gate-decision/v1';
  producer: TierProvenanceProducer;
  revision: string;
  tier: Tier;
  /** Legacy audit field; no longer produced or enforced (#1029). */
  markerRows?: string[];
  rubricClasses: string[];
  l4Status: L4Status;
  correctedFrom?: Tier;
  reason?: string;
  /** Parser-only marker for legacy below-T3 `clear` normalization. */
  legacyL4Status?: 'clear';
}

export interface TierIntakeRecord {
  schema: 'tier-intake/v1';
  producer: TierProvenanceProducer;
  taskIdentity: string;
  kind: 'fresh' | 'compatibility';
  priorTier: Tier;
  firstRevision: string;
}

export interface LegacyDemotionEventRecord {
  schema: 'tier-demotion-event/v1';
  eventId: string;
  kind: 'compatibility';
  sourceRevision: string;
  beforeTier: Tier;
  afterTier: Tier;
}

export interface LegacyDemotionRevalidationRecord {
  schema: 'tier-demotion-revalidation/v1';
  eventId: string;
  candidateRevision: string;
  beforeTier: Tier;
  afterTier: Tier;
}

export interface RetiredDemotionFenceEvidence {
  eventMatches: number;
  invalidEventMatches: number;
  revalidationMatches: number;
  invalidRevalidationMatches: number;
}

export interface RetiredDemotionCaptureInspection {
  events: LegacyDemotionEventRecord[];
  revalidations: LegacyDemotionRevalidationRecord[];
  fences: RetiredDemotionFenceEvidence;
}

export interface TierTransitionEvidence {
  taskIdentity: string;
  currentRevision: string;
  intake: TierIntakeRecord | null;
  revisions: Array<{
    revision: string;
    text: string;
    tier: Tier | null;
    receipt: TierDecisionReceiptRecord | null;
  }>;
  events: Array<{ record: LegacyDemotionEventRecord; captureName: string; captureText: string }>;
  revalidations: Array<{
    record: LegacyDemotionRevalidationRecord;
    captureName: string;
    captureText: string;
  }>;
  captures?: Array<{ captureName: string; captureText: string }>;
  /** Presence and validity of every retired-protocol fence match, including parser failures. */
  retiredDemotionFences?: RetiredDemotionFenceEvidence;
  /** Filesystem-loaded evidence only: whether the path uses the Issue-number authority. */
  canonicalIssueWorkdir?: boolean;
}

export function parseComplexityTierFence(draftText: string): ComplexityTierFence {
  const match = draftText.match(FENCE_RE);
  if (!match) return { kind: 'unparseable', reason: 'missing complexity-tier fence' };

  const fields = new Map<string, string>();
  for (const rawLine of (match[1] ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) {
      return { kind: 'unparseable', reason: `invalid complexity-tier line: ${line}` };
    }
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  const skipLineRaw = fields.get('skip-line');
  if (skipLineRaw && /^(true|yes|1)$/i.test(skipLineRaw)) {
    return { kind: 'no-tier', skipLine: true };
  }

  const tier = fields.get('tier')?.toUpperCase();
  if (!tier || !VALID_TIERS.has(tier)) {
    return { kind: 'unparseable', reason: `invalid or missing tier: ${tier ?? '<empty>'}` };
  }

  const advisoryPrior = fields.get('advisory-prior')?.toUpperCase();
  if (advisoryPrior && !VALID_TIERS.has(advisoryPrior)) {
    return { kind: 'unparseable', reason: `invalid advisory-prior tier: ${advisoryPrior}` };
  }
  const riskNote = fields.get('risk-note');
  if (fields.has('risk-note') && !riskNote) {
    return { kind: 'unparseable', reason: 'risk-note must be non-empty when present' };
  }

  const demotionFrom = fields.get('demotion-from')?.toUpperCase();
  const demotionEvent = fields.get('demotion-event');
  if (demotionFrom && !VALID_TIERS.has(demotionFrom)) {
    return { kind: 'unparseable', reason: `invalid demotion-from tier: ${demotionFrom}` };
  }
  if (Boolean(demotionFrom) !== Boolean(demotionEvent)) {
    return { kind: 'unparseable', reason: 'demotion-from and demotion-event must be present together' };
  }

  return {
    kind: 'tier-fence',
    tier,
    advisoryPrior,
    riskNote,
    demotionFrom,
    demotionEvent: demotionEvent || undefined,
    skipLine: false,
  };
}

export function parseIntakeRecord(value: unknown): TierIntakeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const producer = asProducer(record.producer);
  const priorTier = asTier(record.priorTier);
  if (
    record.schema !== 'tier-intake/v1'
    || !producer
    || typeof record.taskIdentity !== 'string'
    || record.taskIdentity.trim() === ''
    || (record.kind !== 'fresh' && record.kind !== 'compatibility')
    || !priorTier
    || typeof record.firstRevision !== 'string'
    || !REVISION_RE.test(record.firstRevision)
  ) return null;
  return {
    schema: 'tier-intake/v1',
    producer,
    taskIdentity: record.taskIdentity,
    kind: record.kind,
    priorTier,
    firstRevision: record.firstRevision,
  };
}

export function parseDecisionReceipt(value: unknown): TierDecisionReceiptRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const producer = asProducer(record.producer);
  const tier = asTier(record.tier);
  const rubricClasses = parseStringArray(record.rubricClasses);
  const markerRows = record.markerRows === undefined ? undefined : parseStringArray(record.markerRows) ?? undefined;
  if (
    record.schema !== 'tier-gate-decision/v1'
    || !producer
    || typeof record.revision !== 'string'
    || !REVISION_RE.test(record.revision)
    || !tier
    || !rubricClasses
    || rubricClasses.length === 0
    || rubricClasses.some((entry) => !TIER_RUBRIC_CLASSES.has(entry))
  ) return null;

  const rawL4 = String(record.l4Status ?? '');
  let l4Status: L4Status;
  let legacyL4Status: 'clear' | undefined;
  if (tier === 'T3') {
    if (!['clear', 'active', 'ambiguous', 'missing', 'stale'].includes(rawL4)) return null;
    l4Status = rawL4 as L4Status;
  } else if (rawL4 === 'not-applicable') {
    l4Status = 'not-applicable';
  } else if (rawL4 === 'clear') {
    // Upgrade-only read compatibility. New below-T3 writers emit not-applicable.
    l4Status = 'not-applicable';
    legacyL4Status = 'clear';
  } else {
    return null;
  }

  const correctedFrom = record.correctedFrom === undefined ? undefined : asTier(record.correctedFrom) ?? undefined;
  if (record.correctedFrom !== undefined && !correctedFrom) return null;
  const reason = record.reason === undefined ? undefined : typeof record.reason === 'string' ? record.reason : undefined;
  if (record.reason !== undefined && reason === undefined) return null;

  return {
    schema: 'tier-gate-decision/v1',
    producer,
    revision: record.revision,
    tier,
    markerRows,
    rubricClasses,
    l4Status,
    correctedFrom,
    reason,
    legacyL4Status,
  };
}

function parseLegacyEvent(value: unknown): LegacyDemotionEventRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const beforeTier = asTier(record.beforeTier);
  const afterTier = asTier(record.afterTier);
  if (
    record.schema !== 'tier-demotion-event/v1'
    || record.kind !== 'compatibility'
    || typeof record.eventId !== 'string'
    || record.eventId.trim() === ''
    || typeof record.sourceRevision !== 'string'
    || !REVISION_RE.test(record.sourceRevision)
    || !beforeTier
    || !afterTier
    || tierRank(beforeTier) - tierRank(afterTier) !== 1
  ) return null;
  return {
    schema: 'tier-demotion-event/v1',
    eventId: record.eventId,
    kind: 'compatibility',
    sourceRevision: record.sourceRevision,
    beforeTier,
    afterTier,
  };
}

function parseLegacyRevalidation(value: unknown): LegacyDemotionRevalidationRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const beforeTier = asTier(record.beforeTier);
  const afterTier = asTier(record.afterTier);
  if (
    record.schema !== 'tier-demotion-revalidation/v1'
    || typeof record.eventId !== 'string'
    || record.eventId.trim() === ''
    || typeof record.candidateRevision !== 'string'
    || !REVISION_RE.test(record.candidateRevision)
    || !beforeTier
    || !afterTier
    || tierRank(beforeTier) - tierRank(afterTier) !== 1
  ) return null;
  return {
    schema: 'tier-demotion-revalidation/v1',
    eventId: record.eventId,
    candidateRevision: record.candidateRevision,
    beforeTier,
    afterTier,
  };
}

interface ParsedFencedRecords<T> {
  records: T[];
  totalMatches: number;
  invalidMatches: number;
}

function parseFencedRecords<T>(
  text: string,
  regex: RegExp,
  parser: (value: unknown) => T | null,
): ParsedFencedRecords<T> {
  regex.lastIndex = 0;
  const records: T[] = [];
  let totalMatches = 0;
  let invalidMatches = 0;
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    totalMatches += 1;
    try {
      const record = parser(JSON.parse(match[1] ?? ''));
      if (record) records.push(record);
      else invalidMatches += 1;
    } catch {
      invalidMatches += 1;
    }
  }
  return { records, totalMatches, invalidMatches };
}

export function inspectRetiredDemotionCapture(text: string): RetiredDemotionCaptureInspection {
  const events = parseFencedRecords(text, LEGACY_EVENT_RE, parseLegacyEvent);
  const revalidations = parseFencedRecords(text, LEGACY_REVALIDATION_RE, parseLegacyRevalidation);
  return {
    events: events.records,
    revalidations: revalidations.records,
    fences: {
      eventMatches: events.totalMatches,
      invalidEventMatches: events.invalidMatches,
      revalidationMatches: revalidations.totalMatches,
      invalidRevalidationMatches: revalidations.invalidMatches,
    },
  };
}

export interface StageSelectionInput {
  tier: string | null;
  skipLine: boolean;
  explicitAdversarialWrapper?: boolean;
}

export interface StageSelectionResult {
  effectiveTier: string | null;
  floor: string[];
  authoring: string[];
  review: string[];
  wrapperFloorApplied: boolean;
}

export function selectAuthoringReviewStages(input: StageSelectionInput): StageSelectionResult {
  const floor = [...FLOOR_CHECKS];
  const authoring: string[] = [];
  const review: string[] = [];
  if (input.skipLine) return { effectiveTier: null, floor, authoring, review, wrapperFloorApplied: false };

  let effectiveTier = input.tier;
  let wrapperFloorApplied = false;
  if (input.explicitAdversarialWrapper && effectiveTier === 'T1') {
    effectiveTier = 'T2';
    wrapperFloorApplied = true;
  }

  if (effectiveTier === 'T1') {
    review.push('architectural');
  } else if (effectiveTier === 'T2') {
    authoring.push('light-design-analysis');
    review.push('architectural');
  } else if (effectiveTier === 'T3') {
    authoring.push('full-design-analysis');
    review.push('competitive-adversarial', 'architectural', 'architect-lens', 'final-architectural');
  }
  return { effectiveTier, floor, authoring, review, wrapperFloorApplied };
}

export interface TierGateGuardOptions {
  tier?: string | null;
  skipLine?: boolean;
  designSkipped?: boolean;
  adversarialSkipped?: boolean;
  explicitAdversarialWrapper?: boolean;
  repoRoot?: string;
  draftPath?: string;
  transitionEvidence?: TierTransitionEvidence;
  completedLegacyDemotionIdentities?: readonly string[];
}

export type TierGateReceipt =
  | { kind: 'no-tier'; skipLine: true }
  | {
      kind: 'tier-fence';
      tier: string;
      advisoryPrior?: string;
      riskNote?: string;
      effectiveTier: string | null;
      wrapperFloorApplied: boolean;
      explicitAdversarialWrapper: boolean;
    };

export interface TierGateGuardResult {
  ok: boolean;
  errors: string[];
  receipt: TierGateReceipt | null;
  fence: ComplexityTierFence;
  stages: StageSelectionResult;
}

interface WorkdirLayout {
  workdir: string;
  stem: string;
  taskIdentity: string;
  reviewDirs: string[];
  canonicalIssueWorkdir: boolean;
}

function issueNumberFromStem(stem: string): string | null {
  return stem.match(/^(\d+)(?:-|$)/)?.[1] ?? null;
}

function canonicalIssueStateRoot(): string {
  return canonicalReviewStateRoot();
}

function deriveWorkdir(draftPath: string): WorkdirLayout | null {
  const normalized = resolve(draftPath);
  const stem = basename(normalized, '.md');
  const taskNumber = issueNumberFromStem(stem);
  const issueDraftsDir = dirname(normalized);
  if (!taskNumber || basename(issueDraftsDir) !== 'issues_drafts' || basename(dirname(issueDraftsDir)) !== 'docs') return null;
  const workdir = dirname(dirname(issueDraftsDir));
  const canonicalIssueWorkdir = dirname(workdir) === canonicalIssueStateRoot() && basename(workdir) === taskNumber;
  const taskIdentity = canonicalIssueWorkdir ? taskNumber : stem;
  return {
    workdir,
    stem,
    taskIdentity,
    reviewDirs: resolveReviewDirectories(
      { taskIdentity },
      'history',
      [join(issueDraftsDir, '.review', taskIdentity)],
    ),
    canonicalIssueWorkdir,
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function loadTransitionEvidenceFromWorkdir(
  draftPath: string,
  repoRoot = process.cwd(),
): { evidence: TierTransitionEvidence | null; errors: string[] } {
  const normalizedDraft = resolve(draftPath);
  const normalizedRepo = resolve(repoRoot);
  const repoRelative = relative(normalizedRepo, normalizedDraft);
  if (repoRelative === '' || (!repoRelative.startsWith('..') && !isAbsolute(repoRelative))) {
    return { evidence: null, errors: [] };
  }
  const layout = deriveWorkdir(draftPath);
  if (!layout) return { evidence: null, errors: [] };

  const errors: string[] = [];
  const intakePath = join(layout.reviewDirs[0]!, 'tier-intake.json');
  let intake: TierIntakeRecord | null = null;
  if (existsSync(intakePath)) {
    try {
      intake = parseIntakeRecord(readJson(intakePath));
      if (!intake) errors.push('tier provenance: malformed flow-manager intake evidence');
    } catch {
      errors.push('tier provenance: malformed flow-manager intake evidence');
    }
  } else {
    errors.push('tier provenance: missing flow-manager intake evidence');
  }

  const revisionDirs = existsSync(layout.workdir)
    ? readdirSync(layout.workdir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && REVISION_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => revisionNumber(left) - revisionNumber(right))
    : [];
  const revisions: TierTransitionEvidence['revisions'] = [];
  for (const revision of revisionDirs) {
    const revisionDir = join(layout.workdir, revision);
    const candidates = readdirSync(revisionDir, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) return false;
        const candidateStem = basename(entry.name, '.md');
        return layout.canonicalIssueWorkdir
          ? issueNumberFromStem(candidateStem) === layout.taskIdentity
          : candidateStem === layout.stem;
      })
      .map((entry) => entry.name)
      .sort();
    if (candidates.length > 1) {
      errors.push(`tier provenance: ambiguous immutable Issue revision files for ${revision}`);
      continue;
    }
    const candidate = candidates[0];
    if (!candidate) continue;
    const draftFile = join(revisionDir, candidate);
    const text = readFileSync(draftFile, 'utf8');
    const fence = parseComplexityTierFence(text);
    const tier = fence.kind === 'tier-fence' ? asTier(fence.tier) : null;
    const receiptPath = join(layout.workdir, revision, 'tier-gate-receipt.json');
    let receipt: TierDecisionReceiptRecord | null = null;
    if (existsSync(receiptPath)) {
      try { receipt = parseDecisionReceipt(readJson(receiptPath)); } catch { receipt = null; }
    }
    revisions.push({ revision, text, tier, receipt });
  }

  const currentText = readFileSync(draftPath, 'utf8');
  const currentRevision = revisions.filter((revision) => revision.text === currentText).at(-1)?.revision ?? '';
  if (!currentRevision) errors.push('tier provenance: current anchor does not match an immutable rNN revision');

  const events: TierTransitionEvidence['events'] = [];
  const revalidations: TierTransitionEvidence['revalidations'] = [];
  const captures: NonNullable<TierTransitionEvidence['captures']> = [];
  const retiredDemotionFences: RetiredDemotionFenceEvidence = {
    eventMatches: 0,
    invalidEventMatches: 0,
    revalidationMatches: 0,
    invalidRevalidationMatches: 0,
  };
  for (const reviewDir of layout.reviewDirs) {
    if (!existsSync(reviewDir)) continue;
    for (const captureName of readdirSync(reviewDir).filter((name) => name.endsWith('.capture.txt')).sort()) {
      const captureText = readFileSync(join(reviewDir, captureName), 'utf8');
      captures.push({ captureName, captureText });
      const inspection = inspectRetiredDemotionCapture(captureText);
      retiredDemotionFences.eventMatches += inspection.fences.eventMatches;
      retiredDemotionFences.invalidEventMatches += inspection.fences.invalidEventMatches;
      retiredDemotionFences.revalidationMatches += inspection.fences.revalidationMatches;
      retiredDemotionFences.invalidRevalidationMatches += inspection.fences.invalidRevalidationMatches;
      events.push(...inspection.events.map((record) => ({ record, captureName, captureText })));
      revalidations.push(...inspection.revalidations.map((record) => ({ record, captureName, captureText })));
    }
  }

  return {
    evidence: {
      taskIdentity: layout.taskIdentity,
      currentRevision,
      intake,
      revisions,
      events,
      revalidations,
      captures,
      retiredDemotionFences,
      canonicalIssueWorkdir: layout.canonicalIssueWorkdir,
    },
    errors,
  };
}

function validateReceipt(
  revision: TierTransitionEvidence['revisions'][number],
  intake: TierIntakeRecord,
  errors: string[],
): TierDecisionReceiptRecord | null {
  const receipt = revision.receipt;
  if (!receipt) {
    errors.push(`tier provenance: missing or malformed tier-gate receipt for ${revision.revision}`);
    return null;
  }
  if (receipt.revision !== revision.revision || receipt.tier !== revision.tier) {
    errors.push(`tier provenance: tier-gate receipt binding mismatch for ${revision.revision}`);
  }
  if (receipt.producer !== intake.producer) {
    errors.push(`tier provenance: receipt producer mismatch for ${revision.revision}`);
  }
  if (Boolean(receipt.correctedFrom) !== Boolean(receipt.reason !== undefined)) {
    errors.push(`tier correction: correctedFrom and reason must be present together (${revision.revision})`);
  }
  return receipt;
}

function parseBehaviorKind(text: string): 'record-only' | 'action-producing' | null {
  const match = text.match(/```behavior-kind\s*\n\s*(record-only|action-producing)\s*\n```/i);
  return match?.[1]?.toLowerCase() as 'record-only' | 'action-producing' | undefined ?? null;
}

type CanonicalCaptureKind = 'competitive' | 'architectural-review' | 'architectural-lens' | 'architectural';

function canonicalCaptureKind(name: string): CanonicalCaptureKind | null {
  if (/^pass-\d+-competitive(?:-\d+)?\.capture\.txt$/i.test(name)) return 'competitive';
  if (/^pass-\d+-architectural-review(?:-\d{2})?\.capture\.txt$/i.test(name)) return 'architectural-review';
  if (/^pass-\d+-architectural-lens\.capture\.txt$/i.test(name)) return 'architectural-lens';
  if (/^pass-\d+-(?:light-)?architectural\.capture\.txt$/i.test(name)) return 'architectural';
  return null;
}

function selectedCaptureKinds(tier: Tier): ReadonlySet<CanonicalCaptureKind> {
  const selected = new Set<CanonicalCaptureKind>();
  for (const stage of selectAuthoringReviewStages({ tier, skipLine: false }).review) {
    if (stage === 'competitive-adversarial') selected.add('competitive');
    else if (stage === 'architect-lens') selected.add('architectural-lens');
    else if (stage === 'final-architectural') selected.add('architectural');
    else if (stage === 'architectural') selected.add(tier === 'T3' ? 'architectural-review' : 'architectural');
  }
  return selected;
}

export function formatCaptureRevisionHeader(revision: string): string {
  const normalized = revision.toLowerCase();
  if (!REVISION_RE.test(normalized)) {
    throw new Error(`invalid immutable Issue revision: ${revision || '<empty>'}`);
  }
  return `issue_revision: ${normalized}\n`;
}

function captureRevision(text: string): string | null {
  const candidates = [
    ...text.matchAll(/\bissue[_-]revision\s*:\s*(r\d+)\b/gi),
    ...text.matchAll(/\bsourceRevision\s*["']?\s*:\s*["']?(r\d+)\b/gi),
  ].map((match) => match[1]?.toLowerCase()).filter((value): value is string => Boolean(value));
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

function correctionWindowClosedBefore(
  evidence: TierTransitionEvidence,
  targetRevisionIndex: number,
  errors: string[],
): boolean {
  const selected = new Set<CanonicalCaptureKind>();
  for (let index = 0; index <= targetRevisionIndex; index += 1) {
    const tier = evidence.revisions[index]?.tier;
    if (!tier) continue;
    for (const kind of selectedCaptureKinds(tier)) selected.add(kind);
  }

  let firstCaptureIndex = Number.MAX_SAFE_INTEGER;
  for (const capture of evidence.captures ?? []) {
    const kind = canonicalCaptureKind(capture.captureName);
    if (!kind || !selected.has(kind)) continue;
    const revision = captureRevision(capture.captureText);
    if (!revision) {
      errors.push(`tier correction: canonical capture lacks one immutable issue_revision binding (${capture.captureName})`);
      return true;
    }
    const revisionIndex = evidence.revisions.findIndex((entry) => entry.revision.toLowerCase() === revision);
    if (revisionIndex < 0) {
      errors.push(`tier correction: canonical capture binds revision outside this Issue history (${capture.captureName})`);
      return true;
    }
    firstCaptureIndex = Math.min(firstCaptureIndex, revisionIndex);
  }
  return firstCaptureIndex < targetRevisionIndex;
}

function resolvedRetiredDemotionFences(evidence: TierTransitionEvidence): RetiredDemotionFenceEvidence {
  return evidence.retiredDemotionFences ?? {
    eventMatches: evidence.events.length,
    invalidEventMatches: 0,
    revalidationMatches: evidence.revalidations.length,
    invalidRevalidationMatches: 0,
  };
}

function validateLegacyCompatibility(
  evidence: TierTransitionEvidence,
  currentIndex: number,
  errors: string[],
): void {
  const retired = resolvedRetiredDemotionFences(evidence);
  if (
    retired.eventMatches !== 1
    || retired.revalidationMatches !== 1
    || retired.invalidEventMatches !== 0
    || retired.invalidRevalidationMatches !== 0
    || evidence.events.length !== 1
    || evidence.revalidations.length !== 1
  ) {
    errors.push('tier compatibility: frozen identity requires exactly one completed event and revalidation with no extra or malformed retired fences');
    return;
  }
  const event = evidence.events[0]?.record;
  const revalidation = evidence.revalidations[0]?.record;
  if (!event || !revalidation || event.eventId !== revalidation.eventId) {
    errors.push('tier compatibility: event and revalidation binding mismatch');
    return;
  }
  const sourceIndex = evidence.revisions.findIndex((revision) => revision.revision === event.sourceRevision);
  const candidateIndex = evidence.revisions.findIndex((revision) => revision.revision === revalidation.candidateRevision);
  if (
    sourceIndex < 0
    || candidateIndex !== sourceIndex + 1
    || candidateIndex !== currentIndex
    || currentIndex !== evidence.revisions.length - 1
    || event.beforeTier !== revalidation.beforeTier
    || event.afterTier !== revalidation.afterTier
    || evidence.revisions[sourceIndex]?.tier !== event.beforeTier
    || evidence.revisions[candidateIndex]?.tier !== event.afterTier
  ) {
    errors.push('tier compatibility: legacy chain does not bind the existing current lower-tier candidate');
  }
  if (evidence.revisions.some((revision) => revision.receipt?.correctedFrom || revision.receipt?.reason !== undefined)) {
    errors.push('tier compatibility: legacy reader is read-old/write-none and cannot consume new correction fields');
  }
}

function validateFreshProgression(
  evidence: TierTransitionEvidence,
  currentIndex: number,
  intake: TierIntakeRecord,
  errors: string[],
): void {
  const retired = resolvedRetiredDemotionFences(evidence);
  if (retired.eventMatches > 0 || retired.revalidationMatches > 0) {
    errors.push('tier correction: fresh progression cannot produce or consume retired demotion records');
  }
  for (const revision of evidence.revisions.slice(0, currentIndex + 1)) {
    if (revision.receipt?.legacyL4Status) {
      errors.push(`tier decision: fresh below-T3 receipt must emit l4Status not-applicable (${revision.revision})`);
    }
  }

  const hasCorrectionAttempt = evidence.revisions.slice(0, currentIndex + 1).some((revision, index, revisions) => {
    if (revision.receipt?.correctedFrom || revision.receipt?.reason !== undefined) return true;
    const previous = revisions[index - 1];
    return Boolean(previous?.tier && revision.tier && tierRank(revision.tier) < tierRank(previous.tier));
  });
  if (hasCorrectionAttempt && evidence.canonicalIssueWorkdir === false) {
    errors.push('tier correction: intake correction requires the canonical Issue-number workdir history');
  }

  let corrections = 0;
  let sawUpstep = false;
  for (let index = 1; index <= currentIndex; index += 1) {
    const previous = evidence.revisions[index - 1];
    const current = evidence.revisions[index];
    if (!previous?.tier || !current?.tier) continue;
    const receipt = current.receipt;
    const delta = tierRank(current.tier) - tierRank(previous.tier);
    if (delta > 0) {
      sawUpstep = true;
      if (receipt?.correctedFrom || receipt?.reason !== undefined) {
        errors.push(`tier correction: correction fields cannot authorize an upstep (${current.revision})`);
      }
      continue;
    }
    if (delta === 0) {
      if (receipt?.correctedFrom || receipt?.reason !== undefined) {
        errors.push(`tier correction: correction fields require an adjacent downstep (${current.revision})`);
      }
      continue;
    }

    corrections += 1;
    if (delta !== -1) errors.push('tier correction: only one adjacent tier edge is allowed');
    if (corrections > 1) errors.push('tier correction: only one intake downstep is allowed per Issue');
    if (sawUpstep) errors.push('tier correction: an intervening upstep permanently consumes intake correction authority');
    if (!receipt?.correctedFrom || receipt.correctedFrom !== previous.tier) {
      errors.push(`tier correction: receipt correctedFrom must bind ${previous.tier} (${current.revision})`);
    }
    if (!receipt?.reason || receipt.reason.trim() === '') {
      errors.push(`tier correction: non-empty reason is required (${current.revision})`);
    }
    if (correctionWindowClosedBefore(evidence, index, errors)) {
      errors.push('tier correction: first canonical reviewer capture already closed the Issue-bound window');
    }
  }

  const first = evidence.revisions[0];
  if (first?.receipt?.correctedFrom || first?.receipt?.reason !== undefined) {
    errors.push('tier correction: first authoritative receipt cannot contain correction fields');
  }
  if (first?.tier !== intake.priorTier) {
    errors.push('tier provenance: first authoritative candidate must equal the intake prior');
  }
}

function validateTierTransition(
  text: string,
  fence: ComplexityTierFence,
  options: TierGateGuardOptions,
  errors: string[],
): void {
  if (fence.kind !== 'tier-fence') return;
  const loaded = options.transitionEvidence
    ? { evidence: options.transitionEvidence, errors: [] }
    : options.draftPath
      ? loadTransitionEvidenceFromWorkdir(options.draftPath, options.repoRoot)
      : { evidence: null, errors: [] };
  errors.push(...loaded.errors);
  const evidence = loaded.evidence;
  if (!evidence) return;

  const intake = evidence.intake;
  if (!intake) {
    if (!loaded.errors.some((error) => error.includes('intake evidence'))) {
      errors.push('tier provenance: missing flow-manager intake evidence');
    }
    return;
  }
  if (intake.taskIdentity !== evidence.taskIdentity) errors.push('tier provenance: intake evidence task identity mismatch');
  if (fence.advisoryPrior !== intake.priorTier) errors.push('tier provenance: advisory-prior does not match flow-manager intake prior');

  const currentIndex = evidence.revisions.findIndex((revision) => revision.revision === evidence.currentRevision);
  if (currentIndex < 0) {
    errors.push('tier provenance: current revision binding is missing');
    return;
  }
  const current = evidence.revisions[currentIndex];
  const currentTier = asTier(fence.tier);
  if (!current || !currentTier || current.tier !== currentTier) {
    errors.push('tier provenance: current immutable revision tier does not match candidate');
    return;
  }
  if (current.text !== text) errors.push('tier provenance: guarded text does not match current immutable revision');

  const firstValidIndex = evidence.revisions.findIndex((revision) => revision.tier !== null);
  if (firstValidIndex < 0 || evidence.revisions[firstValidIndex]?.revision !== intake.firstRevision) {
    errors.push('tier provenance: intake firstRevision must bind the first valid immutable revision');
  }
  for (let index = 0; index <= currentIndex; index += 1) {
    const revision = evidence.revisions[index];
    if (revision?.tier) validateReceipt(revision, intake, errors);
  }

  if (parseBehaviorKind(text) === 'record-only' && currentTier === 'T3') {
    errors.push('tier classification: record-only work cannot be T3');
  }

  const frozen = new Set(options.completedLegacyDemotionIdentities ?? PRE_1142_COMPLETED_DEMOTION_IDENTITIES);
  const isLegacy = frozen.has(evidence.taskIdentity);
  if (intake.kind === 'compatibility' !== isLegacy) {
    errors.push('tier compatibility: compatibility intake must match the frozen completed-transition census');
  }

  if (isLegacy) {
    validateLegacyCompatibility(evidence, currentIndex, errors);
    return;
  }
  if (fence.demotionFrom || fence.demotionEvent) {
    errors.push('tier correction: fresh tasks cannot use retired demotion fence fields');
  }
  validateFreshProgression(evidence, currentIndex, intake, errors);
}

export function checkTierGateGuard(text: string, options: TierGateGuardOptions = {}): TierGateGuardResult {
  const errors: string[] = [];
  const fence = parseComplexityTierFence(text);
  const tier = options.tier ?? (fence.kind === 'tier-fence' ? fence.tier : null);
  const skipLine = options.skipLine ?? fence.kind === 'no-tier';
  const stages = selectAuthoringReviewStages({ tier, skipLine, explicitAdversarialWrapper: options.explicitAdversarialWrapper });

  if (fence.kind === 'unparseable' && !skipLine) {
    errors.push(`unparseable complexity-tier fence — fail closed (${fence.reason})`);
  }
  if (!skipLine) validateTierTransition(text, fence, options, errors);

  const floors = checkNeverSkippedFloors(text, { repoRoot: options.repoRoot, draftPath: options.draftPath });
  if (!floors.ok) errors.push(...floors.errors);

  let receipt: TierGateReceipt | null = null;
  if (errors.length === 0) {
    if (skipLine || fence.kind === 'no-tier') {
      receipt = { kind: 'no-tier', skipLine: true };
    } else if (fence.kind === 'tier-fence') {
      receipt = {
        kind: 'tier-fence',
        tier: tier ?? fence.tier,
        advisoryPrior: fence.advisoryPrior,
        riskNote: fence.riskNote,
        effectiveTier: stages.effectiveTier,
        wrapperFloorApplied: stages.wrapperFloorApplied,
        explicitAdversarialWrapper: Boolean(options.explicitAdversarialWrapper),
      };
    }
  }
  return { ok: errors.length === 0, errors, receipt, fence, stages };
}

export function formatTierGatePassMessage(result: TierGateGuardResult): string {
  if (!result.receipt) return 'tier-gate guard: PASS';
  if (result.receipt.kind === 'no-tier') return 'tier-gate guard: PASS (receipt=no-tier skip-line)';
  const wrapper = result.receipt.wrapperFloorApplied ? ' wrapper-floor=T2' : '';
  return `tier-gate guard: PASS (receipt=tier-fence tier=${result.receipt.tier}${wrapper})`;
}
