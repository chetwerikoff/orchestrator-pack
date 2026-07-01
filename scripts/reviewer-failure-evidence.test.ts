import { createHash } from 'node:crypto';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FAILURE_EVIDENCE_SCHEMA_VERSION,
  assertFailureEvidenceSecretSafe,
  associateFailureEvidenceRun,
  buildFailureEvidenceSummary,
  createFailureEvidenceArtifact,
  ensureFailureEvidenceForReviewerSession,
  isFailureEvidenceArtifact,
  recordFailureEvidenceOutput,
  recordFailureEvidencePhase,
  recordFailureEvidenceTerminal,
  resolveFailureEvidenceForRun,
  resolveOutputTailLimit,
  resolveTerminationSignalFromExitCode,
  scrubSecretLikeOutput,
  tailBoundedText,
} from '../docs/reviewer-failure-evidence.mjs';
import {
  RECOVERY_REASON_PROVABLY_DEAD,
  fingerprintRun,
  runRecoveryTick,
} from '../docs/review-run-recovery.mjs';
import {
  drainTempRoots,
  readRecoveryAudit,
  tempRecoveryStore,
  writeRecoveryRun,
} from './lib/review-recovery-test-fixtures.js';

type EvidenceCreateResult = { ok: boolean; path?: string };
type EvidenceSummary = { stdoutTail?: string; lastPhase?: string };
type EvidenceResolveResult = { ok: boolean; diagnostic?: string; summary: EvidenceSummary; path?: string };

function tempStore() {
  return tempRecoveryStore();
}

function writeRun(store: string, patch: Record<string, unknown> = {}) {
  return writeRecoveryRun(store, { prNumber: 312, ...patch });
}

function readAudit(store: string) {
  return readRecoveryAudit(store);
}

afterEach(() => {
  drainTempRoots((root: string) => rmSync(root, { recursive: true, force: true }));
});

