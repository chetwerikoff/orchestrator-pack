// @vitest-ci-lane heavy
// @vitest-pre-topology-seconds 1
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';
import {
  ACCEPTANCE_ARTIFACT_OUTPUT_NAMES,
  AUTHOR_DISPOSITIONS_SCHEMA,
  STAGE_EVIDENCE_SCHEMA,
  classifyReconciliationTransport,
  classifyZeroSendCausePolicy,
  inspectAcceptanceArtifacts,
  readEvidenceZeroSendTerminal,
  reconcileStageReadIsRetryable,
  locateGovernedAuthorDispositionBlock,
  parseCanonicalCaptureRevision,
  produceAcceptanceArtifacts,
  authorDispositionAdmission,
  bindPublishedCommentToSlot,
  reconcileCreateIssueStage,
  stageReceiptPayloadsMatchExceptDerivedChain,
} from './create-issue-stage-record-artifacts.ts';
import { parseConsumableStageReceipt } from './create-issue-stage-record-receipt.ts';
import { runFinalAcceptance } from './create-issue-final-acceptance.ts';
import { validateTerminalOneShotBodyBinding } from './create-issue-final-acceptance-contract.ts';
import {
  deriveReviewEpisodeId,
  deriveReviewEpisodeState,
  validateReviewEpisodeTopology,
  type CaptureIdentityV1,
  type ReviewEpisodeDerivationAuthorityV1,
  type ReviewerInvocationEnvelopeV1,
  type StageCompletenessReceiptV1,
  type VerifiedRelayEvidenceV1,
} from './stage-completeness-core.ts';
import { validateReviewLaneRecord } from './review-lane-record.ts';
import {
  existingPacedBoundedRetryAction,
  projectZeroSendManagerResult,
  type CreateIssueActionBinding,
} from './create-issue-next-action.ts';
import {
  buildReviewLaneRouting,
  classifyReviewLaneDeclaration,
  normalizeReviewLaneDeclaration,
  settleReviewLane,
  type ReviewLaneAuthorDeclaration,
} from './review-lane-routing.ts';

vi.mock('../finding-ledger-guard.mjs', () => ({
  checkFindingLedgerGuard: vi.fn(() => ({ ok: true, errors: [] })),
}));

const REPOSITORY = 'chetwerikoff/orchestrator-pack';
const ISSUE = 1192;
const TASK = `issue:${ISSUE}`;
const REVISION = 'r01';
const CONFIG = 'env:OPK_GPT_REVIEWER_CARDINALITY';
const COMMENT_ID = 5194504082;
const CYCLE_COMMENT_ID = COMMENT_ID + 900;
const PUBLISHER = 'chetwerikoff';
const CREATED_AT = '2026-08-07T04:00:00Z';
const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function canonicalVerdict(
  revision = REVISION,
  invocationId = 'invocation-001',
  issueNumber = ISSUE,
  invocationEchoLabel: 'INVOCATION_ID' | 'INVOCATION_ID_TO_ECHO' = 'INVOCATION_ID_TO_ECHO',
): string {
  return [
    `Read revision: #${issueNumber} ${revision}`,
    'review-economics-contract: v1',
    'VERDICT: CLEAN',
    'NO_FINDINGS',
    'SIMPLIFICATION_CLEAN',
    'FINDING_COUNT: 0',
    `${invocationEchoLabel}: ${invocationId}`,
    '',
  ].join('\n');
}

function canonicalFindingsVerdict(options: {
  revision?: string;
  invocationId?: string;
  findingCountLine?: string;
  includeFindingRows?: boolean;
} = {}): string {
  const lines = [
    `Read revision: #${ISSUE} ${options.revision ?? REVISION}`,
    'review-economics-contract: v1',
    'VERDICT: FINDINGS',
    'SIMPLIFICATION_CLEAN',
  ];
  if (options.findingCountLine !== undefined) lines.push(options.findingCountLine);
  lines.push(`INVOCATION_ID_TO_ECHO: ${options.invocationId ?? 'invocation-001'}`);
  if (options.includeFindingRows !== false) lines.push('id: finding-one', 'id: finding-two');
  lines.push('');
  return lines.join('\n');
}

const PUBLISHED_FINDINGS_WITHOUT_VERDICT = [
  'Read revision: #1777 r03',
  'INVOCATION_ID_TO_ECHO: d471e32c-b221-4086-a082-2c3daa48b985',
  'review-economics-contract: v1',
  '',
  'Architectural verdicts: single admission owner — keep; complete existing run-store input — keep; same-PR run as sufficient evidence by itself — cut; derived fields as diagnostics only — keep; A1-A15 executable matrix and full #1740 fixture — keep, with the missing prior-cycle negative; new registry/reconciliation/migration machinery — cut.',
  '',
  'id: arch-current-start-correlation',
  'type: spec',
  'severity: P1',
  'title: Run evidence is not bound to the current legal review start',
  'evidence: r03 requires a genuinely unconsumed current legal pack-review start to refuse, but A1-A15 has no case for a qualifying failed run from a prior review cycle. Current main creates a new cycleId on reset while retaining run-store history. PackReviewRunRecord has no cycleId/review-episode identity, and the current consumption projection/reviewRunEvidence accepts by prNumber plus status/disposition/stale. Full records expose head/timestamps, but r03 defines no authoritative existing relation that distinguishes the required #1740 earlier-head positive from an unrelated prior-cycle same-PR failure.',
  'recommendation: Add a production-shaped prior-cycle same-PR negative and specify the already-observable relation, if one is authoritative, that binds accepted run evidence to the current cycle/start. If no existing production field proves that relation, weaken the invariant or permit the minimum scoped evidence needed instead of admitting by PR number alone.',
  'persistent-machinery: no',
  '',
  'FINDING_COUNT: 1',
  'SIMPLIFICATION_CLEAN',
].join('\n');

