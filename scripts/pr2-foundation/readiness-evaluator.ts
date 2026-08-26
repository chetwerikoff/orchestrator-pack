export const READY_TO_MERGE = 'READY_TO_MERGE' as const;
export const NOT_READY = 'NOT_READY' as const;

export const WORKER_LIFECYCLE_STATES = [
  'working',
  'pr_created',
  'started',
  'fixing_ci',
  'addressing_reviews',
  'blocked',
  'ready_for_review',
  'completed',
] as const;

export type WorkerLifecycleState = typeof WORKER_LIFECYCLE_STATES[number];
export type ReadinessState = typeof READY_TO_MERGE | typeof NOT_READY;

export interface ReadinessTarget {
  readonly repository: string;
  readonly issueNumber: number;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly prNumber: number;
  readonly headSha: string;
}

export interface CurrentPrFact {
  readonly open: boolean;
  readonly expectedTarget: boolean;
  readonly prNumber: number;
  readonly headSha: string;
}

export interface WorkerReportFact {
  readonly accepted?: boolean;
  readonly repoSlug?: string;
  readonly assignment?: {
    readonly assignmentId?: string;
    readonly generation?: number;
    readonly taskId?: string;
  } | null;
  readonly prNumber?: number;
  readonly headSha?: string;
  readonly reportState?: string;
  readonly reportedAtMs?: number;
  readonly lastObservedMs?: number;
}

export interface WorkerStatusFact {
  readonly assignmentId?: string;
  readonly assignmentGeneration?: number;
  readonly taskId?: string;
  readonly issueNumber?: number;
  readonly repository?: string;
  readonly kind?: 'local' | 'remote';
  readonly localCapability?: 'available' | 'degraded' | 'not_applicable';
  readonly derivedStatus?: string;
  readonly winningSource?: string;
  readonly stale?: boolean;
  readonly degradedReason?: string;
  readonly killSwitchActive?: boolean;
  readonly siblingReadinessOk?: boolean;
}

export interface HeadBoundGateFact {
  readonly headSha: string;
  readonly state: 'success' | 'failure' | 'pending' | 'missing' | 'unknown';
}

export interface SmokeGateFact {
  readonly headSha: string;
  readonly state: 'pass' | 'fail' | 'missing' | 'unknown';
}

export interface ReviewReadinessFact {
  readonly obligation: 'complete' | 'missing' | 'blocked' | 'unknown';
  readonly unresolvedRequiredFinding: boolean | 'unknown';
  readonly atCapOpenFindings: boolean | 'unknown';
  readonly atCapContinuationRequired: boolean | 'unknown';
}

export interface ReadinessInput {
  readonly target: ReadinessTarget;
  readonly pr: CurrentPrFact;
  readonly workerReports: readonly WorkerReportFact[];
  readonly workerStatuses: readonly WorkerStatusFact[];
  readonly requiredCi: HeadBoundGateFact;
  readonly review: ReviewReadinessFact;
  readonly smoke: SmokeGateFact;
}

export interface AcceptedWorkerLifecycleFact {
  readonly state: WorkerLifecycleState;
  readonly report: WorkerReportFact;
  readonly status: WorkerStatusFact;
}

export interface ReadinessResult {
  readonly state: ReadinessState;
  readonly ready: boolean;
  readonly failedPredicates: readonly string[];
  readonly lifecycle?: AcceptedWorkerLifecycleFact;
}

const BLOCKING_LIFECYCLE_STATES = new Set<WorkerLifecycleState>([
  'working',
  'pr_created',
  'started',
  'fixing_ci',
  'addressing_reviews',
  'blocked',
]);

