import * as base from './worker-smoke-core-base.ts';
export {
  inspectSmokeProgress,
  observeSmokeCancellationAcknowledgement,
  writeSmokeCancelRequest,
} from './worker-smoke-lifecycle-base.ts';

export * from './worker-smoke-core-base.ts';

function bindControlPlaneVerdict(report: base.SmokeReport): base.SmokeReport {
  let diagnostic = report.controlPlaneDiagnostic;
  Object.defineProperty(report, 'controlPlaneDiagnostic', {
    enumerable: true,
    configurable: true,
    get: () => diagnostic,
    set: (value: base.SmokeControlPlaneDiagnostic | undefined) => {
      diagnostic = value;
      if (value) {
        report.result = 'BLOCKED';
        report.nonPassCause = value.cause;
      }
    },
  });
  if (diagnostic) {
    report.result = 'BLOCKED';
    report.nonPassCause = diagnostic.cause;
  }
  return report;
}

function invalidSmokeReport(
  partial: Partial<base.SmokeReport>,
  binding: { issueNumber: number; prNumber: number; headSha: string },
  reason: string,
): base.SmokeReport {
  return bindControlPlaneVerdict({
    result: 'FAIL',
    issueNumber: binding.issueNumber,
    prNumber: binding.prNumber,
    headSha: binding.headSha,
    scenarios: partial.scenarios?.length
      ? partial.scenarios
      : [{
          action: 'normalize sealed smoke report',
          expected: 'valid pack-owned report',
          observed: reason,
          outcome: 'fail',
        }],
    limitations: [...(partial.limitations ?? []), `normalization:${reason}`],
    trackedFilesUnmodified: false,
    terminalCleanup: partial.terminalCleanup ?? 'not_recorded',
    environmentNotes: partial.environmentNotes ?? [],
    producer: base.SMOKE_REPORT_PRODUCER,
    orcaExecutable: partial.orcaExecutable,
    terminalHandle: partial.terminalHandle,
    nonPassCause: 'missing_agent_report',
  });
}

export function normalizeSmokeReport(
  partial: Partial<base.SmokeReport>,
  binding: { issueNumber: number; prNumber: number; headSha: string },
): ({ ok: true; report: base.SmokeReport } | { ok: false; reason: string; report: base.SmokeReport }) {
  const smokeSupervisorProcess = process.argv[1]?.endsWith('/worker-smoke-run.ts') === true;
  const supervisorPendingPass = partial.result === 'PASS'
    && (partial.terminalCleanup === 'pending'
      || (partial.terminalCleanup === '' && smokeSupervisorProcess))
    && partial.producer === base.SMOKE_REPORT_PRODUCER
    && Boolean(partial.terminalHandle?.trim())
    && Boolean(partial.orcaExecutable?.trim());
  const normalized = base.normalizeSmokeReport(
    supervisorPendingPass
      ? { ...partial, terminalCleanup: 'closed_owned_handle' }
      : partial,
    binding,
  );
  if (!normalized.ok) {
    return {
      ...normalized,
      report: invalidSmokeReport(partial, binding, normalized.reason),
    };
  }
  if (supervisorPendingPass) {
    normalized.report.terminalCleanup = 'pending';
  }
  return { ok: true, report: bindControlPlaneVerdict(normalized.report) };
}

/**
 * Preserve the current sealed-report field name while exposing the direct
 * parsed report to runtime-neutral callers. This is not a runtime compatibility
 * protocol; it is an in-process typed view over the canonical sealed artifact.
 */
export function observeSmokeCompletionEvidence(
  runBinding: base.SmokeRunBinding,
  priorState: base.SmokeCompletionObservationState = base.createSmokeCompletionObservationState(),
): ReturnType<typeof base.observeSmokeCompletionEvidence> & {
  observation: base.SmokeCompletionEvidenceObservation & {
    partial?: Partial<base.SmokeReport> | null;
  };
} {
  const observed = base.observeSmokeCompletionEvidence(runBinding, priorState);
  return {
    ...observed,
    observation: {
      ...observed.observation,
      partial: observed.observation.parsedReport,
    },
  };
}