function comment(
  body = canonicalVerdict(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const id = Number(overrides.id ?? COMMENT_ID);
  const issueNumber = Number(overrides.issueNumber ?? ISSUE);
  return {
    id,
    html_url: `https://github.com/${REPOSITORY}/issues/${issueNumber}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${issueNumber}`,
    body,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    author_association: 'OWNER',
    user: { login: PUBLISHER },
    ...overrides,
  };
}

function cycleComment(
  sourceRevision = REVISION,
  cycleId = 'cycle-1385',
  predecessorCycleId = 'none',
  id = CYCLE_COMMENT_ID,
): Record<string, unknown> {
  const eventKey = `${cycleId}-${sourceRevision}`;
  const payload = {
    schema: 'create-issue-review-cycle/v1',
    'event-key': eventKey,
    'cycle-id': cycleId,
    'predecessor-cycle-id': predecessorCycleId,
    'source-revision': sourceRevision,
    tier: 'T2',
    'public-actor': 'other-flow-manager',
  };
  return comment([
    `<!-- opk-create-issue-journal:create-issue-review-cycle/v1:${eventKey} -->`,
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n'), { id });
}

function issue1976PoisonJournalComment(): Record<string, unknown> {
  const cycleId = '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c';
  const payload = {
    schema: 'create-issue-review-cycle/v1',
    'event-key': cycleId,
    'cycle-id': cycleId,
    'predecessor-cycle-id': 'none',
    'source-revision': 'r01',
    tier: 'T2',
    'public-actor': 'flow-manager',
  };
  return comment([
    `<!-- opk-create-issue-journal:create-issue-review-cycle/v1:${cycleId} -->`,
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n'), {
    id: 5757262517,
    created_at: '2026-08-06T04:00:00Z',
    updated_at: '2026-08-06T04:00:00Z',
  });
}

function issue1976RecoverySuccessorComment(): Record<string, unknown> {
  const cycleId = 'cycle-1385';
  const payload = {
    schema: 'create-issue-review-cycle/v1',
    'event-key': cycleId,
    'cycle-id': cycleId,
    'predecessor-cycle-id': 'none',
    'source-revision': 'r01',
    tier: 'T2',
    'public-actor': 'cursor-flow-manager',
  };
  return comment([
    `<!-- opk-create-issue-journal:create-issue-review-cycle/v1:${cycleId} -->`,
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n'), {
    id: 5757262518,
    created_at: '2026-08-07T04:00:00Z',
    updated_at: '2026-08-07T04:00:00Z',
  });
}

function unrelatedMalformedJournalComment(): Record<string, unknown> {
  return comment([
    '<!-- opk-create-issue-journal:create-issue-review-cycle/v1:unrelated-malformed -->',
    '```json',
    JSON.stringify({
      schema: 'create-issue-review-cycle/v1',
      'event-key': 'different-event-key',
      'cycle-id': 'unrelated-malformed',
      'predecessor-cycle-id': 'none',
      'source-revision': 'r01',
      tier: 'T2',
      'public-actor': 'cursor-flow-manager',
    }, null, 2),
    '```',
  ].join('\n'), {
    id: 5757262519,
    created_at: '2026-08-08T04:00:00Z',
    updated_at: '2026-08-08T04:00:00Z',
  });
}

function finalAcceptanceIssueBody(revision = REVISION): string {
  return [
    `<!-- source-revision: ${revision} -->`,
    '# Fixture',
    '',
    '## Goal',
    'Final acceptance fixture.',
    '',
    '```behavior-kind',
    'record-only',
    '```',
    '',
    '```complexity-tier',
    'tier: T2',
    '```',
    '',
    '```denylist',
    'vendor/**',
    'packages/core/**',
    '```',
    '',
    '```allowed-roots',
    'scripts/lib/create-issue-final-acceptance.ts',
    '```',
    '',
    '## Acceptance criteria',
    '1. Final acceptance remains deterministic.',
    '',
    '## Verification',
    'Run the focused regression.',
    '',
    '```contract-evidence',
    'none',
    '```',
    '',
  ].join('\n');
}

interface TransportOptions {
  principal?: string | null;
  census?: Array<Record<string, unknown>>;
  censusFailure?: boolean;
  reread?: Record<string, unknown> | null;
  rereadFailure?: boolean;
  secondPageFailure?: boolean;
  beforeReread?: () => void;
  cycleComments?: Array<Record<string, unknown>>;
  issueBodies?: string[];
  issueNumber?: number;
  persistCreatedIssueComments?: boolean;
  issueLabels?: string[];
}

function transport(options: TransportOptions = {}) {
  const issueNumber = options.issueNumber ?? ISSUE;
  const principal = options.principal === undefined ? PUBLISHER : options.principal;
  const suppliedCensus = options.census ?? [comment()];
  const observedRevision = suppliedCensus.flatMap((item) => {
    const match = typeof item.body === 'string' ? /^Read revision: #[1-9][0-9]* (r[0-9]+)$/m.exec(item.body) : null;
    return match?.[1] ? [match[1]] : [];
  })[0] ?? REVISION;
  const journalComments = options.cycleComments ?? [cycleComment(observedRevision)];
  const census = [...suppliedCensus, ...journalComments];
  let issueReadCount = 0;
  const createdIssueComments: string[] = [];
  const issueLabels = [...(options.issueLabels ?? [])];
  const runGh = vi.fn((argv: string[]) => {
    if (argv[2] === 'user') {
      if (principal === null) return { exitCode: 1, stdout: '', stderr: 'principal unavailable' };
      return { exitCode: 0, stdout: `${principal}\n`, stderr: '' };
    }
    const target = argv[2] ?? '';
    if (target.startsWith(`repos/${REPOSITORY}/labels/`)) {
      return { exitCode: 0, stdout: '{}', stderr: '' };
    }
    if (target === `repos/${REPOSITORY}/issues/${issueNumber}` && argv.includes('--jq')) {
      const bodies = options.issueBodies ?? [finalAcceptanceIssueBody(observedRevision)];
      const body = bodies[Math.min(issueReadCount, bodies.length - 1)] ?? '';
      issueReadCount += 1;
      return { exitCode: 0, stdout: JSON.stringify({ title: 'fixture issue', body, labels: issueLabels }), stderr: '' };
    }
    if (target === `repos/${REPOSITORY}/issues/${issueNumber}` && argv.includes('-X') && argv.includes('PATCH')) {
      const labels = argv
        .filter((value) => value.startsWith('labels[]='))
        .map((value) => value.slice('labels[]='.length));
      issueLabels.splice(0, issueLabels.length, ...labels);
      return { exitCode: 0, stdout: '{}', stderr: '' };
    }
    if (target === `repos/${REPOSITORY}/issues/${issueNumber}/comments` && argv.includes('-f')) {
      const body = argv.find((value) => value.startsWith('body='))?.slice('body='.length) ?? '';
      createdIssueComments.push(body);
      const id = COMMENT_ID + 2000 + createdIssueComments.length;
      if (options.persistCreatedIssueComments) {
        const createdAt = `2026-09-21T00:${String(createdIssueComments.length).padStart(2, '0')}:00Z`;
        census.push(comment(body, {
          id,
          issueNumber,
          created_at: createdAt,
          updated_at: createdAt,
        }));
      }
      return { exitCode: 0, stdout: JSON.stringify({ id }), stderr: '' };
    }
    if (target === `repos/${REPOSITORY}`) {
      return { exitCode: 0, stdout: `${PUBLISHER}\n`, stderr: '' };
    }
    if (target.includes(`/issues/${issueNumber}/comments?per_page=100&page=1`)) {
      if (options.censusFailure) return { exitCode: 1, stdout: '', stderr: 'census unavailable' };
      return { exitCode: 0, stdout: JSON.stringify(census), stderr: '' };
    }
    if (target.includes(`/issues/${issueNumber}/comments?per_page=100&page=2`)) {
      if (options.secondPageFailure) return { exitCode: 1, stdout: '', stderr: 'page 2 unavailable' };
      return { exitCode: 0, stdout: '[]', stderr: '' };
    }
    if (target.includes('/issues/comments/')) {
      options.beforeReread?.();
      if (options.rereadFailure) return { exitCode: 1, stdout: '', stderr: 'reread unavailable' };
      const id = Number(target.split('/').at(-1));
      const fallback = census.find((item) => Number(item.id) === id) ?? comment(undefined, { id });
      return { exitCode: 0, stdout: JSON.stringify(options.reread ?? fallback), stderr: '' };
    }
    throw new Error(`unexpected gh call: ${argv.join(' ')}`);
  });
  return { runGh, createdIssueComments, issueLabels };
}

function writeGovernedAuthorReply(
  path: string,
  input: {
    sourceRevision: string;
    predecessorStage: string | null;
    findings?: unknown[];
    m4?: unknown[];
  },
): void {
  writeFileSync(path, [
    'Governed author output:',
    '',
    '```create-issue-author-dispositions/v1',
    JSON.stringify({
      schema: AUTHOR_DISPOSITIONS_SCHEMA,
      sourceRevision: input.sourceRevision,
      predecessorStage: input.predecessorStage,
      findings: input.findings ?? [],
      m4: { inventory: input.m4 ?? [] },
    }),
    '```',
    '',
  ].join('\n'));
}

function fixture(input: {
  intakeRevision?: string;
  sourceRevision?: string;
  transportClassification?: 'complete' | 'incident';
  reviewerSource?: string | null;
  turnResultState?: 'ok' | 'recovery_required';
  turnResultScope?: unknown;
  turnResultCause?: string;
  turnResultConfiguredProfileKey?: unknown;
  turnResultSendCount?: unknown;
  omitTurnResultSendCount?: boolean;
  withTurnResult?: boolean;
  withCapture?: boolean;
  captureText?: string;
  invocationEchoLabel?: 'INVOCATION_ID' | 'INVOCATION_ID_TO_ECHO';
  stageInvocationId?: string;
  turnResultInvocationId?: string;
  terminalResultIdentity?: string;
  issueNumber?: number;
} = {}) {
  const issueNumber = input.issueNumber ?? ISSUE;
  const taskIdentity = `issue:${issueNumber}`;
  const intakeRevision = input.intakeRevision ?? REVISION;
  const sourceRevision = input.sourceRevision ?? intakeRevision;
  const transportClassification = input.transportClassification ?? 'incident';
  const turnResultState = input.turnResultState ?? (transportClassification === 'complete' ? 'ok' : 'recovery_required');
  const turnResultScope = input.turnResultScope === undefined
    ? (turnResultState === 'ok' ? 'none' : 'conversation')
    : input.turnResultScope;
  const turnResultCause = input.turnResultCause ?? (transportClassification === 'complete' ? 'ok' : 'direct_publication_owned_parent_missing');
  const turnResultConfiguredProfileKey = input.turnResultConfiguredProfileKey === undefined
    ? 'fixture-profile'
    : input.turnResultConfiguredProfileKey;
  const turnResultSendCount = input.turnResultSendCount === undefined ? 1 : input.turnResultSendCount;
  const reviewerSource = input.reviewerSource === undefined
    ? 'browser-gpt#capture=final-node/v1'
    : input.reviewerSource;
  const invocationEchoLabel = input.invocationEchoLabel ?? 'INVOCATION_ID_TO_ECHO';
  const stageInvocationId = input.stageInvocationId ?? 'invocation-001';
  const turnResultInvocationId = input.turnResultInvocationId ?? 'invocation-001';
  const dir = mkdtempSync(join(tmpdir(), 'opk-1385-artifacts-'));
  tempDirs.push(dir);
  const intakePath = join(dir, 'tier-intake.json');
  const evidencePath = join(dir, 'attempt-001.json');
  const authorPath = join(dir, 'author-dispositions.json');
  const authorReplyPath = join(dir, 'round-01-author-reply.md');
  const capturePath = join(dir, 'pass-02-architectural.capture.txt');
  const reviewEvidencePath = join(dir, 'attempt-000.json');
  const turnResultPath = join(dir, 'turn-result-001.json');
  const outputDir = join(dir, 'output');
  const episode = deriveReviewEpisodeId(taskIdentity, intakeRevision);
  const body = input.captureText ?? canonicalVerdict(sourceRevision, stageInvocationId, issueNumber, invocationEchoLabel);

  writeFileSync(intakePath, JSON.stringify({
    schema: 'tier-intake/v1',
    producer: 'flow-manager',
    taskIdentity,
    kind: 'fresh',
    priorTier: 'T2',
    firstRevision: intakeRevision,
  }));
  writeGovernedAuthorReply(authorReplyPath, {
    sourceRevision,
    predecessorStage: input.phase === 'pre-lens' ? 'architectural-review' : 'architectural',
  });
  const reviewComments = Array.from({ length: 3 }, (_, index) => {
    const invocationId = `architectural-review-invocation-${String(index + 1).padStart(2, '0')}`;
    return comment(canonicalVerdict(sourceRevision, invocationId, issueNumber, invocationEchoLabel), { id: COMMENT_ID + 100 + index, issueNumber });
  });
  const reviewInvocations = reviewComments.map((reviewComment, index) => {
    const ordinal = index + 1;
    const invocationId = `architectural-review-invocation-${String(ordinal).padStart(2, '0')}`;
    const reviewCapturePath = join(dir, `pass-01-architectural-review-${String(ordinal).padStart(2, '0')}.capture.txt`);
    const reviewTurnResultPath = join(dir, `turn-result-review-${String(ordinal).padStart(2, '0')}.json`);
    writeFileSync(reviewCapturePath, String(reviewComment.body));
    const turnResult = { schema: 'turn-result/v1', state: 'ok', scope: 'none', cause: 'ok', invocation_id: invocationId, configured_profile_key: 'fixture-profile', send_count: 1, output: { byte_length: Buffer.byteLength(String(reviewComment.body)), sha256: createHash('sha256').update(String(reviewComment.body)).digest('hex') } };
    const turnResultText = JSON.stringify(turnResult);
    writeFileSync(reviewTurnResultPath, turnResultText);
    const terminalResultIdentity = `sha256:${createHash('sha256').update(turnResultText).digest('hex')}:${basename(reviewTurnResultPath)}`;
    return { schema: 'reviewer-invocation-envelope/v1', reviewEpisodeId: episode, stageAttemptId: 'architectural-review-attempt', policyVersion: 'triple-source/v1', reviewerCardinality: 3, cardinalityConfigIdentity: CONFIG, stage: 'architectural-review', sourceRevision, invocationId, terminalResultIdentity, reviewerSource: `browser-gpt-${String(ordinal).padStart(2, '0')}#capture=final-node/v1`, reviewerSlot: String(ordinal).padStart(2, '0'), reviewerOrdinal: ordinal, attemptOrdinal: 1, retryAttempt: false, terminal: true, terminalClassification: 'complete', sendCount: 1, retryClass: 'none', revisionCheck: 'matched', capacityOutcome: 'admitted', capacityWaitMs: 0, capturePath: reviewCapturePath, turnResultPath: reviewTurnResultPath };
  });
  writeFileSync(reviewEvidencePath, JSON.stringify({ schema: STAGE_EVIDENCE_SCHEMA, tier: 'T2', stage: 'architectural-review', stageAttemptId: 'architectural-review-attempt', stageSequence: 1, cycleId: 'cycle-1385', cycleBinding: { cycleId: 'cycle-1385', sourceRevision, boundBeforeLaunch: true }, policyVersion: 'triple-source/v1', reviewerCardinality: 3, cardinalityConfigIdentity: CONFIG, sourceRevision, outcome: 'complete', revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' }, settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true }, invocations: reviewInvocations }));
  if (input.withCapture) writeFileSync(capturePath, body);

  const invocation: Record<string, unknown> = {
    schema: 'reviewer-invocation-envelope/v1',
    reviewEpisodeId: episode,
    stageAttemptId: 'attempt-001',
    policyVersion: 'single-source/v1',
    reviewerCardinality: 1,
    cardinalityConfigIdentity: CONFIG,
    stage: 'architectural',
    sourceRevision,
    invocationId: stageInvocationId,
    ...(reviewerSource === null ? {} : { reviewerSource }),
    reviewerSlot: '01',
    reviewerOrdinal: 1,
    attemptOrdinal: 1,
    retryAttempt: false,
    terminal: true,
    terminalClassification: transportClassification,
    sendCount: 1,
    retryClass: transportClassification === 'complete' ? 'none' : 'retry-forbidden',
    revisionCheck: 'matched',
    capacityOutcome: 'admitted',
    capacityWaitMs: 0,
    ...(input.withCapture ? { capturePath } : {}),
  };

  if (input.withTurnResult) {
    const turnResult = {
      schema: 'turn-result/v1',
      state: turnResultState,
      scope: turnResultScope,
      cause: turnResultCause,
      invocation_id: turnResultInvocationId,
      configured_profile_key: turnResultConfiguredProfileKey,
      ...(input.omitTurnResultSendCount ? {} : { send_count: turnResultSendCount }),
      ...(turnResultState === 'ok'
        ? { output: { byte_length: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') } }
        : {}),
    };
    const turnResultText = JSON.stringify(turnResult);
    writeFileSync(turnResultPath, turnResultText);
    invocation.turnResultPath = turnResultPath;
    invocation.terminalResultIdentity = input.terminalResultIdentity ?? `sha256:${createHash('sha256').update(turnResultText).digest('hex')}:${basename(turnResultPath)}`;
  }

  const evidence = {
    schema: STAGE_EVIDENCE_SCHEMA,
    tier: 'T2',
    stage: 'architectural',
    stageAttemptId: 'attempt-001',
    stageSequence: 2,
    cycleId: 'cycle-1385',
    cycleBinding: { cycleId: 'cycle-1385', sourceRevision, boundBeforeLaunch: true },
    policyVersion: 'single-source/v1',
    reviewerCardinality: 1,
    cardinalityConfigIdentity: CONFIG,
    sourceRevision,
    outcome: transportClassification === 'complete' ? 'complete' : 'incident',
    revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
    settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
    invocations: [invocation],
  };
  writeFileSync(evidencePath, JSON.stringify(evidence));
  return { dir, intakePath, evidencePath, reviewEvidencePath, authorPath, authorReplyPath, capturePath, turnResultPath, outputDir, evidence, invocation, body, episode, reviewComments, issueNumber, phase: input.phase ?? 'final-acceptance', stageEvidencePaths: [reviewEvidencePath, evidencePath] };
}

function competitivePreLensFixture() {
  const input = fixture({ phase: 'pre-lens' });
  const originalCompetitiveEvidence = JSON.parse(readFileSync(input.reviewEvidencePath, 'utf8')) as Record<string, any>;
  const architecturalEvidencePath = join(input.dir, 'attempt-002.json');
  const architecturalEvidence = JSON.parse(JSON.stringify(originalCompetitiveEvidence)) as Record<string, any>;
  architecturalEvidence.stage = 'architectural-review';
  architecturalEvidence.stageAttemptId = 'architectural-review-attempt';
  architecturalEvidence.stageSequence = 2;
  architecturalEvidence.tier = 'T3';
  for (const invocation of architecturalEvidence.invocations ?? []) {
    invocation.stage = 'architectural-review';
    invocation.stageAttemptId = 'architectural-review-attempt';
  }

  writeFileSync(input.intakePath, JSON.stringify({
    schema: 'tier-intake/v1',
    producer: 'flow-manager',
    taskIdentity: `issue:${input.issueNumber}`,
    kind: 'fresh',
    priorTier: 'T3',
    firstRevision: REVISION,
    competitiveDecision: 'required',
    competitiveRationale: 'fixture freezes the canonical T3 competitive path',
  }));

  const competitiveEvidence = JSON.parse(JSON.stringify(originalCompetitiveEvidence)) as Record<string, any>;
  competitiveEvidence.stage = 'competitive';
  competitiveEvidence.stageAttemptId = 'competitive-attempt';
  competitiveEvidence.stageSequence = 1;
  competitiveEvidence.tier = 'T3';
  for (const [index, invocation] of (competitiveEvidence.invocations ?? []).entries()) {
    const ordinal = String(index + 1).padStart(2, '0');
    const originalInvocationId = invocation.invocationId as string;
    const oldCapturePath = invocation.capturePath as string;
    const oldCaptureText = readFileSync(oldCapturePath, 'utf8');
    const competitiveCapturePath = join(input.dir, `pass-01-competitive-${ordinal}.capture.txt`);
    const architecturalCapturePath = join(input.dir, `pass-02-architectural-review-${ordinal}.capture.txt`);
    writeFileSync(competitiveCapturePath, oldCaptureText);
    const architecturalInvocationId = `architectural-review-followup-${ordinal}`;
    writeFileSync(architecturalCapturePath, oldCaptureText.replace(originalInvocationId, architecturalInvocationId));
    rmSync(oldCapturePath, { force: true });

    invocation.stage = 'competitive';
    invocation.stageAttemptId = 'competitive-attempt';
    delete invocation.terminalResultIdentity;
    const originalTurnResultPath = invocation.turnResultPath as string;
    const originalTurnResult = JSON.parse(readFileSync(originalTurnResultPath, 'utf8')) as Record<string, any>;
    const competitiveTurnResultPath = join(input.dir, `turn-result-competitive-${ordinal}.json`);
    originalTurnResult.invocation_id = originalInvocationId;
    originalTurnResult.output = {
      byte_length: Buffer.byteLength(oldCaptureText),
      sha256: createHash('sha256').update(oldCaptureText).digest('hex'),
    };
    writeFileSync(competitiveTurnResultPath, JSON.stringify(originalTurnResult));
    invocation.capturePath = competitiveCapturePath;
    invocation.turnResultPath = competitiveTurnResultPath;

    const architecturalInvocation = architecturalEvidence.invocations[index];
    architecturalInvocation.invocationId = architecturalInvocationId;
    architecturalInvocation.stage = 'architectural-review';
    architecturalInvocation.stageAttemptId = 'architectural-review-attempt';
    delete architecturalInvocation.terminalResultIdentity;
    const architecturalTurnResult = JSON.parse(readFileSync(originalTurnResultPath, 'utf8')) as Record<string, any>;
    const architecturalTurnResultPath = join(input.dir, `turn-result-architectural-review-${ordinal}.json`);
    const architecturalText = readFileSync(architecturalCapturePath, 'utf8');
    architecturalTurnResult.invocation_id = architecturalInvocationId;
    architecturalTurnResult.output = {
      byte_length: Buffer.byteLength(architecturalText),
      sha256: createHash('sha256').update(architecturalText).digest('hex'),
    };
    writeFileSync(architecturalTurnResultPath, JSON.stringify(architecturalTurnResult));
    architecturalInvocation.capturePath = architecturalCapturePath;
    architecturalInvocation.turnResultPath = architecturalTurnResultPath;
  }
  input.reviewComments.push(...(architecturalEvidence.invocations ?? []).map((invocation: Record<string, any>, index: number) => (
    comment(readFileSync(invocation.capturePath, 'utf8'), { id: COMMENT_ID + 200 + index })
  )));
  writeFileSync(input.reviewEvidencePath, JSON.stringify(competitiveEvidence));
  rmSync(input.evidencePath, { force: true });
  input.stageEvidencePaths = [input.reviewEvidencePath];
  writeGovernedAuthorReply(input.authorReplyPath, {
    sourceRevision: String(competitiveEvidence.sourceRevision),
    predecessorStage: 'competitive',
  });
  return { ...input, architecturalEvidence, architecturalEvidencePath };
}

function produce(
  input: ReturnType<typeof fixture>,
  source = transport({ census: [...input.reviewComments, comment(input.body, { issueNumber: input.issueNumber })], issueNumber: input.issueNumber }),
  operatorAdjudication?: Record<string, unknown>,
) {
  return produceAcceptanceArtifacts({
    reviewDir: input.dir,
    outputDir: input.outputDir,
    tierIntakePath: input.intakePath,
    stageEvidencePaths: input.stageEvidencePaths,
    authorDispositionsPath: input.authorPath,
    phase: input.phase,
    artifactSourceTransport: source,
    ...(operatorAdjudication ? { operatorAdjudication: operatorAdjudication as never } : {}),
  });
}

function produceStageTime(
  input: ReturnType<typeof fixture>,
  source = transport({ census: [...input.reviewComments, comment(input.body)] }),
) {
  return produceAcceptanceArtifacts({
    reviewDir: input.dir,
    outputDir: input.outputDir,
    tierIntakePath: input.intakePath,
    stageEvidencePaths: [input.reviewEvidencePath, input.evidencePath],
    authorDispositionsPath: input.authorPath,
    phase: 'stage-time',
    artifactSourceTransport: source,
  });
}

function validOperatorHint(body: string, revision = REVISION, commentId = COMMENT_ID) {
  return {
    issueNumber: ISSUE,
    sourceRevision: revision,
    verdictUrl: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${commentId}`,
    verdictSha256: createHash('sha256').update(body).digest('hex'),
    verdictByteLength: Buffer.byteLength(body),
    verdictFindingCount: 0,
    reason: 'narrow to the already-published canonical verdict',
  };
}

function inspect(input: ReturnType<typeof fixture>) {
  return inspectAcceptanceArtifacts({
    reviewDir: input.dir,
    outputDir: input.outputDir,
    tierIntakePath: input.intakePath,
    stageEvidencePaths: [input.reviewEvidencePath, input.evidencePath],
    authorDispositionsPath: input.authorPath,
    phase: 'final-acceptance',
  });
}

function inspectStageTime(input: ReturnType<typeof fixture>) {
  return inspectAcceptanceArtifacts({
    reviewDir: input.dir,
    outputDir: input.outputDir,
    tierIntakePath: input.intakePath,
    stageEvidencePaths: [input.reviewEvidencePath, input.evidencePath],
    authorDispositionsPath: input.authorPath,
    phase: 'stage-time',
  });
}

function historicalWitnessPartial(receipt: StageCompletenessReceiptV1): {
  receipt: StageCompletenessReceiptV1;
  droppedCaptureIdentity: string;
} {
  const partial = structuredClone(receipt);
  const missingInvocation = partial.invocations?.[2];
  if (!missingInvocation?.capture) throw new Error('fixture requires a third credentialed invocation capture');
  const droppedCaptureIdentity = missingInvocation.capture.captureIdentity;
  missingInvocation.terminalClassification = 'incident';
  missingInvocation.retryClass = 'retry-forbidden';
  delete missingInvocation.capture;
  delete missingInvocation.artifactAuthority;
  partial.outcome = 'partial';
  partial.partialMissingSources = [{
    reviewerSlot: '03',
    invocationId: 'historical-other-invocation',
    evidenceIdentity: 'historical-other-result',
    reason: 'post-send result unavailable',
  }];
  partial.credentialingCaptures = partial.credentialingCaptures.filter((capture) => capture.captureIdentity !== droppedCaptureIdentity);
  partial.relayEligibleCaptures = partial.relayEligibleCaptures.filter((capture) => capture.captureIdentity !== droppedCaptureIdentity);
  return { receipt: partial, droppedCaptureIdentity };
}

describe('T3 pre-lens stage topology', () => {
  it('produces competitive-only receipts and requires architectural review once its evidence appears', () => {
    const input = competitivePreLensFixture();
    const competitiveOnly = produce(input);
    expect(competitiveOnly.ok, competitiveOnly.errors.join('\n')).toBe(true);
    expect(competitiveOnly.files).toContain('stage-completeness-receipt-competitive-attempt.json');
    expect(competitiveOnly.files).not.toContain('stage-completeness-receipt-architectural-review-attempt.json');

    writeFileSync(input.architecturalEvidencePath, JSON.stringify(input.architecturalEvidence));
    input.stageEvidencePaths = [input.reviewEvidencePath, input.architecturalEvidencePath];
    writeGovernedAuthorReply(input.authorReplyPath, {
      sourceRevision: String(input.architecturalEvidence.sourceRevision),
      predecessorStage: 'architectural-review',
    });
    const bothStages = produce(input);
    expect(bothStages.ok, bothStages.errors.join('\n')).toBe(true);
    expect(bothStages.files).toContain('stage-completeness-receipt-competitive-attempt.json');
    expect(bothStages.files).toContain('stage-completeness-receipt-architectural-review-attempt.json');
  });
});

describe('Issue #1385 authoritative GitHub artifact acceptance', () => {
  it('accepts an omitted invocations field when the persisted value is empty', () => {
    const receipt = (invocations?: unknown) => ({
      schema: 'stage-completeness-receipt/v1',
      stable: 'same',
      ...(invocations === undefined ? {} : { invocations }),
    });
    const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect(stageReceiptPayloadsMatchExceptDerivedChain(
      bytes(receipt([])),
      bytes(receipt()),
    )).toBe(true);
  });

  it('continues rejecting non-empty invocation payload differences and tampered reviewerSource', () => {
    const invocation = {
      schema: 'reviewer-invocation-envelope/v1',
      terminal: true,
      reviewerSource: 'original-source',
    };
    const receipt = (invocations: unknown) => ({ schema: 'stage-completeness-receipt/v1', invocations });
    const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect(stageReceiptPayloadsMatchExceptDerivedChain(
      bytes(receipt([invocation])),
      bytes(receipt([{ ...invocation, terminal: false }])),
    )).toBe(false);
    expect(stageReceiptPayloadsMatchExceptDerivedChain(
      bytes(receipt([invocation])),
      bytes(receipt([{ ...invocation, reviewerSource: 'tampered-source' }])),
    )).toBe(false);
  });

  it('accepts receipt-ok/artifact-ok after stable Issue read, principal lookup, census, and reread', () => {
    const input = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    const source = transport({ census: [...input.reviewComments, comment(input.body)] });
    const result = produce(input, source);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const targets = source.runGh.mock.calls.map((call) => call[0][2]);
    expect(targets.filter((target) => target === `repos/${REPOSITORY}/issues/${ISSUE}`)).toHaveLength(2);
    expect(targets).toContain('user');
    expect(targets).toContain(`repos/${REPOSITORY}/issues/${ISSUE}/comments?per_page=100&page=1`);
    expect(targets).toContain(`repos/${REPOSITORY}/issues/comments/${COMMENT_ID}`);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.invocations[0]).toMatchObject({
      terminalClassification: 'complete',
      sendCount: 1,
      artifactAuthority: {
        kind: 'authoritative-github-artifact',
        repositoryFullName: REPOSITORY,
        issueNumber: ISSUE,
        commentId: COMMENT_ID,
        publisherLogin: PUBLISHER,
      },
    });
  });

  it('restores every pre-existing acceptance artifact after each injected install failure', () => {
    const input = fixture({
      transportClassification: 'complete',
      withTurnResult: true,
      withCapture: true,
    });
    const initial = produce(input);
    expect(initial.ok, initial.errors.join('\n')).toBe(true);

    const receiptNames = readdirSync(input.outputDir)
      .filter((name) => name.startsWith('stage-completeness-receipt-'))
      .sort();
    const receiptBytes = new Map(receiptNames.map((name) => [name, readFileSync(join(input.outputDir, name))]));
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const targetNames = [...receiptNames, ...ACCEPTANCE_ARTIFACT_OUTPUT_NAMES].sort();

    for (let failAfter = 1; failAfter <= ACCEPTANCE_ARTIFACT_OUTPUT_NAMES.length; failAfter += 1) {
      rmSync(input.outputDir, { recursive: true, force: true });
      mkdirSync(input.outputDir, { recursive: true });
      for (const [name, bytes] of receiptBytes) writeFileSync(join(input.outputDir, name), bytes);
      for (const name of ACCEPTANCE_ARTIFACT_OUTPUT_NAMES) {
        writeFileSync(join(input.outputDir, name), `pre-attempt-${failAfter}-${name}\n`);
      }
      const before = new Map(targetNames.map((name) => [name, digest(join(input.outputDir, name))]));
      let observedInstallIndex = 0;
      const source = transport({ census: [...input.reviewComments, comment(input.body)] });
      const result = produceAcceptanceArtifacts({
        reviewDir: input.dir,
        outputDir: input.outputDir,
        tierIntakePath: input.intakePath,
        stageEvidencePaths: [input.reviewEvidencePath, input.evidencePath],
        authorDispositionsPath: input.authorPath,
        phase: 'final-acceptance',
        artifactSourceTransport: source,
        publicationHooks: {
          afterInstall: ({ installIndex }) => {
            observedInstallIndex = installIndex;
            if (installIndex === failAfter) throw new Error(`injected install failure ${installIndex}`);
          },
        },
      });

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain(`injected install failure ${failAfter}`);
      expect(observedInstallIndex).toBe(failAfter);
      expect(readdirSync(input.outputDir).sort()).toEqual(targetNames);
      for (const name of targetNames) {
        expect(digest(join(input.outputDir, name))).toBe(before.get(name));
      }
      expect(readdirSync(input.dir).filter((name) => name.startsWith('.output.tmp-'))).toEqual([]);
    }
  });

  it('republishes identical bytes without new invocations and rejects conflicting published receipts', () => {
    const input = fixture({
      transportClassification: 'complete',
      withTurnResult: true,
      withCapture: true,
    });
    const first = produce(input);
    expect(first.ok, first.errors.join('\n')).toBe(true);

    const publishedNames = readdirSync(input.outputDir).sort();
    const publishedBytes = new Map(
      publishedNames.map((name) => [name, readFileSync(join(input.outputDir, name))]),
    );
    const firstReceipt = JSON.parse(
      readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'),
    );

    const rerun = produce(input, transport({ census: [...input.reviewComments, comment(input.body)] }));
    expect(rerun.ok, rerun.errors.join('\n')).toBe(true);
    expect(readdirSync(input.outputDir).sort()).toEqual(publishedNames);
    for (const name of publishedNames) {
      expect(readFileSync(join(input.outputDir, name))).toEqual(publishedBytes.get(name));
    }
    const rerunReceipt = JSON.parse(
      readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'),
    );
    expect(rerunReceipt.invocations).toEqual(firstReceipt.invocations);
    expect(rerunReceipt.invocations).toHaveLength(1);

    const receiptPath = join(input.outputDir, 'stage-completeness-receipt-attempt-001.json');
    writeFileSync(receiptPath, JSON.stringify({ ...firstReceipt, conflicting: true }) + '\n');
    const conflictingNames = readdirSync(input.outputDir).sort();
    const conflictingBytes = new Map(
      conflictingNames.map((name) => [name, readFileSync(join(input.outputDir, name))]),
    );
    const conflict = produce(input, transport({ census: [...input.reviewComments, comment(input.body)] }));
    expect(conflict.ok).toBe(false);
    expect(conflict.errors.join('\n')).toContain('conflicting immutable stage receipt target');
    expect(readdirSync(input.outputDir).sort()).toEqual(conflictingNames);
    for (const name of conflictingNames) {
      expect(readFileSync(join(input.outputDir, name))).toEqual(conflictingBytes.get(name));
    }
    expect(readdirSync(input.dir).filter((name) => name.startsWith('.output.tmp-'))).toEqual([]);
  });

  it('refreshes derived receipt chain fields without treating the target as conflicting', () => {
    const input = fixture({
      transportClassification: 'complete',
      withTurnResult: true,
      withCapture: true,
    });
    const initial = produce(input);
    expect(initial.ok, initial.errors.join('\n')).toBe(true);
    const captureBytes = readFileSync(input.capturePath);
    const receiptPath = join(input.outputDir, 'stage-completeness-receipt-attempt-001.json');
    const initialReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const priorReceiptId = `${input.episode}:stage-receipt:0001`;
    writeFileSync(receiptPath, JSON.stringify({
      ...initialReceipt,
      stageReceiptId: priorReceiptId,
      previousStageReceiptId: null,
      receiptCensus: [priorReceiptId],
      stageSequence: 1,
    }) + '\n');

    const refreshed = produce(input, transport({ census: [...input.reviewComments, comment(input.body)] }));

    expect(refreshed.ok, refreshed.errors.join('\n')).toBe(true);
    const refreshedReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(refreshedReceipt.stageReceiptId).toBe(initialReceipt.stageReceiptId);
    expect(refreshedReceipt.stageSequence).toBe(initialReceipt.stageSequence);
    expect(refreshedReceipt.previousStageReceiptId).toBe(initialReceipt.previousStageReceiptId);
    expect(refreshedReceipt.receiptCensus).toEqual(initialReceipt.receiptCensus);
    expect(readFileSync(input.capturePath)).toEqual(captureBytes);
  });

  it('refreshes optional reviewer source metadata on a legacy receipt', () => {
    const input = fixture({
      transportClassification: 'complete',
      withTurnResult: true,
      withCapture: true,
    });
    const initial = produce(input);
    expect(initial.ok, initial.errors.join('\n')).toBe(true);
    const receiptPath = join(input.outputDir, 'stage-completeness-receipt-attempt-001.json');
    const initialReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    for (const invocation of initialReceipt.invocations) delete invocation.reviewerSource;
    writeFileSync(receiptPath, JSON.stringify(initialReceipt) + '\n');

    const refreshed = produce(input, transport({ census: [...input.reviewComments, comment(input.body)] }));

    expect(refreshed.ok, refreshed.errors.join('\n')).toBe(true);
    const refreshedReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(refreshedReceipt.invocations.every((invocation: Record<string, unknown>) => typeof invocation.reviewerSource === 'string')).toBe(true);

    refreshedReceipt.invocations[0].reviewerSource = 'tampered-reviewer-source';
    writeFileSync(receiptPath, JSON.stringify(refreshedReceipt) + '\n');
    const conflict = produce(input, transport({ census: [...input.reviewComments, comment(input.body)] }));
    expect(conflict.ok).toBe(false);
    expect(conflict.errors.join('\n')).toContain('conflicting immutable stage receipt target');
  });

  it('requires GitHub artifact authority for complete calls even with an opaque reviewerSource', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'opaque-reviewer-source',
      withTurnResult: true,
      withCapture: true,
    });
    const result = produce(input, transport({ census: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('authoritative GitHub artifact zero_principal_owned_match');
    expect(existsSync(join(input.outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it('accepts a complete GitHub artifact with recovery_required local turn result', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      turnResultState: 'recovery_required',
      turnResultCause: 'direct_publication_no_owned_publication',
      withTurnResult: true,
      withCapture: false,
    });
    const source = transport({ census: [...input.reviewComments, comment(input.body)] });
    const result = produce(input, source);

    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(JSON.parse(readFileSync(input.turnResultPath, 'utf8'))).toMatchObject({
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'direct_publication_no_owned_publication',
      invocation_id: 'invocation-001',
      send_count: 1,
    });
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.invocations[0]).toMatchObject({
      terminalClassification: 'complete',
      sendCount: 1,
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      terminalResultIdentity: input.invocation.terminalResultIdentity,
      artifactAuthority: { kind: 'authoritative-github-artifact' },
    });
  });

  it('accepts an observed direct-publication recovery mismatch with a canonical GitHub comment', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      stageInvocationId: 'a28911b4-9f60-4a42-bd8e-edd6c896540c',
      turnResultInvocationId: 'a28911b4-9f60-4a42-bd8e-edd6c896540c',
      turnResultState: 'recovery_required',
      turnResultCause: 'direct_publication_no_owned_publication',
      withTurnResult: true,
      withCapture: true,
    });
    const source = transport({
      census: [...input.reviewComments, comment(input.body, { id: 5427396953 })],
    });
    const result = produce(input, source);

    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(JSON.parse(readFileSync(input.turnResultPath, 'utf8'))).toMatchObject({
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'direct_publication_no_owned_publication',
      invocation_id: 'a28911b4-9f60-4a42-bd8e-edd6c896540c',
      send_count: 1,
    });
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.invocations[0]).toMatchObject({
      invocationId: 'a28911b4-9f60-4a42-bd8e-edd6c896540c',
      terminalClassification: 'complete',
      sendCount: 1,
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      terminalResultIdentity: input.invocation.terminalResultIdentity,
      artifactAuthority: { kind: 'authoritative-github-artifact' },
    });
  });

  it('rejects an observed mismatch when stage evidence asserts a different GitHub identity', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      stageInvocationId: 'a28911b4-9f60-4a42-bd8e-edd6c896540c',
      turnResultInvocationId: '73fe6971-c58f-4d45-bb35-00ca92bec25a',
      turnResultState: 'recovery_required',
      turnResultCause: 'direct_publication_no_owned_publication',
      terminalResultIdentity: 'github-comment:9999999999',
      withTurnResult: true,
      withCapture: false,
    });
    const result = produceStageTime(input, transport({
      census: [...input.reviewComments, comment(input.body, { id: 5427396953 })],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'stage evidence stage evidence invocation[0].terminalResultIdentity is not derived from the referenced turn-result',
    );
  });

  it('rejects a stale non-GitHub terminal identity for the authoritative artifact', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      stageInvocationId: 'a28911b4-9f60-4a42-bd8e-edd6c896540c',
      turnResultInvocationId: '73fe6971-c58f-4d45-bb35-00ca92bec25a',
      turnResultState: 'recovery_required',
      turnResultCause: 'direct_publication_no_owned_publication',
      terminalResultIdentity: 'sha256:stale-helper-identity',
      withTurnResult: true,
      withCapture: false,
    });
    const result = produceStageTime(input, transport({
      census: [...input.reviewComments, comment(input.body, { id: 5427396953 })],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'stage evidence stage evidence invocation[0].terminalResultIdentity is not derived from the referenced turn-result',
    );
  });

  it('rejects the observed mismatch when complete census omits the GitHub credential comment', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      stageInvocationId: 'a28911b4-9f60-4a42-bd8e-edd6c896540c',
      turnResultInvocationId: '73fe6971-c58f-4d45-bb35-00ca92bec25a',
      turnResultState: 'recovery_required',
      turnResultCause: 'direct_publication_no_owned_publication',
      withTurnResult: true,
      withCapture: false,
    });
    const result = produce(input, transport({ census: input.reviewComments }));

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('authoritative GitHub artifact zero_principal_owned_match');
  });

  it('rejects artifact-backed recovery_required under final-node policy', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'browser-gpt#capture=final-node/v1',
      turnResultState: 'recovery_required',
      turnResultCause: 'direct_publication_no_owned_publication',
      withTurnResult: true,
      withCapture: false,
    });
    const source = transport({ census: [...input.reviewComments, comment(input.body)] });
    const result = produceStageTime(input, source);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('not a successful terminal result');
  });

  it('rejects direct-publication recovery with the wrong cause', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      turnResultState: 'recovery_required',
      turnResultCause: 'direct_publication_owned_parent_missing',
      withTurnResult: true,
      withCapture: false,
    });
    const source = transport({ census: [...input.reviewComments, comment(input.body)] });
    const result = produceStageTime(input, source);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('not a successful terminal result');
  });

  it('rejects direct-publication recovery with malformed common terminal fields', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      turnResultState: 'recovery_required',
      turnResultCause: 'direct_publication_no_owned_publication',
      turnResultScope: 7,
      withTurnResult: true,
      withCapture: false,
    });
    const source = transport({ census: [...input.reviewComments, comment(input.body)] });
    const result = produceStageTime(input, source);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('missing required terminal fields');
  });

  it('rejects direct-publication recovery with non-one local send_count', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      turnResultState: 'recovery_required',
      turnResultCause: 'direct_publication_no_owned_publication',
      turnResultSendCount: 0,
      withTurnResult: true,
      withCapture: false,
    });
    const source = transport({ census: [...input.reviewComments, comment(input.body)] });
    const result = produceStageTime(input, source);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('send_count does not match stage evidence');
  });

  it('rejects direct-publication recovery with missing local send_count', () => {
    const input = fixture({
      transportClassification: 'complete',
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      turnResultState: 'recovery_required',
      turnResultCause: 'direct_publication_no_owned_publication',
      omitTurnResultSendCount: true,
      withTurnResult: true,
      withCapture: false,
    });
    const source = transport({ census: [...input.reviewComments, comment(input.body)] });
    const result = produceStageTime(input, source);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('not a successful terminal result');
  });

  it('keeps the published pass-01 architectural capture for a later stage attempt', () => {
    const input = fixture({ transportClassification: 'incident', withCapture: true });
    const publishedPath = join(input.dir, 'pass-01-architectural.capture.txt');
    renameSync(input.capturePath, publishedPath);
    input.capturePath = publishedPath;
    input.invocation.capturePath = publishedPath;
    input.invocation.stageAttemptId = 'attempt-002';
    input.evidence.stageAttemptId = 'attempt-002';
    writeFileSync(input.evidencePath, JSON.stringify(input.evidence));

    const result = produce(input);

    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(
      readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-002.json'), 'utf8'),
    );
    expect(receipt.invocations[0].capture.name).toBe('pass-01-architectural.capture.txt');
  });

  it('bridges realistic direct_publication_owned_parent_missing without inventing transport success', () => {
    const input = fixture({ transportClassification: 'incident', withTurnResult: true, withCapture: false });
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.outcome).toBe('complete');
    expect(receipt.invocations[0]).toMatchObject({
      terminalClassification: 'incident',
      sendCount: 1,
      retryClass: 'retry-forbidden',
      artifactAuthority: { kind: 'authoritative-github-artifact' },
    });
    expect(readFileSync(input.capturePath, 'utf8')).toBe(input.body);
  });

  it('credentials the published FINDINGS capture without a VERDICT line', () => {
    const input = fixture({
      transportClassification: 'incident',
      withTurnResult: true,
      withCapture: true,
      issueNumber: 1777,
      intakeRevision: 'r03',
      sourceRevision: 'r03',
      captureText: PUBLISHED_FINDINGS_WITHOUT_VERDICT,
      stageInvocationId: 'd471e32c-b221-4086-a082-2c3daa48b985',
      turnResultInvocationId: 'd471e32c-b221-4086-a082-2c3daa48b985',
    });
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.invocations[0]).toMatchObject({
      terminalClassification: 'incident',
      sendCount: 1,
      artifactAuthority: { kind: 'authoritative-github-artifact' },
    });
    expect(receipt.invocations[0].capture.rawFindingCount).toBe(1);
    expect(readFileSync(input.capturePath, 'utf8')).toBe(PUBLISHED_FINDINGS_WITHOUT_VERDICT);
  });

  describe('omitted FINDING_COUNT architectural FINDINGS', () => {
    it('keeps artifactAuthority when id: rows are present', () => {
      const body = canonicalFindingsVerdict();
      const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: body });
      const result = produce(input);
      expect(result.ok, result.errors.join('\n')).toBe(true);
      const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
      expect(body).not.toMatch(/^FINDING_COUNT:/m);
      expect(receipt.invocations[0]).toMatchObject({
        terminalClassification: 'incident',
        sendCount: 1,
        artifactAuthority: { kind: 'authoritative-github-artifact' },
      });
      expect(receipt.invocations[0].capture.rawFindingCount).toBe(2);
      expect(readFileSync(input.capturePath, 'utf8')).toBe(body);
    });

    it('fails closed when explicit FINDING_COUNT disagrees with id: count', () => {
      const body = canonicalFindingsVerdict({ findingCountLine: 'FINDING_COUNT: 1' });
      const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: body });
      const result = produce(input);
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('cannot credential a capture without artifactAuthority');
    });

    it('fails closed when id: finding rows are omitted', () => {
      const body = canonicalFindingsVerdict({ includeFindingRows: false });
      const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: body });
      const result = produce(input);
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('cannot credential a capture without artifactAuthority');
    });

    it('fails closed when explicit FINDING_COUNT is malformed', () => {
      const body = canonicalFindingsVerdict({ findingCountLine: 'FINDING_COUNT: two' });
      const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: body });
      const result = produce(input);
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('cannot credential a capture without artifactAuthority');
    });

    it('fails closed when CLEAN omits FINDING_COUNT', () => {
      const body = [
        `Read revision: #${ISSUE} ${REVISION}`,
        'review-economics-contract: v1',
        'VERDICT: CLEAN',
        'NO_FINDINGS',
        'SIMPLIFICATION_CLEAN',
        'INVOCATION_ID_TO_ECHO: invocation-001',
        '',
      ].join('\n');
      const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: body });
      const result = produce(input);
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('cannot credential a capture without artifactAuthority');
    });

    it('credentials an architectural-clean VERDICT: NO_FINDINGS capture', () => {
      const body = [
        `Read revision: #${ISSUE} ${REVISION}`,
        'review-economics-contract: v1',
        'VERDICT: NO_FINDINGS',
        'SIMPLIFICATION_CLEAN',
        'FINDING_COUNT: 0',
        'INVOCATION_ID_TO_ECHO: invocation-001',
        '',
      ].join('\n');
      const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: body });
      const result = produce(input);
      expect(result.ok, result.errors.join('\n')).toBe(true);
      const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
      expect(receipt.invocations[0]).toMatchObject({
        terminalClassification: 'incident',
        sendCount: 1,
        artifactAuthority: { kind: 'authoritative-github-artifact' },
      });
      expect(receipt.invocations[0].capture.rawFindingCount).toBe(0);
      expect(readFileSync(input.capturePath, 'utf8')).toBe(body);
    });

    it('credentials VERDICT: NO_FINDINGS with a standalone NO_FINDINGS token', () => {
      const body = [
        `Read revision: #${ISSUE} ${REVISION}`,
        'review-economics-contract: v1',
        'VERDICT: NO_FINDINGS',
        'NO_FINDINGS',
        'SIMPLIFICATION_CLEAN',
        'FINDING_COUNT: 0',
        'INVOCATION_ID_TO_ECHO: invocation-001',
        '',
      ].join('\n');
      const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: body });
      const result = produce(input);
      expect(result.ok, result.errors.join('\n')).toBe(true);
      const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
      expect(receipt.invocations[0].artifactAuthority).toMatchObject({
        kind: 'authoritative-github-artifact',
      });
      expect(receipt.invocations[0].capture.rawFindingCount).toBe(0);
    });
  });

  it('accepts receipt-missing/artifact-ok and preserves absent transport identity fields', () => {
    const input = fixture({ transportClassification: 'incident', reviewerSource: null, withTurnResult: false });
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.invocations[0].terminalResultIdentity).toBeUndefined();
    expect(receipt.invocations[0].reviewerSource).toBeUndefined();
    expect(receipt.invocations[0].terminalClassification).toBe('incident');
    expect(receipt.invocations[0].sendCount).toBe(1);
  });

  it('preserves a proven zero-send first attempt and credentials its one legal retry from GitHub', () => {
    const input = fixture({ transportClassification: 'incident', withTurnResult: false, withCapture: false });
    const reviewerSource = 'browser-gpt#capture=final-node/v1';
    const first = {
      ...input.invocation,
      invocationId: 'invocation-zero-send',
      terminalResultIdentity: 'terminal-zero-send',
      reviewerSource,
      attemptOrdinal: 1,
      retryAttempt: false,
      terminalClassification: 'quota',
      sendCount: 0,
      retryClass: 'eligible-zero-send',
    };
    delete first.capturePath;
    delete first.turnResultPath;
    const retry = {
      ...input.invocation,
      invocationId: 'invocation-retry',
      reviewerSource,
      attemptOrdinal: 2,
      retryAttempt: true,
      terminalClassification: 'incident',
      sendCount: 1,
      retryClass: 'retry-forbidden',
    };
    delete retry.capturePath;
    delete retry.turnResultPath;
    delete retry.terminalResultIdentity;
    input.evidence.invocations = [first, retry];
    input.evidence.outcome = 'incident';
    input.evidence.settlement.retryState = 'exhausted';
    writeFileSync(input.evidencePath, JSON.stringify(input.evidence));
    const live = canonicalFindingsVerdict({ invocationId: 'invocation-retry' });
    const source = transport({ census: [...input.reviewComments, comment(live)] });

    const result = produce(input, source);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.outcome).toBe('complete');
    expect(receipt.settlement.retryState).toBe('exhausted');
    expect(receipt.invocations).toHaveLength(2);
    expect(receipt.invocations[0]).toMatchObject({
      invocationId: 'invocation-zero-send',
      sendCount: 0,
      retryClass: 'eligible-zero-send',
      terminalClassification: 'quota',
    });
    expect(receipt.invocations[0].artifactAuthority).toBeUndefined();
    expect(receipt.invocations[0].capture).toBeUndefined();
    expect(receipt.invocations[1]).toMatchObject({
      invocationId: 'invocation-retry',
      sendCount: 1,
      retryClass: 'retry-forbidden',
      artifactAuthority: { kind: 'authoritative-github-artifact' },
    });
    expect(readFileSync(input.capturePath, 'utf8')).toBe(live);
  });

  it('treats a proven-complete zero-match census as absence, not unknown', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ census: [] }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBeUndefined();
    expect(result.errors.join('\n')).toContain('authoritative GitHub artifact zero_principal_owned_match');
    expect(existsSync(join(input.outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each([
    ['foreign target', comment(canonicalVerdict(), { issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/1193` }), /zero_principal_owned_match/],
    ['wrong revision', comment(canonicalVerdict('r02')), /revision mismatch:.*expected=r01.*observed=r02/],
    ['wrong publisher', comment(canonicalVerdict(), { user: { login: 'someone-else' }, author_association: 'OWNER' }), /wrong_publisher/],
    ['edited artifact', comment(canonicalVerdict(), { updated_at: '2026-08-07T04:01:00Z' }), /was edited/],
  ])('rejects %s', (_name, liveComment, expected) => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({
      census: [liveComment as Record<string, unknown>],
      issueBodies: [finalAcceptanceIssueBody(REVISION)],
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(expected as RegExp);
  });

  it('ignores an unrelated authorless non-journal comment when deriving canonical lineage', () => {
    const input = fixture({ transportClassification: 'incident' });
    const authorlessNoiseId = COMMENT_ID + 90;
    const authorlessNoise = comment('unrelated historical note\n', {
      id: authorlessNoiseId,
      html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${authorlessNoiseId}`,
      user: null,
    });
    const result = produce(input, transport({ census: [...input.reviewComments, authorlessNoise, comment(input.body)] }));
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.invocations[0].artifactAuthority.commentId).toBe(COMMENT_ID);
  });

  it('produces receipts when the admitted canonical head has a non-current fork diagnostic', () => {
    const input = fixture({ transportClassification: 'incident' });
    const root = cycleComment(REVISION, 'cycle-1385', 'none', CYCLE_COMMENT_ID);
    const admittedSuccessor = cycleComment(REVISION, 'cycle-successor', 'cycle-1385', CYCLE_COMMENT_ID + 1);
    const nonCurrentFork = cycleComment(REVISION, 'cycle-fork', 'cycle-1385', CYCLE_COMMENT_ID + 2);
    const result = produce(input, transport({
      census: [...input.reviewComments, comment(input.body)],
      cycleComments: [root, admittedSuccessor, nonCurrentFork],
    }));

    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.cycleId).toBe('cycle-1385');
  });

  it.each([
    ['author login', { user: null }],
    ['author association', { author_association: null }],
  ])('fails closed when a journal-marked comment lacks %s', (_label, overrides) => {
    const input = fixture({ transportClassification: 'incident' });
    const untrustedJournal = { ...cycleComment(), ...overrides };
    const result = produceStageTime(input, transport({
      census: [...input.reviewComments, comment(input.body)],
      cycleComments: [untrustedJournal],
    }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBe('source-unavailable');
    expect(result.errors.join('\n')).toContain('journal-marked comment');
  });

  it('fails closed when the canonical invocation candidate lacks authenticated-principal identity', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ census: [...input.reviewComments, comment(input.body, { user: null })] }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBeUndefined();
    expect(result.errors.join('\n')).toContain('zero_principal_owned_match');
  });

  it('rejects a unique echo-less FINDINGS comment because invocation identity is absent', () => {
    const input = fixture({ transportClassification: 'incident', withCapture: false, withTurnResult: false });
    const stageEvidence = JSON.parse(readFileSync(input.reviewEvidencePath, 'utf8')) as Record<string, any>;
    const unmatchedInvocation = stageEvidence.invocations[1] as Record<string, unknown>;
    const findingBody = canonicalFindingsVerdict({ invocationId: 'architectural-review-invocation-02' })
      .replace(/^INVOCATION_ID_TO_ECHO: .*$/m, '')
      .replace(/\n{2,}/g, '\n');
    input.reviewComments[1]!.body = findingBody;
    rmSync(join(input.dir, 'pass-01-architectural-review-02.capture.txt'));
    unmatchedInvocation.terminalClassification = 'incident';
    unmatchedInvocation.retryClass = 'retry-forbidden';
    delete unmatchedInvocation.capturePath;
    delete unmatchedInvocation.terminalResultIdentity;
    writeFileSync(input.reviewEvidencePath, JSON.stringify(stageEvidence));
    const result = produce(input, transport({
      census: [...input.reviewComments, comment(input.body, { issueNumber: input.issueNumber })],
      issueNumber: input.issueNumber,
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('zero_principal_owned_match');
    expect(existsSync(join(input.dir, 'pass-01-architectural-review-02.capture.txt'))).toBe(false);
  });

  it('fails closed when echo-less FINDINGS leftovers are ambiguous', () => {
    const input = fixture({ transportClassification: 'incident', withCapture: false, withTurnResult: false });
    const stageEvidence = JSON.parse(readFileSync(input.reviewEvidencePath, 'utf8')) as Record<string, any>;
    const unmatchedInvocation = stageEvidence.invocations[1] as Record<string, unknown>;
    const findingBody = canonicalFindingsVerdict({ invocationId: 'architectural-review-invocation-02' })
      .replace(/^INVOCATION_ID_TO_ECHO: .*$/m, '')
      .replace(/\n{2,}/g, '\n');
    input.reviewComments[1]!.body = findingBody;
    rmSync(join(input.dir, 'pass-01-architectural-review-02.capture.txt'));
    unmatchedInvocation.terminalClassification = 'incident';
    unmatchedInvocation.retryClass = 'retry-forbidden';
    delete unmatchedInvocation.capturePath;
    delete unmatchedInvocation.terminalResultIdentity;
    writeFileSync(input.reviewEvidencePath, JSON.stringify(stageEvidence));
    const duplicate = comment(findingBody, {
      id: COMMENT_ID + 1001,
      html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID + 1001}`,
    });
    const result = produce(input, transport({
      census: [...input.reviewComments, duplicate, comment(input.body, { issueNumber: input.issueNumber })],
      issueNumber: input.issueNumber,
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('zero_principal_owned_match');
  });

  it('keeps an echoed invocation as the primary bind when an echo-less leftover is present', () => {
    const input = fixture({ transportClassification: 'incident' });
    const findingBody = canonicalFindingsVerdict({ invocationId: 'unmatched-extra' })
      .replace(/^INVOCATION_ID_TO_ECHO: .*$/m, '')
      .replace(/\n{2,}/g, '\n');
    const extra = comment(findingBody, {
      id: COMMENT_ID + 1002,
      html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID + 1002}`,
    });
    const result = produce(input, transport({
      census: [...input.reviewComments, extra, comment(input.body, { issueNumber: input.issueNumber })],
      issueNumber: input.issueNumber,
    }));
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-architectural-review-attempt.json'), 'utf8'));
    expect(receipt.invocations[1].artifactAuthority.commentId).toBe(COMMENT_ID + 101);
  });

  it('filters publisher before uniqueness and ignores a foreign byte-identical candidate', () => {
    const input = fixture({ transportClassification: 'incident' });
    const first = comment(input.body);
    const second = comment(input.body, {
      id: COMMENT_ID + 1,
      html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID + 1}`,
      user: { login: 'someone-else' },
      author_association: 'COLLABORATOR',
    });
    const result = produce(input, transport({
      census: [...input.reviewComments, second, first],
    }));
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.invocations[0].artifactAuthority.commentId).toBe(COMMENT_ID);
    expect(receipt.invocations[0].artifactAuthority.publisherLogin).toBe(PUBLISHER);
  });

  it('fails closed when the current authenticated GitHub principal cannot be resolved', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ principal: null, census: [...input.reviewComments, comment(input.body)] }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBe('identity-unresolved');
    expect(result.errors.join('\n')).toContain('authenticated GitHub principal');
    expect(result.errors.join('\n')).toContain('GET /user');
  });

  it('classifies an incomplete paginated census as TEMPORARY source-unavailable', () => {
    const input = fixture({ transportClassification: 'incident' });
    const filler = Array.from({ length: 100 }, (_, index) => comment(`noise-${index}`, { id: 6000000000 + index }));
    const result = produce(input, transport({ census: filler, secondPageFailure: true }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBe('source-unavailable');
    expect(result.errors.join('\n')).toContain('TEMPORARY source-unavailable');
  });

  it('treats duplicate canonical invocation artifacts with identical bytes as one observation', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ census: [
      ...input.reviewComments,
      comment(input.body),
      comment(input.body, { id: COMMENT_ID + 1, html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID + 1}`, user: { login: 'other-member' }, author_association: 'MEMBER' }),
    ] }));
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('rejects two principal-owned canonical artifacts for the same invocation', () => {
    const input = fixture({ transportClassification: 'incident' });
    const conflicting = `${input.body}material-conflict\n`;
    const result = produce(input, transport({ census: [
      comment(input.body),
      comment(conflicting, { id: COMMENT_ID + 1, html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID + 1}`, user: { login: PUBLISHER }, author_association: 'OWNER' }),
    ] }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('duplicate_principal_owned_match');
  });

  it('classifies local observation loss after the authoritative reread but before capture materialization', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({
      census: [comment(input.body)],
      beforeReread: () => symlinkSync(join(input.dir, 'missing-target'), input.capturePath),
    }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBe('observation-lost');
    expect(result.errors.join('\n')).toContain('TEMPORARY observation-lost');
  });

  it('materializes exact authoritative bytes without leaving staging artifacts', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(readFileSync(input.capturePath, 'utf8')).toBe(input.body);
    expect(readdirSync(input.dir).filter((name) => name.startsWith('.pass-02-architectural.capture.txt.tmp-'))).toEqual([]);
  });

  it('rejects an existing canonical capture conflict and never overwrites it', () => {
    const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: 'foreign local bytes\n' });
    const live = canonicalVerdict();
    const result = produce(input, transport({ census: [...input.reviewComments, comment(live)], reread: comment(live) }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('conflicts with existing canonical capture');
    expect(readFileSync(input.capturePath, 'utf8')).toBe('foreign local bytes\n');
  });

  it('rejects receipt-ok/artifact-missing discrepancy', () => {
    const input = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    const result = produce(input, transport({ census: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('zero_principal_owned_match');
  });

  it('rejects artifact bytes that change between the complete census and reread', () => {
    const input = fixture({ transportClassification: 'incident' });
    const changed = `${input.body}changed\n`;
    const result = produce(input, transport({ census: [...input.reviewComments, comment(input.body)], reread: comment(changed) }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/malformed|changed between complete census and reread/);
  });

  it.each([
    ['complete absence', { census: [] }],
    ['duplicate identity', { census: [comment(), comment(canonicalVerdict(), { id: COMMENT_ID + 1, html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID + 1}` })] }],
    ['untrusted publisher', { census: [comment(canonicalVerdict(), { user: { login: 'someone-else' }, author_association: 'NONE' })] }],
    ['edited artifact', { census: [comment(canonicalVerdict(), { updated_at: '2026-08-07T04:01:00Z' })] }],
    ['wrong revision', { census: [comment(canonicalVerdict('r02'))] }],
    ['reread byte mismatch', { census: [comment()], reread: comment(`${canonicalVerdict()}changed\n`) }],
    ['source unavailable', { censusFailure: true }],
  ])('does not let the operator URL override %s', (_name, transportOptions) => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport(transportOptions as TransportOptions), validOperatorHint(input.body));
    expect(result.ok).toBe(false);
  });

  it('does not let the operator URL override observation loss', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({
      census: [comment(input.body)],
      beforeReread: () => symlinkSync(join(input.dir, 'missing-target'), input.capturePath),
    }), validOperatorHint(input.body));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBe('observation-lost');
  });

  it('does not let the operator URL override an existing-capture conflict', () => {
    const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: 'foreign local bytes\n' });
    const live = canonicalVerdict();
    const result = produce(
      input,
      transport({ census: [...input.reviewComments, comment(live)], reread: comment(live) }),
      validOperatorHint(live),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('conflicts with existing canonical capture');
    expect(readFileSync(input.capturePath, 'utf8')).toBe('foreign local bytes\n');
  });

  it('uses the operator URL only as a narrowing hint after unique canonical resolution', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ census: [...input.reviewComments, comment(input.body)] }), validOperatorHint(input.body));
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const manifest = JSON.parse(readFileSync(join(input.outputDir, 'acceptance-artifacts.json'), 'utf8'));
    expect(manifest.acceptanceBasis).toBe('authoritative-github-artifact');
    expect(manifest.operatorAdjudication).toBeUndefined();
  });

  it('accepts a distinct published author-state hint after unique canonical resolution', () => {
    const input = fixture({ transportClassification: 'incident' });
    const authorState = [
      'm3-protected: id=published-author-state | revision=r01 | contest=none | outcome=non-activate',
      'author-state: published-author-state',
      'revision: r01',
      '',
    ].join('\n');
    const authorStateId = COMMENT_ID + 500;
    const result = produce(
      input,
      transport({ census: [...input.reviewComments, comment(input.body), comment(authorState, { id: authorStateId })] }),
      validOperatorHint(authorState, REVISION, authorStateId),
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const manifest = JSON.parse(readFileSync(join(input.outputDir, 'acceptance-artifacts.json'), 'utf8'));
    expect(manifest.publishedAuthorState).toEqual({
      sha256: createHash('sha256').update(authorState).digest('hex'),
      byteLength: Buffer.byteLength(authorState),
    });
  });

  it('allows the first stage receipt revision to differ from the immutable episode first revision when the canonical cycle binds it', () => {
    const input = fixture({ intakeRevision: 'r03', sourceRevision: 'r04', transportClassification: 'incident' });
    const live = canonicalVerdict('r04');
    const result = produce(input, transport({ census: [...input.reviewComments, comment(live)] }));
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('contributes the authoritative capture exactly once to governance, relay, and ledger', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    const relay = JSON.parse(readFileSync(join(input.outputDir, 'verified-relay-evidence.json'), 'utf8'));
    expect(receipt.credentialingCaptures).toHaveLength(1);
    expect(receipt.relayEligibleCaptures).toHaveLength(1);
    expect(relay).toHaveLength(4);
    expect(new Set([
      receipt.credentialingCaptures[0].captureIdentity,
      receipt.relayEligibleCaptures[0].captureIdentity,
      relay.find((item: VerifiedRelayEvidenceV1) => item.captureIdentity === receipt.credentialingCaptures[0].captureIdentity)?.captureIdentity,
    ]).size).toBe(1);
    const ledgerCall = vi.mocked(checkFindingLedgerGuard).mock.calls.at(-1);
    expect(ledgerCall?.[0]).toEqual([...input.reviewComments.map((item) => String(item.body)), input.body]);
  });

  it('never fabricates ok state, reviewer_source, send accounting, or success terminal identity', () => {
    const input = fixture({ transportClassification: 'incident', reviewerSource: null, withTurnResult: false });
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    const invocation = receipt.invocations[0];
    expect(invocation.terminalClassification).toBe('incident');
    expect(invocation.sendCount).toBe(1);
    expect(invocation.retryClass).toBe('retry-forbidden');
    expect(invocation.reviewerSource).toBeUndefined();
    expect(invocation.terminalResultIdentity).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain('"state":"ok"');
  });

  it('check-artifacts validates the complete produced authoritative set', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const status = inspect(input);
    expect(status.ok, status.missing.map((item) => item.reason).join('\n')).toBe(true);
  });

  it('check-artifacts reports the owning authority instead of manager hand-repair instructions', () => {
    const missingTier = fixture({ transportClassification: 'incident' });
    rmSync(missingTier.intakePath);
    const missingTierReason = inspect(missingTier).missing.find((item) => item.artifact === 'tier-intake/v1')?.reason ?? '';
    expect(missingTierReason).toContain('authority=lifecycle-tool-witnessed');
    expect(missingTierReason).not.toContain('flow-manager-authored input');
    expect(missingTierReason).not.toContain('record/provide');

    const malformedStage = fixture({ transportClassification: 'incident' });
    writeFileSync(malformedStage.reviewEvidencePath, '{');
    const malformedStageReason = inspect(malformedStage).missing.find((item) => item.artifact === 'stage evidence')?.reason ?? '';
    expect(malformedStageReason).toContain('authority=lifecycle-tool-witnessed/GitHub-witnessed');
    expect(malformedStageReason).not.toContain('flow-manager-authored input');

    const missingAuthor = fixture({ transportClassification: 'incident' });
    rmSync(missingAuthor.authorReplyPath);
    const authorReason = inspect(missingAuthor).missing.find((item) => item.artifact === 'governed author output')?.reason ?? '';
    expect(authorReason).toContain('field=findings/m4');
    expect(authorReason).toContain('authority=author-owned');
    expect(authorReason).not.toContain('record/provide');

    const autoDiscovered = fixture({ transportClassification: 'incident' });
    const autoStatus = inspectAcceptanceArtifacts({
      reviewDir: autoDiscovered.dir,
      outputDir: autoDiscovered.outputDir,
      tierIntakePath: autoDiscovered.intakePath,
      stageEvidencePaths: [],
      authorDispositionsPath: autoDiscovered.authorPath,
      phase: 'final-acceptance',
    });
    expect(autoStatus.missing.some((item) => item.reason.includes('no recorded stage evidence paths were supplied'))).toBe(false);
    expect(autoStatus.missing.some((item) => item.reason.includes('--stage-evidence omitted canonical stage evidence files'))).toBe(false);

    const derivedConflict = fixture({ transportClassification: 'incident' });
    const produced = produce(derivedConflict);
    expect(produced.ok, produced.errors.join('\n')).toBe(true);
    writeFileSync(derivedConflict.authorPath, '{}');
    const derivedReason = inspect(derivedConflict).missing.find((item) => item.artifact === 'author dispositions')?.reason ?? '';
    expect(derivedReason).toContain('governed producer provenance');
    expect(derivedReason).toContain('authority=author-owned/GitHub-witnessed/lifecycle-tool-witnessed');
  });

  it('check-artifacts uses final-acceptance semantics for historical partial-witness identity', () => {
    const input = fixture({ transportClassification: 'incident' });
    const produced = produce(input);
    expect(produced.ok, produced.errors.join('\n')).toBe(true);
    const receiptPath = join(input.outputDir, 'stage-completeness-receipt-architectural-review-attempt.json');
    const original = JSON.parse(readFileSync(receiptPath, 'utf8')) as StageCompletenessReceiptV1;
    const partial = historicalWitnessPartial(original).receipt;
    writeFileSync(receiptPath, JSON.stringify(partial, null, 2) + '\n');
    const rawStageEvidence = JSON.parse(readFileSync(input.reviewEvidencePath, 'utf8')) as Record<string, unknown>;
    const rawInvocations = rawStageEvidence.invocations as Array<Record<string, unknown>>;
    rawStageEvidence.outcome = 'partial';
    rawInvocations[2]!.terminalClassification = 'incident';
    rawInvocations[2]!.retryClass = 'retry-forbidden';
    rawStageEvidence.partialMissingSources = [{
      reviewerSlot: '03',
      invocationId: 'historical-other-invocation',
      evidenceIdentity: 'historical-other-result',
      reason: 'post-send result unavailable',
    }];
    writeFileSync(input.reviewEvidencePath, JSON.stringify(rawStageEvidence));

    const finalStatus = inspect(input);
    expect(finalStatus.ok, finalStatus.missing.map((item) => item.reason).join('\n')).toBe(true);
    const stageStatus = inspectStageTime(input);
    expect(stageStatus.ok).toBe(false);
    expect(stageStatus.missing.map((item) => item.reason).join('\n'))
      .toContain(`lacks a journal witness naming invocation ${String(partial.invocations?.[2]?.invocationId)}`);
  });

  it('uses the durable #1976 poison/successor witness for stage-time and final artifact production only', () => {
    const stageInput = fixture({ transportClassification: 'incident' });
    const recoveredStageSource = transport({
      census: [...stageInput.reviewComments, comment(stageInput.body, { issueNumber: stageInput.issueNumber })],
      cycleComments: [issue1976PoisonJournalComment(), issue1976RecoverySuccessorComment()],
      issueNumber: stageInput.issueNumber,
    });
    const stageResult = produceStageTime(stageInput, recoveredStageSource);
    expect(stageResult.ok, stageResult.errors.join('\n')).toBe(true);

    const finalInput = fixture({ transportClassification: 'incident' });
    const recoveredFinalSource = transport({
      census: [...finalInput.reviewComments, comment(finalInput.body, { issueNumber: finalInput.issueNumber })],
      cycleComments: [issue1976PoisonJournalComment(), issue1976RecoverySuccessorComment()],
      issueNumber: finalInput.issueNumber,
    });
    const finalResult = produce(finalInput, recoveredFinalSource);
    expect(finalResult.ok, finalResult.errors.join('\n')).toBe(true);

    const blockedInput = fixture({ transportClassification: 'incident' });
    const blockedSource = transport({
      census: [...blockedInput.reviewComments, comment(blockedInput.body, { issueNumber: blockedInput.issueNumber })],
      cycleComments: [
        issue1976PoisonJournalComment(),
        issue1976RecoverySuccessorComment(),
        unrelatedMalformedJournalComment(),
      ],
      issueNumber: blockedInput.issueNumber,
    });
    const blocked = produce(blockedInput, blockedSource);
    expect(blocked.ok).toBe(false);
    expect(blocked.errors.join('\n')).toContain('malformed-marker');
  });

  it.each([
    ['edited', { updated_at: '2026-08-06T04:01:00Z' }],
    ['non-owner', { user: { login: 'someone-else' } }],
  ])('fails closed for %s journal-marked #1976 poison during stage-time and final artifact production', (_label, overrides) => {
    const poison = { ...issue1976PoisonJournalComment(), ...overrides };

    const stageInput = fixture({ transportClassification: 'incident' });
    const stageResult = produceStageTime(stageInput, transport({
      census: [...stageInput.reviewComments, comment(stageInput.body, { issueNumber: stageInput.issueNumber })],
      cycleComments: [poison, issue1976RecoverySuccessorComment()],
      issueNumber: stageInput.issueNumber,
    }));
    expect(stageResult.ok).toBe(false);
    expect(stageResult.errors.join('\n')).toContain('journal-marked comment');

    const finalInput = fixture({ transportClassification: 'incident' });
    const finalResult = produce(finalInput, transport({
      census: [...finalInput.reviewComments, comment(finalInput.body, { issueNumber: finalInput.issueNumber })],
      cycleComments: [poison, issue1976RecoverySuccessorComment()],
      issueNumber: finalInput.issueNumber,
    }));
    expect(finalResult.ok).toBe(false);
    expect(finalResult.errors.join('\n')).toContain('journal-marked comment');
  });

  it('publishes and confirms final acceptance through the recovered #1976 witness and blocks a second malformed marker', () => {
    const input = fixture({ transportClassification: 'incident' });
    const artifactSource = transport({
      census: [...input.reviewComments, comment(input.body, { issueNumber: input.issueNumber })],
      cycleComments: [issue1976PoisonJournalComment(), issue1976RecoverySuccessorComment()],
      issueNumber: input.issueNumber,
    });
    const produced = produce(input, artifactSource);
    expect(produced.ok, produced.errors.join('\n')).toBe(true);

    const stateRoot = join(input.dir, 'issue-1978-canonical-state');
    const canonicalDir = join(stateRoot, '.review', String(ISSUE));
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, 'tier-intake.json'), readFileSync(input.intakePath));
    const receiptNames = produced.files.filter((name) => name.startsWith('stage-completeness-receipt-'));
    for (const name of receiptNames) {
      writeFileSync(join(canonicalDir, name), readFileSync(join(input.outputDir, name)));
    }

    const previousStateRoot = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = stateRoot;
    try {
      const body = finalAcceptanceIssueBody();
      const source = transport({
        census: [],
        cycleComments: [issue1976PoisonJournalComment(), issue1976RecoverySuccessorComment()],
        issueBodies: [body, body, body, body, body],
        persistCreatedIssueComments: true,
        issueLabels: ['spec-review:in-progress'],
      });
      const result = runFinalAcceptance(source, {
        repo: REPOSITORY,
        issueNumber: ISSUE,
        publicActor: 'cursor-flow-manager',
        workdir: join(input.dir, 'journal-success'),
        issueBody: body,
        issueRevision: REVISION,
        cycleId: 'cycle-1385',
        reviewDir: canonicalDir,
        tierIntakePath: join(canonicalDir, 'tier-intake.json'),
        stageReceiptPaths: receiptNames.map((name) => join(canonicalDir, name)),
        capturePaths: [],
        ledgerPath: join(input.outputDir, 'finding-disposition-ledger.json'),
        relayEvidencePaths: [join(input.outputDir, 'verified-relay-evidence.json')],
      });
      expect(result.ok, [...result.guardErrors, ...result.diagnostics.map((item) => item.message)].join('\n')).toBe(true);
      expect(result.projectionPendingRepair).toBe(false);
      expect(source.createdIssueComments).toHaveLength(1);
      expect(source.createdIssueComments[0]).toContain('create-issue-final-acceptance/v1');
      expect(source.issueLabels).toContain('spec-review:accepted');
      expect(source.issueLabels).not.toContain('spec-review:in-progress');

      const blockedSource = transport({
        census: [],
        cycleComments: [
          issue1976PoisonJournalComment(),
          issue1976RecoverySuccessorComment(),
          unrelatedMalformedJournalComment(),
        ],
        issueBodies: [body],
        persistCreatedIssueComments: true,
        issueLabels: ['spec-review:in-progress'],
      });
      const blocked = runFinalAcceptance(blockedSource, {
        repo: REPOSITORY,
        issueNumber: ISSUE,
        publicActor: 'cursor-flow-manager',
        workdir: join(input.dir, 'journal-blocked'),
        issueBody: body,
        issueRevision: REVISION,
        cycleId: 'cycle-1385',
        reviewDir: canonicalDir,
        tierIntakePath: join(canonicalDir, 'tier-intake.json'),
        stageReceiptPaths: receiptNames.map((name) => join(canonicalDir, name)),
        capturePaths: [],
        ledgerPath: join(input.outputDir, 'finding-disposition-ledger.json'),
        relayEvidencePaths: [join(input.outputDir, 'verified-relay-evidence.json')],
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.guardErrors.join('\n')).toContain('blocking malformed marker');
      expect(blockedSource.createdIssueComments).toHaveLength(0);
      expect(blockedSource.issueLabels).not.toContain('spec-review:accepted');

      for (const [label, poison] of [
        ['edited', { ...issue1976PoisonJournalComment(), updated_at: '2026-08-06T04:01:00Z' }],
        ['non-owner', { ...issue1976PoisonJournalComment(), user: { login: 'someone-else' } }],
      ] as const) {
        const untrustedSource = transport({
          census: [],
          cycleComments: [poison, issue1976RecoverySuccessorComment()],
          issueBodies: [body],
          persistCreatedIssueComments: true,
          issueLabels: ['spec-review:in-progress'],
        });
        const untrusted = runFinalAcceptance(untrustedSource, {
          repo: REPOSITORY,
          issueNumber: ISSUE,
          publicActor: 'cursor-flow-manager',
          workdir: join(input.dir, `journal-${label}`),
          issueBody: body,
          issueRevision: REVISION,
          cycleId: 'cycle-1385',
          reviewDir: canonicalDir,
          tierIntakePath: join(canonicalDir, 'tier-intake.json'),
          stageReceiptPaths: receiptNames.map((name) => join(canonicalDir, name)),
          capturePaths: [],
          ledgerPath: join(input.outputDir, 'finding-disposition-ledger.json'),
          relayEvidencePaths: [join(input.outputDir, 'verified-relay-evidence.json')],
        });
        expect(untrusted.ok).toBe(false);
        expect(untrusted.guardErrors.join('\n')).toContain('blocking malformed marker');
        expect(untrustedSource.createdIssueComments).toHaveLength(0);
        expect(untrustedSource.issueLabels).not.toContain('spec-review:accepted');
      }
    } finally {
      if (previousStateRoot === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previousStateRoot;
    }
  });

  it('blocks final acceptance when the live Issue body drifts at the journal write boundary', () => {
    const input = fixture({ transportClassification: 'incident' });
    const produced = produce(input);
    expect(produced.ok, produced.errors.join('\n')).toBe(true);
    const body = finalAcceptanceIssueBody();
    const driftedBody = body.replace('Final acceptance fixture.', 'Drifted final acceptance fixture.');
    const stateRoot = join(input.dir, 'canonical-state');
    const canonicalDir = join(stateRoot, '.review', String(ISSUE));
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, 'tier-intake.json'), readFileSync(input.intakePath));
    const receiptNames = produced.files.filter((name) => name.startsWith('stage-completeness-receipt-'));
    for (const name of receiptNames) writeFileSync(join(canonicalDir, name), readFileSync(join(input.outputDir, name)));
    const previousStateRoot = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = stateRoot;
    try {
      const source = transport({
        census: [],
        cycleComments: [cycleComment()],
        issueBodies: [body, body, driftedBody],
      });
      const result = runFinalAcceptance(source, {
        repo: REPOSITORY,
        issueNumber: ISSUE,
        publicActor: 'cursor-flow-manager',
        workdir: join(input.dir, 'journal'),
        issueBody: body,
        issueRevision: REVISION,
        cycleId: 'cycle-1385',
        reviewDir: canonicalDir,
        tierIntakePath: join(canonicalDir, 'tier-intake.json'),
        stageReceiptPaths: receiptNames.map((name) => join(canonicalDir, name)),
        capturePaths: [],
        ledgerPath: join(input.outputDir, 'finding-disposition-ledger.json'),
        relayEvidencePaths: [join(input.outputDir, 'verified-relay-evidence.json')],
      });

      expect(result.ok).toBe(false);
      expect(result.guardErrors.join('\n')).toContain('terminal source body');
      expect(source.createdIssueComments).toHaveLength(0);
    } finally {
      if (previousStateRoot === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previousStateRoot;
    }
  });

  it('credentials a TO_ECHO-only comment with no INVOCATION_ID line', () => {
    const input = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    expect(input.body).toMatch(/^INVOCATION_ID_TO_ECHO: invocation-001$/m);
    expect(input.body).not.toMatch(/^INVOCATION_ID: /m);
    for (const reviewComment of input.reviewComments) {
      expect(String(reviewComment.body)).toMatch(/^INVOCATION_ID_TO_ECHO: /m);
      expect(String(reviewComment.body)).not.toMatch(/^INVOCATION_ID: /m);
    }
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('rejects an INVOCATION_ID-only comment as non-canonical invocation evidence', () => {
    const input = fixture({
      transportClassification: 'complete',
      withTurnResult: true,
      withCapture: true,
      invocationEchoLabel: 'INVOCATION_ID',
    });
    expect(input.body).toMatch(/^INVOCATION_ID: invocation-001$/m);
    expect(input.body).not.toMatch(/INVOCATION_ID_TO_ECHO:/);
    const result = produce(input);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('authoritative GitHub artifact zero_principal_owned_match');
  });

  it('check-artifacts makes turn-result transport evidence audit-only only at final acceptance', () => {
    const missingTurnResult = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    const producedTurnResult = produce(missingTurnResult);
    expect(producedTurnResult.ok, producedTurnResult.errors.join('\n')).toBe(true);
    expect(inspect(missingTurnResult).ok).toBe(true);
    rmSync(missingTurnResult.turnResultPath);
    const finalTurnStatus = inspect(missingTurnResult);
    expect(finalTurnStatus.ok, finalTurnStatus.missing.map((item) => item.reason).join('\n')).toBe(true);
    const stageTimeTurnStatus = inspectStageTime(missingTurnResult);
    expect(stageTimeTurnStatus.ok).toBe(false);
    expect(stageTimeTurnStatus.missing.map((item) => item.reason).join('\n')).toContain('missing turn-result/v1 artifact');

    const missingCapture = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    const producedCapture = produce(missingCapture);
    expect(producedCapture.ok, producedCapture.errors.join('\n')).toBe(true);
    expect(inspect(missingCapture).ok).toBe(true);
    rmSync(missingCapture.capturePath);
    const captureStatus = inspect(missingCapture);
    expect(captureStatus.ok).toBe(false);
    expect(captureStatus.missing.map((item) => item.reason).join('\n')).toContain('missing capture file');
  });
});

