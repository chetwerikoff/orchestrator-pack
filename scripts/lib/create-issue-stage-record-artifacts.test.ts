import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';
import {
  AUTHOR_DISPOSITIONS_SCHEMA,
  DEFECT_DISPOSITION_VALUES,
  REMEDY_DISPOSITION_VALUES,
  STAGE_EVIDENCE_SCHEMA,
  inspectAcceptanceArtifacts,
  produceAcceptanceArtifacts,
} from './create-issue-stage-record-artifacts.ts';
import { executeFinalAcceptanceGuards } from './create-issue-final-acceptance-contract.ts';
import { parseConsumableStageReceipt } from './create-issue-stage-record-receipt.ts';
import { buildCanonicalLineage } from './create-issue-stage-record-lineage.ts';
import { logicalFingerprint } from './create-issue-stage-record-marker.ts';
import { runStageFinalizeCli } from './create-issue-stage-record-cli.ts';
import {
  CYCLE_SCHEMA,
  STAGE_SCHEMA,
  type CycleEventLogical,
  type StageEventLogical,
} from './create-issue-stage-record-types.ts';

vi.mock('../finding-ledger-guard.mjs', () => ({
  checkFindingLedgerGuard: vi.fn(() => ({ ok: true, errors: [] })),
}));
import { deriveReviewEpisodeId, deriveStageReceiptId, deriveReviewEpisodeState } from './stage-completeness-core.ts';

const TASK = 'issue:1192';
const REVISION = 'r01';
const EPISODE = deriveReviewEpisodeId(TASK, REVISION);
const CONFIG = 'env:OPK_GPT_REVIEWER_CARDINALITY';
const CLEAN_CAPTURE = 'review-economics-contract: v1\nNO_FINDINGS\nSIMPLIFICATION_CLEAN\n';
const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opk-1192-artifacts-'));
  tempDirs.push(dir);
  const capturePath = join(dir, 'pass-01-architectural.capture.txt');
  const stageEvidencePath = join(dir, 'attempt-001.json');
  const intakePath = join(dir, 'tier-intake.json');
  const authorPath = join(dir, 'author-dispositions.json');
  const turnResultPath = join(dir, 'turn-result-001.json');
  writeFileSync(capturePath, CLEAN_CAPTURE);
  const captureSha256 = createHash('sha256').update(CLEAN_CAPTURE).digest('hex');
  const turnResult = {
    schema: 'turn-result/v1',
    state: 'ok',
    scope: 'none',
    cause: 'ok',
    invocation_id: 'invocation-001',
    configured_profile_key: 'fixture-profile',
    output: { byte_length: Buffer.byteLength(CLEAN_CAPTURE), sha256: captureSha256 },
  };
  const turnResultText = JSON.stringify(turnResult);
  writeFileSync(turnResultPath, turnResultText);
  const terminalResultIdentity = 'sha256:' + createHash('sha256').update(turnResultText).digest('hex') + ':' + basename(turnResultPath);
  writeFileSync(intakePath, JSON.stringify({
    schema: 'tier-intake/v1',
    producer: 'flow-manager',
    taskIdentity: TASK,
    kind: 'fresh',
    priorTier: 'T2',
    firstRevision: REVISION,
  }));
  writeFileSync(authorPath, JSON.stringify({
    schema: AUTHOR_DISPOSITIONS_SCHEMA,
    findings: [],
  }));
  const evidence = {
    schema: STAGE_EVIDENCE_SCHEMA,
    tier: 'T2',
    stage: 'architectural',
    stageAttemptId: 'attempt-001',
    stageSequence: 1,
    cycleId: 'cycle-1192',
    cycleBinding: { cycleId: 'cycle-1192', sourceRevision: REVISION, boundBeforeLaunch: true },
    policyVersion: 'single-source/v1',
    reviewerCardinality: 1,
    cardinalityConfigIdentity: CONFIG,
    sourceRevision: REVISION,
    outcome: 'complete',
    revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
    settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
    invocations: [{
      schema: 'reviewer-invocation-envelope/v1',
      reviewEpisodeId: EPISODE,
      stageAttemptId: 'attempt-001',
      policyVersion: 'single-source/v1',
      reviewerCardinality: 1,
      cardinalityConfigIdentity: CONFIG,
      stage: 'architectural',
      sourceRevision: REVISION,
      invocationId: 'invocation-001',
      terminalResultIdentity,
      turnResultPath,
      reviewerSource: 'terminal-gpt',
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
      capturePath: capturePath,
    }],
  };
  writeFileSync(stageEvidencePath, JSON.stringify(evidence));
  return { dir, capturePath, turnResultPath, stageEvidencePath, intakePath, authorPath, evidence };
}

function writeClaudeLensFixture(input: ReturnType<typeof fixture>) {
  const capturePath = join(input.dir, 'pass-03-architectural-lens.capture.txt');
  const producerEvidencePath = join(input.dir, 'claude-producer-evidence.json');
  writeFileSync(capturePath, CLEAN_CAPTURE);
  writeFileSync(input.intakePath, JSON.stringify({
    schema: 'tier-intake/v1',
    producer: 'flow-manager',
    taskIdentity: TASK,
    kind: 'fresh',
    priorTier: 'T2',
    firstRevision: REVISION,
  }));
  const stageAttemptId = 'attempt-lens';
  const invocationId = 'claude-invocation';
  const producingRunIdentity = 'claude-run';
  const terminalResultIdentity = 'claude-result';
  const producerEvidenceIdentity = 'claude-evidence';
  writeFileSync(input.stageEvidencePath, JSON.stringify({
    schema: STAGE_EVIDENCE_SCHEMA,
    tier: 'T3',
    stage: 'architectural-lens',
    stageAttemptId,
    stageSequence: 1,
    cycleId: 'cycle-1192',
    cycleBinding: { cycleId: 'cycle-1192', sourceRevision: REVISION, boundBeforeLaunch: true },
    policyVersion: 'single-source/v1',
    reviewerCardinality: 1,
    cardinalityConfigIdentity: CONFIG,
    sourceRevision: REVISION,
    outcome: 'complete',
    revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
    settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
    claude: {
      kind: 'capture',
      provider: 'claude-cli',
      invocationId,
      producingRunIdentity,
      terminalResultIdentity,
      producerEvidenceIdentity,
      terminal: true,
      terminalClassification: 'complete',
      exitCode: 0,
      m3Status: 'recorded',
      capturePath,
    },
  }));
  const sha256 = createHash('sha256').update(CLEAN_CAPTURE).digest('hex');
  writeFileSync(producerEvidencePath, JSON.stringify({
    schema: 'claude-producer-evidence/v1',
    evidenceIdentity: producerEvidenceIdentity,
    reviewEpisodeId: EPISODE,
    stageAttemptId,
    sourceRevision: REVISION,
    invocationId,
    producingRunIdentity,
    terminalResultIdentity,
    terminal: true,
    terminalClassification: 'complete',
    exitCode: 0,
    capture: {
      captureIdentity: `sha256:${sha256}:${capturePath.split('/').at(-1)}`,
      name: capturePath.split('/').at(-1),
      byteLength: Buffer.byteLength(CLEAN_CAPTURE),
      sha256,
      rawFindingCount: 0,
    },
    m3Status: 'recorded',
  }));
  return { capturePath, producerEvidencePath };
}

