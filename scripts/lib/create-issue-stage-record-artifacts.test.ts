import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { runStageFinalizeCli } from './create-issue-stage-record-cli.ts';

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
  writeFileSync(capturePath, CLEAN_CAPTURE);
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
      terminalResultIdentity: 'result-001',
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
  return { dir, capturePath, stageEvidencePath, intakePath, authorPath, evidence };
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
      '```contract-evidence', 'none', '```', 'r01',
    ].join('\n');
    const acceptance = executeFinalAcceptanceGuards({
      issueBody,
      issueRevision: REVISION,
      cycleId: 'cycle-1192',
      tier: 'T2',
      reviewDir: outputDir,
      tierIntakePath: input.intakePath,
      stageReceiptPaths: [receiptPath],
      capturePaths: [input.capturePath],
      ledgerPath: join(outputDir, 'finding-disposition-ledger.json'),
      relayEvidencePaths: [join(outputDir, 'verified-relay-evidence.json')],
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
    expect(produced.errors.join('\n')).toContain('no completed-stage evidence');
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

  it('rejects artifact-only flags on journal commands instead of ignoring them', () => {
    for (const [flag, value] of [
      ['--review-dir', '/tmp/review'],
      ['--tier-intake', '/tmp/intake.json'],
      ['--stage-evidence', '/tmp/evidence.json'],
      ['--author-dispositions', '/tmp/dispositions.json'],
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
