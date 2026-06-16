import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FAILURE_EVIDENCE_SCHEMA_VERSION,
  assertFailureEvidenceSecretSafe,
  associateFailureEvidenceRun,
  buildFailureEvidenceSummary,
  createFailureEvidenceArtifact,
  ensureFailureEvidenceForReviewerSession,
  readFailureEvidenceArtifact,
  recordFailureEvidenceOutput,
  recordFailureEvidencePhase,
  recordFailureEvidenceTerminal,
  resolveFailureEvidenceForRun,
  resolveTerminationSignalFromExitCode,
  tailBoundedText,
} from '../docs/reviewer-failure-evidence.mjs';
import {
  RECOVERY_REASON_PROVABLY_DEAD,
  fingerprintRun,
  runRecoveryTick,
} from '../docs/review-run-recovery.mjs';

const roots: string[] = [];

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-failure-evidence-'));
  roots.push(root);
  mkdirSync(join(root, 'runs'), { recursive: true });
  return root;
}

function writeRun(store: string, patch: Record<string, unknown> = {}) {
  const run = {
    id: `review-run-${patch.idSuffix ?? 'a'}`,
    projectId: 'orchestrator-pack',
    linkedSessionId: 'opk-worker',
    reviewerSessionId: 'opk-rev-a',
    status: 'running',
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    startedAt: '2026-06-13T00:00:00.000Z',
    targetSha: 'abc123',
    prNumber: 312,
    summary: 'fixture',
    ...patch,
  };
  delete (run as Record<string, unknown>).idSuffix;
  const path = join(store, 'runs', `${run.id}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  return { run, path };
}

function readAudit(store: string) {
  return JSON.parse(readFileSync(join(store, 'review-run-recovery-audit.json'), 'utf8'));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('reviewer-failure-evidence', () => {
  it('creates a durable artifact before wrapper start with reviewer-session binding', () => {
    const store = tempStore();
    const created = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-a',
      wrapperKind: 'codex',
    });
    expect(created.ok).toBe(true);
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
    }) as { path: string };
    recordFailureEvidencePhase({ path, phase: 'wrapper_started' });
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
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
    }) as { path: string };
    const stderr = 'review failed: missing dependency\n'.repeat(200);
    recordFailureEvidenceTerminal({ path, exitCode: 17, stderr, outputTailLimit: 256 });
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    expect(artifact.exitCode).toBe(17);
    expect(artifact.stderrTail.length).toBeLessThanOrEqual(256);
    expect(artifact.stderrTail).toContain('missing dependency');
  });

  it('records signal detail for signal-style exit codes on linux', () => {
    const signal = resolveTerminationSignalFromExitCode(137, 'linux');
    expect(signal.signal).toBe('9');
    const store = tempStore();
    const { path } = createFailureEvidenceArtifact({
      storeDir: store,
      reviewerSessionId: 'opk-rev-signal',
      wrapperKind: 'codex',
    }) as { path: string };
    recordFailureEvidenceTerminal({ path, exitCode: 137 });
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
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
    }) as { path: string };
    recordFailureEvidenceOutput({ path, stdout: large, outputTailLimit: 512 });
    const summary = buildFailureEvidenceSummary(JSON.parse(readFileSync(path, 'utf8')), { summaryTailLimit: 128 });
    expect(JSON.parse(readFileSync(path, 'utf8')).stdoutTail.length).toBe(512);
    expect(summary.stdoutTail!.length).toBeLessThanOrEqual(128);
  });

  it('associates run id without ambiguity after run becomes discoverable', () => {
    const store = tempStore();
    const { run } = writeRun(store, { reviewerSessionId: 'opk-rev-bind' });
    const created = ensureFailureEvidenceForReviewerSession({
      storeDir: store,
      reviewerSessionId: 'opk-rev-bind',
      wrapperKind: 'claude',
    });
    expect(created.ok).toBe(true);
    associateFailureEvidenceRun({
      path: created.path,
      storeDir: store,
      runId: run.id,
      runFingerprint: fingerprintRun(run),
    });
    const resolved = resolveFailureEvidenceForRun(store, run);
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
    const resolved = resolveFailureEvidenceForRun(store, run);
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
    }) as { path: string };
    recordFailureEvidencePhase({ path: created.path, phase: 'wrapper_started' });
    recordFailureEvidencePhase({ path: created.path, phase: 'reviewer_output_observed' });
    recordFailureEvidenceOutput({ path: created.path, stderr: 'partial reviewer output' });

    const bootHash = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const sidecarPath = join(store, 'reviewer-liveness', `${run.id}.json`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    sidecar.identity.process.bootIdHash = createHash('sha256').update(bootHash).digest('hex').slice(0, 16);
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

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
    const bootHash = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const sidecarPath = join(store, 'reviewer-liveness', `${run.id}.json`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    sidecar.identity.process.bootIdHash = createHash('sha256').update(bootHash).digest('hex').slice(0, 16);
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

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
    const bootHash = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const sidecarPath = join(store, 'reviewer-liveness', `${run.id}.json`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    sidecar.identity.process.bootIdHash = createHash('sha256').update(bootHash).digest('hex').slice(0, 16);
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

    runRecoveryTick({ storeDir: store, nowMs: Date.parse('2026-06-13T00:03:00Z') });
    runRecoveryTick({ storeDir: store, nowMs: Date.parse('2026-06-13T00:04:00Z') });
    const transitions = readAudit(store).records.filter((r: { type: string }) => r.type === 'recovery_transition');
    expect(transitions).toHaveLength(1);
  });
});
