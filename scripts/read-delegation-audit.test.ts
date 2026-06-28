import { execFileSync, spawn, execSync } from 'node:child_process';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AuditVerdict, ReadEntry, ReadKind, WorkUnit } from '../docs/read-delegation-audit.d.mts';
import {
  appendMetricRecord,
  auditWorkUnit,
  auditWorkUnits,
  countFileLinesFromDisk,
  countTextLines,
  currentHookWiringFingerprint,
  evaluateStopAudit,
  matchesCoworkerAskCommand,
  extractEventsFromTranscript,
  extractEventsFromTranscriptRecords,
  inferShellReadAroundRead,
  inferShellReadAroundReads,
  extractShellCommandPaths,
  isInboundUserRequest,
  loadMetricWindowSummary,
  measureReadToolLines,
  measureShellDiffLogLines,
  partitionEventsIntoWorkUnits,
  populateStopAuditPayload,
  resolveReadToolPath,
  runStopAudit,
  SURFACES,
  T1_VOLUME_FLOOR,
  CURSOR_ADVISORY_CLASSIFICATIONS,
  toolUseToAuditEvents,
} from '../docs/read-delegation-audit.mjs';
import { classifierManifestHash } from '../docs/read-delegation-classifier.mjs';

type StopAuditResult = {
  ok: boolean;
  failOpen?: boolean;
  verdicts: AuditVerdict[];
  summary: {
    delegableTriggerUnits: number;
    flaggedUnits: number;
    flaggedReadLines: number;
    indexServedExcludedLines?: number;
    advisoryUnits?: number;
    advisorySatisfiedUnits?: number;
    advisoryExcludedLines?: number;
    residualNonCompliance: number;
    denominatorCause?: string;
    reviewHookCaptureBranch?: string;
    degraded?: boolean;
  };
  flags: AuditVerdict[];
  error?: string;
  health?: Record<string, unknown>;
  metric?: {
    artifactPath: string;
    window: Record<string, unknown>;
  };
};

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'scripts/fixtures/read-delegation-audit');
const auditModule = path.join(repoRoot, 'docs/read-delegation-audit.mjs');

type FixtureExpect = {
  triggerFired?: boolean;
  excludedFromDenominator?: boolean;
  flagged?: boolean;
  inDenominator?: boolean;
  diffLog?: boolean;
  selfAttestedDelegation?: boolean;
  machineObservedDelegation?: boolean;
  reviewerPath?: boolean;
  codeClass?: boolean;
  allIndexServed?: boolean;
  indexServedExcludedLines?: number;
  advisory?: boolean;
  advisoryOutcome?: string;
  advisorySatisfied?: boolean;
  shellReadAround?: boolean;
  reviewSignalState?: string;
};

type FixturePayload = {
  description?: string;
  surface?: string;
  reviewerPath?: boolean;
  reviewerPathSource?: string;
  reviewSignal?: Record<string, unknown>;
  env?: Record<string, string>;
  workUnits?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  expect?: FixtureExpect;
  expectUnits?: Array<{ key: string; triggerFired: boolean; flagged: boolean }>;
  expectSummary?: {
    delegableTriggerUnits: number;
    flaggedUnits: number;
    advisoryUnits?: number;
    advisoryExcludedLines?: number;
    residualNonCompliance: number;
    denominatorCause?: string;
    reviewHookCaptureBranch?: string;
  };
  injectError?: boolean;
  expectHealth?: boolean;
  expectDegraded?: boolean;
};

function loadFixture(name: string): FixturePayload {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8')) as FixturePayload;
}

