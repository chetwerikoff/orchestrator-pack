/**
 * Tier gate core: fence parsing, stage selection, floor checks (Issue #576).
 * Tier transition provenance and bounded final-lens demotion enforcement (Issue #973).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { checkNeverSkippedFloors } from './tier-gate-floor.ts';

export { checkWorkerSafetyFloor } from './tier-gate-floor.ts';

export const VALID_TIERS = new Set(['T1', 'T2', 'T3']);
export const FLOOR_CHECKS = [
  'worker-safety',
  'contract-evidence',
  'behavior-kind',
  'finding-ledger-carve-out',
] as const;

/**
 * Frozen #973 production compatibility eligibility. The cutover deliberately chooses
 * the fail-closed empty set: every production identity follows fresh rules. Runtime code
 * must never discover, infer, append, or otherwise extend compatibility eligibility.
 */
export const PRE_973_CUTOVER_WORKDIR_IDENTITIES = Object.freeze([] as string[]);

/** Historical sanctioned demotions at #973 cutover: none. */
export const PRE_973_HISTORICAL_DEMOTIONS = Object.freeze([] as string[]);

/**
 * Exact producer identifiers recognized by tier-provenance parsers (#1093).
 * Runtime code must never discover, infer, append, or otherwise extend this set.
 */
export const TIER_PROVENANCE_PRODUCER_ALLOWLIST = Object.freeze([
  'cursor-flow-manager',
  'opencode-flow-manager',
] as const);

export type TierProvenanceProducer = (typeof TIER_PROVENANCE_PRODUCER_ALLOWLIST)[number];

const TIER_PROVENANCE_PRODUCER_SET = new Set<string>(TIER_PROVENANCE_PRODUCER_ALLOWLIST);

function asRecognizedProducer(value: unknown): TierProvenanceProducer | null {
  if (typeof value !== 'string') return null;
  return TIER_PROVENANCE_PRODUCER_SET.has(value) ? (value as TierProvenanceProducer) : null;
}

export const TIER_RUBRIC_CLASSES = new Set([
  'failure-type:text-cosmetics',
  'failure-type:local-behavior',
  'failure-type:subsystem-or-system-guarantee',
  'size:small-obvious-self-contained',
  'size:single-component-design-judgment',
  'fail-up:doubt',
]);

const FENCE_RE = /```complexity-tier\s*\n([\s\S]*?)```/i;
const DEMOTION_EVENT_RE = /```tier-demotion-event\s*\n([\s\S]*?)```/gi;
const DEMOTION_REVALIDATION_RE = /```tier-demotion-revalidation\s*\n([\s\S]*?)```/gi;
const REVISION_RE = /^r(\d+)$/i;

type Tier = 'T1' | 'T2' | 'T3';
type L4Status = 'clear' | 'active' | 'ambiguous' | 'missing' | 'stale';

export type ComplexityTierFence =
  | {
      kind: 'tier-fence';
      tier: string;
      advisoryPrior?: string;
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
}

export interface TierIntakeRecord {
  schema: 'tier-intake/v1';
  producer: TierProvenanceProducer;
  taskIdentity: string;
  kind: 'fresh' | 'compatibility';
  priorTier: Tier;
  firstRevision: string;
}

export interface TierDriverDisposition {
  kind: 'marker' | 'rubric';
  id: string;
  rationale: string;
}

export const CLAUDE_DEMOTION_ROLE = 'architect';
export const CLAUDE_DEMOTION_STAGE = 'final-architect-lens';
export const GPT_DEMOTION_ROLE = 'reviewer';
export const GPT_DEMOTION_STAGE = 'final-architectural';
export const GPT_NARROW_REVALIDATION_STAGE = 'final-architectural-narrow-revalidation';

export type TierDemotionRole = typeof CLAUDE_DEMOTION_ROLE | typeof GPT_DEMOTION_ROLE;
export type TierDemotionEventStage = typeof CLAUDE_DEMOTION_STAGE | typeof GPT_DEMOTION_STAGE;
export type TierDemotionRevalidationStage =
  | typeof CLAUDE_DEMOTION_STAGE
  | typeof GPT_NARROW_REVALIDATION_STAGE;

export interface TierDemotionEventRecord {
  schema: 'tier-demotion-event/v1';
  eventId: string;
  kind: 'new' | 'compatibility';
  role: TierDemotionRole;
  stage: TierDemotionEventStage;
  sourceRevision: string;
  beforeTier: Tier;
  afterTier: Tier;
  drivers: TierDriverDisposition[];
  historicalAfterRevision?: string;
  historicalLensCapture?: string;
}

export interface TierDemotionRevalidationRecord {
  schema: 'tier-demotion-revalidation/v1';
  eventId: string;
  role: TierDemotionRole;
  stage: TierDemotionRevalidationStage;
  candidateRevision: string;
  beforeTier: Tier;
  afterTier: Tier;
  l4Status: L4Status;
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
  events: Array<{ record: TierDemotionEventRecord; captureName: string; captureText: string }>;
  revalidations: Array<{
    record: TierDemotionRevalidationRecord;
    captureName: string;
    captureText: string;
  }>;
  captures?: Array<{ captureName: string; captureText: string }>;
}

