import { readFileSync } from 'node:fs';
import {
  PRETTY_JSON_WITH_NEWLINE,
  serializeJsonArtifact,
  type JsonArtifactContract,
} from '#opk-kernel/json-artifact';
import {
  evaluateWorkerStatusKillSwitch,
  mergeWorkerStatusIntoSessions,
  readWorkerStatusStoreFile,
  resolveWorkerStatusStorePath,
  testSiblingReadiness,
  type WorkerStatusStore,
} from '../lib/worker-status-store.mjs';
import {
  listCurrentWorkerAssignments,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import {
  resolveCurrentWorkerAssignmentBindings,
  type ResolvedWorkerAssignment,
  type WorkerAssignmentReconciliation,
} from '../lib/worker-assignment-runtime.ts';
import type { RuntimeWorker } from '../runtime/contracts.ts';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import {
  argumentValue,
  integerArgument,
  isDirectExecution,
  parseArguments,
  describeError,
} from './cli.ts';

interface AnyRow { readonly [key: string]: unknown }

export interface WorkerStatusReportRow {
  readonly assignmentId?: string;
  readonly assignmentGeneration?: number;
  readonly taskId?: string;
  readonly issueNumber?: number;
  readonly repository?: string;
  readonly kind?: 'local' | 'remote';
  readonly provider?: string;
  readonly bindingKey?: string;
  readonly localCapability?: 'available' | 'degraded' | 'not_applicable';
  readonly sessionId?: string;
  readonly derivedStatus: string;
  readonly decisionStatus: string;
  readonly freshnessAgeMs: number;
  readonly winningSource: string;
  readonly stale: boolean;
  readonly degradedReason: string;
  readonly diagnostics: readonly unknown[];
  readonly killSwitchActive: boolean;
  readonly siblingReadinessOk: boolean;
}

export interface WorkerStatusReportArtifact {
  readonly generatedAtMs: number;
  readonly killSwitchActive: boolean;
  readonly siblingReady: boolean;
  readonly workers: readonly WorkerStatusReportRow[];
}

function isRecord(value: unknown): value is AnyRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stringValue(value: unknown): string { return value === null || value === undefined ? '' : String(value); }
function nonEmpty(value: unknown): string { return stringValue(value).trim(); }
function booleanValue(value: unknown, fallback = false): boolean { return typeof value === 'boolean' ? value : fallback; }
function integerValue(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? Math.trunc(parsed) : 0; }
function dataRows(payload: unknown, label: string): readonly AnyRow[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error(`${label}: missing required top-level data[]`);
  return payload.data.map((row, index) => {
    if (!isRecord(row)) throw new Error(`${label}: data[${index}] must be an object`);
    return row;
  });
}
function normalizeFixtureSessionRow(row: AnyRow): AnyRow {
  const id = nonEmpty(row.id) || nonEmpty(row.name) || nonEmpty(row.sessionId);
  const projectId = nonEmpty(row.projectId) || nonEmpty(row.project);
  const normalized: Record<string, unknown> = { ...row };
  if (id) { normalized.id = id; if (!normalized.name) normalized.name = id; if (!normalized.sessionId) normalized.sessionId = id; }
  if (projectId) { normalized.projectId = projectId; if (!normalized.project) normalized.project = projectId; }
  if (row.issueId && !normalized.issue) normalized.issue = String(row.issueId);
  return normalized;
}
function assertFixtureSessionRow(row: AnyRow): void {
  const id = nonEmpty(row.id);
  if (!id) throw new Error('runtime worker fixture: session row missing non-empty id');
  const role = nonEmpty(row.role);
  if (role !== 'worker' && role !== 'orchestrator') throw new Error(`runtime worker fixture: session row ${id} has invalid role '${role}'`);
  if (!nonEmpty(row.status)) throw new Error(`runtime worker fixture: session row ${id} missing status`);
  if (!Object.hasOwn(row, 'isTerminated') || typeof row.isTerminated !== 'boolean') throw new Error(`runtime worker fixture: session row ${id} isTerminated must be boolean`);
  if (Object.hasOwn(row, 'reports')) throw new Error(`runtime worker fixture: session row ${id} must not carry reports field`);
}

/** Historical fixture seam only; production rows are assignment-centric below. */
export function mergeRuntimeStatusSessionRows(workerPayload: unknown, orchestratorPayload: unknown, project: string): AnyRow[] {
  const merged = new Map<string, AnyRow>();
  for (const row of [...dataRows(workerPayload, 'runtime worker fixture'), ...dataRows(orchestratorPayload, 'runtime orchestrator fixture')]) {
    const normalized = normalizeFixtureSessionRow(row);
    if (project && nonEmpty(normalized.projectId) !== project) continue;
    if (normalized.isTerminated === true) continue;
    assertFixtureSessionRow(normalized);
    const id = nonEmpty(normalized.id);
    if (merged.has(id)) throw new Error(`runtime worker fixture: duplicate session id '${id}' across worker and orchestrator lists`);
    merged.set(id, normalized);
  }
  return [...merged.values()];
}

/** Legacy focused helper retained for fixture coverage, not production authority. */
export function runtimeWorkersToStatusSessions(workers: readonly RuntimeWorker[], project: string): AnyRow[] {
  const seen = new Set<string>();
  return workers.map((worker) => {
    const id = nonEmpty(worker.identity.id);
    const runtime = nonEmpty(worker.identity.runtime);
    const generation = nonEmpty(worker.identity.generation);
    if (!id || !runtime || !generation) throw new Error('runtime worker inventory returned incomplete composite identity');
    if (seen.has(id)) throw new Error(`runtime worker inventory returned duplicate id '${id}'`);
    seen.add(id);
    return { id, name:id, sessionId:id, role:'worker', status:'unknown', isTerminated:false,
      ...(project ? { projectId:project, project } : {}), runtime, generation,
      workspacePath:worker.workspacePath, title:worker.title, provenance:worker.provenance };
  });
}

function assignmentBase(assignment: WorkerAssignment, project: string): Record<string, unknown> {
  return {
    role: 'worker', status: 'unknown', isTerminated: false,
    assignmentId: assignment.assignmentId,
    assignmentGeneration: assignment.generation,
    taskId: assignment.taskId,
    issueNumber: assignment.issueNumber,
    repository: assignment.repository,
    kind: assignment.kind,
    provider: assignment.provider,
    bindingKey: assignment.bindingKey,
    ...(project ? { projectId: project, project } : {}),
  };
}

/**
 * Project current logical assignments into the singular WorkerStatus producer.
 * Runtime/session/workspace facts are joined only for an exact current local
 * binding. Remote and unresolved-local rows never fabricate those fields.
 */
export function assignmentsToStatusSessions(input: {
  readonly assignments: readonly WorkerAssignment[];
  readonly bindings?: readonly ResolvedWorkerAssignment[];
  readonly reconciliations?: readonly WorkerAssignmentReconciliation[];
  readonly project: string;
}): AnyRow[] {
  const bindingByAssignment = new Map(
    (input.bindings ?? []).map((binding) => [binding.assignment.assignmentId, binding] as const),
  );
  const reconciliationByAssignment = new Map(
    (input.reconciliations ?? []).map((row) => [row.assignment.assignmentId, row] as const),
  );
  return input.assignments.map((assignment) => {
    const base = assignmentBase(assignment, input.project);
    if (assignment.kind === 'remote') {
      return { ...base, localCapability:'not_applicable' };
    }
    const binding = bindingByAssignment.get(assignment.assignmentId);
    if (!binding) {
      const reason = reconciliationByAssignment.get(assignment.assignmentId)?.reason ?? 'target_unresolved';
      return { ...base, localCapability:'degraded', localCapabilityReason:reason };
    }
    const worker = binding.worker;
    return {
      ...base,
      localCapability:'available',
      id:worker.identity.id,
      name:worker.identity.id,
      sessionId:worker.identity.id,
      runtime:worker.identity.runtime,
      generation:worker.identity.generation,
      workspacePath:worker.workspacePath,
      title:worker.title,
      provenance:worker.provenance,
    };
  });
}

function unknownRuntimeRows(sessions: readonly AnyRow[], reason: string): AnyRow[] {
  return sessions.map((session) => ({ ...session, status:'unknown', workerStatus:'unknown', workerStatusDerived:'unknown',
    workerStatusSource:'pack-worker-status-store', workerStatusWinningSource:'degraded', workerStatusStale:true,
    workerStatusDegradedReason:reason, degradedReason:reason, workerStatusDiagnostics:[reason] }));
}

export function buildWorkerStatusReport(
  sessions: readonly AnyRow[], store: WorkerStatusStore | Record<string, unknown>, nowMs: number,
  options: { readonly killSwitchActive: boolean; readonly siblingReady: boolean; readonly repoTickGeneration?: number },
): WorkerStatusReportArtifact {
  const runtimeRows = sessions.filter((row) => nonEmpty(row.id));
  const runtimeProjected = options.killSwitchActive
    ? unknownRuntimeRows(runtimeRows, 'kill_switch_active')
    : !options.siblingReady
      ? unknownRuntimeRows(runtimeRows, 'sibling_not_ready')
      : mergeWorkerStatusIntoSessions([...runtimeRows], store, nowMs, options.repoTickGeneration ?? 0);
  const byId = new Map(runtimeProjected.map((row) => [nonEmpty(row.id), row] as const));
  const projected = sessions.map((session): AnyRow => {
    const id = nonEmpty(session.id);
    if (id) return byId.get(id) ?? session;
    if (session.kind === 'remote') {
      return { ...session, workerStatusDerived:'unknown', workerStatusWinningSource:'worker_assignment', workerStatusStale:false, workerStatusDiagnostics:[] };
    }
    const reason = nonEmpty(session.localCapabilityReason) || 'target_unresolved';
    return { ...session, workerStatusDerived:'unknown', workerStatusWinningSource:'degraded', workerStatusStale:true, workerStatusDegradedReason:reason, workerStatusDiagnostics:[reason] };
  });
  const workers = projected.map((session): WorkerStatusReportRow => {
    const lastUpdatedMs = integerValue(session.workerStatusLastUpdatedMs);
    const kind = nonEmpty(session.kind);
    const localCapability = nonEmpty(session.localCapability);
    return {
      ...(nonEmpty(session.assignmentId) ? { assignmentId:nonEmpty(session.assignmentId) } : {}),
      ...(integerValue(session.assignmentGeneration) > 0 ? { assignmentGeneration:integerValue(session.assignmentGeneration) } : {}),
      ...(nonEmpty(session.taskId) ? { taskId:nonEmpty(session.taskId) } : {}),
      ...(integerValue(session.issueNumber) > 0 ? { issueNumber:integerValue(session.issueNumber) } : {}),
      ...(nonEmpty(session.repository) ? { repository:nonEmpty(session.repository) } : {}),
      ...(kind === 'local' || kind === 'remote' ? { kind } : {}),
      ...(nonEmpty(session.provider) ? { provider:nonEmpty(session.provider) } : {}),
      ...(nonEmpty(session.bindingKey) ? { bindingKey:nonEmpty(session.bindingKey) } : {}),
      ...(localCapability === 'available' || localCapability === 'degraded' || localCapability === 'not_applicable' ? { localCapability } : {}),
      ...(nonEmpty(session.id) || nonEmpty(session.sessionId) ? { sessionId:nonEmpty(session.id)||nonEmpty(session.sessionId) } : {}),
      derivedStatus:nonEmpty(session.workerStatusDerived)||nonEmpty(session.status)||'unknown',
      decisionStatus:nonEmpty(session.status)||'unknown',
      freshnessAgeMs:lastUpdatedMs>0?nowMs-lastUpdatedMs:-1,
      winningSource:nonEmpty(session.workerStatusWinningSource), stale:booleanValue(session.workerStatusStale),
      degradedReason:nonEmpty(session.workerStatusDegradedReason)||nonEmpty(session.degradedReason),
      diagnostics:Array.isArray(session.workerStatusDiagnostics)?session.workerStatusDiagnostics:[],
      killSwitchActive:options.killSwitchActive, siblingReadinessOk:options.siblingReady,
    };
  });
  return { generatedAtMs:nowMs, killSwitchActive:options.killSwitchActive, siblingReady:options.siblingReady, workers };
}

function validateWorkerStatusReport(value: unknown): WorkerStatusReportArtifact {
  if (!isRecord(value) || !Array.isArray(value.workers)) throw new Error('worker-status report must contain workers[]');
  return value as unknown as WorkerStatusReportArtifact;
}
export const WORKER_STATUS_REPORT_CONTRACT: JsonArtifactContract<WorkerStatusReportArtifact> = {
  id:'worker-status-report/v1', validate:(value)=>validateWorkerStatusReport(value), format:PRETTY_JSON_WITH_NEWLINE,
};

async function loadSessions(args: ReturnType<typeof parseArguments>, project: string): Promise<AnyRow[]> {
  const fixture = argumentValue(args, 'session-lists-fixture');
  if (fixture) {
    const payload = JSON.parse(readFileSync(fixture, 'utf8')) as unknown;
    if (!isRecord(payload)) throw new Error('session-lists fixture must be an object');
    return mergeRuntimeStatusSessionRows(payload.workerList, payload.orchestratorList, project);
  }
  const assignmentFile = resolveWorkerAssignmentStorePath(project, process.env);
  const assignments = listCurrentWorkerAssignments(assignmentFile);
  if (!assignments) throw new Error('worker assignment store untrusted');
  const scoped = assignments.filter((assignment) => assignment.projectId === project);
  if (!scoped.some((assignment) => assignment.kind === 'local')) {
    return assignmentsToStatusSessions({ assignments:scoped, project });
  }
  const requestedAdapter = argumentValue(args, 'runtime-adapter');
  let runtime;
  try {
    runtime = await selectRuntimeAdapter(requestedAdapter ? { adapter:requestedAdapter } : {});
  } catch {
    return assignmentsToStatusSessions({
      assignments:scoped, project,
      reconciliations:scoped.filter((assignment)=>assignment.kind==='local').map((assignment)=>({ assignment, reason:'target_unresolved' as const })),
    });
  }
  const resolution = resolveCurrentWorkerAssignmentBindings({
    file:assignmentFile,
    repository:scoped[0]?.repository ?? '',
    adapter:runtime,
    timeoutMs:60_000,
  });
  if (resolution.status !== 'ok') {
    return assignmentsToStatusSessions({
      assignments:scoped, project,
      reconciliations:scoped.filter((assignment)=>assignment.kind==='local').map((assignment)=>({ assignment, reason:'target_unresolved' as const })),
    });
  }
  return assignmentsToStatusSessions({ assignments:scoped, bindings:resolution.bindings, reconciliations:resolution.reconciliations, project });
}

export function renderWorkerStatusText(report: WorkerStatusReportArtifact): string {
  const lines = [`worker-status report (read-only) killSwitch=${report.killSwitchActive} siblingReady=${report.siblingReady}`];
  for (const row of report.workers) {
    const identity = row.assignmentId ? `${row.assignmentId}@${row.assignmentGeneration}` : row.sessionId ?? 'unknown';
    lines.push(`${identity} kind=${row.kind ?? 'legacy'} local=${row.localCapability ?? 'legacy'} status=${row.derivedStatus} decision=${row.decisionStatus} ageMs=${row.freshnessAgeMs} source=${row.winningSource} stale=${row.stale} degraded=${row.degradedReason}`);
    if (row.diagnostics.length > 0) lines.push(`  diagnostics: ${row.diagnostics.map(String).join('; ')}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  const project = argumentValue(args, 'project', 'orchestrator-pack');
  const nowMs = integerArgument(args, 'now-ms', Date.now());
  const sessions = await loadSessions(args, project);
  const storePath = argumentValue(args, 'store-path') || resolveWorkerStatusStorePath(process.env);
  const store = readWorkerStatusStoreFile(storePath) as unknown as Record<string, unknown>;
  const killSwitch = evaluateWorkerStatusKillSwitch(process.env).disabled;
  const readiness = testSiblingReadiness(process.env);
  const report = buildWorkerStatusReport(sessions, store, nowMs, { killSwitchActive:killSwitch, siblingReady:readiness.ok });
  if (args.flags.has('json')) process.stdout.write(serializeJsonArtifact(report, WORKER_STATUS_REPORT_CONTRACT));
  else process.stdout.write(renderWorkerStatusText(report));
  return 0;
}
if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${describeError(error)}\n`); return 1; });
}