describe('reviewer-failure-evidence', () => {
  it('creates a durable artifact before wrapper start with reviewer-session binding', () => {
    const store = tempStore();
    const created = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-a',
      wrapperKind: 'codex',
    }) as EvidenceCreateResult;
    expect(created.ok).toBe(true);
    expect(created.path).toBeTruthy();
    const raw = readFileSync(created.path!, 'utf8');
    expect(JSON.parse(raw).reviewerSessionId).toBe('opk-rev-a');
    expect(JSON.parse(raw).wrapperKind).toBe('codex');
    expect(raw).not.toMatch(/command|cwd|env|token|secret|profile/i);
  });

  it('records phases incrementally and preserves last phase without fabricated exit code when killed mid-flight', () => {
    const store = tempStore();
    const { path } = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-killed',
      wrapperKind: 'codex',
    }) as EvidenceCreateResult;
    recordFailureEvidencePhase({ path: path!, phase: 'wrapper_started' });
    const artifact = JSON.parse(readFileSync(path!, 'utf8'));
    expect(artifact.lastPhase).toBe('wrapper_started');
    expect(artifact.exitCode).toBeUndefined();
    expect(artifact.signal).toBeUndefined();
  });

  it('records non-zero exit code and bounded stderr tail', () => {
    const store = tempStore();
    const { path } = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-fail',
      wrapperKind: 'codex',
    }) as EvidenceCreateResult;
    const stderr = 'review failed: missing dependency\n'.repeat(200);
    recordFailureEvidenceTerminal({ path: path!, exitCode: 17, stderr, outputTailLimit: 256 });
    const artifact = JSON.parse(readFileSync(path!, 'utf8'));
    expect(artifact.exitCode).toBe(17);
    expect(artifact.stderrTail.length).toBeLessThanOrEqual(256);
    expect(artifact.stderrTail).toContain('missing dependency');
  });

  it('scrubs secret-like reviewer output before persisting evidence tails', () => {
    const store = tempStore();
    const { path } = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-secret',
      wrapperKind: 'codex',
    }) as EvidenceCreateResult;
    const stderr = 'Authorization: Bearer sk-live-abc123def456\nreview failed\n';
    recordFailureEvidenceOutput({ path: path!, stderr });
    const raw = readFileSync(path!, 'utf8');
    expect(raw).not.toContain('sk-live-abc123def456');
    const artifact = JSON.parse(raw);
    expect(artifact.stderrTail).toContain('[REDACTED]');
    expect(assertFailureEvidenceSecretSafe(artifact).ok).toBe(true);
  });

  it('redacts entire multi-pair Cookie headers before persisting evidence tails', () => {
    const store = tempStore();
    const { path } = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-cookie',
      wrapperKind: 'codex',
    }) as EvidenceCreateResult;
    const stderr = 'Cookie: sid=abc; refresh=def\nreview failed\n';
    recordFailureEvidenceOutput({ path: path!, stderr });
    const raw = readFileSync(path!, 'utf8');
    expect(raw).not.toContain('sid=');
    expect(raw).not.toContain('refresh=');
    expect(raw).not.toContain('def');
    const artifact = JSON.parse(raw);
    expect(artifact.stderrTail).toContain('Cookie: [REDACTED]');
    expect(assertFailureEvidenceSecretSafe(artifact).ok).toBe(true);
  });

  it('redacts generic cookie key assignments outside Cookie headers', () => {
    const store = tempStore();
    const { path } = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-cookie-kv',
      wrapperKind: 'codex',
    }) as EvidenceCreateResult;
    const stderr = 'cookie=sid=abc\nreview failed\n';
    recordFailureEvidenceOutput({ path: path!, stderr });
    const raw = readFileSync(path!, 'utf8');
    expect(raw).not.toContain('sid=abc');
    const artifact = JSON.parse(raw);
    expect(artifact.stderrTail).toContain('cookie=[REDACTED]');
    expect(assertFailureEvidenceSecretSafe(artifact).ok).toBe(true);
  });

  it('records signal detail for signal-style exit codes on linux', () => {
    const signal = resolveTerminationSignalFromExitCode(137, 'linux');
    expect(signal.signal).toBe('9');
    const store = tempStore();
    const { path } = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-signal',
      wrapperKind: 'codex',
    }) as EvidenceCreateResult;
    recordFailureEvidenceTerminal({ path: path!, exitCode: 137 });
    const artifact = JSON.parse(readFileSync(path!, 'utf8'));
    expect(artifact.signal).toBe('9');
    expect(artifact.exitCode).toBe(137);
  });

  it('marks signal unavailable on unsupported platforms', () => {
    const signal = resolveTerminationSignalFromExitCode(1, 'win32');
    expect(signal.signal).toBe('signal_unavailable');
  });

  it('bounds large stdout capture and summary tails', () => {
    const large = 'x'.repeat(20_000);
    expect(tailBoundedText(large, 1024).length).toBe(1024);
    const store = tempStore();
    const { path } = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-large',
      wrapperKind: 'codex',
    }) as EvidenceCreateResult;
    recordFailureEvidenceOutput({ path: path!, stdout: large, outputTailLimit: 512 });
    const artifact = JSON.parse(readFileSync(path!, 'utf8'));
    const summary = buildFailureEvidenceSummary(artifact, { summaryTailLimit: 128 }) as EvidenceSummary;
    expect(artifact.stdoutTail.length).toBe(512);
    expect(summary.stdoutTail!.length).toBeLessThanOrEqual(128);
  });

  it('honors AO_REVIEW_FAILURE_EVIDENCE_OUTPUT_TAIL_LIMIT when outputTailLimit is omitted', () => {
    const previous = process.env.AO_REVIEW_FAILURE_EVIDENCE_OUTPUT_TAIL_LIMIT;
    process.env.AO_REVIEW_FAILURE_EVIDENCE_OUTPUT_TAIL_LIMIT = '128';
    try {
      expect(resolveOutputTailLimit()).toBe(128);
      const store = tempStore();
      const { path } = createFailureEvidenceArtifact({
        storeDir: store,
        reviewerSessionId: 'opk-rev-env-tail',
        wrapperKind: 'codex',
      }) as EvidenceCreateResult;
      recordFailureEvidenceOutput({ path: path!, stdout: 'y'.repeat(500) });
      const artifact = JSON.parse(readFileSync(path!, 'utf8'));
      expect(artifact.stdoutTail.length).toBe(128);
    } finally {
      if (previous === undefined) delete process.env.AO_REVIEW_FAILURE_EVIDENCE_OUTPUT_TAIL_LIMIT;
      else process.env.AO_REVIEW_FAILURE_EVIDENCE_OUTPUT_TAIL_LIMIT = previous;
    }
  });

  it('honors AO_REVIEW_FAILURE_EVIDENCE_SUMMARY_TAIL_LIMIT on resolveFailureEvidenceForRun recovery path', () => {
    const previous = process.env.AO_REVIEW_FAILURE_EVIDENCE_SUMMARY_TAIL_LIMIT;
    process.env.AO_REVIEW_FAILURE_EVIDENCE_SUMMARY_TAIL_LIMIT = '64';
    try {
      const store = tempStore();
      const { run } = writeRun(store, { reviewerSessionId: 'opk-rev-summary-env' });
      const { path } = createFailureEvidenceArtifact({
        storeDir: store,
        reviewerSessionId: 'opk-rev-summary-env',
        wrapperKind: 'codex',
        runId: run.id,
        runFingerprint: fingerprintRun(run),
      }) as EvidenceCreateResult;
      recordFailureEvidenceOutput({ path: path!, stdout: 'z'.repeat(500) });
      associateFailureEvidenceRun({
        path: path!,
        storeDir: store,
        runId: run.id,
        runFingerprint: fingerprintRun(run),
      });
      const resolved = resolveFailureEvidenceForRun(store, run) as EvidenceResolveResult;
      expect(resolved.ok).toBe(true);
      expect(resolved.summary.stdoutTail!.length).toBeLessThanOrEqual(64);
    } finally {
      if (previous === undefined) delete process.env.AO_REVIEW_FAILURE_EVIDENCE_SUMMARY_TAIL_LIMIT;
      else process.env.AO_REVIEW_FAILURE_EVIDENCE_SUMMARY_TAIL_LIMIT = previous;
    }
  });

  it('associates run id without ambiguity after run becomes discoverable', () => {
    const store = tempStore();
    const { run } = writeRun(store, { reviewerSessionId: 'opk-rev-bind' });
    const created = ensureFailureEvidenceForReviewerSession({
      storeDir: store,
      reviewerSessionId: 'opk-rev-bind',
      wrapperKind: 'claude',
    }) as EvidenceCreateResult;
    expect(created.ok).toBe(true);
    associateFailureEvidenceRun({
      path: created.path,
      storeDir: store,
      runId: run.id,
      runFingerprint: fingerprintRun(run),
    });
    const resolved = resolveFailureEvidenceForRun(store, run) as EvidenceResolveResult;
    expect(resolved.ok).toBe(true);
    expect(resolved.summary.lastPhase).toBeUndefined();
    expect(resolved.path).toBeTruthy();
  });

  it('rejects secret-like forbidden fields in artifacts', () => {
    const unsafe = {
      schemaVersion: FAILURE_EVIDENCE_SCHEMA_VERSION,
      reviewerSessionId: 'opk-rev-a',
      token: 'sk-secret',
      commandLine: 'codex review --token abc',
    };
    const result = assertFailureEvidenceSecretSafe(unsafe);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('token'))).toBe(true);
    expect(result.errors.some((e) => e.includes('commandLine'))).toBe(true);
  });

  it('reports failure_evidence_missing when artifact cannot be found', () => {
    const store = tempStore();
    const { run } = writeRun(store);
    const resolved = resolveFailureEvidenceForRun(store, run) as EvidenceResolveResult;
    expect(resolved.ok).toBe(false);
    expect(resolved.diagnostic).toBe('failure_evidence_missing');
  });

  it('resets stale session evidence when a new run starts in the same reviewer workspace', () => {
    const store = tempStore();
    const first = writeRun(store, {
      idSuffix: 'first',
      reviewerSessionId: 'opk-rev-repeat',
      status: 'failed',
      completedAt: '2026-06-13T00:01:00.000Z',
    });
    const firstPath = join(store, 'reviewer-failure-evidence', 'opk-rev-repeat.json');
    mkdirSync(join(store, 'reviewer-failure-evidence'), { recursive: true });
    writeFileSync(firstPath, `${JSON.stringify({
      schemaVersion: 1,
      reviewerSessionId: 'opk-rev-repeat',
      runId: first.run.id,
      phases: [{ phase: 'wrapper_exited', at: '2026-06-13T00:01:00.000Z' }],
      lastPhase: 'wrapper_exited',
      exitCode: 0,
      completionStatus: 'normal',
      stderrTail: 'old run stderr',
    }, null, 2)}\n`);
    writeRun(store, {
      idSuffix: 'second',
      reviewerSessionId: 'opk-rev-repeat',
      createdAt: '2026-06-13T00:02:00.000Z',
      startedAt: '2026-06-13T00:02:00.000Z',
    });
    const ensured = ensureFailureEvidenceForReviewerSession({
      storeDir: store,
      reviewerSessionId: 'opk-rev-repeat',
      wrapperKind: 'codex',
    });
    expect(ensured.reset).toBe(true);
    const artifact = JSON.parse(readFileSync(firstPath, 'utf8'));
    expect(artifact.runId).toBe('review-run-second');
    expect(artifact.exitCode).toBeUndefined();
    expect(artifact.stderrTail).toBeUndefined();
    expect(artifact.phases).toEqual([]);
  });

  it('does not return evidence from a stale by-run pointer after session reuse', () => {
    const store = tempStore();
    const first = writeRun(store, {
      idSuffix: 'old-pointer',
      reviewerSessionId: 'opk-rev-stale-pointer',
      status: 'failed',
      completedAt: '2026-06-13T00:01:00.000Z',
    });
    const sessionPath = join(store, 'reviewer-failure-evidence', 'opk-rev-stale-pointer.json');
    const pointerDir = join(store, 'reviewer-failure-evidence', 'by-run');
    mkdirSync(pointerDir, { recursive: true });
    writeFileSync(join(pointerDir, `${first.run.id}.json`), `${JSON.stringify({
      schemaVersion: 1,
      runId: first.run.id,
      reviewerSessionId: 'opk-rev-stale-pointer',
      artifactPath: sessionPath,
    }, null, 2)}\n`);
    writeFileSync(sessionPath, `${JSON.stringify({
      schemaVersion: 1,
      reviewerSessionId: 'opk-rev-stale-pointer',
      runId: first.run.id,
      phases: [{ phase: 'wrapper_exited', at: '2026-06-13T00:01:00.000Z' }],
      lastPhase: 'wrapper_exited',
      stderrTail: 'first run evidence',
    }, null, 2)}\n`);

    writeRun(store, {
      idSuffix: 'new-pointer',
      reviewerSessionId: 'opk-rev-stale-pointer',
      createdAt: '2026-06-13T00:02:00.000Z',
    });
    ensureFailureEvidenceForReviewerSession({
      storeDir: store,
      reviewerSessionId: 'opk-rev-stale-pointer',
      wrapperKind: 'codex',
    });

    const resolved = resolveFailureEvidenceForRun(store, first.run) as EvidenceResolveResult;
    expect(resolved.ok).toBe(false);
    expect(resolved.diagnostic).toBe('failure_evidence_missing');
  });

  it('does not treat by-run pointer JSON as the evidence artifact', () => {
    const store = tempStore();
    const { run } = writeRun(store, { idSuffix: 'pointer', reviewerSessionId: 'opk-rev-pointer' });
    const pointerDir = join(store, 'reviewer-failure-evidence', 'by-run');
    mkdirSync(pointerDir, { recursive: true });
    const pointerPath = join(pointerDir, `${run.id}.json`);
    writeFileSync(pointerPath, `${JSON.stringify({
      schemaVersion: 1,
      runId: run.id,
      reviewerSessionId: 'opk-rev-pointer',
      artifactPath: join(store, 'reviewer-failure-evidence', 'missing-session.json'),
    }, null, 2)}\n`);
    expect(isFailureEvidenceArtifact(JSON.parse(readFileSync(pointerPath, 'utf8')))).toBe(false);
    const resolved = resolveFailureEvidenceForRun(store, run) as EvidenceResolveResult;
    expect(resolved.ok).toBe(false);
    expect(resolved.diagnostic).toBe('failure_evidence_missing');
  });
});