describe('Issue #1385 round-two receipt regressions', () => {
  function outputAuthority(input: ReturnType<typeof fixture>) {
    return {
      tierIntake: JSON.parse(readFileSync(input.intakePath, 'utf8')),
      receiptInventory: JSON.parse(readFileSync(join(input.outputDir, 'review-episode-inventory.json'), 'utf8')),
      claudeProducerEvidence: [],
    };
  }

  it('rejects zero-send, malformed, mismatched, and captureless artifactAuthority branches', () => {
    const input = fixture({ transportClassification: 'incident' });
    const produced = produce(input);
    expect(produced.ok, produced.errors.join('\n')).toBe(true);
    const accepted = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8')) as StageCompletenessReceiptV1;
    const relayEvidence = JSON.parse(readFileSync(join(input.outputDir, 'verified-relay-evidence.json'), 'utf8')) as VerifiedRelayEvidenceV1[];
    const episodeAuthority = outputAuthority(input);

    const zeroSend = structuredClone(accepted);
    zeroSend.invocations![0]!.sendCount = 0;
    expect(deriveReviewEpisodeState([zeroSend], relayEvidence, episodeAuthority).errors.join('\n'))
      .toContain('artifactAuthority requires sendCount 1');

    const malformed = structuredClone(accepted);
    malformed.invocations![0]!.artifactAuthority!.commentUrl = `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID + 1}`;
    expect(deriveReviewEpisodeState([malformed], relayEvidence, episodeAuthority).errors.join('\n'))
      .toContain('artifactAuthority.commentUrl is not canonical');

    const mismatched = structuredClone(accepted);
    mismatched.invocations![0]!.artifactAuthority!.issueNumber = ISSUE + 1;
    mismatched.invocations![0]!.artifactAuthority!.commentUrl = `https://github.com/${REPOSITORY}/issues/${ISSUE + 1}#issuecomment-${COMMENT_ID}`;
    expect(deriveReviewEpisodeState([mismatched], relayEvidence, episodeAuthority).errors.join('\n'))
      .toContain('artifactAuthority.issueNumber does not match receipt taskIdentity');

    const captureless = structuredClone(accepted);
    delete captureless.invocations![0]!.capture;
    expect(deriveReviewEpisodeState([captureless], relayEvidence, episodeAuthority).errors.join('\n'))
      .toContain('artifactAuthority requires capture');
  });

  it('threads final-acceptance semantics through derived partial-stage credentialing', () => {
    const input = fixture({ transportClassification: 'incident' });
    const produced = produce(input);
    expect(produced.ok, produced.errors.join('\n')).toBe(true);
    const reviewReceipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-architectural-review-attempt.json'), 'utf8')) as StageCompletenessReceiptV1;
    const terminalReceipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8')) as StageCompletenessReceiptV1;
    const partial = historicalWitnessPartial(reviewReceipt);
    const relays = (JSON.parse(readFileSync(join(input.outputDir, 'verified-relay-evidence.json'), 'utf8')) as VerifiedRelayEvidenceV1[])
      .filter((relay) => relay.captureIdentity !== partial.droppedCaptureIdentity);
    const finalAuthority: ReviewEpisodeDerivationAuthorityV1 = {
      ...outputAuthority(input),
      validationPurpose: 'final-acceptance',
    };
    const finalState = deriveReviewEpisodeState([partial.receipt, terminalReceipt], relays, finalAuthority);
    expect(finalState.errors, finalState.errors.join('\n')).toEqual([]);
    expect(validateReviewEpisodeTopology(finalState, 'final-acceptance')).toEqual([]);

    const stageState = deriveReviewEpisodeState([partial.receipt, terminalReceipt], relays, {
      ...outputAuthority(input),
      validationPurpose: 'stage-time',
    });
    expect(stageState.errors.join('\n'))
      .toContain(`lacks a journal witness naming invocation ${String(partial.receipt.invocations?.[2]?.invocationId)}`);
  });

  it('keeps artifact-backed complete transport identities audit-only at final acceptance', () => {
    const input = fixture({ transportClassification: 'incident', reviewerSource: null, withTurnResult: false });
    const produced = produce(input);
    expect(produced.ok, produced.errors.join('\n')).toBe(true);
    const reviewReceipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-architectural-review-attempt.json'), 'utf8')) as StageCompletenessReceiptV1;
    const terminalReceipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8')) as StageCompletenessReceiptV1;
    const invocation = terminalReceipt.invocations?.[0];
    if (!invocation?.artifactAuthority || !invocation.capture) throw new Error('fixture requires artifact-backed terminal evidence');
    expect(invocation.terminalResultIdentity).toBeUndefined();
    expect(invocation.reviewerSource).toBeUndefined();
    invocation.terminalClassification = 'complete';
    invocation.retryClass = 'none';
    const relays = JSON.parse(readFileSync(join(input.outputDir, 'verified-relay-evidence.json'), 'utf8')) as VerifiedRelayEvidenceV1[];
    const finalState = deriveReviewEpisodeState([reviewReceipt, terminalReceipt], relays, {
      ...outputAuthority(input),
      validationPurpose: 'final-acceptance',
    });
    expect(finalState.errors, finalState.errors.join('\n')).toEqual([]);

    const stageState = deriveReviewEpisodeState([reviewReceipt, terminalReceipt], relays, {
      ...outputAuthority(input),
      validationPurpose: 'stage-time',
    });
    expect(stageState.errors.join('\n')).toContain('complete result requires terminalResultIdentity');
    expect(stageState.errors.join('\n')).toContain('complete result requires reviewerSource');
  });

  it('accepts the #1706 r04/r06/r07 history at live r08 without rewriting it and rejects r09 drift', () => {
    const taskIdentity = `issue:${ISSUE}`;
    const episodeFirstRevision = 'r04';
    const reviewEpisodeId = `${taskIdentity}@${episodeFirstRevision}`;
    const receiptId = (sequence: number) => `${reviewEpisodeId}:stage-receipt:${String(sequence).padStart(4, '0')}`;
    const makeCapture = (name: string, seed: string): CaptureIdentityV1 => {
      const digest = createHash('sha256').update(seed).digest('hex');
      return {
        captureIdentity: `sha256:${digest}:${name}`,
        name,
        byteLength: Buffer.byteLength(seed),
        sha256: digest,
        rawFindingCount: 0,
      };
    };
    const makeBrowserReceipt = (
      stage: 'competitive' | 'architectural-review' | 'architectural',
      sequence: number,
      sourceRevision: string,
    ): StageCompletenessReceiptV1 => {
      const attemptId = `${stage}-attempt`;
      const policyVersion = stage === 'architectural' ? 'single-source/v1' as const : 'triple-source/v1' as const;
      const name = stage === 'architectural'
        ? `pass-${String(sequence).padStart(2, '0')}-architectural.capture.txt`
        : `pass-${String(sequence).padStart(2, '0')}-${stage}-01.capture.txt`;
      const item = makeCapture(name, `${stage}:${sourceRevision}`);
      return {
        schema: 'stage-completeness-receipt/v1',
        tier: 'T3',
        taskIdentity,
        episodeFirstRevision,
        reviewEpisodeId,
        stageReceiptId: receiptId(sequence),
        previousStageReceiptId: sequence === 1 ? null : receiptId(sequence - 1),
        receiptCensus: Array.from({ length: sequence }, (_, index) => receiptId(index + 1)),
        stageAttemptId: attemptId,
        stageSequence: sequence,
        stage,
        policyVersion,
        reviewerCardinality: 1,
        cardinalityConfigIdentity: CONFIG,
        sourceRevision,
        outcome: 'complete',
        revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
        settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
        invocations: [{
          schema: 'reviewer-invocation-envelope/v1',
          reviewEpisodeId,
          stageAttemptId: attemptId,
          policyVersion,
          reviewerCardinality: 1,
          cardinalityConfigIdentity: CONFIG,
          stage,
          sourceRevision,
          invocationId: `${stage}-${sourceRevision}-invocation`,
          terminalResultIdentity: `${stage}-${sourceRevision}-terminal`,
          reviewerSource: `${stage}-${sourceRevision}-source`,
          reviewerSlot: '01',
          reviewerOrdinal: 1,
          attemptOrdinal: 1,
          retryAttempt: false,
          terminal: true,
          terminalClassification: 'complete',
          sendCount: 1,
          retryClass: 'none',
          revisionCheck: 'matched',
          capacityOutcome: 'admitted',
          capacityWaitMs: 0,
          capture: item,
        }],
        credentialingCaptures: [item],
        relayEligibleCaptures: [item],
      };
    };

    const competitive = makeBrowserReceipt('competitive', 1, 'r04');
    const preterminal = makeBrowserReceipt('architectural-review', 2, 'r04');
    const lensCapture = makeCapture('pass-03-architectural-lens.capture.txt', 'architectural-lens:r06');
    const lens: StageCompletenessReceiptV1 = {
      schema: 'stage-completeness-receipt/v1',
      tier: 'T3',
      taskIdentity,
      episodeFirstRevision,
      reviewEpisodeId,
      stageReceiptId: receiptId(3),
      previousStageReceiptId: receiptId(2),
      receiptCensus: [receiptId(1), receiptId(2), receiptId(3)],
      stageAttemptId: 'architectural-lens-attempt',
      stageSequence: 3,
      stage: 'architectural-lens',
      policyVersion: 'single-source/v1',
      reviewerCardinality: 1,
      cardinalityConfigIdentity: CONFIG,
      sourceRevision: 'r06',
      outcome: 'complete',
      revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
      settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
      claude: {
        kind: 'capture',
        provider: 'claude-cli',
        invocationId: 'claude-r06-invocation',
        producingRunIdentity: 'claude-r06-run',
        terminalResultIdentity: 'claude-r06-terminal',
        producerEvidenceIdentity: 'claude-r06-evidence',
        terminal: true,
        terminalClassification: 'complete',
        exitCode: 0,
        capture: lensCapture,
        m3Status: 'recorded',
      },
      credentialingCaptures: [lensCapture],
      relayEligibleCaptures: [lensCapture],
    };
    const terminal = makeBrowserReceipt('architectural', 4, 'r07');
    const receipts = [competitive, preterminal, lens, terminal];
    const preservedHistory = structuredClone(receipts);
    const captures = receipts.flatMap((item) => item.relayEligibleCaptures);
    const relays: VerifiedRelayEvidenceV1[] = captures.map((item, index) => ({
      relayAttemptId: `1706-relay-${index + 1}`,
      captureIdentity: item.captureIdentity,
      sourceLabel: `${item.name}|${item.captureIdentity}`,
      name: item.name,
      byteLength: item.byteLength,
      sha256: item.sha256,
      verified: true,
    }));
    const episodeAuthority = {
      tierIntake: {
        schema: 'tier-intake/v1' as const,
        producer: 'historical-flow-manager',
        taskIdentity,
        kind: 'fresh' as const,
        priorTier: 'T3' as const,
        firstRevision: episodeFirstRevision,
        competitiveDecision: 'required' as const,
        competitiveRationale: 'historical #1706 cycle began at r04',
      },
      receiptInventory: {
        source: 'canonical-review-directory' as const,
        taskIdentity,
        episodeFirstRevision,
        reviewEpisodeId,
        stageReceiptIds: receipts.map((item) => item.stageReceiptId),
      },
      claudeProducerEvidence: [],
      validationPurpose: 'final-acceptance' as const,
    };

    const state = deriveReviewEpisodeState(receipts, relays, episodeAuthority);
    expect(state.errors, state.errors.join('\n')).toEqual([]);
    expect(validateReviewEpisodeTopology(state, 'final-acceptance')).toEqual([]);
    expect(state.receipts.map((item) => item.sourceRevision)).toEqual(['r04', 'r04', 'r06', 'r07']);
    expect(state.receipts[2]?.claude).toMatchObject({
      invocationId: 'claude-r06-invocation',
      producingRunIdentity: 'claude-r06-run',
      terminalResultIdentity: 'claude-r06-terminal',
      producerEvidenceIdentity: 'claude-r06-evidence',
    });

    const terminalBody = '<!-- source-revision: r07 -->\n# #1706 terminal-reviewed bytes';
    const liveR08Body = '<!-- source-revision: r08 -->\n# #1706 bounded corrected bytes';
    const acceptedBodyErrors: string[] = [];
    validateTerminalOneShotBodyBinding(terminalBody, liveR08Body, 'r08', receipts, acceptedBodyErrors);
    expect(acceptedBodyErrors).toEqual([]);

    const r09Errors: string[] = [];
    validateTerminalOneShotBodyBinding(
      terminalBody,
      liveR08Body.replace('source-revision: r08', 'source-revision: r09'),
      'r09',
      receipts,
      r09Errors,
    );
    expect(r09Errors).toContain('post-terminal correction must advance exactly one source revision: reviewed=r07 current=r09');
    expect(receipts).toEqual(preservedHistory);

    const stageTimeState = deriveReviewEpisodeState(receipts, relays, {
      ...episodeAuthority,
      validationPurpose: 'stage-time',
    });
    expect(stageTimeState.errors.join('\n')).toContain('is not independently supplied');
  });
});


