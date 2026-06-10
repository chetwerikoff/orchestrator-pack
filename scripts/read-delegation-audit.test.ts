import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuditVerdict, ReadKind, WorkUnit } from '../docs/read-delegation-audit.d.mts';
import {
  appendMetricRecord,
  auditWorkUnit,
  auditWorkUnits,
  evaluateStopAudit,
  extractEventsFromTranscript,
  extractEventsFromTranscriptRecords,
  loadMetricWindowSummary,
  partitionEventsIntoWorkUnits,
  populateStopAuditPayload,
  runStopAudit,
  SURFACES,
  T1_VOLUME_FLOOR,
} from '../docs/read-delegation-audit.mjs';

type StopAuditResult = {
  ok: boolean;
  failOpen?: boolean;
  verdicts: AuditVerdict[];
  summary: {
    delegableTriggerUnits: number;
    flaggedUnits: number;
    flaggedReadLines: number;
    residualNonCompliance: number;
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
};

type FixturePayload = {
  description?: string;
  surface?: string;
  reviewerPath?: boolean;
  env?: Record<string, string>;
  workUnits?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  expect?: FixtureExpect;
  expectUnits?: Array<{ key: string; triggerFired: boolean; flagged: boolean }>;
  expectSummary?: {
    delegableTriggerUnits: number;
    flaggedUnits: number;
    residualNonCompliance: number;
  };
  injectError?: boolean;
  expectHealth?: boolean;
  expectDegraded?: boolean;
};

function loadFixture(name: string): FixturePayload {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8')) as FixturePayload;
}

function evaluateFixture(name: string, surfaceOverride?: string): StopAuditResult {
  const fixture = loadFixture(name);
  const surface = surfaceOverride ?? fixture.surface ?? 'cursor';
  return evaluateStopAudit({
    surface,
    reviewerPath: fixture.reviewerPath,
    env: fixture.env,
    workUnits: fixture.workUnits,
    events: fixture.events,
  }) as StopAuditResult;
}

function firstVerdict(result: StopAuditResult) {
  expect(result.verdicts.length).toBeGreaterThan(0);
  return result.verdicts[0];
}

const equivalenceFixtures = [
  'below-floor.json',
  'edit-same-file.json',
  'edit-other-file.json',
  'no-edit-no-reason.json',
  'no-op-with-evidence.json',
  'delegated-machine-observed.json',
  'cumulative-chunks.json',
  'code-class-excluded.json',
  'reviewer-path-excluded.json',
  'diff-log-below-t1.json',
  'self-attested-delegation.json',
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
    expect(verdict.flagged).toBe(true);
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
      surface: 'cursor',
      workUnits: fixture.workUnits,
    }) as StopAuditResult;
    expect(result.summary.delegableTriggerUnits).toBe(fixture.expectSummary?.delegableTriggerUnits);
    expect(result.summary.flaggedUnits).toBe(fixture.expectSummary?.flaggedUnits);
    expect(result.summary.residualNonCompliance).toBe(
      fixture.expectSummary?.residualNonCompliance,
    );
  });

  it('emits machine-readable window summary from artifact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-audit-'));
    const artifactPath = path.join(dir, 'metrics.jsonl');
    const payload = loadFixture('metric-emission-denominator.json');
    const stop = runStopAudit({
      surface: 'cursor',
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

describe('fail-open and fail-loud', () => {
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

describe('stop hook transcript population', () => {
  it('extracts read events from Cursor transcript records', () => {
    const readPath = path.join(fixturesDir, 'no-edit-no-reason.json');
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
    expect(result.flags.length).toBe(1);
  });

  it('populates work units from transcript_path when hook payload is sparse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-transcript-'));
    const readPath = path.join(fixturesDir, 'no-edit-no-reason.json');
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
    expect(result.flags.length).toBe(1);
  });

  it('reads transcript_path from disk via extractEventsFromTranscript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-delegation-transcript-'));
    const readPath = path.join(fixturesDir, 'delegated-machine-observed.json');
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
        { surface: 'cursor' },
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
        verdict: auditWorkUnit(unit, { surface: 'cursor' }),
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
        { surface: 'cursor' },
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

describe('stop hook CLI', () => {
  it('runs stop subcommand from stdin JSON', () => {
    const stdout = execFileSync(
      'node',
      [auditModule, 'stop'],
      {
        cwd: repoRoot,
        input: JSON.stringify({
          surface: 'cursor',
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
    expect(cursor[0].flagged).toBe(claude[0].flagged);
  });
});
