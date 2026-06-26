/**
 * Orchestrator review-pipeline aggregate spawn budget (Issue #480).
 * Vitest: scripts/review-pipeline-spawn-budget.test.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadPackSpawnBudgetManifest } from './spawn-budget-manifest-loader.mjs';
import { readStdinJson } from './review-mechanical-cli.mjs';

export const REVIEW_PIPELINE_SPAWN_BUDGET_VERSION = 'review-pipeline-spawn-budget/v1';
export const REVIEW_PIPELINE_SPAWN_CAPTURE_VERSION = 'review-pipeline-spawn-capture/v1';
export const REVIEW_PIPELINE_SPAWN_BUDGET_RELATIVE_PATH = 'docs/review-pipeline-spawn-budget.json';

/** @type {readonly string[]} */
export const REQUIRED_SOURCE_CLASSES = Object.freeze([
  'supervisor-child',
  'llm-orchestrator-review-start',
  'worker-test-suite',
  'autonomous-guard',
  'unknown',
]);

const SUPERVISOR_CHILD_PATTERNS = [
  /orchestrator-wake-listener\.ps1/i,
  /orchestrator-wake-heartbeat\.ps1/i,
  /review-trigger-reconcile\.ps1/i,
  /review-trigger-reeval\.ps1/i,
  /review-ready-report-state-seed\.ps1/i,
  /ci-green-wake-reconcile\.ps1/i,
  /review-send-reconcile\.ps1/i,
  /review-finding-delivery-confirm\.ps1/i,
  /worker-message-submit-reconcile\.ps1/i,
  /review-run-recovery\.ps1/i,
  /review-start-claim-reaper\.ps1/i,
  /ci-failure-notification-reconcile\.ps1/i,
  /ci-failure-notification-reaction\.ps1/i,
  /orchestrator-wake-supervisor\.ps1/i,
];

const LLM_REVIEW_START_PATTERNS = [
  /invoke-orchestrator-claimed-review-run\.ps1/i,
  /\bao\s+review\s+run\b/i,
  /Invoke-OrchestratorClaimedReviewRun/i,
];

const WORKER_TEST_PATTERNS = [
  /\bvitest\b/i,
  /\bnpm\s+test\b/i,
  /\bpnpm\s+test\b/i,
  /worktrees\/opk-/i,
  /_test-.*fixture/i,
  /\bnpx\s+vitest\b/i,
];

const AUTONOMOUS_GUARD_PATTERNS = [
  /ao-autonomous-guard\.ps1/i,
  /git-autonomous-guard\.ps1/i,
  /^pwsh-guard:/i,
  /autonomous-guard-fast-path/i,
  /Orchestrator-AutonomousSpawnGate/i,
];

const SUPERVISOR_READ_PATTERNS = [
  /^git\s+(config|log|branch|status)\b/i,
  /^ao\s+(status|review\s+list)\b/i,
];

/**
 * @param {string} commandLine
 * @param {{ childId?: string, sourceHint?: string }} [hints]
 */
export function attributeSpawnSourceClass(commandLine, hints = {}) {
  const line = String(commandLine ?? '').trim();
  const hint = String(hints.sourceHint ?? hints.childId ?? '').trim().toLowerCase();

  if (hint && SUPERVISOR_CHILD_PATTERNS.some((re) => re.test(hint))) {
    return 'supervisor-child';
  }
  if (hint && LLM_REVIEW_START_PATTERNS.some((re) => re.test(hint))) {
    return 'llm-orchestrator-review-start';
  }
  if (hint && WORKER_TEST_PATTERNS.some((re) => re.test(hint))) {
    return 'worker-test-suite';
  }
  if (hint && AUTONOMOUS_GUARD_PATTERNS.some((re) => re.test(hint))) {
    return 'autonomous-guard';
  }

  if (LLM_REVIEW_START_PATTERNS.some((re) => re.test(line))) {
    return 'llm-orchestrator-review-start';
  }
  if (SUPERVISOR_CHILD_PATTERNS.some((re) => re.test(line))) {
    return 'supervisor-child';
  }
  if (SUPERVISOR_READ_PATTERNS.some((re) => re.test(line))) {
    return 'supervisor-child';
  }
  if (WORKER_TEST_PATTERNS.some((re) => re.test(line))) {
    return 'worker-test-suite';
  }
  if (AUTONOMOUS_GUARD_PATTERNS.some((re) => re.test(line))) {
    return 'autonomous-guard';
  }
  return 'unknown';
}