export function parseComplexityTierFence(draftText: string): ComplexityTierFence {
  const match = draftText.match(FENCE_RE);
  if (!match) {
    return { kind: 'unparseable', reason: 'missing complexity-tier fence' };
  }

  const body = match[1] ?? '';
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const fields = new Map<string, string>();
  for (const line of lines) {
    const sep = line.indexOf(':');
    if (sep < 0) {
      return { kind: 'unparseable', reason: `invalid complexity-tier line: ${line}` };
    }
    fields.set(line.slice(0, sep).trim().toLowerCase(), line.slice(sep + 1).trim());
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
  const demotionFrom = fields.get('demotion-from')?.toUpperCase();
  const demotionEvent = fields.get('demotion-event');
  if (demotionFrom && !VALID_TIERS.has(demotionFrom)) {
    return { kind: 'unparseable', reason: `invalid demotion-from tier: ${demotionFrom}` };
  }
  if (Boolean(demotionFrom) !== Boolean(demotionEvent)) {
    return {
      kind: 'unparseable',
      reason: 'demotion-from and demotion-event must be present together',
    };
  }

  return {
    kind: 'tier-fence',
    tier,
    advisoryPrior: advisoryPrior && VALID_TIERS.has(advisoryPrior) ? advisoryPrior : undefined,
    demotionFrom,
    demotionEvent: demotionEvent || undefined,
    skipLine: false,
  };
}

function stripComplexityTierFence(text: string): string {
  return text.replace(FENCE_RE, '');
}

const ISSUE_BINDING_FENCE_RES = [
  /```behavior-kind\s*\n([\s\S]*?)```/i,
  /```denylist\s*\n([\s\S]*?)```/i,
  /```allowed-roots\s*\n([\s\S]*?)```/i,
  /```contract-evidence\s*\n([\s\S]*?)```/i,
] as const;

function extractIssueBindingFenceSnapshot(text: string): string {
  const parts: string[] = [];
  for (const pattern of ISSUE_BINDING_FENCE_RES) {
    const match = text.match(pattern);
    parts.push(match ? match[0].trim() : '<missing-binding-fence>');
  }
  return parts.join('\n---\n');
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

  if (input.skipLine) {
    return { effectiveTier: null, floor, authoring, review, wrapperFloorApplied: false };
  }

  let effectiveTier = input.tier;
  let wrapperFloorApplied = false;
  if (input.explicitAdversarialWrapper && effectiveTier === 'T1') {
    effectiveTier = 'T2';
    wrapperFloorApplied = true;
  }

  if (effectiveTier === 'T1') {
    review.push('light-architectural');
  } else if (effectiveTier === 'T2') {
    authoring.push('light-design-analysis');
    review.push('architectural');
    if (input.explicitAdversarialWrapper) {
      review.unshift('competitive-adversarial');
    }
  } else if (effectiveTier === 'T3') {
    authoring.push('full-design-analysis');
    review.push(
      'competitive-adversarial',
      'architectural',
      'architect-lens',
      'final-architectural',
    );
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
  cutoverIdentities?: readonly string[];
  historicalDemotionIdentities?: readonly string[];
}

export type TierGateReceipt =
  | { kind: 'no-tier'; skipLine: true }
  | {
      kind: 'tier-fence';
      tier: string;
      advisoryPrior?: string;
      demotionFrom?: string;
      demotionEvent?: string;
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

function asTier(value: unknown): Tier | null {
  const normalized = typeof value === 'string' ? value.toUpperCase() : '';
  return VALID_TIERS.has(normalized) ? (normalized as Tier) : null;
}

function tierRank(tier: Tier): number {
  return tier === 'T1' ? 1 : tier === 'T2' ? 2 : 3;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    return null;
  }
  const items = value.map((item) => String(item));
  return new Set(items).size === items.length ? items : null;
}

export function parseIntakeRecord(value: unknown): TierIntakeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const priorTier = asTier(record.priorTier);
  const producer = asRecognizedProducer(record.producer);
  if (
    record.schema !== 'tier-intake/v1'
    || !producer
    || typeof record.taskIdentity !== 'string'
    || record.taskIdentity.trim() === ''
    || (record.kind !== 'fresh' && record.kind !== 'compatibility')
    || !priorTier
    || typeof record.firstRevision !== 'string'
    || !REVISION_RE.test(record.firstRevision)
  ) {
    return null;
  }
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
  const tier = asTier(record.tier);
  const rubricClasses = parseStringArray(record.rubricClasses);
  const legacyMarkerRows = record.markerRows === undefined
    ? undefined
    : parseStringArray(record.markerRows) ?? undefined;
  const producer = asRecognizedProducer(record.producer);
  if (
    record.schema !== 'tier-gate-decision/v1'
    || !producer
    || typeof record.revision !== 'string'
    || !REVISION_RE.test(record.revision)
    || !tier
    || !rubricClasses
    || rubricClasses.length === 0
    || rubricClasses.some((item) => !TIER_RUBRIC_CLASSES.has(item))
    || !['clear', 'active', 'ambiguous', 'missing', 'stale'].includes(String(record.l4Status))
  ) {
    return null;
  }
  return {
    schema: 'tier-gate-decision/v1',
    producer,
    revision: record.revision,
    tier,
    markerRows: legacyMarkerRows,
    rubricClasses,
    l4Status: record.l4Status as L4Status,
  };
}

function parseDriverDisposition(value: unknown): TierDriverDisposition | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    (record.kind !== 'marker' && record.kind !== 'rubric')
    || typeof record.id !== 'string'
    || record.id.trim() === ''
    || typeof record.rationale !== 'string'
    || record.rationale.trim() === ''
  ) {
    return null;
  }
  return { kind: record.kind, id: record.id, rationale: record.rationale };
}

function isValidDemotionEventRoleStage(role: string, stage: string): boolean {
  return (
    (role === CLAUDE_DEMOTION_ROLE && stage === CLAUDE_DEMOTION_STAGE)
    || (role === GPT_DEMOTION_ROLE && stage === GPT_DEMOTION_STAGE)
  );
}

