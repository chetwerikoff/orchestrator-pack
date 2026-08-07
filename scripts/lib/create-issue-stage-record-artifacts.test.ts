import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { deriveReviewEpisodeId } from './stage-completeness-core.ts';

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
): string {
  return [
    `Read revision: #${issueNumber} ${revision}`,
    'review-economics-contract: v1',
    'VERDICT: CLEAN',
    'NO_FINDINGS',
    'SIMPLIFICATION_CLEAN',
    'FINDING_COUNT: 0',
    `INVOCATION_ID: ${invocationId}`,
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
} = {}) {
  const intakeRevision = input.intakeRevision ?? REVISION;
  const sourceRevision = input.sourceRevision ?? intakeRevision;
  const transportClassification = input.transportClassification ?? 'incident';
  const reviewerSource = input.reviewerSource === undefined
    ? 'browser-gpt#capture=final-node/v1'
    : input.reviewerSource;
  const dir = mkdtempSync(join(tmpdir(), 'opk-1385-artifacts-'));
  tempDirs.push(dir);
  const intakePath = join(dir, 'tier-intake.json');
  const evidencePath = join(dir, 'attempt-001.json');
  const authorPath = join(dir, 'author-dispositions.json');
  const capturePath = join(dir, 'pass-01-architectural.capture.txt');
  const turnResultPath = join(dir, 'turn-result-001.json');
  const outputDir = join(dir, 'output');
  const episode = deriveReviewEpisodeId(TASK, intakeRevision);
  const body = input.captureText ?? canonicalVerdict(sourceRevision);

  writeFileSync(intakePath, JSON.stringify({
    schema: 'tier-intake/v1',
    producer: 'flow-manager',
    taskIdentity: TASK,
    kind: 'fresh',
    priorTier: 'T2',
    firstRevision: intakeRevision,
  }));
  writeFileSync(authorPath, JSON.stringify({ schema: AUTHOR_DISPOSITIONS_SCHEMA, findings: [] }));
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
    stageSequence: 1,
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
  return { dir, intakePath, evidencePath, authorPath, capturePath, turnResultPath, outputDir, evidence, invocation, body, episode };
}

function produce(
  input: ReturnType<typeof fixture>,
  source = transport({ census: [comment(input.body)] }),
  operatorAdjudication?: Record<string, unknown>,
) {
  return produceAcceptanceArtifacts({
    reviewDir: input.dir,
    outputDir: input.outputDir,
    tierIntakePath: input.intakePath,
    stageEvidencePaths: [input.evidencePath],
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

describe('Issue #1385 authoritative GitHub artifact acceptance', () => {
  it('accepts receipt-ok/artifact-ok only after census, principal proof, and reread', () => {
    const input = fixture({ transportClassification: 'complete', withTurnResult: true, withCapture: true });
    const source = transport({ census: [comment(input.body)] });
    const result = produce(input, source);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(source.runGh.mock.calls.map((call) => call[0][2])).toEqual([
      'user',
      `repos/${REPOSITORY}/issues/${ISSUE}/comments?per_page=100&page=1`,
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
    ['wrong revision', comment(canonicalVerdict('r02')), /absent after complete census/],
    ['wrong publisher', comment(canonicalVerdict(), { user: { login: 'someone-else' } }), /provenance-mismatch/],
    ['edited artifact', comment(canonicalVerdict(), { updated_at: '2026-08-07T04:01:00Z' }), /was edited/],
  ])('rejects %s', (_name, liveComment, expected) => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ census: [liveComment as Record<string, unknown>] }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(expected as RegExp);
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

  it('rejects an existing canonical capture conflict and never overwrites it', () => {
    const input = fixture({ transportClassification: 'incident', withCapture: true, captureText: 'foreign local bytes\n' });
    const live = canonicalVerdict();
    const result = produce(input, transport({ census: [comment(live)], reread: comment(live) }));
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
    const result = produce(input, transport({ census: [comment(input.body)], reread: comment(changed) }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/malformed|changed between complete census and reread/);
  });

  it.each([
    ['complete absence', { census: [] }],
    ['duplicate identity', { census: [comment(), comment(canonicalVerdict(), { id: COMMENT_ID + 1, html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}#issuecomment-${COMMENT_ID + 1}` })] }],
    ['wrong publisher', { census: [comment(canonicalVerdict(), { user: { login: 'someone-else' } })] }],
    ['edited artifact', { census: [comment(canonicalVerdict(), { updated_at: '2026-08-07T04:01:00Z' })] }],
    ['source unavailable', { censusFailure: true }],
    ['principal unavailable', { principal: null }],
  ])('does not let the operator URL override %s', (_name, transportOptions) => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport(transportOptions as TransportOptions), validOperatorHint(input.body));
    expect(result.ok).toBe(false);
  });

  it('uses the operator URL only as a narrowing hint after unique canonical resolution', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input, transport({ census: [comment(input.body)] }), validOperatorHint(input.body));
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const manifest = JSON.parse(readFileSync(join(input.outputDir, 'acceptance-artifacts.json'), 'utf8'));
    expect(manifest.acceptanceBasis).toBe('authoritative-github-artifact');
    expect(manifest.operatorAdjudication).toBeUndefined();
  });

  it('accepts intake r03 with a terminal artifact bound to r04', () => {
    const input = fixture({ intakeRevision: 'r03', sourceRevision: 'r04', transportClassification: 'incident' });
    const live = canonicalVerdict('r04');
    const result = produce(input, transport({ census: [comment(live)], reread: comment(live) }));
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.episodeFirstRevision).toBe('r03');
    expect(receipt.sourceRevision).toBe('r04');
    expect(receipt.invocations[0].sourceRevision).toBe('r04');
  });

  it('contributes the authoritative capture exactly once to governance, relay, and ledger', () => {
    const input = fixture({ transportClassification: 'incident' });
    const result = produce(input);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(input.outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    const relay = JSON.parse(readFileSync(join(input.outputDir, 'verified-relay-evidence.json'), 'utf8'));
    expect(receipt.credentialingCaptures).toHaveLength(1);
    expect(receipt.relayEligibleCaptures).toHaveLength(1);
    expect(relay).toHaveLength(1);
    expect(new Set([
      receipt.credentialingCaptures[0].captureIdentity,
      receipt.relayEligibleCaptures[0].captureIdentity,
      relay[0].captureIdentity,
    ]).size).toBe(1);
    const ledgerCall = vi.mocked(checkFindingLedgerGuard).mock.calls.at(-1);
    expect(ledgerCall?.[0]).toEqual([input.body]);
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
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: input.outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.evidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
    });
    expect(status.ok, status.missing.map((item) => item.reason).join('\n')).toBe(true);
  });
});
