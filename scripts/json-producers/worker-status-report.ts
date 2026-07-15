import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from '#opk-kernel/subprocess';
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
} from '../lib/worker-status-store.mjs';
import {
  argumentValue,
  describeError,
  integerArgument,
  isDirectExecution,
  parseArguments,
} from './cli.js';

interface AnyRow { readonly [key: string]: unknown }

export interface WorkerStatusReportRow {
  readonly sessionId: string;
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

function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function nonEmpty(value: unknown): string {
  return stringValue(value).trim();
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function integerValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function dataRows(payload: unknown, label: string): readonly AnyRow[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error(`${label}: missing required top-level data[]`);
  return payload.data.map((row, index) => {
    if (!isRecord(row)) throw new Error(`${label}: data[${index}] must be an object`);
    return row;
  });
}

export function parseAoPrefixedJson(text: string, label: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`${label} produced no JSON output`);
  try {
    return JSON.parse(text.slice(start)) as unknown;
  } catch (error) {
    throw new Error(`${label} parse failed: ${describeError(error)}`);
  }
}

function normalizeAoSessionRow(row: AnyRow): AnyRow {
  const id = nonEmpty(row.id) || nonEmpty(row.name) || nonEmpty(row.sessionId);
  const projectId = nonEmpty(row.projectId) || nonEmpty(row.project);
  const normalized: Record<string, unknown> = { ...row };
  if (id) {
    normalized.id = id;
    if (!normalized.name) normalized.name = id;
    if (!normalized.sessionId) normalized.sessionId = id;
  }
  if (projectId) {
    normalized.projectId = projectId;
    if (!normalized.project) normalized.project = projectId;
  }
  if (row.issueId && !normalized.issue) normalized.issue = String(row.issueId);
  return normalized;
}

function assertSessionRow(row: AnyRow): void {
  const id = nonEmpty(row.id);
  if (!id) throw new Error('ao session adapter: session row missing non-empty id');
  const role = nonEmpty(row.role);
  if (role !== 'worker' && role !== 'orchestrator') throw new Error(`ao session adapter: session row ${id} has invalid role '${role}'`);
  if (!nonEmpty(row.status)) throw new Error(`ao session adapter: session row ${id} missing status`);
  if (!Object.hasOwn(row, 'isTerminated') || typeof row.isTerminated !== 'boolean') {
    throw new Error(`ao session adapter: session row ${id} isTerminated must be boolean`);
  }
  if (Object.hasOwn(row, 'reports')) throw new Error(`ao session adapter: session row ${id} must not carry reports field on AO 0.10`);
}

export function mergeAoStatusSessionRows(
  workerPayload: unknown,
  orchestratorPayload: unknown,
  project: string,
): AnyRow[] {
  const merged = new Map<string, AnyRow>();
  for (const row of [...dataRows(workerPayload, 'ao session ls'), ...dataRows(orchestratorPayload, 'ao orchestrator ls')]) {
    const normalized = normalizeAoSessionRow(row);
    if (project && nonEmpty(normalized.projectId) !== project) continue;
    if (normalized.isTerminated === true) continue;
    assertSessionRow(normalized);
    const id = nonEmpty(normalized.id);
    if (merged.has(id)) throw new Error(`ao session adapter: duplicate session id '${id}' across worker and orchestrator lists`);
    merged.set(id, normalized);
  }
  return [...merged.values()];
}

function unknownRows(sessions: readonly AnyRow[], reason: string): AnyRow[] {
  return sessions.map((session) => ({
    ...session,
    status: 'unknown',
    workerStatus: 'unknown',
    workerStatusDerived: 'unknown',
    workerStatusSource: 'pack-worker-status-store',
    workerStatusWinningSource: 'degraded',
    workerStatusStale: true,
    workerStatusDegradedReason: reason,
    degradedReason: reason,
    workerStatusDiagnostics: [reason],
    reports: Array.isArray(session.reports) ? session.reports : [],
  }));
}

export function buildWorkerStatusReport(
  sessions: readonly AnyRow[],
  store: Record<string, unknown>,
  nowMs: number,
  options: { readonly killSwitchActive: boolean; readonly siblingReady: boolean; readonly repoTickGeneration?: number },
): WorkerStatusReportArtifact {
  const projected = options.killSwitchActive
    ? unknownRows(sessions, 'kill_switch_active')
    : !options.siblingReady
      ? unknownRows(sessions, 'sibling_not_ready')
      : mergeWorkerStatusIntoSessions([...sessions], store, nowMs, options.repoTickGeneration ?? 0);
  const workers = projected.map((session): WorkerStatusReportRow => {
    const lastUpdatedMs = integerValue(session.workerStatusLastUpdatedMs);
    return {
      sessionId: nonEmpty(session.id) || nonEmpty(session.name) || nonEmpty(session.sessionId),
      derivedStatus: nonEmpty(session.workerStatusDerived) || nonEmpty(session.status) || 'unknown',
      decisionStatus: nonEmpty(session.status) || 'unknown',
      freshnessAgeMs: lastUpdatedMs > 0 ? nowMs - lastUpdatedMs : -1,
      winningSource: nonEmpty(session.workerStatusWinningSource),
      stale: booleanValue(session.workerStatusStale),
      degradedReason: nonEmpty(session.workerStatusDegradedReason) || nonEmpty(session.degradedReason),
      diagnostics: Array.isArray(session.workerStatusDiagnostics) ? session.workerStatusDiagnostics : [],
      killSwitchActive: options.killSwitchActive,
      siblingReadinessOk: options.siblingReady,
    };
  });
  return {
    generatedAtMs: nowMs,
    killSwitchActive: options.killSwitchActive,
    siblingReady: options.siblingReady,
    workers,
  };
}

function validateWorkerStatusReport(value: unknown): WorkerStatusReportArtifact {
  if (!isRecord(value) || !Array.isArray(value.workers)) throw new Error('worker-status report must contain workers[]');
  return value as unknown as WorkerStatusReportArtifact;
}

export const WORKER_STATUS_REPORT_CONTRACT: JsonArtifactContract<WorkerStatusReportArtifact> = {
  id: 'worker-status-report/v1',
  validate: (value) => validateWorkerStatusReport(value),
  format: PRETTY_JSON_WITH_NEWLINE,
};

async function invokeAo(args: readonly string[], label: string, aoCommand: string): Promise<unknown> {
  const result = await runProcess({ command: aoCommand, args, inheritParentEnv: true, timeoutMs: 60_000 });
  if (!result.ok) throw new Error(`${label} failed (exit ${result.exitCode ?? result.outcome}): ${result.stderr || result.error || result.stdout}`);
  return parseAoPrefixedJson(result.stdout, label);
}

async function loadSessions(args: ReturnType<typeof parseArguments>, project: string): Promise<AnyRow[]> {
  const fixture = argumentValue(args, 'session-lists-fixture');
  if (fixture) {
    const payload = JSON.parse(readFileSync(fixture, 'utf8')) as unknown;
    if (!isRecord(payload)) throw new Error('session-lists fixture must be an object');
    return mergeAoStatusSessionRows(payload.workerList, payload.orchestratorList, project);
  }
  const aoCommand = argumentValue(args, 'ao-command', 'ao');
  const workerArgs = ['session', 'ls', '--json'];
  if (project) workerArgs.push('-p', project);
  const [workerList, orchestratorList] = await Promise.all([
    invokeAo(workerArgs, 'ao session ls', aoCommand),
    invokeAo(['orchestrator', 'ls', '--json'], 'ao orchestrator ls', aoCommand),
  ]);
  return mergeAoStatusSessionRows(workerList, orchestratorList, project);
}

export function renderWorkerStatusText(report: WorkerStatusReportArtifact): string {
  const lines = [`worker-status report (read-only) killSwitch=${report.killSwitchActive} siblingReady=${report.siblingReady}`];
  for (const row of report.workers) {
    lines.push(`${row.sessionId} status=${row.derivedStatus} decision=${row.decisionStatus} ageMs=${row.freshnessAgeMs} source=${row.winningSource} stale=${row.stale} degraded=${row.degradedReason}`);
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
  const report = buildWorkerStatusReport(sessions, store, nowMs, {
    killSwitchActive: killSwitch,
    siblingReady: readiness.ok,
  });
  if (args.flags.has('json')) process.stdout.write(serializeJsonArtifact(report, WORKER_STATUS_REPORT_CONTRACT));
  else process.stdout.write(renderWorkerStatusText(report));
  return 0;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${describeError(error)}\n`);
    return 1;
  });
}