function isValidDemotionRevalidationRoleStage(role: string, stage: string): boolean {
  return (
    (role === CLAUDE_DEMOTION_ROLE && stage === CLAUDE_DEMOTION_STAGE)
    || (role === GPT_DEMOTION_ROLE && stage === GPT_NARROW_REVALIDATION_STAGE)
  );
}

function isAuthorizedDemotionTransition(role: string, beforeTier: Tier, afterTier: Tier): boolean {
  if (role === CLAUDE_DEMOTION_ROLE) return beforeTier === 'T3' && afterTier === 'T2';
  return role === GPT_DEMOTION_ROLE
    && ((beforeTier === 'T3' && afterTier === 'T2')
      || (beforeTier === 'T2' && afterTier === 'T1'));
}

function parseDemotionEvent(value: unknown): TierDemotionEventRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const beforeTier = asTier(record.beforeTier);
  const afterTier = asTier(record.afterTier);
  const drivers = Array.isArray(record.drivers)
    ? record.drivers.map(parseDriverDisposition)
    : null;
  if (
    record.schema !== 'tier-demotion-event/v1'
    || typeof record.eventId !== 'string'
    || record.eventId.trim() === ''
    || (record.kind !== 'new' && record.kind !== 'compatibility')
    || !isValidDemotionEventRoleStage(
      typeof record.role === 'string' ? record.role : '',
      typeof record.stage === 'string' ? record.stage : '',
    )
    || typeof record.sourceRevision !== 'string'
    || !REVISION_RE.test(record.sourceRevision)
    || !beforeTier
    || !afterTier
    || !drivers
    || drivers.some((driver) => !driver)
    || new Set(
      (drivers.filter(Boolean) as TierDriverDisposition[])
        .map((driver) => `${driver.kind}:${driver.id}`),
    ).size !== drivers.length
  ) {
    return null;
  }
  if (
    record.historicalAfterRevision != null
    && (typeof record.historicalAfterRevision !== 'string'
      || !REVISION_RE.test(record.historicalAfterRevision))
  ) {
    return null;
  }
  if (record.historicalLensCapture != null && typeof record.historicalLensCapture !== 'string') {
    return null;
  }
  const role = typeof record.role === 'string' ? record.role : '';
  if (
    tierRank(beforeTier) - tierRank(afterTier) !== 1
    || !isAuthorizedDemotionTransition(role, beforeTier, afterTier)
  ) {
    return null;
  }
  const stage = typeof record.stage === 'string' ? record.stage : '';
  return {
    schema: 'tier-demotion-event/v1',
    eventId: record.eventId,
    kind: record.kind,
    role: role as TierDemotionRole,
    stage: stage as TierDemotionEventStage,
    sourceRevision: record.sourceRevision,
    beforeTier,
    afterTier,
    drivers: drivers as TierDriverDisposition[],
    historicalAfterRevision: record.historicalAfterRevision as string | undefined,
    historicalLensCapture: record.historicalLensCapture as string | undefined,
  };
}

function parseDemotionRevalidation(value: unknown): TierDemotionRevalidationRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const beforeTier = asTier(record.beforeTier);
  const afterTier = asTier(record.afterTier);
  if (
    record.schema !== 'tier-demotion-revalidation/v1'
    || typeof record.eventId !== 'string'
    || record.eventId.trim() === ''
    || !isValidDemotionRevalidationRoleStage(
      typeof record.role === 'string' ? record.role : '',
      typeof record.stage === 'string' ? record.stage : '',
    )
    || typeof record.candidateRevision !== 'string'
    || !REVISION_RE.test(record.candidateRevision)
    || !beforeTier
    || !afterTier
    || !['clear', 'active', 'ambiguous', 'missing', 'stale'].includes(String(record.l4Status))
  ) {
    return null;
  }
  const role = typeof record.role === 'string' ? record.role : '';
  const stage = typeof record.stage === 'string' ? record.stage : '';
  if (!isAuthorizedDemotionTransition(role, beforeTier, afterTier)) return null;
  return {
    schema: 'tier-demotion-revalidation/v1',
    eventId: record.eventId,
    role: role as TierDemotionRole,
    stage: stage as TierDemotionRevalidationStage,
    candidateRevision: record.candidateRevision,
    beforeTier,
    afterTier,
    l4Status: record.l4Status as L4Status,
  };
}

function parseFencedJsonRecords<T>(
  text: string,
  regex: RegExp,
  parser: (value: unknown) => T | null,
): { records: T[]; malformed: boolean } {
  regex.lastIndex = 0;
  const records: T[] = [];
  let malformed = false;
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    try {
      const parsed = parser(JSON.parse(match[1] ?? ''));
      if (parsed) records.push(parsed);
      else malformed = true;
    } catch {
      malformed = true;
    }
  }
  return { records, malformed };
}

