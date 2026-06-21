import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  REVERIFY_REASONS,
  REVERIFY_RUN_OUTCOMES,
  REVERIFY_STATUSES,
  REVERIFY_VERIFICATION_MODES,
  formatReviewerReverifySummary,
  resolveLinkedIssueNumber,
  runContractEvidenceReverify,
  type ReverifyRowResult,
} from './lib/contract-evidence-reverify.js';
import { DEFAULT_REVERIFY_MANIFEST_PATH, isCommandSafe, resolveAllowlistedCommand } from './lib/reverify-command-resolution.js';
import { runSandboxedAllowlistedCommand } from './lib/reverify-sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.join(here, '..');
const fixtureRoot = path.join(packRoot, 'tests/fixtures/contract-evidence-reverify');
const manifestPath = 'tests/fixtures/contract-evidence-reverify/capture-manifest.json';

function loadIssue(name: string): string {
  return readFileSync(path.join(fixtureRoot, 'issues', name), 'utf8');
}

function isPrHeadFullSandboxAvailable(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  const probe = spawnSync('bwrap', ['--version'], {
    encoding: 'utf8',
    shell: false,
  });
  return probe.status === 0;
}

const prHeadFullSandboxAvailable = isPrHeadFullSandboxAvailable();

function expectNewRowWhenFullSandboxAvailable(
  row: ReverifyRowResult,
  whenAvailable: Partial<ReverifyRowResult>,
) {
  if (!prHeadFullSandboxAvailable) {
    expect(row).toMatchObject({
      status: 'unverified',
      reason: 'producer-unreachable',
      verificationMode: 'not-run',
    });
    return;
  }
  expect(row).toMatchObject(whenAvailable);
}

function baseInput(snapshotBody: string, overrides: Record<string, unknown> = {}) {
  return {
    repoRoot: packRoot,
    trustedBaseRoot: packRoot,
    reviewTargetRoot: packRoot,
    manifestPath,
    boundSnapshotBody: snapshotBody,
    prBody: 'Closes #9001\n',
    explicitIssueNumber: 9001,
    prHeadSha: 'fixture-head',
    ...overrides,
  };
}


function shouldExcludeFromArchiveTrustedRootCopy(sourceRoot: string, src: string): boolean {
  const rel = path.relative(sourceRoot, src);
  if (!rel) {
    return false;
  }
  if (rel === '.git' || rel.startsWith(`.git${path.sep}`)) {
    return true;
  }
  return rel === 'node_modules' || rel.startsWith(`node_modules${path.sep}`);
}

function createArchiveTrustedRootFixture(): string {
  const archiveRoot = mkdtempSync(path.join(tmpdir(), 'reverify-archive-trusted-'));
  cpSync(packRoot, archiveRoot, {
    recursive: true,
    filter: (src) => !shouldExcludeFromArchiveTrustedRootCopy(packRoot, src),
  });
  return archiveRoot;
}