export interface WorkerSmokeCommentRecord {
  id?: number | string;
  body?: string;
  created_at?: string;
  updated_at?: string;
  createdAt?: string;
  updatedAt?: string;
  user?: { login?: string | null } | null;
  actor?: { login?: string | null } | string | null;
}

export interface WorkerSmokeTrustedTarget {
  repositorySlug?: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  resolvedIssueNumber?: number;
  resolvedPrNumber?: number;
  liveHeadSha?: string;
  issueBodyMatchesTarget?: boolean;
  trustedPublisherLogin?: string;
  commentCensusComplete?: boolean;
  commentSnapshotStable?: boolean;
}

export interface WorkerSmokeTupleDiagnostic {
  tuple: string;
  outcome?: base.SmokeScenario['outcome'];
  commentId?: number;
}

export interface WorkerSmokeCandidateDiagnostic {
  commentId: number;
  reason: string;
  createdAt: string;
}

export interface WorkerSmokeBoundedCollection<T> {
  total: number;
  items: T[];
  truncated: boolean;
  overflow: boolean;
}

export interface WorkerSmokeGlobalBlock {
  blocked: boolean;
  kind?: 'invalid_candidate' | 'FAIL' | 'BLOCKED';
  commentId?: number;
  reason?: string;
}

export interface WorkerSmokeCoverageDiagnostics {
  target: {
    repository: string;
    issueNumber: number;
    prNumber: number;
    headSha: string;
  };
  scenarioCount: number;
  coverage: 'complete' | 'partial';
  covered: WorkerSmokeBoundedCollection<WorkerSmokeTupleDiagnostic>;
  missing: WorkerSmokeBoundedCollection<WorkerSmokeTupleDiagnostic>;
  latestNonPass: WorkerSmokeBoundedCollection<WorkerSmokeTupleDiagnostic>;
  invalidCandidates: WorkerSmokeBoundedCollection<WorkerSmokeCandidateDiagnostic>;
  rejectedCandidates: WorkerSmokeBoundedCollection<WorkerSmokeCandidateDiagnostic>;
  globalBlock: WorkerSmokeGlobalBlock;
  payloadOverflow: boolean;
  payloadBytes: number;
}

export interface WorkerSmokeCoverageResult {
  accepting: boolean;
  reason: string;
  diagnostics: WorkerSmokeCoverageDiagnostics;
  latestClearingPass?: base.SmokeReport;
  controlPlaneDiagnostic?: base.SmokeControlPlaneDiagnostic;
}

export interface WorkerSmokeGateInput {
  issueBody: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  prComments: readonly WorkerSmokeCommentRecord[];
  ciGreen: boolean;
  orcaWorktreeOk: boolean;
  ownedTerminalClosed: boolean;
  terminalProvenanceOk: boolean;
  repositorySlug?: string;
  resolvedIssueNumber?: number;
  resolvedPrNumber?: number;
  liveHeadSha?: string;
  issueBodyMatchesTarget?: boolean;
  trustedPublisherLogin?: string;
  commentCensusComplete?: boolean;
  commentSnapshotStable?: boolean;
}

export interface WorkerSmokeGateDecision {
  allowed: boolean;
  reason: string;
  smokeRequired: boolean;
  diagnostics?: WorkerSmokeCoverageDiagnostics;
  controlPlaneDiagnostic?: base.SmokeControlPlaneDiagnostic;
}

interface OrderedCandidate {
  id: number;
  body: string;
  createdAt: string;
  createdMs: number;
  invalidReason?: string;
  report?: base.SmokeReport;
}

const DIAGNOSTIC_ITEM_LIMIT = 50;
const DIAGNOSTIC_TEXT_BYTES = 256;
const DIAGNOSTIC_PAYLOAD_BYTES = 64 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REPORT_BLOCK_PATTERN = /```worker-smoke-report\s*\r?\n[\s\S]*?```/giu;