function revisionNumber(name: string): number {
  const match = name.match(REVISION_RE);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function deriveWorkdir(draftPath: string): { workdir: string; stem: string; reviewDir: string } | null {
  const normalized = resolve(draftPath);
  const stem = basename(normalized, '.md');
  const issueDraftsDir = dirname(normalized);
  if (basename(issueDraftsDir) !== 'issues_drafts' || basename(dirname(issueDraftsDir)) !== 'docs') {
    return null;
  }
  const workdir = dirname(dirname(issueDraftsDir));
  return {
    workdir,
    stem,
    reviewDir: join(issueDraftsDir, '.review', stem),
  };
}

function loadTransitionEvidenceFromWorkdir(
  draftPath: string,
  repoRoot = process.cwd(),
): { evidence: TierTransitionEvidence | null; errors: string[] } {
  const normalizedDraft = resolve(draftPath);
  const normalizedRepo = resolve(repoRoot);
  const repoRelative = relative(normalizedRepo, normalizedDraft);
  if (repoRelative === '' || (!repoRelative.startsWith('..') && !isAbsolute(repoRelative))) {
    // Tracked legacy drafts are prior art, not #973 Issue-only workdir anchors.
    return { evidence: null, errors: [] };
  }
  const layout = deriveWorkdir(draftPath);
  if (!layout) return { evidence: null, errors: [] };

  const errors: string[] = [];
  const intakePath = join(layout.reviewDir, 'tier-intake.json');
  let intake: TierIntakeRecord | null = null;
  if (existsSync(intakePath)) {
    try {
      intake = parseIntakeRecord(readJsonFile(intakePath));
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
    const draftFile = join(layout.workdir, revision, `${layout.stem}.md`);
    if (!existsSync(draftFile)) continue;
    const text = readFileSync(draftFile, 'utf8');
    const parsedFence = parseComplexityTierFence(text);
    const tier = parsedFence.kind === 'tier-fence' ? asTier(parsedFence.tier) : null;
    const receiptPath = join(layout.workdir, revision, 'tier-gate-receipt.json');
    let receipt: TierDecisionReceiptRecord | null = null;
    if (existsSync(receiptPath)) {
      try {
        receipt = parseDecisionReceipt(readJsonFile(receiptPath));
      } catch {
        receipt = null;
      }
    }
    revisions.push({ revision, text, tier, receipt });
  }

  const currentText = readFileSync(draftPath, 'utf8');
  const currentMatches = revisions.filter((item) => item.text === currentText);
  const currentRevision = currentMatches.at(-1)?.revision ?? '';
  if (!currentRevision) {
    errors.push('tier provenance: current anchor does not match an immutable rNN revision');
  }

  const events: TierTransitionEvidence['events'] = [];
  const revalidations: TierTransitionEvidence['revalidations'] = [];
  const captureEntries: NonNullable<TierTransitionEvidence['captures']> = [];
  if (existsSync(layout.reviewDir)) {
    const captureNames = readdirSync(layout.reviewDir)
      .filter((name) => name.endsWith('.capture.txt'))
      .sort();
    for (const captureName of captureNames) {
      const captureText = readFileSync(join(layout.reviewDir, captureName), 'utf8');
      captureEntries.push({ captureName, captureText });
      const eventParsed = parseFencedJsonRecords(captureText, DEMOTION_EVENT_RE, parseDemotionEvent);
      const revalidationParsed = parseFencedJsonRecords(
        captureText,
        DEMOTION_REVALIDATION_RE,
        parseDemotionRevalidation,
      );
      if (eventParsed.malformed) {
        errors.push(`tier provenance: malformed demotion event in ${captureName}`);
      }
      if (revalidationParsed.malformed) {
        errors.push(`tier provenance: malformed demotion revalidation in ${captureName}`);
      }
      events.push(...eventParsed.records.map((record) => ({ record, captureName, captureText })));
      revalidations.push(
        ...revalidationParsed.records.map((record) => ({ record, captureName, captureText })),
      );
    }
  }

  return {
    evidence: {
      taskIdentity: layout.stem,
      currentRevision,
      intake,
      revisions,
      events,
      revalidations,
      captures: captureEntries,
    },
    errors,
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function driverKey(kind: 'marker' | 'rubric', id: string): string {
  return `${kind}:${id}`;
}

function capturePassIndex(name: string, pattern: RegExp): number | null {
  const match = name.match(pattern);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) ? value : null;
}

const ARCHITECTURAL_LENS_CAPTURE_RE = /^pass-(\d+)-architectural-lens\.capture\.txt$/i;
const ARCHITECTURAL_CAPTURE_RE = /^pass-(\d+)-architectural\.capture\.txt$/i;
const GPT_NARROW_REVALIDATION_CAPTURE_RE =
  /^pass-(\d+)-architectural-demotion-narrow-revalidation\.capture\.txt$/i;

function architectLensPassIndex(name: string): number | null {
  return capturePassIndex(name, ARCHITECTURAL_LENS_CAPTURE_RE);
}

function architecturalPassIndex(name: string): number | null {
  return capturePassIndex(name, ARCHITECTURAL_CAPTURE_RE);
}

function gptNarrowRevalidationPassIndex(name: string): number | null {
  return capturePassIndex(name, GPT_NARROW_REVALIDATION_CAPTURE_RE);
}

function isArchitectLensCaptureName(name: string): boolean {
  return architectLensPassIndex(name) !== null;
}

function usesLegacySingleDemotionSemantics(
  evidence: TierTransitionEvidence,
  historicalDemotions: Set<string>,
): boolean {
  return evidence.intake?.kind === 'compatibility' || historicalDemotions.has(evidence.taskIdentity);
}

function validateDemotionEventCaptureBinding(
  eventEntry: TierTransitionEvidence['events'][number],
  errors: string[],
): number | null {
  const event = eventEntry.record;
  if (!isAuthorizedDemotionTransition(event.role, event.beforeTier, event.afterTier)) {
    errors.push('tier demotion: role is not authorized for the requested adjacent transition');
  }
  if (event.role === CLAUDE_DEMOTION_ROLE) {
    const pass = architectLensPassIndex(eventEntry.captureName);
    if (pass === null) {
      errors.push('tier demotion: Claude event must come from a canonical architect-lens capture');
    }
    return pass;
  }
  const pass = architecturalPassIndex(eventEntry.captureName);
  if (pass === null) {
    errors.push('tier demotion: GPT event must come from a canonical architectural capture');
  }
  return pass;
}

function validateDemotionRevalidationCaptureBinding(
  eventEntry: TierTransitionEvidence['events'][number],
  revalidationEntry: TierTransitionEvidence['revalidations'][number],
  eventPass: number | null,
  errors: string[],
): void {
  const event = eventEntry.record;
  const revalidation = revalidationEntry.record;
  if (revalidation.role !== event.role) {
    errors.push('tier demotion: revalidation role does not match originating event');
  }
  if (revalidation.role === CLAUDE_DEMOTION_ROLE) {
    const revalidationPass = architectLensPassIndex(revalidationEntry.captureName);
    if (revalidationPass === null) {
      errors.push('tier demotion: Claude revalidation must come from a canonical architect-lens capture');
    } else if (eventPass !== null && revalidationPass <= eventPass) {
      errors.push('tier demotion: current-candidate revalidation must be newer than demotion event');
    }
    return;
  }
  const narrowPass = gptNarrowRevalidationPassIndex(revalidationEntry.captureName);
  if (narrowPass === null) {
    errors.push('tier demotion: GPT revalidation must come from a canonical narrow-revalidation capture');
    return;
  }
  if (eventPass !== null && narrowPass !== eventPass) {
    errors.push('tier demotion: GPT narrow revalidation must share the originating architectural pass index');
  }
  const eventBlocks = parseFencedJsonRecords(
    revalidationEntry.captureText,
    DEMOTION_EVENT_RE,
    parseDemotionEvent,
  );
  const revalidationBlocks = parseFencedJsonRecords(
    revalidationEntry.captureText,
    DEMOTION_REVALIDATION_RE,
    parseDemotionRevalidation,
  );
  if (eventBlocks.records.length > 0 || eventBlocks.malformed) {
    errors.push('tier demotion: GPT narrow revalidation capture cannot contain a demotion event');
  }
  if (revalidationBlocks.records.length > 0) {
    DEMOTION_REVALIDATION_RE.lastIndex = 0;
    const remainder = revalidationEntry.captureText.replace(DEMOTION_REVALIDATION_RE, '').trim();
    if (revalidationBlocks.records.length !== 1 || revalidationBlocks.malformed || remainder !== '') {
      errors.push('tier demotion: GPT narrow revalidation capture must contain only one revalidation JSON block');
    }
  }
}

function validateFreshDemotionChain(
  evidence: TierTransitionEvidence,
  errors: string[],
): Array<{
  eventEntry: TierTransitionEvidence['events'][number];
  sourceIndex: number;
  candidateIndex: number;
}> {
  if (evidence.events.some((entry) => entry.record.kind !== 'new')) {
    errors.push('tier demotion: fresh lifecycle cannot contain compatibility demotion evidence');
  }
  const newEvents = evidence.events.filter((entry) => entry.record.kind === 'new');

  const sorted = [...newEvents].sort(
    (left, right) => revisionNumber(left.record.sourceRevision) - revisionNumber(right.record.sourceRevision),
  );
  const edges = new Set<string>();
  const eventIds = new Set<string>();
  const sourceRevisions = new Set<string>();
  const captureCounts = new Map<string, number>();
  for (const entry of sorted) {
    captureCounts.set(entry.captureName, (captureCounts.get(entry.captureName) ?? 0) + 1);
  }
  if ([...captureCounts.values()].some((count) => count > 1)) {
    errors.push('tier demotion: one authoritative lens capture may authorize at most one downstep');
  }
  const declaredEventIds = new Set(sorted.map((entry) => entry.record.eventId));
  if (evidence.revalidations.some((entry) => !declaredEventIds.has(entry.record.eventId))) {
    errors.push('tier demotion: orphan revalidation does not bind a fresh-chain event');
  }

  const validated: Array<{
    eventEntry: TierTransitionEvidence['events'][number];
    sourceIndex: number;
    candidateIndex: number;
  }> = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const eventEntry = sorted[index];
    const event = eventEntry.record;
    const edge = `${event.beforeTier}->${event.afterTier}`;
    if (eventIds.has(event.eventId)) {
      errors.push('tier demotion: duplicate demotion event id in fresh chain');
    }
    eventIds.add(event.eventId);
    if (edges.has(edge)) {
      errors.push('tier demotion: duplicate adjacent demotion edge in fresh chain');
    }
    edges.add(edge);
    if (sourceRevisions.has(event.sourceRevision)) {
      errors.push('tier demotion: multiple downsteps cannot share one source revision');
    }
    sourceRevisions.add(event.sourceRevision);
    if (index > 0) {
      const previous = sorted[index - 1].record;
      if (previous.afterTier !== event.beforeTier) {
        errors.push('tier demotion: demotion chain is not contiguous');
      }
      if (revisionNumber(previous.sourceRevision) >= revisionNumber(event.sourceRevision)) {
        errors.push('tier demotion: demotion chain source revisions are out of order');
      }
    }
    if (tierRank(event.beforeTier) - tierRank(event.afterTier) !== 1) {
      errors.push('tier demotion: only one adjacent tier downstep is allowed per authoritative capture');
    }

    const eventPass = validateDemotionEventCaptureBinding(eventEntry, errors);
    const sourceIndex = evidence.revisions.findIndex(
      (revision) => revision.revision === event.sourceRevision,
    );
    const source = sourceIndex >= 0 ? evidence.revisions[sourceIndex] : null;
    if (!source || source.tier !== event.beforeTier) {
      errors.push('tier demotion: event source revision tier does not match event beforeTier');
    } else {
      validateDecisionReceipt(source, errors);
      if (source.receipt) {
        const expectedDrivers = source.receipt.rubricClasses.map((id) => driverKey('rubric', id));
        const actualDrivers = event.drivers
          .filter((driver) => driver.kind === 'rubric')
          .map((driver) => driverKey(driver.kind, driver.id));
        if (!sameStringSet(expectedDrivers, actualDrivers)) {
          errors.push('tier demotion: event driver dispositions must exactly match source trigger set');
        }
      }
    }

    const matchingRevalidations = evidence.revalidations.filter(
      (entry) => entry.record.eventId === event.eventId,
    );
    if (matchingRevalidations.length !== 1) {
      errors.push(`tier demotion: current candidate requires exactly one matching demotion revalidation (event ${event.eventId})`);
      validated.push({ eventEntry, sourceIndex, candidateIndex: -1 });
      continue;
    }
    const revalidationEntry = matchingRevalidations[0];
    const revalidation = revalidationEntry.record;
    validateDemotionRevalidationCaptureBinding(eventEntry, revalidationEntry, eventPass, errors);
    if (
      revalidation.beforeTier !== event.beforeTier
      || revalidation.afterTier !== event.afterTier
    ) {
      errors.push('tier demotion: revalidation transition does not match original event');
    }
    if (revalidation.l4Status !== 'clear') {
      errors.push(`tier demotion: revalidation L4 evidence must be clear (${revalidation.l4Status})`);
    }
    const candidateIndex = evidence.revisions.findIndex(
      (revision) => revision.revision === revalidation.candidateRevision,
    );
    const candidate = candidateIndex >= 0 ? evidence.revisions[candidateIndex] : null;
    if (
      !candidate
      || candidateIndex <= sourceIndex
      || candidate.tier !== event.afterTier
    ) {
      errors.push('tier demotion: revalidation candidate revision does not prove the event transition');
    } else {
      validateDecisionReceipt(candidate, errors);
      if (candidate.receipt?.l4Status !== 'clear') {
        errors.push('tier demotion: revalidated candidate requires a clear bound tier receipt');
      }
    }
    if (event.role === GPT_DEMOTION_ROLE && candidateIndex !== sourceIndex + 1) {
      errors.push('tier demotion: GPT narrow revalidation must bind the immediate post-event revision');
    }
    if (
      event.role === GPT_DEMOTION_ROLE
      && source
      && candidate
      && candidateIndex === sourceIndex + 1
      && extractIssueBindingFenceSnapshot(source.text)
        !== extractIssueBindingFenceSnapshot(candidate.text)
    ) {
      errors.push('tier demotion: narrow revalidation candidate contains unrelated material body change');
    }
    validated.push({ eventEntry, sourceIndex, candidateIndex });
  }

  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index - 1].candidateIndex !== validated[index].sourceIndex) {
      errors.push('tier demotion: each fresh-chain step must start from the preceding revalidated candidate');
    }
  }
  return validated;
}

