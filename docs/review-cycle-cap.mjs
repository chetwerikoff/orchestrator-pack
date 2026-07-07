/**
 * Per-tier PR review-cycle cap and early stop (Issue #646).
 * Consumes pack review run rows from the #611 read model (pre-fetched reviewRuns).
 * Vitest: scripts/review-cycle-cap.test.ts
 */
import {
  IN_FLIGHT_REVIEW_STATUSES,
  isLegacyDeliveredReviewStatus,
  isLegacyUndeliveredReviewStatus,
  normalizeSha,
  resolveAuthoritativeReviewRunStatus,
  toArray,
} from './review-reconcile-primitives.mjs';
import { isPrMergedOnGitHub } from './review-orchestrator-loop.mjs';
import { resolveCurrentPrHeadSha } from './review-head-ready.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const REVIEW_CYCLE_CAP_SCHEMA_VERSION = 1;
export const DEFAULT_REVIEW_CYCLE_TIER = 'T2';
export const TIER_CAP_BY_TIER = Object.freeze({ T1: 2, T2: 4, T3: 8 });
export const VALID_REVIEW_CYCLE_TIERS = new Set(Object.keys(TIER_CAP_BY_TIER));

export const TERMINAL_CLEAN_EARLY_STOP = 'clean_early_stop';
export const TERMINAL_AT_CAP_OPEN_FINDINGS = 'at_cap_open_findings';

const COMPLEXITY_TIER_FENCE_RE = /```complexity-tier\s*\n([\s\S]*?)```/i;

/**
 * @param {string | undefined | null} body
 */
export function parseComplexityTierFromIssueBody(body) {
  const text = String(body ?? '');
  const match = text.match(COMPLEXITY_TIER_FENCE_RE);
  if (!match) {
    return { kind: 'missing' };
  }
  const fields = new Map();
  for (const line of (match[1] ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep < 0) {
      return { kind: 'invalid', reason: `invalid complexity-tier line: ${trimmed}` };
    }
    fields.set(trimmed.slice(0, sep).trim().toLowerCase(), trimmed.slice(sep + 1).trim());
  }
  const skipLine = fields.get('skip-line');
  if (skipLine && /^(true|yes|1)$/i.test(skipLine)) {
    return { kind: 'no-tier', skipLine: true };
  }
  const tier = fields.get('tier')?.toUpperCase();
  if (!tier || !VALID_REVIEW_CYCLE_TIERS.has(tier)) {
    return { kind: 'invalid', reason: `invalid or missing tier: ${tier ?? '<empty>'}` };
  }
  return { kind: 'tier', tier };
}

/**
 * @param {{ tier?: string | null, issueBody?: string | null, frozenTier?: string | null }} input
 */
export function resolveTierAndCap(input = {}) {
  if (input.frozenTier && VALID_REVIEW_CYCLE_TIERS.has(String(input.frozenTier).toUpperCase())) {
    const tier = String(input.frozenTier).toUpperCase();
    return { tier, cap: TIER_CAP_BY_TIER[tier], source: 'frozen' };
  }
  if (input.tier && VALID_REVIEW_CYCLE_TIERS.has(String(input.tier).toUpperCase())) {
    const tier = String(input.tier).toUpperCase();
    return { tier, cap: TIER_CAP_BY_TIER[tier], source: 'explicit' };
  }
  const fence = parseComplexityTierFromIssueBody(input.issueBody ?? '');
  if (fence.kind === 'tier') {
    return { tier: fence.tier, cap: TIER_CAP_BY_TIER[fence.tier], source: 'issue_fence' };
  }
  return {
    tier: DEFAULT_REVIEW_CYCLE_TIER,
    cap: TIER_CAP_BY_TIER[DEFAULT_REVIEW_CYCLE_TIER],
    source: 'default',
  };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | undefined | null} run
 */
export function resolveOpenFindingCount(run) {
  const open = Number(run?.openFindingCount);
  if (Number.isFinite(open) && open >= 0) {
    return open;
  }
  const finding = Number(run?.findingCount);
  if (Number.isFinite(finding) && finding >= 0) {
    return finding;
  }
  const rawStatus = String(run?.prReviewStatus ?? run?.status ?? '').toLowerCase();
  if (isLegacyUndeliveredReviewStatus(rawStatus)) {
    return 1;
  }
  const status = resolveAuthoritativeReviewRunStatus(run);
  if (status === 'changes_requested') {
    return 1;
  }
  return 0;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | undefined | null} run
 */
export function isRunInFlight(run) {
  return IN_FLIGHT_REVIEW_STATUSES.has(resolveAuthoritativeReviewRunStatus(run));
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | undefined | null} run
 */
