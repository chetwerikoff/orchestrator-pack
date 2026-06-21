/**
 * Shared per-(PR, worker-cycle, intent-class, worker-target) worker nudge gate (Issue #384).
 * Vitest: scripts/worker-nudge-gate.test.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLegacyNudgedCycle, buildOwnerCycleKey, getOwnerCycleRecord } from './worker-iteration-cycle.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const WORKER_NUDGE_GATE_VERSION = 'worker-nudge-gate/v1';
export const ATOMIC_WORKER_NUDGE_CLAIM_CAPABILITY = 'worker-nudge-claim-atomic/v1';
export const ORCHESTRATOR_TURN_SURFACE = 'orchestrator-turn';
export const AUTONOMOUS_SURFACE_ENV = 'AO_AUTONOMOUS_ORCHESTRATOR_SURFACE';
export const GATED_WORKER_NUDGE_BYPASS_ENV = 'AO_GATED_WORKER_NUDGE_BYPASS';
export const CLASSIFIER_VERSION = 'worker-nudge-intent/v1';

/** @type {readonly string[]} */
export const INTENT_CLASSES = Object.freeze([
  'review-findings',
  'findings-delivery',
  'ci-green-handoff',
  'ci-failure',
  'liveness',
  'unknown-worker-nudge',
]);

/** @type {readonly string[]} */
export const TERMINAL_CLAIM_PHASES = Object.freeze([
  'SENT',
  'FAILED_DEFINITIVE',
  'UNCERTAIN',
]);

/** @type {readonly string[]} */
export const ACTIVE_CLAIM_PHASES = Object.freeze(['CLAIMED', 'SEND_ATTEMPTED']);

const SHA40 = /^[0-9a-f]{40}$/i;
const DEFAULT_UNRESOLVED_ESCALATE_COUNT = 3;
const DEFAULT_UNRESOLVED_ESCALATE_MS = 15 * 60 * 1000;

/**
 * @param {unknown} value
 */
function toArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {string | undefined | null} sha
 */
export function normalizeHeadSha(sha) {
  return String(sha ?? '')
    .trim()
    .toLowerCase();
}

/**
 * @param {string} storePath
 */
export function canonicalizeStorePath(storePath) {
  let normalized = String(storePath ?? '').trim();
  if (!normalized) {
    return '';
  }
  const wsl = normalized.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (wsl) {
    normalized = `${wsl[1].toUpperCase()}:/${wsl[2]}`;
  }
  normalized = normalized.replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized.toLowerCase();
}

/**
 * @param {string} storePath
 */
