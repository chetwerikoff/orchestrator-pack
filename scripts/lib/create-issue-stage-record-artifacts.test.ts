// @vitest-ci-lane heavy
// @vitest-pre-topology-seconds 1
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';
import {
  ACCEPTANCE_ARTIFACT_OUTPUT_NAMES,
  AUTHOR_DISPOSITIONS_SCHEMA,
  STAGE_EVIDENCE_SCHEMA,
  inspectAcceptanceArtifacts,
  produceAcceptanceArtifacts,
  stageReceiptPayloadsMatchExceptDerivedChain,
} from './create-issue-stage-record-artifacts.ts';
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

function comment(
  body = canonicalVerdict(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const id = Number(overrides.id ?? COMMENT_ID);
  return {
    id,
    html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE}`,
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

interface TransportOptions {
  principal?: string | null;
  census?: Array<Record<string, unknown>>;
  censusFailure?: boolean;
  reread?: Record<string, unknown> | null;
  rereadFailure?: boolean;
  secondPageFailure?: boolean;
  beforeReread?: () => void;
  cycleComments?: Array<Record<string, unknown>>;
}

function transport(options: TransportOptions = {}) {
  const principal = options.principal === undefined ? PUBLISHER : options.principal;
  const suppliedCensus = options.census ?? [comment()];
  const observedRevision = suppliedCensus.flatMap((item) => {
    const match = typeof item.body === 'string' ? /^Read revision: #[1-9][0-9]* (r[0-9]+)$/m.exec(item.body) : null;
    return match?.[1] ? [match[1]] : [];
  })[0] ?? REVISION;
  const journalComments = options.cycleComments ?? [cycleComment(observedRevision)];
  const census = [...suppliedCensus, ...journalComments];
  const runGh = vi.fn((argv: string[]) => {
    if (argv[2] === 'user') {
      if (principal === null) return { exitCode: 1, stdout: '', stderr: 'principal unavailable' };
      return { exitCode: 0, stdout: `${principal}\n`, stderr: '' };
    }
    const target = argv[2] ?? '';
    if (target === `repos/${REPOSITORY}`) {
      return { exitCode: 0, stdout: `${PUBLISHER}\n`, stderr: '' };
    }
    if (target.includes(`/issues/${ISSUE}/comments?per_page=100&page=1`)) {
      if (options.censusFailure) return { exitCode: 1, stdout: '', stderr: 'census unavailable' };
      return { exitCode: 0, stdout: JSON.stringify(census), stderr: '' };
    }
    if (target.includes(`/issues/${ISSUE}/comments?per_page=100&page=2`)) {
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
  return { runGh };
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
} = {}) {
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
  const dir = mkdtempSync(join(tmpdir(), 'opk-1385-artifacts-'));
  tempDirs.push(dir);
  const intakePath = join(dir, 'tier-intake.json');
  const evidencePath = join(dir, 'attempt-001.json');
  const authorPath = join(dir, 'author-dispositions.json');
  const capturePath = join(dir, 'pass-02-architectural.capture.txt');
  const reviewEvidencePath = join(dir, 'attempt-000.json');
  const turnResultPath = join(dir, 'turn-result-001.json');
  const outputDir = join(dir, 'output');
  const episode = deriveReviewEpisodeId(TASK, intakeRevision);
  const body = input.captureText ?? canonicalVerdict(sourceRevision, 'invocation-001', ISSUE, invocationEchoLabel);

  writeFileSync(intakePath, JSON.stringify({
    schema: 'tier-intake/v1',
    producer: 'flow-manager',
    taskIdentity: TASK,
    kind: 'fresh',
    priorTier: 'T2',
    firstRevision: intakeRevision,
  }));
  writeFileSync(authorPath, JSON.stringify({ schema: AUTHOR_DISPOSITIONS_SCHEMA, findings: [] }));
  const reviewComments = Array.from({ length: 3 }, (_, index) => {
    const invocationId = `architectural-review-invocation-${String(index + 1).padStart(2, '0')}`;
    return comment(canonicalVerdict(sourceRevision, invocationId, ISSUE, invocationEchoLabel), { id: COMMENT_ID + 100 + index });
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
    return { schema: 'reviewer-invocation-envelope/v1', reviewEpisodeId: episode, stageAttemptId: 'architectural-review-attempt', policyVersion: 'triple-source/v1', reviewerCardinality: 3, cardinalityConfigIdentity: CONFIG, stage: 'architectural-review', sourceRevision, invocationId, terminalResultIdentity: `sha256:${createHash('sha256').update(turnResultText).digest('hex')}:${basename(reviewTurnResultPath)}`, reviewerSource: `browser-gpt-${String(ordinal).padStart(2, '0')}#capture=final-node/v1`, reviewerSlot: String(ordinal).padStart(2, '0'), reviewerOrdinal: ordinal, attemptOrdinal: 1, retryAttempt: false, terminal: true, terminalClassification: 'complete', sendCount: 1, retryClass: 'none', revisionCheck: 'matched', capacityOutcome: 'admitted', capacityWaitMs: 0, capturePath: reviewCapturePath, turnResultPath: reviewTurnResultPath };
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
    invocationId: 'invocation-001',
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
      invocation_id: 'invocation-001',
      configured_profile_key: turnResultConfiguredProfileKey,
      ...(input.omitTurnResultSendCount ? {} : { send_count: turnResultSendCount }),
      ...(turnResultState === 'ok'
        ? { output: { byte_length: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') } }
        : {}),
    };
    const turnResultText = JSON.stringify(turnResult);
    writeFileSync(turnResultPath, turnResultText);
    invocation.turnResultPath = turnResultPath;
    invocation.terminalResultIdentity = `sha256:${createHash('sha256').update(turnResultText).digest('hex')}:${basename(turnResultPath)}`;
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
  return { dir, intakePath, evidencePath, reviewEvidencePath, authorPath, capturePath, turnResultPath, outputDir, evidence, invocation, body, episode, reviewComments };
}

function produce(
  input: ReturnType<typeof fixture>,
  source = transport({ census: [...input.reviewComments, comment(input.body)] }),
  operatorAdjudication?: Record<string, unknown>,
) {
  return produceAcceptanceArtifacts({
    reviewDir: input.dir,
    outputDir: input.outputDir,
    tierIntakePath: input.intakePath,
    stageEvidencePaths: [input.reviewEvidencePath, input.evidencePath],
    authorDispositionsPath: input.authorPath,
    phase: 'final-acceptance',
    artifactSourceTransport: source,
    ...(operatorAdjudication ? { operatorAdjudication: operatorAdjudication as never } : {}),
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

  it('accepts receipt-ok/artifact-ok only after census, principal proof, and reread', () => {
    const input = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    const source = transport({ census: [...input.reviewComments, comment(input.body)] });
    const result = produce(input, source);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(source.runGh.mock.calls.map((call) => call[0][2])).toEqual([
      `repos/${REPOSITORY}`,
      `repos/${REPOSITORY}/issues/${ISSUE}/comments?per_page=100&page=1`,
      'user',
      `repos/${REPOSITORY}/issues/${ISSUE}/comments?per_page=100&page=1`,
      ...input.reviewComments.map((item) => `repos/${REPOSITORY}/issues/comments/${String(item.id)}`),
      `repos/${REPOSITORY}/issues/comments/${COMMENT_ID}`,
    ]);
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
    expect(result.errors.join('\n')).toContain('authoritative GitHub artifact absent after complete census');
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
    const result = produce(input, source);

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
    const result = produce(input, source);

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
    const result = produce(input, source);

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
    const result = produce(input, source);

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
    const result = produce(input, source);

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
    const live = canonicalVerdict(REVISION, 'invocation-retry');
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
    expect(result.errors.join('\n')).toContain('authoritative GitHub artifact absent after complete census');
    expect(existsSync(join(input.outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each([
    ['foreign target', comment(canonicalVerdict(), { issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/1193` }), /absent after complete census/],
    ['wrong revision', comment(canonicalVerdict('r02')), /revision mismatch:.*expected=r01.*observed=r02/],
    ['wrong publisher', comment(canonicalVerdict(), { user: { login: 'someone-else' } }), /provenance-mismatch/],
    ['edited artifact', comment(canonicalVerdict(), { updated_at: '2026-08-07T04:01:00Z' }), /was edited/],
  ])('rejects %s', (_name, liveComment, expected) => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ census: [liveComment as Record<string, unknown>] }));
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
    const result = produce(input, transport({
      census: [...input.reviewComments, comment(input.body)],
      cycleComments: [untrustedJournal],
    }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBe('source-unavailable');
    expect(result.errors.join('\n')).toContain('journal-marked comment');
  });

  it('fails closed when the canonical invocation candidate itself has no author', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ census: [...input.reviewComments, comment(input.body, { user: null })] }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBe('provenance-unresolved');
    expect(result.errors.join('\n')).toContain('canonical artifact candidate has no authoritative comment-author login');
  });

  it('filters provenance before uniqueness and compares GitHub logins case-insensitively', () => {
    const input = fixture({ transportClassification: 'incident' });
    const principalComment = comment(input.body);
    const foreignComment = comment(input.body, {
      id: COMMENT_ID + 1,
      html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID + 1}`,
      user: { login: 'someone-else' },
    });
    const result = produce(input, transport({
      principal: PUBLISHER.toUpperCase(),
      census: [...input.reviewComments, foreignComment, principalComment],
    }));
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.invocations[0].artifactAuthority.commentId).toBe(COMMENT_ID);
    expect(receipt.invocations[0].artifactAuthority.publisherLogin).toBe(PUBLISHER);
  });

  it('classifies unavailable authenticated principal as TEMPORARY provenance-unresolved', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ principal: null }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBe('provenance-unresolved');
    expect(result.errors.join('\n')).toContain('TEMPORARY provenance-unresolved');
  });

  it('classifies an incomplete paginated census as TEMPORARY source-unavailable', () => {
    const input = fixture({ transportClassification: 'incident' });
    const filler = Array.from({ length: 100 }, (_, index) => comment(`noise-${index}`, { id: 6000000000 + index }));
    const result = produce(input, transport({ census: filler, secondPageFailure: true }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBe('source-unavailable');
    expect(result.errors.join('\n')).toContain('TEMPORARY source-unavailable');
  });

  it('classifies duplicate canonical invocation artifacts as TEMPORARY identity-unresolved', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ census: [
      comment(input.body),
      comment(input.body, { id: COMMENT_ID + 1, html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID + 1}` }),
    ] }));
    expect(result.ok).toBe(false);
    expect(result.temporary).toBe('identity-unresolved');
    expect(result.errors.join('\n')).toContain('TEMPORARY identity-unresolved');
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
    expect(result.errors.join('\n')).toContain('artifact absent after complete census');
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
    ['wrong publisher', { census: [comment(canonicalVerdict(), { user: { login: 'someone-else' } })] }],
    ['edited artifact', { census: [comment(canonicalVerdict(), { updated_at: '2026-08-07T04:01:00Z' })] }],
    ['wrong revision', { census: [comment(canonicalVerdict('r02'))] }],
    ['reread byte mismatch', { census: [comment()], reread: comment(`${canonicalVerdict()}changed\n`) }],
    ['source unavailable', { censusFailure: true }],
    ['principal unavailable', { principal: null }],
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
    expect(result.errors.join('\n')).toContain('authoritative GitHub artifact absent after complete census');
  });

  it('check-artifacts still requires capture and turn-result evidence for successful transport', () => {
    const missingTurnResult = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    const producedTurnResult = produce(missingTurnResult);
    expect(producedTurnResult.ok, producedTurnResult.errors.join('\n')).toBe(true);
    expect(inspect(missingTurnResult).ok).toBe(true);
    rmSync(missingTurnResult.turnResultPath);
    const turnStatus = inspect(missingTurnResult);
    expect(turnStatus.ok).toBe(false);
    expect(turnStatus.missing.map((item) => item.reason).join('\n')).toContain('missing turn-result/v1 artifact');

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

  it('accepts the full r03 preterminal to r04 terminal chain and rejects terminal revision drift', () => {
    const taskIdentity = `issue:${ISSUE}`;
    const episodeFirstRevision = 'r03';
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

    const competitive = makeBrowserReceipt('competitive', 1, 'r03');
    const preterminal = makeBrowserReceipt('architectural-review', 2, 'r03');
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
      sourceRevision: 'r04',
      outcome: 'complete',
      revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
      settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
      claude: {
        kind: 'waiver',
        waiver: { reason: 'claude-unavailable', unavailability: 'provider-unavailable', evidenceIdentity: 'r04-lens-waiver' },
      },
      credentialingCaptures: [],
      relayEligibleCaptures: [],
    };
    const terminal = makeBrowserReceipt('architectural', 4, 'r04');
    const receipts = [competitive, preterminal, lens, terminal];
    const captures = receipts.flatMap((item) => item.relayEligibleCaptures);
    const relays: VerifiedRelayEvidenceV1[] = captures.map((item, index) => ({
      relayAttemptId: `r03-r04-relay-${index + 1}`,
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
        producer: 'flow-manager',
        taskIdentity,
        kind: 'fresh' as const,
        priorTier: 'T3' as const,
        firstRevision: episodeFirstRevision,
        competitiveDecision: 'required' as const,
        competitiveRationale: 'fixture includes the required competitive predecessor',
      },
      receiptInventory: {
        source: 'canonical-review-directory' as const,
        taskIdentity,
        episodeFirstRevision,
        reviewEpisodeId,
        stageReceiptIds: receipts.map((item) => item.stageReceiptId),
      },
      claudeProducerEvidence: [],
    };

    const state = deriveReviewEpisodeState(receipts, relays, episodeAuthority);
    expect(state.errors, state.errors.join('\n')).toEqual([]);
    expect(validateReviewEpisodeTopology(state, 'final-acceptance')).toEqual([]);
    expect(state.receipts.map((item) => item.sourceRevision)).toEqual(['r03', 'r03', 'r04', 'r04']);

    const drifted = structuredClone(receipts);
    drifted[3]!.invocations![0]!.sourceRevision = 'r05';
    const driftedState = deriveReviewEpisodeState(drifted, relays, episodeAuthority);
    expect(driftedState.errors.join('\n')).toContain('sourceRevision mismatch');
  });
});


describe('Issue #1556 pre-lens architectural-review routing', () => {
  it('preserves immutable routing on every reviewer slot and rejects an omission', () => {
    const prepare = (missingSlot?: string) => {
      const input = fixture({ transportClassification: 'complete' });
      rmSync(input.evidencePath);

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
    writeFileSync(input.authorPath, JSON.stringify({
      schema: AUTHOR_DISPOSITIONS_SCHEMA,
      findings: Array.from({ length: 7 }, (_, index) => ({
        id: 'lens-finding-' + String(index + 1),
        type: 'quality',
        occurrences: [lensIdentity + ':' + String(index + 1)],
        defectDisposition: 'addressed',
        remedyDisposition: 'accepted',
        'persistent-machinery': 'no',
        simplificationCutCandidate: false,
      })),
    }));
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