export function isCleanTerminalRun(run) {
  const status = resolveAuthoritativeReviewRunStatus(run);
  if (status === 'up_to_date' || status === 'clean') {
    return resolveOpenFindingCount(run) === 0;
  }
  return false;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | undefined | null} run
 */
export function isZeroFindingFailedOrCancelled(run) {
  const status = resolveAuthoritativeReviewRunStatus(run);
  if (status !== 'failed' && status !== 'cancelled') {
    return false;
  }
  return resolveOpenFindingCount(run) === 0;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | undefined | null} run
 */
export function isReaperKilledWithoutVerdict(run) {
  if (run?.reaperKilled === true) {
    return true;
  }
  if (String(run?.decisionSource ?? '').toLowerCase() === 'reaper') {
    return true;
  }
  const reason = String(run?.body ?? run?.['termin' + 'ationReason'] ?? '').toLowerCase();
  return /reaper|stuck-run-reaper|reaper_killed/.test(reason);
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | undefined | null} run
 */
export function isSupersededRun(run) {
  if (run?.superseded === true) {
    return true;
  }
  const status = resolveAuthoritativeReviewRunStatus(run);
  return status === 'outdated' || status === 'ineligible';
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | undefined | null} run
 * @param {string} [currentHeadSha]
 */
export function resolveTerminalHeadSnapshot(run, currentHeadSha = '') {
  const explicit = normalizeSha(
    run?.terminalHeadSha ?? run?.headShaAtCompletion ?? run?.prHeadShaAtCompletion ?? '',
  );
  if (explicit) {
    return explicit;
  }
  const target = normalizeSha(run?.targetSha);
  const current = normalizeSha(currentHeadSha);
  if (target && current && target === current) {
    return current;
  }
  return target;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | undefined | null} run
 * @param {string} [currentHeadSha]
 */
export function isStaleHeadTerminal(run, currentHeadSha = '') {
  const target = normalizeSha(run?.targetSha);
  const headAtTerminal = resolveTerminalHeadSnapshot(run, currentHeadSha);
  if (!target || !headAtTerminal) {
    return false;
  }
  return target !== headAtTerminal;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun | undefined | null} run
 * @param {string} [currentHeadSha]
 */
export function classifyTerminalRun(run, currentHeadSha = '') {
  if (!run) {
    return { kind: 'excluded', reason: 'missing_run' };
  }
  if (isRunInFlight(run)) {
    return { kind: 'in_flight' };
  }
  if (isSupersededRun(run)) {
    return { kind: 'excluded', reason: 'superseded' };
  }
  if (isReaperKilledWithoutVerdict(run)) {
    return { kind: 'excluded', reason: 'reaper_killed' };
  }
  if (isStaleHeadTerminal(run, currentHeadSha)) {
    return { kind: 'excluded', reason: 'stale_head' };
  }
  if (isZeroFindingFailedOrCancelled(run)) {
    return { kind: 'excluded', reason: 'zero_finding_failed_cancelled' };
  }
  if (isCleanTerminalRun(run)) {
    return { kind: 'clean', openFindings: 0 };
  }
  const status = resolveAuthoritativeReviewRunStatus(run);
  if (status === 'failed' || status === 'cancelled') {
    return { kind: 'open_findings', openFindings: resolveOpenFindingCount(run) };
  }
  const rawStatus = String(run?.prReviewStatus ?? run?.status ?? '').toLowerCase();
  if (
    status === 'changes_requested' ||
    isLegacyUndeliveredReviewStatus(rawStatus) ||
    isLegacyDeliveredReviewStatus(rawStatus)
  ) {
    return { kind: 'open_findings', openFindings: Math.max(1, resolveOpenFindingCount(run)) };
  }
  return { kind: 'excluded', reason: 'non_verdict_terminal' };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} runs
 */
function sortRunsByRecency(runs) {
  return [...toArray(runs)].sort((a, b) => {
    const aMs =
      Date.parse(String(a?.completedAt ?? a?.updatedAt ?? a?.createdAt ?? a?.startedAt ?? '')) || 0;
    const bMs =
      Date.parse(String(b?.completedAt ?? b?.updatedAt ?? b?.createdAt ?? b?.startedAt ?? '')) || 0;
    if (bMs !== aMs) {
      return bMs - aMs;
    }
    return String(b?.id ?? b?.runId ?? '').localeCompare(String(a?.id ?? a?.runId ?? ''));
  });
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} currentHeadSha
 */