function validateDecisionReceipt(
  revision: TierTransitionEvidence['revisions'][number],
  errors: string[],
): void {
  if (!revision.receipt) {
    errors.push(`tier provenance: missing or malformed tier-gate receipt for ${revision.revision}`);
    return;
  }
  if (revision.receipt.revision !== revision.revision || revision.receipt.tier !== revision.tier) {
    errors.push(`tier provenance: tier-gate receipt binding mismatch for ${revision.revision}`);
  }
}

function validateCompatibilityEvent(
  eventEntry: TierTransitionEvidence['events'][number],
  evidence: TierTransitionEvidence,
  errors: string[],
): void {
  const event = eventEntry.record;
  if (!event.historicalAfterRevision || !event.historicalLensCapture) {
    errors.push('tier demotion: compatibility event missing historical transition evidence');
    return;
  }
  const source = evidence.revisions.find((item) => item.revision === event.sourceRevision);
  const after = evidence.revisions.find((item) => item.revision === event.historicalAfterRevision);
  if (!source || !after || source.tier !== event.beforeTier || after.tier !== event.afterTier) {
    errors.push('tier demotion: compatibility event historical revisions do not prove transition');
  }
  const historicalCapture = evidence.captures?.find(
    (item) => item.captureName === event.historicalLensCapture,
  );
  if (!historicalCapture) {
    errors.push('tier demotion: compatibility event historical final-lens capture is missing');
  } else {
    if (!isArchitectLensCaptureName(historicalCapture.captureName)) {
      errors.push('tier demotion: compatibility historical evidence is not an architect-lens capture');
    }
    const normalized = historicalCapture.captureText.toLowerCase();
    if (
      !normalized.includes('architect')
      || !normalized.includes('final')
      || !historicalCapture.captureText.includes(event.sourceRevision)
      || !historicalCapture.captureText.includes(event.historicalAfterRevision)
    ) {
      errors.push('tier demotion: compatibility historical capture does not bind final-lens transition');
    }
  }
}