function normalizeLogin(value: string | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function commentActorLogin(comment: WorkerSmokeCommentRecord): string {
  if (typeof comment.actor === 'string') return normalizeLogin(comment.actor);
  return normalizeLogin(comment.user?.login ?? comment.actor?.login ?? undefined);
}

function commentTimestamp(comment: WorkerSmokeCommentRecord, field: 'created' | 'updated'): string {
  return String(field === 'created'
    ? comment.created_at ?? comment.createdAt ?? ''
    : comment.updated_at ?? comment.updatedAt ?? '').trim();
}

function positiveCommentId(value: number | string | undefined): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function truncateUtf8(value: string, limit = DIAGNOSTIC_TEXT_BYTES): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= limit) return value;
  for (let end = limit; end > 0; end -= 1) {
    const candidate = buffer.subarray(0, end).toString('utf8');
    if (!candidate.endsWith('\uFFFD')) return candidate;
  }
  return '';
}

function tupleKey(action: string, expected: string): string {
  return JSON.stringify([action.trim(), expected.trim()]);
}

function tuplePreview(action: string, expected: string): string {
  return truncateUtf8(`${action.trim()} | ${expected.trim()}`);
}

function collectLineValues(body: string, pattern: RegExp): string[] {
  return [...body.matchAll(pattern)].map((match) => String(match[1] ?? '').trim());
}

