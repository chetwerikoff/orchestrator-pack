import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadPackSpawnBudgetManifest } from './spawn-budget-manifest-loader.mjs';
import {
  REQUIRED_SOURCE_CLASSES,
  REVIEW_PIPELINE_SPAWN_BUDGET_RELATIVE_PATH,
  aggregateSpawnEvents,
  deriveReducedBudgetThreshold,
  measurePerStepCosts,
  validateReviewPipelineSpawnBudget,
  validateSpawnCapture,
} from './review-pipeline-spawn-budget-attribution.mjs';

const JOURNAL_RATE_MACHINE_PATH_RE =
  /(?:^|\s)(?:\/(?:home|tmp|var|Users)\/|\b[A-Z]:\\)|worktrees\/opk-\d+/i;

export function loadReviewPipelineSpawnBudget(packRoot) {
  return loadPackSpawnBudgetManifest(
    packRoot,
    REVIEW_PIPELINE_SPAWN_BUDGET_RELATIVE_PATH,
    validateReviewPipelineSpawnBudget,
    { okReason: 'spawn_budget_ok' },
  );
}

export function validateJournalRateAttribution(capture) {
  const validated = validateSpawnCapture(capture);
  if (!validated.ok) return validated;
  const events = capture.events ?? [];
  const elapsedMs = Number(capture.window?.elapsedMs ?? 0);
  const measurementModel = String(
    capture.measurementModel ?? capture.captureProvenance?.measurementModel ?? '',
  );
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
  const subprocessEvents = events.filter((event) =>
    /^pwsh -NoProfile -File scripts\//.test(String(event.commandLine ?? '')),
  );
  const invocationCount = Number(capture.captureProvenance?.subprocessInvocationCount ?? 0);
  if (subprocessEvents.length < 1) {
    return { ok: false, reason: 'journal_rate_missing_subprocess_script_evidence' };
  }
  if (!Number.isFinite(invocationCount) || invocationCount < subprocessEvents.length) {
    return { ok: false, reason: 'journal_rate_subprocess_count_mismatch' };
  }
  const observedRatePerMinute = (events.length / elapsedMs) * 60_000;
  if (!Number.isFinite(observedRatePerMinute) || observedRatePerMinute <= 0) {
    return { ok: false, reason: 'journal_rate_not_computable' };
  }
  const aggregation = aggregateSpawnEvents(events);
  if (Number(aggregation.bySource['supervisor-child'] ?? 0) < 1 ||
      Number(aggregation.bySource['llm-orchestrator-review-start'] ?? 0) < 1) {
    return { ok: false, reason: 'journal_rate_insufficient_source_attribution' };
  }
  if (events.length > 0 && Number(aggregation.bySource.unknown ?? 0) === events.length) {
    return { ok: false, reason: 'journal_rate_all_events_unknown' };
  }
  if (!capture.pointInTimePsSnapshot || typeof capture.pointInTimePsSnapshot !== 'object') {
    return { ok: false, reason: 'journal_rate_missing_supplementary_ps_snapshot' };
  }
  return {
    ok: true,
    reason: 'journal_rate_attribution_ok',
    observedRatePerMinute,
    subprocessInvocationCount: subprocessEvents.length,
    bySource: aggregation.bySource,
  };
}

export function buildSpawnBudgetReport(capture, budgetManifest) {
  const validated = validateSpawnCapture(capture);
  if (!validated.ok) return { ok: false, reason: validated.reason };
  const events = capture.events ?? [];
  const aggregation = aggregateSpawnEvents(events);
  const elapsedMs = Number(capture.window?.elapsedMs ?? 0);
  const callerCadencePerMinute = Number(
    capture.window?.callerCadencePerMinute ?? budgetManifest.callerCadencePerMinute ?? 12,
  );
  const measuredPerStepCosts = measurePerStepCosts(
    aggregation.bySource,
    aggregation.totalProcessCount,
  );
  const derived = deriveReducedBudgetThreshold({
    measuredPerStepCosts,
    callerCadencePerMinute,
    reductionFactor: Number(budgetManifest.reductionFactor ?? 0.35),
    perStepCostFloor: Number(budgetManifest.perStepCostFloor ?? 1),
  });
  const observedRatePerMinute = elapsedMs > 0
    ? (aggregation.totalProcessCount / elapsedMs) * 60_000
    : aggregation.totalProcessCount;
  const psSnapshot = capture.pointInTimePsSnapshot ?? null;
  const psProcessCount = psSnapshot && typeof psSnapshot.processCount === 'number'
    ? psSnapshot.processCount
    : null;
  return {
    ok: true,
    caseId: String(capture.caseId),
    callerPath: String(capture.captureProvenance?.callerPath ?? 'unknown'),
    elapsedMs,
    effectiveElapsedMs: elapsedMs,
    windowMinutes: elapsedMs / 60_000,
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
    psSnapshotMissesBurst: psProcessCount !== null && psProcessCount < aggregation.totalProcessCount,
    budgetBelowBaseline: derived.derivedBudgetThreshold < aggregation.totalProcessCount,
  };
}