/**
 * @param {unknown} budget
 */
export function validateReviewPipelineSpawnBudget(budget) {
  if (!budget || typeof budget !== 'object') {
    return { ok: false, reason: 'spawn_budget_missing_or_unreadable' };
  }
  const version = String(/** @type {{ version?: string }} */ (budget).version ?? '');
  if (version !== REVIEW_PIPELINE_SPAWN_BUDGET_VERSION) {
    return { ok: false, reason: 'spawn_budget_unknown_version' };
  }
  const classes = /** @type {{ sourceClasses?: unknown }} */ (budget).sourceClasses;
  if (!Array.isArray(classes)) {
    return { ok: false, reason: 'spawn_budget_missing_source_classes' };
  }
  for (const required of REQUIRED_SOURCE_CLASSES) {
    if (!classes.includes(required)) {
      return { ok: false, reason: `spawn_budget_missing_source_class_${required}` };
    }
  }
  return { ok: true, reason: 'spawn_budget_ok' };
}

/**
 * @param {string} packRoot
 */
export function loadReviewPipelineSpawnBudget(packRoot) {
  return loadPackSpawnBudgetManifest(
    packRoot,
    REVIEW_PIPELINE_SPAWN_BUDGET_RELATIVE_PATH,
    validateReviewPipelineSpawnBudget,
    { okReason: 'spawn_budget_ok' },
  );
}

/**
 * @param {unknown} capture
 */
export function validateSpawnCapture(capture) {
  if (!capture || typeof capture !== 'object') {
    return { ok: false, reason: 'capture_missing_or_unreadable' };
  }
  const version = String(/** @type {{ version?: string }} */ (capture).version ?? '');
  if (version !== REVIEW_PIPELINE_SPAWN_CAPTURE_VERSION) {
    return { ok: false, reason: 'capture_unknown_version' };
  }
  const caseId = String(/** @type {{ caseId?: string }} */ (capture).caseId ?? '');
  if (!caseId) {
    return { ok: false, reason: 'capture_missing_case_id' };
  }
  const events = /** @type {{ events?: unknown }} */ (capture).events;
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: 'capture_missing_events' };
  }
  const window = /** @type {{ window?: Record<string, unknown> }} */ (capture).window;
  if (!window || typeof window !== 'object') {
    return { ok: false, reason: 'capture_missing_window' };
  }
  if (typeof window.elapsedMs !== 'number' || window.elapsedMs <= 0) {
    return { ok: false, reason: 'capture_missing_elapsed_window' };
  }
  if (typeof window.callerCadencePerMinute !== 'number' || window.callerCadencePerMinute <= 0) {
    return { ok: false, reason: 'capture_missing_caller_cadence' };
  }
  return { ok: true, reason: 'capture_ok', caseId };
}

const JOURNAL_RATE_MACHINE_PATH_RE =
  /(?:^|\s)(?:\/(?:home|tmp|var|Users)\/|\b[A-Z]:\\)|worktrees\/opk-\d+/i;

/**
 * Fail-closed journal/rate attribution evidence for committed captures (Issue #480 AC#1).
 * @param {unknown} capture
 */
