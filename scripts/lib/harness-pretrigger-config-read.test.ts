import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyReviewerHarnessAbort,
  evaluateProjectReviewerHarness,
} from '../../docs/ao-0-10-review-api.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const reviewApiLib = path.join(repoRoot, 'scripts/lib/Invoke-AoReviewApi.ps1');
const daemonCapturesDir = path.join(
  repoRoot,
  'tests/external-output-references/captures/ao-0-10-daemon',
);
const legacyConfigCapture = path.join(
  repoRoot,
  'tests/external-output-references/captures/ao-0-10-review-api/project-config.raw.json',
);

function loadJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

describe('harness pre-trigger project-config read (Issue #682)', () => {
  it('Get-AoProjectConfigJson reads GET /api/v1/projects/{id} not /config', () => {
    const text = readFileSync(reviewApiLib, 'utf8');
    const fnStart = text.indexOf('function Get-AoProjectConfigJson');
    const fnEnd = text.indexOf('function Set-AoProjectReviewerHarness');
    const body = text.slice(fnStart, fnEnd);
    expect(body).toMatch(/\/api\/v1\/projects\/\$\(\[uri\]::EscapeDataString\(\$ProjectId\)\)"/);
    expect(body).not.toMatch(/\/config"/);
    expect(body).toMatch(/Unwrap-AoProjectConfigPayload/);
  });

  it('live-shape capture selects reviewers at .project.config.reviewers after unwrap', () => {
    const live = loadJson(path.join(daemonCapturesDir, 'project-single-reviewers.raw.json'));
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
    const legacy = loadJson(legacyConfigCapture);
    const wrongEnvelope = { status: 'ok', project: legacy };
    expect(classifyReviewerHarnessAbort(wrongEnvelope, 'codex').abort).toBe(true);
    expect(classifyReviewerHarnessAbort(legacy, 'codex').abort).toBe(false);
  });

  it('Invoke-AoReviewTriggerForWorker allows live-shape fixture and refuses empty reviewers', () => {
    const livePath = path.join(daemonCapturesDir, 'project-single-reviewers.raw.json');
    const allowOut = execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `. '${reviewApiLib}'; $live = Get-Content '${livePath}' -Raw | ConvertFrom-Json; $guard = Invoke-AoReviewApiCli -Subcommand 'harness-guard' -Payload @{ payload = (Unwrap-AoProjectConfigPayload -Payload $live); expectedHarness = 'codex' }; $guard | ConvertTo-Json -Compress -Depth 5`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    expect(JSON.parse(allowOut)).toMatchObject({ abort: false, harness: 'codex' });

    const refuseOut = execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `. '${reviewApiLib}'; $result = Invoke-AoReviewTriggerForWorker -SessionId 'worker-682' -ProjectConfigFixture @{ reviewers = @() }; $result | ConvertTo-Json -Compress -Depth 5`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    const refused = JSON.parse(refuseOut) as { ok: boolean; reason: string; classified: boolean };
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('reviewers_harness_misconfig');
    expect(refused.classified).toBe(true);
  });

  it('GET /config 405 capture binds METHOD_NOT_ALLOWED selector', () => {
    const body = loadJson(path.join(daemonCapturesDir, 'project-config-get-405.raw.json'));
    expect(body.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('Set-AoProjectReviewerHarness reviewer-write path remains PUT /config', () => {
    const text = readFileSync(reviewApiLib, 'utf8');
    const fnStart = text.indexOf('function Set-AoProjectReviewerHarness');
    const fnEnd = text.indexOf('function Test-ReviewBeforeCleanupGate');
    const body = text.slice(fnStart, fnEnd);
    expect(body).toMatch(/Method PUT/);
    expect(body).toMatch(/\/config"/);
  });
});