function validateTierTransition(
  text: string,
  fence: ComplexityTierFence,
  opts: TierGateGuardOptions,
  errors: string[],
): void {
  if (fence.kind !== 'tier-fence') return;

  const loaded = opts.transitionEvidence
    ? { evidence: opts.transitionEvidence, errors: [] }
    : opts.draftPath
      ? loadTransitionEvidenceFromWorkdir(opts.draftPath, opts.repoRoot)
      : { evidence: null, errors: [] };
  errors.push(...loaded.errors);
  const evidence = loaded.evidence;
  if (!evidence) return;

  const currentTier = asTier(fence.tier);
  if (!currentTier) return;
  const cutover = new Set(opts.cutoverIdentities ?? PRE_973_CUTOVER_WORKDIR_IDENTITIES);
  const historicalDemotions = new Set(
    opts.historicalDemotionIdentities ?? PRE_973_HISTORICAL_DEMOTIONS,
  );
  const isLegacyListed = cutover.has(evidence.taskIdentity);
  const intake = evidence.intake;

  if (!intake) {
    if (!loaded.errors.some((error) => error.includes('intake evidence'))) {
      errors.push('tier provenance: missing flow-manager intake evidence');
    }
    return;
  }
  if (intake.taskIdentity !== evidence.taskIdentity) {
    errors.push('tier provenance: intake evidence task identity mismatch');
  }
  if (intake.kind === 'compatibility' && !isLegacyListed) {
    errors.push('tier provenance: compatibility intake requires frozen cutover membership');
  }
  if (fence.advisoryPrior !== intake.priorTier) {
    errors.push('tier provenance: advisory-prior does not match flow-manager intake prior');
  }

  const currentIndex = evidence.revisions.findIndex((item) => item.revision === evidence.currentRevision);
  if (currentIndex < 0) {
    errors.push('tier provenance: current revision binding is missing');
    return;
  }
  const current = evidence.revisions[currentIndex];
  if (current.tier !== currentTier) {
    errors.push('tier provenance: current immutable revision tier does not match candidate');
  }
  validateDecisionReceipt(current, errors);
  if (current.receipt && currentTier !== 'T3' && current.receipt.l4Status !== 'clear') {
    errors.push(`tier demotion: below-T3 candidate requires current clear L4 evidence (${current.receipt.l4Status})`);
  }

  const first = evidence.revisions.find((item) => item.revision === intake.firstRevision);
  const earliestValid = evidence.revisions.find((item) => item.tier);
  if (!first || !first.tier) {
    errors.push('tier provenance: intake firstRevision is missing or unparseable');
  } else if (!earliestValid || earliestValid.revision !== intake.firstRevision) {
    errors.push('tier provenance: intake firstRevision must bind the first valid immutable revision');
  } else if (intake.kind === 'compatibility') {
    if (intake.priorTier !== first.tier) {
      errors.push('tier provenance: compatibility intake prior must equal first valid revision tier');
    }
  } else if (tierRank(first.tier) < tierRank(intake.priorTier)) {
    errors.push('tier provenance: first authoritative candidate cannot be below intake prior');
  }

  if (currentIndex === 0) return;
  const preceding = evidence.revisions.slice(0, currentIndex).filter((item) => item.tier);
  if (preceding.length === 0) return;
  for (const revision of preceding) {
    validateDecisionReceipt(revision, errors);
  }

  const highRank = Math.max(...preceding.map((item) => tierRank(item.tier as Tier)));
  const highTier = (['T1', 'T2', 'T3'] as Tier[])[highRank - 1];
  if (tierRank(currentTier) >= highRank) return;

  const source = [...preceding].reverse().find((item) => item.tier === highTier);
  if (!source?.receipt) {
    errors.push('tier demotion: source high-watermark decision receipt is unavailable');
    return;
  }
  validateDecisionReceipt(source, errors);

  if (!fence.demotionFrom || !fence.demotionEvent) {
    errors.push('tier demotion: observed downstep requires demotion-from and demotion-event fence fields');
    return;
  }
  const legacySemantics = usesLegacySingleDemotionSemantics(evidence, historicalDemotions);
  if (legacySemantics) {
    if (highRank - tierRank(currentTier) !== 1) {
      errors.push('tier demotion: only one adjacent tier downstep is allowed');
    }
    const distinctEventIds = new Set(evidence.events.map((entry) => entry.record.eventId));
    if (distinctEventIds.size > 1) {
      errors.push('tier demotion: lifecycle already contains conflicting/second demotion event');
    }
    const matchingEvents = evidence.events.filter(
      (entry) => entry.record.eventId === fence.demotionEvent,
    );
    if (matchingEvents.length !== 1) {
      errors.push('tier demotion: exactly one demotion event is required for the fence demotion-event id');
      return;
    }
    const eventEntry = matchingEvents[0];
    const event = eventEntry.record;
    const eventPass = validateDemotionEventCaptureBinding(eventEntry, errors);
    if (fence.demotionFrom !== highTier) {
      errors.push('tier demotion: demotion-from does not match immutable high-watermark');
    }
    if (
      event.sourceRevision !== source.revision
      || event.beforeTier !== highTier
      || event.afterTier !== currentTier
    ) {
      errors.push('tier demotion: event source/candidate transition binding mismatch');
    }
    if (event.kind !== 'compatibility') {
      errors.push('tier demotion: frozen historical identity must use compatibility evidence');
    } else {
      if (!isLegacyListed) {
        errors.push('tier demotion: compatibility event requires frozen cutover membership');
      }
      if (!historicalDemotions.has(evidence.taskIdentity)) {
        errors.push('tier demotion: compatibility event is absent from frozen historical-demotion census');
      }
      validateCompatibilityEvent(eventEntry, evidence, errors);
    }
    const expectedDrivers = source.receipt.rubricClasses.map((id) => driverKey('rubric', id));
    const actualDrivers = event.drivers
      .filter((driver) => driver.kind === 'rubric')
      .map((driver) => driverKey(driver.kind, driver.id));
    if (!sameStringSet(expectedDrivers, actualDrivers)) {
      errors.push('tier demotion: event driver dispositions must exactly match source trigger set');
    }
    const matchingRevalidations = evidence.revalidations.filter(
      (entry) => entry.record.eventId === event.eventId
        && entry.record.candidateRevision === evidence.currentRevision,
    );
    if (matchingRevalidations.length !== 1) {
      errors.push('tier demotion: current candidate requires exactly one matching demotion revalidation');
      return;
    }
    const revalidationEntry = matchingRevalidations[0];
    validateDemotionRevalidationCaptureBinding(eventEntry, revalidationEntry, eventPass, errors);
    const revalidation = revalidationEntry.record;
    if (
      revalidation.beforeTier !== event.beforeTier
      || revalidation.afterTier !== event.afterTier
    ) {
      errors.push('tier demotion: revalidation transition does not match original event');
    }
    if (revalidation.l4Status !== 'clear') {
      errors.push(`tier demotion: revalidation L4 evidence must be clear (${revalidation.l4Status})`);
    }
  } else {
    const chain = validateFreshDemotionChain(evidence, errors);
    if (chain.length === 0) {
      errors.push('tier demotion: observed downstep requires a fresh adjacent demotion chain');
      return;
    }
    const firstStep = chain[0];
    const latestStep = chain.at(-1)!;
    const firstEvent = firstStep.eventEntry.record;
    const latestEvent = latestStep.eventEntry.record;
    if (firstEvent.beforeTier !== highTier) {
      errors.push('tier demotion: fresh chain must start from the immutable preceding high tier');
    }
    if (latestEvent.eventId !== fence.demotionEvent) {
      errors.push('tier demotion: fence must reference the latest event in the fresh chain');
    }
    if (fence.demotionFrom !== latestEvent.beforeTier) {
      errors.push('tier demotion: demotion-from does not match the latest adjacent downstep source tier');
    }
    if (latestEvent.afterTier !== currentTier || latestStep.candidateIndex !== currentIndex) {
      errors.push('tier demotion: latest event/revalidation does not bind the current candidate');
    }
    if (chain.length !== highRank - tierRank(currentTier)) {
      errors.push('tier demotion: fresh chain does not cover each adjacent tier edge exactly once');
    }
    const firstSourceIndex = firstStep.sourceIndex;
    for (let index = Math.max(firstSourceIndex + 1, 1); index <= currentIndex; index += 1) {
      const previousTier = evidence.revisions[index - 1].tier;
      const nextTier = evidence.revisions[index].tier;
      if (previousTier && nextTier && tierRank(nextTier) > tierRank(previousTier)) {
        errors.push('tier demotion: intervening upstep invalidates the fresh demotion chain');
        break;
      }
    }
  }

  // Ensure the current candidate text is the same text being guarded.
  if (current.text !== text) {
    errors.push('tier provenance: guarded text does not match current immutable revision');
  }
}

