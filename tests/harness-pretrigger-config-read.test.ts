import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyReviewerHarnessAbort,
  evaluateProjectReviewerHarness,
} from '../docs/ao-0-10-review-api.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewApiLib = path.join(repoRoot, 'scripts/lib/Invoke-AoReviewApi.ps1');
const daemonCapturesDir = path.join(
  repoRoot,
  'tests/external-output-references/captures/ao-0-10-daemon',
);
const legacyConfigCapture = path.join(
  repoRoot,
  'tests/external-output-references/captures/ao-0-10-review-api/project-config.raw.json',
);

function loadHarnessJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

describe('harness pre-trigger project-config read (Issue #682)', () => {
  it('Get-AoProjectConfigJson reads GET /api/v1/projects/{id} not /config', () => {
    const text = readFileSync(reviewApiLib, 'utf8');
    const fnStart = text.indexOf('function Get-AoProjectConfigJson');
    const fnEnd = text.indexOf('function Test-ReviewBeforeCleanupGate');
    const body = text.slice(fnStart, fnEnd);
    expect(body).toMatch(/\/api\/v1\/projects\/\$\(\[uri\]::EscapeDataString\(\$ProjectId\)\)"/);
    expect(body).not.toMatch(/\/config"/);
    expect(body).toMatch(/Unwrap-AoProjectConfigPayload/);
  });

  it('live-shape capture selects reviewers at .project.config.reviewers after unwrap', () => {
    const live = loadHarnessJson(path.join(daemonCapturesDir, 'project-single-reviewers.raw.json'));
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

  it('old /config top-level reviewers shape does not satisfy live envelope selector', () => {
    const legacy = loadHarnessJson(legacyConfigCapture);
    const wrongEnvelope = { status: 'ok', project: legacy };
    expect(classifyReviewerHarnessAbort(wrongEnvelope, 'codex').abort).toBe(true);
    expect(classifyReviewerHarnessAbort(legacy, 'codex').abort).toBe(false);
  });

  it('Invoke-AoReviewTriggerForWorker delegates to the pack runner without reviewer-harness gating', () => {
    const text = readFileSync(reviewApiLib, 'utf8');
    const fnStart = text.indexOf('function Invoke-AoReviewTriggerForWorker');
    const fnEnd = text.indexOf('function Get-ReviewTriggerInvocationLine');
    const body = text.slice(fnStart, fnEnd);
    expect(body).toMatch(/Invoke-AoSessionReviewTrigger/);
    expect(body).toMatch(/pack_review_runner_failed/);
    expect(body).not.toMatch(/harness-guard|reviewers_harness_misconfig|Get-AoProjectConfigJson/);
  });

  it('GET /config 405 capture binds METHOD_NOT_ALLOWED selector', () => {
    const body = loadHarnessJson(path.join(daemonCapturesDir, 'project-config-get-405.raw.json'));
    expect(body.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('retires reviewer-harness config writes from the review adapter', () => {
    const text = readFileSync(reviewApiLib, 'utf8');
    expect(text).not.toMatch(/function Set-AoProjectReviewerHarness/);
    expect(text).not.toMatch(/\/config"/);
  });
});