function currentFixtureCaptureCommit() {
  return execSync('git rev-parse HEAD', {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function enrichFixtureCaptureMetadata(
  workUnits: Array<Record<string, unknown>> | undefined,
): WorkUnit[] | undefined {
  if (!workUnits) {
    return undefined;
  }
  const commit = currentFixtureCaptureCommit();
  const manifestHash = classifierManifestHash();
  return workUnits.map((unit) => {
    const useCapture = unit.useCaptureMetadata === true;
    const reads = Array.isArray(unit.reads)
      ? unit.reads.map((read, index) => {
          const row = read as Record<string, unknown>;
          const needsCapture = useCapture || row.useCaptureMetadata === true;
          return {
            ...(row as ReadEntry),
            readDiscriminator: String(row.readDiscriminator ?? index),
            surface: needsCapture ? String(row.surface ?? 'cursor') : (row.surface as string | undefined),
            capturedCommit: needsCapture ? commit : (row.capturedCommit as string | undefined),
            classifierManifestHash: needsCapture
              ? manifestHash
              : (row.classifierManifestHash as string | undefined),
          };
        })
      : [];
    return {
      ...(unit as unknown as WorkUnit),
      capturedCommit: useCapture ? commit : (unit.capturedCommit as string | undefined),
      classifierManifestHash: useCapture
        ? manifestHash
        : (unit.classifierManifestHash as string | undefined),
      reads,
    };
  });
}

function evaluateFixture(name: string, surfaceOverride?: string): StopAuditResult {
  const fixture = loadFixture(name);
  const surface = surfaceOverride ?? fixture.surface ?? 'cursor';
  return evaluateStopAudit({
    surface,
    reviewerPath: fixture.reviewerPath,
    reviewerPathSource: fixture.reviewerPathSource,
    reviewSignal: fixture.reviewSignal,
    env: fixture.env,
    workUnits: enrichFixtureCaptureMetadata(fixture.workUnits),
    events: fixture.events,
  }) as StopAuditResult;
}

function firstVerdict(result: StopAuditResult) {
  expect(result.verdicts.length).toBeGreaterThan(0);
  return result.verdicts[0];
}

function createBulkReadFile(dir: string, lines = 450) {
  const filePath = path.join(dir, `bulk-read-${lines}.txt`);
  fs.writeFileSync(
    filePath,
    Array.from({ length: lines }, (_, index) => `bulk-line-${index + 1}`).join('\n'),
  );
  return filePath;
}

const equivalenceFixtures = [
  'below-floor.json',
  'code-class-excluded.json',
  'reviewer-path-excluded.json',
  'diff-log-below-t1.json',
  'ambient-reviewer-env-ordinary.json',
  'ambient-review-marker-ordinary.json',
  'undecidable-review-marker.json',
];

describe('threshold constants', () => {
  it('exports canonical T1 floor of 400 lines', () => {
    expect(T1_VOLUME_FLOOR).toBe(400);
  });
});

describe('equivalence-class fixtures', () => {
  for (const fixtureName of equivalenceFixtures) {
    it(`${fixtureName} matches tabled audit verdict`, () => {
      const fixture = loadFixture(fixtureName);
      const result = evaluateFixture(fixtureName);
      if (fixture.expectUnits) {
        for (const expected of fixture.expectUnits) {
          const verdict = result.verdicts.find((row) => row.workUnitKey === expected.key);
          expect(verdict, `missing unit ${expected.key}`).toBeDefined();
          expect(verdict?.triggerFired).toBe(expected.triggerFired);
          expect(verdict?.flagged).toBe(expected.flagged);
        }
        return;
      }

      const verdict = firstVerdict(result);
      const expectRow = fixture.expect ?? {};
      if (expectRow.triggerFired !== undefined) {
        expect(verdict.triggerFired).toBe(expectRow.triggerFired);
      }
      if (expectRow.excludedFromDenominator !== undefined) {
        expect(verdict.excludedFromDenominator).toBe(expectRow.excludedFromDenominator);
      }
      if (expectRow.flagged !== undefined) {
        expect(verdict.flagged).toBe(expectRow.flagged);
      }
      if (expectRow.inDenominator !== undefined) {
        expect(verdict.inDenominator).toBe(expectRow.inDenominator);
      }
      if (expectRow.diffLog !== undefined) {
        expect(verdict.trigger.diffLog).toBe(expectRow.diffLog);
      }
      if (expectRow.selfAttestedDelegation !== undefined) {
        expect(verdict.selfAttestedDelegation).toBe(expectRow.selfAttestedDelegation);
      }
      if (expectRow.machineObservedDelegation !== undefined) {
        expect(verdict.machineObservedDelegation).toBe(expectRow.machineObservedDelegation);
      }
      if (expectRow.reviewerPath !== undefined) {
        expect(verdict.reviewerPath).toBe(expectRow.reviewerPath);
      }
      if (expectRow.codeClass !== undefined) {
        expect(verdict.codeClass).toBe(expectRow.codeClass);
      }
      if (expectRow.advisory !== undefined) {
        expect(verdict.advisory).toBe(expectRow.advisory);
      }
      if (expectRow.advisoryOutcome !== undefined) {
        expect(verdict.advisoryOutcome).toBe(expectRow.advisoryOutcome);
      }
      if (expectRow.advisorySatisfied !== undefined) {
        expect(verdict.advisorySatisfied).toBe(expectRow.advisorySatisfied);
      }
      if (expectRow.shellReadAround !== undefined) {
        expect(verdict.shellReadAround).toBe(expectRow.shellReadAround);
      }
      if (expectRow.reviewSignalState !== undefined) {
        expect(verdict.reviewSignalState).toBe(expectRow.reviewSignalState);
      }

      if (fixture.expectSummary) {
        const summary = result.summary;
        if (fixture.expectSummary.delegableTriggerUnits !== undefined) {
          expect(summary.delegableTriggerUnits).toBe(fixture.expectSummary.delegableTriggerUnits);
        }
        if (fixture.expectSummary.flaggedUnits !== undefined) {
          expect(summary.flaggedUnits).toBe(fixture.expectSummary.flaggedUnits);
        }
        if (fixture.expectSummary.residualNonCompliance !== undefined) {
          expect(summary.residualNonCompliance).toBe(fixture.expectSummary.residualNonCompliance);
        }
        if (fixture.expectSummary.denominatorCause !== undefined) {
          expect(summary.denominatorCause).toBe(fixture.expectSummary.denominatorCause);
        }
        if (fixture.expectSummary.reviewHookCaptureBranch !== undefined) {
          expect(summary.reviewHookCaptureBranch).toBe(fixture.expectSummary.reviewHookCaptureBranch);
        }
      }
      if (fixture.expectDegraded !== undefined) {
        expect(result.summary.degraded).toBe(fixture.expectDegraded);
      }
    });
  }
});

describe('detection parity (Claude vs Cursor)', () => {
  for (const fixtureName of equivalenceFixtures) {
    it(`${fixtureName} yields identical flag verdict on both surfaces`, () => {
      const cursor = evaluateFixture(fixtureName, 'cursor');
      const claude = evaluateFixture(fixtureName, 'claude');
      expect(cursor.verdicts.map((row) => row.flagged)).toEqual(
        claude.verdicts.map((row) => row.flagged),
      );
      expect(cursor.verdicts.map((row) => row.inDenominator)).toEqual(
        claude.verdicts.map((row) => row.inDenominator),
      );
      expect(cursor.verdicts.map((row) => row.excludedFromDenominator)).toEqual(
        claude.verdicts.map((row) => row.excludedFromDenominator),
      );
      expect(cursor.verdicts.map((row) => row.reviewerPath)).toEqual(
        claude.verdicts.map((row) => row.reviewerPath),
      );
      expect(cursor.summary.denominatorCause).toBe(claude.summary.denominatorCause);
      expect(cursor.summary.reviewHookCaptureBranch).toBe(claude.summary.reviewHookCaptureBranch);
    });
  }
});

describe('work-unit boundary', () => {
  it('partitions one inbound request across many reads into one unit', () => {
    const units = partitionEventsIntoWorkUnits([
      { inboundRequestId: 'req-1', kind: 'read', path: 'docs/a.md', lines: 150 },
      { inboundRequestId: 'req-1', kind: 'read', path: 'docs/b.md', lines: 150 },
      { inboundRequestId: 'req-1', kind: 'read', path: 'docs/c.md', lines: 150 },
    ]);
    expect(units).toHaveLength(1);
    const verdict = auditWorkUnit(units[0], { surface: 'cursor' });
    expect(verdict.triggerFired).toBe(true);
    expect(verdict.advisory).toBe(true);
    expect(verdict.flagged).toBe(false);
  });

  it('keeps two inbound requests as separate units (fixture-pinned)', () => {
    const result = evaluateFixture('work-unit-boundary.json');
    expect(result.verdicts).toHaveLength(2);
    expect(result.verdicts.every((row) => !row.flagged)).toBe(true);
  });
});

describe('metric emission', () => {
  it('counts delegated, edit-exempt, and excepted units in denominator', () => {
    const fixture = loadFixture('metric-emission-denominator.json');
    const result = evaluateStopAudit({
      surface: fixture.surface ?? 'claude',
      workUnits: fixture.workUnits,
    }) as StopAuditResult;
    expect(result.summary.delegableTriggerUnits).toBe(fixture.expectSummary?.delegableTriggerUnits);
    expect(result.summary.flaggedUnits).toBe(fixture.expectSummary?.flaggedUnits);
    expect(result.summary.residualNonCompliance).toBe(
      fixture.expectSummary?.residualNonCompliance,
    );
  });


  it('distinguishes all-excluded from no-trigger windows by structured cause', () => {
    const noTrigger = evaluateStopAudit({
      surface: 'cursor',
      workUnits: [
        { key: 'unit-low', inboundRequestId: 'req-1', reads: [{ path: 'docs/a.md', lines: 20, kind: 'file' }] },
      ],
    }) as StopAuditResult;
    expect(noTrigger.summary.denominatorCause).toBe('no-trigger');

    const allExcluded = evaluateStopAudit({
      surface: 'cursor',
      reviewSignal: { present: true, source: 'tracked-review-wrapper', kind: 'review-execution' },
      workUnits: [
        { key: 'unit-review', inboundRequestId: 'req-1', reads: [{ path: 'docs/a.md', lines: 450, kind: 'file' }] },
        { key: 'unit-low', inboundRequestId: 'req-2', reads: [{ path: 'docs/b.md', lines: 20, kind: 'file' }] },
      ],
    }) as StopAuditResult;
    expect(allExcluded.summary.denominatorCause).toBe('all-excluded');
  });

  it('loads the persisted review-hook capability on ordinary live summaries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-audit-'));
    const artifactPath = path.join(dir, 'metrics.jsonl');
    const fixture = loadFixture('ambient-reviewer-env-ordinary.json');
    runStopAudit({
      surface: fixture.surface ?? 'claude',
      env: fixture.env,
      workUnits: (fixture.workUnits ?? []) as WorkUnit[],
      artifactPath,
      eventId: 'evt-live-capability',
      nowMs: 1_700_000_000_003,
    }) as StopAuditResult;
    const summary = loadMetricWindowSummary(artifactPath);
    expect(summary.reviewHookCaptureBranch).toBe('world-a-no-review-hook');
    expect(summary.degraded).toBe(false);
  });

  it('fails loud for malformed, stale, and live-mismatched capability provenance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-capability-'));
    const artifactPath = path.join(dir, 'metrics.jsonl');
    const malformed = path.join(dir, 'malformed.json');
    fs.writeFileSync(malformed, '{');
    expect(loadMetricWindowSummary(artifactPath, { capabilityRecordPath: malformed }).reviewHookCaptureBranch).toBe('unknown');

    const stale = path.join(dir, 'stale.json');
    const capability = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/read-delegation-review-hook-capability.json'), 'utf8'));
    capability.surfaces.cursor.codeHashes['docs/read-delegation-audit.mjs'] = 'stale';
    fs.writeFileSync(stale, JSON.stringify(capability));
    const staleSummary = loadMetricWindowSummary(artifactPath, { capabilityRecordPath: stale });
    expect(staleSummary.reviewHookCaptureBranch).toBe('unknown');
    expect(staleSummary.degraded).toBe(true);

    appendMetricRecord(artifactPath, {
      kind: 'work_unit_verdict',
      eventId: 'evt-bad-fingerprint',
      surface: 'cursor',
      auditSchemaVersion: 2,
      hookWiringFingerprint: { ...currentHookWiringFingerprint(), wrapperHash: 'stale' },
      verdict: {
        ...auditWorkUnit(
          { key: 'unit-a', inboundRequestId: 'req-1', reads: [{ path: 'docs/a.md', lines: 450, kind: 'file' }] },
          { surface: 'cursor' },
        ),
        hookWiringFingerprint: { ...currentHookWiringFingerprint(), wrapperHash: 'stale' },
      },
    });
    const mismatchSummary = loadMetricWindowSummary(artifactPath);
    expect(mismatchSummary.reviewHookCaptureBranch).toBe('unknown');
    expect(mismatchSummary.degraded).toBe(true);
  });

  it('quarantines pre-fix schema rows in mixed JSONL artifacts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-mixed-schema-'));
    const artifactPath = path.join(dir, 'mixed.jsonl');
    fs.writeFileSync(artifactPath, `${JSON.stringify({
      kind: 'work_unit_verdict',
      eventId: 'legacy-poison',
      surface: 'cursor',
      verdict: {
        workUnitKey: 'legacy',
        inboundRequestId: 'req-old',
        surface: 'cursor',
        triggerFired: true,
        excludedFromDenominator: true,
        inDenominator: false,
        flagged: false,
        reviewerPath: true,
        trigger: { fileLines: 900, diffLogLines: 0 },
      },
    })}\n`);
    appendMetricRecord(artifactPath, {
      kind: 'work_unit_verdict',
      eventId: 'new-good',
      surface: 'cursor',
      verdict: auditWorkUnit(
        { key: 'new', inboundRequestId: 'req-new', reads: [{ path: 'docs/a.md', lines: 450, kind: 'file' }] },
        { surface: 'claude' },
      ),
    });
    const summary = loadMetricWindowSummary(artifactPath);
    expect(summary.delegableTriggerUnits).toBe(1);
    expect(summary.flaggedUnits).toBe(1);
    expect(summary.denominatorCause).toBe('normal');
  });

  it('emits machine-readable window summary from artifact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-audit-'));
    const artifactPath = path.join(dir, 'metrics.jsonl');
    const payload = loadFixture('metric-emission-denominator.json');
    const stop = runStopAudit({
      surface: payload.surface ?? 'claude',
      workUnits: payload.workUnits,
      artifactPath,
      windowId: 'win-test',
      eventId: 'evt-metrics',
      nowMs: 1_700_000_000_000,
    }) as StopAuditResult;
    expect(stop.ok).toBe(true);
    const summary = loadMetricWindowSummary(artifactPath);
    expect(summary.delegableTriggerUnits).toBe(4);
    expect(summary.flaggedUnits).toBe(1);
    expect(summary.residualNonCompliance).toBe(0.25);
    expect(summary.degraded).toBe(false);
  });
});