describe('contract-evidence reverify (Issue #376)', () => {

  it('archive trusted root without .git gets live capture verification when sandbox available', () => {
    if (!prHeadFullSandboxAvailable) {
      return;
    }
    const archiveTrustedRoot = createArchiveTrustedRootFixture();
    try {
      expect(existsSync(path.join(archiveTrustedRoot, '.git'))).toBe(false);
      const result = runContractEvidenceReverify(baseInput(loadIssue('live-match.md'), {
        trustedBaseRoot: archiveTrustedRoot,
      }));
      expect(result.rows[0]).toMatchObject({
        status: 'verified',
        verificationMode: 'live',
        producerVerified: true,
      });
      expect(result.rows[0].verificationMode).not.toBe('compared-to-record');
    } finally {
      rmSync(archiveTrustedRoot, { recursive: true, force: true });
    }
  });


  it('detects mutations inside disposable sandbox copy', () => {
    const resolved = resolveAllowlistedCommand(
      'REVERIFY_ATTEMPT_MUTATION=1 REVERIFY_VALUE=match node tests/fixtures/contract-evidence-reverify/producers/structured-value.mjs',
      { repoRoot: packRoot },
    );
    expect(resolved).not.toBeNull();
    const result = runSandboxedAllowlistedCommand(resolved!, {
      cwd: packRoot,
      dependencyRoot: packRoot,
      timeoutMs: 10_000,
      sandboxMode: 'trusted-base',
    });
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe('read-only-postcondition-violated');
    expect(existsSync(path.join(packRoot, '.reverify-mutation-marker'))).toBe(false);
  });

  it('runs capture producers against review target data, not trusted base only', () => {
    const reviewTargetRoot = createArchiveTrustedRootFixture();
    try {
      const runtimeValuePath = path.join(
        reviewTargetRoot,
        'tests/fixtures/contract-evidence-reverify/runtime-value.txt',
      );
      writeFileSync(runtimeValuePath, 'divergent\n', 'utf8');
      const result = runContractEvidenceReverify(baseInput(loadIssue('live-runtime-file.md'), {
        trustedBaseRoot: packRoot,
        reviewTargetRoot,
        repoRoot: reviewTargetRoot,
        prBody: 'Closes #9015\n',
        explicitIssueNumber: 9015,
      }));
      expect(result.rows[0]).toMatchObject({
        status: 'divergent',
        verificationMode: 'live',
        asserted: 'match',
        observed: 'divergent',
        producerVerified: false,
      });
    } finally {
      rmSync(reviewTargetRoot, { recursive: true, force: true });
    }
  });

  it('AC1: live capture row still matching emits verified/live', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('live-match.md')));
    expect(result.runOutcome).toBe('rows-evaluated');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      status: 'verified',
      verificationMode: 'live',
      producerVerified: true,
    });
    expect(result.rows[0].reason).toBeUndefined();
  });

  it('structured producer nonzero exit is divergent not producer-verified', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('live-exit-nonzero.md'), {
      prBody: 'Closes #9012\n',
      explicitIssueNumber: 9012,
    }));
    expect(result.rows[0]).toMatchObject({
      status: 'divergent',
      verificationMode: 'live',
      producerVerified: false,
    });
    expect(result.rows[0].observed).toContain('exit:');
  });

  it('cli-behavior live capture row matching exit and stdout emits verified/live', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('live-cli-behavior-match.md'), {
      prBody: 'Closes #9013\n',
      explicitIssueNumber: 9013,
    }));
    expect(result.rows[0]).toMatchObject({
      status: 'verified',
      verificationMode: 'live',
      producerVerified: true,
    });
    expect(result.rows[0].asserted).toContain('0/');
    expect(result.rows[0].observed).toContain('0/');
  });

  it('cli-behavior live capture diverges when exit ok but stdout wrong', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('live-cli-behavior-wrong-body.md'), {
      prBody: 'Closes #9014\n',
      explicitIssueNumber: 9014,
    }));
    expect(result.rows[0]).toMatchObject({
      status: 'divergent',
      verificationMode: 'live',
      producerVerified: false,
    });
    expect(result.rows[0].asserted).toContain('0/');
    expect(result.rows[0].observed).toMatch(/^0\//);
    expect(result.rows[0].observed).toContain('false');
  });

  it('rejects allowlisted-prefix sibling paths for node scripts', () => {
    expect(isCommandSafe(
      'node tests/fixtures/contract-evidence-reverify/producers-malicious/script.mjs',
      packRoot,
    )).toBe(false);
    expect(isCommandSafe(
      'node tests/fixtures/contract-evidence-reverify/producers/genuine-new-proof.mjs',
      packRoot,
    )).toBe(true);
  });

  it('npm test NEW proof outside allowlist is unsafe-or-undeclared', () => {
    const body = loadIssue('new-fulfilled.md').replace(
      'proof-command: REVERIFY_STATUS=verified node tests/fixtures/contract-evidence-reverify/producers/genuine-new-proof.mjs',
      'proof-command: npm test -- producer-emission-unmapped',
    );
    const result = runContractEvidenceReverify(
      baseInput(body, { prBody: 'Closes #9004\n', explicitIssueNumber: 9004 }),
    );
    expect(result.rows[0]).toMatchObject({
      status: 'unverified',
      reason: 'unsafe-or-undeclared-command',
      verificationMode: 'not-run',
    });
  });

  it('npm test -- reverify resolves vitest proof and independent producer mapping', () => {
    expect(isCommandSafe('npm test -- reverify', packRoot)).toBe(true);
    const resolved = resolveAllowlistedCommand('npm test -- reverify', { repoRoot: packRoot });
    expect(resolved?.allowlistId).toBe('npm test -- reverify');
    expect(resolved?.args?.[0]).toContain('vitest.mjs');
    expect(resolved?.args?.[2]).toBe('reverify');
    expect(resolved?.env?.TMPDIR).toBe('/tmp');
    expect(resolved?.env?.VITEST_CACHE_DIR).toBe('/tmp/opk-reverify-vitest-cache');
  });

  it('npm independent mapping strings observe producer reality without echoing issue expected', () => {
    const allowlistPath = path.join(packRoot, 'scripts/contract-evidence-reverify-allowlist.json');
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as {
      npmProofIndependentCommands?: Record<string, string>;
    };
    const mappings = allowlist.npmProofIndependentCommands ?? {};
    for (const independentCommand of Object.values(mappings)) {
      expect(independentCommand).not.toContain('{{expected}}');
      expect(independentCommand).not.toMatch(/REVERIFY_STATUS=/);
      expect(independentCommand).not.toMatch(/REVERIFY_VALUE=/);
    }
    expect(mappings['npm test -- reverify']).toBe(
      'node tests/fixtures/contract-evidence-reverify/producers/genuine-new-proof.mjs',
    );
    expect(mappings['npm test -- contract-evidence-reverify']).toBe(
      'node tests/fixtures/contract-evidence-reverify/producers/structured-value.mjs',
    );
  });

  it('AC2/AC14/reverify: live capture divergence emits divergent with values', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('live-divergent.md'), {
      prBody: 'Closes #9002\n',
      explicitIssueNumber: 9002,
    }));
    expect(result.rows[0]).toMatchObject({
      status: 'divergent',
      verificationMode: 'live',
      producerVerified: false,
    });
    expect(result.rows[0].asserted).toContain('expected');
    expect(result.rows[0].observed).toContain('divergent');
  });

  it('AC3: fulfilled NEW row emits verified/live', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('new-fulfilled.md'), {
      prBody: 'Closes #9004\n',
      explicitIssueNumber: 9004,
    }));
    expectNewRowWhenFullSandboxAvailable(result.rows[0], {
      status: 'verified',
      verificationMode: 'live',
      producerVerified: true,
    });
  });

  it('AC4: ran proof showing non-emission yields unfulfilled-new', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('new-unfulfilled.md'), {
      prBody: 'Closes #9005\n',
      explicitIssueNumber: 9005,
    }));
    expectNewRowWhenFullSandboxAvailable(result.rows[0], {
      status: 'unfulfilled-new',
      verificationMode: 'live',
    });
  });

  it('AC4: absent/unsafe NEW proof yields unverified not unfulfilled-new', () => {
    const unsafeBody = loadIssue('new-fulfilled.md').replace(
      'proof-command: REVERIFY_STATUS=verified node tests/fixtures/contract-evidence-reverify/producers/genuine-new-proof.mjs',
      'proof-command: rm -rf /tmp/reverify-unsafe',
    );
    const absent = runContractEvidenceReverify(
      baseInput(unsafeBody, { prBody: 'Closes #9004\n', explicitIssueNumber: 9004 }),
    );
    expect(absent.rows[0].status).toBe('unverified');
    expect(absent.rows[0].status).not.toBe('unfulfilled-new');
    expect(absent.rows[0].verificationMode).toBe('not-run');
    expect(absent.rows[0].reason).toBe('unsafe-or-undeclared-command');
  });

  it('AC5/AC6: compared-to-record is not producer-verified', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('compared-to-record.md'), {
      prBody: 'Closes #9007\n',
      explicitIssueNumber: 9007,
    }));
    expect(result.rows[0]).toMatchObject({
      verificationMode: 'compared-to-record',
      producerVerified: false,
    });
  });

  it('AC8: emits snapshot identifiers and distinct output fields', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('live-match.md')));
    expect(result.issueNumber).toBe(9001);
    expect(result.snapshotHash).toMatch(/^sha256:/);
    expect(result.rows[0]?.rowHash).toMatch(/^sha256:/);
    for (const value of REVERIFY_STATUSES) {
      expect(typeof value).toBe('string');
    }
    for (const value of REVERIFY_VERIFICATION_MODES) {
      expect(typeof value).toBe('string');
    }
    for (const value of REVERIFY_REASONS) {
      expect(typeof value).toBe('string');
    }
  });

  it('AC9: linked-issue ambiguity surfaces run-level states', () => {
    const noLinked = resolveLinkedIssueNumber({ prBody: 'No issue link' });
    expect(noLinked.ok).toBe(false);
    if (!noLinked.ok) {
      expect(noLinked.runOutcome).toBe('no-linked-issue');
    }
    const multi = resolveLinkedIssueNumber({ prBody: 'Closes #1\n\nCloses #2\n' });
    expect(multi.ok).toBe(false);
    if (!multi.ok) {
      expect(multi.runOutcome).toBe('multiple-linked-issues');
    }
    const mismatch = resolveLinkedIssueNumber({
        prBody: 'Closes #9001\n',
        expectedIssueNumber: 42,
      });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.runOutcome).toBe('pr-issue-mismatch');
    }
    const unavailable = runContractEvidenceReverify({
      ...baseInput(loadIssue('live-match.md')),
      boundSnapshotBody: null,
    });
    expect(unavailable.runOutcome).toBe('unavailable-snapshot');
  });

  it('AC10: manifest hash mismatch is integrity-failed terminal', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('integrity-failed.md'), {
      prBody: 'Closes #9008\n',
      explicitIssueNumber: 9008,
    }));
    expect(result.rows[0]).toMatchObject({
      status: 'integrity-failed',
      verificationMode: 'not-run',
    });
  });

  it('AC12: boundary fixtures for unreachable/unsupported/unsafe/no-rows', () => {
    const noRows = runContractEvidenceReverify(baseInput(loadIssue('explicit-none.md'), {
      prBody: 'Closes #9003\n',
      explicitIssueNumber: 9003,
    }));
    expect(noRows.runOutcome).toBe('no-rows');

    const unreachable = runContractEvidenceReverify(
      baseInput(loadIssue('producer-unreachable.md'), {
        prBody: 'Closes #9009\n',
        explicitIssueNumber: 9009,
        timeoutMs: 50,
      }),
    );
    expect(unreachable.rows[0]).toMatchObject({
      status: 'unverified',
      reason: 'producer-unreachable',
      verificationMode: 'not-run',
    });

    const unsafe = runContractEvidenceReverify(baseInput(loadIssue('unsafe-command.md'), {
      prBody: 'Closes #9010\n',
      explicitIssueNumber: 9010,
    }));
    expect(unsafe.rows[0].verificationMode).toBe('compared-to-record');

    const unsupported = runContractEvidenceReverify(
      baseInput(loadIssue('unsupported-producer.md'), {
        prBody: 'Closes #9011\n',
        explicitIssueNumber: 9011,
      }),
    );
    expect(unsupported.rows[0]).toMatchObject({
      status: 'unverified',
      reason: 'unsupported-producer',
      verificationMode: 'not-run',
    });
  });

  it('non-genuine NEW proof yields unverified/non-genuine-proof', () => {
    const result = runContractEvidenceReverify(
      baseInput(loadIssue('new-non-genuine-proof.md'), {
        prBody: 'Closes #9006\n',
        explicitIssueNumber: 9006,
      }),
    );
    expectNewRowWhenFullSandboxAvailable(result.rows[0], {
      status: 'unverified',
      reason: 'non-genuine-proof',
      verificationMode: 'not-run',
    });
  });

  it('NEW row with producer-command identical to proof-command yields unverified/non-genuine-proof', () => {
    const proofCommand =
      'REVERIFY_STATUS=verified node tests/fixtures/contract-evidence-reverify/producers/genuine-new-proof.mjs';
    const body = loadIssue('new-fulfilled.md').replace(
      `proof-command: ${proofCommand}`,
      `proof-command: ${proofCommand}\nproducer-command: ${proofCommand}`,
    );
    const result = runContractEvidenceReverify(
      baseInput(body, { prBody: 'Closes #9004\n', explicitIssueNumber: 9004 }),
    );
    expectNewRowWhenFullSandboxAvailable(result.rows[0], {
      status: 'unverified',
      reason: 'non-genuine-proof',
      verificationMode: 'not-run',
    });
  });

  it('snapshot-drift flag on rows-evaluated when current issue differs', () => {
    const snapshot = loadIssue('live-match.md');
    const drifted = `${snapshot}\n\nEdited after capture.`;
    const result = runContractEvidenceReverify(
      baseInput(snapshot, { currentIssueBody: drifted }),
    );
    expect(result.runOutcome).toBe('rows-evaluated');
    expect(result.snapshotDrift).toBe(true);
  });

  it('trusted-base tamper marks capture row unverified', () => {
    const result = runContractEvidenceReverify(
      baseInput(loadIssue('live-match.md'), {
        prModifiedPaths: ['tests/fixtures/contract-evidence-reverify/capture-manifest.json'],
      }),
    );
    expect(result.rows[0]).toMatchObject({
      status: 'unverified',
      reason: 'untrusted-pr-modified',
    });
  });

  it('PR-modified trusted checker marks capture row unverified', () => {
    const result = runContractEvidenceReverify(
      baseInput(loadIssue('live-match.md'), {
        prModifiedPaths: ['scripts/lib/reverify-sandbox.ts'],
      }),
    );
    expect(result.rows[0]).toMatchObject({
      status: 'unverified',
      reason: 'untrusted-pr-modified',
    });
  });

  it('PR-modified capture producer is not executed live', () => {
    const result = runContractEvidenceReverify(
      baseInput(loadIssue('live-match.md'), {
        prModifiedPaths: ['tests/fixtures/contract-evidence-reverify/producers/structured-value.mjs'],
      }),
    );
    expect(result.rows[0]).toMatchObject({
      status: 'unverified',
      reason: 'untrusted-pr-modified',
    });
  });

  it('checker crash fixtures emit check-error and partial-run', () => {
    const before = runContractEvidenceReverify({
      ...baseInput(loadIssue('live-match.md')),
      simulateCrashBeforeFirstRow: true,
    });
    expect(before.runOutcome).toBe('check-error');

    const partial = runContractEvidenceReverify({
      ...baseInput(loadIssue('live-divergent.md'), {
        prBody: 'Closes #9002\n',
        explicitIssueNumber: 9002,
      }),
      simulateCrashAfterRow: 0,
    });
    expect(partial.runOutcome).toBe('partial-run');
    expect(partial.rows).toHaveLength(0);
  });

  it('host-independent verdict across cwd variants', () => {
    const input = baseInput(loadIssue('live-match.md'));
    const a = runContractEvidenceReverify({ ...input, repoRoot: packRoot });
    const b = runContractEvidenceReverify({
      ...input,
      repoRoot: path.join(packRoot, 'tests', 'fixtures', 'contract-evidence-reverify'),
      trustedBaseRoot: packRoot,
      reviewTargetRoot: packRoot,
    });
    expect(a.rows[0]?.status).toBe(b.rows[0]?.status);
  });

  it('summary surfaces every row to reviewer without block verdict', () => {
    const result = runContractEvidenceReverify(baseInput(loadIssue('live-divergent.md'), {
      prBody: 'Closes #9002\n',
      explicitIssueNumber: 9002,
    }));
    const summary = formatReviewerReverifySummary(result);
    expect(summary).toContain('never-blocks: true');
    expect(summary).toContain('status=divergent');
    expect(summary).toContain('verification-mode=live');
    expect(summary).toContain('never-blocks: true');
  });

  it('rejects issue-body command injection via shell metacharacters', () => {
    const injected = loadIssue('new-fulfilled.md').replace(
      'proof-command: REVERIFY_STATUS=verified node tests/fixtures/contract-evidence-reverify/producers/genuine-new-proof.mjs',
      'proof-command: node tests/fixtures/contract-evidence-reverify/producers/genuine-new-proof.mjs; touch .reverify-mutation-marker',
    );
    const result = runContractEvidenceReverify(
      baseInput(injected, { prBody: 'Closes #9004\n', explicitIssueNumber: 9004 }),
    );
    expect(result.rows[0]).toMatchObject({
      status: 'unverified',
      reason: 'unsafe-or-undeclared-command',
      verificationMode: 'not-run',
    });
    expect(existsSync(path.join(packRoot, '.reverify-mutation-marker'))).toBe(false);
  });

  it('invoke CLI defaults to production capture manifest', () => {
    expect(DEFAULT_REVERIFY_MANIFEST_PATH).toBe('tests/external-output-references/capture-manifest.json');
  });

  it('invoke CLI emits JSON for divergence fixture (AC14 command path)', () => {
    const snapshotFile = path.join(fixtureRoot, 'issues', 'live-divergent.md');
    const proc = spawnSync(
      'node',
      [
        '--import',
        'tsx',
        path.join(packRoot, 'scripts/invoke-contract-evidence-reverify.ts'),
        '--repo-root',
        packRoot,
        '--snapshot-file',
        snapshotFile,
        '--pr-body-file',
        path.join(fixtureRoot, 'issues', 'live-divergent-pr-body.md'),
        '--explicit-issue',
        '9002',
        '--manifest-path',
        manifestPath,
      ],
      { encoding: 'utf8', cwd: packRoot },
    );
    expect(proc.status).toBe(0);
    const payload = JSON.parse(proc.stdout);
    expect(payload.rows[0].status).toBe('divergent');
  });

  it('run-level vocabulary covers fixed outcomes', () => {
    for (const outcome of REVERIFY_RUN_OUTCOMES) {
      expect(outcome.length).toBeGreaterThan(0);
    }
  });

  it('read-only postcondition: live check does not create mutation marker', () => {
    const marker = path.join(packRoot, '.reverify-mutation-marker');
    if (existsSync(marker)) {
      unlinkSync(marker);
    }
    const body = loadIssue('live-match.md');
    runContractEvidenceReverify(baseInput(body));
    expect(existsSync(marker)).toBe(false);
  });

  it('e2e reviewer fixture skips without OPK_REVERIFY_E2E_LIVE', () => {
    const proc = spawnSync('node', ['--import', 'tsx', 'scripts/run-reviewer-reverify-e2e-fixture.mjs'], {
      cwd: packRoot,
      encoding: 'utf8',
      env: { ...process.env, OPK_REVERIFY_E2E_LIVE: '', OPK_REVERIFY_E2E_SESSION: '' },
    });
    expect(proc.status).toBe(0);
    const payload = JSON.parse(proc.stdout);
    expect(payload.skipped).toBe(true);
    expect(payload.viaAoReviewExecute).toBe(false);
  });

  it('e2e reviewer fixture path passes', { timeout: 120_000 }, () => {
    if (process.env.OPK_REVERIFY_E2E_LIVE !== '1' && !process.env.OPK_REVERIFY_E2E_SESSION?.trim()) {
      return;
    }

    const aoCheck = spawnSync('which', ['ao'], { encoding: 'utf8' });
    if (aoCheck.status !== 0) {
      return;
    }

    const proc = spawnSync('node', ['--import', 'tsx', 'scripts/run-reviewer-reverify-e2e-fixture.mjs'], {
      cwd: packRoot,
      encoding: 'utf8',
    });
    expect(proc.status).toBe(0);
    const payload = JSON.parse(proc.stdout);
    expect(payload.skipped).not.toBe(true);
    expect(payload.viaAoReviewExecute).toBe(true);
    expect(payload.promptContainsCheckpoint2).toBe(true);
    expect(payload.summaryRunOutcomeRowsEvaluated).toBe(true);
    expect(payload.summaryIncludesRows).toBe(true);
    expect(payload.summaryIncludesNeverBlocks).toBe(true);
    expect(payload.reviewerOutputIsCheckpoint2Summary).toBe(true);
    expect(payload.summary).not.toContain('reverify-e2e-probe');
  });
});

describe('reverify npm test filter (AC14 producer-emission proof)', () => {
  it('reverify filter executes divergent fixture assertion', () => {
    const result = runContractEvidenceReverify(
      baseInput(loadIssue('live-divergent.md'), {
        prBody: 'Closes #9002\n',
        explicitIssueNumber: 9002,
      }),
    );
    expect(result.rows[0]?.status).toBe('divergent');
  });
});
