import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AO_REVIEW_TRIGGER_PATH,
  buildReviewTriggerInvocation,
  buildReviewTriggerPath,
  classifyReviewTriggerResponse,
  evaluateProjectReviewerHarness,
  evaluateReviewBeforeCleanupGate,
  findForbiddenLegacyReviewRunCommands,
  flattenSessionReviewsToRuns,
} from '../docs/ao-0-10-review-api.mjs';
import { buildReviewRunArgv, buildReviewTriggerPath as reconcileTriggerPath } from '../docs/review-trigger-reconcile.mjs';
import { findForbiddenReviewWakeCommands } from '../docs/review-wake-trigger.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const capturesDir = path.join(
  repoRoot,
  'tests/external-output-references/captures/ao-0-10-review-api',
);
const fixturesDir = path.join(repoRoot, 'tests/fixtures/ao-0-10-review-trigger');
const wakeTriggerLib = path.join(repoRoot, 'scripts/lib/Invoke-ReviewWakeTrigger.ps1');
const reconcileScript = path.join(repoRoot, 'scripts/review-trigger-reconcile.ps1');
const reevalLib = path.join(repoRoot, 'scripts/lib/Invoke-ReviewTriggerReeval.ps1');
const workerRecoveryLib = path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1');
const reviewApiLib = path.join(repoRoot, 'scripts/lib/Invoke-AoReviewApi.ps1');