export function validateJournalRateAttribution(capture) {
  const validated = validateSpawnCapture(capture);
  if (!validated.ok) {
    return validated;
  }

  const cap = /** @type {Record<string, any>} */ (capture);
  const events = /** @type {Array<Record<string, unknown>>} */ (cap.events ?? []);
  const elapsedMs = Number(cap.window?.elapsedMs ?? 0);
  const measurementModel = String(cap.measurementModel ?? cap.captureProvenance?.measurementModel ?? '');
  if (measurementModel !== 'journal-rate-attribution') {
    return { ok: false, reason: 'journal_rate_missing_measurement_model' };
  }

  for (const event of events) {
    if (typeof event.atMs !== 'number' || !Number.isFinite(event.atMs)) {
      return { ok: false, reason: 'journal_rate_missing_event_timestamps' };
    }
    const commandLine = String(event.commandLine ?? '');
    if (JOURNAL_RATE_MACHINE_PATH_RE.test(commandLine)) {
      return { ok: false, reason: 'journal_rate_machine_specific_paths', commandLine };
    }
  }

  const subprocessScriptEvents = events.filter((event) =>
    /^pwsh -NoProfile -File scripts\//.test(String(event.commandLine ?? '')),
  );
  const subprocessInvocationCount = Number(cap.captureProvenance?.subprocessInvocationCount ?? 0);
  if (subprocessScriptEvents.length < 1) {
    return { ok: false, reason: 'journal_rate_missing_subprocess_script_evidence' };
  }
  if (
    !Number.isFinite(subprocessInvocationCount) ||
    subprocessInvocationCount < subprocessScriptEvents.length
  ) {
    return { ok: false, reason: 'journal_rate_subprocess_count_mismatch' };
  }

  const observedRatePerMinute = (events.length / elapsedMs) * 60_000;
  if (!Number.isFinite(observedRatePerMinute) || observedRatePerMinute <= 0) {
    return { ok: false, reason: 'journal_rate_not_computable' };
  }

  const aggregation = aggregateSpawnEvents(events);
  const supervisorCount = Number(aggregation.bySource?.['supervisor-child'] ?? 0);
  const reviewStartCount = Number(aggregation.bySource?.['llm-orchestrator-review-start'] ?? 0);
  if (supervisorCount < 1 || reviewStartCount < 1) {
    return { ok: false, reason: 'journal_rate_insufficient_source_attribution' };
  }

  const unknownCount = Number(aggregation.bySource?.unknown ?? 0);
  if (events.length > 0 && unknownCount === events.length) {
    return { ok: false, reason: 'journal_rate_all_events_unknown' };
  }

  if (!cap.pointInTimePsSnapshot || typeof cap.pointInTimePsSnapshot !== 'object') {
    return { ok: false, reason: 'journal_rate_missing_supplementary_ps_snapshot' };
  }

  return {
    ok: true,
    reason: 'journal_rate_attribution_ok',
    observedRatePerMinute,
    subprocessInvocationCount: subprocessScriptEvents.length,
    bySource: aggregation.bySource,
  };
}


/**
 * @param {Array<{ commandLine?: string, sourceHint?: string, childId?: string, atMs?: number }>} events
 */
export function aggregateSpawnEvents(events) {
  /** @type {Record<string, number>} */
  const bySource = Object.fromEntries(REQUIRED_SOURCE_CLASSES.map((key) => [key, 0]));
  /** @type {Map<string, number>} */
  const commandCounts = new Map();

  for (const event of events) {
    const commandLine = String(event?.commandLine ?? event?.sourceHint ?? 'unknown');
    const sourceClass = attributeSpawnSourceClass(commandLine, {
      sourceHint: event?.sourceHint,
      childId: event?.childId,
    });
    bySource[sourceClass] = (bySource[sourceClass] ?? 0) + 1;
    const normalized = commandLine.replace(/\s+/g, ' ').trim().slice(0, 240);
    commandCounts.set(normalized, (commandCounts.get(normalized) ?? 0) + 1);
  }

  const topOffenders = [...commandCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([commandLine, count]) => ({ commandLine, count }));

  const totalProcessCount = events.length;
  const nontrivialUnknown = bySource.unknown ?? 0;
  const nontrivialTotal =
    totalProcessCount - (bySource.unknown ?? 0) + (nontrivialUnknown > 0 ? 0 : 0);

  return {
    totalProcessCount,
    bySource,
    topOffenders,
    nontrivialNonUnknownCount: totalProcessCount - nontrivialUnknown,
  };
}

/**
 * @param {Record<string, number>} bySource
 * @param {number} totalEvents
 */
export function measurePerStepCosts(bySource, totalEvents) {
  /** @type {Record<string, number>} */
  const measured = {};
  const denom = Math.max(1, totalEvents);
  for (const sourceClass of REQUIRED_SOURCE_CLASSES) {
    measured[sourceClass] = Number(((bySource[sourceClass] ?? 0) / denom).toFixed(6));
  }
  return measured;
}

