import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { executeReview } from '../plugins/ao-codex-pr-reviewer/lib/review_core.js';
import { parseTerminalVerdictPayload } from '../plugins/ao-codex-pr-reviewer/lib/emit.js';
import {
  assertNoBoardFieldEmission,
  assertTrustedPackRootExecution,
  classifyHarnessBridgeFailure,
  classifyReviewerHarnessAbort,
  containsProseSubmitMarkers,
  evaluateHarnessKillSwitch,
  evaluateNestedReviewBudget,
  HARNESS_BRIDGE_KILL_SWITCH_ENV,
  HARNESS_NESTED_BUDGET_ENV,
  resolveHarnessExecutionSurfaces,
  validateMapperSubmitPayload,
} from '../docs/harness-review-bridge.mjs';
import {
  classifyReviewTriggerResponse,
  classifyReviewerHarnessAbort,
  evaluateProjectReviewerHarness,
} from '../docs/ao-0-10-review-api.mjs';
import {
  HARNESS_BRIDGE_KILL_SWITCH,
  buildHarnessSubmitPayload,
  resolveHarnessTrustedPaths,
  runHarnessReviewBridge,
} from './harness-review-bridge.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'plugins/ao-codex-pr-reviewer/tests/fixtures');
const harnessFixtures = path.join(repoRoot, 'tests/fixtures/harness-review-bridge');
const capturesDir = path.join(repoRoot, 'tests/external-output-references/captures/ao-0-10-review-api');
const daemonCapturesDir = path.join(
  repoRoot,
  'tests/external-output-references/captures/ao-0-10-daemon',
);
const legacyConfigCapture = path.join(capturesDir, 'project-config.raw.json');
const reviewApiLib = path.join(repoRoot, 'scripts/lib/Invoke-AoReviewApi.ps1');
const SCOPED_ISSUE_NUMBER = 9;
const tempRoots: string[] = [];
const oldEnv = { ...process.env };

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.env = { ...oldEnv };
});

function tempCapture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-review-bridge-test-'));
  tempRoots.push(dir);
  return path.join(dir, 'submit.json');
}

function readFixture(name: string): string {
  return readFileSync(path.join(fixtureDir, name), 'utf8');
}