describe('Issue #1556 pre-lens architectural-review routing', () => {
  it('preserves immutable routing on every reviewer slot and rejects an omission', () => {
    const prepare = (missingSlot?: string) => {
      const input = fixture({ transportClassification: 'complete' });
      rmSync(input.evidencePath);
      writeGovernedAuthorReply(input.authorReplyPath, {
        sourceRevision: REVISION,
        predecessorStage: 'architectural-review',
      });

      writeFileSync(input.intakePath, JSON.stringify({
        schema: 'tier-intake/v1',
        producer: 'flow-manager',
        taskIdentity: TASK,
        kind: 'fresh',
        priorTier: 'T3',
        firstRevision: REVISION,
        competitiveDecision: 'skipped',
        competitiveRationale: 'competitive review was skipped for this pre-lens attempt',
      }));

      const declaration: ReviewLaneAuthorDeclaration = {
        schema: 'review-lane-change-set/v1',
        owner: 'issue-author',
        entries: [{
          kind: 'exact',
          path: 'scripts/chatgpt-browser-turn/driver.ts',
          behaviors: ['pure-review-lane-selection'],
        }],
      };
      const normalized = normalizeReviewLaneDeclaration(declaration);
      if (normalized.status !== 'usable') throw new Error('routing fixture input must be usable');
      const routing = buildReviewLaneRouting(
        { ...normalized, identity: `${REVISION}:${normalized.identity}` },
        classifyReviewLaneDeclaration(declaration),
        REVISION,
        'architectural-review-attempt',
        'disputed',
      );
      const sourceVerdicts = { '01': 'accept' as const, '02': 'accept' as const, '03': 'accept' as const };
      const settlement = settleReviewLane(routing, sourceVerdicts);
      const sourceVerdictEvidence = Object.fromEntries(input.reviewComments.map((reviewComment, index) => {
        const slot = String(index + 1).padStart(2, '0');
        const name = `pass-01-architectural-review-${slot}.capture.txt`;
        const body = String(reviewComment.body);
        const digest = createHash('sha256').update(body).digest('hex');
        return [slot, {
          producerEvidenceIdentity: `architectural-review-producer-${slot}`,
          captureIdentity: `sha256:${digest}:${name}`,
          terminalClassification: 'complete',
          captureVerified: true,
          digestMatches: true,
          verdictText: 'NO_FINDINGS',
          rawFindingCount: 0,
        }];
      }));
      const reviewLane = {
        routing,
        finalRequiredSlots: settlement.finalRequiredSlots,
        sourceVerdicts,
        sourceVerdictEvidence,
        conflictDecision: settlement.conflictDecision,
        settlement,
      };
      const evidence = JSON.parse(readFileSync(input.reviewEvidencePath, 'utf8')) as Record<string, unknown>;
      evidence.tier = 'T3';
      evidence.policyVersion = 'review-lane-routing/v1';
      evidence.reviewerCardinality = routing.reviewerCardinality;
      evidence.cardinalityConfigIdentity = routing.cardinalityConfigIdentity;
      evidence.reviewLane = reviewLane;
      evidence.invocations = (evidence.invocations as Array<Record<string, unknown>>).map((invocation) => ({
        ...invocation,
        policyVersion: 'review-lane-routing/v1',
        reviewerCardinality: routing.reviewerCardinality,
        cardinalityConfigIdentity: routing.cardinalityConfigIdentity,
        ...(String(invocation.reviewerSlot) === missingSlot ? {} : { reviewLaneRouting: routing }),
      }));
      writeFileSync(input.reviewEvidencePath, JSON.stringify(evidence));

      return {
        input,
        source: transport({ census: [...input.reviewComments, comment(input.body)] }),
        reviewLane,
      };
    };
    const producePreLens = ({ input, source }: ReturnType<typeof prepare>) => produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: input.outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.reviewEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'pre-lens',
      artifactSourceTransport: source,
    });

    const prepared = prepare();
    const result = producePreLens(prepared);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(
      prepared.input.outputDir,
      'stage-completeness-receipt-architectural-review-attempt.json',
    ), 'utf8'));
    expect(receipt).toMatchObject({
      policyVersion: 'review-lane-routing/v1',
      reviewLane: prepared.reviewLane,
    });
    expect(receipt.invocations).toHaveLength(3);
    expect(receipt.invocations.map((invocation: { reviewerSlot: string }) => invocation.reviewerSlot))
      .toEqual(['01', '02', '03']);
    for (const invocation of receipt.invocations) {
      expect(invocation.reviewLaneRouting).toEqual(receipt.reviewLane.routing);
    }

    const lensEvidencePath = join(prepared.input.dir, 'lens-evidence.json');
    writeFileSync(lensEvidencePath, JSON.stringify({
      schema: STAGE_EVIDENCE_SCHEMA,
      tier: 'T3',
      stage: 'architectural-lens',
      stageAttemptId: 'architectural-lens-attempt',
    }));
    const omittedLens = produceAcceptanceArtifacts({
      reviewDir: prepared.input.dir,
      outputDir: prepared.input.outputDir,
      tierIntakePath: prepared.input.intakePath,
      stageEvidencePaths: [prepared.input.reviewEvidencePath],
      authorDispositionsPath: prepared.input.authorPath,
      phase: 'pre-lens',
      artifactSourceTransport: prepared.source,
    });
    expect(omittedLens.ok, omittedLens.errors.join('\n')).toBe(true);
    expect(omittedLens.files).toContain('finding-disposition-ledger.json');

    const passedLens = produceAcceptanceArtifacts({
      reviewDir: prepared.input.dir,
      outputDir: prepared.input.outputDir,
      tierIntakePath: prepared.input.intakePath,
      stageEvidencePaths: [prepared.input.reviewEvidencePath, lensEvidencePath],
      authorDispositionsPath: prepared.input.authorPath,
      phase: 'pre-lens',
      artifactSourceTransport: prepared.source,
    });
    expect(passedLens.ok, passedLens.errors.join('\n')).toBe(true);

    const missingRoute = producePreLens(prepare('02'));
    expect(missingRoute.ok).toBe(false);
    expect(missingRoute.errors.join('\n')).toContain('missing immutable reviewLaneRouting evidence');
  });
});