describe('line counting and missing-window handling', () => {
  it('does not count a trailing newline as an extra line at thresholds', () => {
    const exactly400 = `${Array.from({ length: 400 }, (_, index) => `line-${index + 1}`).join('\n')}\n`;
    expect(countTextLines(exactly400)).toBe(400);
    expect(measureReadToolLines({}, exactly400)).toBe(400);

    const exactly200Diff = `${Array.from({ length: 200 }, (_, index) => `diff-${index + 1}`).join('\n')}\n`;
    expect(measureShellDiffLogLines('git diff HEAD~1', exactly200Diff)).toBe(200);

    const result = evaluateStopAudit({
      surface: 'cursor',
      workUnits: [
        {
          key: 'unit-threshold',
          inboundRequestId: 'req-1',
          reads: [{ lines: 400, kind: 'file' }],
        },
      ],
    }) as StopAuditResult;
    expect(result.verdicts[0].triggerFired).toBe(false);
    expect(result.verdicts[0].flagged).toBe(false);
  });

  it('returns fail-open when transcript_path exists but cannot be read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-transcript-unreadable-'));
    const transcriptPath = path.join(dir, 'unreadable.jsonl');
    const artifactPath = path.join(dir, 'metrics.jsonl');
    fs.writeFileSync(transcriptPath, '{"role":"user"}\n');
    fs.chmodSync(transcriptPath, 0o000);

    try {
      const result = runStopAudit({
        surface: 'cursor',
        transcript_path: transcriptPath,
        artifactPath,
        eventId: 'evt-transcript-read-fail',
        nowMs: 1_700_000_000_001,
      }) as StopAuditResult;
      expect(result.ok).toBe(false);
      expect(result.failOpen).toBe(true);
      expect(result.error).toBeTruthy();

      const stdout = execFileSync(
        'node',
        [auditModule, 'stop'],
        {
          cwd: repoRoot,
          input: JSON.stringify({
            surface: 'cursor',
            transcript_path: transcriptPath,
            artifactPath,
            eventId: 'evt-transcript-cli-fail',
          }),
          encoding: 'utf8',
        },
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.failOpen).toBe(true);
      expect(parsed.ok).toBe(false);
    } finally {
      fs.chmodSync(transcriptPath, 0o600);
    }
  });

  it('records missing_window when transcript_path yields no tool events', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-missing-'));
    const artifactPath = path.join(dir, 'missing-window.jsonl');
    const transcriptPath = path.join(dir, 'empty-transcript.jsonl');
    fs.writeFileSync(transcriptPath, '');

    const result = runStopAudit({
      surface: 'cursor',
      transcript_path: transcriptPath,
      artifactPath,
      windowId: 'win-missing',
      eventId: 'evt-missing',
      nowMs: 1_700_000_000_002,
    }) as StopAuditResult;

    expect(result.ok).toBe(true);
    const summary = loadMetricWindowSummary(artifactPath);
    expect(summary.missingWindows).toBe(1);
    expect(summary.degraded).toBe(true);
    expect(result.verdicts).toHaveLength(0);
  });
});

describe('fail-open and fail-loud', () => {
  it('returns fail-open when metric append and health persistence both fail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-audit-append-fail-'));
    const result = runStopAudit({
      surface: 'cursor',
      workUnits: (loadFixture('no-edit-no-reason.json').workUnits ?? []) as WorkUnit[],
      artifactPath: dir,
      eventId: 'evt-append-fail',
      nowMs: 1_700_000_000_000,
    }) as StopAuditResult;
    expect(result.ok).toBe(false);
    expect(result.failOpen).toBe(true);
    expect(result.error).toBeTruthy();
  });

  it('records health error and marks window degraded without blocking', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-audit-'));
    const artifactPath = path.join(dir, 'health.jsonl');
    const result = runStopAudit({
      surface: 'not-a-surface',
      artifactPath,
      eventId: 'evt-error',
      nowMs: 1_700_000_000_000,
    }) as StopAuditResult;
    expect(result.ok).toBe(false);
    expect(result.failOpen).toBe(true);
    const summary = loadMetricWindowSummary(artifactPath);
    expect(summary.auditErrors).toBeGreaterThan(0);
    expect(summary.degraded).toBe(true);
  });
});

