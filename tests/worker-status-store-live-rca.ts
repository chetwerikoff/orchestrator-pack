import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getExplicitSessionPrNumber,
  getSessionIssueNumber,
  headRefCorrelatesToIssue,
  resolveSessionPrBinding,
  sessionDetailFromSessionGetPayload,
  shouldEnrichSessionDetailFromGet,
  type AoSession,
  type OpenPr,
} from '../docs/session-pr-binding-resolver.mjs';
import {
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../scripts/kernel/subprocess.ts';

type JsonObject = Record<string, unknown>;
type CommandRunner = (options: RunProcessOptions) => Promise<ProcessResult>;

const TERMINAL_SESSION_RE = /^(terminated|killed|exited|dead|closed)$/i;
const NON_ACTIONABLE_STATUS_RE = /^(unknown|stale)$/i;
const BINDING_CONTRACT_DEPENDENCY = 'docs/issues_drafts/291-pr-session-binding-contract.md';
const OPEN_PR_LIMIT = 200;
const DETAIL_POLICY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/worker-status-detail-policy.json');

export interface WorkerStatusDetailPolicy {
  readonly schemaVersion: number;
  readonly maxCallsPerTick: number;
  readonly perCallTimeoutMs: number;
  readonly globalDeadlineMs: number;
  readonly postKillDrainMs: number;
}

export function loadWorkerStatusDetailPolicy(path = DETAIL_POLICY_PATH): WorkerStatusDetailPolicy {
  const raw = objectOrEmpty(JSON.parse(readFileSync(path, 'utf8')));
  const policy: WorkerStatusDetailPolicy = {
    schemaVersion: parseNumber(raw.schemaVersion),
    maxCallsPerTick: parseNumber(raw.maxCallsPerTick),
    perCallTimeoutMs: parseNumber(raw.perCallTimeoutMs),
    globalDeadlineMs: parseNumber(raw.globalDeadlineMs),
    postKillDrainMs: parseNumber(raw.postKillDrainMs),
  };
  if (policy.schemaVersion !== 1) throw new Error('worker-status detail policy schemaVersion must be 1');
  if (!Number.isInteger(policy.maxCallsPerTick) || policy.maxCallsPerTick <= 0 || policy.maxCallsPerTick > 200) {
    throw new Error('worker-status detail policy maxCallsPerTick out of range');
  }
  if (!Number.isInteger(policy.perCallTimeoutMs) || policy.perCallTimeoutMs <= 0 || policy.perCallTimeoutMs > 60_000) {
    throw new Error('worker-status detail policy perCallTimeoutMs out of range');
  }
  if (!Number.isInteger(policy.globalDeadlineMs) || policy.globalDeadlineMs <= 0 || policy.globalDeadlineMs >= 20_000) {
    throw new Error('worker-status detail policy globalDeadlineMs must stay below the 20s supervisor stall budget');
  }
  if (!Number.isInteger(policy.postKillDrainMs) || policy.postKillDrainMs < 0 || policy.postKillDrainMs > 2_000) {
    throw new Error('worker-status detail policy postKillDrainMs out of range');
  }
  return policy;
}

export interface LiveRcaOptions {
  readonly stateDir?: string;
  readonly project?: string;
  readonly repoRoot?: string;
  readonly maxSessionDetails?: number;
  readonly sessionDetailTimeoutMs?: number;
  readonly detailDeadlineMs?: number;
  readonly runner?: CommandRunner;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

export interface StoreSummary {
  readonly state: 'missing' | 'empty' | 'populated-degraded' | 'populated-usable' | 'populated-mixed';
  readonly rowCount: number;
  readonly degradedCount: number;
  readonly unusableCount: number;
  readonly usableCount: number;
  readonly winningSourceDistribution: Readonly<Record<string, number>>;
  readonly modifiedAtMs: number | null;
}

export interface ReportStoreSummary {
  readonly state: 'missing' | 'present';
  readonly generation: number;
  readonly bindingCount: number;
  readonly sourceRecordCount: number;
  readonly modifiedAtMs: number | null;
}

interface CommandObservation {
  readonly ok: boolean;
  readonly reason: string;
  readonly payload: unknown;
}

function objectOrEmpty(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function arrayOfObjects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is JsonObject => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function parseNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeSha(value: unknown): string {
  return normalizeString(value).toLowerCase();
}

export function parsePrefixedJson(text: string, label: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    const leading = line.search(/\S/);
    if (leading >= 0 && (line[leading] === '{' || line[leading] === '[')) {
      candidates.push(line.trim());
      candidates.push(text.slice(offset + leading).trim());
    }
    offset += line.length;
    if (text.slice(offset, offset + 2) === '\r\n') offset += 2;
    else if (text[offset] === '\n') offset += 1;
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return JSON.parse(candidate);
    } catch {
      // AO and gh may prefix diagnostics. Keep scanning bounded candidate starts.
    }
  }
  throw new Error(`${label}: no valid JSON payload`);
}

function readJsonFile(path: string): { payload: JsonObject | null; modifiedAtMs: number | null } {
  if (!existsSync(path)) return { payload: null, modifiedAtMs: null };
  const payload = objectOrEmpty(JSON.parse(readFileSync(path, 'utf8')));
  return { payload, modifiedAtMs: statSync(path).mtimeMs };
}

function recordMap(payload: JsonObject | null): JsonObject {
  if (!payload) return {};
  const records = objectOrEmpty(payload.records);
  if (Object.keys(records).length > 0) return records;
  return objectOrEmpty(payload.rows);
}

function rowIsSemanticallyUsable(row: JsonObject): boolean {
  const source = normalizeString(row.winningSource).toLowerCase();
  const status = normalizeString(row.derivedStatus ?? row.status).toLowerCase();
  return Boolean(source)
    && source !== 'degraded'
    && Boolean(status)
    && !NON_ACTIONABLE_STATUS_RE.test(status);
}

export function summarizeWorkerStatusStore(path: string): StoreSummary {
  const { payload, modifiedAtMs } = readJsonFile(path);
  if (!payload) {
    return {
      state: 'missing',
      rowCount: 0,
      degradedCount: 0,
      unusableCount: 0,
      usableCount: 0,
      winningSourceDistribution: {},
      modifiedAtMs,
    };
  }
  const rows = Object.values(recordMap(payload)).map(objectOrEmpty);
  const distribution: Record<string, number> = {};
  let degradedCount = 0;
  let usableCount = 0;
  for (const row of rows) {
    const source = normalizeString(row.winningSource).toLowerCase() || 'missing';
    distribution[source] = (distribution[source] ?? 0) + 1;
    if (source === 'degraded') degradedCount += 1;
    if (rowIsSemanticallyUsable(row)) usableCount += 1;
  }
  const unusableCount = rows.length - usableCount;
  const state = rows.length === 0
    ? 'empty'
    : usableCount === 0
      ? 'populated-degraded'
      : usableCount === rows.length
        ? 'populated-usable'
        : 'populated-mixed';
  return {
    state,
    rowCount: rows.length,
    degradedCount,
    unusableCount,
    usableCount,
    winningSourceDistribution: distribution,
    modifiedAtMs,
  };
}

export function summarizeWorkerReportStore(path: string): ReportStoreSummary {
  const { payload, modifiedAtMs } = readJsonFile(path);
  if (!payload) {
    return {
      state: 'missing',
      generation: 0,
      bindingCount: 0,
      sourceRecordCount: 0,
      modifiedAtMs,
    };
  }
  return {
    state: 'present',
    generation: parseNumber(payload.generation),
    bindingCount: Object.keys(objectOrEmpty(payload.bindingByKey)).length,
    sourceRecordCount: Object.keys(objectOrEmpty(payload.sourceRecords)).length,
    modifiedAtMs,
  };
}

async function observeJsonCommand(
  runner: CommandRunner,
  options: RunProcessOptions,
  label: string,
): Promise<CommandObservation> {
  const result = await runner({ ...options, allowEmptyStdout: false });
  if (!result.ok) {
    return {
      ok: false,
      reason: `${label}:${result.outcome}:${result.exitCode ?? 'none'}`,
      payload: null,
    };
  }
  try {
    return { ok: true, reason: '', payload: parsePrefixedJson(result.stdout, label) };
  } catch {
    return { ok: false, reason: `${label}:invalid_json`, payload: null };
  }
}

function sessionRows(payload: unknown): AoSession[] {
  const root = objectOrEmpty(payload);
  return arrayOfObjects(root.data ?? root.sessions) as AoSession[];
}

function openPrRows(payload: unknown): OpenPr[] {
  if (Array.isArray(payload)) return arrayOfObjects(payload) as OpenPr[];
  const root = objectOrEmpty(payload);
  return arrayOfObjects(root.data ?? root.items ?? root.pullRequests) as OpenPr[];
}

function sessionIdentifier(session: AoSession): string {
  return normalizeString(session.sessionId ?? session.id ?? session.name);
}

function sessionHead(session: AoSession): string {
  const row = session as AoSession & { headSha?: string };
  return normalizeSha(row.ownedHeadSha ?? row.headRefOid ?? row.headSha);
}

function sessionBranch(session: AoSession): string {
  return normalizeString(session.branch ?? session.headBranch ?? session.headRefName);
}

function sessionIsActiveWorker(session: AoSession): boolean {
  const row = session as AoSession & { isTerminated?: boolean };
  const role = normalizeString(row.role).toLowerCase();
  const status = normalizeString(row.status);
  return role === 'worker'
    && row.isTerminated !== true
    && !TERMINAL_SESSION_RE.test(status);
}

function detailPayloadToResolverDetail(detailPayload: JsonObject | null): { displayName?: string } | null {
  return detailPayload ? sessionDetailFromSessionGetPayload(detailPayload) : null;
}

function existingContractBinding(
  session: AoSession,
  detailPayload: JsonObject | null,
  openPrs: OpenPr[],
) {
  return resolveSessionPrBinding(session, openPrs, {
    headSha: sessionHead(session) || undefined,
    sessionDetail: detailPayloadToResolverDetail(detailPayload),
  });
}

function sessionCorrelatesToOpenPrCandidate(
  session: AoSession,
  detailPayload: JsonObject | null,
  openPrs: OpenPr[],
): boolean {
  const head = sessionHead(session);
  const branch = sessionBranch(session);
  const explicitPr = getExplicitSessionPrNumber(session);
  if (explicitPr > 0) {
    return openPrs.some((pr) => parseNumber(pr.number) === explicitPr
      && (!head || normalizeSha(pr.headRefOid) === head));
  }
  if (head) {
    return openPrs.some((pr) => normalizeSha(pr.headRefOid) === head);
  }
  if (branch) {
    return openPrs.some((pr) => normalizeString(pr.headRefName ?? pr.head) === branch);
  }
  const issue = getSessionIssueNumber(session);
  return issue > 0 && openPrs.some((pr) => headRefCorrelatesToIssue(
    normalizeString(pr.headRefName ?? pr.head),
    issue,
    session,
  ));
}

function detailIsRequired(session: AoSession): boolean {
  return shouldEnrichSessionDetailFromGet(session);
}

async function processLiveness(runner: CommandRunner, env: Readonly<NodeJS.ProcessEnv>): Promise<'running' | 'not-running' | 'unknown'> {
  const result = process.platform === 'win32'
    ? await runner({
        command: 'pwsh',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'review-ready-report-state-seed' }; if ($p) { 'running' } else { 'not-running' }",
        ],
        env,
        inheritParentEnv: true,
        allowEmptyStdout: false,
      })
    : await runner({
        command: 'sh',
        args: ['-c', "pgrep -af '[r]eview-ready-report-state-seed' >/dev/null && printf running || printf not-running"],
        env,
        inheritParentEnv: true,
        allowEmptyStdout: false,
      });
  if (!result.ok) return 'unknown';
  const value = normalizeString(result.stdout);
  return value === 'running' || value === 'not-running' ? value : 'unknown';
}