export function evaluateSpawnBudgetReport(report) {
  if (!report?.ok) return { ok: false, reason: report?.reason ?? 'report_invalid' };
  for (const sourceClass of REQUIRED_SOURCE_CLASSES) {
    if (typeof report.bySource?.[sourceClass] !== 'number') {
      return { ok: false, reason: `missing_source_bucket_${sourceClass}` };
    }
  }
  const totalProcessCount = Number(report.totalProcessCount ?? 0);
  if (totalProcessCount > 0 && Number(report.bySource?.unknown ?? 0) === totalProcessCount) {
    return { ok: false, reason: 'all_spawns_collapsed_into_unknown' };
  }
  const observedRatePerMinute = Number(report.observedRatePerMinute ?? 0);
  const overBudget = observedRatePerMinute > Number(report.derivedBudgetThreshold ?? 0);
  return {
    ok: !overBudget,
    reason: overBudget ? 'aggregate_budget_exceeded' : 'within_aggregate_budget',
    overBudget,
    observedRatePerMinute,
    totalProcessCount,
    derivedBudgetThreshold: report.derivedBudgetThreshold,
  };
}

export function replayCaptureBudgetCheck(capture, budgetManifest, expectedCaseId) {
  const validated = validateSpawnCapture(capture);
  if (!validated.ok) return { ok: false, reason: validated.reason, expectedCaseId };
  if (validated.caseId !== expectedCaseId) {
    return { ok: false, reason: 'capture_case_id_mismatch', expectedCaseId, actual: validated.caseId };
  }
  const report = buildSpawnBudgetReport(capture, budgetManifest);
  if (!report.ok) return { ok: false, reason: report.reason, expectedCaseId };
  const journalRate = validateJournalRateAttribution(capture);
  if (!journalRate.ok) {
    return { ok: false, reason: journalRate.reason, expectedCaseId, journalRate };
  }
  const verdict = evaluateSpawnBudgetReport(report);
  const expectPass = expectedCaseId === String(budgetManifest.reducedPassCaseId ?? 'reduced-post-change');
  const expectFail = expectedCaseId === String(budgetManifest.stormBaselineCaseId ?? 'storm-baseline');
  if (expectPass && !verdict.ok) {
    return { ok: false, reason: 'reduced_capture_rejected_by_budget', expectedCaseId, report, verdict };
  }
  if (expectFail && verdict.ok) {
    return { ok: false, reason: 'storm_capture_accepted_by_budget', expectedCaseId, report, verdict };
  }
  return {
    ok: true,
    reason: expectPass ? 'reduced_capture_passes' : 'storm_capture_fails_as_expected',
    expectedCaseId,
    report,
    verdict,
  };
}

export function verifyCommittedCaptureReplays(packRoot, budgetManifest) {
  const manifest = budgetManifest ?? loadReviewPipelineSpawnBudget(packRoot).budget ?? null;
  if (!manifest) return { ok: false, reason: 'spawn_budget_manifest_unavailable' };
  const stormRel = String(
    manifest.captures?.['storm-baseline'] ??
      'tests/external-output-references/review-pipeline-spawn-budget/storm-baseline.capture.json',
  );
  const reducedRel = String(
    manifest.captures?.['reduced-post-change'] ??
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
  if (!stormJournal.ok) return { ok: false, reason: `storm_${stormJournal.reason}`, stormJournal };
  const reducedJournal = validateJournalRateAttribution(reducedCapture);
  if (!reducedJournal.ok) {
    return { ok: false, reason: `reduced_${reducedJournal.reason}`, reducedJournal };
  }
  const storm = replayCaptureBudgetCheck(stormCapture, manifest, 'storm-baseline');
  const reduced = replayCaptureBudgetCheck(reducedCapture, manifest, 'reduced-post-change');
  if (!storm.ok || !reduced.ok) {
    return { ok: false, reason: !storm.ok ? storm.reason : reduced.reason, storm, reduced };
  }
  if (!storm.report?.budgetBelowBaseline) {
    return { ok: false, reason: 'derived_budget_not_below_storm_baseline', storm, reduced };
  }
  if (Number(reduced.report?.derivedBudgetThreshold) >= Number(storm.report?.observedRatePerMinute)) {
    return { ok: false, reason: 'reduced_threshold_not_below_storm_rate', storm, reduced };
  }
  return { ok: true, reason: 'capture_replays_ok', storm, reduced, stormJournal, reducedJournal };
}

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
    if (unit) args.push('-u', unit);
    const sample = spawnSync(journalCommand, args, { encoding: 'utf8', timeout: 10_000 });
    if (sample.status !== 0) {
      return {
        ok: false,
        reason: 'journal_query_failed',
        detail: `${sample.stderr ?? ''}${sample.stdout ?? ''}`.trim().slice(0, 240),
      };
    }
    const lines = String(sample.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
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
