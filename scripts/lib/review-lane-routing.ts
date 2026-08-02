import { createHash } from 'node:crypto';

export const REVIEW_LANE_CLASSIFIER_POLICY_VERSION = 'review-lane-classifier/v1' as const;
export const REVIEW_LANE_ROUTING_POLICY_VERSION = 'review-lane-routing/v1' as const;
export const MATERIAL_VERDICT_CONFLICT_RULE = 'material-verdict-conflict/v1' as const;

export const SAFE_BEHAVIOR_TAGS = Object.freeze([
  'documentation-only', 'test-only', 'generated-parity-only', 'author-declaration-validation',
  'pure-review-lane-selection', 'review-source-cardinality-only', 'tier-lane-orthogonality',
  'additive-existing-receipt-evidence', 'material-verdict-normalization-only',
  'scope-declaration-only', 'routing-policy-epoch',
] as const);
export const SECURITY_BEHAVIOR_TAGS = Object.freeze([
  'credentials-or-secrets', 'authentication-or-authorization', 'permissions-or-trust',
  'authenticated-external-side-effect', 'protected-boundary-enforcement',
] as const);
export const DESTRUCTIVE_BEHAVIOR_TAGS = Object.freeze([
  'merge-or-release-authority', 'deletion-or-destructive-cleanup', 'irreversible-mutation', 'rollback-authority',
] as const);

const ALLOWED_ROOTS = [
  'docs/tiering.md', 'docs/review-lanes.md', 'docs/declarations/**',
  '.claude/skills/create-issue-draft/**', '.claude/skills/discuss-with-gpt/**',
  '.cursor/skills/create-issue-draft/**', '.cursor/skills/discuss-with-gpt/**',
  'scripts/lib/tier-gate-core.ts', 'scripts/lib/tier-gate-*.test.ts',
  'scripts/lib/stage-completeness-core.ts', 'scripts/stage-completeness-guard.ts',
  'scripts/stage-completeness-guard.test.ts', 'scripts/lib/create-issue-stage-record*.ts',
  'scripts/lib/create-issue-stage-record*.test.ts', 'scripts/create-issue-stage-finalize.ts',
  'scripts/lib/review-lane-*.ts', 'scripts/review-lane-*.ts',
] as const;
const DENYLIST = [
  'vendor/**', 'packages/core/**', '.ao/**', '.github/workflows/**', 'prompts/**',
  'scripts/chatgpt-browser-turn/**', 'agent-orchestrator.yaml', 'agent-orchestrator.*.yaml',
  '**/.env*', '**/*credential*', '**/*secret*',
] as const;
const SECURITY_TOKENS = new Set([
  'credential', 'credentials', 'secret', 'secrets', 'auth', 'authentication',
  'authorization', 'permission', 'permissions', 'trust',
]);
const DESTRUCTIVE_TOKENS = new Set(['merge', 'release', 'delete', 'deletion', 'cleanup', 'rollback', 'irreversible']);

export type ReviewLaneBehaviorTag = string;
export type ReviewLaneEntryKind = 'exact' | 'family';
export type ReviewLaneInputStatus = 'usable' | 'author-revision-required' | 'producer-unavailable';
export type ReviewLaneAuthorRevisionReason =
  | 'declaration-missing' | 'declaration-malformed' | 'declaration-contradictory'
  | 'path-not-repository-relative' | 'declared-path-outside-allowed-roots' | 'declared-path-denied';
export type ReviewLaneProducerUnavailableReason =
  | 'consistent-revision-body-identity-unavailable' | 'lane-input-producer-unavailable' | 'lane-input-identity-unproducible';
export type ReviewLaneBlastRadius = 'low' | 'high' | 'high-or-uncertain';
export type ReviewLanePolicyStatus = 'available' | 'unavailable';
export type ReviewLanePolicyUnavailableReason =
  | 'classifier-version-unknown' | 'classifier-rules-unreadable' | 'classifier-rules-malformed'
  | 'classifier-rules-contradictory' | 'classifier-identity-unproducible' | 'classifier-identity-mismatch';