export async function runWorkerStatusLiveRca(options: LiveRcaOptions = {}): Promise<JsonObject> {
  const stateDir = resolve(
    options.stateDir
      ?? process.env.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR
      ?? join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor'),
  );
  const project = options.project ?? 'orchestrator-pack';
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const runtimeDetailPolicy = loadWorkerStatusDetailPolicy();
  const maxSessionDetails = Math.max(0, options.maxSessionDetails ?? runtimeDetailPolicy.maxCallsPerTick);
  const sessionDetailTimeoutMs = Math.max(1, options.sessionDetailTimeoutMs ?? runtimeDetailPolicy.perCallTimeoutMs);
  const detailDeadlineMs = Math.max(1, options.detailDeadlineMs ?? runtimeDetailPolicy.globalDeadlineMs);
  const detailPolicyMatchesRuntime = maxSessionDetails === runtimeDetailPolicy.maxCallsPerTick
    && sessionDetailTimeoutMs === runtimeDetailPolicy.perCallTimeoutMs
    && detailDeadlineMs === runtimeDetailPolicy.globalDeadlineMs;
  const runner = options.runner ?? runProcess;
  const env = { ...process.env, ...options.env };

  const workerStatus = summarizeWorkerStatusStore(join(stateDir, 'worker-status-store.json'));
  const workerReport = summarizeWorkerReportStore(join(stateDir, 'worker-report-store.json'));

  const aoList = await observeJsonCommand(runner, {
    command: 'ao',
    args: ['session', 'ls', '--json', '-p', project, '--include-terminated'],
    env,
    inheritParentEnv: true,
    timeoutMs: 30_000,
  }, 'ao_session_ls');
  const ghOpenPrs = await observeJsonCommand(runner, {
    command: 'gh',
    args: ['pr', 'list', '--state', 'open', '--json', 'number,headRefOid,headRefName,state', '--limit', String(OPEN_PR_LIMIT)],
    cwd: repoRoot,
    env,
    inheritParentEnv: true,
    timeoutMs: 30_000,
  }, 'gh_open_pr_list');

  const sessions = aoList.ok ? sessionRows(aoList.payload) : [];
  const openPrs = ghOpenPrs.ok ? openPrRows(ghOpenPrs.payload) : [];
  const details = new Map<string, JsonObject>();
  const detailEligible = sessions.filter((session) => (
    sessionIsActiveWorker(session) && shouldEnrichSessionDetailFromGet(session)
  ));
  let detailAttemptCount = 0;
  let detailFailureCount = 0;
  const detailAttemptRows = detailEligible.slice(0, maxSessionDetails);
  const detailStartedAt = Date.now();
  for (const session of detailAttemptRows) {
    const remainingMs = detailDeadlineMs - (Date.now() - detailStartedAt);
    if (remainingMs <= 0) break;
    const id = sessionIdentifier(session);
    if (!id) continue;
    detailAttemptCount += 1;
    const observation = await observeJsonCommand(runner, {
      command: 'ao',
      args: ['session', 'get', id, '--json', '-p', project],
      env,
      inheritParentEnv: true,
      timeoutMs: Math.max(1, Math.min(sessionDetailTimeoutMs, remainingMs)),
    }, 'ao_session_get');
    if (!observation.ok) {
      detailFailureCount += 1;
      continue;
    }
    details.set(id, objectOrEmpty(observation.payload));
  }
  const detailElapsedMs = Date.now() - detailStartedAt;
  const detailSkippedByLimitCount = Math.max(0, detailEligible.length - detailAttemptRows.length);
  const detailSkippedByDeadlineCount = Math.max(0, detailAttemptRows.length - detailAttemptCount);

  let activeWorkerCount = 0;
  let openPrCandidateCount = 0;
  let listContractBindingCount = 0;
  let enrichedContractBindingCount = 0;
  let detailRecoveredCount = 0;
  let unresolvedExistingContractCount = 0;
  for (const session of sessions) {
    if (!sessionIsActiveWorker(session)) continue;
    activeWorkerCount += 1;
    const id = sessionIdentifier(session);
    const detail = id ? details.get(id) ?? null : null;
    const candidate = sessionCorrelatesToOpenPrCandidate(session, detail, openPrs);
    if (!candidate) continue;
    openPrCandidateCount += 1;
    const listBinding = existingContractBinding(session, null, openPrs);
    const enrichedBinding = existingContractBinding(session, detail, openPrs);
    const listCanBind = listBinding.bound && parseNumber(listBinding.prNumber) > 0;
    const enrichedCanBind = enrichedBinding.bound && parseNumber(enrichedBinding.prNumber) > 0;
    if (listCanBind) listContractBindingCount += 1;
    if (enrichedCanBind) enrichedContractBindingCount += 1;
    if (!listCanBind && enrichedCanBind) detailRecoveredCount += 1;
    if (!enrichedCanBind) unresolvedExistingContractCount += 1;
  }

  const commandEvidenceComplete = detailPolicyMatchesRuntime
    && aoList.ok
    && ghOpenPrs.ok
    && detailFailureCount === 0
    && detailSkippedByLimitCount === 0
    && detailSkippedByDeadlineCount === 0;
  const matrixCells = new Set<string>();
  if (workerStatus.state === 'empty') matrixCells.add('empty');
  if (workerStatus.state === 'populated-degraded' || workerStatus.state === 'populated-mixed') {
    matrixCells.add('populated-degraded');
  }
  if (workerStatus.usableCount > 0) matrixCells.add('populated-usable');
  if (!aoList.ok || !ghOpenPrs.ok || detailFailureCount > 0) matrixCells.add('silent-catch-swallow-candidate');
  if (!detailPolicyMatchesRuntime) matrixCells.add('session-detail-policy-mismatch');
  if (detailSkippedByLimitCount > 0 || detailSkippedByDeadlineCount > 0) matrixCells.add('session-detail-probe-incomplete');
  if (detailRecoveredCount > 0) matrixCells.add('never-invoked-session-detail-enrichment');
  if (commandEvidenceComplete && unresolvedExistingContractCount > 0) matrixCells.add('binding-contract-gap');

  const recommendedPath = !commandEvidenceComplete
    ? 'undetermined'
    : unresolvedExistingContractCount > 0
      ? 'B'
      : detailRecoveredCount > 0
        ? 'A'
        : 'undetermined';
  const usableRowPreconditionSatisfied = workerStatus.usableCount > 0;
  const missingProofs = [
    'dead-worker-reconcile live before/after decision trace',
    'Worker-Recovery live before/after cleanup-decision trace',
  ];
  if (!usableRowPreconditionSatisfied) {
    missingProofs.unshift('post-fix live non-degraded actionable worker-status row');
  }

  return {
    schemaVersion: 'worker-status-store-live-rca/v2',
    observedAt: new Date().toISOString(),
    sanitized: true,
    workerStatus,
    workerReport,
    commands: {
      aoSessionListOk: aoList.ok,
      ghOpenPrListOk: ghOpenPrs.ok,
      openPrLimit: OPEN_PR_LIMIT,
      runtimeDetailPolicy,
      appliedDetailPolicy: {
        maxCallsPerTick: maxSessionDetails,
        perCallTimeoutMs: sessionDetailTimeoutMs,
        globalDeadlineMs: detailDeadlineMs,
      },
      detailPolicyMatchesRuntime,
      detailEligibleCount: detailEligible.length,
      detailAttemptCount,
      detailFailureCount,
      detailSkippedByLimitCount,
      detailSkippedByDeadlineCount,
      detailElapsedMs,
      evidenceComplete: commandEvidenceComplete,
    },
    bindingEvidence: {
      sessionCount: sessions.length,
      activeWorkerCount,
      openPrCount: openPrs.length,
      openPrCandidateCount,
      listContractBindingCount,
      enrichedContractBindingCount,
      detailRecoveredCount,
      unresolvedExistingContractCount,
    },
    seedProcessLiveness: await processLiveness(runner, env),
    matrixCells: [...matrixCells].sort(),
    closure: {
      recommendedPath,
      usableRowPreconditionSatisfied,
      blockerCleared: false,
      migrationGateStatus: 'open',
      missingProofs,
      dependency: recommendedPath === 'B' ? BINDING_CONTRACT_DEPENDENCY : null,
      missingContract: recommendedPath === 'B'
        ? 'At least one active worker is correlated to an open PR by live head/branch/issue evidence, but the shipped resolver cannot bind it from explicit PR, corroborated numeric displayName, or unambiguous issue correlation.'
        : null,
    },
  };
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function nonNegativeIntegerArgument(args: string[], name: string): number | undefined {
  const raw = argumentValue(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await runWorkerStatusLiveRca({
    stateDir: argumentValue(args, '--state-dir'),
    project: argumentValue(args, '--project'),
    repoRoot: argumentValue(args, '--repo-root'),
    maxSessionDetails: nonNegativeIntegerArgument(args, '--max-session-details'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry && import.meta.url === entry) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`worker-status-store live RCA failed: ${message}\n`);
    process.exitCode = 1;
  });
}
