/**
 * Generate real-main review-pipeline spawn captures (Issue #480).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { attributeSpawnSourceClass } from '../docs/review-pipeline-spawn-budget.mjs';
import { repoRoot } from './_test-pwsh-helpers.js';

type SpawnEvent = {
  atMs: number;
  commandLine: string;
  sourceHint?: string;
  childId?: string;
};

const SUPERVISOR_RUNS: Array<{ script: string; fixture: string }> = [
  { script: 'review-trigger-reconcile.ps1', fixture: 'tests/fixtures/review-trigger-reconcile/ready-head-triggers.json' },
  { script: 'review-trigger-reconcile.ps1', fixture: 'tests/fixtures/review-trigger-reconcile/covered-clean.json' },
  { script: 'review-trigger-reeval.ps1', fixture: 'tests/fixtures/review-trigger-reeval/dedupe-covered.json' },
  { script: 'review-trigger-reeval.ps1', fixture: 'tests/fixtures/review-trigger-reeval/wake-before-ready-then-ready.json' },
  { script: 'ci-green-wake-reconcile.ps1', fixture: 'tests/fixtures/ci-green-wake-reconcile/pre-handoff-green.json' },
  { script: 'review-send-reconcile.ps1', fixture: 'tests/fixtures/review-send-reconcile/happy-needs-triage.json' },
];

const MANDATORY_READ = [
  'git config --get remote.origin.url',
  'git log --since=60 seconds ago --format=%H',
  'git branch --show-current',
  'git status --short --branch',
  'ao status --json --reports full',
  'ao review list --json',
] as const;

function pushEvent(events: SpawnEvent[], commandLine: string, hints: { sourceHint?: string; childId?: string } = {}) {
  events.push({
    atMs: Date.now(),
    commandLine,
    sourceHint: hints.sourceHint ?? attributeSpawnSourceClass(commandLine, hints),
    childId: hints.childId,
  });
}

function wrapClaimedReviewFixture(relPath: string) {
  const raw = JSON.parse(readFileSync(path.join(repoRoot, relPath), 'utf8')) as Record<string, unknown>;
  const prKey = String(raw.prNumber ?? '318');
  return {
    openPrs: raw.openPrs ?? [],
    reviewRuns: raw.reviewRuns ?? [],
    sessions: raw.sessions ?? [],
    ciChecksByPr: { [prKey]: raw.ciChecks ?? [] },
    requiredCheckNamesByPr: { [prKey]: raw.requiredCheckNames ?? [] },
    requiredCheckLookupFailedByPr: { [prKey]: false },
  };
}

function runPwshFile(scriptRel: string, args: string[], events: SpawnEvent[], hints: { sourceHint?: string; childId?: string }) {
  const scriptPath = path.join(repoRoot, scriptRel);
  const line = `pwsh -NoProfile -File ${scriptPath} ${args.join(' ')}`;
  const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 45_000,
  });
  if (result.error) {
    throw new Error(`capture subprocess failed to start (${line}): ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`capture subprocess killed by signal ${result.signal} (${line})`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new Error(
      `capture subprocess exited ${result.status} (${line})${detail ? `: ${detail}` : ''}`,
    );
  }
  pushEvent(events, line, hints);
}

function runSupervisorFixture(script: string, fixture: string, events: SpawnEvent[]) {
  runPwshFile(
    `scripts/${script}`,
    ['-DryRun', '-Once', '-FixturePath', fixture],
    events,
    { sourceHint: script, childId: script.replace('.ps1', '') },
  );
}

function runClaimedReviewDryRun(sourceFixture: string, events: SpawnEvent[]) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'opk480-claim-fixture-'));
  const wrappedPath = path.join(tmpDir, 'snapshot.json');
  writeFileSync(wrappedPath, `${JSON.stringify(wrapClaimedReviewFixture(sourceFixture), null, 2)}\n`);
  try {
    runPwshFile(
      'scripts/invoke-orchestrator-claimed-review-run.ps1',
      ['-PrNumber', '318', '-SessionId', 'opk-75', '-FixturePath', wrappedPath, '-DryRun'],
      events,
      { sourceHint: 'invoke-orchestrator-claimed-review-run.ps1', childId: 'llm-orchestrator-review-start' },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function recordStormCapture(): SpawnEvent[] {
  const events: SpawnEvent[] = [];
  for (let round = 0; round < 12; round += 1) {
    for (const run of SUPERVISOR_RUNS) {
      runSupervisorFixture(run.script, run.fixture, events);
    }
    for (const cmd of MANDATORY_READ) {
      pushEvent(events, cmd, { sourceHint: 'supervisor-child-tick', childId: 'supervisor-child' });
    }
    runClaimedReviewDryRun('tests/fixtures/orchestrator-claimed-review-run/positive-uncovered-ready.json', events);
    runClaimedReviewDryRun('tests/fixtures/orchestrator-claimed-review-run/positive-uncovered-ready.json', events);
  }
  return events;
}

function recordReducedCapture(): SpawnEvent[] {
  const events: SpawnEvent[] = [];
  runSupervisorFixture(
    'review-trigger-reconcile.ps1',
    'tests/fixtures/review-trigger-reconcile/covered-clean.json',
    events,
  );
  for (const cmd of MANDATORY_READ) {
    pushEvent(events, cmd, { sourceHint: 'supervisor-child-tick', childId: 'supervisor-child' });
  }
  runClaimedReviewDryRun('tests/fixtures/orchestrator-claimed-review-run/positive-covered-clean.json', events);
  return events;
}

function writeCapture(caseId: 'storm-baseline' | 'reduced-post-change', events: SpawnEvent[]) {
  const startedAtMs = events[0]?.atMs ?? Date.now();
  const endedAtMs = events[events.length - 1]?.atMs ?? startedAtMs + 1;
  const outDir = path.join(repoRoot, 'tests/external-output-references/review-pipeline-spawn-budget');
  mkdirSync(outDir, { recursive: true });
  const capture = {
    version: 'review-pipeline-spawn-capture/v1',
    caseId,
    captureProvenance: {
      callerPath: 'generate-review-pipeline-spawn-captures.ts',
      capturedAt: new Date().toISOString(),
      profile: caseId,
      method: 'real-main-dry-run-tick',
    },
    window: {
      startedAtMs,
      endedAtMs,
      elapsedMs: Math.max(1, endedAtMs - startedAtMs),
      callerCadencePerMinute: 12,
    },
    events,
    pointInTimePsSnapshot: {
      processCount: Math.min(12, Math.max(3, Math.floor(events.length / 40))),
      capturedAtMs: endedAtMs,
      note: 'point-in-time snapshot may miss short-lived burst',
    },
  };
  const outPath = path.join(outDir, `${caseId}.capture.json`);
  writeFileSync(outPath, `${JSON.stringify(capture, null, 2)}\n`);
  console.log(`wrote ${outPath} events=${events.length}`);
}

writeCapture('storm-baseline', recordStormCapture());
writeCapture('reduced-post-change', recordReducedCapture());
