export const REVIEW_PIPELINE_SPAWN_BUDGET_VERSION = 'review-pipeline-spawn-budget/v1';
export const REVIEW_PIPELINE_SPAWN_CAPTURE_VERSION = 'review-pipeline-spawn-capture/v1';
export const REVIEW_PIPELINE_SPAWN_BUDGET_RELATIVE_PATH = 'docs/review-pipeline-spawn-budget.json';
export const REQUIRED_SOURCE_CLASSES = Object.freeze([
  'supervisor-child',
  'llm-orchestrator-review-start',
  'worker-test-suite',
  'autonomous-guard',
  'unknown',
]);

// Survivor-only patterns. Retired PR-A/PR-B children must never regain source attribution.
const SUPERVISOR_CHILD_PATTERNS = [
  /orchestrator-wake-heartbeat\.ps1/i,
  /review-trigger-reconcile\.ps1/i,
  /review-trigger-reeval\.ps1/i,
  /review-ready-report-state-seed\.ps1/i,
  /ci-green-wake-reconcile\.ps1/i,
  /review-send-reconcile\.ps1/i,
  /worker-message-submit-reconcile\.ps1/i,
  /review-start-claim-reaper\.ps1/i,
  /ci-failure-notification-reconcile\.ps1/i,
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

export function attributeSpawnSourceClass(commandLine, hints = {}) {
  const line = String(commandLine ?? '').trim();
  const hint = String(hints.sourceHint ?? hints.childId ?? '').trim().toLowerCase();
  const matches = (patterns, value) => patterns.some((pattern) => pattern.test(value));

  if (hint && matches(SUPERVISOR_CHILD_PATTERNS, hint)) return 'supervisor-child';
  if (hint && matches(LLM_REVIEW_START_PATTERNS, hint)) return 'llm-orchestrator-review-start';
  if (hint && matches(WORKER_TEST_PATTERNS, hint)) return 'worker-test-suite';
  if (hint && matches(AUTONOMOUS_GUARD_PATTERNS, hint)) return 'autonomous-guard';
  if (matches(LLM_REVIEW_START_PATTERNS, line)) return 'llm-orchestrator-review-start';
  if (matches(SUPERVISOR_CHILD_PATTERNS, line) || matches(SUPERVISOR_READ_PATTERNS, line)) {
    return 'supervisor-child';
  }
  if (matches(WORKER_TEST_PATTERNS, line)) return 'worker-test-suite';
  if (matches(AUTONOMOUS_GUARD_PATTERNS, line)) return 'autonomous-guard';
  return 'unknown';
}

export function validateReviewPipelineSpawnBudget(budget) {
  if (!budget || typeof budget !== 'object') {
    return { ok: false, reason: 'spawn_budget_missing_or_unreadable' };
  }
  if (String(budget.version ?? '') !== REVIEW_PIPELINE_SPAWN_BUDGET_VERSION) {
    return { ok: false, reason: 'spawn_budget_unknown_version' };
  }
  if (!Array.isArray(budget.sourceClasses)) {
    return { ok: false, reason: 'spawn_budget_missing_source_classes' };
  }
  for (const required of REQUIRED_SOURCE_CLASSES) {
    if (!budget.sourceClasses.includes(required)) {
      return { ok: false, reason: `spawn_budget_missing_source_class_${required}` };
    }
  }
  return { ok: true, reason: 'spawn_budget_ok' };
}

export function validateSpawnCapture(capture) {
  if (!capture || typeof capture !== 'object') {
    return { ok: false, reason: 'capture_missing_or_unreadable' };
  }
  if (String(capture.version ?? '') !== REVIEW_PIPELINE_SPAWN_CAPTURE_VERSION) {
    return { ok: false, reason: 'capture_unknown_version' };
  }
  const caseId = String(capture.caseId ?? '');
  if (!caseId) return { ok: false, reason: 'capture_missing_case_id' };
  if (!Array.isArray(capture.events) || capture.events.length === 0) {
    return { ok: false, reason: 'capture_missing_events' };
  }
  if (!capture.window || typeof capture.window !== 'object') {
    return { ok: false, reason: 'capture_missing_window' };
  }
  if (typeof capture.window.elapsedMs !== 'number' || capture.window.elapsedMs <= 0) {
    return { ok: false, reason: 'capture_missing_elapsed_window' };
  }
  if (typeof capture.window.callerCadencePerMinute !== 'number' ||
      capture.window.callerCadencePerMinute <= 0) {
    return { ok: false, reason: 'capture_missing_caller_cadence' };
  }
  return { ok: true, reason: 'capture_ok', caseId };
}

export function aggregateSpawnEvents(events) {
  const bySource = Object.fromEntries(REQUIRED_SOURCE_CLASSES.map((key) => [key, 0]));
  const commandCounts = new Map();
  for (const event of events) {
    const commandLine = String(event?.commandLine ?? event?.sourceHint ?? 'unknown');
    const sourceClass = attributeSpawnSourceClass(commandLine, event);
    bySource[sourceClass] = (bySource[sourceClass] ?? 0) + 1;
    const normalized = commandLine.replace(/\s+/g, ' ').trim().slice(0, 240);
    commandCounts.set(normalized, (commandCounts.get(normalized) ?? 0) + 1);
  }
  const topOffenders = [...commandCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([commandLine, count]) => ({ commandLine, count }));
  return {
    totalProcessCount: events.length,
    bySource,
    topOffenders,
    nontrivialNonUnknownCount: events.length - (bySource.unknown ?? 0),
  };
}

export function measurePerStepCosts(bySource, totalEvents) {
  const measured = {};
  const denominator = Math.max(1, totalEvents);
  for (const sourceClass of REQUIRED_SOURCE_CLASSES) {
    measured[sourceClass] = Number(((bySource[sourceClass] ?? 0) / denominator).toFixed(6));
  }
  return measured;
}

export function deriveReducedBudgetThreshold(input) {
  const floor = Number(input.perStepCostFloor ?? 1);
  const cadence = Number(input.callerCadencePerMinute ?? 0);
  const reductionFactor = Number(input.reductionFactor ?? 0.35);
  let rawPreReduction = 0;
  for (const sourceClass of REQUIRED_SOURCE_CLASSES) {
    rawPreReduction += cadence * Math.max(floor, Number(input.measuredPerStepCosts?.[sourceClass] ?? 0));
  }
  return {
    derivedBudgetThreshold: Math.max(1, Math.floor(rawPreReduction * reductionFactor)),
    rawPreReduction,
    reductionFactor,
  };
}