export type ReviewLaneScopeClass = 'safe' | 'security-sensitive' | 'destructive' | 'conservative-invalid';
export type ReviewLaneConservativeReason =
  | 'unmatched-path' | 'unmatched-path-family' | 'unknown-behavior-tag'
  | 'missing-required-multipurpose-tag' | 'conflicting-author-tags';
export type ReviewLaneTopology = 'fixed/v1' | 'conditional-third/v1';
export type ReviewLaneSlotState = 'activated' | 'not-activated';
export type ReviewLaneSourceVerdict = 'accept' | 'material-findings' | 'blocked' | 'refused' | 'unparseable';
export type ReviewLaneConflictDecision = 'no-conflict' | 'conflict-requires-slot-03' | 'blocked-initial-source';
export type ReviewLaneName = 'normal' | 'disputed';

export interface ReviewLaneAuthorEntry {
  kind: ReviewLaneEntryKind;
  path: string;
  behaviors: readonly ReviewLaneBehaviorTag[];
}
export interface ReviewLaneAuthorDeclaration {
  schema: 'review-lane-change-set/v1';
  owner: 'issue-author';
  entries: readonly ReviewLaneAuthorEntry[];
}
export interface NormalizedReviewLaneEntry {
  kind: ReviewLaneEntryKind;
  path: string;
  behaviors: string[];
}
export interface UsableReviewLaneInput {
  status: 'usable';
  sourceRevision?: string;
  bodyIdentity?: string;
  identity: string;
  entries: NormalizedReviewLaneEntry[];
  blastRadius: ReviewLaneBlastRadius;
}
export interface ReviewLaneAuthorRevisionRequired {
  status: 'author-revision-required';
  reason: ReviewLaneAuthorRevisionReason;
  entry?: string;
  message: string;
}
export interface ReviewLaneProducerUnavailable {
  status: 'producer-unavailable';
  reason: ReviewLaneProducerUnavailableReason;
  observed?: ReviewLaneBodyRead[];
  message: string;
}
export type ReviewLaneInput = UsableReviewLaneInput | ReviewLaneAuthorRevisionRequired | ReviewLaneProducerUnavailable;
export interface ReviewLanePathClassification {
  path: string;
  scopeClass: ReviewLaneScopeClass;
  conservativeReasons: ReviewLaneConservativeReason[];
  matchedRule: string | null;
}
export interface ReviewLaneClassification {
  schema: 'review-lane-classifier/v1';
  policyStatus: ReviewLanePolicyStatus;
  policyIdentity: string;
  unavailableReason?: ReviewLanePolicyUnavailableReason;
  scopeClass: ReviewLaneScopeClass;
  conservativeReasons: ReviewLaneConservativeReason[];
  paths: ReviewLanePathClassification[];
}
export interface ReviewLaneRouting {
  schema: typeof REVIEW_LANE_ROUTING_POLICY_VERSION;
  routingPolicyIdentity: typeof REVIEW_LANE_ROUTING_POLICY_VERSION;
  lane: ReviewLaneName;
  topology: ReviewLaneTopology;
  policyVersion: typeof REVIEW_LANE_ROUTING_POLICY_VERSION;
  reviewerCardinality: number;
  cardinalityConfigIdentity: string;
  possibleSlots: string[];
  initiallyActivatedSlots: string[];
  conditionalActivationRule: typeof MATERIAL_VERDICT_CONFLICT_RULE | null;
  sourceRevision: string;
  stageAttemptId: string;
  laneInputIdentity: string;
  classifierIdentity: string;
}
export interface ReviewLaneBodyRead { sourceRevision: string; body: string; }
export interface FrozenReviewLaneBody {
  status: 'frozen';
  sourceRevision: string;
  body: string;
  bodyIdentity: string;
  reads: ReviewLaneBodyRead[];
}
export interface ReviewLaneBodyIdentityUnavailable {
  status: 'producer-unavailable';
  reason: 'consistent-revision-body-identity-unavailable';
  observed: ReviewLaneBodyRead[];
  message: string;
}
export type ReviewLaneBodyFreezeResult = FrozenReviewLaneBody | ReviewLaneBodyIdentityUnavailable;
export interface MaterialVerdictEvidence {
  terminalClassification: string;
  captureVerified?: boolean;
  digestMatches?: boolean;
  verdictText?: string;
  rawFindingCount?: number;
  materialFindingBlocks?: number;
}
export interface ReviewLaneSettlement {
  ok: boolean;
  conflictDecision: ReviewLaneConflictDecision;
  finalRequiredSlots: string[];
  slotCensus: Array<{ slot: string; state: ReviewLaneSlotState }>;
  errors: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function declaration(value: unknown): value is ReviewLaneAuthorDeclaration {
  return record(value) && value.schema === 'review-lane-change-set/v1'
    && value.owner === 'issue-author' && Array.isArray(value.entries);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!record(value)) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function glob(globText: string): RegExp {
  return new RegExp(`^${globText.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '.*').replaceAll('*', '[^/]*')}$`);
}
function matches(path: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return glob(pattern).test(path);
}
function normalizedPath(value: string): { path: string; relative: boolean } {
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\/+/, '');
  return {
    path,
    relative: path.length > 0 && !path.startsWith('/') && !/^[A-Za-z]:\//.test(path) && !path.split('/').includes('..'),
  };
}
function denied(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split('/').filter(Boolean);
  const file = segments.at(-1) ?? '';
  const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file;
  const sensitiveSegment = segments.some((segment) =>
    segment.includes('secret') || segment.includes('credential') || segment.startsWith('.env'));
  const sensitiveStem = stem.includes('secret') || stem.includes('credential') || stem.startsWith('.env');
  return sensitiveSegment || sensitiveStem
    || DENYLIST.some((pattern) => matches(path, pattern) || matches(lower, pattern.toLowerCase()));
}
function allowed(path: string): boolean {
  return ALLOWED_ROOTS.some((pattern) => matches(path, pattern));
}
function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function parseReviewLaneAuthorDeclaration(value: unknown): ReviewLaneAuthorDeclaration | null {
  return declaration(value) ? value : null;
}