export function checkTierGateGuard(
  text: string,
  opts: TierGateGuardOptions = {},
): TierGateGuardResult {
  const errors: string[] = [];
  const fence = parseComplexityTierFence(text);

  const tier = opts.tier ?? (fence.kind === 'tier-fence' ? fence.tier : null);
  const skipLine = opts.skipLine ?? (fence.kind === 'no-tier');

  const stages = selectAuthoringReviewStages({
    tier,
    skipLine,
    explicitAdversarialWrapper: opts.explicitAdversarialWrapper,
  });

  if (fence.kind === 'unparseable' && !skipLine) {
    errors.push(`unparseable complexity-tier fence — fail closed (${fence.reason})`);
  }

  if (!skipLine) {
    validateTierTransition(text, fence, opts, errors);
  }

  const workerSafety = checkNeverSkippedFloors(text, {
    repoRoot: opts.repoRoot,
    draftPath: opts.draftPath,
  });
  if (!workerSafety.ok) {
    errors.push(...workerSafety.errors);
  }

  let receipt: TierGateReceipt | null = null;
  if (errors.length === 0) {
    if (skipLine || fence.kind === 'no-tier') {
      receipt = { kind: 'no-tier', skipLine: true };
    } else {
      receipt = {
        kind: 'tier-fence',
        tier: tier ?? (fence.kind === 'tier-fence' ? fence.tier : 'T3'),
        advisoryPrior: fence.kind === 'tier-fence' ? fence.advisoryPrior : undefined,
        demotionFrom: fence.kind === 'tier-fence' ? fence.demotionFrom : undefined,
        demotionEvent: fence.kind === 'tier-fence' ? fence.demotionEvent : undefined,
        effectiveTier: stages.effectiveTier,
        wrapperFloorApplied: stages.wrapperFloorApplied,
        explicitAdversarialWrapper: Boolean(opts.explicitAdversarialWrapper),
      };
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    receipt,
    fence,
    stages,
  };
}

export function formatTierGatePassMessage(result: TierGateGuardResult): string {
  if (!result.receipt) {
    return 'tier-gate guard: PASS';
  }
  if (result.receipt.kind === 'no-tier') {
    return 'tier-gate guard: PASS (receipt=no-tier skip-line)';
  }
  const wrapperNote = result.receipt.wrapperFloorApplied ? ' wrapper-floor=T2' : '';
  const demotionNote = result.receipt.demotionEvent
    ? ` demotion-event=${result.receipt.demotionEvent}`
    : '';
  return `tier-gate guard: PASS (receipt=tier-fence tier=${result.receipt.tier}${wrapperNote}${demotionNote})`;
}