function loadJson(filePath: string) {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function runPwsh(script: string) {
  return execFileSync('pwsh', ['-NoProfile', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

describe('AO 0.10 review trigger API (Issue #623)', () => {
  it('buildReviewTriggerInvocation binds POST /reviews/trigger', () => {
    const invocation = buildReviewTriggerInvocation('orchestrator-pack-7');
    expect(invocation.method).toBe('POST');
    expect(invocation.path).toBe('/api/v1/sessions/orchestrator-pack-7/reviews/trigger');
    expect(invocation.shimArgv).toEqual(['ao-review', 'run', 'orchestrator-pack-7']);
    expect(AO_REVIEW_TRIGGER_PATH).toContain('/reviews/trigger');
  });

  it('buildReviewRunArgv delegates to ao-review shim argv', () => {
    expect(buildReviewRunArgv('opk-11', './scripts/run-pack-review.ps1')).toEqual([
      'ao-review',
      'run',
      'opk-11',
    ]);
    expect(reconcileTriggerPath('opk-11')).toBe('/api/v1/sessions/opk-11/reviews/trigger');
    expect(buildReviewTriggerPath('opk-11')).toBe('/api/v1/sessions/opk-11/reviews/trigger');
  });

  it('classifies trigger 201/200 capture payloads', () => {
    const created = loadJson(path.join(capturesDir, 'trigger-created.raw.json'));
    const reused = loadJson(path.join(capturesDir, 'trigger-reused.raw.json'));
    expect(classifyReviewTriggerResponse(created, 201)).toMatchObject({
      ok: true,
      created: true,
      reused: false,
    });
    expect(classifyReviewTriggerResponse(reused, 200)).toMatchObject({
      ok: true,
      created: false,
      reused: true,
    });
  });

  it('flattens session reviews list into legacy run rows', () => {
    const listPayload = loadJson(path.join(capturesDir, 'session-reviews-list.raw.json'));
    const runs = flattenSessionReviewsToRuns(listPayload, 'orchestrator-pack-7');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 'rr-623-created-1',
      status: 'running',
      linkedSessionId: 'orchestrator-pack-7',
      prNumber: 623,
    });
  });

  it('project config harness evaluation matches codex incumbent', () => {
    const config = loadJson(path.join(capturesDir, 'project-config.raw.json'));
    expect(evaluateProjectReviewerHarness(config, 'codex')).toMatchObject({
      ok: true,
      harness: 'codex',
      matchesExpected: true,
    });
  });

  it('forbids legacy ao review run in mechanical guards', () => {
    const violations = findForbiddenLegacyReviewRunCommands([
      'ao review run opk-1 --execute --command codex',
    ]);
    expect(violations).toHaveLength(1);
    const wakeViolations = findForbiddenReviewWakeCommands([
      'ao review run opk-11 --execute --command ./scripts/run-pack-review.ps1',
    ]);
    expect(wakeViolations).toHaveLength(1);
    expect(findForbiddenReviewWakeCommands(['ao-review run opk-11'])).toHaveLength(0);
  });

  it('review-before-cleanup gate blocks running latestRun for current head', () => {
    for (const name of ['cleanup-blocked-running.json', 'cleanup-proceed-complete.json']) {
      const fixture = loadJson(path.join(fixturesDir, name));
      const gate = evaluateReviewBeforeCleanupGate(fixture);
      expect(gate).toMatchObject(fixture.expect as Record<string, unknown>);
    }
  });

  it('ao-review shim replays trigger capture (fixture mode)', () => {
    const triggerCapture = path.join(capturesDir, 'trigger-created.raw.json');
    const out = runPwsh(
      `& '${path.join(repoRoot, 'scripts/ao-review.ps1')}' run orchestrator-pack-7 -FixtureTriggerPath '${triggerCapture}'`,
    ).trim();
    expect(out).toContain('review trigger ok');
    expect(out).toContain('http=201');
  });

  it('ao-review send exits REMOVED without silent success', () => {
    expect(() => {
      runPwsh(`& '${path.join(repoRoot, 'scripts/ao-review.ps1')}' send run-1 2>&1`);
    }).toThrow();
  });

  it('wake/reconcile/reeval entry scripts call Invoke-AoReviewTriggerForWorker not ao review run', () => {
    for (const [label, filePath] of [
      ['wake', wakeTriggerLib],
      ['reconcile', reconcileScript],
      ['reeval', reevalLib],
    ] as const) {
      const text = readFileSync(filePath, 'utf8');
      expect(text, label).toMatch(/Invoke-AoReviewTriggerForWorker/);
      expect(text, label).not.toMatch(/&\s+ao\s+@runArgs/);
      expect(text, label).not.toMatch(/@\('review',\s*'run'/);
    }
  });

  it('worker recovery enforces review-before-cleanup gate before worktree remove', () => {
    const text = readFileSync(workerRecoveryLib, 'utf8');
    expect(text).toMatch(/Assert-ReviewBeforeCleanupGate/);
    const gateIdx = text.indexOf('Assert-ReviewBeforeCleanupGate');
    const removeIdx = text.indexOf('worktree remove --force $pathCanon.canonical');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(gateIdx);
  });

  it('Invoke-AoReviewApi uses SkipHttpErrorCheck on PowerShell 7+ for allowed-status handling', () => {
    const text = readFileSync(reviewApiLib, 'utf8');
    expect(text).toMatch(/SkipHttpErrorCheck/);
    expect(text).toMatch(/Read-AoHttpResponseBodyText/);
    const httpJsonStart = text.indexOf('function Invoke-AoDaemonHttpJson');
    const httpJsonEnd = text.indexOf('function Get-AoSessionReviewsJson');
    const httpJsonBody = text.slice(httpJsonStart, httpJsonEnd);
    expect(httpJsonBody).toMatch(/Read-AoHttpResponseBodyText -Response \$resp/);
    expect(httpJsonBody).not.toMatch(/GetResponseStream\(\)/);
  });

  it('Invoke-AoReviewTriggerForWorker classifies HTTP 422 fixture as review_trigger_invalid', () => {
    const trigger422 = path.join(capturesDir, 'trigger-terminated-422.raw.json');
    const out = runPwsh(`
      . '${reviewApiLib}'
      $fixture = Get-Content '${trigger422}' -Raw | ConvertFrom-Json
      $result = Invoke-AoReviewTriggerForWorker -SessionId 'orchestrator-pack-dead' -FixturePayload $fixture
      $result | ConvertTo-Json -Compress -Depth 5
    `).trim();
    const result = JSON.parse(out) as { ok: boolean; httpStatus: number; reason: string };
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(422);
    expect(result.reason).toBe('review_trigger_invalid');
  });

  it('Read-AoHttpResponseBodyText reads HttpResponseMessage bodies on PowerShell 7', () => {
    const out = runPwsh(`
      . '${reviewApiLib}'
      $msg = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]::UnprocessableEntity)
      $msg.Content = [System.Net.Http.StringContent]::new('{"error":"unprocessable"}', [System.Text.Encoding]::UTF8, 'application/json')
      Read-AoHttpResponseBodyText -Response $msg
    `).trim();
    expect(out).toContain('unprocessable');
  });
});