export function canonicalStoreId(storePath) {
  const canonical = canonicalizeStorePath(storePath);
  if (!canonical) {
    return '';
  }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

/**
 * @param {object} input
 */
export function buildWorkerTarget(input) {
  const targetId = String(input.targetId ?? input.sessionId ?? input.workerSessionId ?? '').trim();
  const targetGeneration = String(
    input.targetGeneration ?? input.workerGeneration ?? input.sessionGeneration ?? targetId,
  ).trim();
  if (!targetId) {
    return { workerTarget: '', targetId: '', targetGeneration: '', verifiable: false };
  }
  return {
    workerTarget: `${targetId}:${targetGeneration}`,
    targetId,
    targetGeneration,
    verifiable: Boolean(targetId && targetGeneration),
  };
}

/**
 * @param {object} input
 */
export function classifyIntent(input) {
  const hint = String(input.intentClass ?? input.intentHint ?? '').trim().toLowerCase();
  if (INTENT_CLASSES.includes(hint)) {
    return hint;
  }

  const source = String(input.source ?? '').trim().toLowerCase();
  const surface = String(input.surface ?? '').trim().toLowerCase();
  const message = String(input.message ?? '').trim().toLowerCase();

  if (source === 'review-send' || source.includes('review-send')) {
    return 'findings-delivery';
  }
  if (source.includes('ci-failure') || source.includes('ci-failed')) {
    return 'ci-failure';
  }
  if (
    source.includes('ci-green') ||
    source === 'pack-send' ||
    message.includes('continue-hand-off') ||
    message.includes('ready_for_review when ci green')
  ) {
    return 'ci-green-handoff';
  }
  if (
    surface === 'waiting_worker_review_response' ||
    surface === 'merge.ready' ||
    message.includes('review findings') ||
    message.includes('needs_triage') ||
    message.includes('addressing_reviews') ||
    message.includes('ao review list')
  ) {
    return 'review-findings';
  }
  if (message.includes('liveness') || source.includes('heartbeat') || source.includes('liveness')) {
    return 'liveness';
  }
  return 'unknown-worker-nudge';
}

/**
 * @param {string} intentClass
 * @param {object} input
 */
export function deriveCycleKey(intentClass, input) {
  const klass = String(intentClass ?? '').trim().toLowerCase();
  const prNumber = Number(input.prNumber ?? 0);
  const headSha = normalizeHeadSha(input.headSha ?? input.eventHeadSha ?? '');
  const target = buildWorkerTarget(input);

  switch (klass) {
    case 'review-findings':
    case 'findings-delivery': {
      const runId = String(input.reviewRunId ?? input.runId ?? '').trim();
      if (!runId) {
        return '';
      }
      return `run:${runId}`;
    }
    case 'ci-green-handoff': {
      const transitionId = String(input.transitionId ?? '').trim();
      if (transitionId) {
        return `transition:${transitionId}`;
      }
      if (headSha) {
        return `transition:${prNumber}:${headSha}`;
      }
      return '';
    }
    case 'ci-failure': {
      const episodeKey = String(input.episodeKey ?? input.redPeriod ?? '').trim();
      if (episodeKey) {
        return `episode:${episodeKey}`;
      }
      if (headSha) {
        return `episode:${prNumber}:${headSha}`;
      }
      return '';
    }
    case 'liveness':
    case 'unknown-worker-nudge':
      if (!headSha || !target.workerTarget) {
        return '';
      }
      return `head:${headSha}:${target.targetGeneration}`;
    default:
      return '';
  }
}

/**
 * @param {object} input
 */
export function buildTupleKey(input) {
  const intentClass = classifyIntent(input);
  const cycleKey = deriveCycleKey(intentClass, input);
  const target = buildWorkerTarget(input);
  const prNumber = Number(input.prNumber ?? 0);
  if (!prNumber || !cycleKey || !intentClass || !target.workerTarget) {
    return {
      ok: false,
      reason: 'tuple_incomplete',
      intentClass,
      cycleKey,
      workerTarget: target.workerTarget,
    };
  }
  return {
    ok: true,
    prNumber,
    intentClass,
    cycleKey,
    workerTarget: target.workerTarget,
    targetId: target.targetId,
    targetGeneration: target.targetGeneration,
    targetVerifiable: target.verifiable,
    tupleKey: `${prNumber}|${cycleKey}|${intentClass}|${target.workerTarget}`,
  };
}

/**
 * @param {object} record
 */
export function remapLegacy332Record(record) {
  const transitionId = String(record?.transitionId ?? record?.sourceKey ?? '').trim();
  const sessionId = String(record?.sessionId ?? '').trim();
  const sentAtMs = Number(record?.sentAtMs ?? 0);
  const verifiable = Boolean(sessionId && (record?.targetGeneration || record?.sessionGeneration));
  if (!verifiable) {
    return { suppresses: false, reason: 'legacy_unverifiable', verifiable: false };
  }
  const targetGeneration = String(record?.targetGeneration ?? record?.sessionGeneration ?? sessionId);
  const intentClass = String(record?.intentClass ?? 'ci-green-handoff');
  const cycleKey = transitionId
    ? `transition:${transitionId.replace(/^ci-green:/, '')}`
    : deriveCycleKey(intentClass, record);
  return {
    suppresses: Boolean(cycleKey && sessionId),
    reason: 'legacy_verifiable',
    verifiable: true,
    intentClass,
    cycleKey,
    workerTarget: `${sessionId}:${targetGeneration}`,
    sentAtMs,
  };
}

/**
 * @param {object} input
 */
export function buildAuditRecord(input) {
  const required = [
    'prNumber',
    'logicalWorkerId',
    'sessionGeneration',
    'rawSessionId',
    'targetResolutionSource',
    'surface',
    'cycleKey',
    'intentClass',
    'storeId',
    'decision',
    'reason',
    'claimPhase',
    'sendTarget',
  ];
  /** @type {Record<string, unknown>} */
  const out = {
    kind: 'worker-nudge-gate',
    gateVersion: WORKER_NUDGE_GATE_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    atUtc: new Date().toISOString(),
    ...input,
  };
  for (const key of required) {
    if (out[key] === undefined || out[key] === null || out[key] === '') {
      out.auditIncomplete = true;
      out.missingAuditField = key;
      break;
    }
  }
  return out;
}

/**
 * @param {object} input
 */
function resolveUnresolvedEscalationBounds(input) {
  const count = Math.max(
    1,
    Number(input.unresolvedEscalateCount ?? process.env.AO_NUDGE_GATE_UNRESOLVED_ESCALATE_COUNT) ||
      DEFAULT_UNRESOLVED_ESCALATE_COUNT,
  );
  const ms = Math.max(
    1,
    Number(input.unresolvedEscalateMs ?? process.env.AO_NUDGE_GATE_UNRESOLVED_ESCALATE_MS) ||
      DEFAULT_UNRESOLVED_ESCALATE_MS,
  );
  const reportStaleMs = Math.max(1, Number(input.reportStaleMs ?? 30 * 60 * 1000));
  return {
    count,
    ms: Math.min(ms, reportStaleMs),
    reportStaleMs,
  };
}

/**
 * @param {object} input
 */
export function evaluateNudgeGate(input) {
  const tuple = buildTupleKey(input);
  if (!tuple.ok) {
    return {
      allow: false,
      decision: 'SUPPRESS',
      reason: tuple.reason,
      failClosed: true,
      audit: buildAuditRecord({
        prNumber: input.prNumber ?? null,
        logicalWorkerId: input.targetId ?? input.sessionId ?? null,
        sessionGeneration: input.targetGeneration ?? null,
        rawSessionId: input.sessionId ?? null,
        targetResolutionSource: input.targetResolutionSource ?? 'unresolved',
        surface: input.surface ?? input.source ?? 'unknown',
        cycleKey: tuple.cycleKey ?? null,
        intentClass: tuple.intentClass ?? 'unknown-worker-nudge',
        storeId: canonicalStoreId(input.storePath ?? ''),
        decision: 'SUPPRESS',
        reason: tuple.reason,
        claimPhase: 'none',
        sendTarget: input.sessionId ?? null,
      }),
    };
  }

  const storeId = canonicalStoreId(input.storePath ?? '');
  const claims = toArray(input.claims);
  const terminal = claims.find(
    (row) =>
      String(row?.tupleKey ?? '') === tuple.tupleKey &&
      TERMINAL_CLAIM_PHASES.includes(String(row?.phase ?? row?.state ?? '')),
  );
  if (terminal) {
    const phase = String(terminal.phase ?? terminal.state ?? 'SENT');
    if (phase === 'SENT' || phase === 'UNCERTAIN') {
      return suppress('already_served', tuple, input, storeId, phase);
    }
  }

  const active = claims.find(
    (row) =>
      String(row?.tupleKey ?? '') === tuple.tupleKey &&
      ACTIVE_CLAIM_PHASES.includes(String(row?.phase ?? row?.state ?? '')),
  );
  if (active && String(input.holderProcessGuid ?? '') !== String(active.holder?.processGuid ?? active.processGuid ?? '')) {
    return suppress('claimed', tuple, input, storeId, String(active.phase ?? active.state ?? 'CLAIMED'));
  }

  for (const legacy of toArray(input.legacyRecords)) {
    const mapped = remapLegacy332Record(legacy);
    if (!mapped.suppresses) {
      continue;
    }
    if (
      mapped.intentClass === tuple.intentClass &&
      mapped.cycleKey === tuple.cycleKey &&
      mapped.workerTarget === tuple.workerTarget
    ) {
      return suppress('legacy_record', tuple, input, storeId, 'SENT');
    }
  }

  const cycleState = input.cycleState ?? {};
  const repoId = String(cycleState.repoId ?? input.repoId ?? 'orchestrator-pack');
  const owner = getOwnerCycleRecord(cycleState, repoId, tuple.prNumber, tuple.targetId);
  if (tuple.intentClass === 'ci-green-handoff' && owner?.nudgeArmed) {
    return suppress('already_nudged_this_cycle', tuple, input, storeId, 'SENT');
  }

  const legacyNudged = input.legacyNudged ?? {};
  const bootstrapped = bootstrapLegacyNudgedCycle(cycleState, legacyNudged, tuple.prNumber, tuple.targetId);
  const bootOwner = getOwnerCycleRecord(bootstrapped, repoId, tuple.prNumber, tuple.targetId);
  if (tuple.intentClass === 'ci-green-handoff' && bootOwner?.nudgeArmed && !owner?.nudgeArmed) {
    return suppress('legacy_nudged_cycle', tuple, input, storeId, 'SENT');
  }

  if (input.stateUnreadable) {
    const bounds = resolveUnresolvedEscalationBounds(input);
    const unresolvedCount = Number(input.unresolvedCount ?? 0) + 1;
    const escalate =
      unresolvedCount >= bounds.count ||
      Number(input.unresolvedSinceMs ?? 0) + bounds.ms <= Number(input.nowMs ?? Date.now());
    return {
      allow: false,
      decision: 'SUPPRESS',
      reason: escalate ? 'unresolved_escalate' : 'unresolved_fail_closed',
      failClosed: true,
      escalate,
      unresolvedCount,
      audit: buildAuditRecord({
        prNumber: tuple.prNumber,
        logicalWorkerId: tuple.targetId,
        sessionGeneration: tuple.targetGeneration,
        rawSessionId: input.sessionId ?? tuple.targetId,
        targetResolutionSource: input.targetResolutionSource ?? 'session',
        surface: input.surface ?? input.source ?? 'unknown',
        cycleKey: tuple.cycleKey,
        intentClass: tuple.intentClass,
        storeId,
        decision: 'SUPPRESS',
        reason: escalate ? 'unresolved_escalate' : 'unresolved_fail_closed',
        claimPhase: 'none',
        sendTarget: input.sessionId ?? tuple.targetId,
      }),
    };
  }

  return {
    allow: true,
    decision: 'SEND',
    reason: 'gate_allow',
    tuple,
    audit: buildAuditRecord({
      prNumber: tuple.prNumber,
      logicalWorkerId: tuple.targetId,
      sessionGeneration: tuple.targetGeneration,
      rawSessionId: input.sessionId ?? tuple.targetId,
      targetResolutionSource: input.targetResolutionSource ?? 'session',
      surface: input.surface ?? input.source ?? 'unknown',
      cycleKey: tuple.cycleKey,
      intentClass: tuple.intentClass,
      storeId,
      decision: 'SEND',
      reason: 'gate_allow',
      claimPhase: 'CLAIMED',
      sendTarget: input.sessionId ?? tuple.targetId,
    }),
  };
}

/**
 * @param {string} reason
 * @param {object} tuple
 * @param {object} input
 * @param {string} storeId
 * @param {string} claimPhase
 */
function suppress(reason, tuple, input, storeId, claimPhase) {
  return {
    allow: false,
    decision: 'SUPPRESS',
    reason,
    tuple,
    audit: buildAuditRecord({
      prNumber: tuple.prNumber,
      logicalWorkerId: tuple.targetId,
      sessionGeneration: tuple.targetGeneration,
      rawSessionId: input.sessionId ?? tuple.targetId,
      targetResolutionSource: input.targetResolutionSource ?? 'session',
      surface: input.surface ?? input.source ?? 'unknown',
      cycleKey: tuple.cycleKey,
      intentClass: tuple.intentClass,
      storeId,
      decision: 'SUPPRESS',
      reason,
      claimPhase,
      sendTarget: input.sessionId ?? tuple.targetId,
    }),
  };
}

/**
 * @param {object} input
 */
export function acquireClaim(input) {
  const gate = evaluateNudgeGate(input);
  if (!gate.allow) {
    return {
      acquired: false,
      reason: gate.reason,
      decision: gate.decision,
      audit: gate.audit,
    };
  }
  const tuple = gate.tuple ?? buildTupleKey(input);
  const claimId = String(input.claimId ?? createHash('sha256').update(`${tuple.tupleKey}:${Date.now()}`).digest('hex').slice(0, 16));
  const leaseMs = Math.max(1, Number(input.claimLeaseMs ?? 120_000));
  const nowMs = Number(input.nowMs ?? Date.now());
  return {
    acquired: true,
    reason: 'acquired',
    claimId,
    phase: 'CLAIMED',
    tuple,
    claimLeaseExpiresAtMs: nowMs + leaseMs,
    audit: gate.audit,
  };
}

/**
 * @param {object} input
 */
export function finalizeClaim(input) {
  const phase = String(input.phase ?? input.outcome ?? '').trim().toUpperCase();
  if (!['SENT', 'FAILED_DEFINITIVE', 'UNCERTAIN', 'SEND_ATTEMPTED'].includes(phase)) {
    return { ok: false, reason: 'invalid_finalize_phase', phase };
  }
  if (phase === 'FAILED_DEFINITIVE') {
    return { ok: true, phase, retryable: true, reason: 'failed_definitive' };
  }
  if (phase === 'UNCERTAIN') {
    return { ok: true, phase, retryable: false, escalate: true, reason: 'uncertain_delivery' };
  }
  if (phase === 'SEND_ATTEMPTED') {
    return { ok: true, phase, retryable: false, reason: 'send_attempted' };
  }
  return { ok: true, phase: 'SENT', retryable: false, reason: 'sent' };
}

/**
 * @param {string} commandLine
 */
export function containsRawWorkerSendInvocation(commandLine) {
  return /\bao\s+send\b/i.test(String(commandLine ?? ''));
}

/**
 * @param {string} commandLine
 */
export function isGatedWorkerNudgeParentCommandLine(commandLine) {
  const line = String(commandLine ?? '');
  return /invoke-gated-worker-nudge\.ps1/i.test(line) || /journaled-worker-send\.ps1/i.test(line);
}

/**
 * @param {object} input
 */
export function evaluateBoundary(input) {
  if (!input.autonomousSurface) {
    return { allowed: true, reason: 'manual_surface' };
  }
  if (input.claimedBypass) {
    return { allowed: true, reason: 'gated_bypass' };
  }
  if (containsRawWorkerSendInvocation(input.commandLine) && !isGatedWorkerNudgeParentCommandLine(input.commandLine)) {
    return { allowed: false, reason: 'autonomous_raw_worker_send_denied' };
  }
  return { allowed: true, reason: 'not_raw_worker_send' };
}

/**
 * @param {string[]} commandLines
 */
export function findForbiddenAutonomousWorkerSendInvocations(commandLines) {
  return toArray(commandLines)
    .map((commandLine) => ({
      commandLine,
      verdict: evaluateBoundary({ commandLine, autonomousSurface: true, claimedBypass: false }),
    }))
    .filter((entry) => !entry.verdict.allowed);
}

/**
 * @param {object} input
 */
export function evaluatePreflight(input) {
  if (input.loadedGateVersion !== WORKER_NUDGE_GATE_VERSION) {
    return {
      ok: false,
      reason: 'gate_preflight_stale_or_missing',
      auditShape: 'preflight_refusal',
      markerState: String(input.loadedGateVersion ?? ''),
    };
  }
  if (input.atomicClaimPresent === false) {
    return {
      ok: false,
      reason: 'atomic_claim_capability_missing',
      auditShape: 'preflight_refusal',
      markerState: ATOMIC_WORKER_NUDGE_CLAIM_CAPABILITY,
    };
  }
  for (const capability of toArray(input.liveCapabilities)) {
    const classification = String(capability?.classification ?? '').toLowerCase();
    if (!classification || (classification !== 'gated' && classification !== 'unavailable')) {
      return {
        ok: false,
        reason: 'live_capability_unclassified',
        auditShape: 'preflight_refusal',
        markerState: String(capability?.id ?? ''),
      };
    }
  }
  const raw = toArray(input.liveCapabilities).find((row) => row.id === 'ao-worker-send-raw');
  if (raw && String(raw.classification).toLowerCase() !== 'unavailable') {
    return {
      ok: false,
      reason: 'raw_worker_send_not_unavailable',
      auditShape: 'preflight_refusal',
      markerState: 'ao-worker-send-raw',
    };
  }
  return { ok: true, reason: 'gate_preflight_ok', auditShape: 'none' };
}

/**
 * @param {string} [inventoryPath]
 */
export function loadAutonomousWorkerNudgeCapabilities(inventoryPath) {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const resolved =
    inventoryPath ?? path.join(repoRoot, 'docs/autonomous-worker-nudge-capabilities.json');
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

/**
 * @param {object} input
 */
export function validateCapabilityInventory(input) {
  const repoIds = new Set(toArray(input.repoInventory).map((row) => String(row.id)));
  const violations = [];
  for (const row of toArray(input.repoInventory)) {
    const classification = String(row.classification ?? '');
    if (classification !== 'gated' && classification !== 'unavailable') {
      violations.push(`unclassified repo capability: ${row.id}`);
    }
  }
  for (const live of toArray(input.liveSurfaces)) {
    const id = String(live.id ?? '');
    if (!repoIds.has(id)) {
      violations.push(`live capability missing from repo inventory: ${id}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * @param {object} input
 */
export function evaluateAdoptionGate(input) {
  const gatedCommandPresent = Boolean(input.gatedCommandPresent);
  const rawDenied = Boolean(input.rawWorkerSendDenied);
  const ok = gatedCommandPresent && rawDenied;
  return {
    ok,
    nudgeSurfaceEnabled: ok,
    degraded: !ok,
    gatedCommandPresent,
    rawWorkerSendDenied: rawDenied,
    errors: ok
      ? []
      : [
          ...(gatedCommandPresent ? [] : ['orchestratorRules missing invoke-gated-worker-nudge.ps1']),
          ...(rawDenied ? [] : ['raw ao send not denied at process boundary']),
        ],
  };
}

runStdinJsonCli('worker-nudge-gate.mjs', {
  evaluateNudgeGate: () => evaluateNudgeGate(readStdinJson()),
  acquireClaim: () => acquireClaim(readStdinJson()),
  finalizeClaim: () => finalizeClaim(readStdinJson()),
  evaluateBoundary: () => evaluateBoundary(readStdinJson()),
  evaluatePreflight: () => evaluatePreflight(readStdinJson()),
  evaluateAdoption: () => evaluateAdoptionGate(readStdinJson()),
  classifyIntent: () => {
    const input = readStdinJson();
    return { intentClass: classifyIntent(input) };
  },
  deriveCycleKey: () => {
    const input = readStdinJson();
    const intentClass = classifyIntent(input);
    return { intentClass, cycleKey: deriveCycleKey(intentClass, input) };
  },
  canonicalizeStorePath: () => {
    const input = readStdinJson();
    const storePath = String(input.storePath ?? '');
    return {
      canonicalPath: canonicalizeStorePath(storePath),
      storeId: canonicalStoreId(storePath),
    };
  },
  remapLegacy332: () => remapLegacy332Record(readStdinJson()),
});