describe('Claude and shell transcript compatibility', () => {
  it('resolves Cursor read_file target_file inputs for line measurement', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-cursor-read-'));
    const readPath = createBulkReadFile(dir, 450);
    expect(resolveReadToolPath({ target_file: readPath })).toBe(readPath);

    const events = toolUseToAuditEvents(
      'read_file',
      { target_file: readPath, limit: 450 },
      'req-cursor',
    );
    expect(events).toHaveLength(1);
    expect(events[0].path).toBe(readPath);
    expect(events[0].lines).toBe(450);
  });

  it('flags Cursor read_file transcript reads the same as Read reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-cursor-bulk-'));
    const readPath = createBulkReadFile(dir, 450);
    const readRecords = [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'inspect policy' }] },
      },
      {
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { path: readPath, limit: 450 },
            },
          ],
        },
      },
    ];
    const cursorFileRecords = [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'inspect policy' }] },
      },
      {
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'read_file',
              input: { target_file: readPath, limit: 450 },
            },
          ],
        },
      },
    ];
    const readStyle = evaluateStopAudit({
      surface: 'cursor',
      workUnits: extractEventsFromTranscriptRecords(readRecords).workUnits,
    }) as StopAuditResult;
    const readFileStyle = evaluateStopAudit({
      surface: 'cursor',
      workUnits: extractEventsFromTranscriptRecords(cursorFileRecords).workUnits,
    }) as StopAuditResult;
    expect(readFileStyle.verdicts[0]?.advisory).toBe(true);
    expect(readFileStyle.verdicts[0]?.flagged).toBe(false);
    expect(readStyle.verdicts[0]?.advisory).toBe(true);
    expect(readStyle.verdicts[0]?.flagged).toBe(false);
  });

  it('resolves Claude Read file_path inputs for line measurement', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-limit-'));
    const readPath = createBulkReadFile(dir, 450);
    expect(resolveReadToolPath({ file_path: readPath })).toBe(readPath);

    const events = toolUseToAuditEvents(
      'Read',
      { file_path: readPath, limit: 450 },
      'req-claude',
    );
    expect(events).toHaveLength(1);
    expect(events[0].path).toBe(readPath);
    expect(events[0].lines).toBe(450);
  });

  it('treats Read limits as caps when the file is shorter than the limit', () => {
    const readPath = path.join(fixturesDir, 'no-edit-no-reason.json');
    const actualLines = measureReadToolLines({ path: readPath });
    expect(measureReadToolLines({ path: readPath, limit: 450 })).toBe(actualLines);
    expect(actualLines).toBeLessThan(T1_VOLUME_FLOOR);

    const result = evaluateStopAudit({
      surface: 'cursor',
      workUnits: extractEventsFromTranscriptRecords([
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'inspect policy' }] },
        },
        {
          role: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Read',
                input: { path: readPath, limit: 450 },
              },
            ],
          },
        },
      ]).workUnits,
    }) as StopAuditResult;
    expect(result.flags.length).toBe(0);
  });

  it('flags Claude transcript reads the same as Cursor reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-bulk-'));
    const readPath = createBulkReadFile(dir, 450);
    const records = [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'inspect policy' }] },
      },
      {
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: readPath, limit: 450 },
            },
          ],
        },
      },
    ];
    const cursor = evaluateStopAudit({
      surface: 'cursor',
      workUnits: extractEventsFromTranscriptRecords(records).workUnits,
    }) as StopAuditResult;
    const claude = evaluateStopAudit({
      surface: 'claude',
      workUnits: extractEventsFromTranscriptRecords(records).workUnits,
    }) as StopAuditResult;
    expect(claude.flags.length).toBe(1);
    expect(claude.flags.length).toBe(1);
    expect(claude.flags[0]?.flagged).toBe(true);
    expect(cursor.verdicts[0]?.advisory).toBe(true);
    expect(cursor.verdicts[0]?.flagged).toBe(false);
  });

  it('counts file lines from disk without loading the entire file for limited reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-bounded-'));
    const readPath = path.join(dir, 'large.txt');
    fs.writeFileSync(
      readPath,
      Array.from({ length: 1000 }, (_, index) => `line-${index + 1}`).join('\n'),
    );
    const readFileSpy = vi.spyOn(fs, 'readFileSync');
    expect(countFileLinesFromDisk(readPath, 0, 450)).toBe(450);
    expect(measureReadToolLines({ path: readPath, limit: 450 })).toBe(450);
    expect(readFileSpy).not.toHaveBeenCalled();
    readFileSpy.mockRestore();

    const fullText = readFileSync(readPath, 'utf8');
    expect(countFileLinesFromDisk(readPath)).toBe(countTextLines(fullText));
    expect(countFileLinesFromDisk(readPath, 10, 20)).toBe(20);
  });

  it('does not false-fire T1 when work unit reads supply string line counts', () => {
    const result = auditWorkUnit(
      {
        key: 'unit-string-lines',
        inboundRequestId: 'req-1',
        reads: [
          { path: 'docs/a.ts', lines: '150', kind: 'file' },
          { path: 'docs/b.ts', lines: '150', kind: 'file' },
        ] as unknown as ReadEntry[],
      },
      { surface: 'cursor' },
    );
    expect(result.triggerFired).toBe(false);
    expect(result.flagged).toBe(false);
    expect(result.inDenominator).toBe(false);
  });

  it('excludes codeClassGated units from the denominator without per-read isCodeClass', () => {
    const result = auditWorkUnit(
      {
        key: 'unit-code-class-gated',
        inboundRequestId: 'req-1',
        codeClassGated: true,
        reads: [{ path: 'vendor/pkg/foo.py', lines: 500, kind: 'file' }],
      },
      { surface: 'cursor' },
    );
    expect(result.codeClass).toBe(true);
    expect(result.excludedFromDenominator).toBe(true);
    expect(result.inDenominator).toBe(false);
    expect(result.flagged).toBe(false);
  });

  it('recognizes multiline coworker ask commands as machine-observed delegation', () => {
    const multilineCommands = [
      "coworker ask \\\n  --profile code --question 'summarize' docs/a.md",
      "coworker ask\n  --profile=code --question 'summarize' docs/a.md",
    ];
    for (const command of multilineCommands) {
      expect(matchesCoworkerAskCommand(command)).toBe(true);
    }

    const result = evaluateStopAudit({
      surface: 'cursor',
      workUnits: [
        {
          key: 'unit-multiline-delegation',
          inboundRequestId: 'req-1',
          reads: [{ path: 'docs/a.md', lines: 450, kind: 'file' }],
          shellCommands: [multilineCommands[0]],
        },
      ],
    }) as StopAuditResult;
    expect(result.verdicts[0].advisoryOutcome).toBe(
      CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY_SATISFIED,
    );
    expect(result.verdicts[0].flagged).toBe(false);
  });

  it('recognizes coworker ask --profile=code as machine-observed delegation', () => {
    const result = evaluateStopAudit({
      surface: 'cursor',
      workUnits: [
        {
          key: 'unit-profile-equals',
          inboundRequestId: 'req-1',
          reads: [{ path: 'docs/a.md', lines: 450, kind: 'file' }],
          shellCommands: ["coworker ask --profile=code --question 'summarize' docs/a.md"],
        },
      ],
    }) as StopAuditResult;
    expect(result.verdicts[0].advisoryOutcome).toBe(
      CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY_SATISFIED,
    );
    expect(result.verdicts[0].flagged).toBe(false);
    expect(result.verdicts[0].inDenominator).toBe(false);
  });

  it('recognizes Claude Edit and MultiEdit tools for edit-exempt units', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-claude-edit-'));
    const readPath = createBulkReadFile(dir, 450);
    for (const editTool of ['Edit', 'MultiEdit'] as const) {
      const records = [
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'read then edit' }] },
        },
        {
          role: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Read',
                input: { file_path: readPath, limit: 450 },
              },
              {
                type: 'tool_use',
                name: editTool,
                input: { file_path: readPath, old_string: 'bulk-line-1', new_string: 'edited-line-1' },
              },
            ],
          },
        },
      ];
      const result = evaluateStopAudit({
        surface: 'claude',
        workUnits: extractEventsFromTranscriptRecords(records).workUnits,
      }) as StopAuditResult;
      expect(result.verdicts[0].editExempt).toBe(true);
      expect(result.verdicts[0].flagged).toBe(false);
    }
  });

  it('does not re-execute shell commands without captured transcript output', () => {
    expect(measureShellDiffLogLines('git diff HEAD~1')).toBe(0);
    const events = toolUseToAuditEvents(
      'Shell',
      { command: 'git diff HEAD~1' },
      'req-shell',
    );
    expect(events.some((event) => event.readKind === 'diff')).toBe(false);
  });

  it('measures diff/log volume only from captured shell output', () => {
    const captured = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`).join('\n');
    expect(measureShellDiffLogLines('git diff HEAD~1', captured)).toBe(250);

    const events = toolUseToAuditEvents(
      'Shell',
      { command: 'git diff HEAD~1' },
      'req-shell',
      { shellOutput: captured },
    );
    expect(events.some((event) => event.readKind === 'diff' && event.lines === 250)).toBe(true);
  });

  it('classifies tail log shell reads as advisory on Cursor', () => {
    const captured = Array.from({ length: 450 }, (_, index) => `log-line-${index + 1}`).join('\n');
    expect(measureShellDiffLogLines('tail -n 450 /tmp/app.log', captured)).toBe(0);

    const events = toolUseToAuditEvents(
      'Shell',
      { command: 'tail -n 450 /tmp/app.log' },
      'req-tail',
      { shellOutput: captured },
    );
    expect(events.some((event) => event.readKind === 'log' && event.lines === 450)).toBe(true);
    expect(events.some((event) => event.readKind === 'diff')).toBe(false);

    const result = evaluateStopAudit({
      surface: 'cursor',
      workUnits: partitionEventsIntoWorkUnits(events.map((event) => ({
        ...event,
        inboundRequestId: 'req-tail',
        workUnitKey: 'unit-tail',
      }))),
    }) as StopAuditResult;
    expect(result.verdicts[0].advisory).toBe(true);
    expect(result.verdicts[0].flagged).toBe(false);
    expect(result.verdicts[0].shellReadAround).toBe(true);
  });

  it('keeps tool_result user messages inside the same work unit', () => {
    expect(
      isInboundUserRequest({
        role: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
      }),
    ).toBe(false);

    const records = [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'first question' }] },
      },
      {
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Shell',
              input: { command: 'git diff HEAD~1' },
            },
          ],
        },
      },
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: Array.from({ length: 250 }, (_, index) => `line-${index + 1}`).join('\n'),
            },
          ],
        },
      },
    ];

    const extracted = extractEventsFromTranscriptRecords(records);
    expect(extracted.workUnits).toHaveLength(1);
    const result = evaluateStopAudit({
      surface: 'claude',
      workUnits: extracted.workUnits,
    }) as StopAuditResult;
    expect(result.flags.length).toBe(1);
  });
});

describe('work unit resolution', () => {
  it('partitions events when workUnits is an empty array', () => {
    const result = evaluateStopAudit({
      surface: 'claude',
      workUnits: [],
      events: [
        {
          kind: 'read',
          inboundRequestId: 'req-1',
          workUnitKey: 'unit-events',
          lines: 450,
          readKind: 'file',
          path: 'docs/a.md',
        },
      ],
    }) as StopAuditResult;
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].flagged).toBe(true);
  });

  it('preserves capture metadata when partitioning read events', () => {
    const manifestHash = classifierManifestHash();
    expect(() =>
      evaluateStopAudit({
        surface: 'cursor',
        events: [
          {
            kind: 'read',
            inboundRequestId: 'req-1',
            workUnitKey: 'unit-capture-events',
            lines: 900,
            readKind: 'file',
            path: 'plugins/ao-scope-guard/lib/check.ts',
            capturedCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            classifierManifestHash: manifestHash,
            readDiscriminator: '0',
            surface: 'cursor',
          },
        ],
      }),
    ).toThrow(/captured-head-mismatch/);
  });
});

describe('stop hook transcript population', () => {
  it('extracts read events from Cursor transcript records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-bulk-'));
    const readPath = createBulkReadFile(dir, 450);
    const records = [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'inspect policy' }] },
      },
      {
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { path: readPath, limit: 450 },
            },
          ],
        },
      },
    ];

    const extracted = extractEventsFromTranscriptRecords(records, {
      conversationId: 'conv-test',
      generationId: 'gen-test',
    });
    expect(extracted.events.length).toBeGreaterThan(0);
    expect(extracted.workUnits).toHaveLength(1);
    const result = evaluateStopAudit({
      surface: 'cursor',
      hook_event_name: 'stop',
      conversation_id: 'conv-test',
      generation_id: 'gen-test',
      workUnits: extracted.workUnits,
    }) as StopAuditResult;
    expect(result.verdicts[0]?.advisory).toBe(true);
    expect(result.flags.length).toBe(0);
  });

  it('populates work units from transcript_path when hook payload is sparse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-transcript-'));
    const readPath = createBulkReadFile(dir, 450);
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const template = fs.readFileSync(
      path.join(fixturesDir, 'stop-hook-transcript.jsonl'),
      'utf8',
    );
    fs.writeFileSync(transcriptPath, template.replace('REPLACE_READ_PATH', readPath));

    const populated = populateStopAuditPayload({
      hook_event_name: 'stop',
      conversation_id: 'conv-populate',
      generation_id: 'gen-populate',
      transcript_path: transcriptPath,
      surface: 'cursor',
    });
    expect(Array.isArray(populated.workUnits)).toBe(true);
    expect((populated.workUnits as WorkUnit[]).length).toBe(1);

    const result = runStopAudit({
      ...populated,
      artifactPath: path.join(dir, 'metrics.jsonl'),
      windowId: 'win-transcript',
      nowMs: 1_700_000_000_001,
    }) as StopAuditResult;
    expect(result.ok).toBe(true);
    expect(result.verdicts[0]?.advisory).toBe(true);
    expect(result.flags.length).toBe(0);
  });

  it('captures shell read-arounds from shell-only Cursor transcripts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-shell-read-around-'));
    const readPath = path.join(dir, 'large-draft.md');
    fs.writeFileSync(
      readPath,
      Array.from({ length: 450 }, (_, index) => `draft-line-${index + 1}`).join('\n'),
    );
    const captured = fs.readFileSync(readPath, 'utf8');
    const command = `head -n 450 ${readPath}`;
    const records = [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'read the draft' }] },
      },
      {
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'shell-1',
              name: 'Shell',
              input: { command },
            },
          ],
        },
      },
      {
        role: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'shell-1', content: captured }],
        },
      },
    ];

    const extracted = extractEventsFromTranscriptRecords(records);
    expect(extracted.workUnits).toHaveLength(1);
    const unit = extracted.workUnits[0];
    expect(unit.reads?.length).toBe(1);
    expect(unit.reads?.[0]?.path).toBe(readPath);
    expect(unit.reads?.[0]?.lines).toBe(450);
    expect(unit.shellCommands).toEqual([command]);

    const result = evaluateStopAudit({
      surface: 'cursor',
      workUnits: extracted.workUnits,
    }) as StopAuditResult;
    const verdict = result.verdicts[0];
    expect(verdict.advisory).toBe(true);
    expect(verdict.advisoryOutcome).toBe(CURSOR_ADVISORY_CLASSIFICATIONS.SHELL_READ_AROUND);
    expect(verdict.shellReadAround).toBe(true);
    expect(result.summary.advisoryUnits).toBe(1);
  });

  it('preserves every path in multi-file shell cat reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-shell-cat-multi-'));
    const filePaths = ['a.md', 'b.md', 'c.md'].map((name) => path.join(dir, name));
    const lineCounts = [134, 133, 133];
    const chunks = filePaths.map((filePath, index) => {
      const content = Array.from(
        { length: lineCounts[index] },
        (_, lineIndex) => `${path.basename(filePath)}-line-${lineIndex + 1}`,
      ).join('\n');
      fs.writeFileSync(filePath, content);
      return content;
    });
    const command = `cat ${filePaths.join(' ')}`;
    const output = `${chunks.join('\n')}\n`;
    expect(extractShellCommandPaths(command)).toEqual(filePaths);
    const inferred = inferShellReadAroundReads(command, output);
    expect(inferred.map((read) => read.path)).toEqual(filePaths);
    expect(inferred.reduce((sum, read) => sum + read.lines, 0)).toBe(400);
    const events = toolUseToAuditEvents(
      'Shell',
      { command },
      'req-shell-cat-multi',
      { shellOutput: output },
    );
    const readEvents = events.filter((event) => event.kind === 'read');
    expect(readEvents).toHaveLength(3);
    expect(new Set(readEvents.map((event) => event.path))).toEqual(new Set(filePaths));
  });

  it('defaults head without -n to ten lines when output is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-shell-head-default-'));
    const readPath = path.join(dir, 'tracked-draft.md');
    fs.writeFileSync(
      readPath,
      Array.from({ length: 450 }, (_, index) => `line-${index + 1}`).join('\n'),
    );
    const inferred = inferShellReadAroundRead(`head ${readPath}`);
    expect(inferred).toEqual({ path: readPath, lines: 10, readKind: 'file' });
  });

  it('declines grep reads when captured output is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-shell-grep-miss-'));
    const readPath = path.join(dir, 'tracked-draft.md');
    fs.writeFileSync(readPath, 'only line\n');
    expect(inferShellReadAroundRead(`grep no-match ${readPath}`)).toBeNull();
  });

  it('extracts nested python open() paths for shell read-around', () => {
    const inferred = inferShellReadAroundRead(
      `python -c "print(open('docs/foo.md').read())"`,
    );
    expect(inferred).toBeNull();
    const withOutput = inferShellReadAroundRead(
      `python -c "print(open('docs/foo.md').read())"`,
      'line-1\nline-2\n',
    );
    expect(withOutput?.path).toBe('docs/foo.md');
    expect(withOutput?.lines).toBe(2);
  });

  it('uses bounded head -n counts instead of full-file fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-shell-bounded-'));
    const readPath = path.join(dir, 'tracked-draft.md');
    fs.writeFileSync(
      readPath,
      Array.from({ length: 450 }, (_, index) => `line-${index + 1}`).join('\n'),
    );
    const inferred = inferShellReadAroundRead(`head -n 10 ${readPath}`);
    expect(inferred).toEqual({ path: readPath, lines: 10, readKind: 'file' });
  });

  it('does not treat ordinary python script execution as a synthetic read', () => {
    expect(inferShellReadAroundRead('python scripts/read-delegation-audit.test.ts')).toBeNull();
    const events = toolUseToAuditEvents(
      'Shell',
      { command: 'python scripts/read-delegation-audit.test.ts' },
      'req-python-exec',
    );
    expect(events.some((event) => event.kind === 'read')).toBe(false);
  });

  it('infers shell read-around reads from head -n without captured output when path exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-shell-infer-'));
    const readPath = path.join(dir, 'tracked-draft.md');
    fs.writeFileSync(
      readPath,
      Array.from({ length: 450 }, (_, index) => `line-${index + 1}`).join('\n'),
    );
    const command = `head -n 450 ${readPath}`;
    const inferred = inferShellReadAroundRead(command);
    expect(inferred).toEqual({ path: readPath, lines: 450, readKind: 'file' });
    const events = toolUseToAuditEvents('Shell', { command }, 'req-shell-read-around');
    expect(events.some((event) => event.kind === 'read' && event.path === readPath)).toBe(true);
  });

  it('reads transcript_path from disk via extractEventsFromTranscript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-transcript-'));
    const readPath = createBulkReadFile(dir, 450);
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'task' }] },
        }),
        JSON.stringify({
          role: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Read',
                input: { path: readPath, limit: 450 },
              },
            ],
          },
        }),
      ].join('\n'),
    );

    const extracted = extractEventsFromTranscript(transcriptPath, {
      conversationId: 'conv-file',
      generationId: 'gen-file',
    });
    expect(extracted.workUnits).toHaveLength(1);
    expect(extracted.workUnits[0].reads?.[0]?.lines).toBe(450);
  });

  it('prefers captured Read tool_result length over the requested limit', () => {
    const readPath = path.join(fixturesDir, 'no-edit-no-reason.json');
    const captured = Array.from({ length: 450 }, (_, index) => `line-${index + 1}`).join('\n');
    const records = [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'task' }] },
      },
      {
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'read-1',
              name: 'Read',
              input: { path: readPath, limit: 450 },
            },
          ],
        },
      },
      {
        role: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'read-1', content: captured }],
        },
      },
    ];

    const extracted = extractEventsFromTranscriptRecords(records);
    expect(extracted.workUnits[0].reads?.[0]?.lines).toBe(450);
    const result = evaluateStopAudit({
      surface: 'cursor',
      workUnits: extracted.workUnits,
    }) as StopAuditResult;
    expect(result.verdicts[0]?.advisory).toBe(true);
    expect(result.flags.length).toBe(0);
  });
});

describe('concurrency and idempotency', () => {
  it('does not double-count duplicate event ids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-audit-'));
    const artifactPath = path.join(dir, 'concurrency.jsonl');
    const record = {
      kind: 'work_unit_verdict',
      eventId: 'evt-dup',
      windowId: 'win-1',
      surface: 'cursor',
      verdict: auditWorkUnit(
        {
          key: 'unit-a',
          inboundRequestId: 'req-1',
          reads: [{ path: 'docs/a.md', lines: 450, kind: 'file' }],
        },
        { surface: 'claude' },
      ),
    };

    const first = appendMetricRecord(artifactPath, record);
    const second = appendMetricRecord(artifactPath, record);
    expect(first.appended).toBe(true);
    expect(second.duplicate).toBe(true);

    const summary = loadMetricWindowSummary(artifactPath);
    expect(summary.delegableTriggerUnits).toBe(1);
  });

  it('appends concurrent unique events without loss', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-audit-'));
    const artifactPath = path.join(dir, 'concurrent.jsonl');
    const units: WorkUnit[] = [
      {
        key: 'unit-a',
        inboundRequestId: 'req-1',
        reads: [{ path: 'docs/a.md', lines: 450, kind: 'file' as ReadKind }],
      },
      {
        key: 'unit-b',
        inboundRequestId: 'req-2',
        reads: [{ path: 'docs/b.md', lines: 450, kind: 'file' as ReadKind }],
      },
    ];

    for (const [index, unit] of units.entries()) {
      appendMetricRecord(artifactPath, {
        kind: 'work_unit_verdict',
        eventId: `evt-${index}`,
        windowId: 'win-1',
        surface: 'cursor',
        verdict: auditWorkUnit(unit, { surface: 'claude' }),
      });
    }

    const summary = loadMetricWindowSummary(artifactPath);
    expect(summary.delegableTriggerUnits).toBe(2);
    expect(summary.flaggedUnits).toBe(2);
  });

  it('does not double-count concurrent duplicate appends', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-audit-'));
    const artifactPath = path.join(dir, 'concurrent-dup.jsonl');
    const record = JSON.stringify({
      kind: 'work_unit_verdict',
      eventId: 'evt-concurrent-dup',
      windowId: 'win-1',
      surface: 'cursor',
      verdict: auditWorkUnit(
        {
          key: 'unit-a',
          inboundRequestId: 'req-1',
          reads: [{ path: 'docs/a.md', lines: 450, kind: 'file' }],
        },
        { surface: 'claude' },
      ),
    });
    const child = `
      import { appendMetricRecord } from ${JSON.stringify(path.join(repoRoot, 'docs/read-delegation-audit.mjs'))};
      const result = appendMetricRecord(process.argv[1], JSON.parse(process.argv[2]));
      console.log(JSON.stringify(result));
    `;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise<{ code: number | null; stdout: string }>((resolve) => {
          const proc = spawn(
            'node',
            ['--input-type=module', '-e', child, artifactPath, record],
            { stdio: ['ignore', 'pipe', 'inherit'] },
          );
          let stdout = '';
          proc.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
          });
          proc.on('close', (code) => resolve({ code, stdout }));
        }),
      ),
    );

    for (const result of results) {
      expect(result.code).toBe(0);
    }
    const parsed = results.map((result) => JSON.parse(result.stdout.trim()));
    expect(parsed.filter((row) => row.appended).length).toBe(1);
    expect(parsed.filter((row) => row.duplicate).length).toBe(3);
    const summary = loadMetricWindowSummary(artifactPath);
    expect(summary.delegableTriggerUnits).toBe(1);
  });
});

const indexServedFixtures = [
  'index-served-excluded.json',
  'out-of-index-log-flagged.json',
  'out-of-index-diff-flagged.json',
  'out-of-index-external-flagged.json',
  'mixed-below-floor.json',
  'mixed-above-floor.json',
  'code-class-per-read-mixed.json',
];

describe('index-served carve-out (Issue #309)', () => {
  for (const fixtureName of indexServedFixtures) {
    it(`${fixtureName} matches index-served audit table`, () => {
      const fixture = loadFixture(fixtureName);
      const result = evaluateFixture(fixtureName);
      const expectRow = fixture.expect ?? {};
      const verdict = firstVerdict(result);
      if (expectRow.triggerFired !== undefined) {
        expect(verdict.triggerFired).toBe(expectRow.triggerFired);
      }
      if (expectRow.excludedFromDenominator !== undefined) {
        expect(verdict.excludedFromDenominator).toBe(expectRow.excludedFromDenominator);
      }
      if (expectRow.flagged !== undefined) {
        expect(verdict.flagged).toBe(expectRow.flagged);
      }
      if (expectRow.inDenominator !== undefined) {
        expect(verdict.inDenominator).toBe(expectRow.inDenominator);
      }
      if (expectRow.allIndexServed !== undefined) {
        expect(verdict.allIndexServed).toBe(expectRow.allIndexServed);
      }
      if (expectRow.indexServedExcludedLines !== undefined) {
        expect(verdict.indexServedExcludedLines).toBe(expectRow.indexServedExcludedLines);
      }
      if (expectRow.codeClass !== undefined) {
        expect(verdict.codeClass).toBe(expectRow.codeClass);
      }
      if (expectRow.advisory !== undefined) {
        expect(verdict.advisory).toBe(expectRow.advisory);
      }
      if (expectRow.advisoryOutcome !== undefined) {
        expect(verdict.advisoryOutcome).toBe(expectRow.advisoryOutcome);
      }
    });
  }

  it('index-served exclusion record carries full predicate matrix', () => {
    const result = evaluateFixture('index-served-excluded.json');
    const verdict = firstVerdict(result);
    const indexRow = verdict.readClassifications?.find(
      (row) => row.classification === 'index-served',
    );
    expect(indexRow).toBeDefined();
    const record = indexRow?.exclusionRecord ?? {};
    expect(record.canonicalPath).toBe('plugins/ao-scope-guard/lib/check.ts');
    expect(record.gitTracked).toBe(true);
    expect(record.matchedAllowedRoot).toBe('plugins/**');
    expect(record.sourceCodeClassifierMatch).toBe(true);
    expect(record.capturedCommit).toBeTruthy();
    expect(record.classifierManifestHash).toBeTruthy();
    expect(record.denominatorImpact).toBe('excluded');
    expect(record.excludedLineCount).toBe(900);
  });

  it('mixed session residual metric is non-zero and not 0/0', () => {
    const fixture = loadFixture('mixed-session-residual.json');
    const result = evaluateStopAudit({
      surface: 'cursor',
      workUnits: enrichFixtureCaptureMetadata(fixture.workUnits),
    }) as StopAuditResult;
    expect(result.summary.delegableTriggerUnits).toBe(0);
    expect(result.summary.advisoryUnits).toBe(1);
    expect(result.summary.residualNonCompliance).toBe(0);
    expect(result.summary.indexServedExcludedLines).toBe(900);
  });

  it('Cursor advisory vs Claude mandatory on same out-of-index log read', () => {
    const cursor = evaluateFixture('out-of-index-log-flagged.json', 'cursor');
    const claude = evaluateFixture('claude-mandatory-log-flagged.json', 'claude');
    expect(cursor.verdicts[0].advisory).toBe(true);
    expect(cursor.verdicts[0].flagged).toBe(false);
    expect(claude.verdicts[0].flagged).toBe(true);
    expect(claude.verdicts[0].inDenominator).toBe(true);
  });

  it('preflight: reviewer-path fixtures remain green (#264 precondition)', () => {
    const result = evaluateFixture('reviewer-path-excluded.json');
    expect(result.verdicts[0].reviewerPath).toBe(true);
    expect(result.verdicts[0].excludedFromDenominator).toBe(true);
    expect(result.summary.denominatorCause).toBe('all-excluded');
  });

  it('blocking status on captured-head mismatch', () => {
    const fixture = loadFixture('index-served-excluded.json');
    const units = enrichFixtureCaptureMetadata(fixture.workUnits);
    expect(units?.[0].reads?.[0]).toBeDefined();
    units![0].reads![0].capturedCommit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(() =>
      evaluateStopAudit({ surface: 'cursor', workUnits: units }),
    ).toThrow(/captured-head-mismatch/);
  });

  it('blocking status on partial capture metadata', () => {
    const commit = currentFixtureCaptureCommit();
    expect(() =>
      evaluateStopAudit({
        surface: 'cursor',
        workUnits: [
          {
            key: 'unit-partial-capture',
            inboundRequestId: 'req-1',
            reads: [
              {
                path: 'plugins/ao-scope-guard/lib/check.ts',
                lines: 900,
                kind: 'file',
                capturedCommit: commit,
                readDiscriminator: '0',
                surface: 'cursor',
              },
            ],
          },
        ],
      }),
    ).toThrow(/missing-capture-field/);
  });

  it('accepts short capturedCommit SHAs equivalent to checkout HEAD', () => {
    const shortCommit = execSync('git rev-parse --short HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const manifestHash = classifierManifestHash();
    const result = evaluateStopAudit({
      surface: 'cursor',
      workUnits: [
        {
          key: 'unit-short-sha',
          inboundRequestId: 'req-1',
          reads: [
            {
              path: 'plugins/ao-scope-guard/lib/check.ts',
              lines: 900,
              kind: 'file',
              capturedCommit: shortCommit,
              classifierManifestHash: manifestHash,
              readDiscriminator: '0',
              surface: 'cursor',
            },
          ],
        },
      ],
    }) as StopAuditResult;
    expect(result.verdicts[0].allIndexServed).toBe(true);
    expect(result.verdicts[0].indexServedExcludedLines).toBe(900);
  });

  it('blocking status on malformed captured read with missing lines', () => {
    const commit = currentFixtureCaptureCommit();
    const manifestHash = classifierManifestHash();
    expect(() =>
      evaluateStopAudit({
        surface: 'cursor',
        workUnits: [
          {
            key: 'unit-missing-lines',
            inboundRequestId: 'req-1',
            reads: [
              {
                path: 'plugins/ao-scope-guard/lib/check.ts',
                kind: 'file',
                capturedCommit: commit,
                classifierManifestHash: manifestHash,
                readDiscriminator: '0',
                surface: 'cursor',
              },
            ],
          },
        ],
      }),
    ).toThrow(/missing-capture-field/);
  });

  it('keeps non-index source reads delegable despite isCodeClass transcript tags', () => {
    const result = evaluateStopAudit({
      surface: 'claude',
      workUnits: [
        {
          key: 'unit-claude-source',
          inboundRequestId: 'req-1',
          reads: [{ path: 'plugins/code-gated.ts', lines: 900, kind: 'file', isCodeClass: true }],
        },
      ],
    }) as StopAuditResult;
    expect(result.verdicts[0].readClassifications?.[0]?.classification).toBe('out-of-index');
    expect(result.verdicts[0].codeClass).toBe(false);
    expect(result.verdicts[0].inDenominator).toBe(true);
    expect(result.verdicts[0].flagged).toBe(true);
  });

  it('classifies isCodeClass-tagged tracked source reads as index-served on the events path', () => {
    const events = toolUseToAuditEvents(
      'Read',
      { path: 'plugins/ao-scope-guard/lib/check.ts', limit: 900 },
      'req-index-transcript',
      { toolOutput: Array.from({ length: 900 }, (_, index) => `line-${index + 1}`).join('\n') },
    );
    expect(events[0]?.path).toBe('plugins/ao-scope-guard/lib/check.ts');
    const result = evaluateStopAudit({
      surface: 'cursor',
      workUnits: partitionEventsIntoWorkUnits(
        events.map((event) => ({
          ...event,
          workUnitKey: 'unit-index-transcript',
        })),
      ),
    }) as StopAuditResult;
    const verdict = result.verdicts[0];
    expect(verdict.readClassifications?.some((row) => row.classification === 'index-served')).toBe(
      true,
    );
    expect(verdict.allIndexServed).toBe(true);
    expect(verdict.indexServedExcludedLines).toBe(900);
    expect(verdict.excludedFromDenominator).toBe(true);
    expect(verdict.codeClass).toBe(false);
  });
});

describe('invoke-read-delegation-audit-stop.ps1', () => {
  const invokeScript = path.join(repoRoot, 'scripts/invoke-read-delegation-audit-stop.ps1');
  const powershellBin =
    process.platform === 'win32'
      ? 'powershell.exe'
      : (() => {
          try {
            execFileSync('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
              encoding: 'utf8',
            });
            return 'powershell';
          } catch {
            return null;
          }
        })();

  it('parses hook stdin with PS 5.1-compatible code', () => {
    if (!powershellBin) {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-hook-'));
    const artifactPath = path.join(dir, 'hook.jsonl');
    execFileSync(
      powershellBin,
      ['-NoProfile', '-File', invokeScript, '-ArtifactPath', artifactPath],
      {
        cwd: repoRoot,
        input: JSON.stringify({
          hook_event_name: 'stop',
          conversation_id: 'conv-hook',
          generation_id: 'gen-hook',
          workUnits: loadFixture('no-edit-no-reason.json').workUnits,
        }),
        encoding: 'utf8',
      },
    );
    const lines = fs.readFileSync(artifactPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const record = JSON.parse(lines[0]) as { surface?: string };
    expect(record.surface).toBe('cursor');
  });

  it('does not treat ambient PACK_REVIEWER as reviewer-path (#264)', () => {
    if (!powershellBin) {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-hook-ambient-'));
    const artifactPath = path.join(dir, 'hook.jsonl');
    const savedReviewer = process.env.PACK_REVIEWER;
    const savedCommand = process.env.REVIEW_COMMAND;
    process.env.PACK_REVIEWER = 'codex';
    process.env.REVIEW_COMMAND = 'pwsh scripts/invoke-pack-review.ps1';
    try {
      execFileSync(
        powershellBin,
        ['-NoProfile', '-File', invokeScript, '-ArtifactPath', artifactPath],
        {
          cwd: repoRoot,
          input: JSON.stringify({
            hook_event_name: 'Stop',
            surface: 'claude',
            workUnits: loadFixture('ambient-reviewer-env-ordinary.json').workUnits,
          }),
          encoding: 'utf8',
        },
      );
      const lines = fs.readFileSync(artifactPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const record = JSON.parse(lines[0]) as { verdict?: { reviewerPath?: boolean; inDenominator?: boolean } };
      expect(record.verdict?.reviewerPath).toBe(false);
      expect(record.verdict?.inDenominator).toBe(true);
    } finally {
      if (savedReviewer === undefined) {
        delete process.env.PACK_REVIEWER;
      } else {
        process.env.PACK_REVIEWER = savedReviewer;
      }
      if (savedCommand === undefined) {
        delete process.env.REVIEW_COMMAND;
      } else {
        process.env.REVIEW_COMMAND = savedCommand;
      }
    }
  });

  it('creates the metric directory before writing wrapper errors', () => {
    if (!powershellBin) {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-hook-error-'));
    const artifactPath = path.join(dir, 'nested', 'metrics.jsonl');
    execFileSync(
      powershellBin,
      ['-NoProfile', '-File', invokeScript, '-ArtifactPath', artifactPath, '-RepoRoot', repoRoot],
      {
        cwd: repoRoot,
        input: JSON.stringify({
          surface: 'not-a-surface',
          workUnits: [],
        }),
        encoding: 'utf8',
      },
    );
    expect(fs.existsSync(artifactPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(artifactPath, 'utf8').trim()) as {
      kind?: string;
    };
    expect(record.kind).toBe('audit_error');
  });
});

describe('stop hook CLI', () => {
  it('runs stop subcommand from stdin JSON', () => {
    const stdout = execFileSync(
      'node',
      [auditModule, 'stop'],
      {
        cwd: repoRoot,
        input: JSON.stringify({
          surface: 'claude',
          workUnits: loadFixture('no-edit-no-reason.json').workUnits,
        }),
        encoding: 'utf8',
      },
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.flags.length).toBe(1);
  });
});

describe('beforeReadFile deny probe artifact', () => {
  it('is checked in for Phase-2 feasibility', () => {
    const probe = loadFixture('cursor-before-read-file-deny-probe.json') as Record<string, unknown>;
    expect(probe.hook).toBe('beforeReadFile');
    expect(probe.attempt).toBe('deny');
    expect((probe.response as Record<string, unknown>).permission).toBe('deny');
  });
});

describe('surface enumeration', () => {
  it('covers both Claude and Cursor audit paths', () => {
    expect(SURFACES).toEqual(['cursor', 'claude']);
    const units = (loadFixture('no-edit-no-reason.json').workUnits ?? []) as WorkUnit[];
    const cursor = auditWorkUnits(units, { surface: 'cursor' });
    const claude = auditWorkUnits(units, { surface: 'claude' });
    expect(cursor[0].advisory).toBe(true);
    expect(cursor[0].flagged).toBe(false);
    expect(claude[0].flagged).toBe(true);
  });
});

describe('Cursor-seat advisory carve-out (Issue #359)', () => {
  const advisoryFixtures = [
    'cursor-advisory-markdown-capture.json',
    'cursor-advisory-log.json',
    'cursor-advisory-external.json',
  ];

  for (const fixtureName of advisoryFixtures) {
    it(`${fixtureName} records advisory classification without non-compliance`, () => {
      const result = evaluateFixture(fixtureName);
      const verdict = firstVerdict(result);
      expect(verdict.advisory).toBe(true);
      expect(verdict.flagged).toBe(false);
      expect(verdict.excludedFromDenominator).toBe(true);
      expect(
        verdict.readClassifications?.some(
          (row) => row.classification === CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY,
        ),
      ).toBe(true);
    });
  }

  it('cursor-advisory-delegated-satisfied.json records advisory-satisfied outcome', () => {
    const result = evaluateFixture('cursor-advisory-delegated-satisfied.json');
    expect(firstVerdict(result).advisoryOutcome).toBe(
      CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY_SATISFIED,
    );
  });

  it('cursor-advisory-delegated-then-shell.json preserves satisfaction when delegation observed', () => {
    const result = evaluateFixture('cursor-advisory-delegated-then-shell.json');
    const verdict = firstVerdict(result);
    expect(verdict.advisoryOutcome).toBe(CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY_SATISFIED);
    expect(verdict.advisorySatisfied).toBe(true);
    expect(verdict.shellReadAround).toBe(false);
    expect(result.summary.advisorySatisfiedUnits).toBe(1);
  });

  it('cursor-advisory-partial-targeted-read.json keeps untargeted bulk advisory unsatisfied', () => {
    const result = evaluateFixture('cursor-advisory-partial-targeted-read.json');
    const verdict = firstVerdict(result);
    expect(verdict.advisoryOutcome).toBe(CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY);
    expect(verdict.advisorySatisfied).toBe(false);
    expect(result.summary.advisorySatisfiedUnits).toBe(0);
  });

  it('cursor-advisory-targeted-read.json records advisory-satisfied for offset/limit read', () => {
    const result = evaluateFixture('cursor-advisory-targeted-read.json');
    expect(firstVerdict(result).advisoryOutcome).toBe(
      CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY_SATISFIED,
    );
  });

  it('cursor-advisory-shell-read-around.json records shell-read-around, not satisfied', () => {
    const result = evaluateFixture('cursor-advisory-shell-read-around.json');
    const verdict = firstVerdict(result);
    expect(verdict.advisoryOutcome).toBe(CURSOR_ADVISORY_CLASSIFICATIONS.SHELL_READ_AROUND);
    expect(verdict.advisorySatisfied).toBe(false);
    expect(verdict.shellReadAround).toBe(true);
  });

  it('cursor-advisory-unrelated-shell.json ignores unrelated shell commands', () => {
    const result = evaluateFixture('cursor-advisory-unrelated-shell.json');
    const verdict = firstVerdict(result);
    expect(verdict.advisoryOutcome).toBe(CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY_SATISFIED);
    expect(verdict.shellReadAround).toBe(false);
    expect(result.summary.advisorySatisfiedUnits).toBe(1);
  });

  it('cursor-advisory-mixed-mandatory-diff.json counts advisory reads in mandatory units', () => {
    const result = evaluateFixture('cursor-advisory-mixed-mandatory-diff.json');
    const verdict = firstVerdict(result);
    expect(verdict.advisory).toBe(true);
    expect(verdict.inDenominator).toBe(true);
    expect(verdict.flagged).toBe(true);
    expect(result.summary.advisoryUnits).toBe(1);
    expect(result.summary.advisoryExcludedLines).toBe(450);
  });

  it('out-of-index-diff-flagged.json stays mandatory on Cursor (not advisory)', () => {
    const result = evaluateFixture('out-of-index-diff-flagged.json', 'cursor');
    const verdict = firstVerdict(result);
    expect(verdict.advisory).not.toBe(true);
    expect(verdict.flagged).toBe(true);
    expect(verdict.inDenominator).toBe(true);
  });
});