/**
 * @param {object} input
 * @param {Record<string, number>} input.measuredPerStepCosts
 * @param {number} input.callerCadencePerMinute
 * @param {number} input.windowMinutes
 * @param {number} input.reductionFactor
 * @param {number} [input.perStepCostFloor]
 */
export function deriveReducedBudgetThreshold(input) {
  const floor = Number(input.perStepCostFloor ?? 1);
  const cadence = Number(input.callerCadencePerMinute ?? 0);
  const factor = Number(input.reductionFactor ?? 0.35);
  let rawPerMinute = 0;
  for (const sourceClass of REQUIRED_SOURCE_CLASSES) {
    const perStep = Math.max(floor, Number(input.measuredPerStepCosts?.[sourceClass] ?? 0));
    rawPerMinute += cadence * perStep;
  }
  const derivedBudgetThreshold = Math.max(1, Math.floor(rawPerMinute * factor));
  return { derivedBudgetThreshold, rawPreReduction: rawPerMinute, reductionFactor: factor };
}

/**
 * @param {unknown} capture
 * @param {Record<string, unknown>} budgetManifest
 */
export function buildSpawnBudgetReport(capture, budgetManifest) {
  const validated = validateSpawnCapture(capture);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }

  const cap = /** @type {Record<string, any>} */ (capture);
  const events = /** @type {Array<Record<string, unknown>>} */ (cap.events ?? []);
  const aggregation = aggregateSpawnEvents(events);
  const elapsedMs = Number(cap.window?.elapsedMs ?? 0);
  const windowMinutes = elapsedMs / 60_000;
  const callerCadencePerMinute = Number(
    cap.window?.callerCadencePerMinute ?? budgetManifest.callerCadencePerMinute ?? 12,
  );
  const measuredPerStepCosts = measurePerStepCosts(
    aggregation.bySource,
    aggregation.totalProcessCount,
  );
  const reductionFactor = Number(budgetManifest.reductionFactor ?? 0.35);
  const derived = deriveReducedBudgetThreshold({
    measuredPerStepCosts,
    callerCadencePerMinute,
    reductionFactor,
    perStepCostFloor: Number(budgetManifest.perStepCostFloor ?? 1),
  });

  const effectiveElapsedMs = Math.max(elapsedMs, 60_000);
  const observedRatePerMinute =
    effectiveElapsedMs > 0
      ? (aggregation.totalProcessCount / effectiveElapsedMs) * 60_000
      : aggregation.totalProcessCount;

  const psSnapshot = cap.pointInTimePsSnapshot ?? null;
  const psProcessCount =
    psSnapshot && typeof psSnapshot.processCount === 'number' ? psSnapshot.processCount : null;

  return {
    ok: true,
    caseId: String(cap.caseId),
    callerPath: String(cap.captureProvenance?.callerPath ?? 'unknown'),
    elapsedMs,
    effectiveElapsedMs,
    windowMinutes,
    callerCadencePerMinute,
    totalProcessCount: aggregation.totalProcessCount,
    bySource: aggregation.bySource,
    topOffenders: aggregation.topOffenders,
    measuredPerStepCosts,
    observedBaseline: aggregation.totalProcessCount,
    observedRatePerMinute,
    derivedBudgetThreshold: derived.derivedBudgetThreshold,
    reductionFactor: derived.reductionFactor,
    rawPreReduction: derived.rawPreReduction,
    pointInTimePsSnapshot: psSnapshot,
    psSnapshotMissesBurst:
      psProcessCount !== null && psProcessCount < aggregation.totalProcessCount,
    budgetBelowBaseline: derived.derivedBudgetThreshold < aggregation.totalProcessCount,
  };
}

/**
 * @param {ReturnType<typeof buildSpawnBudgetReport>} report
 */
