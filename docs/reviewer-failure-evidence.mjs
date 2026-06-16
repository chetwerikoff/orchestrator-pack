/**
 * Reviewer failure evidence artifact (Issue #312).
 *
 * Incremental, secret-safe execution evidence for local AO review runs. Record-only
 * observability consumed by #287 recovery — never a review verdict authority.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readStdinJson, runAsyncStdinJsonCliMain } from './review-mechanical-cli.mjs';
import { fingerprintRun, findRunForReviewerSession } from './review-run-recovery.mjs';

export const FAILURE_EVIDENCE_SCHEMA_VERSION = 1;
export const DEFAULT_OUTPUT_TAIL_LIMIT = 8192;
export const DEFAULT_SUMMARY_TAIL_LIMIT = 1024;

export const EVIDENCE_PHASES = new Set([
  'selector_resolved',
  'wrapper_resolved',
  'arguments_prepared',
  'wrapper_started',
  'reviewer_output_observed',
  'wrapper_exited',
  'entrypoint_failed_before_wrapper_start',
  'normal_completion',
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECRET_PATTERN = /(?:token|secret|password|api[_-]?key|authorization|cookie|private[_-]?key|bearer\s)/i;
const REMAINING_CREDENTIAL_PATTERN = /Bearer\s+(?!\[REDACTED\])\S+|(?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*(?!\[REDACTED\])\S+|\b(?:sk|ghp|xox[baprs])-[A-Za-z0-9_-]{4,}\b/i;
export const OUTPUT_WITHHELD_MARKER = '[output_withheld]';
const FORBIDDEN_FIELD_NAMES = new Set([
  'env',
  'environment',
  'command',
  'commandLine',
  'cmdline',
  'cwd',
  'prompt',
  'profile',
  'cookie',
  'token',
  'secret',
  'authorization',
]);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function safeReviewerSessionId(value) {
  const id = String(value ?? '').trim();
  return SAFE_ID.test(id) ? id : '';
}

function safeRunId(value) {
  const id = String(value ?? '').trim();
  return SAFE_ID.test(id) ? id : '';
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function getFailureEvidenceDir(storeDir) {
  return join(storeDir, 'reviewer-failure-evidence');
}

export function getFailureEvidenceSessionPath(storeDir, reviewerSessionId) {
  const session = safeReviewerSessionId(reviewerSessionId);
  if (!session) return null;
  return join(getFailureEvidenceDir(storeDir), `${session}.json`);
}

export function getFailureEvidenceRunPointerPath(storeDir, runId) {
  const id = safeRunId(runId);
  if (!id) return null;
  return join(getFailureEvidenceDir(storeDir), 'by-run', `${id}.json`);
}

export function resolveOutputTailLimit(env = process.env) {
  const parsed = Number(env.AO_REVIEW_FAILURE_EVIDENCE_OUTPUT_TAIL_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_OUTPUT_TAIL_LIMIT;
  return Math.floor(parsed);
}

export function resolveSummaryTailLimit(env = process.env) {
  const parsed = Number(env.AO_REVIEW_FAILURE_EVIDENCE_SUMMARY_TAIL_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SUMMARY_TAIL_LIMIT;
  return Math.floor(parsed);
}

export function tailBoundedText(text, limit = DEFAULT_OUTPUT_TAIL_LIMIT) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return value.slice(-limit);
}

export function scrubSecretLikeOutput(text) {
  let value = String(text ?? '');
  value = value.replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]');
  value = value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  value = value.replace(
    /((?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*)\S+/gi,
    '$1[REDACTED]',
  );
  value = value.replace(/\b(?:sk|ghp|xox[baprs])-[A-Za-z0-9_-]{4,}\b/g, '[REDACTED]');
  return value;
}

function prepareBoundedOutputTail(text, outputTailLimit) {
  if (text == null) return { tail: undefined, withheld: false };
  const scrubbed = scrubSecretLikeOutput(text);
  const tail = tailBoundedText(scrubbed, outputTailLimit);
  if (REMAINING_CREDENTIAL_PATTERN.test(tail)) {
    return { tail: OUTPUT_WITHHELD_MARKER, withheld: true };
  }
  return { tail, withheld: false };
}

function assignBoundedOutputTail(artifact, field, withheldField, text, outputTailLimit) {
  const prepared = prepareBoundedOutputTail(text, outputTailLimit);
  if (prepared.tail === undefined) return;
  artifact[field] = prepared.tail;
  if (prepared.withheld) artifact[withheldField] = true;
}

function emptyArtifact({ reviewerSessionId, wrapperKind }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: FAILURE_EVIDENCE_SCHEMA_VERSION,
    reviewerSessionId,
    createdAt: now,
    updatedAt: now,
    wrapperKind: wrapperKind ? String(wrapperKind) : undefined,
    phases: [],
    lastPhase: undefined,
  };
}

export function createFailureEvidenceArtifact({
  storeDir,
  reviewerSessionId,
  wrapperKind,
  runId,
  runFingerprint,
}) {
  const session = safeReviewerSessionId(reviewerSessionId);
  if (!session) return { ok: false, reason: 'invalid_reviewer_session_id' };
  const path = getFailureEvidenceSessionPath(storeDir, session);
  const artifact = emptyArtifact({ reviewerSessionId: session, wrapperKind });
  const boundRunId = safeRunId(runId);
  if (boundRunId) {
    artifact.runId = boundRunId;
    artifact.runFingerprint = runFingerprint ? String(runFingerprint) : undefined;
    const pointer = getFailureEvidenceRunPointerPath(storeDir, boundRunId);
    if (pointer) {
      writeJsonAtomic(pointer, {
        schemaVersion: FAILURE_EVIDENCE_SCHEMA_VERSION,
        runId: boundRunId,
        reviewerSessionId: session,
        artifactPath: path,
      });
    }
  }
  writeJsonAtomic(path, artifact);
  return { ok: true, path, artifact };
}

function readArtifactFile(path) {
  if (!path || !existsSync(path)) return null;
  return asRecord(JSON.parse(readFileSync(path, 'utf8')));
}

export function readFailureEvidenceArtifact(storeDir, { runId, reviewerSessionId } = {}) {
  const boundRunId = safeRunId(runId);
  if (boundRunId) {
    const pointerPath = getFailureEvidenceRunPointerPath(storeDir, boundRunId);
    const pointer = readArtifactFile(pointerPath);
    if (pointer?.artifactPath) {
      const artifact = readArtifactFile(String(pointer.artifactPath));
      if (artifact) return { ok: true, path: String(pointer.artifactPath), artifact };
    }
    const dir = join(getFailureEvidenceDir(storeDir), 'by-run');
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const candidate = readArtifactFile(join(dir, entry.name));
        if (candidate?.runId === boundRunId) {
          return { ok: true, path: join(dir, entry.name), artifact: candidate };
        }
      }
    }
  }
  const session = safeReviewerSessionId(reviewerSessionId);
  if (session) {
    const path = getFailureEvidenceSessionPath(storeDir, session);
    const artifact = readArtifactFile(path);
    if (artifact) return { ok: true, path, artifact };
  }
  if (boundRunId) {
    const evidenceDir = getFailureEvidenceDir(storeDir);
    if (existsSync(evidenceDir)) {
      for (const entry of readdirSync(evidenceDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const candidate = readArtifactFile(join(evidenceDir, entry.name));
        if (candidate?.runId === boundRunId) {
          return { ok: true, path: join(evidenceDir, entry.name), artifact: candidate };
        }
      }
    }
  }
  return { ok: false, reason: 'failure_evidence_missing' };
}

function mutateArtifact(path, mutator) {
  const artifact = readArtifactFile(path);
  if (!artifact) return { ok: false, reason: 'artifact_missing' };
  const next = mutator({ ...artifact, phases: [...(artifact.phases ?? [])] });
  if (!next) return { ok: false, reason: 'mutation_rejected' };
  next.updatedAt = new Date().toISOString();
  writeJsonAtomic(path, next);
  return { ok: true, path, artifact: next };
}

export function recordFailureEvidencePhase({ path, phase }) {
  const normalized = String(phase ?? '').trim();
  if (!EVIDENCE_PHASES.has(normalized)) {
    return { ok: false, reason: 'invalid_phase' };
  }
  return mutateArtifact(path, (artifact) => {
    artifact.phases.push({ phase: normalized, at: new Date().toISOString() });
    artifact.lastPhase = normalized;
    return artifact;
  });
}

export function associateFailureEvidenceRun({ path, storeDir, runId, runFingerprint }) {
  const boundRunId = safeRunId(runId);
  if (!boundRunId) return { ok: false, reason: 'invalid_run_id' };
  const result = mutateArtifact(path, (artifact) => {
    artifact.runId = boundRunId;
    if (runFingerprint) artifact.runFingerprint = String(runFingerprint);
    return artifact;
  });
  if (!result.ok) return result;
  const pointer = getFailureEvidenceRunPointerPath(storeDir, boundRunId);
  if (pointer) {
    writeJsonAtomic(pointer, {
      schemaVersion: FAILURE_EVIDENCE_SCHEMA_VERSION,
      runId: boundRunId,
      reviewerSessionId: result.artifact.reviewerSessionId,
      artifactPath: path,
    });
  }
  return result;
}

export function recordFailureEvidenceOutput({ path, stdout, stderr, outputTailLimit = DEFAULT_OUTPUT_TAIL_LIMIT }) {
  return mutateArtifact(path, (artifact) => {
    assignBoundedOutputTail(artifact, 'stdoutTail', 'stdoutTailWithheld', stdout, outputTailLimit);
    assignBoundedOutputTail(artifact, 'stderrTail', 'stderrTailWithheld', stderr, outputTailLimit);
    return artifact;
  });
}

export function resolveTerminationSignalFromExitCode(exitCode, platform = process.platform) {
  const code = Number(exitCode);
  if (!Number.isFinite(code)) return { signal: 'signal_unavailable', signalDetail: 'exit_code_unavailable' };
  if (platform === 'win32') {
    return { signal: 'signal_unavailable', signalDetail: 'windows_exit_code_only' };
  }
  if (code > 128 && code < 256) {
    const signalNumber = code - 128;
    return { signal: String(signalNumber), signalDetail: `terminated_by_signal_${signalNumber}` };
  }
  if (code < 0) {
    return { signal: String(Math.abs(code)), signalDetail: `negative_exit_${code}` };
  }
  return { signal: undefined, signalDetail: undefined };
}

export function recordFailureEvidenceTerminal({
  path,
  exitCode,
  signal,
  signalDetail,
  stdout,
  stderr,
  outputTailLimit = DEFAULT_OUTPUT_TAIL_LIMIT,
  completionStatus,
}) {
  return mutateArtifact(path, (artifact) => {
    if (exitCode != null && Number.isFinite(Number(exitCode))) {
      artifact.exitCode = Number(exitCode);
    }
    if (signal != null) {
      artifact.signal = String(signal);
    } else if (exitCode != null) {
      const resolved = resolveTerminationSignalFromExitCode(exitCode);
      if (resolved.signal) artifact.signal = resolved.signal;
      if (resolved.signalDetail) artifact.signalDetail = resolved.signalDetail;
    }
    if (signalDetail != null) artifact.signalDetail = String(signalDetail);
    assignBoundedOutputTail(artifact, 'stdoutTail', 'stdoutTailWithheld', stdout, outputTailLimit);
    assignBoundedOutputTail(artifact, 'stderrTail', 'stderrTailWithheld', stderr, outputTailLimit);
    if (completionStatus) artifact.completionStatus = String(completionStatus);
    return artifact;
  });
}

export function buildFailureEvidenceSummary(artifact, options = {}) {
  if (!asRecord(artifact)) {
    return { diagnostic: 'failure_evidence_missing' };
  }
  const summaryTailLimit = options.summaryTailLimit ?? DEFAULT_SUMMARY_TAIL_LIMIT;
  const summary = {
    schemaVersion: FAILURE_EVIDENCE_SCHEMA_VERSION,
    lastPhase: artifact.lastPhase ?? artifact.phases?.at(-1)?.phase,
    wrapperKind: artifact.wrapperKind,
    exitCode: artifact.exitCode,
    signal: artifact.signal,
    signalDetail: artifact.signalDetail,
    completionStatus: artifact.completionStatus,
    stdoutTail: artifact.stdoutTail
      ? tailBoundedText(scrubSecretLikeOutput(artifact.stdoutTail), summaryTailLimit)
      : undefined,
    stderrTail: artifact.stderrTail
      ? tailBoundedText(scrubSecretLikeOutput(artifact.stderrTail), summaryTailLimit)
      : undefined,
    phaseCount: Array.isArray(artifact.phases) ? artifact.phases.length : 0,
    artifactPath: options.artifactPath,
  };
  for (const key of Object.keys(summary)) {
    if (summary[key] === undefined) delete summary[key];
  }
  return summary;
}

function stringLooksSecretUnsafe(text) {
  const value = String(text ?? '');
  if (REMAINING_CREDENTIAL_PATTERN.test(value)) return true;
  if (/(?:token|secret|password|api[_-]?key|cookie)\s*[:=]\s*(?!\[REDACTED\])\S+/i.test(value)) return true;
  return false;
}

export function assertFailureEvidenceSecretSafe(value, path = 'root') {
  const errors = [];
  function walk(node, currentPath) {
    if (node == null) return;
    if (typeof node === 'string') {
      if (stringLooksSecretUnsafe(node)) errors.push(`${currentPath}: suspicious secret-like content`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${currentPath}[${index}]`));
      return;
    }
    if (!asRecord(node)) return;
    for (const [key, entry] of Object.entries(node)) {
      if (FORBIDDEN_FIELD_NAMES.has(key)) {
        errors.push(`${currentPath}.${key}: forbidden field`);
      }
      walk(entry, `${currentPath}.${key}`);
    }
  }
  walk(value, path);
  return { ok: errors.length === 0, errors };
}

export function resolveFailureEvidenceForRun(storeDir, run) {
  const runId = safeRunId(run?.id ?? run?.runId);
  const reviewerSessionId = safeReviewerSessionId(run?.reviewerSessionId);
  const read = readFailureEvidenceArtifact(storeDir, { runId, reviewerSessionId });
  if (!read.ok) {
    return {
      ok: false,
      diagnostic: 'failure_evidence_missing',
      summary: { diagnostic: 'failure_evidence_missing', runId, reviewerSessionId },
    };
  }
  const validation = assertFailureEvidenceSecretSafe(read.artifact);
  if (!validation.ok) {
    return {
      ok: false,
      diagnostic: 'failure_evidence_malformed',
      summary: {
        diagnostic: 'failure_evidence_malformed',
        errors: validation.errors.slice(0, 5),
        lastPhase: read.artifact.lastPhase,
      },
      path: read.path,
    };
  }
  return {
    ok: true,
    path: read.path,
    artifact: read.artifact,
    summary: buildFailureEvidenceSummary(read.artifact, { artifactPath: read.path }),
  };
}

export function enrichRecoveryEvidenceWithFailure(storeDir, run, livenessEvidence) {
  const failure = resolveFailureEvidenceForRun(storeDir, run);
  const next = { ...livenessEvidence };
  if (failure.ok) {
    next.failureEvidence = failure.summary;
    next.failureEvidencePath = failure.path;
  } else {
    next.failureEvidenceDiagnostic = failure.diagnostic;
    next.failureEvidence = failure.summary;
  }
  return next;
}

export function ensureFailureEvidenceForReviewerSession({
  storeDir,
  reviewerSessionId,
  wrapperKind,
}) {
  const session = safeReviewerSessionId(reviewerSessionId);
  if (!session) return { ok: false, reason: 'invalid_reviewer_session_id' };
  const existingPath = getFailureEvidenceSessionPath(storeDir, session);
  if (existsSync(existingPath)) {
    const artifact = readArtifactFile(existingPath);
    return { ok: true, path: existingPath, artifact, created: false };
  }
  const entry = findRunForReviewerSession(storeDir, session);
  const run = entry?.run;
  const created = createFailureEvidenceArtifact({
    storeDir,
    reviewerSessionId: session,
    wrapperKind,
    runId: run ? safeRunId(run.id ?? run.runId) : undefined,
    runFingerprint: run ? fingerprintRun(run) : undefined,
  });
  if (!created.ok) return created;
  if (run && created.path) {
    associateFailureEvidenceRun({
      path: created.path,
      storeDir,
      runId: safeRunId(run.id ?? run.runId),
      runFingerprint: fingerprintRun(run),
    });
  }
  return { ...created, created: true };
}

async function main() {
  const subcommand = process.argv[2] ?? 'help';
  const payload = await readStdinJson();
  switch (subcommand) {
    case 'create':
      return createFailureEvidenceArtifact(payload ?? {});
    case 'record-phase':
      return recordFailureEvidencePhase(payload ?? {});
    case 'associate-run':
      return associateFailureEvidenceRun(payload ?? {});
    case 'record-output':
      return recordFailureEvidenceOutput(payload ?? {});
    case 'record-terminal':
      return recordFailureEvidenceTerminal(payload ?? {});
    case 'read':
      return readFailureEvidenceArtifact(payload?.storeDir, payload ?? {});
    case 'resolve-for-run':
      return resolveFailureEvidenceForRun(payload?.storeDir, payload?.run ?? {});
    case 'ensure':
      return ensureFailureEvidenceForReviewerSession(payload ?? {});
    case 'build-summary':
      return buildFailureEvidenceSummary(payload?.artifact, payload?.options ?? {});
    case 'assert-secret-safe':
      return assertFailureEvidenceSecretSafe(payload?.value ?? payload);
    case 'scrub-output':
      return { scrubbed: scrubSecretLikeOutput(payload?.text ?? '') };
    default:
      throw new Error(`Unknown reviewer-failure-evidence subcommand: ${subcommand}`);
  }
}

runAsyncStdinJsonCliMain('reviewer-failure-evidence.mjs', main);