describe('reviewer-failure-evidence recovery linkage', () => {
  function writeSidecar(store: string, run: Record<string, unknown>) {
    mkdirSync(join(store, 'reviewer-liveness'), { recursive: true });
    const sidecar = {
      schemaVersion: 1,
      runId: run.id,
      runFingerprint: fingerprintRun(run),
      reviewerSessionId: run.reviewerSessionId,
      capturedAt: '2026-06-13T00:00:01.000Z',
      windows: { crashGraceMs: 120_000, maxReviewDurationMs: 600_000, ambiguousStaleMs: 900_000 },
      identity: {
        kind: 'linux_proc_pid_starttime_boot',
        process: { pid: 99999999, startTimeTicks: '100', bootIdHash: 'boot-a' },
      },
    };
    writeFileSync(join(store, 'reviewer-liveness', `${run.id}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
  }

  function patchSidecarBootHash(store: string, runId: string) {
    const bootHash = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const sidecarPath = join(store, 'reviewer-liveness', `${runId}.json`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    sidecar.identity.process.bootIdHash = createHash('sha256').update(bootHash).digest('hex').slice(0, 16);
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  }

  it('links bounded failure evidence summary into recovery audit for proc_entry_missing (opk-rev-318 class)', () => {
    const store = tempStore();
    const { run } = writeRun(store, { reviewerSessionId: 'opk-rev-318' });
    writeSidecar(store, run);
    const created = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-318',
      wrapperKind: 'codex',
      runId: run.id,
      runFingerprint: fingerprintRun(run),
    }) as EvidenceCreateResult;
    recordFailureEvidencePhase({ path: created.path!, phase: 'wrapper_started' });
    recordFailureEvidencePhase({ path: created.path!, phase: 'reviewer_output_observed' });
    recordFailureEvidenceOutput({ path: created.path!, stderr: 'partial reviewer output' });
    patchSidecarBootHash(store, String(run.id));

    const result = runRecoveryTick({ storeDir: store, nowMs: Date.parse('2026-06-13T00:03:00Z') });
    expect(result.ok).toBe(true);
    const audit = readAudit(store);
    const transition = audit.records.find((r: { type: string }) => r.type === 'recovery_transition');
    expect(transition.evidence.failureEvidence.lastPhase).toBe('reviewer_output_observed');
    expect(transition.evidence.failureEvidenceDiagnostic).toBeUndefined();
    expect(transition.summary).toContain('reviewer_output_observed');
  });

  it('records failure_evidence_missing diagnostic when artifact is absent', () => {
    const store = tempStore();
    const { run } = writeRun(store);
    writeSidecar(store, run);
    patchSidecarBootHash(store, String(run.id));

    runRecoveryTick({ storeDir: store, nowMs: Date.parse('2026-06-13T00:03:00Z') });
    const transition = readAudit(store).records.find((r: { type: string }) => r.type === 'recovery_transition');
    expect(transition.evidence.failureEvidenceDiagnostic).toBe('failure_evidence_missing');
  });

  it('does not duplicate evidence summaries across repeated recovery ticks', () => {
    const store = tempStore();
    const { run } = writeRun(store, { reviewerSessionId: 'opk-rev-dedupe' });
    writeSidecar(store, run);
    createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-dedupe',
      wrapperKind: 'codex',
      runId: run.id,
      runFingerprint: fingerprintRun(run),
    });
    patchSidecarBootHash(store, String(run.id));

    runRecoveryTick({ storeDir: store, nowMs: Date.parse('2026-06-13T00:03:00Z') });
    runRecoveryTick({ storeDir: store, nowMs: Date.parse('2026-06-13T00:04:00Z') });
    const transitions = readAudit(store).records.filter((r: { type: string }) => r.type === 'recovery_transition');
    expect(transitions).toHaveLength(1);
  });
});
