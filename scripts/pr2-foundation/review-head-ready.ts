export interface HeadReadyCheck {
  name?: string;
  state?: string;
  conclusion?: string;
  status?: string;
}

export interface HeadReadyReport {
  reportState?: string;
  state?: string;
  headRefOid?: string;
  headSha?: string;
  accepted?: boolean;
}

export interface HeadReadySession {
  id?: string;
  sessionId?: string;
  name?: string;
  role?: string;
  kind?: string;
  status?: string;
  isTerminated?: boolean;
  ownedHeadSha?: string;
  headRefOid?: string;
  reports?: HeadReadyReport[];
}

export interface HeadReadyReviewRun {
  targetSha?: string;
  headSha?: string;
  status?: string;
}

export interface HeadReadyDecision {
  eligible: boolean;
  route: 'start_review' | 'defer' | 'already_covered';
  reason: string;
}

const REQUIRED_CHECKS = Object.freeze([
  'verify orchestrator-pack structure',
  'pr scope guard',
  'run pack contract tests',
  'self-architect lint',
]);

function normalized(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function checkSuccessful(check: HeadReadyCheck): boolean {
  return ['success', 'successful', 'completed'].includes(
    normalized(check.state ?? check.conclusion ?? check.status),
  );
}

function liveWorker(session: HeadReadySession | null | undefined): session is HeadReadySession {
  if (!session || session.isTerminated === true) return false;
  const role = normalized(session.role ?? session.kind);
  if (role !== 'worker' && role !== 'coding') return false;
  return !['terminated', 'closed', 'failed', 'dead', 'stopped'].includes(normalized(session.status));
}

function reportCoversHead(report: HeadReadyReport, headSha: string): boolean {
  if (report.accepted === false) return false;
  const state = normalized(report.reportState ?? report.state);
  if (state !== 'ready_for_review') return false;
  const stored = normalized(report.headRefOid ?? report.headSha);
  return Boolean(stored && stored === normalized(headSha));
}

function runCoversHead(run: HeadReadyReviewRun, headSha: string): boolean {
  const target = normalized(run.targetSha ?? run.headSha);
  if (target !== normalized(headSha)) return false;
  return !['failed', 'cancelled', 'stale'].includes(normalized(run.status));
}

/**
 * Foundation-local head-ready predicate retained after the legacy docs module
 * is terminalized. It intentionally proves only the invariant consumed by the
 * liveness/kernel contract: one live exact-head worker handoff plus all required
 * merge-contract checks and no covering review run starts review exactly once.
 */
export function evaluateHeadReadyForReview(input: {
  reviewRuns?: HeadReadyReviewRun[];
  prNumber: number;
  headSha: string;
  session?: HeadReadySession | null;
  ciChecks?: HeadReadyCheck[];
}): HeadReadyDecision {
  const headSha = normalized(input.headSha);
  if (!headSha || !Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    return { eligible: false, route: 'defer', reason: 'invalid_pr_head' };
  }
  if (!liveWorker(input.session)) {
    return { eligible: false, route: 'defer', reason: 'no_worker_session' };
  }
  const owned = normalized(input.session.ownedHeadSha ?? input.session.headRefOid);
  if (owned && owned !== headSha) {
    return { eligible: false, route: 'defer', reason: 'worker_head_mismatch' };
  }
  if (!(input.session.reports ?? []).some((report) => reportCoversHead(report, headSha))) {
    return { eligible: false, route: 'defer', reason: 'ready_for_review_missing' };
  }
  const checks = input.ciChecks ?? [];
  const byName = new Map(checks.map((check) => [normalized(check.name), check]));
  if (REQUIRED_CHECKS.some((name) => !byName.has(name) || !checkSuccessful(byName.get(name)!))) {
    return { eligible: false, route: 'defer', reason: 'required_ci_not_green' };
  }
  if ((input.reviewRuns ?? []).some((run) => runCoversHead(run, headSha))) {
    return { eligible: false, route: 'already_covered', reason: 'head_already_covered' };
  }
  return { eligible: true, route: 'start_review', reason: 'ready_for_review' };
}