describe('Issue #1192 evidence-derived acceptance artifacts', () => {
  it('computes canonical identifiers and produces validator-valid artifacts', () => {
    const input = fixture();
    const captureTime = new Date('2026-08-02T02:00:00.000Z');
    utimesSync(input.capturePath, captureTime, captureTime);
    const outputDir = join(input.dir, 'artifacts');
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(outputDir, 'stage-completeness-receipt-attempt-001.json'), 'utf8'));
    expect(receipt.reviewEpisodeId).toBe(EPISODE);
    expect(receipt.stageReceiptId).toBe(deriveStageReceiptId(EPISODE, 1));
    expect(receipt.receiptCensus).toEqual([receipt.stageReceiptId]);
    const relay = JSON.parse(readFileSync(join(outputDir, 'verified-relay-evidence.json'), 'utf8'));
    expect(relay[0].byteLength).toBe(Buffer.byteLength(CLEAN_CAPTURE));
    expect(relay[0].sha256).toBe(receipt.credentialingCaptures[0].sha256);
    const guardOptions = vi.mocked(checkFindingLedgerGuard).mock.calls.at(-1)?.[2] as {
      stageTerminalConfirmed: boolean;
      captureMetadata: Array<{ timestampMs: number }>;
    };
    expect(guardOptions.stageTerminalConfirmed).toBe(true);
    expect(guardOptions.captureMetadata[0]?.timestampMs).toBe(statSync(input.capturePath).mtimeMs);
    expect(deriveReviewEpisodeState(
      [receipt],
      relay,
      {
        tierIntake: JSON.parse(readFileSync(input.intakePath, 'utf8')),
        receiptInventory: JSON.parse(readFileSync(join(outputDir, 'review-episode-inventory.json'), 'utf8')),
      },
    ).errors).toEqual([]);
  });

  it('feeds the produced files into the unchanged final-acceptance guards', () => {
    const input = fixture();
    const outputDir = join(input.dir, 'artifacts');
    const produced = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(produced.ok, produced.errors.join('\n')).toBe(true);
    const receiptPath = join(outputDir, 'stage-completeness-receipt-attempt-001.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(parseConsumableStageReceipt(receipt).errors).toEqual([]);
    const issueBody = [
      '# Fixture', '', '## Goal', 'Exercise acceptance.', '',
      '```behavior-kind', 'action-producing', '```',
      '```positive-outcome', 'asserts: emits a deterministic result', 'input: realistic', '```',
      '```complexity-tier', 'tier: T2', 'advisory-prior: T2', '```',
      '```denylist', 'vendor/**', 'packages/core/**', '```',
      '```allowed-roots', 'scripts/**', '```',
      '## Acceptance criteria', '1. The fixture is deterministic.', '',
      '## Verification', 'Run the focused test.', '',
      '```contract-evidence', 'none', '```', '<!-- source-revision: r01 -->',
    ].join('\n');
    const cycle: CycleEventLogical = {
      schema: CYCLE_SCHEMA,
      'event-key': 'cycle-1192',
      'cycle-id': 'cycle-1192',
      'predecessor-cycle-id': 'none',
      'source-revision': REVISION,
      tier: 'T2',
      'public-actor': 'cursor-flow-manager',
    };
    const parsedReceipt = parseConsumableStageReceipt(receipt).receipt!;
    const stage: StageEventLogical = {
      schema: STAGE_SCHEMA,
      'event-key': `${parsedReceipt.cycleId}:${parsedReceipt.stage}:${parsedReceipt.stageAttemptId}`,
      'cycle-id': parsedReceipt.cycleId,
      stage: parsedReceipt.stage,
      tier: parsedReceipt.tier,
      'source-revision': parsedReceipt.sourceRevision,
      'stage-attempt-id': parsedReceipt.stageAttemptId,
      'policy-version': parsedReceipt.policyVersion,
      'settled-outcome': parsedReceipt.outcome,
      'source-count': parsedReceipt.completedSourceCount,
      'required-source-count': parsedReceipt.reviewerCardinality,
      'producer-evidence': parsedReceipt.producerEvidence,
      'tier-transition': parsedReceipt.tierTransition,
    };
    const canonicalLineage = buildCanonicalLineage([
      {
        schema: CYCLE_SCHEMA,
        eventKey: cycle['event-key'],
        logical: cycle,
        fingerprint: logicalFingerprint(cycle),
        commentId: 1,
        createdAt: '2026-08-02T00:00:00.000Z',
      },
      {
        schema: STAGE_SCHEMA,
        eventKey: stage['event-key'],
        logical: stage,
        fingerprint: logicalFingerprint(stage),
        commentId: 2,
        createdAt: '2026-08-02T00:01:00.000Z',
      },
    ]);
    const acceptance = executeFinalAcceptanceGuards({
      issueBody,
      currentIssueBody: issueBody,
      issueRevision: REVISION,
      cycleId: 'cycle-1192',
      tier: 'T2',
      reviewDir: outputDir,
      tierIntakePath: input.intakePath,
      stageReceiptPaths: [receiptPath],
      capturePaths: [input.capturePath],
      ledgerPath: join(outputDir, 'finding-disposition-ledger.json'),
      relayEvidencePaths: [join(outputDir, 'verified-relay-evidence.json')],
      canonicalLineage,
      tierTransitionEvidence: {
        taskIdentity: TASK,
        currentRevision: REVISION,
        intake: JSON.parse(readFileSync(input.intakePath, 'utf8')),
        revisions: [{
          revision: REVISION,
          text: issueBody,
          tier: 'T2',
          receipt: {
            schema: 'tier-gate-decision/v1',
            producer: 'flow-manager',
            revision: REVISION,
            tier: 'T2',
            rubricClasses: ['failure-type:local-behavior'],
            l4Status: 'not-applicable',
          },
        }],
        events: [],
        revalidations: [],
      },
    });
    expect(acceptance.ok, acceptance.errors.join('\n')).toBe(true);
  });

  it('rejects hand-supplied canonical identifiers instead of trusting them', () => {
    const input = fixture();
    writeFileSync(input.stageEvidencePath, JSON.stringify({
      ...input.evidence,
      reviewEpisodeId: 'hand-written-episode',
      stageReceiptId: 'hand-written-receipt',
    }));
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/reviewEpisodeId is not canonical|stageReceiptId is not canonical/);
    expect(existsSync(join(input.dir, 'artifacts'))).toBe(false);
  });

  it('rejects omitted recorded stage evidence by naming the missing file', () => {
    const input = fixture();
    const omittedPath = join(input.dir, 'attempt-002.json');
    writeFileSync(omittedPath, JSON.stringify({
      ...input.evidence,
      stageAttemptId: 'attempt-002',
    }));
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(omittedPath);
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(status.missing.some((item) => item.reason.includes(omittedPath))).toBe(true);
  });

  it('does not produce any artifact when a recorded stage names a missing capture', () => {
    const input = fixture();
    writeFileSync(input.stageEvidencePath, JSON.stringify({
      ...input.evidence,
      invocations: input.evidence.invocations.map((invocation) => ({
        ...invocation,
        capturePath: join(input.dir, 'never-ran.capture.txt'),
      })),
    }));
    const outputDir = join(input.dir, 'artifacts');
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('missing capture file');
    expect(result.errors.join('\n')).toContain('never-ran.capture.txt');
    expect(existsSync(outputDir)).toBe(false);
  });

  it('invalidates stale artifacts before a replacement run fails', () => {
    const input = fixture();
    const outputDir = join(input.dir, 'artifacts');
    const first = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(first.ok, first.errors.join('\n')).toBe(true);
    writeFileSync(input.stageEvidencePath, JSON.stringify({
      ...input.evidence,
      invocations: input.evidence.invocations.map((invocation) => ({
        ...invocation,
        capturePath: join(input.dir, 'missing-after-success.capture.txt'),
      })),
    }));
    const failed = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(failed.ok).toBe(false);
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
    expect(inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    }).ok).toBe(false);
  });

  it('rejects stage attempt ids that could escape the output directory', () => {
    const input = fixture();
    const outputDir = join(input.dir, 'artifacts');
    const outsidePath = join(input.dir, 'outside.json');
    writeFileSync(input.stageEvidencePath, JSON.stringify({
      ...input.evidence,
      stageAttemptId: 'x/../../outside',
    }));
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('safe output filename component');
    expect(existsSync(outsidePath)).toBe(false);
  });

  it('passes a false terminal assurance when recorded settlement is not terminal', () => {
    const input = fixture();
    writeFileSync(input.stageEvidencePath, JSON.stringify({
      ...input.evidence,
      settlement: { allLaunchedTerminal: false, retryState: 'none', finalRevisionMatched: true },
    }));
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok).toBe(false);
    const guardOptions = vi.mocked(checkFindingLedgerGuard).mock.calls.at(-1)?.[2] as {
      stageTerminalConfirmed: boolean;
    };
    expect(guardOptions.stageTerminalConfirmed).toBe(false);
    expect(result.errors.join('\n')).toContain('terminal settlement');
  });

  it('reports missing T3 final-acceptance stages instead of trusting stale markers', () => {
    const input = fixture();
    writeFileSync(input.stageEvidencePath, JSON.stringify({
      ...input.evidence,
      tier: 'T3',
      stage: 'architectural',
    }));
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: input.dir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
    });
    expect(status.ok).toBe(false);
    expect(status.missing.some((item) => item.reason.includes('missing completed stage evidence for competitive'))).toBe(true);
    expect(status.missing.some((item) => item.reason.includes('missing completed stage evidence for architectural-review'))).toBe(true);
    expect(status.missing.some((item) => item.reason.includes('missing completed stage evidence for architectural-lens'))).toBe(true);
  });

  it('reports missing stage evidence before acceptance runs', () => {
    const input = fixture();
    const produced = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [],
      authorDispositionsPath: input.authorPath,
    });
    expect(produced.ok).toBe(false);
    expect(produced.errors.join('\n')).toContain(input.stageEvidencePath);
    expect(existsSync(join(input.dir, 'artifacts'))).toBe(false);
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [],
      authorDispositionsPath: input.authorPath,
    });
    expect(status.ok).toBe(false);
    expect(status.missing.some((item) => item.reason.includes('no recorded stage evidence paths'))).toBe(true);
    expect(status.missing.some((item) => item.artifact === 'verified relay evidence')).toBe(true);
  });

  it('preflights missing Claude capture files for architectural-lens evidence', () => {
    const input = fixture();
    const lensEvidencePath = join(input.dir, 'attempt-lens.json');
    const missingCapturePath = join(input.dir, 'missing-lens.capture.txt');
    writeFileSync(lensEvidencePath, JSON.stringify({
      schema: STAGE_EVIDENCE_SCHEMA,
      stage: 'architectural-lens',
      claude: { capturePath: 'missing-lens.capture.txt' },
    }));
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [lensEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(status.ok).toBe(false);
    expect(status.missing.some((item) => (
      item.artifact === 'capture'
      && item.reason.includes('Claude capture')
      && item.reason.includes(missingCapturePath)
    ))).toBe(true);
  });

  it('requires Claude producer evidence for a T3 Claude lens in both artifact commands', () => {
    const input = fixture();
    writeClaudeLensFixture(input);
    const options = {
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    };
    const produced = produceAcceptanceArtifacts(options);
    expect(produced.ok).toBe(false);
    expect(produced.errors.join('\n')).toContain('missing claude-producer-evidence/v1 input');
    const status = inspectAcceptanceArtifacts(options);
    expect(status.missing.some((item) => (
      item.artifact === 'claude-producer-evidence/v1'
      && item.reason.includes('--claude-producer-evidence')
    ))).toBe(true);
  });

  it('derives supplied Claude producer evidence into authority', () => {
    const input = fixture();
    const claude = writeClaudeLensFixture(input);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      claudeProducerEvidencePaths: [claude.producerEvidencePath],
    });
    expect(result.errors.join('\n')).not.toContain('not independently supplied');
    const guardOptions = vi.mocked(checkFindingLedgerGuard).mock.calls.at(-1)?.[2] as {
      episodeAuthority?: { claudeProducerEvidence?: Array<{ evidenceIdentity: string }> };
    };
    expect(guardOptions.episodeAuthority?.claudeProducerEvidence).toEqual([
      expect.objectContaining({ evidenceIdentity: 'claude-evidence' }),
    ]);
  });

  it('returns a structured indexed error for a non-object author finding', () => {
    const input = fixture();
    writeFileSync(input.authorPath, JSON.stringify({
      schema: AUTHOR_DISPOSITIONS_SCHEMA,
      findings: [null],
    }));
    expect(() => produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    })).not.toThrow();
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('author dispositions findings[0] must be an object');
  });

  it('rejects completed stage evidence without a referenced turn-result artifact', () => {
    const input = fixture();
    rmSync(input.turnResultPath);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('missing turn-result/v1 artifact');
  });

  it('rejects a turn-result whose invocation id does not match the stage evidence', () => {
    const input = fixture();
    writeFileSync(input.turnResultPath, JSON.stringify({
      schema: 'turn-result/v1',
      state: 'ok',
      scope: 'none',
      cause: 'ok',
      invocation_id: 'wrong-invocation',
      configured_profile_key: 'fixture-profile',
      output: {
        byte_length: Buffer.byteLength(CLEAN_CAPTURE),
        sha256: createHash('sha256').update(CLEAN_CAPTURE).digest('hex'),
      },
    }));
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('invocation_id does not match');
  });

  it('rejects a turn-result whose output metadata does not match the capture', () => {
    const input = fixture();
    const turnResult = JSON.parse(readFileSync(input.turnResultPath, 'utf8'));
    turnResult.output.sha256 = '0'.repeat(64);
    writeFileSync(input.turnResultPath, JSON.stringify(turnResult));
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: join(input.dir, 'artifacts'),
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('output does not match capture bytes');
  });

  it('accepts the complete produced artifact set in check-artifacts', () => {
    const input = fixture();
    const outputDir = join(input.dir, 'artifacts');
    const produced = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(produced.ok, produced.errors.join('\n')).toBe(true);
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(status.ok, status.missing.map((item) => item.reason).join('\n')).toBe(true);
  });

  it('rejects an incomplete artifact directory even when relay and ledger exist', () => {
    const input = fixture();
    const outputDir = join(input.dir, 'artifacts');
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, 'verified-relay-evidence.json'), '[]');
    writeFileSync(join(outputDir, 'finding-disposition-ledger.json'), '{}');
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(status.ok).toBe(false);
    expect(status.missing.some((item) => item.artifact === 'stage-completeness-receipt')).toBe(true);
    expect(status.missing.some((item) => item.artifact === 'review-episode-inventory')).toBe(true);
    expect(status.missing.some((item) => item.artifact === 'acceptance-artifacts')).toBe(true);
  });

  it('rejects directory-backed and malformed output artifacts', () => {
    const input = fixture();
    const outputDir = join(input.dir, 'artifacts');
    mkdirSync(join(outputDir, 'verified-relay-evidence.json'), { recursive: true });
    writeFileSync(join(outputDir, 'finding-disposition-ledger.json'), '{');
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(status.ok).toBe(false);
    expect(status.missing.some((item) => item.reason.includes('not a regular file'))).toBe(true);
    expect(status.missing.some((item) => item.reason.includes('malformed JSON'))).toBe(true);
  });

  it('returns a structured error when settlement evidence is missing', () => {
    const input = fixture();
    writeFileSync(input.stageEvidencePath, JSON.stringify({
      ...input.evidence,
      settlement: null,
    }));
    let result: ReturnType<typeof produceAcceptanceArtifacts> | undefined;
    expect(() => {
      result = produceAcceptanceArtifacts({
        reviewDir: input.dir,
        outputDir: join(input.dir, 'artifacts'),
        tierIntakePath: input.intakePath,
        stageEvidencePaths: [input.stageEvidencePath],
        authorDispositionsPath: input.authorPath,
      });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    expect(result?.errors.join('\n')).toContain('settlement');
  });

  it('reports missing capture paths for completed browser and Claude branches', () => {
    const input = fixture();
    writeFileSync(input.stageEvidencePath, JSON.stringify({
      ...input.evidence,
      tier: 'T3',
      stage: 'architectural-lens',
      invocations: [{ terminalClassification: 'complete' }],
      claude: { kind: 'capture' },
    }));
    writeFileSync(join(input.dir, 'verified-relay-evidence.json'), '[]');
    writeFileSync(join(input.dir, 'finding-disposition-ledger.json'), '{}');
    const status = inspectAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: input.dir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(status.ok).toBe(false);
    expect(status.missing.some((item) => item.reason.includes('completed invocation[0] is missing capturePath'))).toBe(true);
    expect(status.missing.some((item) => item.reason.includes('Claude capture branch is missing capturePath'))).toBe(true);
  });

  it('does not recursively delete a foreign directory matching an artifact name', () => {
    const input = fixture();
    const foreignDir = join(input.dir, 'stage-completeness-receipt-old.json');
    const sentinelPath = join(foreignDir, 'keep.txt');
    mkdirSync(foreignDir);
    writeFileSync(sentinelPath, 'keep');
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir: input.dir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(existsSync(foreignDir)).toBe(true);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('keep');
  });

  it('rolls back a partial publication when an artifact target is a directory', () => {
    const input = fixture();
    const outputDir = join(input.dir, 'artifacts');
    const foreignDir = join(outputDir, 'verified-relay-evidence.json');
    mkdirSync(foreignDir, { recursive: true });
    writeFileSync(join(foreignDir, 'keep.txt'), 'keep');
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('unable to publish acceptance artifacts');
    expect(existsSync(join(outputDir, 'stage-completeness-receipt-attempt-001.json'))).toBe(false);
    expect(existsSync(foreignDir)).toBe(true);
    expect(readFileSync(join(foreignDir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('rejects artifact-only flags on journal commands instead of ignoring them', () => {
    for (const [flag, value] of [
      ['--review-dir', '/tmp/review'],
      ['--tier-intake', '/tmp/intake.json'],
      ['--stage-evidence', '/tmp/evidence.json'],
      ['--author-dispositions', '/tmp/dispositions.json'],
      ['--claude-producer-evidence', '/tmp/claude.json'],
      ['--output-dir', '/tmp/output'],
      ['--phase', 'pre-lens'],
    ]) {
      expect(runStageFinalizeCli(['node', 'create-issue-stage-finalize.ts', 'start-cycle', flag, value])).toBe(2);
    }
  });

  it('keeps the documented disposition vocabularies equal to validator source sets', () => {
    const validator = readFileSync(join(process.cwd(), 'scripts/finding-ledger-guard.mjs'), 'utf8');
    const readSet = (name: string): string[] => {
      const match = validator.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]+)\\]\\)`));
      return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((item) => item[1]!);
    };
    expect([...DEFECT_DISPOSITION_VALUES]).toEqual(readSet('DEFECT_DISPOSITIONS'));
    expect([...REMEDY_DISPOSITION_VALUES]).toEqual(readSet('REMEDY_DISPOSITIONS'));
    const documentation = readFileSync(join(process.cwd(), 'docs/create-issue-draft-acceptance-artifacts.md'), 'utf8');
    for (const value of [...DEFECT_DISPOSITION_VALUES, ...REMEDY_DISPOSITION_VALUES]) expect(documentation).toContain(`\`${value}\``);
  });
});


describe('Issue #1341 operator-adjudicated final-acceptance artifacts', () => {
  function governedCapture(): string {
    return [
      'Read revision: #1192 r01',
      'review-economics-contract: v1',
      'VERDICT: CLEAN',
      'NO_FINDINGS',
      'SIMPLIFICATION_CLEAN',
      'FINDING_COUNT: 0',
      'INVOCATION_ID: fixture-terminal-1192',
      '',
    ].join('\n');
  }

  function adjudication(capture: string) {
    return {
      issueNumber: 1192,
      sourceRevision: 'r01',
      verdictUrl: 'https://github.com/chetwerikoff/orchestrator-pack/issues/1192#issuecomment-5194504082',
      verdictSha256: createHash('sha256').update(capture).digest('hex'),
      verdictByteLength: Buffer.byteLength(capture),
      verdictFindingCount: 0,
      reason: 'operator confirmed the already-published exact terminal verdict',
    };
  }

  function referenceTransport(
    capture: string,
    overrides: Record<string, unknown> = {},
    exitCode = 0,
  ) {
    return {
      runGh(argv: string[]) {
        expect(argv).toEqual([
'gh',
'api',
'repos/chetwerikoff/orchestrator-pack/issues/comments/5194504082',
        ]);
        return {
exitCode,
stderr: exitCode === 0 ? '' : 'not found',
stdout: exitCode === 0 ? JSON.stringify({
  id: 5194504082,
  html_url: 'https://github.com/chetwerikoff/orchestrator-pack/issues/1192#issuecomment-5194504082',
  issue_url: 'https://api.github.com/repos/chetwerikoff/orchestrator-pack/issues/1192',
  body: capture,
  created_at: '2026-08-05T15:00:00Z',
  updated_at: '2026-08-05T15:00:00Z',
  user: { login: 'chetwerikoff' },
  author_association: 'OWNER',
  ...overrides,
}) : '',
        };
      },
    };
  }

  for (const transportState of ['absent', 'driver_error'] as const) {
    it(`accepts exact governed bytes with ${transportState} transport and preserves that fact`, () => {
      const input = fixture();
      const capture = governedCapture();
      writeFileSync(input.capturePath, capture);
      const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
      if (transportState === 'absent') {
        delete evidence.invocations[0].turnResultPath;
        evidence.invocations[0].terminalResultIdentity = 'recorded-missing-transport-artifact';
        rmSync(input.turnResultPath, { force: true });
      } else {
        const failed = {
schema: 'turn-result/v1',
state: 'driver_error',
scope: 'invocation',
cause: 'browser_lost',
invocation_id: 'invocation-001',
configured_profile_key: 'fixture-profile',
output: {
  byte_length: Buffer.byteLength(capture),
  sha256: createHash('sha256').update(capture).digest('hex'),
},
        };
        const failedText = JSON.stringify(failed);
        writeFileSync(input.turnResultPath, failedText);
        evidence.invocations[0].terminalResultIdentity = 'sha256:'
+ createHash('sha256').update(failedText).digest('hex')
+ ':' + basename(input.turnResultPath);
      }
      writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
      const outputDir = join(input.dir, `operator-${transportState}`);
      const options = {
        reviewDir: input.dir,
        outputDir,
        tierIntakePath: input.intakePath,
        stageEvidencePaths: [input.stageEvidencePath],
        authorDispositionsPath: input.authorPath,
        phase: 'final-acceptance' as const,
        operatorAdjudication: adjudication(capture),
        operatorReferenceTransport: referenceTransport(capture),
      };
      const result = produceAcceptanceArtifacts(options);
      expect(result.ok, result.errors.join('\n')).toBe(true);
      const manifest = JSON.parse(readFileSync(join(outputDir, 'acceptance-artifacts.json'), 'utf8'));
      expect(manifest.operatorAdjudication).toMatchObject({
        provenance: 'operator_adjudicated',
        target: { issueNumber: 1192, sourceRevision: 'r01', invocationId: 'invocation-001' },
        reference: {
sha256: adjudication(capture).verdictSha256,
byteLength: Buffer.byteLength(capture),
findingCount: 0,
        },
        originalTransport: {
state: transportState,
terminalClassification: 'complete',
sendCount: 1,
        },
      });
      expect(JSON.stringify(manifest.operatorAdjudication)).not.toContain('"state":"ok"');
      expect(inspectAcceptanceArtifacts(options).ok).toBe(true);
    });
  }

  it('rejects absent transport without the direct operator input with legacy error bytes and no writes', () => {
    const input = fixture();
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    delete evidence.invocations[0].turnResultPath;
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, 'legacy-absent');
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('stage evidence invocation[0].turnResultPath is missing');
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });


  for (const scenario of [
    {
      name: 'edited published reference',
      transport: (capture: string) => referenceTransport(capture, { updated_at: '2026-08-05T15:01:00Z' }),
      error: 'was edited',
    },
    {
      name: 'unavailable published reference',
      transport: (capture: string) => referenceTransport(capture, {}, 1),
      error: 'is unavailable',
    },
    {
      name: 'incompletely observed published reference',
      transport: (capture: string) => referenceTransport(capture, { author_association: undefined }),
      error: 'is incompletely observed',
    },
    {
      name: 'published bytes that differ from the governed capture',
      transport: (capture: string) => referenceTransport(`${capture}edited`),
      error: 'SHA-256 is mismatched',
    },
  ]) {
    it(`rejects ${scenario.name} before artifact publication`, () => {
      const input = fixture();
      const capture = governedCapture();
      writeFileSync(input.capturePath, capture);
      const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
      delete evidence.invocations[0].turnResultPath;
      writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
      const outputDir = join(input.dir, `operator-reference-${scenario.name.replaceAll(' ', '-')}`);
      const result = produceAcceptanceArtifacts({
        reviewDir: input.dir,
        outputDir,
        tierIntakePath: input.intakePath,
        stageEvidencePaths: [input.stageEvidencePath],
        authorDispositionsPath: input.authorPath,
        phase: 'final-acceptance',
        operatorAdjudication: adjudication(capture),
        operatorReferenceTransport: scenario.transport(capture),
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain(scenario.error);
      expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
    });
  }

  it('rejects a byte/hash mismatch before artifact publication', () => {
    const input = fixture();
    const capture = governedCapture();
    writeFileSync(input.capturePath, capture);
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    delete evidence.invocations[0].turnResultPath;
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, 'operator-mismatch');
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: { ...adjudication(capture), verdictSha256: '0'.repeat(64) },
      operatorReferenceTransport: referenceTransport(capture),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('published verdict SHA-256 is mismatched');
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each([
    {
      name: 'tier-intake Issue mismatch',
      prepare: (input: ReturnType<typeof fixture>, capture: string) => {
        writeFileSync(input.intakePath, JSON.stringify({
          schema: 'tier-intake/v1', producer: 'flow-manager', taskIdentity: 'issue:1193',
          kind: 'fresh', priorTier: 'T2', firstRevision: 'r01',
        }));
        return { adjudication: adjudication(capture), repositoryFullName: 'chetwerikoff/orchestrator-pack' };
      },
      expected: 'operator adjudication Issue does not match authoritative tier-intake Issue',
    },
    {
      name: 'review-episode revision mismatch',
      prepare: (_input: ReturnType<typeof fixture>, capture: string) => ({
        adjudication: { ...adjudication(capture), sourceRevision: 'r02' },
        repositoryFullName: 'chetwerikoff/orchestrator-pack',
      }),
      expected: 'operator adjudication revision does not match authoritative review episode',
    },
    {
      name: 'cross-repository same-number comment',
      prepare: (_input: ReturnType<typeof fixture>, capture: string) => ({
        adjudication: {
          ...adjudication(capture),
          verdictUrl: 'https://github.com/other/repository/issues/1192#issuecomment-5194504082',
        },
        repositoryFullName: 'chetwerikoff/orchestrator-pack',
      }),
      expected: 'operator adjudication verdictUrl repository does not match authoritative repository',
    },
  ])('rejects $name before transport or artifact mutation', ({ prepare, expected }) => {
    const input = fixture();
    const capture = governedCapture();
    writeFileSync(input.capturePath, capture);
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    delete evidence.invocations[0].turnResultPath;
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, 'pre-side-effect-rejection');
    mkdirSync(outputDir, { recursive: true });
    const sentinel = join(outputDir, 'acceptance-artifacts.json');
    writeFileSync(sentinel, 'sentinel');
    const runGh = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    const prepared = prepare(input, capture);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: prepared.adjudication,
      repositoryFullName: prepared.repositoryFullName,
      operatorReferenceTransport: { runGh },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(expected);
    expect(runGh).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, 'utf8')).toBe('sentinel');
  });

  it('rejects a matching non-terminal progress comment', () => {
    const input = fixture();
    const capture = [
      'Read revision: #1192 r01',
      'review-economics-contract: v1',
      'progress: still reviewing',
      'SIMPLIFICATION_CLEAN',
      '',
    ].join('\n');
    writeFileSync(input.capturePath, capture);
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    delete evidence.invocations[0].turnResultPath;
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, 'operator-non-terminal');
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: adjudication(capture),
      operatorReferenceTransport: referenceTransport(capture),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('operator adjudication published verdict is not a canonical terminal verdict');
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each([
    {
      name: 'output metadata mismatch',
      mutateResult: (failed: Record<string, unknown>) => {
        failed.output = { byte_length: 1, sha256: '0'.repeat(64) };
      },
      mutateEvidence: (_evidence: Record<string, any>) => {},
      expected: 'output does not match capture bytes',
    },
    {
      name: 'terminal-result identity mismatch',
      mutateResult: (_failed: Record<string, unknown>) => {},
      mutateEvidence: (evidence: Record<string, any>) => {
        evidence.invocations[0].terminalResultIdentity = 'sha256:' + '0'.repeat(64) + ':turn-result.json';
      },
      expected: 'terminalResultIdentity is not derived from the referenced turn-result',
    },
  ])('continues through the existing $name guard after suppressing only non-ok state', ({ mutateResult, mutateEvidence, expected }) => {
    const input = fixture();
    const capture = governedCapture();
    writeFileSync(input.capturePath, capture);
    const failed: Record<string, unknown> = {
      schema: 'turn-result/v1',
      state: 'driver_error',
      scope: 'invocation',
      cause: 'browser_lost',
      invocation_id: 'invocation-001',
      configured_profile_key: 'fixture-profile',
      output: {
        byte_length: Buffer.byteLength(capture),
        sha256: createHash('sha256').update(capture).digest('hex'),
      },
    };
    mutateResult(failed);
    const failedText = JSON.stringify(failed);
    writeFileSync(input.turnResultPath, failedText);
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    evidence.invocations[0].terminalResultIdentity = 'sha256:'
      + createHash('sha256').update(failedText).digest('hex') + ':' + basename(input.turnResultPath);
    mutateEvidence(evidence);
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, `operator-downstream-${expected.replaceAll(' ', '-')}`);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: adjudication(capture),
      operatorReferenceTransport: referenceTransport(capture),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(expected);
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each([
    { sendCount: 0, expected: 'send_count does not match stage evidence' },
    { sendCount: 2, expected: 'send_count must be 0 or 1' },
  ])('rejects adjudicated turn-result send_count $sendCount consistently', ({ sendCount, expected }) => {
    const input = fixture();
    const capture = governedCapture();
    writeFileSync(input.capturePath, capture);
    const failed = {
      schema: 'turn-result/v1',
      state: 'driver_error',
      scope: 'invocation',
      cause: 'browser_lost',
      invocation_id: 'invocation-001',
      configured_profile_key: 'fixture-profile',
      send_count: sendCount,
      output: {
        byte_length: Buffer.byteLength(capture),
        sha256: createHash('sha256').update(capture).digest('hex'),
      },
    };
    const failedText = JSON.stringify(failed);
    writeFileSync(input.turnResultPath, failedText);
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    evidence.invocations[0].terminalResultIdentity = 'sha256:'
      + createHash('sha256').update(failedText).digest('hex') + ':' + basename(input.turnResultPath);
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, `operator-send-count-${sendCount}`);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: adjudication(capture),
      operatorReferenceTransport: referenceTransport(capture),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(expected);
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each([
    ['operator Issue', '--operator-issue-number'],
    ['verdict byte length', '--operator-verdict-byte-length'],
    ['finding count', '--operator-finding-count'],
  ])('rejects a blank numeric CLI value for %s before artifact production', (_name, blankFlag) => {
    const input = fixture();
    const capture = governedCapture();
    const args = [
      'node', 'create-issue-stage-finalize.ts', 'produce-artifacts',
      '--review-dir', input.dir,
      '--tier-intake', input.intakePath,
      '--stage-evidence', input.stageEvidencePath,
      '--author-dispositions', input.authorPath,
      '--phase', 'final-acceptance',
      '--operator-issue-number', '1192',
      '--operator-source-revision', 'r01',
      '--operator-verdict-url', adjudication(capture).verdictUrl,
      '--operator-verdict-sha256', adjudication(capture).verdictSha256,
      '--operator-verdict-byte-length', String(Buffer.byteLength(capture)),
      '--operator-finding-count', '0',
      '--operator-reason', 'direct operator reason',
    ];
    const index = args.indexOf(blankFlag);
    args[index + 1] = '';
    expect(() => runStageFinalizeCli(args)).toThrow(
      /operator adjudication requires Issue, revision, verdict URL\/hash\/bytes\/findings, and reason/,
    );
  });

});






describe('Issue #1341 accepted operator-input smoke matrix completion', () => {
  const HEAD_A_1341 = 'a'.repeat(40);
  const HEAD_B_1341 = 'b'.repeat(40);
  const REPOSITORY_1341 = 'chetwerikoff/orchestrator-pack';

  function gateAIssueBody(): string {
    return [
      '```complexity-tier',
      'tier: T1',
      'advisory-prior: T1',
      '```',
    ].join('\n');
  }

  function gateAInput(
    storeRoot: string,
    boundSnapshot: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber: 1341,
      headSha: HEAD_A_1341,
      operatorRepository: REPOSITORY_1341,
      operatorIssueNumber: 1341,
      operatorBoundSnapshot: boundSnapshot,
      operatorReason: 'direct operator recovery for the exact blocked review',
      claimMode: 'preacquired',
      fixtureCurrentPrHeadSha: HEAD_A_1341,
      fixturePrState: 'OPEN',
      fixtureRepoSlug: REPOSITORY_1341,
      fixturePostReviewHeadSha: HEAD_A_1341,
      fixtureIssueBody: gateAIssueBody(),
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      ...overrides,
    };
  }

  async function withGateAEnvironment<T>(run: () => Promise<T>): Promise<T> {
    const saved = { ...process.env };
    try {
      process.env.OPK_VITEST_HARNESS = '1';
      process.env.PACK_REVIEWER = 'codex';
      return await run();
    } finally {
      process.env = saved;
    }
  }

  it('admits a complete Gate A operator target through the actual direct CLI', async () => {
    const { captureBoundIssueSnapshot, computeBoundIssueSnapshotHash } = await import('./reverify-bound-issue-snapshot.js');
    const { listPackReviewRuns } = await import('./pack-review-run-store.js');
    const { runProcessSync } = await import('../kernel/subprocess.js');
    const { chmodSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'opk-1341-gate-a-cli-'));
    tempDirs.push(root);
    const storeRoot = join(root, 'store');
    const capture = join(root, 'github-review.json');
    const binRoot = join(root, 'bin');
    mkdirSync(binRoot, { recursive: true });
    if (process.platform === 'win32') {
      writeFileSync(join(binRoot, 'gh.cmd'), '@echo off\r\necho {}\r\nexit /b 0\r\n');
    } else {
      const gh = join(binRoot, 'gh');
      writeFileSync(gh, '#!/usr/bin/env node\nprocess.stdout.write("{}\\n");\n');
      chmodSync(gh, 0o755);
    }
    const issueBody = gateAIssueBody();
    const snapshotStore = join(root, 'bound-snapshots');
    const captured = captureBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 1341,
      prHeadSha: HEAD_A_1341,
      issueNumber: 1341,
      issueBody,
      storeDirOverride: snapshotStore,
    });
    const digest = computeBoundIssueSnapshotHash(issueBody);
    expect(captured.snapshotHash).toBe(digest);
    const result = runProcessSync({
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        join(process.cwd(), 'scripts', 'pack-review-runner.ts'),
        'start',
        '--pr-number', '1341',
        '--head-sha', HEAD_A_1341,
        '--operator-repository', REPOSITORY_1341,
        '--operator-issue-number', '1341',
        '--operator-bound-snapshot', digest,
        '--operator-reason', 'direct operator CLI recovery',
      ],
      cwd: process.cwd(),
      input: JSON.stringify({
        projectId: 'orchestrator-pack',
        storeRoot,
        sourceRepoRoot: process.cwd(),
        claimMode: 'preacquired',
        fixtureCurrentPrHeadSha: HEAD_A_1341,
        fixturePrState: 'OPEN',
        fixtureRepoSlug: REPOSITORY_1341,
        fixturePostReviewHeadSha: HEAD_A_1341,
        fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
        fixtureGithubReviewId: 1341,
      }),
      env: {
        ...process.env,
        OPK_VITEST_HARNESS: '1',
        PACK_REVIEWER: 'codex',
        PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE: capture,
        OPK_BASE_DIR: join(root, 'ao-base'),
        OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR: snapshotStore,
        PATH: `${binRoot}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      timeoutMs: 30_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, created: true });
    const runs = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      prNumber: 1341,
      targetSha: HEAD_A_1341,
      canonicalRepository: REPOSITORY_1341,
      linkedSessionId: '',
      startReason: 'direct operator CLI recovery',
    });
    expect(runs[0]?.surface).toContain('operator_adjudicated');
    expect(runs[0]?.surface).toContain('session-binding=absent');
    expect(existsSync(capture)).toBe(true);
  }, 30_000);

  it.each([
    ['repository omitted', 'operatorRepository', undefined],
    ['repository blank', 'operatorRepository', '   '],
    ['Issue omitted', 'operatorIssueNumber', undefined],
    ['Issue blank', 'operatorIssueNumber', '   '],
    ['snapshot omitted', 'operatorBoundSnapshot', undefined],
    ['snapshot blank', 'operatorBoundSnapshot', '   '],
    ['reason omitted', 'operatorReason', undefined],
    ['reason blank', 'operatorReason', '   '],
    ['short head', 'headSha', 'a'.repeat(39)],
    ['stale head', 'headSha', HEAD_B_1341],
    ['closed PR', 'fixturePrState', 'CLOSED'],
  ])('rejects Gate A %s before any run, status, notification, or reviewer side effect', async (
    _name,
    field,
    value,
  ) => {
    await withGateAEnvironment(async () => {
      const { startPackReview } = await import('../pack-review-runner.js');
      const { listPackReviewRuns } = await import('./pack-review-run-store.js');
      const { computeBoundIssueSnapshotHash } = await import('./reverify-bound-issue-snapshot.js');
      const root = mkdtempSync(join(tmpdir(), 'opk-1341-gate-a-fields-'));
      tempDirs.push(root);
      const storeRoot = join(root, 'store');
      const invocationLog = join(root, 'reviewer-invocations.jsonl');
      process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
      let started = false;
      let statusWrites = 0;
      let notifications = 0;
      const input = gateAInput(
        storeRoot,
        computeBoundIssueSnapshotHash(gateAIssueBody()),
        {
          [field]: value,
          onRunStarted: () => { started = true; },
          fixtureRequiredStatusWriter: async () => { statusWrites += 1; },
          fixtureWorkerNotifier: async () => {
            notifications += 1;
            return { state: 'delivered' as const, reason: 'fixture' };
          },
        },
      );
      await expect(startPackReview(input as Parameters<typeof startPackReview>[0])).rejects.toThrow();
      expect(started).toBe(false);
      expect(statusWrites).toBe(0);
      expect(notifications).toBe(0);
      expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toEqual([]);
      expect(existsSync(invocationLog)).toBe(false);
    });
  });

  it.each([
    ['missing snapshot evidence', 'missing'],
    ['stale head-bound snapshot evidence', 'stale'],
    ['multiple competing snapshot paths', 'multiple'],
    ['mismatched snapshot identity', 'mismatched'],
  ])('rejects Gate A %s before run/subprocess creation', async (_name, scenario) => {
    await withGateAEnvironment(async () => {
      const { startPackReview } = await import('../pack-review-runner.js');
      const { listPackReviewRuns } = await import('./pack-review-run-store.js');
      const {
        boundIssueSnapshotArtifactPaths,
        captureBoundIssueSnapshot,
        computeBoundIssueSnapshotHash,
      } = await import('./reverify-bound-issue-snapshot.js');
      const root = mkdtempSync(join(tmpdir(), 'opk-1341-gate-a-snapshot-'));
      tempDirs.push(root);
      const storeRoot = join(root, 'store');
      const snapshotStore = join(root, 'snapshots');
      const body = gateAIssueBody();
      const digest = computeBoundIssueSnapshotHash(body);
      process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR = snapshotStore;
      delete process.env.OPK_BOUND_ISSUE_SNAPSHOT_PATH;
      if (scenario === 'stale') {
        const paths = boundIssueSnapshotArtifactPaths({
          projectId: 'orchestrator-pack',
          prNumber: 1341,
          prHeadSha: HEAD_A_1341,
          issueNumber: 1341,
          storeDirOverride: snapshotStore,
        });
        mkdirSync(join(snapshotStore, 'pr-1341', HEAD_A_1341.slice(0, 12)), { recursive: true });
        writeFileSync(paths.snapshotPath, body);
        writeFileSync(paths.metadataPath, JSON.stringify({
          schemaVersion: 1,
          projectId: 'orchestrator-pack',
          prNumber: 1341,
          prHeadSha: HEAD_B_1341,
          issueNumber: 1341,
          snapshotHash: digest,
          capturedAt: '2026-08-05T00:00:00.000Z',
          capturePhase: 'review-preflight',
        }));
      } else if (scenario !== 'missing') {
        const captured = captureBoundIssueSnapshot({
          projectId: 'orchestrator-pack',
          prNumber: 1341,
          prHeadSha: HEAD_A_1341,
          issueNumber: 1341,
          issueBody: body,
          storeDirOverride: snapshotStore,
        });
        if (scenario === 'multiple') {
          const duplicate = join(root, 'duplicate-bound-issue.md');
          writeFileSync(duplicate, body);
          process.env.OPK_BOUND_ISSUE_SNAPSHOT_PATH = duplicate;
          expect(captured.snapshotPath).not.toBe(duplicate);
        }
      }
      const invocationLog = join(root, 'reviewer-invocations.jsonl');
      process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
      let started = false;
      const input = gateAInput(storeRoot, scenario === 'mismatched'
        ? computeBoundIssueSnapshotHash(`${body}\nchanged`)
        : digest, {
        fixtureIssueBody: undefined,
        onRunStarted: () => { started = true; },
      });
      await expect(startPackReview(input as Parameters<typeof startPackReview>[0])).rejects.toThrow(
        /snapshot (missing|corrupted)|snapshot file path does not match|does not match authoritative review context/,
      );
      expect(started).toBe(false);
      expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toEqual([]);
      expect(existsSync(invocationLog)).toBe(false);
    });
  });

  it('rejects Gate A active/reuse and journaled/resume candidates before delivery or reviewer side effects', async () => {
    await withGateAEnvironment(async () => {
      const { startPackReview } = await import('../pack-review-runner.js');
      const {
        createPackReviewRun,
        getPackReviewRun,
        listPackReviewRuns,
        setPackReviewRunTerminal,
        updatePackReviewRun,
      } = await import('./pack-review-run-store.js');
      const { computeBoundIssueSnapshotHash } = await import('./reverify-bound-issue-snapshot.js');
      for (const kind of ['active', 'journaled-resume'] as const) {
        const root = mkdtempSync(join(tmpdir(), `opk-1341-gate-a-${kind}-`));
        tempDirs.push(root);
        const storeRoot = join(root, 'store');
        const invocationLog = join(root, 'reviewer-invocations.jsonl');
        process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
        const created = createPackReviewRun({
          projectId: 'orchestrator-pack',
          storeRoot,
          prNumber: 1341,
          headSha: HEAD_A_1341,
          linkedSessionId: 'original-session',
          startReason: 'original reason',
          surface: 'original surface',
          trustedPackRoot: process.cwd(),
          sourceRepoRoot: process.cwd(),
          canonicalRepository: REPOSITORY_1341,
        });
        if (kind === 'journaled-resume') {
          setPackReviewRunTerminal(created.run.id, 'commented', {
            reviewVerdict: 'clean',
            findingCount: 0,
            findings: [],
          }, { projectId: 'orchestrator-pack', storeRoot });
          updatePackReviewRun(created.run.id, {
            journalOutcome: {
              state: 'persisted',
              recordedAtUtc: '2026-08-05T00:00:00.000Z',
              reason: 'fixture persisted verdict',
              idempotencyKey: `verdict:${created.run.id}:${HEAD_A_1341}`,
              attempts: 1,
            },
          }, { projectId: 'orchestrator-pack', storeRoot });
        }
        let statusWrites = 0;
        let notifications = 0;
        await expect(startPackReview(gateAInput(
          storeRoot,
          computeBoundIssueSnapshotHash(gateAIssueBody()),
          {
            fixtureRequiredStatusWriter: async () => { statusWrites += 1; },
            fixtureWorkerNotifier: async () => {
              notifications += 1;
              return { state: 'delivered' as const, reason: 'fixture' };
            },
          },
        ) as Parameters<typeof startPackReview>[0])).rejects.toThrow(/cannot reuse or resume existing same-head run/);
        expect(statusWrites).toBe(0);
        expect(notifications).toBe(0);
        expect(existsSync(invocationLog)).toBe(false);
        expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(1);
        expect(getPackReviewRun(created.run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
          linkedSessionId: 'original-session',
          startReason: 'original reason',
          surface: 'original surface',
        });
      }
    });
  });

  it.each(['worker', 'reviewer', 'flow-manager'])(
    'prevents the %s autonomous stdin surface from minting Gate A operator authority',
    async (surface) => {
      const { runProcessSync } = await import('../kernel/subprocess.js');
      const { computeBoundIssueSnapshotHash } = await import('./reverify-bound-issue-snapshot.js');
      const root = mkdtempSync(join(tmpdir(), `opk-1341-gate-a-mint-${surface}-`));
      tempDirs.push(root);
      const storeRoot = join(root, 'store');
      const result = runProcessSync({
        command: process.execPath,
        args: [
          '--experimental-strip-types',
          join(process.cwd(), 'scripts', 'pack-review-runner.ts'),
          'start',
          '--pr-number', '1341',
          '--head-sha', HEAD_A_1341,
        ],
        cwd: process.cwd(),
        input: JSON.stringify({
          projectId: 'orchestrator-pack',
          storeRoot,
          sourceRepoRoot: process.cwd(),
          surface,
          actor: 'operator',
          operatorRepository: REPOSITORY_1341,
          operatorIssueNumber: 1341,
          operatorBoundSnapshot: computeBoundIssueSnapshotHash(gateAIssueBody()),
          operatorReason: 'autonomous caller supplied prose',
        }),
        env: {
          ...process.env,
          OPK_VITEST_HARNESS: '1',
          PACK_REVIEWER: 'codex',
        },
        encoding: 'utf8',
        timeoutMs: 15_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'operator pack-review start inputs are accepted only from direct CLI arguments',
      );
      expect(existsSync(storeRoot)).toBe(false);
    },
  );

  it('keeps Gate A no-input failure bytes and side effects bit-for-bit identical', async () => {
    const saved = { ...process.env };
    try {
      delete process.env.OPK_VITEST_HARNESS;
      const { startPackReview } = await import('../pack-review-runner.js');
      const { listPackReviewRuns } = await import('./pack-review-run-store.js');
      const roots = [
        mkdtempSync(join(tmpdir(), 'opk-1341-gate-a-parity-a-')),
        mkdtempSync(join(tmpdir(), 'opk-1341-gate-a-parity-b-')),
      ];
      tempDirs.push(...roots);
      const base = {
        projectId: 'orchestrator-pack',
        sourceRepoRoot: process.cwd(),
        prNumber: 1341,
        headSha: HEAD_A_1341,
      };
      const messages: string[] = [];
      for (const [index, root] of roots.entries()) {
        try {
          await startPackReview(index === 0
            ? { ...base, storeRoot: root }
            : {
                ...base,
                storeRoot: root,
                operatorRepository: undefined,
                operatorIssueNumber: undefined,
                operatorBoundSnapshot: undefined,
                operatorReason: undefined,
              });
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
      }
      expect(Buffer.from(messages[0] ?? '')).toEqual(Buffer.from(messages[1] ?? ''));
      expect(messages[0]).toBe('pack review target requires an immutable session PR/Issue binding');
      for (const root of roots) {
        expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot: root })).toEqual([]);
      }
    } finally {
      process.env = saved;
    }
  });

  function governedCapture1341(overrides: string[] = []): string {
    return [
      'Read revision: #1192 r01',
      'review-economics-contract: v1',
      'VERDICT: CLEAN',
      'NO_FINDINGS',
      'SIMPLIFICATION_CLEAN',
      'FINDING_COUNT: 0',
      'INVOCATION_ID: fixture-terminal-1192',
      ...overrides,
      '',
    ].join('\n');
  }

  function adjudication1341(capture: string) {
    return {
      issueNumber: 1192,
      sourceRevision: 'r01',
      verdictUrl: 'https://github.com/chetwerikoff/orchestrator-pack/issues/1192#issuecomment-5194504082',
      verdictSha256: createHash('sha256').update(capture).digest('hex'),
      verdictByteLength: Buffer.byteLength(capture),
      verdictFindingCount: 0,
      reason: 'operator confirmed the already-published exact terminal verdict',
    };
  }

  function referenceTransport1341(
    capture: string,
    overrides: Record<string, unknown> = {},
    exitCode = 0,
  ) {
    return {
      runGh: vi.fn(() => ({
        exitCode,
        stderr: exitCode === 0 ? '' : 'not found',
        stdout: exitCode === 0 ? JSON.stringify({
          id: 5194504082,
          html_url: adjudication1341(capture).verdictUrl,
          issue_url: 'https://api.github.com/repos/chetwerikoff/orchestrator-pack/issues/1192',
          body: capture,
          created_at: '2026-08-05T15:00:00Z',
          updated_at: '2026-08-05T15:00:00Z',
          user: { login: 'chetwerikoff' },
          author_association: 'OWNER',
          ...overrides,
        }) : '',
      })),
    };
  }

  function absentGateBFixture() {
    const input = fixture();
    const capture = governedCapture1341();
    writeFileSync(input.capturePath, capture);
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    delete evidence.invocations[0].turnResultPath;
    evidence.invocations[0].terminalResultIdentity = 'recorded-missing-transport-artifact';
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    rmSync(input.turnResultPath, { force: true });
    return { input, capture, evidence };
  }

  function baseGateBArgs(input: ReturnType<typeof fixture>, capture: string): string[] {
    return [
      'node', 'create-issue-stage-finalize.ts', 'produce-artifacts',
      '--review-dir', input.dir,
      '--tier-intake', input.intakePath,
      '--stage-evidence', input.stageEvidencePath,
      '--author-dispositions', input.authorPath,
      '--output-dir', join(input.dir, 'cli-output'),
      '--phase', 'final-acceptance',
      '--operator-issue-number', '1192',
      '--operator-source-revision', 'r01',
      '--operator-verdict-url', adjudication1341(capture).verdictUrl,
      '--operator-verdict-sha256', adjudication1341(capture).verdictSha256,
      '--operator-verdict-byte-length', String(Buffer.byteLength(capture)),
      '--operator-finding-count', '0',
      '--operator-reason', 'direct operator reason',
    ];
  }

  it.each([
    ['Issue', '--operator-issue-number'],
    ['revision', '--operator-source-revision'],
    ['verdict URL', '--operator-verdict-url'],
    ['verdict SHA-256', '--operator-verdict-sha256'],
    ['verdict byte length', '--operator-verdict-byte-length'],
    ['finding count', '--operator-finding-count'],
    ['reason', '--operator-reason'],
  ])('rejects Gate B when %s is omitted or blank before artifact production', (_name, flag) => {
    for (const mode of ['omitted', 'blank'] as const) {
      const { input, capture } = absentGateBFixture();
      const args = baseGateBArgs(input, capture);
      const index = args.indexOf(flag);
      if (mode === 'omitted') args.splice(index, 2);
      else args[index + 1] = '   ';
      expect(() => runStageFinalizeCli(args)).toThrow(
        /operator adjudication requires Issue, revision, verdict URL\/hash\/bytes\/findings, and reason/,
      );
      expect(existsSync(join(input.dir, 'cli-output'))).toBe(false);
    }
  });

  it.each([
    {
      name: 'wrong authoritative Issue',
      adjudication: (capture: string) => ({ ...adjudication1341(capture), issueNumber: 1193 }),
      transport: (capture: string) => referenceTransport1341(capture),
      expected: 'Issue does not match authoritative tier-intake Issue',
      transportCalled: false,
    },
    {
      name: 'wrong authoritative revision',
      adjudication: (capture: string) => ({ ...adjudication1341(capture), sourceRevision: 'r02' }),
      transport: (capture: string) => referenceTransport1341(capture),
      expected: 'revision does not match authoritative review episode',
      transportCalled: false,
    },
    {
      name: 'wrong byte length',
      adjudication: (capture: string) => ({ ...adjudication1341(capture), verdictByteLength: Buffer.byteLength(capture) + 1 }),
      transport: (capture: string) => referenceTransport1341(capture),
      expected: 'published verdict byte length is mismatched',
      transportCalled: true,
    },
    {
      name: 'wrong finding count',
      adjudication: (capture: string) => ({ ...adjudication1341(capture), verdictFindingCount: 1 }),
      transport: (capture: string) => referenceTransport1341(capture),
      expected: 'published verdict finding count is mismatched',
      transportCalled: true,
    },
    {
      name: 'wrong comment identity',
      adjudication: (capture: string) => adjudication1341(capture),
      transport: (capture: string) => referenceTransport1341(capture, { id: 5194504083 }),
      expected: 'published verdict reference identity is mismatched',
      transportCalled: true,
    },
    {
      name: 'unbound Issue reference',
      adjudication: (capture: string) => adjudication1341(capture),
      transport: (capture: string) => referenceTransport1341(capture, {
        issue_url: 'https://api.github.com/repos/chetwerikoff/orchestrator-pack/issues/1193',
      }),
      expected: 'published verdict reference identity is mismatched',
      transportCalled: true,
    },
  ])('rejects Gate B $name before artifact publication', (scenario) => {
    const { input, capture } = absentGateBFixture();
    const outputDir = join(input.dir, `gate-b-${scenario.name.replaceAll(' ', '-')}`);
    mkdirSync(outputDir, { recursive: true });
    const sentinel = join(outputDir, 'acceptance-artifacts.json');
    writeFileSync(sentinel, 'sentinel');
    const transport = scenario.transport(capture);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: scenario.adjudication(capture),
      operatorReferenceTransport: transport,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(scenario.expected);
    expect(transport.runGh).toHaveBeenCalledTimes(scenario.transportCalled ? 1 : 0);
    expect(readFileSync(sentinel, 'utf8')).toBe('sentinel');
  });

  it('rejects a matching non-terminal Gate B reference before artifact publication', () => {
    const { input } = absentGateBFixture();
    const progress = [
      'Read revision: #1192 r01',
      'review-economics-contract: v1',
      'progress: still reviewing',
      'SIMPLIFICATION_CLEAN',
      '',
    ].join('\n');
    writeFileSync(input.capturePath, progress);
    const outputDir = join(input.dir, 'gate-b-non-terminal');
    mkdirSync(outputDir, { recursive: true });
    const sentinel = join(outputDir, 'acceptance-artifacts.json');
    writeFileSync(sentinel, 'sentinel');
    const transport = referenceTransport1341(progress);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: adjudication1341(progress),
      operatorReferenceTransport: transport,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('operator adjudication published verdict is not a canonical terminal verdict');
    expect(transport.runGh).toHaveBeenCalledTimes(1);
    expect(readFileSync(sentinel, 'utf8')).toBe('sentinel');
  });

  it('rejects an ambiguous operator match across multiple governed invocations', () => {
    const { input, capture, evidence } = absentGateBFixture();
    evidence.invocations.push({
      ...evidence.invocations[0],
      reviewerSlot: '02',
      reviewerOrdinal: 2,
      invocationId: 'invocation-002',
      terminalResultIdentity: 'recorded-missing-transport-artifact-2',
    });
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, 'gate-b-ambiguous');
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: adjudication1341(capture),
      operatorReferenceTransport: referenceTransport1341(capture),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'operator adjudication must match exactly one absent or non-ok terminal invocation; matched 2',
    );
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each([
    {
      name: 'terminal settlement remains red',
      mutate: (input: ReturnType<typeof fixture>) => {
        const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
        evidence.settlement.allLaunchedTerminal = false;
        writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
      },
      expected: 'terminal settlement',
    },
    {
      name: 'invocation revision check remains red',
      mutate: (input: ReturnType<typeof fixture>) => {
        const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
        evidence.invocations[0].revisionCheck = 'stale';
        writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
      },
      expected: 'revisionCheck must be matched',
    },
    {
      name: 'author disposition evidence remains red',
      mutate: (input: ReturnType<typeof fixture>) => {
        writeFileSync(input.authorPath, JSON.stringify({ schema: AUTHOR_DISPOSITIONS_SCHEMA, findings: [null] }));
      },
      expected: 'author dispositions findings[0] must be an object',
    },
  ])('keeps the downstream $name guard red after only transport substitution', (scenario) => {
    const { input, capture } = absentGateBFixture();
    scenario.mutate(input);
    const outputDir = join(input.dir, `gate-b-downstream-${scenario.name.replaceAll(' ', '-')}`);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: adjudication1341(capture),
      operatorReferenceTransport: referenceTransport1341(capture),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(scenario.expected);
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each(['worker', 'reviewer', 'flow-manager'])(
    'does not let %s prose or actor fields mint Gate B authority',
    (surface) => {
      const { input } = absentGateBFixture();
      const outputDir = join(input.dir, `gate-b-mint-${surface}`);
      const result = produceAcceptanceArtifacts({
        reviewDir: input.dir,
        outputDir,
        tierIntakePath: input.intakePath,
        stageEvidencePaths: [input.stageEvidencePath],
        authorDispositionsPath: input.authorPath,
        phase: 'final-acceptance',
        actor: 'operator',
        publicActor: surface,
        operatorReason: 'autonomous prose is not structured authority',
      } as Parameters<typeof produceAcceptanceArtifacts>[0] & Record<string, unknown>);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('stage evidence invocation[0].turnResultPath is missing');
      expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
    },
  );

  it('keeps Gate B ordinary state=ok artifact bytes bit-for-bit unchanged without operator input', () => {
    const input = fixture();
    const outputA = join(input.dir, 'parity-a');
    const outputB = join(input.dir, 'parity-b');
    const common = {
      reviewDir: input.dir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance' as const,
    };
    const first = produceAcceptanceArtifacts({ ...common, outputDir: outputA });
    const second = produceAcceptanceArtifacts({
      ...common,
      outputDir: outputB,
      operatorAdjudication: undefined,
      operatorReferenceTransport: undefined,
      repositoryFullName: undefined,
    } as Parameters<typeof produceAcceptanceArtifacts>[0]);
    expect(first.ok, first.errors.join('\n')).toBe(true);
    expect(second.ok, second.errors.join('\n')).toBe(true);
    expect(first.files).toEqual(second.files);
    for (const file of first.files) {
      expect(readFileSync(join(outputA, file))).toEqual(readFileSync(join(outputB, file)));
    }
  });

  it.each(['absent', 'non-ok'])(
    'keeps Gate B ordinary %s failure bytes and no-write behavior bit-for-bit unchanged',
    (transportState) => {
      const input = fixture();
      if (transportState === 'absent') {
        const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
        delete evidence.invocations[0].turnResultPath;
        writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
        rmSync(input.turnResultPath, { force: true });
      } else {
        const failed = {
          schema: 'turn-result/v1',
          state: 'driver_error',
          scope: 'invocation',
          cause: 'browser_lost',
          invocation_id: 'invocation-001',
          configured_profile_key: 'fixture-profile',
          output: {
            byte_length: Buffer.byteLength(CLEAN_CAPTURE),
            sha256: createHash('sha256').update(CLEAN_CAPTURE).digest('hex'),
          },
        };
        const failedText = JSON.stringify(failed);
        writeFileSync(input.turnResultPath, failedText);
        const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
        evidence.invocations[0].terminalResultIdentity = 'sha256:'
          + createHash('sha256').update(failedText).digest('hex') + ':' + basename(input.turnResultPath);
        writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
      }
      const outputs = [join(input.dir, 'failure-a'), join(input.dir, 'failure-b')];
      const common = {
        reviewDir: input.dir,
        tierIntakePath: input.intakePath,
        stageEvidencePaths: [input.stageEvidencePath],
        authorDispositionsPath: input.authorPath,
        phase: 'final-acceptance' as const,
      };
      const first = produceAcceptanceArtifacts({ ...common, outputDir: outputs[0] });
      const second = produceAcceptanceArtifacts({
        ...common,
        outputDir: outputs[1],
        operatorAdjudication: undefined,
        operatorReferenceTransport: undefined,
        repositoryFullName: undefined,
      } as Parameters<typeof produceAcceptanceArtifacts>[0]);
      expect(first.ok).toBe(false);
      expect(second.ok).toBe(false);
      expect(Buffer.from(first.errors.join('\n'))).toEqual(Buffer.from(second.errors.join('\n')));
      expect(first.files).toEqual([]);
      expect(second.files).toEqual([]);
      expect(existsSync(join(outputs[0], 'acceptance-artifacts.json'))).toBe(false);
      expect(existsSync(join(outputs[1], 'acceptance-artifacts.json'))).toBe(false);
    },
  );
});
