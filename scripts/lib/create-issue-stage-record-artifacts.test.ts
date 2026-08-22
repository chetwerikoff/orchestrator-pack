import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';
import {
  AUTHOR_DISPOSITIONS_SCHEMA,
  STAGE_EVIDENCE_SCHEMA,
  inspectAcceptanceArtifacts,
  produceAcceptanceArtifacts,
} from './create-issue-stage-record-artifacts.ts';
import {
  deriveReviewEpisodeId,
  deriveReviewEpisodeState,
  validateReviewEpisodeTopology,
  type CaptureIdentityV1,
  type StageCompletenessReceiptV1,
  type VerifiedRelayEvidenceV1,
} from './stage-completeness-core.ts';

vi.mock('../finding-ledger-guard.mjs', () => ({
  checkFindingLedgerGuard: vi.fn(() => ({ ok: true, errors: [] })),
}));

const REPOSITORY = 'chetwerikoff/orchestrator-pack';
const ISSUE = 1192;
const TASK = `issue:${ISSUE}`;
const REVISION = 'r01';
const CONFIG = 'env:OPK_GPT_REVIEWER_CARDINALITY';
const COMMENT_ID = 5194504082;
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
    user: { login: PUBLISHER },
    ...overrides,
  };
}

interface TransportOptions {
  principal?: string | null;
  census?: Array<Record<string, unknown>>;
  censusFailure?: boolean;
  reread?: Record<string, unknown> | null;
  rereadFailure?: boolean;
  secondPageFailure?: boolean;
  beforeReread?: () => void;
}

function transport(options: TransportOptions = {}) {
  const principal = options.principal === undefined ? PUBLISHER : options.principal;
  const census = options.census ?? [comment()];
  const runGh = vi.fn((argv: string[]) => {
    if (argv[2] === 'user') {
      if (principal === null) return { exitCode: 1, stdout: '', stderr: 'principal unavailable' };
      return { exitCode: 0, stdout: `${principal}\n`, stderr: '' };
    }
    const target = argv[2] ?? '';
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
  withTurnResult?: boolean;
  withCapture?: boolean;
  captureText?: string;
  invocationEchoLabel?: 'INVOCATION_ID' | 'INVOCATION_ID_TO_ECHO';
} = {}) {
  const intakeRevision = input.intakeRevision ?? REVISION;
  const sourceRevision = input.sourceRevision ?? intakeRevision;
  const transportClassification = input.transportClassification ?? 'incident';
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
      state: transportClassification === 'complete' ? 'ok' : 'recovery_required',
      scope: transportClassification === 'complete' ? 'none' : 'invocation',
      cause: transportClassification === 'complete' ? 'ok' : 'direct_publication_owned_parent_missing',
      invocation_id: 'invocation-001',
      configured_profile_key: 'fixture-profile',
      send_count: 1,
      ...(transportClassification === 'complete'
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

function validOperatorHint(body: string, revision = REVISION) {
  return {
    issueNumber: ISSUE,
    sourceRevision: revision,
    verdictUrl: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID}`,
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
  it('accepts receipt-ok/artifact-ok only after census, principal proof, and reread', () => {
    const input = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    const source = transport({ census: [...input.reviewComments, comment(input.body)] });
    const result = produce(input, source);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(source.runGh.mock.calls.map((call) => call[0][2])).toEqual([
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

  it('ignores an unrelated authorless comment while preserving the complete census', () => {
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

  it('rejects a first stage receipt that re-roots the intake revision', () => {
    const input = fixture({ intakeRevision: 'r03', sourceRevision: 'r04', transportClassification: 'incident' });
    const live = canonicalVerdict('r04');
    const result = produce(input, transport({ census: [...input.reviewComments, comment(live)], reread: comment(live) }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('first stage receipt sourceRevision must equal episodeFirstRevision');
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

  it('still credentials an INVOCATION_ID comment (comment 5381523513 class)', () => {
    const input = fixture({
      transportClassification: 'complete',
      withTurnResult: true,
      withCapture: true,
      invocationEchoLabel: 'INVOCATION_ID',
    });
    expect(input.body).toMatch(/^INVOCATION_ID: invocation-001$/m);
    expect(input.body).not.toMatch(/INVOCATION_ID_TO_ECHO:/);
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
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