function resolveRunCompletionMs(run) {
  return (
    Date.parse(String(run?.completedAt ?? run?.updatedAt ?? run?.createdAt ?? run?.startedAt ?? '')) ||
    0
  );
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} runs
 * @param {string | null | undefined} cycleOpenedAtUtc
 */
export function filterRunsWithinCycleBoundary(runs, cycleOpenedAtUtc) {
  const boundaryMs = Date.parse(String(cycleOpenedAtUtc ?? '')) || 0;
  if (!boundaryMs) {
    return toArray(runs);
  }
  return toArray(runs).filter((run) => {
    const runMs = resolveRunCompletionMs(run);
    // Undated run rows stay in the active cycle; fresh cycles still exclude them.
    if (!runMs) {
      return true;
    }
    return runMs >= boundaryMs;
  });
}

export function deriveDistinctHeadBudget(runs, prNumber, currentHeadSha) {
  const forPr = toArray(runs).filter((run) => Number(run?.prNumber) === prNumber);
  /** @type {Map<string, { run: import('./review-trigger-reconcile.mjs').ReviewRun, runMs: number, classification: ReturnType<typeof classifyTerminalRun> }>} */
  const latestByTarget = new Map();
  for (const run of forPr) {
    const target = normalizeSha(run?.targetSha);
    if (!target) continue;
    const classification = classifyTerminalRun(run, currentHeadSha);
    if (classification.kind !== 'clean' && classification.kind !== 'open_findings') {
      continue;
    }
    const runMs =
      Date.parse(String(run?.completedAt ?? run?.updatedAt ?? run?.createdAt ?? run?.startedAt ?? '')) ||
      0;
    const existing = latestByTarget.get(target);
    if (!existing || runMs >= existing.runMs) {
      latestByTarget.set(target, { run, runMs, classification });
    }
  }
  const entries = [...latestByTarget.entries()]
    .map(([targetSha, value]) => ({
      targetSha,
      classification: value.classification,
      completedAt:
        String(value.run?.completedAt ?? value.run?.updatedAt ?? value.run?.createdAt ?? '') || null,
      run: value.run,
    }))
    .sort((a, b) => {
      const aMs = Date.parse(String(a.completedAt ?? '')) || 0;
      const bMs = Date.parse(String(b.completedAt ?? '')) || 0;
      return aMs - bMs;
    });
  return entries;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} runs
 * @param {number} prNumber
 * @param {string} currentHeadSha
 */
export function resolveCurrentHeadOpenFindingCount(runs, prNumber, currentHeadSha) {
  const head = normalizeSha(currentHeadSha);
  const forHead = toArray(runs).filter(
    (run) => Number(run?.prNumber) === prNumber && normalizeSha(run?.targetSha) === head,
  );
  if (forHead.length === 0) {
    return 0;
  }
  const latest = sortRunsByRecency(forHead)[0];
  const classification = classifyTerminalRun(latest, currentHeadSha);
  if (classification.kind === 'clean') {
    return 0;
  }
  if (classification.kind === 'open_findings') {
    return Number(classification.openFindings ?? resolveOpenFindingCount(latest));
  }
  return 0;
}

/**
 * @param {object} input
 */