describe('Issue #1744 two-missing AR waiver production', () => {
  const prepare = (withWaiver: boolean) => {
    const input = fixture({ transportClassification: 'complete' });
    writeGovernedAuthorReply(input.authorReplyPath, {
      sourceRevision: REVISION,
      predecessorStage: 'architectural-review',
    });
    writeFileSync(input.intakePath, JSON.stringify({
      schema: 'tier-intake/v1', producer: 'flow-manager', taskIdentity: TASK, kind: 'fresh', priorTier: 'T3',
      firstRevision: REVISION, competitiveDecision: 'skipped', competitiveRationale: 'competitive review was skipped for pre-lens',
    }));
    rmSync(input.evidencePath);
    const declaration: ReviewLaneAuthorDeclaration = {
      schema: 'review-lane-change-set/v1', owner: 'issue-author', entries: [{
        kind: 'exact', path: 'scripts/chatgpt-browser-turn/driver.ts', behaviors: ['pure-review-lane-selection'],
      }],
    };
    const normalized = normalizeReviewLaneDeclaration(declaration);
    if (normalized.status !== 'usable') throw new Error('waiver fixture input must be usable');
    const routing = buildReviewLaneRouting(
      { ...normalized, identity: `${REVISION}:${normalized.identity}` },
      classifyReviewLaneDeclaration(declaration), REVISION, 'architectural-review-attempt', 'disputed',
    );
    const evidence = JSON.parse(readFileSync(input.reviewEvidencePath, 'utf8')) as Record<string, unknown>;
    const invocations = (evidence.invocations as Array<Record<string, unknown>>).map((invocation) => {
      const slot = String(invocation.reviewerSlot);
      const { capturePath: _capturePath, ...withoutCapture } = invocation;
      return {
        ...withoutCapture,
        policyVersion: 'review-lane-routing/v1', reviewerCardinality: 3,
        cardinalityConfigIdentity: routing.cardinalityConfigIdentity, reviewLaneRouting: routing,
        ...(slot === '01'
          ? { capturePath: invocation.capturePath, retryClass: 'none' }
          : { terminalClassification: 'incident', retryClass: 'retry-forbidden' }),
      };
    });
    const sourceVerdicts = { '01': 'accept' as const };
    const reviewCapturePath = String((invocations[0] as Record<string, unknown>).capturePath);
    const captureName = basename(reviewCapturePath);
    const captureDigest = createHash('sha256').update(readFileSync(reviewCapturePath)).digest('hex');
    const reviewLane = {
      routing, finalRequiredSlots: ['01', '02', '03'], sourceVerdicts,
      sourceVerdictEvidence: { '01': {
        producerEvidenceIdentity: 'architectural-review-producer-01',
        captureIdentity: `sha256:${captureDigest}:${captureName}`, terminalClassification: 'complete',
        captureVerified: true, digestMatches: true, verdictText: 'NO_FINDINGS', rawFindingCount: 0,
      } },
      conflictDecision: 'no-conflict' as const,
      settlement: settleReviewLane(routing, { '01': 'accept', '02': 'accept', '03': 'accept' }),
    };
    Object.assign(evidence, {
      tier: 'T3', policyVersion: 'review-lane-routing/v1', reviewerCardinality: 3,
      cardinalityConfigIdentity: routing.cardinalityConfigIdentity, outcome: 'partial', producerEvidence: 'waived',
      partialMissingSources: [
        { reviewerSlot: '02', invocationId: 'invocation-002', evidenceIdentity: 'terminal-02', reason: 'possible-or-actual send with resend forbidden' },
        { reviewerSlot: '03', invocationId: 'invocation-003', evidenceIdentity: 'terminal-03', reason: 'possible-or-actual send with resend forbidden' },
      ], invocations, reviewLane,
    });
    writeFileSync(input.reviewEvidencePath, JSON.stringify(evidence));
    const waiverPath = join(input.dir, 'ar-successor-operator-waiver.json');
    if (withWaiver) writeFileSync(waiverPath, JSON.stringify({
      schema: 'operator-stage-waiver/v1', stage: 'architectural-review', cycleId: 'cycle-1385',
      stageAttemptId: 'architectural-review-attempt', sourceRevision: REVISION,
      missingSlots: ['02', '03'], reason: 'explicit operator authorization',
    }));
    const source = transport({ census: [...input.reviewComments, comment(input.body)] });
    return { input, source, waiverPath };
  };

  it('admits the live pre-lens partial shape only with the explicit operator waiver', () => {
    const withoutWaiver = prepare(false);
    const rejected = produceAcceptanceArtifacts({
      reviewDir: withoutWaiver.input.dir, outputDir: withoutWaiver.input.outputDir,
      tierIntakePath: withoutWaiver.input.intakePath, stageEvidencePaths: [withoutWaiver.input.reviewEvidencePath],
      authorDispositionsPath: withoutWaiver.input.authorPath, phase: 'pre-lens', artifactSourceTransport: withoutWaiver.source,
    });
    expect(rejected.ok).toBe(false);

    const withWaiver = prepare(true);
    const accepted = produceAcceptanceArtifacts({
      reviewDir: withWaiver.input.dir, outputDir: withWaiver.input.outputDir,
      tierIntakePath: withWaiver.input.intakePath, stageEvidencePaths: [withWaiver.input.reviewEvidencePath],
      authorDispositionsPath: withWaiver.input.authorPath, phase: 'pre-lens', artifactSourceTransport: withWaiver.source,
      waiverPath: withWaiver.waiverPath,
    });
    expect(accepted.ok, accepted.errors.join('\n')).toBe(true);
  });
});


