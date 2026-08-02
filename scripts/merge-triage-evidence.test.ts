import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMergeTriageEvidenceRecord,
  classifyTextOnlyMergeTriageCandidate,
  deriveMergeTriageEvidenceTuple,
  expectedMergeTriageEvidenceKey,
  parseIssueDenylist,
  produceMergeTriageEvidence,
  selectMergeTriageEvidence,
} from './merge-triage-evidence.ts';

const roots: string[] = [];
const makeRoot = () => {
  const storeRoot = mkdtempSync(join(tmpdir(), 'merge-triage-evidence-test-'));
  roots.push(storeRoot);
  return { storeRoot, now: new Date('2026-08-03T00:00:00.000Z') };
};
const issueBody = '```denylist\nvendor/**\n.github/workflows/**\n```';
const makeTuple = (head = 'a'.repeat(40)) => deriveMergeTriageEvidenceTuple({
  repository: 'chetwerikoff/orchestrator-pack',
  prNumber: 898,
  cycleId: 'cycle-1',
  currentHeadSha: head,
  atCapHash: 'at-cap-hash',
  producerExecutableBytes: 'trusted producer bytes',
  boundIssueSnapshotBytes: issueBody,
  changedPathCaptureBytes: `vendor/file.ts@${head}`,
  input: { changedPaths: ['vendor/file.ts'] },
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #898 trusted at-cap evidence', () => {
  it('selects trusted current-head evidence and reproduces it after at-cap head shift', () => {
    const options = makeRoot();
    const tupleA = makeTuple();
    const produced = produceMergeTriageEvidence({
      tuple: tupleA,
      changedPaths: ['vendor/file.ts', 'README.md'],
      issueBody,
      options,
    });
    expect(produced.record.matchedPaths).toEqual(['vendor/file.ts']);
    expect(selectMergeTriageEvidence({ tuple: tupleA, options })).toMatchObject({
      kind: 'selected',
      verdict: 'BLOCK',
      reason: 'trusted_current_head_denylist_intersection',
    });

    const tupleB = makeTuple('b'.repeat(40));
    expect(expectedMergeTriageEvidenceKey(tupleB)).not.toBe(expectedMergeTriageEvidenceKey(tupleA));
    expect(selectMergeTriageEvidence({ tuple: tupleB, options })).toEqual({
      kind: 'missing',
      verdict: 'PENDING_OPERATOR',
      reason: 'evidence_missing',
    });
    produceMergeTriageEvidence({
      tuple: tupleB,
      changedPaths: ['README.md'],
      issueBody,
      options,
    });
    expect(selectMergeTriageEvidence({ tuple: tupleB, options })).toMatchObject({
      kind: 'selected',
      verdict: 'PENDING_ARCHITECT',
    });
  });

  it('never turns marker text or a text-derived scope candidate into automatic BLOCK', () => {
    expect(classifyTextOnlyMergeTriageCandidate({ blockMarker: true })).toEqual({
      verdict: 'PENDING_ARCHITECT',
      reason: 'block_marker_requires_architect_or_trusted_producer',
    });
    expect(classifyTextOnlyMergeTriageCandidate({ scopeViolationCandidate: true })).toEqual({
      verdict: 'PENDING_ARCHITECT',
      reason: 'scope_candidate_requires_trusted_producer',
    });
  });

  it('fails closed when two differing rows claim the same expected tuple', () => {
    const options = makeRoot();
    const tuple = makeTuple();
    const produced = produceMergeTriageEvidence({
      tuple,
      changedPaths: ['vendor/file.ts'],
      issueBody,
      options,
    });
    const forged = buildMergeTriageEvidenceRecord({
      tuple,
      changedPaths: ['README.md'],
      denylistPatterns: parseIssueDenylist(issueBody),
      producedAtUtc: '2026-08-03T00:01:00.000Z',
    });
    const duplicatePath = join(options.storeRoot, 'immutable', 'evidence', 'forged-duplicate.json');
    mkdirSync(dirname(duplicatePath), { recursive: true });
    writeFileSync(duplicatePath, `${JSON.stringify(forged)}\n`, 'utf8');
    expect(readFileSync(duplicatePath, 'utf8')).not.toContain(produced.digest);
    expect(selectMergeTriageEvidence({ tuple, options })).toEqual({
      kind: 'authority_conflict',
      verdict: 'PENDING_OPERATOR',
      reason: 'evidence_ambiguous',
    });
  });
});