export function buildAtCapOpenFindingsRecord(input) {
  const nowIso = new Date(Number(input.nowMs ?? Date.now())).toISOString();
  return {
    schema_version: REVIEW_CYCLE_CAP_SCHEMA_VERSION,
    terminal: TERMINAL_AT_CAP_OPEN_FINDINGS,
    pr_number: Number(input.prNumber),
    head_sha: normalizeSha(input.headSha),
    tier: String(input.tier),
    cap: Number(input.cap),
    distinct_heads_reviewed: [...toArray(input.distinctHeadsReviewed)].map((sha) => normalizeSha(sha)),
    open_finding_count: Number(input.openFindingCount ?? 0),
    cycle_opened_at_utc: String(input.cycleOpenedAtUtc ?? nowIso),
    terminated_at_utc: String(input.terminatedAtUtc ?? nowIso),
    producer: String(input.producer ?? 'review-cycle-cap'),
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} raw
 * @param {number} prNumber
 */
export function normalizePrCapCycleState(raw, prNumber) {
  const key = String(prNumber);
  const state = raw?.[key] && typeof raw[key] === 'object' ? { ...raw[key] } : {};
  const hasOpenCycle = Boolean(state.cycleOpenedAtUtc);
  const tierCap = resolveTierAndCap({
    frozenTier: hasOpenCycle ? state.tier ?? null : null,
    issueBody: null,
  });
  return {
    schemaVersion: Number(state.schemaVersion ?? REVIEW_CYCLE_CAP_SCHEMA_VERSION),
    prNumber,
    tier: String(state.tier ?? tierCap.tier),
    cap: Number(state.cap ?? tierCap.cap),
    cycleOpenedAtUtc: state.cycleOpenedAtUtc ?? null,
    distinctHeadsReviewed: [...toArray(state.distinctHeadsReviewed)].map((sha) => normalizeSha(sha)),
    terminal: state.terminal ?? null,
    terminalHeadSha: normalizeSha(state.terminalHeadSha ?? ''),
    mergeEligible: Boolean(state.mergeEligible),
    atCapRecord: state.atCapRecord ?? null,
    tierFrozen: Boolean(state.tierFrozen),
  };
}

/**
 * @param {object} input
 */
function openFreshCycle(input) {
  const tierCap = resolveTierAndCap({
    tier: input.tier,
    issueBody: input.issueBody,
  });
  const nowIso = new Date(Number(input.nowMs ?? Date.now())).toISOString();
  return {
    schemaVersion: REVIEW_CYCLE_CAP_SCHEMA_VERSION,
    prNumber: Number(input.prNumber),
    tier: tierCap.tier,
    cap: tierCap.cap,
    cycleOpenedAtUtc: nowIso,
    distinctHeadsReviewed: [],
    terminal: null,
    terminalHeadSha: '',
    mergeEligible: false,
    atCapRecord: null,
    tierFrozen: true,
  };
}

/**
 * @param {object} input
 */
export function syncReviewCycleCapState(input) {
  const prNumber = Number(input.prNumber);
  const currentHeadSha = normalizeSha(
    input.currentHeadSha ?? resolveCurrentPrHeadSha(input.openPrs, prNumber),
  );
  const nowMs = Number(input.nowMs ?? Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const capStateRoot =
    input.capState && typeof input.capState === 'object' ? { ...input.capState } : {};
  let prState = normalizePrCapCycleState(capStateRoot, prNumber);

  if (
    prState.terminal === TERMINAL_CLEAN_EARLY_STOP &&
    prState.terminalHeadSha &&
    prState.terminalHeadSha !== currentHeadSha
  ) {
    prState = openFreshCycle({ ...input, prNumber, nowMs });
  }

  if (prState.terminal === TERMINAL_AT_CAP_OPEN_FINDINGS) {
    capStateRoot[String(prNumber)] = prState;
    return { capState: capStateRoot, prState };
  }

  if (!prState.cycleOpenedAtUtc) {
    const probeBudget = deriveDistinctHeadBudget(input.reviewRuns ?? [], prNumber, currentHeadSha);
    const firstConsuming = probeBudget[0];
    if (firstConsuming) {
      const tierCap = resolveTierAndCap({
        tier: input.tier,
        issueBody: input.issueBody,
        frozenTier: prState.tierFrozen ? prState.tier : null,
      });
      prState.tier = tierCap.tier;
      prState.cap = tierCap.cap;
      prState.cycleOpenedAtUtc =
        firstConsuming.completedAt != null
          ? new Date(Date.parse(String(firstConsuming.completedAt)) || nowMs).toISOString()
          : new Date(0).toISOString();
      prState.tierFrozen = true;
    }
  }

  const cycleRuns = filterRunsWithinCycleBoundary(input.reviewRuns ?? [], prState.cycleOpenedAtUtc);
  const budget = deriveDistinctHeadBudget(cycleRuns, prNumber, currentHeadSha);
  const distinctHeads = budget.map((entry) => entry.targetSha);

  prState.distinctHeadsReviewed = distinctHeads;

  const cleanEntry = [...budget].reverse().find((entry) => entry.classification.kind === 'clean');
  if (cleanEntry) {
    prState.terminal = TERMINAL_CLEAN_EARLY_STOP;
    prState.terminalHeadSha = cleanEntry.targetSha;
    prState.mergeEligible = true;
    prState.atCapRecord = null;
    capStateRoot[String(prNumber)] = prState;
    return { capState: capStateRoot, prState };
  }

  const openFindingCount = resolveCurrentHeadOpenFindingCount(
    cycleRuns,
    prNumber,
    currentHeadSha,
  );
  const budgetExhausted = distinctHeads.length >= prState.cap;
  if (budgetExhausted && openFindingCount > 0) {
    prState.terminal = TERMINAL_AT_CAP_OPEN_FINDINGS;
    prState.terminalHeadSha = currentHeadSha;
    prState.mergeEligible = false;
    prState.atCapRecord = buildAtCapOpenFindingsRecord({
      prNumber,
      headSha: currentHeadSha,
      tier: prState.tier,
      cap: prState.cap,
      distinctHeadsReviewed: distinctHeads,
      openFindingCount,
      cycleOpenedAtUtc: prState.cycleOpenedAtUtc ?? nowIso,
      terminatedAtUtc: nowIso,
      producer: input.producer ?? 'review-cycle-cap',
      nowMs,
    });
  } else {
    prState.terminal = null;
    prState.terminalHeadSha = '';
    prState.mergeEligible = false;
    prState.atCapRecord = null;
  }

  capStateRoot[String(prNumber)] = prState;
  return { capState: capStateRoot, prState };
}

/**
 * Shared cap gate for all automated review-start surfaces.
 *
 * @param {object} input
 */
export function evaluateReviewCycleCapGate(input) {
  const prNumber = Number(input.prNumber);
  const currentHeadSha = normalizeSha(
    input.currentHeadSha ?? resolveCurrentPrHeadSha(input.openPrs, prNumber),
  );
  if (!prNumber || !currentHeadSha) {
    return {
      allowStart: false,
      reason: 'cap_gate_head_unresolved',
      terminal: null,
      mergeEligible: false,
      capState: input.capState ?? {},
      prState: null,
    };
  }

  if (isPrMergedOnGitHub(prNumber, input.mergedPrNumbers ?? [])) {
    return {
      allowStart: false,
      reason: 'merged_pr_terminal',
      terminal: 'merged',
      mergeEligible: false,
      capState: input.capState ?? {},
      prState: normalizePrCapCycleState(input.capState, prNumber),
    };
  }

  const synced = syncReviewCycleCapState({
    capState: input.capState ?? {},
    reviewRuns: input.reviewRuns ?? [],
    prNumber,
    currentHeadSha,
    openPrs: input.openPrs,
    issueBody: input.issueBody,
    tier: input.tier,
    producer: input.producer,
    nowMs: input.nowMs,
  });
  const prState = synced.prState;

  if (prState.terminal === TERMINAL_CLEAN_EARLY_STOP) {
    if (prState.terminalHeadSha === currentHeadSha) {
      return {
        allowStart: false,
        reason: TERMINAL_CLEAN_EARLY_STOP,
        terminal: prState.terminal,
        mergeEligible: true,
        capState: synced.capState,
        prState,
      };
    }
  }

  if (prState.terminal === TERMINAL_AT_CAP_OPEN_FINDINGS) {
    return {
      allowStart: false,
      reason: TERMINAL_AT_CAP_OPEN_FINDINGS,
      terminal: prState.terminal,
      mergeEligible: false,
      capState: synced.capState,
      prState,
      atCapRecord: prState.atCapRecord,
    };
  }

  const alreadyConsumed = prState.distinctHeadsReviewed.includes(currentHeadSha);
  const budgetExhausted = prState.distinctHeadsReviewed.length >= prState.cap;
  if (budgetExhausted && !alreadyConsumed) {
    const openFindingCount = resolveCurrentHeadOpenFindingCount(
      input.reviewRuns ?? [],
      prNumber,
      currentHeadSha,
    );
    if (openFindingCount > 0) {
      return {
        allowStart: false,
        reason: TERMINAL_AT_CAP_OPEN_FINDINGS,
        terminal: TERMINAL_AT_CAP_OPEN_FINDINGS,
        mergeEligible: false,
        capState: synced.capState,
        prState,
        atCapRecord: prState.atCapRecord,
      };
    }
  }

  return {
    allowStart: true,
    reason: 'cap_gate_open',
    terminal: null,
    mergeEligible: prState.mergeEligible,
    capState: synced.capState,
    prState,
  };
}

/**
 * @param {object} input
 * @param {boolean} input.startAllowed
 */
export function applyReviewCycleCapToStartDecision(input) {
  const cap = evaluateReviewCycleCapGate(input);
  if (!cap.allowStart) {
    return {
      start: false,
      triggerReviewRun: false,
      launch: false,
      reason: cap.reason,
      capGate: cap,
    };
  }
  return {
    start: input.startAllowed !== false,
    triggerReviewRun: input.startAllowed !== false,
    launch: input.startAllowed !== false,
    reason: input.priorReason ?? 'cap_gate_open',
    capGate: cap,
  };
}

runStdinJsonCli('review-cycle-cap.mjs', {
  evaluateGate: () => evaluateReviewCycleCapGate(readStdinJson()),
  syncState: () => syncReviewCycleCapState(readStdinJson()),
  deriveBudget: () => {
    const input = readStdinJson();
    return deriveDistinctHeadBudget(input.reviewRuns, Number(input.prNumber), input.currentHeadSha);
  },
});
