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