function normalized(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizedRepository(value: unknown): string {
  return normalized(value).toLowerCase();
}

function normalizedSha(value: unknown): string {
  const candidate = normalized(value).toLowerCase();
  return /^[0-9a-f]{40}$/u.test(candidate) ? candidate : '';
}

function lifecycleState(value: unknown): WorkerLifecycleState | null {
  const candidate = normalized(value).toLowerCase();
  return (WORKER_LIFECYCLE_STATES as readonly string[]).includes(candidate)
    ? candidate as WorkerLifecycleState
    : null;
}

function sameAssignment(report: WorkerReportFact, target: ReadinessTarget): boolean {
  return normalized(report.assignment?.assignmentId) === normalized(target.assignmentId)
    && Number(report.assignment?.generation ?? 0) === target.assignmentGeneration
    && normalized(report.assignment?.taskId) === normalized(target.taskId);
}

function exactReport(report: WorkerReportFact, target: ReadinessTarget): boolean {
  return report.accepted !== false
    && normalizedRepository(report.repoSlug) === normalizedRepository(target.repository)
    && sameAssignment(report, target)
    && Number(report.prNumber ?? 0) === target.prNumber
    && normalizedSha(report.headSha) === normalizedSha(target.headSha);
}

function reportTimestamp(report: WorkerReportFact): number {
  const value = Number(report.reportedAtMs ?? report.lastObservedMs ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function selectAcceptedCurrentWorkerReport(
  reports: readonly WorkerReportFact[],
  target: ReadinessTarget,
): WorkerReportFact | null {
  const exact = reports
    .filter((report) => exactReport(report, target))
    .sort((left, right) => reportTimestamp(right) - reportTimestamp(left));
  const current = exact[0];
  if (!current) return null;
  const currentTimestamp = reportTimestamp(current);
  const tied = exact.filter((report) => reportTimestamp(report) === currentTimestamp);
  const states = new Set(tied.map((report) => lifecycleState(report.reportState) ?? '<invalid>'));
  return states.size === 1 ? current : null;
}

function exactStatus(status: WorkerStatusFact, target: ReadinessTarget): boolean {
  return normalized(status.assignmentId) === normalized(target.assignmentId)
    && Number(status.assignmentGeneration ?? 0) === target.assignmentGeneration
    && normalized(status.taskId) === normalized(target.taskId)
    && Number(status.issueNumber ?? 0) === target.issueNumber
    && normalizedRepository(status.repository) === normalizedRepository(target.repository);
}

function usableStatusProjection(status: WorkerStatusFact): boolean {
  if (status.stale !== false) return false;
  if (status.killSwitchActive === true) return false;
  if (status.siblingReadinessOk === false) return false;
  if (normalized(status.degradedReason)) return false;
  if (status.kind === 'local' && status.localCapability !== 'available') return false;
  if (status.kind === 'remote' && status.localCapability !== 'not_applicable') return false;
  if (status.localCapability === 'degraded') return false;
  if (normalized(status.winningSource).toLowerCase() === 'degraded') return false;
  return true;
}

export function selectCorroboratingWorkerStatus(
  statuses: readonly WorkerStatusFact[],
  target: ReadinessTarget,
): WorkerStatusFact | null {
  const exact = statuses.filter((status) => exactStatus(status, target));
  if (exact.length !== 1) return null;
  return usableStatusProjection(exact[0]!) ? exact[0]! : null;
}

export function deriveAcceptedWorkerLifecycle(
  input: Pick<ReadinessInput, 'target' | 'workerReports' | 'workerStatuses'>,
): AcceptedWorkerLifecycleFact | null {
  const report = selectAcceptedCurrentWorkerReport(input.workerReports, input.target);
  if (!report) return null;
  const state = lifecycleState(report.reportState);
  if (!state) return null;
  const status = selectCorroboratingWorkerStatus(input.workerStatuses, input.target);
  if (!status) return null;
  return { state, report, status };
}

export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const failures: string[] = [];
  const targetHead = normalizedSha(input.target.headSha);
  const targetIdentityValid = Boolean(
    targetHead
    && input.target.issueNumber > 0
    && input.target.prNumber > 0
    && input.target.assignmentGeneration > 0
    && normalized(input.target.assignmentId)
    && normalized(input.target.taskId)
    && normalizedRepository(input.target.repository),
  );
  if (!targetIdentityValid) failures.push('authoritative_target_invalid');

  if (!input.pr.open) failures.push('pr_not_open');
  if (!input.pr.expectedTarget) failures.push('pr_target_mismatch');
  if (input.pr.prNumber !== input.target.prNumber) failures.push('pr_number_mismatch');
  if (!targetHead || normalizedSha(input.pr.headSha) !== targetHead) failures.push('pr_head_mismatch');

  if (!targetHead || normalizedSha(input.requiredCi.headSha) !== targetHead || input.requiredCi.state !== 'success') {
    failures.push('required_ci_not_green_for_current_head');
  }
  if (input.review.obligation !== 'complete') failures.push('review_obligation_incomplete');
  if (input.review.unresolvedRequiredFinding !== false) failures.push('unresolved_required_review_finding');
  if (input.review.atCapOpenFindings !== false) failures.push('at_cap_open_findings');
  if (input.review.atCapContinuationRequired !== false) failures.push('at_cap_continuation_required');
  if (!targetHead || normalizedSha(input.smoke.headSha) !== targetHead || input.smoke.state !== 'pass') {
    failures.push('exact_head_smoke_not_passed');
  }

  const lifecycle = deriveAcceptedWorkerLifecycle(input);
  if (!lifecycle) failures.push('accepted_worker_lifecycle_missing_or_conflicting');
  else if (BLOCKING_LIFECYCLE_STATES.has(lifecycle.state)) failures.push(`worker_lifecycle_blocker:${lifecycle.state}`);

  return {
    state: failures.length === 0 ? READY_TO_MERGE : NOT_READY,
    ready: failures.length === 0,
    failedPredicates: failures,
    ...(lifecycle ? { lifecycle } : {}),
  };
}

export const ReadinessEvaluator = Object.freeze({
  evaluate: evaluateReadiness,
  selectAcceptedCurrentWorkerReport,
  selectCorroboratingWorkerStatus,
  deriveAcceptedWorkerLifecycle,
});