describe('Issue #1484 post-lens ledger production', () => {
  it('includes the settled Claude lens receipt in the ledger before terminal GPT', () => {
    const input = fixture({ transportClassification: 'incident' });
    const intake = JSON.parse(readFileSync(input.intakePath, 'utf8')) as Record<string, unknown>;
    intake.priorTier = 'T3';
    intake.competitiveDecision = 'skipped';
    intake.competitiveRationale = 'competitive review is not needed for this post-lens attempt';
    writeFileSync(input.intakePath, JSON.stringify(intake));

    const reviewEvidence = JSON.parse(readFileSync(input.reviewEvidencePath, 'utf8')) as Record<string, unknown>;
    reviewEvidence.tier = 'T3';
    writeFileSync(input.reviewEvidencePath, JSON.stringify(reviewEvidence));

    const lensCapturePath = join(input.dir, 'pass-02-architectural-lens.capture.txt');
    const lensCapture = [
      'review-economics-contract: v1',
      '',
      '```text',
      'stage: architectural-lens (Claude, single independent lens)',
      '```',
      '',
      ...Array.from({ length: 7 }, (_, index) => [
        '```text',
        'id: lens-finding-' + String(index + 1),
        'type: quality',
        'severity: P1',
        'title: Lens finding ' + String(index + 1),
        'evidence: Observable lens defect.',
        'recommendation: Use the cheapest sufficient correction.',
        'persistent-machinery: no',
        '```',
        '',
      ]).flat(),
      'Example prose follows:',
      '```markdown',
      'id: example-only',
      'type: quality',
      'severity: P1',
      'evidence: This is illustrative prose.',
      'recommendation: Do not count this example.',
      'persistent-machinery: no',
      '```',
      '',
    ].join('\n');
    writeFileSync(lensCapturePath, lensCapture);
    const lensEvidence = {
      schema: STAGE_EVIDENCE_SCHEMA,
      tier: 'T3',
      stage: 'architectural-lens',
      stageAttemptId: 'architectural-lens-attempt',
      stageSequence: 2,
      cycleId: 'cycle-1385',
      cycleBinding: { cycleId: 'cycle-1385', sourceRevision: REVISION, boundBeforeLaunch: true },
      policyVersion: 'single-source/v1',
      reviewerCardinality: 1,
      cardinalityConfigIdentity: CONFIG,
      sourceRevision: REVISION,
      outcome: 'complete',
      revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
      settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
      claude: { kind: 'capture', provider: 'claude-cli', invocationId: 'lens-invocation', producingRunIdentity: 'lens-run', terminalResultIdentity: 'lens-terminal', producerEvidenceIdentity: 'lens-evidence', terminal: true, terminalClassification: 'complete', exitCode: 0, m3Status: 'recorded', capturePath: lensCapturePath },
    };
    writeFileSync(input.evidencePath, JSON.stringify(lensEvidence));
    const lensDigest = createHash('sha256').update(lensCapture).digest('hex');
    const lensIdentity = 'sha256:' + lensDigest + ':pass-02-architectural-lens.capture.txt';
    writeGovernedAuthorReply(input.authorReplyPath, {
      sourceRevision: REVISION,
      predecessorStage: 'architectural-lens',
      findings: Array.from({ length: 7 }, (_, index) => ({
        id: 'lens-finding-' + String(index + 1),
        type: 'quality',
        occurrences: [lensIdentity + ':' + String(index + 1)],
        defectDisposition: 'addressed',
        remedyDisposition: 'accepted',
        'persistent-machinery': 'no',
        simplificationCutCandidate: false,
      })),
    });
    const producerEvidencePath = join(input.dir, 'claude-producer-evidence.json');
    writeFileSync(producerEvidencePath, JSON.stringify([{
      schema: 'claude-producer-evidence/v1',
      evidenceIdentity: 'lens-evidence',
      reviewEpisodeId: input.episode,
      stageAttemptId: 'architectural-lens-attempt',
      sourceRevision: REVISION,
      invocationId: 'lens-invocation',
      producingRunIdentity: 'lens-run',
      terminalResultIdentity: 'lens-terminal',
      terminal: true,
      terminalClassification: 'complete',
      exitCode: 0,
      capture: { captureIdentity: lensIdentity, name: 'pass-02-architectural-lens.capture.txt', byteLength: Buffer.byteLength(lensCapture), sha256: lensDigest, rawFindingCount: 7 },
      m3Status: 'recorded',
    }]));

    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: input.outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.reviewEvidencePath, input.evidencePath],
      authorDispositionsPath: input.authorPath,
      claudeProducerEvidencePaths: [producerEvidencePath],
      artifactSourceTransport: transport({ census: input.reviewComments }),
      phase: 'post-lens',
    });

    expect(result.ok, result.errors.join('\n')).toBe(true);
    const ledger = JSON.parse(readFileSync(join(input.outputDir, 'finding-disposition-ledger.json'), 'utf8'));
    expect(ledger.counts.rawFindingCount).toBe(7);
    const inventory = JSON.parse(readFileSync(join(input.outputDir, 'review-episode-inventory.json'), 'utf8'));
    expect(inventory.stageReceiptIds).toHaveLength(2);
    expect(result.files).toContain('stage-completeness-receipt-architectural-lens-attempt.json');
  });
});


describe('Issue #1973 post-send envelope send_count hydration', () => {
  function sealedEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      schema: 'flow-manager-long-running-child-terminal/v1',
      run_identity: 'run-1973',
      attempt_identity: 'attempt-1973',
      completion_mode: 'browser-turn-result-v1',
      handoff_receipt_path: '/tmp/opk-1973-handoff.json',
      launcher_started_at: '2026-09-21T00:00:00.000Z',
      handoff_committed_at: '2026-09-21T00:00:01.000Z',
      terminal_at: '2026-09-21T00:00:02.000Z',
      lifecycle_outcome: 'incident',
      incident: 'child_terminal_result_missing',
      delivery: 'POSSIBLY_DELIVERED',
      recovery_available: false,
      diagnostics: {
        last_heartbeat: {
          schema: 'observation-heartbeat/v1',
          phase: 'post_send_observation',
          poll_count: 1,
          observation_state: 'busy',
          stable_reads: 0,
          completion_ready: false,
        },
      },
      ...overrides,
    };
  }

  function prepareSealedInvocation(envelope: Record<string, unknown>) {
    const input = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    const envelopePath = join(input.dir, 'envelope.json');
    writeFileSync(envelopePath, JSON.stringify(envelope));
    const evidence = JSON.parse(readFileSync(input.evidencePath, 'utf8')) as Record<string, unknown>;
    const invocation = { ...(evidence.invocations as Array<Record<string, unknown>>)[0] };
    delete invocation.terminal;
    delete invocation.terminalClassification;
    delete invocation.sendCount;
    delete invocation.retryClass;
    delete invocation.turnResultPath;
    delete invocation.terminalResultIdentity;
    invocation.terminalEnvelopePath = envelopePath;
    evidence.invocations = [invocation];
    evidence.taskIdentity = TASK;
    writeFileSync(input.evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    return { input, envelopePath, envelopeBefore: readFileSync(envelopePath) };
  }

  it('hydrates omitted send_count from post_send_observation as post-send-failure without rewriting the envelope', () => {
    const prepared = prepareSealedInvocation(sealedEnvelope());
    const source = transport({ census: [...prepared.input.reviewComments, comment(prepared.input.body)] });
    const reconciled = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.evidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: source,
    });
    expect(reconciled.ok, reconciled.errors.join('\n')).toBe(true);
    const hydrated = JSON.parse(readFileSync(prepared.input.evidencePath, 'utf8')) as {
      invocations: Array<Record<string, unknown>>;
    };
    expect(hydrated.invocations[0]).toMatchObject({
      terminal: true,
      terminalClassification: 'post-send-failure',
      sendCount: 1,
      retryClass: 'retry-forbidden',
    });
    expect(readFileSync(prepared.envelopePath).equals(prepared.envelopeBefore)).toBe(true);
    expect(JSON.stringify(hydrated)).not.toContain('no exact send_count');
  });

  it('still fails closed when omitted send_count has no post_send_observation heartbeat', () => {
    const prepared = prepareSealedInvocation(sealedEnvelope({
      diagnostics: { last_heartbeat: { phase: 'admitted_pre_send', poll_count: 0 } },
    }));
    const source = transport({ census: [...prepared.input.reviewComments, comment(prepared.input.body)] });
    const reconciled = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.evidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: source,
    });
    expect(reconciled.ok).toBe(false);
    expect(reconciled.errors.join('\n')).toContain('no exact send_count');
    expect(readFileSync(prepared.envelopePath).equals(prepared.envelopeBefore)).toBe(true);
  });
});