function targetValues(body: string): {
  issues: number[];
  prs: number[];
  heads: string[];
} {
  return {
    issues: collectLineValues(body, /^\s*(?:-\s*)?issue:\s*#(\d+)\s*$/gimu).map(Number),
    prs: collectLineValues(body, /^\s*(?:-\s*)?pr:\s*#(\d+)\s*$/gimu).map(Number),
    heads: collectLineValues(body, /^\s*(?:-\s*)?head(?:-sha|\s+sha):\s*`?([0-9a-f]{40})`?\s*$/gimu)
      .map((value) => value.toLowerCase()),
  };
}

function isClearlyOtherTarget(
  values: ReturnType<typeof targetValues>,
  target: WorkerSmokeTrustedTarget,
): boolean {
  const head = target.headSha.trim().toLowerCase();
  return (values.issues.length > 0 && values.issues.every((value) => value !== target.issueNumber))
    || (values.prs.length > 0 && values.prs.every((value) => value !== target.prNumber))
    || (values.heads.length > 0 && values.heads.every((value) => value !== head));
}

function targetBindingReason(
  values: ReturnType<typeof targetValues>,
  target: WorkerSmokeTrustedTarget,
): string | undefined {
  if (values.issues.length !== 1) return 'canonical_issue_binding_count_invalid';
  if (values.prs.length !== 1) return 'canonical_pr_binding_count_invalid';
  if (values.heads.length !== 1) return 'canonical_head_binding_count_invalid';
  if (values.issues[0] !== target.issueNumber) return 'canonical_issue_binding_mismatch';
  if (values.prs[0] !== target.prNumber) return 'canonical_pr_binding_mismatch';
  if (values.heads[0] !== target.headSha.trim().toLowerCase()) return 'canonical_head_binding_mismatch';
  return undefined;
}

function strictReportReason(report: base.SmokeReport): string | undefined {
  if (report.producer !== base.SMOKE_REPORT_PRODUCER) return 'producer_missing_or_invalid';
  if (!base.smokeTerminalHandleLooksValid(report.terminalHandle)) return 'terminal_handle_missing_or_invalid';
  if (!report.orcaExecutable?.trim()) return 'orca_executable_missing';
  if (report.trackedFilesUnmodified !== true) return 'tracked_files_modified_or_missing';
  if (!base.isClosedOwnedSmokeTerminalCleanup(report.terminalCleanup)) return 'terminal_cleanup_missing_or_invalid';
  if (!Array.isArray(report.scenarios) || report.scenarios.length === 0) return 'scenario_rows_missing';

  const seen = new Set<string>();
  for (const scenario of report.scenarios) {
    if (!scenario.action?.trim()) return 'scenario_action_missing';
    if (!scenario.expected?.trim()) return 'scenario_expected_missing';
    if (!scenario.observed?.trim()) return 'scenario_observed_missing';
    if (!scenario.outcome || !['pass', 'fail', 'skipped', 'blocked'].includes(scenario.outcome)) {
      return 'scenario_outcome_missing_or_invalid';
    }
    const key = tupleKey(scenario.action, scenario.expected);
    if (seen.has(key)) return 'scenario_tuple_duplicate';
    seen.add(key);
    if (report.result === 'PASS' && scenario.outcome !== 'pass') return 'pass_contains_non_pass_row';
  }
  return undefined;
}

function validateTrustedTarget(
  target: WorkerSmokeTrustedTarget,
  issueBody: string,
): string | undefined {
  if (!target.repositorySlug || !REPOSITORY_SLUG.test(target.repositorySlug.trim())) {
    return 'trusted_repository_missing_or_invalid';
  }
  if (!Number.isInteger(target.issueNumber) || target.issueNumber <= 0) return 'trusted_issue_missing_or_invalid';
  if (!Number.isInteger(target.prNumber) || target.prNumber <= 0) return 'trusted_pr_missing_or_invalid';
  if (!FULL_SHA.test(target.headSha.trim().toLowerCase())) return 'trusted_head_missing_or_invalid';
  if (target.resolvedIssueNumber !== target.issueNumber) return 'trusted_issue_resolution_mismatch';
  if (target.resolvedPrNumber !== target.prNumber) return 'trusted_pr_resolution_mismatch';
  if (target.issueBodyMatchesTarget !== true || !issueBody.trim()) return 'trusted_issue_body_mismatch';
  if (target.liveHeadSha?.trim().toLowerCase() !== target.headSha.trim().toLowerCase()) {
    return 'live_pr_head_mismatch';
  }
  if (!normalizeLogin(target.trustedPublisherLogin)) return 'trusted_publisher_unresolved';
  if (target.commentCensusComplete !== true) return 'comment_census_incomplete';
  if (target.commentSnapshotStable !== true) return 'comment_snapshot_unstable';
  return undefined;
}

function makeCollection<T>(all: readonly T[]): WorkerSmokeBoundedCollection<T> {
  return {
    total: all.length,
    items: all.slice(0, DIAGNOSTIC_ITEM_LIMIT),
    truncated: all.length > DIAGNOSTIC_ITEM_LIMIT,
    overflow: all.length > DIAGNOSTIC_ITEM_LIMIT,
  };
}

function finalizeDiagnostics(diagnostics: WorkerSmokeCoverageDiagnostics): WorkerSmokeCoverageDiagnostics {
  const collections: WorkerSmokeBoundedCollection<unknown>[] = [
    diagnostics.rejectedCandidates,
    diagnostics.invalidCandidates,
    diagnostics.latestNonPass,
    diagnostics.missing,
    diagnostics.covered,
  ];
  diagnostics.payloadBytes = 0;
  let bytes = Buffer.byteLength(JSON.stringify(diagnostics), 'utf8');
  while (bytes > DIAGNOSTIC_PAYLOAD_BYTES) {
    const collection = collections.find((candidate) => candidate.items.length > 0);
    if (!collection) break;
    collection.items.pop();
    collection.truncated = true;
    collection.overflow = true;
    diagnostics.payloadOverflow = true;
    bytes = Buffer.byteLength(JSON.stringify(diagnostics), 'utf8');
  }
  diagnostics.payloadBytes = bytes;
  let finalBytes = Buffer.byteLength(JSON.stringify(diagnostics), 'utf8');
  while (finalBytes > DIAGNOSTIC_PAYLOAD_BYTES) {
    const collection = collections.find((candidate) => candidate.items.length > 0);
    if (!collection) break;
    collection.items.pop();
    collection.truncated = true;
    collection.overflow = true;
    diagnostics.payloadOverflow = true;
    diagnostics.payloadBytes = 0;
    diagnostics.payloadBytes = Buffer.byteLength(JSON.stringify(diagnostics), 'utf8');
    finalBytes = Buffer.byteLength(JSON.stringify(diagnostics), 'utf8');
  }
  diagnostics.payloadBytes = finalBytes;
  return diagnostics;
}

function emptyDiagnostics(
  target: WorkerSmokeTrustedTarget,
  scenarioCount: number,
): WorkerSmokeCoverageDiagnostics {
  return finalizeDiagnostics({
    target: {
      repository: target.repositorySlug?.trim().toLowerCase() ?? '',
      issueNumber: target.issueNumber,
      prNumber: target.prNumber,
      headSha: target.headSha.trim().toLowerCase(),
    },
    scenarioCount,
    coverage: 'partial',
    covered: makeCollection([]),
    missing: makeCollection([]),
    latestNonPass: makeCollection([]),
    invalidCandidates: makeCollection([]),
    rejectedCandidates: makeCollection([]),
    globalBlock: { blocked: false },
    payloadOverflow: false,
    payloadBytes: 0,
  });
}

function admitComment(
  comment: WorkerSmokeCommentRecord,
  target: WorkerSmokeTrustedTarget,
): { kind: 'non_candidate' } | { kind: 'fatal'; reason: string } | { kind: 'candidate'; candidate: OrderedCandidate } {
  const body = String(comment.body ?? '');
  const marker = `<!-- ${base.SMOKE_REPORT_MARKER} -->`;
  const markerCount = body.split(marker).length - 1;
  if (markerCount === 0) return { kind: 'non_candidate' };

  const values = targetValues(body);
  if (isClearlyOtherTarget(values, target)) return { kind: 'non_candidate' };

  const actor = commentActorLogin(comment);
  if (actor && actor !== normalizeLogin(target.trustedPublisherLogin)) return { kind: 'non_candidate' };

  const id = positiveCommentId(comment.id);
  const createdAt = commentTimestamp(comment, 'created');
  const updatedAt = commentTimestamp(comment, 'updated');
  const createdMs = Date.parse(createdAt);
  if (!id || !createdAt || !updatedAt || !Number.isFinite(createdMs)) {
    return { kind: 'fatal', reason: 'candidate_ordering_metadata_invalid' };
  }

  const candidate: OrderedCandidate = { id, body, createdAt, createdMs };
  if (!actor) candidate.invalidReason = 'candidate_actor_missing';
  else if (markerCount !== 1) candidate.invalidReason = 'canonical_marker_count_invalid';
  else if (createdAt !== updatedAt) candidate.invalidReason = 'candidate_edited';

  const bindingReason = targetBindingReason(values, target);
  if (!candidate.invalidReason && bindingReason) candidate.invalidReason = bindingReason;

  const reportBlocks = [...body.matchAll(REPORT_BLOCK_PATTERN)];
  if (!candidate.invalidReason && reportBlocks.length !== 1) {
    candidate.invalidReason = 'canonical_report_block_count_invalid';
  }

  if (!candidate.invalidReason) {
    const partial = base.parseSmokeAgentReport(reportBlocks[0]?.[0] ?? '');
    if (!partial) {
      candidate.invalidReason = 'canonical_report_parse_failed';
    } else {
      const normalized = base.normalizeSmokeReport(partial, {
        issueNumber: target.issueNumber,
        prNumber: target.prNumber,
        headSha: target.headSha.trim().toLowerCase(),
      });
      if (!normalized.ok) candidate.invalidReason = normalized.reason;
      else {
        const strictReason = strictReportReason(normalized.report);
        if (strictReason) candidate.invalidReason = strictReason;
        else candidate.report = normalized.report;
      }
    }
  }

  return { kind: 'candidate', candidate };
}

export function evaluateWorkerSmokeCoverage(input: {
  issueBody: string;
  comments: readonly WorkerSmokeCommentRecord[];
  target: WorkerSmokeTrustedTarget;
}): WorkerSmokeCoverageResult {
  const plan = base.resolveSmokeRequirement(input.issueBody);
  const diagnostics = emptyDiagnostics(input.target, plan.scenarios.length);
  const targetReason = validateTrustedTarget(input.target, input.issueBody);
  if (targetReason) return { accepting: false, reason: targetReason, diagnostics };
  if (plan.requirement !== 'required' || plan.scenarios.length === 0) {
    return { accepting: false, reason: 'missing_smoke_plan', diagnostics };
  }

  const ids = new Set<number>();
  for (const comment of input.comments) {
    const id = positiveCommentId(comment.id);
    if (!id) continue;
    if (ids.has(id)) return { accepting: false, reason: 'comment_census_duplicate_id', diagnostics };
    ids.add(id);
  }

  const candidates: OrderedCandidate[] = [];
  const rejected: WorkerSmokeCandidateDiagnostic[] = [];
  for (const comment of input.comments) {
    const admitted = admitComment(comment, input.target);
    if (admitted.kind === 'fatal') {
      rejected.push({ commentId: positiveCommentId(comment.id) ?? 0, reason: admitted.reason, createdAt: commentTimestamp(comment, 'created') });
      diagnostics.rejectedCandidates = makeCollection(rejected);
      return {
        accepting: false,
        reason: admitted.reason,
        diagnostics: finalizeDiagnostics(diagnostics),
      };
    }
    if (admitted.kind === 'candidate') candidates.push(admitted.candidate);
  }
  candidates.sort((left, right) => left.createdMs - right.createdMs || left.id - right.id);

  const currentKeys = new Set(plan.scenarios.map((scenario) => tupleKey(scenario.action, scenario.expected)));
  const latestRows = new Map<string, { scenario: base.SmokeScenario; commentId: number }>();
  const invalid: WorkerSmokeCandidateDiagnostic[] = [];
  let globalBlock: WorkerSmokeGlobalBlock = { blocked: false };
  let latestClearingPass: base.SmokeReport | undefined;
  let controlPlaneDiagnostic: base.SmokeControlPlaneDiagnostic | undefined;

  for (const candidate of candidates) {
    if (candidate.invalidReason || !candidate.report) {
      const reason = candidate.invalidReason ?? 'candidate_invalid';
      invalid.push({ commentId: candidate.id, reason: truncateUtf8(reason), createdAt: candidate.createdAt });
      globalBlock = { blocked: true, kind: 'invalid_candidate', commentId: candidate.id, reason };
      controlPlaneDiagnostic = undefined;
      continue;
    }

    for (const scenario of candidate.report.scenarios) {
      const key = tupleKey(scenario.action, scenario.expected);
      if (currentKeys.has(key)) latestRows.set(key, { scenario, commentId: candidate.id });
    }

    if (candidate.report.result === 'PASS') {
      globalBlock = { blocked: false };
      latestClearingPass = candidate.report;
      controlPlaneDiagnostic = undefined;
    } else {
      globalBlock = {
        blocked: true,
        kind: candidate.report.result,
        commentId: candidate.id,
        reason: `smoke_${candidate.report.result.toLowerCase()}`,
      };
      controlPlaneDiagnostic = candidate.report.controlPlaneDiagnostic;
    }
  }

  const covered: WorkerSmokeTupleDiagnostic[] = [];
  const missing: WorkerSmokeTupleDiagnostic[] = [];
  const latestNonPass: WorkerSmokeTupleDiagnostic[] = [];
  for (const scenario of plan.scenarios) {
    const latest = latestRows.get(tupleKey(scenario.action, scenario.expected));
    const diagnostic: WorkerSmokeTupleDiagnostic = {
      tuple: tuplePreview(scenario.action, scenario.expected),
      outcome: latest?.scenario.outcome,
      commentId: latest?.commentId,
    };
    if (!latest) missing.push(diagnostic);
    else if (latest.scenario.outcome === 'pass') covered.push(diagnostic);
    else latestNonPass.push(diagnostic);
  }

  const complete = missing.length === 0 && latestNonPass.length === 0 && !globalBlock.blocked;
  diagnostics.coverage = complete ? 'complete' : 'partial';
  diagnostics.covered = makeCollection(covered);
  diagnostics.missing = makeCollection(missing);
  diagnostics.latestNonPass = makeCollection(latestNonPass);
  diagnostics.invalidCandidates = makeCollection([...invalid].reverse());
  diagnostics.rejectedCandidates = makeCollection([...rejected].reverse());
  diagnostics.globalBlock = {
    ...globalBlock,
    reason: globalBlock.reason ? truncateUtf8(globalBlock.reason) : undefined,
  };

  return {
    accepting: complete,
    reason: globalBlock.blocked
      ? globalBlock.reason ?? 'smoke_evidence_globally_blocked'
      : complete ? 'smoke_plan_covered' : 'smoke_plan_not_fully_covered',
    diagnostics: finalizeDiagnostics(diagnostics),
    latestClearingPass,
    controlPlaneDiagnostic,
  };
}

export function evaluateWorkerSmokeGate(input: WorkerSmokeGateInput): WorkerSmokeGateDecision {
  const plan = base.resolveSmokeRequirement(input.issueBody);
  if (plan.requirement === 'unknown') {
    return { allowed: false, reason: 'issue_body_unavailable', smokeRequired: true };
  }
  if (plan.requirement === 'legacy-exempt' || plan.requirement === 'not-applicable') {
    if (!input.ciGreen) return { allowed: false, reason: 'required_ci_not_green', smokeRequired: false };
    return { allowed: true, reason: 'smoke_not_required', smokeRequired: false };
  }
  if (plan.scenarios.length === 0) {
    return { allowed: false, reason: 'missing_smoke_plan', smokeRequired: true };
  }

  const coverage = evaluateWorkerSmokeCoverage({
    issueBody: input.issueBody,
    comments: input.prComments,
    target: {
      repositorySlug: input.repositorySlug,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      headSha: input.headSha,
      resolvedIssueNumber: input.resolvedIssueNumber,
      resolvedPrNumber: input.resolvedPrNumber,
      liveHeadSha: input.liveHeadSha,
      issueBodyMatchesTarget: input.issueBodyMatchesTarget,
      trustedPublisherLogin: input.trustedPublisherLogin,
      commentCensusComplete: input.commentCensusComplete,
      commentSnapshotStable: input.commentSnapshotStable,
    },
  });

  if (!input.orcaWorktreeOk) {
    return { allowed: false, reason: 'orca_worktree_unresolved', smokeRequired: true, diagnostics: coverage.diagnostics };
  }
  if (!coverage.accepting) {
    return {
      allowed: false,
      reason: coverage.controlPlaneDiagnostic?.cause ?? coverage.reason,
      smokeRequired: true,
      diagnostics: coverage.diagnostics,
      controlPlaneDiagnostic: coverage.controlPlaneDiagnostic,
    };
  }
  if (!input.ownedTerminalClosed && !coverage.latestClearingPass) {
    return { allowed: false, reason: 'owned_smoke_terminal_uncleaned', smokeRequired: true, diagnostics: coverage.diagnostics };
  }
  if (!input.ciGreen) {
    return { allowed: false, reason: 'required_ci_not_green', smokeRequired: true, diagnostics: coverage.diagnostics };
  }
  if (!input.terminalProvenanceOk) {
    return { allowed: false, reason: 'smoke_terminal_provenance_unverified', smokeRequired: true, diagnostics: coverage.diagnostics };
  }
  return { allowed: true, reason: 'smoke_pass_and_ci_green', smokeRequired: true, diagnostics: coverage.diagnostics };
}