export function evaluateSpawnBudgetReport(report) {
  if (!report?.ok) {
    return { ok: false, reason: report?.reason ?? 'report_invalid' };
  }
  for (const sourceClass of REQUIRED_SOURCE_CLASSES) {
    if (typeof report.bySource?.[sourceClass] !== 'number') {
      return { ok: false, reason: `missing_source_bucket_${sourceClass}` };
    }
  }
  const nontrivialTotal = Number(report.totalProcessCount ?? 0);
  const unknown = Number(report.bySource?.unknown ?? 0);
  if (nontrivialTotal > 0 && unknown === nontrivialTotal) {
    return { ok: false, reason: 'all_spawns_collapsed_into_unknown' };
  }
  const observedRatePerMinute = Number(report.observedRatePerMinute ?? 0);
  const overBudget = observedRatePerMinute > Number(report.derivedBudgetThreshold ?? 0);
  return {
    ok: !overBudget,
    reason: overBudget ? 'aggregate_budget_exceeded' : 'within_aggregate_budget',
    overBudget,
    observedRatePerMinute,
    totalProcessCount: nontrivialTotal,
    derivedBudgetThreshold: report.derivedBudgetThreshold,
  };
}

/**
 * @param {unknown} capture
 * @param {Record<string, unknown>} budgetManifest
 * @param {'storm-baseline' | 'reduced-post-change'} expectedCaseId
 */
export function replayCaptureBudgetCheck(capture, budgetManifest, expectedCaseId) {
  const validated = validateSpawnCapture(capture);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason, expectedCaseId };
  }
  if (validated.caseId !== expectedCaseId) {
    return { ok: false, reason: 'capture_case_id_mismatch', expectedCaseId, actual: validated.caseId };
  }

  const report = buildSpawnBudgetReport(capture, budgetManifest);
  if (!report.ok) {
    return { ok: false, reason: report.reason, expectedCaseId };
  }

  const journalRate = validateJournalRateAttribution(capture);
  if (!journalRate.ok) {
    return { ok: false, reason: journalRate.reason, expectedCaseId, journalRate };
  }

  const verdict = evaluateSpawnBudgetReport(report);
  const expectPass = expectedCaseId === String(budgetManifest.reducedPassCaseId ?? 'reduced-post-change');
  const expectFail = expectedCaseId === String(budgetManifest.stormBaselineCaseId ?? 'storm-baseline');

  if (expectPass && !verdict.ok) {
    return {
      ok: false,
      reason: 'reduced_capture_rejected_by_budget',
      expectedCaseId,
      report,
      verdict,
    };
  }
  if (expectFail && verdict.ok) {
    return {
      ok: false,
      reason: 'storm_capture_accepted_by_budget',
      expectedCaseId,
      report,
      verdict,
    };
  }

  return {
    ok: true,
    reason: expectPass ? 'reduced_capture_passes' : 'storm_capture_fails_as_expected',
    expectedCaseId,
    report,
    verdict,
  };
}

/**
 * @param {string} packRoot
 * @param {Record<string, unknown>} [budgetManifest]
 */