describe('Issue #1977 evidence-backed zero-send partial reconciliation', () => {
  const incidentInvocationId = '316369ff-5fad-4621-ae02-7c2894a28b53';

  function prepareZeroSend(overrides: Record<string, unknown> = {}) {
    const input = fixture({ phase: 'pre-lens' });
    input.stageEvidencePaths = [input.reviewEvidencePath];
    rmSync(input.evidencePath, { force: true });
    const evidence = JSON.parse(readFileSync(input.reviewEvidencePath, 'utf8')) as Record<string, any>;
    const invocation = evidence.invocations[0] as Record<string, any>;
    invocation.invocationId = incidentInvocationId;
    invocation.terminal = true;
    invocation.terminalClassification = 'incident';
    invocation.sendCount = 0;
    invocation.retryClass = 'retry-forbidden';
    delete invocation.capturePath;
    delete invocation.turnResultPath;
    delete invocation.terminalResultIdentity;
    const envelopePath = join(input.dir, 'terminal-competitive-01-final.json');
    invocation.terminalEnvelopePath = envelopePath;

    const candidateText = JSON.stringify({
      schema: 'turn-result/v1',
      state: 'output_conflict',
      scope: 'invocation',
      cause: 'observation_marker_conflict',
      invocation_id: incidentInvocationId,
      configured_profile_key: 'fixture-profile',
      send_count: 0,
    });
    const identity = `sha256:${createHash('sha256').update(candidateText, 'utf8').digest('hex')}:turn-result-v1`;
    writeFileSync(envelopePath, JSON.stringify({
      schema: 'flow-manager-long-running-child-terminal/v1',
      run_identity: 'run-1977',
      attempt_identity: 'attempt-1977',
      completion_mode: 'browser-turn-result-v1',
      handoff_receipt_path: '/tmp/opk-1977-handoff.json',
      launcher_started_at: '2026-09-21T00:00:00.000Z',
      handoff_committed_at: '2026-09-21T00:00:01.000Z',
      terminal_at: '2026-09-21T00:00:02.000Z',
      lifecycle_outcome: 'incident',
      incident: 'child_turn_state:output_conflict',
      delivery: 'not-sent',
      turn_result_state: 'output_conflict',
      turn_result_cause: 'observation_marker_conflict',
      send_count: 0,
      observed_invocation_id: incidentInvocationId,
      observed_turn_result_identity: identity,
      recovery_available: false,
      ...overrides,
    }));
    evidence.outcome = 'partial';
    evidence.producerEvidence = 'not-applicable';
    evidence.partialMissingSources = [{
      reviewerSlot: '01',
      invocationId: incidentInvocationId,
      evidenceIdentity: identity,
      reason: 'terminal zero-send source is unobservable and blind resend is forbidden',
    }];
    writeFileSync(input.reviewEvidencePath, JSON.stringify(evidence, null, 2) + '\n');
    return {
      input,
      source: transport({ census: input.reviewComments.slice(1) }),
      identity,
    };
  }

  it('reconciles and credentials two GitHub sources plus one proven zero-send missing source', () => {
    const prepared = prepareZeroSend();
    const reconciled = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: prepared.source,
    });
    expect(reconciled.ok, reconciled.errors.join('\n')).toBe(true);
    expect(reconciled.capturePaths).toHaveLength(2);

    const hydrated = JSON.parse(readFileSync(prepared.input.reviewEvidencePath, 'utf8')) as Record<string, any>;
    expect(hydrated.outcome).toBe('partial');
    expect(hydrated.invocations[0]).toMatchObject({
      terminalClassification: 'incident',
      sendCount: 0,
      retryClass: 'retry-forbidden',
      terminalResultIdentity: prepared.identity,
    });
    expect(hydrated.invocations[0]).not.toHaveProperty('artifactAuthority');

    const produced = produceAcceptanceArtifacts({
      reviewDir: prepared.input.dir,
      outputDir: prepared.input.outputDir,
      tierIntakePath: prepared.input.intakePath,
      stageEvidencePaths: [prepared.input.reviewEvidencePath],
      authorDispositionsPath: prepared.input.authorPath,
      phase: 'pre-lens',
      artifactSourceTransport: prepared.source,
    });
    expect(produced.ok, produced.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(
      join(prepared.input.outputDir, 'stage-completeness-receipt-architectural-review-attempt.json'),
      'utf8',
    )) as Record<string, any>;
    expect(receipt.outcome).toBe('partial');
    expect(receipt.credentialingCaptures).toHaveLength(2);
    expect(receipt.partialMissingSources[0]).toMatchObject({
      reviewerSlot: '01',
      invocationId: incidentInvocationId,
      evidenceIdentity: prepared.identity,
    });
  });

  it('rewrites a stored eligible-zero-send second attempt to retry-forbidden and credentials it', () => {
    const prepared = prepareZeroSend();
    const evidence = JSON.parse(readFileSync(prepared.input.reviewEvidencePath, 'utf8')) as Record<string, any>;
    const invocation = evidence.invocations[0] as Record<string, any>;
    invocation.attemptOrdinal = 2;
    invocation.retryAttempt = true;
    invocation.retryClass = 'eligible-zero-send';
    writeFileSync(prepared.input.reviewEvidencePath, JSON.stringify(evidence, null, 2) + '\n');

    const reconciled = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: prepared.source,
    });
    expect(reconciled.ok, reconciled.errors.join('\n')).toBe(true);
    const hydrated = JSON.parse(readFileSync(prepared.input.reviewEvidencePath, 'utf8')) as Record<string, any>;
    expect(hydrated.invocations[0]).toMatchObject({
      attemptOrdinal: 2,
      sendCount: 0,
      retryClass: 'retry-forbidden',
      terminalClassification: 'incident',
      terminalResultIdentity: prepared.identity,
    });
  });

  it('keeps a stored first-attempt eligible-zero-send class', () => {
    const prepared = prepareZeroSend();
    const evidence = JSON.parse(readFileSync(prepared.input.reviewEvidencePath, 'utf8')) as Record<string, any>;
    const invocation = evidence.invocations[0] as Record<string, any>;
    invocation.attemptOrdinal = 1;
    invocation.retryClass = 'eligible-zero-send';
    writeFileSync(prepared.input.reviewEvidencePath, JSON.stringify(evidence, null, 2) + '\n');

    const result = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: prepared.source,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('retryClass=eligible-zero-send');
    const stored = JSON.parse(readFileSync(prepared.input.reviewEvidencePath, 'utf8')) as Record<string, any>;
    expect(stored.invocations[0].retryClass).toBe('eligible-zero-send');
  });

  it('rejects a stored eligible-zero-send second attempt that lacks terminal result identity', () => {
    const prepared = prepareZeroSend({ observed_turn_result_identity: '' });
    const evidence = JSON.parse(readFileSync(prepared.input.reviewEvidencePath, 'utf8')) as Record<string, any>;
    const invocation = evidence.invocations[0] as Record<string, any>;
    invocation.attemptOrdinal = 2;
    invocation.retryAttempt = true;
    invocation.retryClass = 'eligible-zero-send';
    writeFileSync(prepared.input.reviewEvidencePath, JSON.stringify(evidence, null, 2) + '\n');

    const result = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: prepared.source,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('lacks a valid observed turn-result identity');
  });

  it('keeps an unsealed first-attempt zero-send incident retry-eligible under current-main policy', () => {
    const prepared = prepareZeroSend();
    const evidence = JSON.parse(readFileSync(prepared.input.reviewEvidencePath, 'utf8')) as Record<string, any>;
    const invocation = evidence.invocations[0] as Record<string, any>;
    delete invocation.terminal;
    delete invocation.terminalClassification;
    delete invocation.sendCount;
    delete invocation.retryClass;
    writeFileSync(prepared.input.reviewEvidencePath, JSON.stringify(evidence, null, 2) + '\n');

    const result = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: prepared.source,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('retryClass=eligible-zero-send');
  });

  it('fails closed on a foreign observed invocation id', () => {
    const prepared = prepareZeroSend({ observed_invocation_id: 'foreign-invocation' });
    const result = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: prepared.source,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('observed_invocation_id does not match admitted invocationId');
  });

  it('does not accept an envelope hash as observed turn-result identity', () => {
    const prepared = prepareZeroSend({
      observed_turn_result_identity: `sha256:${'a'.repeat(64)}:terminal-envelope.json`,
    });
    const result = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: prepared.source,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('lacks a valid observed turn-result identity');
  });
});

describe('proven zero-send first attempts are retry-eligible (Issue #1981)', () => {
  const zeroSendIncident = {
    lifecycle_outcome: 'incident',
    turn_result_state: 'input_invalid',
    turn_result_cause: 'input_invalid:invocation_id_invalid',
    send_count: 0,
    delivery: 'not-sent',
  };

  it('classifies a first-attempt input_invalid zero-send as incident / eligible-zero-send', () => {
    expect(classifyReconciliationTransport(zeroSendIncident, 1)).toEqual({
      terminalClassification: 'incident',
      sendCount: 0,
      retryClass: 'eligible-zero-send',
    });
  });

  it('forbids retry when the same envelope is attempt 2', () => {
    expect(classifyReconciliationTransport(zeroSendIncident, 2)).toEqual({
      terminalClassification: 'incident',
      sendCount: 0,
      retryClass: 'retry-forbidden',
    });
  });

  it.each([
    ['canonical_prompt_mismatch:expected_sha256=abc', 'driver_error'],
    ['observation_marker_conflict', 'driver_error'],
  ])('classifies %s at sendCount 0 as incident / eligible-zero-send', (cause, state) => {
    expect(classifyReconciliationTransport({
      ...zeroSendIncident,
      turn_result_state: state,
      turn_result_cause: cause,
    }, 1)).toEqual({
      terminalClassification: 'incident',
      sendCount: 0,
      retryClass: 'eligible-zero-send',
    });
  });

  it('keeps sendCount 1 driver_error as post-send-failure / retry-forbidden', () => {
    expect(classifyReconciliationTransport({
      lifecycle_outcome: 'incident',
      turn_result_state: 'driver_error',
      turn_result_cause: 'driver_error',
      send_count: 1,
      delivery: 'sent',
    }, 1)).toEqual({
      terminalClassification: 'post-send-failure',
      sendCount: 1,
      retryClass: 'retry-forbidden',
    });
  });

  it('returns null when send_count is omitted without a post_send_observation heartbeat', () => {
    expect(classifyReconciliationTransport({
      lifecycle_outcome: 'incident',
      turn_result_state: 'input_invalid',
      turn_result_cause: 'input_invalid:invocation_id_invalid',
      delivery: 'not-sent',
    }, 1)).toBeNull();
  });
});

describe('governed author disposition block shapes (Issue #1983)', () => {
  const fenceless1978R02Path = join(
    fileURLToPath(new URL('../..', import.meta.url)),
    'tests/external-output-references/create-issue-author-reply-fenceless-1978-r02.txt',
  );

  it('AC1: locates and parses the verbatim fenceless 1978-r02 harvest', () => {
    const fixtureText = readFileSync(fenceless1978R02Path, 'utf8');
    const located = locateGovernedAuthorDispositionBlock(fixtureText);
    expect(located).toEqual(expect.objectContaining({ body: expect.any(String) }));
    if (!('body' in located)) throw new Error('expected a located body');
    const parsed = JSON.parse(located.body) as {
      schema: string;
      sourceRevision: string;
      findings: unknown[];
    };
    expect(parsed.schema).toBe('create-issue-author-dispositions/v1');
    expect(parsed.sourceRevision).toBe('r02');
    expect(parsed.findings).toHaveLength(5);
  });

  it('AC2: the fenced wrap of the same harvest locates to JSON deep-equal with AC1', () => {
    const fixtureText = readFileSync(fenceless1978R02Path, 'utf8');
    const fencelessLocated = locateGovernedAuthorDispositionBlock(fixtureText);
    if (!('body' in fencelessLocated)) throw new Error('expected a located body');
    const fixtureWithoutFirstLine = fixtureText.slice(fixtureText.indexOf('\n') + 1);
    const fenced = '```create-issue-author-dispositions/v1\n' + fixtureWithoutFirstLine + '\n```';
    const fencedLocated = locateGovernedAuthorDispositionBlock(fenced);
    if (!('body' in fencedLocated)) throw new Error('expected a located fenced body');
    expect(JSON.parse(fencedLocated.body)).toEqual(JSON.parse(fencelessLocated.body));
  });

  it('AC3: locates and parses the #1968 prose-then-fenced single-line JSON shape', () => {
    const json = JSON.stringify({
      schema: AUTHOR_DISPOSITIONS_SCHEMA,
      sourceRevision: REVISION,
      predecessorStage: 'architectural',
      findings: [],
      m4: { inventory: [] },
    });
    const text = ['Governed author output:', '', '```create-issue-author-dispositions/v1', json, '```', ''].join('\n');
    const located = locateGovernedAuthorDispositionBlock(text);
    if (!('body' in located)) throw new Error('expected a located body');
    expect(JSON.parse(located.body)).toEqual(JSON.parse(json));
  });

  it('AC4: two block-start lines are rejected as multiple', () => {
    const json = '{"schema":"create-issue-author-dispositions/v1"}';
    const twoBare = ['create-issue-author-dispositions/v1', json, 'create-issue-author-dispositions/v1', json].join('\n');
    expect(locateGovernedAuthorDispositionBlock(twoBare)).toEqual({ error: 'multiple' });
    const fencedPlusBare = [
      '```create-issue-author-dispositions/v1',
      json,
      '```',
      'create-issue-author-dispositions/v1',
      json,
    ].join('\n');
    expect(locateGovernedAuthorDispositionBlock(fencedPlusBare)).toEqual({ error: 'multiple' });
  });

  it('AC5: a bare label followed by non-JSON fails JSON.parse on the located body and inspect path', () => {
    const located = locateGovernedAuthorDispositionBlock('create-issue-author-dispositions/v1\nnot json\n');
    expect(located).toEqual(expect.objectContaining({ body: 'not json' }));
    if (!('body' in located)) throw new Error('expected a located body');
    expect(() => JSON.parse(located.body)).toThrow();
    const input = fixture({ transportClassification: 'incident' });
    writeFileSync(input.authorReplyPath, 'create-issue-author-dispositions/v1\nnot json\n');
    const authorReason = inspect(input).missing.find((item) => item.artifact === 'governed author output')?.reason ?? '';
    expect(authorReason).toContain('governed author disposition block is malformed JSON');
    expect(authorReason).toContain('authority=author-owned');
  });

  it('AC6: a schema field without a block-start line is none', () => {
    expect(locateGovernedAuthorDispositionBlock('{"schema":"create-issue-author-dispositions/v1"}')).toEqual({ error: 'none' });
  });

  it('produce-artifacts accepts a fenceless harvested author reply', () => {
    const input = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    writeFileSync(input.authorReplyPath, [
      'create-issue-author-dispositions/v1',
      JSON.stringify({
        schema: AUTHOR_DISPOSITIONS_SCHEMA,
        sourceRevision: REVISION,
        predecessorStage: 'architectural',
        findings: [],
        m4: { inventory: [] },
      }),
      '',
    ].join('\n'));
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });
});

describe('Issue #2009 canonical plural capture verdicts', () => {
  function pluralBody(verdict: string): string {
    return canonicalFindingsVerdict().replace('VERDICT: FINDINGS', `VERDICT: ${verdict}`);
  }

  it('accepts a plural-finding capture whose sole verdict is FINDINGS or NEEDS_ATTENTION', () => {
    expect(parseCanonicalCaptureRevision(pluralBody('FINDINGS'))).toEqual({
      issueNumber: ISSUE,
      sourceRevision: REVISION,
      findingCount: 2,
    });
    expect(parseCanonicalCaptureRevision(pluralBody('NEEDS_ATTENTION'))).toEqual({
      issueNumber: ISSUE,
      sourceRevision: REVISION,
      findingCount: 2,
    });
  });

  it('rejects a plural-finding capture whose sole verdict is any other token', () => {
    expect(parseCanonicalCaptureRevision(pluralBody('BLOCKED'))).toBeNull();
    expect(parseCanonicalCaptureRevision(pluralBody('CLEAN'))).toBeNull();
  });

  it('still accepts a plural-finding capture with no verdict line', () => {
    expect(parseCanonicalCaptureRevision(PUBLISHED_FINDINGS_WITHOUT_VERDICT)).toMatchObject({
      issueNumber: 1777,
      sourceRevision: 'r03',
      findingCount: 1,
    });
  });

  it('credentials VERDICT: NEEDS_ATTENTION the same way as VERDICT: FINDINGS', () => {
    const body = pluralBody('NEEDS_ATTENTION');
    const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: body });
    const result = produce(input, transport({
      census: [...input.reviewComments, comment(body, { issueNumber: input.issueNumber })],
      issueNumber: input.issueNumber,
    }));
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('does not credential a plural capture with another verdict token', () => {
    const body = pluralBody('BLOCKED');
    const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: body });
    const result = produce(input, transport({
      census: [...input.reviewComments, comment(body, { issueNumber: input.issueNumber })],
      issueNumber: input.issueNumber,
    }));
    expect(result.ok).toBe(false);
  });
});

describe('Issue #2010 settled receipt sourceVerdicts recovery', () => {
  const DISAGREE = 'routed review record sourceVerdicts disagree with producer evidence';

  function prepareRoutedReceipt(mutate: (reviewLane: {
    sourceVerdicts: Record<string, 'accept' | 'material-findings'>;
    sourceVerdictEvidence: Record<string, Record<string, unknown>>;
  }) => void) {
    const input = fixture({ transportClassification: 'complete' });
    const declaration: ReviewLaneAuthorDeclaration = {
      schema: 'review-lane-change-set/v1',
      owner: 'issue-author',
      entries: [{
        kind: 'exact',
        path: 'scripts/chatgpt-browser-turn/driver.ts',
        behaviors: ['pure-review-lane-selection'],
      }],
    };
    const normalized = normalizeReviewLaneDeclaration(declaration);
    if (normalized.status !== 'usable') throw new Error('routing fixture input must be usable');
    const routing = buildReviewLaneRouting(
      { ...normalized, identity: `${REVISION}:${normalized.identity}` },
      classifyReviewLaneDeclaration(declaration),
      REVISION,
      'architectural-review-attempt',
      'disputed',
    );
    const sourceVerdicts = { '01': 'accept' as const, '02': 'accept' as const, '03': 'accept' as const };
    const sourceVerdictEvidence = Object.fromEntries(input.reviewComments.map((reviewComment, index) => {
      const slot = String(index + 1).padStart(2, '0');
      const name = `pass-01-architectural-review-${slot}.capture.txt`;
      const body = String(reviewComment.body);
      const digest = createHash('sha256').update(body).digest('hex');
      return [slot, {
        producerEvidenceIdentity: `architectural-review-producer-${slot}`,
        captureIdentity: `sha256:${digest}:${name}`,
        terminalClassification: 'complete',
        captureVerified: true,
        digestMatches: true,
        verdictText: 'NO_FINDINGS',
        rawFindingCount: 0,
      }];
    }));
    const settlement = settleReviewLane(routing, sourceVerdicts);
    const reviewLane = {
      routing,
      finalRequiredSlots: settlement.finalRequiredSlots,
      sourceVerdicts,
      sourceVerdictEvidence,
      conflictDecision: settlement.conflictDecision,
      settlement,
    };
    mutate(reviewLane);
    const receipt = {
      schema: 'stage-completeness-receipt/v1',
      stage: 'architectural-review',
      stageAttemptId: 'architectural-review-attempt',
      reviewLane,
    };
    const receiptPath = join(input.dir, 'stage-completeness-receipt-architectural-review-attempt.json');
    const originalBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    writeFileSync(receiptPath, originalBytes);
    return { input, receiptPath, originalBytes };
  }

  it('rebuilds a same-stageAttemptId receipt whose sourceVerdicts disagree with complete producer evidence', () => {
    const prepared = prepareRoutedReceipt((reviewLane) => {
      reviewLane.sourceVerdicts = { '01': 'material-findings', '02': 'accept', '03': 'accept' };
    });
    const result = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: transport(),
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.alreadySettled).not.toBe(true);
    const receipt = JSON.parse(readFileSync(prepared.receiptPath, 'utf8')) as { reviewLane: { sourceVerdicts: Record<string, string> } };
    expect(validateReviewLaneRecord(receipt.reviewLane)).toEqual({ ok: true, errors: [] });
    expect(receipt.reviewLane.sourceVerdicts).toEqual({ '01': 'accept', '02': 'accept', '03': 'accept' });
  });

  it('leaves an already-matching settled receipt untouched', () => {
    const prepared = prepareRoutedReceipt(() => {});
    const result = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: transport(),
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.alreadySettled).toBe(true);
    expect(readFileSync(prepared.receiptPath).equals(prepared.originalBytes)).toBe(true);
  });

  it('fails closed when producer evidence cannot rebuild the routed record', () => {
    const prepared = prepareRoutedReceipt((reviewLane) => {
      delete reviewLane.sourceVerdictEvidence['03'];
    });
    const result = reconcileCreateIssueStage({
      reviewDir: prepared.input.dir,
      stageEvidencePath: prepared.input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: transport(),
    });
    expect(result.ok).toBe(false);
    expect(result.alreadySettled).not.toBe(true);
    expect(result.errors).toContain(DISAGREE);
    expect(readFileSync(prepared.receiptPath).equals(prepared.originalBytes)).toBe(true);
    const receipt = JSON.parse(readFileSync(prepared.receiptPath, 'utf8')) as {
      reviewLane: { sourceVerdicts: Record<string, string>; sourceVerdictEvidence: Record<string, unknown> };
    };
    expect(receipt.reviewLane.sourceVerdictEvidence['03']).toBeUndefined();
    expect(receipt.reviewLane.sourceVerdicts['03']).toBe('accept');
  });
});