describe('AO 0.10 harness review bridge (Issue #658)', () => {
  it('guards trusted pack prompt, bridge, and mapper paths statically', () => {
    const paths = resolveHarnessTrustedPaths(repoRoot);
    expect(paths.prompt.endsWith('prompts/codex_review_prompt.md')).toBe(true);
    expect(paths.bridge.endsWith('scripts/harness-review-bridge.ts')).toBe(true);
    expect(paths.mapper.endsWith('plugins/ao-codex-pr-reviewer/lib/review_jsonl.ts')).toBe(true);
  });

  it('rejects worker-worktree shadowing for prompt resolution', () => {
    const workerRoot = '/tmp/opk-harness-worker-wt';
    const surfaces = resolveHarnessExecutionSurfaces(repoRoot);
    const shadowed = {
      ...surfaces,
      promptPath: path.join(workerRoot, 'prompts/codex_review_prompt.md'),
    };
    const result = assertTrustedPackRootExecution(shadowed, workerRoot);
    expect(result.ok).toBe(false);
  });

  it('submits mapper-normalized [Pn] structured findings', () => {
    const capture = tempCapture();
    process.env.AO_HARNESS_REVIEW_SUBMIT_CAPTURE_FILE = capture;
    const result = runHarnessReviewBridge({
      runId: 'run-658-findings',
      repoRoot,
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      source: 'codex-local',
      fixtureStdout: 'ignored',
      fixtureProcessJsonl: readFixture('process-clean.jsonl'),
      fixtureSessionJsonl: readFixture('session-findings.jsonl'),
    });
    expect(result.ok).toBe(true);
    const submitted = JSON.parse(readFileSync(capture, 'utf8'));
    expect(submitted.payload.findingCount).toBe(1);
    expect(submitted.payload.findings[0].title).toMatch(/^\[P3\]/);
    expect(submitted.payload.findings[0].body).toMatch(/severity: non-blocking/);
    expect(assertNoBoardFieldEmission(submitted.payload)).toEqual([]);
  });

  it('matches invoke-pack-review mapper golden shape', () => {
    const review = executeReview({
      repoRoot,
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      source: 'codex-local',
      fixtureStdout: 'ignored',
      fixtureProcessJsonl: readFixture('process-clean.jsonl'),
      fixtureSessionJsonl: readFixture('session-findings.jsonl'),
    });
    const golden = JSON.parse(readFileSync(path.join(harnessFixtures, 'invoke-pack-review-mapper-golden.json'), 'utf8'));
    const payload = parseTerminalVerdictPayload(review.aoStdout);
    expect(payload?.verdict).toBe(golden.verdict);
    expect(payload?.findings[0]?.title).toBe(golden.findings[0].title);
    expect(payload?.findings[0]?.filePath).toBe(golden.findings[0].filePath);
  });

  it('submits clean findingCount:0 / NO_FINDINGS contract', () => {
    const capture = tempCapture();
    process.env.AO_HARNESS_REVIEW_SUBMIT_CAPTURE_FILE = capture;
    const result = runHarnessReviewBridge({
      runId: 'run-658-clean',
      repoRoot,
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      source: 'codex-local',
      fixtureStdout: 'ignored',
      fixtureProcessJsonl: readFixture('process-clean.jsonl'),
      fixtureSessionJsonl: readFixture('session-native-clean-op-rev-27.jsonl'),
    });
    expect(result).toMatchObject({ ok: true, reason: 'NO_FINDINGS' });
    const submitted = JSON.parse(readFileSync(capture, 'utf8'));
    expect(submitted.payload).toMatchObject({ verdict: 'clean', findingCount: 0, findings: [] });
  });

  it('fails closed on contradictory review_output without prose scraping', () => {
    const capture = tempCapture();
    process.env.AO_HARNESS_REVIEW_SUBMIT_CAPTURE_FILE = capture;
    const result = runHarnessReviewBridge({
      runId: 'run-658-contradictory',
      repoRoot,
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      source: 'codex-local',
      fixtureStdout: 'NO_FINDINGS',
      fixtureProcessJsonl: readFixture('process-clean.jsonl'),
      fixtureSessionJsonl: readFixture('session-contradictory-clean-verdict.jsonl'),
    });
    expect(result.ok).toBe(false);
    expect(result.submitSkipped).toBe(true);
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it('rejects prose-only submit markers', () => {
    expect(containsProseSubmitMarkers('Finding: bad\nBLOCKING: denylist')).toBe(true);
    expect(validateMapperSubmitPayload('Finding: bad').ok).toBe(false);
  });

  it('kill-switch aborts before submit', () => {
    const capture = tempCapture();
    process.env.AO_HARNESS_REVIEW_SUBMIT_CAPTURE_FILE = capture;
    process.env[HARNESS_BRIDGE_KILL_SWITCH] = '1';
    expect(evaluateHarnessKillSwitch({ [HARNESS_BRIDGE_KILL_SWITCH_ENV]: '1' }).disabled).toBe(true);
    const result = runHarnessReviewBridge({
      runId: 'run-658-kill',
      repoRoot,
      baseRef: 'origin/main',
      fixtureStdout: 'NO_FINDINGS',
    });
    expect(result.ok).toBe(false);
    expect(result.submitSkipped).toBe(true);
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it('single nested codex review budget guard blocks re-entry', () => {
    expect(evaluateNestedReviewBudget({ [HARNESS_NESTED_BUDGET_ENV]: '1' }).ok).toBe(false);
    const source = readFileSync(path.join(repoRoot, 'scripts/harness-review-bridge.ts'), 'utf8');
    expect(source.match(/\bexecuteReview\(/g)).toHaveLength(1);
  });

  it('classifies unset reviewers before trigger', () => {
    const guard = classifyReviewerHarnessAbort({}, 'codex');
    expect(guard.abort).toBe(true);
    expect(guard.reason).toBe('reviewers_harness_misconfig');
  });

  it('Invoke-AoReviewTriggerForWorker refuses trigger on misconfig fixture', () => {
    const out = execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `. '${reviewApiLib}'; $fixture = @{ reviewers = @() }; $result = Invoke-AoReviewTriggerForWorker -SessionId 'worker-1' -ProjectConfigFixture $fixture; $result | ConvertTo-Json -Compress -Depth 5`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    const result = JSON.parse(out) as { ok: boolean; reason: string; classified: boolean };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('reviewers_harness_misconfig');
    expect(result.classified).toBe(true);
  });

  it('Get-AoProjectConfigJson reads GET /api/v1/projects/{id} not /config (Issue #682)', () => {
    const text = readFileSync(reviewApiLib, 'utf8');
    const fnStart = text.indexOf('function Get-AoProjectConfigJson');
    const fnEnd = text.indexOf('function Set-AoProjectReviewerHarness');
    const body = text.slice(fnStart, fnEnd);
    expect(body).toMatch(/\/api\/v1\/projects\/\$\(\[uri\]::EscapeDataString\(\$ProjectId\)\)"/);
    expect(body).not.toMatch(/\/config"/);
    expect(body).toMatch(/Unwrap-AoProjectConfigPayload/);
  });

  it('live-shape capture selects reviewers at .project.config.reviewers after unwrap (Issue #682)', () => {
    const live = JSON.parse(
      readFileSync(path.join(daemonCapturesDir, 'project-single-reviewers.raw.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(evaluateProjectReviewerHarness(live, 'codex')).toMatchObject({
      ok: false,
      harness: '',
      matchesExpected: false,
    });
    const project = live.project as Record<string, unknown>;
    expect(evaluateProjectReviewerHarness(project, 'codex')).toMatchObject({
      ok: true,
      harness: 'codex',
      matchesExpected: true,
    });
  });

  it('old /config top-level reviewers shape does not satisfy live envelope selector (Issue #682)', () => {
    const legacy = JSON.parse(readFileSync(legacyConfigCapture, 'utf8')) as Record<string, unknown>;
    const wrongEnvelope = { status: 'ok', project: legacy };
    expect(classifyReviewerHarnessAbort(wrongEnvelope, 'codex').abort).toBe(true);
    expect(classifyReviewerHarnessAbort(legacy, 'codex').abort).toBe(false);
  });

  it('Invoke-AoReviewTriggerForWorker allows live-shape fixture harness guard (Issue #682)', () => {
    const livePath = path.join(daemonCapturesDir, 'project-single-reviewers.raw.json');
    const out = execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `. '${reviewApiLib}'; $live = Get-Content '${livePath}' -Raw | ConvertFrom-Json; $guard = Invoke-AoReviewApiCli -Subcommand 'harness-guard' -Payload @{ payload = (Unwrap-AoProjectConfigPayload -Payload $live); expectedHarness = 'codex' }; $guard | ConvertTo-Json -Compress -Depth 5`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    expect(JSON.parse(out)).toMatchObject({ abort: false, harness: 'codex' });
  });

  it('GET /config 405 capture binds METHOD_NOT_ALLOWED selector (Issue #682)', () => {
    const body = JSON.parse(
      readFileSync(path.join(daemonCapturesDir, 'project-config-get-405.raw.json'), 'utf8'),
    ) as { code: string };
    expect(body.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('Set-AoProjectReviewerHarness reviewer-write path remains PUT /config (Issue #682)', () => {
    const text = readFileSync(reviewApiLib, 'utf8');
    const fnStart = text.indexOf('function Set-AoProjectReviewerHarness');
    const fnEnd = text.indexOf('function Test-ReviewBeforeCleanupGate');
    const body = text.slice(fnStart, fnEnd);
    expect(body).toMatch(/Method PUT/);
    expect(body).toMatch(/\/config"/);
  });

  it('ao-review trigger classify unchanged for capture payloads', () => {
    const created = JSON.parse(readFileSync(path.join(capturesDir, 'trigger-created.raw.json'), 'utf8'));
    expect(classifyReviewTriggerResponse(created, 201)).toMatchObject({
      ok: true,
      created: true,
      reused: false,
    });
  });

  it('failure-class matrix covers binding-table rows', () => {
    for (const failureClass of [
      'reviewers_harness_misconfig',
      'contradictory_review_output',
      'timeout_no_verdict',
      'stuck_running_no_submit',
      'claude_supersede_policy',
      'unstructured_github_body',
      'prose_submit_markers',
      'empty_mapper_output',
      'invalid_terminal_verdict_payload',
      'finding_missing_pn_title_prefix',
      'harness_bridge_kill_switch',
      'nested_review_budget_exceeded',
    ]) {
      expect(classifyHarnessBridgeFailure(failureClass).classified).toBe(true);
    }
  });

  it('rejects submit payloads whose finding title lost the [Pn] prefix', () => {
    expect(() =>
      buildHarnessSubmitPayload(
        JSON.stringify({
          verdict: 'findings',
          findingCount: 1,
          findings: [{ title: 'Missing priority prefix', severity: 'warning', body: 'severity: non-blocking' }],
        }),
      ),
    ).toThrow('finding_missing_pn_title_prefix');
  });

  it('rejects scope-violation titles without a priority prefix', () => {
    const payload = JSON.stringify({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ title: '[scope-violation] Out of scope file', body: 'severity: blocking' }],
    });
    expect(validateMapperSubmitPayload(payload)).toMatchObject({
      ok: false,
      reason: 'finding_missing_pn_title_prefix',
    });
    expect(() => buildHarnessSubmitPayload(payload)).toThrow('finding_missing_pn_title_prefix');
  });

  it('accepts scope-violation titles with a priority prefix', () => {
    const payload = JSON.stringify({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ title: '[P2] [scope-violation] Out of scope file', body: 'severity: blocking' }],
    });
    expect(validateMapperSubmitPayload(payload).ok).toBe(true);
  });
  it('maps mapper validation failures to stable harness failure classes', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty_mapper_output'],
      ['Finding: bad\n', 'prose_submit_markers'],
      ['not-json', 'invalid_terminal_verdict_payload'],
    ];
    for (const [stdout, reason] of cases) {
      expect(validateMapperSubmitPayload(stdout)).toMatchObject({ ok: false, reason });
      expect(() => buildHarnessSubmitPayload(stdout)).toThrow(reason);
      expect(classifyHarnessBridgeFailure(reason).classified).toBe(true);
    }
  });
});