export function verifyCommittedCaptureReplays(packRoot, budgetManifest) {
  const manifest =
    budgetManifest ??
  loadReviewPipelineSpawnBudget(packRoot).budget ??
    null;
  if (!manifest) {
    return { ok: false, reason: 'spawn_budget_manifest_unavailable' };
  }

  const stormRel = String(
    /** @type {{ captures?: Record<string, string> }} */ (manifest).captures?.['storm-baseline'] ??
      'tests/external-output-references/review-pipeline-spawn-budget/storm-baseline.capture.json',
  );
  const reducedRel = String(
    /** @type {{ captures?: Record<string, string> }} */ (manifest).captures?.['reduced-post-change'] ??
      'tests/external-output-references/review-pipeline-spawn-budget/reduced-post-change.capture.json',
  );

  const stormPath = join(packRoot, stormRel);
  const reducedPath = join(packRoot, reducedRel);
  if (!existsSync(stormPath) || !existsSync(reducedPath)) {
    return { ok: false, reason: 'committed_captures_missing' };
  }

  const stormCapture = JSON.parse(readFileSync(stormPath, 'utf8'));
  const reducedCapture = JSON.parse(readFileSync(reducedPath, 'utf8'));

  const stormJournal = validateJournalRateAttribution(stormCapture);
  if (!stormJournal.ok) {
    return { ok: false, reason: `storm_${stormJournal.reason}`, stormJournal };
  }
  const reducedJournal = validateJournalRateAttribution(reducedCapture);
  if (!reducedJournal.ok) {
    return { ok: false, reason: `reduced_${reducedJournal.reason}`, reducedJournal };
  }

  const storm = replayCaptureBudgetCheck(
    stormCapture,
    /** @type {Record<string, unknown>} */ (manifest),
    'storm-baseline',
  );
  const reduced = replayCaptureBudgetCheck(
    reducedCapture,
    /** @type {Record<string, unknown>} */ (manifest),
    'reduced-post-change',
  );

  if (!storm.ok || !reduced.ok) {
    return {
      ok: false,
      reason: !storm.ok ? storm.reason : reduced.reason,
      storm,
      reduced,
    };
  }

  const stormReport = storm.report;
  const reducedReport = reduced.report;
  if (!stormReport?.budgetBelowBaseline) {
    return { ok: false, reason: 'derived_budget_not_below_storm_baseline', storm, reduced };
  }
  if (Number(reducedReport?.derivedBudgetThreshold) >= Number(stormReport.observedRatePerMinute)) {
    return { ok: false, reason: 'reduced_threshold_not_below_storm_rate', storm, reduced };
  }

  return { ok: true, reason: 'capture_replays_ok', storm, reduced, stormJournal, reducedJournal };
}

/**
 * Verify journal/rate evidence is available on the host (live path only).
 * Committed captures must pass {@link validateJournalRateAttribution} regardless.
 * @param {{ journalCommand?: string, since?: string, unit?: string }} [options]
 */
export function collectLiveJournalSpawns(options = {}) {
  const journalCommand = options.journalCommand ?? 'journalctl';
  const since = options.since ?? '5 minutes ago';
  const unit = options.unit ?? '';
  if (process.platform !== 'linux') {
    return { ok: false, reason: 'unsupported-host', platform: process.platform };
  }
  try {
    const probe = spawnSync('which', [journalCommand], { encoding: 'utf8' });
    if (probe.status !== 0) {
      return { ok: false, reason: 'unsupported-host', detail: 'journalctl_missing' };
    }
    const args = ['--since', since, '--output', 'short-iso', '--no-pager'];
    if (unit) {
      args.push('-u', unit);
    }
    const sample = spawnSync(journalCommand, args, { encoding: 'utf8', timeout: 10_000 });
    if (sample.status !== 0) {
      return {
        ok: false,
        reason: 'journal_query_failed',
        detail: `${sample.stderr ?? ''}${sample.stdout ?? ''}`.trim().slice(0, 240),
      };
    }
    const lines = String(sample.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const execLines = lines.filter((line) => /\b(Started|spawn|EXEC|COMMAND=)\b/i.test(line));
    return {
      ok: true,
      reason: 'live_journal_rate_sample_ok',
      lineCount: lines.length,
      execLineCount: execLines.length,
      sampleWindow: since,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'unsupported-host',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const cliSubcommands = {
  attribute: () => {
    const input = readStdinJson();
    const sourceClass = attributeSpawnSourceClass(input.commandLine, input);
    return { sourceClass };
  },
  report: () => {
    const input = readStdinJson();
    const report = buildSpawnBudgetReport(input.capture, input.budget ?? {});
    return report;
  },
  evaluate: () => {
    const input = readStdinJson();
    const report = buildSpawnBudgetReport(input.capture, input.budget ?? {});
    return { report, verdict: evaluateSpawnBudgetReport(report) };
  },
  replay: () => {
    const input = readStdinJson();
    return replayCaptureBudgetCheck(input.capture, input.budget ?? {}, input.expectedCaseId);
  },
  verifyCaptures: () => {
    const input = readStdinJson();
    return verifyCommittedCaptureReplays(input.packRoot ?? '.', input.budget);
  },
};

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const sub = process.argv[2] ?? '';
  const handler = cliSubcommands[/** @type {keyof typeof cliSubcommands} */ (sub)];
  if (!handler) {
    console.error(`unknown subcommand: ${sub}`);
    process.exit(2);
  }
  const result = handler();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    process.exit(1);
  }
}