describe('Issue #2017 routed missing-slot recovery', () => {
  it('binds an empty routed slot from tier-intake and reconciles a consistent artifact verdict', () => {
    const input = fixture();
    const declaration: ReviewLaneAuthorDeclaration = {
      schema: 'review-lane-change-set/v1',
      owner: 'issue-author',
      entries: [{ kind: 'exact', path: 'scripts/lib/create-issue-stage-record-artifacts.ts', behaviors: ['published-comment-bind'] }],
    };
    const normalized = normalizeReviewLaneDeclaration(declaration);
    if (normalized.status !== 'usable') throw new Error(normalized.status);
    const routing = buildReviewLaneRouting(
      { ...normalized, identity: `${REVISION}:${normalized.identity}` },
      classifyReviewLaneDeclaration(declaration),
      REVISION,
      'attempt-001',
      'normal',
    );
    const slotIds = ['published-slot-01', 'published-slot-02', 'published-slot-03'] as const;
    const bodyFor = (id: string) => [
      `Read revision: #${ISSUE} ${REVISION}`,
      `INVOCATION_ID_TO_ECHO: ${id}`,
      'review-economics-contract: v1',
      'VERDICT: CLEAN',
      'NO_FINDINGS',
      'SIMPLIFICATION_CLEAN',
      'FINDING_COUNT: 0',
      '',
    ].join('\n');
    const comments = slotIds.map((id, index) => comment(bodyFor(id), { id: COMMENT_ID + 11 + index }));
    const evidence = {
      schema: STAGE_EVIDENCE_SCHEMA,
      producer: 'create-issue-stage-finalize/start-cycle',
      taskIdentity: TASK,
      tier: 'T3',
      stage: 'architectural-review',
      stageAttemptId: 'attempt-001',
      stageSequence: 1,
      cycleId: 'cycle-2017',
      cycleBinding: { cycleId: 'cycle-2017', sourceRevision: REVISION, boundBeforeLaunch: true },
      policyVersion: 'review-lane-routing/v1',
      reviewerCardinality: routing.reviewerCardinality,
      cardinalityConfigIdentity: routing.cardinalityConfigIdentity,
      sourceRevision: REVISION,
      reviewLaneRouting: routing,
      invocations: [],
    };
    writeFileSync(input.reviewEvidencePath, JSON.stringify(evidence, null, 2) + '\n');
    const source = transport({ census: comments });
    for (const [index, id] of slotIds.entries()) {
      const slot = String(index + 1).padStart(2, '0');
      const reviewComment = comments[index]!;
      const bound = bindPublishedCommentToSlot({
        reviewDir: input.dir,
        stageEvidencePath: input.reviewEvidencePath,
        repositoryFullName: REPOSITORY,
        issueNumber: ISSUE,
        reviewerSlot: slot,
        invocationId: id,
        commentUrl: String(reviewComment.html_url),
        artifactSourceTransport: source,
      });
      expect(bound.ok, bound.errors.join('\n')).toBe(true);
    }
    const boundEvidence = JSON.parse(readFileSync(input.reviewEvidencePath, 'utf8')) as {
      invocations: Array<Record<string, unknown>>;
    };
    expect(boundEvidence.invocations.map((row) => row.reviewEpisodeId)).toEqual(slotIds.map(() => `${TASK}@${REVISION}`));
    for (const name of readdirSync(input.dir)) {
      if (name.endsWith('.capture.txt')) rmSync(join(input.dir, name));
    }
    const reconciled = reconcileCreateIssueStage({
      reviewDir: input.dir,
      stageEvidencePath: input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      artifactSourceTransport: source,
    });
    expect(reconciled.ok, reconciled.errors.join('\n')).toBe(true);
    const stored = JSON.parse(readFileSync(input.reviewEvidencePath, 'utf8')) as {
      reviewLane: { sourceVerdicts: Record<string, string>; sourceVerdictEvidence: Record<string, { terminalClassification: string }> };
      completedSourceCount?: number;
    };
    expect(stored.reviewLane.sourceVerdicts['01']).toBe('accept');
    expect(stored.reviewLane.sourceVerdicts['02']).toBe('accept');
    expect(stored.reviewLane.sourceVerdicts['03']).toBe('accept');
    expect(stored.reviewLane.sourceVerdictEvidence['01'].terminalClassification).toBe('complete');
    expect(stored.reviewLane.sourceVerdictEvidence['02'].terminalClassification).toBe('complete');
    expect(validateReviewLaneRecord(stored.reviewLane).ok).toBe(true);
    const parsed = parseConsumableStageReceipt({ ...stored, completedSourceCount: 3 });
    expect(parsed.errors, parsed.errors.join('\n')).toEqual([]);
    expect(parsed.receipt).not.toBeNull();
  });
});

describe('Issue #2040 canonical invocation echo position', () => {
  const otherSlot = { reviewerSlot: '02', invocationId: 'published-slot-02', marker: 'untouched' };

  function canonicalBody(options: {
    issueNumber?: number;
    revision?: string;
    invocationId?: string;
    echoPlacement?: 'third-non-empty' | 'later' | 'missing' | 'duplicate' | 'different';
    canonical?: boolean;
  } = {}): string {
    const issueNumber = options.issueNumber ?? ISSUE;
    const revision = options.revision ?? REVISION;
    const invocationId = options.invocationId ?? 'published-slot-01';
    const echo = `INVOCATION_ID_TO_ECHO: ${invocationId}`;
    const contract = 'review-economics-contract: v1';
    const tail = options.canonical === false ? [] : ['NO_FINDINGS', 'SIMPLIFICATION_CLEAN', 'FINDING_COUNT: 0'];
    const placement = options.echoPlacement ?? 'third-non-empty';
    const lines = [`Read revision: #${issueNumber} ${revision}`, contract];
    if (placement === 'third-non-empty' || placement === 'duplicate') lines.push(echo);
    if (placement === 'duplicate') lines.push(echo);
    if (placement === 'different') lines.push('INVOCATION_ID_TO_ECHO: other-invocation');
    if (placement === 'later') lines.push(...tail, echo);
    else lines.push(...tail);
    lines.push('');
    return lines.join('\n');
  }

  function bindSlot(body: string, commentOverrides: Record<string, unknown> = {}, principal?: string) {
    const input = fixture();
    const evidence = {
      schema: STAGE_EVIDENCE_SCHEMA,
      producer: 'create-issue-stage-finalize/start-cycle',
      taskIdentity: TASK,
      tier: 'T3',
      stage: 'architectural-review',
      stageAttemptId: 'attempt-001',
      stageSequence: 1,
      cycleId: 'cycle-2040',
      cycleBinding: { cycleId: 'cycle-2040', sourceRevision: REVISION, boundBeforeLaunch: true },
      policyVersion: 'review-lane-routing/v1',
      reviewerCardinality: 1,
      cardinalityConfigIdentity: CONFIG,
      sourceRevision: REVISION,
      invocations: [otherSlot],
    };
    writeFileSync(input.reviewEvidencePath, JSON.stringify(evidence, null, 2) + '\n');
    const before = readFileSync(input.reviewEvidencePath, 'utf8');
    const reviewComment = comment(body, { id: COMMENT_ID + 40, ...commentOverrides });
    const source = transport({ census: [reviewComment], ...(principal === undefined ? {} : { principal }) });
    const bound = bindPublishedCommentToSlot({
      reviewDir: input.dir,
      stageEvidencePath: input.reviewEvidencePath,
      repositoryFullName: REPOSITORY,
      issueNumber: ISSUE,
      reviewerSlot: '01',
      invocationId: 'published-slot-01',
      commentUrl: String(reviewComment.html_url),
      artifactSourceTransport: source,
    });
    const after = readFileSync(input.reviewEvidencePath, 'utf8');
    return { bound, before, after };
  }

  it('binds when the invocation echo is the third non-empty line and leaves the other slot unchanged', () => {
    const { bound, after } = bindSlot(canonicalBody({ echoPlacement: 'third-non-empty' }));
    expect(bound.ok, bound.errors.join('\n')).toBe(true);
    const stored = JSON.parse(after) as { invocations: Array<Record<string, unknown>> };
    const named = stored.invocations.find((row) => row.reviewerSlot === '01');
    expect(named).toMatchObject({ invocationId: 'published-slot-01', sendCount: 1 });
    expect(stored.invocations.find((row) => row.reviewerSlot === '02')).toEqual(otherSlot);
  });

  it('binds when the invocation echo appears later in an otherwise canonical body', () => {
    const { bound, after } = bindSlot(canonicalBody({ echoPlacement: 'later' }));
    expect(bound.ok, bound.errors.join('\n')).toBe(true);
    const stored = JSON.parse(after) as { invocations: Array<Record<string, unknown>> };
    expect(stored.invocations.find((row) => row.reviewerSlot === '01')?.invocationId).toBe('published-slot-01');
    expect(stored.invocations.find((row) => row.reviewerSlot === '02')).toEqual(otherSlot);
  });

  it.each([
    ['wrong issue', { issueNumber: ISSUE + 1 }],
    ['wrong revision', { revision: 'r99' }],
    ['missing invocation echo', { echoPlacement: 'missing' as const }],
    ['duplicate invocation echo', { echoPlacement: 'duplicate' as const }],
    ['different invocation echo', { echoPlacement: 'different' as const }],
  ])('fails and writes nothing for a %s', (_label, overrides) => {
    const { bound, before, after } = bindSlot(canonicalBody({ echoPlacement: 'third-non-empty', ...overrides }));
    expect(bound.ok).toBe(false);
    expect(after).toBe(before);
  });

  it.each([
    ['foreign publisher', { user: { login: 'foreign-publisher' } }, {}],
    ['edited comment', { updated_at: '2026-08-07T05:00:00Z' }, {}],
    ['noncanonical payload', {}, { canonical: false }],
  ])('fails and writes nothing for a %s', (_label, commentOverrides, bodyOverrides) => {
    const { bound, before, after } = bindSlot(
      canonicalBody({ echoPlacement: 'third-non-empty', ...bodyOverrides }),
      commentOverrides,
    );
    expect(bound.ok).toBe(false);
    expect(after).toBe(before);
  });

  it('fails and writes nothing when a noncanonical payload still has the invocation echo on the second line', () => {
    const body = [
      `Read revision: #${ISSUE} ${REVISION}`,
      'INVOCATION_ID_TO_ECHO: published-slot-01',
      'review-economics-contract: v1',
      '',
    ].join('\n');
    const { bound, before, after } = bindSlot(body);
    expect(bound.ok).toBe(false);
    expect(after).toBe(before);
  });

  it('binds a canonical comment published by the authenticated principal when that principal is not the repository owner', () => {
    const { bound, after } = bindSlot(
      canonicalBody({ echoPlacement: 'third-non-empty' }),
      { user: { login: 'binding-principal' } },
      'binding-principal',
    );
    expect(bound.ok, bound.errors.join('\n')).toBe(true);
    const stored = JSON.parse(after) as { invocations: Array<Record<string, unknown>> };
    expect(stored.invocations.find((row) => row.reviewerSlot === '01')?.invocationId).toBe('published-slot-01');
    expect(stored.invocations.find((row) => row.reviewerSlot === '02')).toEqual(otherSlot);
  });

});

describe('cause-classed zero-send continuation (Issue #1999)', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const fixtureDir = join(repoRoot, 'tests/external-output-references');
  const fixtureNames = [
    'create-issue-926-terminal-competitive-01.json',
    'create-issue-926-terminal-competitive-01-final.json',
    'create-issue-witness-conflict-existing-artifact.json',
    'create-issue-1977-poisoned-canonical-attempt.json',
  ];
  const binding: CreateIssueActionBinding = {
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 926,
    sourceRevision: 'r04',
    stage: 'competitive',
    stageAttemptId: '926-competitive-attempt',
  };

  function loadFixture(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as Record<string, unknown>;
  }

  function project(envelope: Record<string, unknown>, attemptOrdinal: number, freshInvocationId?: string) {
    const policy = classifyZeroSendCausePolicy(envelope);
    return projectZeroSendManagerResult({
      policy,
      attemptOrdinal,
      binding,
      invocationId: 'fixture-invocation',
      reviewerSlot: '01',
      owned_prompt_seen: typeof (envelope.observation_uncertainty_diagnostics as { owned_prompt_seen?: boolean } | undefined)?.owned_prompt_seen === 'boolean'
        ? (envelope.observation_uncertainty_diagnostics as { owned_prompt_seen: boolean }).owned_prompt_seen
        : undefined,
      observed_user_heads: Array.isArray((envelope.observation_uncertainty_diagnostics as { observed_user_heads?: unknown } | undefined)?.observed_user_heads)
        ? (envelope.observation_uncertainty_diagnostics as { observed_user_heads: string[] }).observed_user_heads
        : undefined,
      pacedRetryAction: existingPacedBoundedRetryAction(binding, '01'),
      freshInvocationId,
    });
  }

  it('keeps the four scrubbed fixtures free of chat URLs, cookies, tokens, secrets, and local paths', () => {
    const forbidden = /chatgpt\.com|cookie|token|secret|\/home\/|\/tmp\//i;
    for (const name of fixtureNames) {
      const text = readFileSync(join(fixtureDir, name), 'utf8');
      expect(text, name).not.toMatch(forbidden);
    }
  });

  it('classifies the #926 input_invalid envelope as deterministic-input and keeps #1981 retry class', () => {
    const envelope = loadFixture('create-issue-926-terminal-competitive-01.json');
    expect(classifyZeroSendCausePolicy(envelope)).toEqual({
      class: 'deterministic-input',
      code: 'input_invalid',
      rawCause: 'input_invalid:invocation_id_invalid',
    });
    expect(classifyReconciliationTransport(envelope, 1)).toEqual({
      terminalClassification: 'incident',
      sendCount: 0,
      retryClass: 'eligible-zero-send',
    });
    expect(classifyReconciliationTransport(envelope, 2)).toMatchObject({ retryClass: 'retry-forbidden' });
    const projected = project(envelope, 1, 'fresh-invocation-id');
    expect(projected).toMatchObject({
      ok: false,
      cause: 'input_invalid',
      blocker: 'input_invalid:invocation_id_invalid',
      nextAction: null,
      reason: {
        class: 'deterministic-input',
        code: 'input_invalid',
        rawCause: 'input_invalid:invocation_id_invalid',
        binding,
      },
    });
    expect(JSON.stringify(projected)).not.toContain('fresh-invocation-id');
  });

  it('classifies the #926 marker-conflict envelope from observable diagnostics only', () => {
    const envelope = loadFixture('create-issue-926-terminal-competitive-01-final.json');
    expect(classifyZeroSendCausePolicy(envelope)).toEqual({
      class: 'state-conflict',
      code: 'marker_conflict',
      rawCause: 'observation_marker_conflict',
    });
    const projected = project(envelope, 1);
    expect(projected).toMatchObject({
      nextAction: null,
      reason: {
        class: 'state-conflict',
        code: 'marker_conflict',
        rawCause: 'observation_marker_conflict',
        owned_prompt_seen: false,
        observed_user_heads: ['FOREIGN'],
      },
    });
    expect(JSON.stringify(projected)).not.toContain('comment');
  });

  it.each([
    ['quota', 'quota'],
    ['rate_limit', 'rate_limit'],
    ['composer-refusal', 'composer-refusal'],
    ['fill-timeout', 'fill-timeout'],
    ['chrome_not_running', 'chrome_not_running'],
  ])('uses the existing paced retry once for observable %s', (cause, code) => {
    const envelope = {
      schema: 'turn-result/v1',
      state: cause,
      cause,
      send_count: 0,
    };
    const policy = classifyZeroSendCausePolicy(envelope);
    expect(policy).toEqual({ class: 'transient', code, rawCause: cause });
    const action = existingPacedBoundedRetryAction(binding, '01');
    expect(action.kind).toBe('retry-create-issue-browser-preflight');
    expect(action.binding.stageAttemptId).toBe(binding.stageAttemptId);
    expect(action.argv).toContain('--stage-attempt-id');
    expect(action.argv).toContain(binding.stageAttemptId!);
    const projected = projectZeroSendManagerResult({
      policy,
      attemptOrdinal: 1,
      binding,
      reviewerSlot: '01',
      pacedRetryAction: action,
    });
    expect(projected).toEqual({
      ok: false,
      cause: code,
      blocker: cause,
      nextAction: action,
    });
    const second = projectZeroSendManagerResult({
      policy,
      attemptOrdinal: 2,
      binding,
      reviewerSlot: '01',
      pacedRetryAction: action,
    });
    expect(second).toMatchObject({ nextAction: null, reason: { class: 'transient', code } });
  });

  it('does not admit child_start_failed or browser process spawn failure', () => {
    for (const cause of ['child_start_failed', 'browser process spawn failure']) {
      const envelope = {
        schema: 'turn-result/v1',
        state: 'driver_error',
        cause,
        send_count: 0,
      };
      expect(classifyZeroSendCausePolicy(envelope)).toBeNull();
      expect(project(envelope, 1)).toBeNull();
    }
  });

  it('keeps an existing-artifact witness conflict off the zero-send retry path', () => {
    const fixture = loadFixture('create-issue-witness-conflict-existing-artifact.json');
    expect(classifyZeroSendCausePolicy(fixture)).toBeNull();
    expect(reconcileStageReadIsRetryable({
      errors: [`${String(fixture.conflict)}: ${String(fixture.existingCaptureName)}`],
    })).toBe(false);
  });

  it('reads the #1977 poisoned canonical attempt without changing its stageAttemptId', () => {
    const observed = readEvidenceZeroSendTerminal(join(fixtureDir, 'create-issue-1977-poisoned-canonical-attempt.json'));
    expect(observed).toMatchObject({
      stageAttemptId: '1977-poisoned-canonical-attempt',
      sourceRevision: 'r04',
      stage: 'competitive',
      attemptOrdinal: 1,
      policy: {
        class: 'deterministic-input',
        code: 'input_invalid',
        rawCause: 'input_invalid:invocation_id_invalid',
      },
      invocationId: '1977-deterministic-invocation',
      reviewerSlot: '01',
    });
  });
});

describe('Issue #2028 reviewer-stage author reply gate', () => {
  it('produces reviewer-stage artifacts when a predecessor exists and round-NN-author-reply is absent', () => {
    const input = fixture({ phase: 'pre-lens' });
    rmSync(input.authorReplyPath);
    rmSync(input.evidencePath);
    input.stageEvidencePaths = [input.reviewEvidencePath];
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.files).toContain('stage-completeness-receipt-architectural-review-attempt.json');
    expect(result.files).not.toContain('finding-disposition-ledger.json');
    expect(existsSync(input.authorPath)).toBe(false);
    expect(existsSync(join(input.outputDir, 'finding-disposition-ledger.json'))).toBe(false);
    const receiptText = readFileSync(join(input.outputDir, 'stage-completeness-receipt-architectural-review-attempt.json'), 'utf8');
    expect(receiptText).not.toContain('"findings"');
    expect(receiptText).not.toContain('"m4"');
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: input.outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: input.stageEvidencePaths,
      authorDispositionsPath: input.authorPath,
      phase: 'pre-lens',
    });
    expect(status.ok, status.missing.map((item) => item.reason).join('\n')).toBe(true);
    expect(status.missing.some((item) => item.reason.includes('round-NN-author-reply'))).toBe(false);
  });

  it('accepts producer-owned zero-state when no predecessor stage exists', () => {
    expect(authorDispositionAdmission({
      consumesAuthorAdjudication: true,
      predecessorPresent: false,
      authorReplyDisposition: 'absent',
    })).toBe('lifecycle-zero-state');
    const input = fixture({ phase: 'final-acceptance' });
    rmSync(input.authorReplyPath);
    rmSync(input.reviewEvidencePath);
    rmSync(input.evidencePath);
    const result = produce({ ...input, stageEvidencePaths: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).not.toContain('round-NN-author-reply');
    expect(existsSync(input.authorPath)).toBe(false);
  });

  it('fails closed a downstream bundle that includes author dispositions without a governed author reply', () => {
    const input = fixture({ phase: 'final-acceptance' });
    rmSync(input.authorReplyPath);
    const result = produce(input);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('missing governed author output round-NN-author-reply.*');
    expect(existsSync(input.authorPath)).toBe(false);
    expect(existsSync(join(input.outputDir, 'finding-disposition-ledger.json'))).toBe(false);
    const status = inspect(input);
    expect(status.ok).toBe(false);
    expect(status.missing.some((item) => item.reason.includes('round-NN-author-reply'))).toBe(true);
  });

  it('defers pre-lens materialization when only a prior-stage author reply and dispositions exist', () => {
    const input = fixture({ phase: 'pre-lens' });
    rmSync(input.evidencePath);
    input.stageEvidencePaths = [input.reviewEvidencePath];
    writeGovernedAuthorReply(input.authorReplyPath, {
      sourceRevision: REVISION,
      predecessorStage: 'competitive',
    });
    const historicalDispositions = JSON.stringify({
      schema: AUTHOR_DISPOSITIONS_SCHEMA,
      producer: 'governed-author-output/v1',
      reviewEpisodeId: input.episode,
      sourceRevision: REVISION,
      predecessorStage: 'competitive',
      draft: 'prior stage draft',
      findings: [],
      m4: { inventory: [] },
    }, null, 2) + '\n';
    writeFileSync(input.authorPath, historicalDispositions);
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.files).toContain('stage-completeness-receipt-architectural-review-attempt.json');
    expect(result.files).not.toContain('finding-disposition-ledger.json');
    expect(readFileSync(input.authorPath, 'utf8')).toBe(historicalDispositions);
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: input.outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: input.stageEvidencePaths,
      authorDispositionsPath: input.authorPath,
      phase: 'pre-lens',
    });
    expect(status.ok, status.missing.map((item) => item.reason).join('\n')).toBe(true);
    expect(status.missing.some((item) => item.reason.includes('round-NN-author-reply'))).toBe(false);
  });
});