export function normalizeReviewLaneDeclaration(value: unknown): ReviewLaneInput {
  if (!declaration(value)) {
    return {
      status: 'author-revision-required',
      reason: value === undefined || value === null ? 'declaration-missing' : 'declaration-malformed',
      message: 'review-lane-change-set/v1 must be an issue-author declaration',
    };
  }
  if (value.entries.length === 0) {
    return { status: 'author-revision-required', reason: 'declaration-malformed', message: 'declaration has no semantic entries' };
  }
  const entries: NormalizedReviewLaneEntry[] = [];
  for (const entry of value.entries) {
    if (!record(entry) || (entry.kind !== 'exact' && entry.kind !== 'family')
      || typeof entry.path !== 'string' || !Array.isArray(entry.behaviors)) {
      return { status: 'author-revision-required', reason: 'declaration-malformed', message: 'declaration entry is malformed' };
    }
    const candidate = normalizedPath(entry.path);
    if (!candidate.relative) {
      return { status: 'author-revision-required', reason: 'path-not-repository-relative', entry: entry.path, message: `path is not repository-relative: ${entry.path}` };
    }
    if (denied(candidate.path)) {
      return { status: 'author-revision-required', reason: 'declared-path-denied', entry: candidate.path, message: `path is denied: ${candidate.path}` };
    }
    if (!allowed(candidate.path)) {
      return { status: 'author-revision-required', reason: 'declared-path-outside-allowed-roots', entry: candidate.path, message: `path is outside allowed roots: ${candidate.path}` };
    }
    if (entry.behaviors.length === 0 || entry.behaviors.some((tag) => typeof tag !== 'string' || tag.trim().length === 0)) {
      return { status: 'author-revision-required', reason: 'declaration-malformed', entry: candidate.path, message: `behaviors are malformed: ${candidate.path}` };
    }
    entries.push({ kind: entry.kind, path: candidate.path, behaviors: uniqueSorted(entry.behaviors.map((tag) => tag.trim())) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous.path === current.path && previous.kind === current.kind
      && canonical(previous.behaviors) !== canonical(current.behaviors)) {
      return {
        status: 'author-revision-required',
        reason: 'declaration-contradictory',
        entry: current.path,
        message: `duplicate declaration has conflicting semantics: ${current.path}`,
      };
    }
  }
  const uniqueEntries: NormalizedReviewLaneEntry[] = [];
  for (const entry of entries) {
    const previous = uniqueEntries.at(-1);
    if (previous && previous.path === entry.path && previous.kind === entry.kind
      && canonical(previous.behaviors) === canonical(entry.behaviors)) {
      continue;
    }
    uniqueEntries.push(entry);
  }
  entries.length = 0;
  entries.push(...uniqueEntries);
  const blastRadius: ReviewLaneBlastRadius = entries.some((entry) => entry.kind === 'family')
    ? 'high-or-uncertain' : entries.length >= 7 ? 'high' : 'low';
  return { status: 'usable', identity: digest(canonical(entries)), entries, blastRadius };
}

interface SafeRule { pattern: string; required: readonly string[]; allowed: readonly string[]; }
const SAFE_RULES: readonly SafeRule[] = [
  { pattern: 'docs/tiering.md', required: ['tier-lane-orthogonality'], allowed: ['documentation-only', 'tier-lane-orthogonality'] },
  { pattern: 'docs/review-lanes.md', required: ['documentation-only'], allowed: ['documentation-only'] },
  { pattern: 'docs/declarations/**', required: ['scope-declaration-only'], allowed: ['scope-declaration-only'] },
  { pattern: '.claude/skills/create-issue-draft/**', required: ['author-declaration-validation', 'review-source-cardinality-only'], allowed: ['author-declaration-validation', 'review-source-cardinality-only'] },
  { pattern: '.claude/skills/discuss-with-gpt/**', required: ['review-source-cardinality-only'], allowed: ['review-source-cardinality-only'] },
  { pattern: '.cursor/skills/create-issue-draft/**', required: ['generated-parity-only', 'review-source-cardinality-only'], allowed: ['generated-parity-only', 'review-source-cardinality-only'] },
  { pattern: '.cursor/skills/discuss-with-gpt/**', required: ['generated-parity-only', 'review-source-cardinality-only'], allowed: ['generated-parity-only', 'review-source-cardinality-only'] },
  { pattern: 'scripts/lib/tier-gate-core.ts', required: ['tier-lane-orthogonality', 'routing-policy-epoch'], allowed: ['tier-lane-orthogonality', 'routing-policy-epoch'] },
  { pattern: 'scripts/lib/stage-completeness-core.ts', required: ['additive-existing-receipt-evidence', 'routing-policy-epoch'], allowed: ['additive-existing-receipt-evidence', 'material-verdict-normalization-only', 'review-source-cardinality-only', 'routing-policy-epoch'] },
  { pattern: 'scripts/stage-completeness-guard.ts', required: ['additive-existing-receipt-evidence', 'routing-policy-epoch'], allowed: ['additive-existing-receipt-evidence', 'routing-policy-epoch'] },
  { pattern: 'scripts/lib/create-issue-stage-record*.ts', required: ['additive-existing-receipt-evidence', 'routing-policy-epoch'], allowed: ['additive-existing-receipt-evidence', 'review-source-cardinality-only', 'routing-policy-epoch'] },
  { pattern: 'scripts/create-issue-stage-finalize.ts', required: ['additive-existing-receipt-evidence'], allowed: ['additive-existing-receipt-evidence', 'material-verdict-normalization-only', 'review-source-cardinality-only'] },
  { pattern: 'scripts/lib/review-lane-*.ts', required: ['pure-review-lane-selection'], allowed: ['pure-review-lane-selection', 'material-verdict-normalization-only', 'routing-policy-epoch'] },
  { pattern: 'scripts/lib/tier-gate-*.test.ts', required: ['test-only'], allowed: ['test-only'] },
  { pattern: 'scripts/stage-completeness-guard.test.ts', required: ['test-only'], allowed: ['test-only'] },
  { pattern: 'scripts/lib/create-issue-stage-record*.test.ts', required: ['test-only'], allowed: ['test-only'] },
  { pattern: 'scripts/lib/review-lane-*.test.ts', required: ['test-only'], allowed: ['test-only'] },
  { pattern: 'scripts/review-lane-*.test.ts', required: ['test-only'], allowed: ['test-only'] },
];

export function reviewLaneClassifierPolicyIdentity(): string {
  return digest(canonical({
    schema: REVIEW_LANE_CLASSIFIER_POLICY_VERSION,
    allowedRoots: ALLOWED_ROOTS,
    denylist: DENYLIST,
    safeBehaviorTags: [...SAFE_BEHAVIOR_TAGS],
    securityBehaviorTags: [...SECURITY_BEHAVIOR_TAGS],
    destructiveBehaviorTags: [...DESTRUCTIVE_BEHAVIOR_TAGS],
    securityTokens: [...SECURITY_TOKENS].sort(),
    destructiveTokens: [...DESTRUCTIVE_TOKENS].sort(),
    safeRules: SAFE_RULES,
  }));
}

function tokens(path: string): Set<string> {
  return new Set(path.toLowerCase().split(/[\/._-]+/).filter(Boolean));
}
function hasToken(actual: Set<string>, wanted: Set<string>): boolean {
  for (const token of wanted) if (actual.has(token)) return true;
  return false;
}
function classifyPath(entry: ReviewLaneAuthorEntry): ReviewLanePathClassification {
  const path = entry.path.replaceAll('\\', '/');
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  const file = parts.at(-1) ?? '';
  const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file;
  const securityByCompound = parts.includes('access-control') || stem === 'access-control';
  const securityByPath = lower.startsWith('scripts/chatgpt-browser-turn/')
    || lower === 'agent-orchestrator.yaml' || /^agent-orchestrator\..+\.yaml$/i.test(path);
  const securityByTag = entry.behaviors.some((tag) => SECURITY_BEHAVIOR_TAGS.includes(tag as typeof SECURITY_BEHAVIOR_TAGS[number]));
  const destructiveByTag = entry.behaviors.some((tag) => DESTRUCTIVE_BEHAVIOR_TAGS.includes(tag as typeof DESTRUCTIVE_BEHAVIOR_TAGS[number]));
  const pathTokens = tokens(path);
  if (lower.startsWith('.github/workflows/') || hasToken(pathTokens, DESTRUCTIVE_TOKENS) || destructiveByTag) {
    return { path, scopeClass: 'destructive', conservativeReasons: [], matchedRule: lower.startsWith('.github/workflows/') ? '.github/workflows/**' : null };
  }
  if (securityByCompound || securityByPath || hasToken(pathTokens, SECURITY_TOKENS) || securityByTag) {
    return { path, scopeClass: 'security-sensitive', conservativeReasons: [], matchedRule: securityByCompound ? 'access-control' : null };
  }
  const unknown = entry.behaviors.filter((tag) => !SAFE_BEHAVIOR_TAGS.includes(tag as typeof SAFE_BEHAVIOR_TAGS[number]));
  const rule = [...SAFE_RULES]
    .sort((left, right) => right.pattern.replaceAll('*', '').length - left.pattern.replaceAll('*', '').length)
    .find((candidate) => matches(path, candidate.pattern));
  if (!rule) {
    return {
      path,
      scopeClass: 'conservative-invalid',
      conservativeReasons: [path.includes('*') ? 'unmatched-path-family' : 'unmatched-path', ...(unknown.length ? ['unknown-behavior-tag' as const] : [])],
      matchedRule: null,
    };
  }
  if (unknown.length) return { path, scopeClass: 'conservative-invalid', conservativeReasons: ['unknown-behavior-tag'], matchedRule: rule.pattern };
  if (entry.behaviors.some((tag) => !rule.allowed.includes(tag))) {
    return { path, scopeClass: 'conservative-invalid', conservativeReasons: ['conflicting-author-tags'], matchedRule: rule.pattern };
  }
  if (rule.required.some((tag) => !entry.behaviors.includes(tag))) {
    return { path, scopeClass: 'conservative-invalid', conservativeReasons: ['missing-required-multipurpose-tag'], matchedRule: rule.pattern };
  }
  return { path, scopeClass: 'safe', conservativeReasons: [], matchedRule: rule.pattern };
}

export function classifyReviewLaneDeclaration(
  value: ReviewLaneAuthorDeclaration,
  policyIdentity = reviewLaneClassifierPolicyIdentity(),
): ReviewLaneClassification {
  const paths = value.entries.map(classifyPath);
  const ranks: Record<ReviewLaneScopeClass, number> = { safe: 0, 'conservative-invalid': 1, 'security-sensitive': 2, destructive: 3 };
  const scopeClass = paths.reduce<ReviewLaneScopeClass>((current, item) => ranks[item.scopeClass] > ranks[current] ? item.scopeClass : current, 'safe');
  const conservativeReasons = uniqueSorted(paths.flatMap((item) => item.conservativeReasons)) as ReviewLaneConservativeReason[];
  if (policyIdentity !== reviewLaneClassifierPolicyIdentity()) {
    return { schema: REVIEW_LANE_CLASSIFIER_POLICY_VERSION, policyStatus: 'unavailable', policyIdentity,
      unavailableReason: 'classifier-identity-mismatch', scopeClass, conservativeReasons, paths };
  }
  return { schema: REVIEW_LANE_CLASSIFIER_POLICY_VERSION, policyStatus: 'available', policyIdentity, scopeClass, conservativeReasons, paths };
}

export function buildReviewLaneRouting(input: UsableReviewLaneInput, classification: ReviewLaneClassification, sourceRevision: string, stageAttemptId: string): ReviewLaneRouting {
  if (classification.policyStatus !== 'available') throw new Error(`classifier unavailable: ${classification.unavailableReason ?? 'unknown'}`);
  const disputed = classification.scopeClass !== 'safe' || input.blastRadius !== 'low';
  const lane: ReviewLaneName = disputed ? 'disputed' : 'normal';
  const topology: ReviewLaneTopology = lane === 'disputed' && classification.scopeClass === 'safe'
    && (input.blastRadius === 'high' || input.blastRadius === 'high-or-uncertain') ? 'conditional-third/v1' : 'fixed/v1';
  const possibleSlots = lane === 'normal' ? ['01'] : ['01', '02', '03'];
  const initiallyActivatedSlots = topology === 'conditional-third/v1' ? ['01', '02'] : [...possibleSlots];
  const conditionalActivationRule = topology === 'conditional-third/v1' ? MATERIAL_VERDICT_CONFLICT_RULE : null;
  const cardinalityConfigIdentity = digest(canonical({ policyVersion: REVIEW_LANE_ROUTING_POLICY_VERSION, topology, possibleSlots, initiallyActivatedSlots, conditionalActivationRule }));
  return {
    schema: REVIEW_LANE_ROUTING_POLICY_VERSION, routingPolicyIdentity: REVIEW_LANE_ROUTING_POLICY_VERSION,
    lane, topology, policyVersion: REVIEW_LANE_ROUTING_POLICY_VERSION, reviewerCardinality: possibleSlots.length,
    cardinalityConfigIdentity, possibleSlots, initiallyActivatedSlots, conditionalActivationRule,
    sourceRevision, stageAttemptId, laneInputIdentity: input.identity, classifierIdentity: classification.policyIdentity,
  };
}

export function freezeConsistentReviewLaneBody(reads: readonly ReviewLaneBodyRead[]): ReviewLaneBodyFreezeResult {
  for (let index = 1; index < reads.length; index += 1) {
    const previous = reads[index - 1];
    const current = reads[index];
    if (previous.sourceRevision === current.sourceRevision && digest(previous.body) === digest(current.body)) {
      return { status: 'frozen', sourceRevision: current.sourceRevision, body: current.body, bodyIdentity: digest(current.body), reads: reads.slice(0, index + 1) };
    }
  }
  return { status: 'producer-unavailable', reason: 'consistent-revision-body-identity-unavailable', observed: [...reads], message: 'two consecutive reads did not expose the same revision and body identity' };
}

export function normalizeMaterialVerdict(evidence: MaterialVerdictEvidence): ReviewLaneSourceVerdict {
  if (evidence.terminalClassification === 'composer-refusal') return 'refused';
  if (['quota', 'fill-timeout', 'post-send-failure', 'output-conflict', 'incident'].includes(evidence.terminalClassification)) return 'blocked';
  if (evidence.terminalClassification !== 'complete' || evidence.captureVerified !== true || evidence.digestMatches !== true) return 'unparseable';
  const noFindings = evidence.verdictText?.trim() === 'NO_FINDINGS';
  const hasFindings = (evidence.materialFindingBlocks ?? evidence.rawFindingCount ?? 0) > 0;
  if (noFindings === hasFindings) return 'unparseable';
  return noFindings ? 'accept' : 'material-findings';
}
export function evaluateMaterialVerdictConflict(left: ReviewLaneSourceVerdict, right: ReviewLaneSourceVerdict): ReviewLaneConflictDecision {
  const valid = (value: ReviewLaneSourceVerdict): boolean => value === 'accept' || value === 'material-findings';
  if (!valid(left) || !valid(right)) return 'blocked-initial-source';
  return left === right ? 'no-conflict' : 'conflict-requires-slot-03';
}
export function settleReviewLane(routing: ReviewLaneRouting, verdicts: Readonly<Record<string, ReviewLaneSourceVerdict>>): ReviewLaneSettlement {
  const errors: string[] = [];
  const possible = new Set(routing.possibleSlots);
  for (const slot of Object.keys(verdicts)) if (!possible.has(slot)) errors.push(`slot ${slot} is outside possibleSlots`);
  const value = (slot: string): ReviewLaneSourceVerdict | undefined => verdicts[slot];
  let conflictDecision: ReviewLaneConflictDecision = 'no-conflict';
  let finalRequiredSlots = [...routing.initiallyActivatedSlots];
  let slotCensus = routing.possibleSlots.map((slot) => ({ slot, state: routing.initiallyActivatedSlots.includes(slot) ? 'activated' as const : 'not-activated' as const }));
  if (routing.topology === 'conditional-third/v1') {
    const first = value('01');
    const second = value('02');
    if (!first || !second) {
      conflictDecision = 'blocked-initial-source';
      errors.push('conditional-third requires terminal verdicts for slots 01 and 02');
    } else {
      conflictDecision = evaluateMaterialVerdictConflict(first, second);
      if (conflictDecision === 'conflict-requires-slot-03') {
        finalRequiredSlots = ['01', '02', '03'];
        slotCensus = slotCensus.map((row) => row.slot === '03' ? { slot: row.slot, state: 'activated' as const } : row);
      } else if (conflictDecision === 'blocked-initial-source') {
        errors.push('an initial source did not produce a usable material verdict');
      } else if (value('03') !== undefined) errors.push('slot 03 must not have an envelope when no conflict activates it');
    }
  }
  for (const slot of finalRequiredSlots) {
    const sourceVerdict = value(slot);
    if (sourceVerdict !== 'accept' && sourceVerdict !== 'material-findings') {
      errors.push(`required slot ${slot} did not settle to accept or material-findings`);
      conflictDecision = 'blocked-initial-source';
    }
  }
  return { ok: errors.length === 0, conflictDecision, finalRequiredSlots: errors.length === 0 ? finalRequiredSlots : [], slotCensus, errors };
}
