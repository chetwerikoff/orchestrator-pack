import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, accessSync, constants } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runProcess, type ProcessResult } from '../kernel/subprocess.ts';
import { TABLE, INVENTORY, RUNTIME_OUTPUTS, WORKFLOW_BLOB_SHA, WORKFLOW_CONTENT_SHA256, nativeOutput, workflowCoverage, workflowHashes, type Diagnostic, type NativeOutput, type Row, type RowId } from './contract.ts';

type Probe = Record<string, unknown>;
type GateFailure = { reason: string; diagnostic: Diagnostic; probe?: Probe };
const REPO = process.cwd();
const emptyNative = nativeOutput('selected-child');

function diagnostic(reason_code: string, path: string, expected: unknown, actual: unknown, remediation: string | null): Diagnostic {
  return { reason_code, path, expected, actual, remediation };
}
function streamText(value: unknown): string {
  return typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : '';
}
function rowBase(row_id: RowId): Row {
  return { row_id, selection: 'selected', applicability: 'applicable', termination: 'not_started', command_verdict: 'blocked', cleanup_status: 'not_required', snapshot_status: 'not_checked', reason_code: null, diagnostic: null, native_output: emptyNative };
}
function rowBlock(row: Row, reason: string, d: Diagnostic): void {
  row.reason_code = reason;
  row.diagnostic = d;
}
function outputMembers(root: string): string[] {
  return readdirSync(root).filter(name => /^\.vitest-runtime-report.*\.json(?:\.meta\.json)?$/.test(name)).sort();
}
function outputCensus(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const name of outputMembers(root)) {
    const bytes = readFileSync(join(root, name));
    result[name] = { exists: true, byte_length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  return result;
}
function status(root: string): string {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  return String(result.stdout ?? '');
}
function probeRecord(probe_id: string, kind: string, attribution: 'global' | 'row_local', affected_rows: string[] = []): Probe {
  return { probe_id, kind, attribution, affected_rows, execution_kind: 'in_process', execution: 'completed', probe_verdict: 'passed', diagnostic: null };
}
function blockedProbe(probe_id: string, kind: string, attribution: 'global' | 'row_local', affected_rows: string[], d: Diagnostic): Probe {
  return { probe_id, kind, attribution, affected_rows, execution_kind: 'in_process', execution: 'completed', probe_verdict: 'failed', diagnostic: { reason_code: 'preflight_probe_failed', subject: d.path, expected: d.expected, actual: d.actual, remediation: d.remediation } };
}
function globalFailure(reason: string, path: string, expected: unknown, actual: unknown, remediation: string | null, probe?: Probe): GateFailure {
  return { reason, diagnostic: diagnostic(reason, path, expected, actual, remediation), probe };
}
function checkRuntime(): GateFailure | undefined {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const npm = spawnSync('npm', ['--version'], { cwd: REPO, encoding: 'utf8' });
  const npmMajor = Number(String(npm.stdout ?? '').trim().split('.')[0]);
  if (process.platform !== 'linux' || process.arch !== 'x64' || nodeMajor !== 22 || npm.status !== 0 || npmMajor !== 10) {
    return globalFailure('unsupported_local_environment', 'node/npm runtime', { platform: 'linux', arch: 'x64', node_major: 22, npm_major: 10 }, { platform: process.platform, arch: process.arch, node_major: nodeMajor, npm_major: npmMajor }, 'Use Linux x86_64 with Node 22 and npm 10.');
  }
  for (const command of ['git', 'bash', 'pwsh']) {
    const found = spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
    if (found.status !== 0) return globalFailure('unsupported_local_environment', command, 'executable available', String(found.stderr ?? ''), `Install or expose ${command}.`);
  }
  try {
    const probe = join(REPO, `.ci-preflight-symlink-${process.pid}`);
    spawnSync('bash', ['-lc', `ln -s . "${probe}" && rm -f "${probe}"`], { cwd: REPO });
  } catch (error) {
    return globalFailure('unsupported_local_environment', REPO, 'symlink-capable filesystem', String(error), 'Use a symlink-capable checkout.');
  }
  return undefined;
}
function checkPaths(): GateFailure | undefined {
  for (const tableRow of TABLE) for (const path of tableRow.paths) {
    const full = join(REPO, path);
    if (!existsSync(full)) return globalFailure('preflight_input_missing_or_invalid', path, 'existing accessible path', 'missing', 'Restore the checked-in prerequisite.');
    try { accessSync(full, constants.R_OK); } catch (error) { return globalFailure('preflight_input_missing_or_invalid', path, 'readable', String(error), 'Restore access to the checked-in prerequisite.'); }
  }
  for (const path of ['package.json', 'package-lock.json', 'node_modules/.package-lock.json', 'tsconfig.base.json', 'scripts/vitest-ci-lanes.config.json']) {
    try { JSON.parse(readFileSync(join(REPO, path), 'utf8')); } catch (error) {
      if (path === 'tsconfig.base.json') continue;
      return globalFailure('preflight_input_missing_or_invalid', path, 'parseable checked-in configuration', String(error), 'Restore a valid configuration file.');
    }
  }
  for (const output of outputMembers(REPO)) return globalFailure('caller_owned_output', output, 'absent', outputCensus(REPO)[output], 'Remove or move the caller-owned runtime output.');
  return undefined;
}
function checkDependencies(): GateFailure | undefined {
  let pkg: any; let lock: any; let installed: any;
  try {
    pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
    installed = JSON.parse(readFileSync(join(REPO, 'node_modules/.package-lock.json'), 'utf8'));
  } catch (error) { return globalFailure('dependency_installation_invalid', 'package-lock.json', 'valid package and lockfile metadata', String(error), 'Restore the pre-existing lockfile installation.'); }
  if (lock.name !== pkg.name || lock.version !== pkg.version || installed.lockfileVersion !== lock.lockfileVersion) return globalFailure('dependency_installation_invalid', 'package-lock.json', { name: pkg.name, version: pkg.version, lockfileVersion: lock.lockfileVersion }, { name: lock.name, version: lock.version, lockfileVersion: installed.lockfileVersion }, 'Restore the matching pre-existing installation.');
  const census = spawnSync('npm', ['ls', '--all', '--include=dev', '--json', '--offline'], { cwd: REPO, encoding: 'utf8' });
  if (census.status !== 0) return globalFailure('dependency_installation_invalid', 'npm ls --all --include=dev --json', 'complete valid integrity census', { status: census.status, stdout: census.stdout, stderr: census.stderr }, 'Restore dependencies without installing from this command.');
  const pester = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Module -ListAvailable Pester | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty Version).ToString()'], { cwd: REPO, encoding: 'utf8' });
  if (pester.status !== 0 || !/^(?:5|[6-9]|[1-9]\d)\./.test(String(pester.stdout ?? '').trim())) return globalFailure('dependency_missing', 'Pester', '>= 5.0.0', { status: pester.status, stdout: pester.stdout, stderr: pester.stderr }, 'Install Pester >= 5 outside this command.');
  return undefined;
}
function checkDirectDependency(name: 'typescript' | 'vitest', rowId: '05' | '07'): GateFailure | undefined {
  const pkgPath = join(REPO, 'node_modules', name, 'package.json');
  const binPath = join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  try {
    const declared = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).devDependencies ?? {})[name];
    const installed = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    if (!declared || !installed || !existsSync(binPath)) return globalFailure('dependency_missing', `node_modules/${name}`, { declared, executable: true }, { installed, executable: existsSync(binPath) }, `Restore the local ${name} installation.`);
    const version = spawnSync(binPath, ['--version'], { cwd: REPO, encoding: 'utf8' });
    if (version.status !== 0 || !String(version.stdout ?? '').trim()) return globalFailure('dependency_incompatible', `node_modules/${name}`, { declared, executable: true }, { installed, status: version.status, stderr: version.stderr }, `Restore a compatible local ${name} executable.`);
    return undefined;
  } catch (error) {
    return globalFailure('dependency_missing', `node_modules/${name}`, { row: rowId }, String(error), `Restore the local ${name} installation.`);
  }
}
function processGroupObservation(pid: number | undefined): { pgid: number; observation: 'absent' | 'present' | 'probe_error'; errno: number | null } | null {
  if (!pid || process.platform === 'win32') return null;
  try { process.kill(-pid, 0); return { pgid: pid, observation: 'present', errno: null }; }
  catch (error: any) {
    if (error?.code === 'ESRCH') return { pgid: pid, observation: 'absent', errno: null };
    if (error?.code === 'EPERM') return { pgid: pid, observation: 'present', errno: error?.errno ?? null };
    return { pgid: pid, observation: 'probe_error', errno: error?.errno ?? null };
  }
}
async function execute(rowDef: typeof TABLE[number], env?: NodeJS.ProcessEnv): Promise<{ row: Row; pgid?: number }> {
  const row = rowBase(rowDef.row_id);
  let pgid: number | undefined;
  let result: ProcessResult;
  try {
    result = await runProcess({ command: rowDef.command, args: [...rowDef.args], cwd: REPO, env, inheritParentEnv: true, timeoutMs: rowDef.timeout, killGraceMs: rowDef.grace, allowEmptyStdout: true, onSpawn: pid => { pgid = pid; }, onStdoutChunk: () => undefined, onStderrChunk: () => undefined });
  } catch (error) {
    row.termination = 'spawn_failed'; row.reason_code = 'spawn_failed'; row.diagnostic = diagnostic('spawn_failed', rowDef.command, { outcome: 'exit' }, { outcome: 'spawn-failed', error: String(error) }, 'Restore the executable and retry.');
    return { row };
  }
  const stdout = streamText(result.stdout); const stderr = streamText(result.stderr);
  row.native_output = nativeOutput('selected-child', stdout, stderr);
  switch (result.outcome) {
    case 'timeout': row.termination = 'timed_out'; row.command_verdict = 'not_evaluated'; row.reason_code = 'timeout'; row.diagnostic = diagnostic('timeout', rowDef.command, { outcome: 'exit' }, { outcome: 'timeout', timeout_ms: rowDef.timeout }, 'Fix the check or increase its existing bounded runtime.'); break;
    case 'signal': row.termination = 'signaled'; row.command_verdict = 'failed'; row.reason_code = 'process_signaled'; row.diagnostic = diagnostic('process_signaled', rowDef.command, { outcome: 'exit', signal: null }, { outcome: 'signal', signal: result.signal, exit_code: null }, 'Investigate the terminating signal.'); break;
    case 'consumer-error': row.termination = 'consumer_error'; row.command_verdict = 'not_evaluated'; row.reason_code = 'subprocess_consumer_error'; row.diagnostic = diagnostic('subprocess_consumer_error', rowDef.command, { callback: 'normally returning' }, { outcome: 'consumer-error', error: result.error ?? '' }, 'Fix the subprocess output consumer.'); break;
    case 'spawn-failure': row.termination = 'spawn_failed'; row.reason_code = 'spawn_failed'; row.diagnostic = diagnostic('spawn_failed', rowDef.command, { outcome: 'exit' }, { outcome: 'spawn-failed', error: result.error ?? '' }, 'Restore the executable and retry.'); break;
    default:
      row.termination = result.signal ? 'signaled' : 'exited';
      row.command_verdict = row.termination === 'exited' && result.exitCode === 0 ? 'passed' : 'failed';
      if (row.command_verdict === 'failed') { row.reason_code = row.termination === 'signaled' ? 'process_signaled' : 'command_failed'; row.diagnostic = diagnostic(row.reason_code, rowDef.command, { exit_code: 0 }, { exit_code: result.exitCode, signal: result.signal }, 'Inspect the preserved native diagnostics.'); }
      break;
  }
  row.cleanup_status = 'clean';
  return { row, pgid };
}
function applyBlock(rows: Row[], reason: string, d: Diagnostic): void { for (const row of rows) rowBlock(row, reason, d); }
export async function runPreflight(repoRoot = REPO): Promise<Record<string, unknown>> {
  const rows = TABLE.map(row => rowBase(row.row_id));
  const probes: Probe[] = [];
  const global = checkRuntime();
  probes.push(global ? blockedProbe('probe.platform-tools', 'platform-tools', 'global', [], global.diagnostic) : probeRecord('probe.platform-tools', 'platform-tools', 'global'));
  const hashes = (() => { try { return workflowHashes(repoRoot); } catch (error) { return { blob: '', content: String(error) }; } })();
  const hashFailure = hashes.blob !== WORKFLOW_BLOB_SHA || hashes.content !== WORKFLOW_CONTENT_SHA256;
  const hashDiagnostic = diagnostic('workflow_inventory_stale', '.github/workflows/scope-guard.yml', { git_blob_sha: WORKFLOW_BLOB_SHA, content_sha256: WORKFLOW_CONTENT_SHA256 }, hashes, 'Restore the bound workflow revision.');
  probes.push(hashFailure ? blockedProbe('probe.workflow-hashes', 'workflow-hashes', 'global', [], hashDiagnostic) : probeRecord('probe.workflow-hashes', 'workflow-hashes', 'global'));
  const paths = global ?? (hashFailure ? globalFailure('workflow_inventory_stale', '.github/workflows/scope-guard.yml', hashDiagnostic.expected, hashDiagnostic.actual, hashDiagnostic.remediation) : checkPaths());
  probes.push(paths ? blockedProbe('probe.global-paths', 'global-paths', 'global', [], paths.diagnostic) : probeRecord('probe.global-paths', 'global-paths', 'global'));
  const outputs = paths ?? checkPaths();
  probes.push(outputs ? blockedProbe('probe.caller-outputs', 'caller-outputs', 'global', [], outputs.diagnostic) : probeRecord('probe.caller-outputs', 'caller-outputs', 'global'));
  const baselineStatus = status(repoRoot);
  const baselineFailure = baselineStatus ? globalFailure('dirty_worktree', repoRoot, '', baselineStatus, 'Clean caller changes before running preflight.') : undefined;
  probes.push(baselineFailure ? blockedProbe('probe.baseline', 'baseline', 'global', [], baselineFailure.diagnostic) : probeRecord('probe.baseline', 'baseline', 'global'));
  const deps = baselineFailure ?? paths ?? checkDependencies();
  probes.push(deps ? blockedProbe('probe.lockfile-root', 'lockfile-root', 'global', [], deps.diagnostic) : probeRecord('probe.lockfile-root', 'lockfile-root', 'global'));
  probes.push(deps ? blockedProbe('probe.npm-census', 'npm-integrity-census', 'global', [], deps.diagnostic) : probeRecord('probe.npm-census', 'npm-integrity-census', 'global'));
  probes.push(deps ? blockedProbe('probe.pester', 'pester-query', 'global', [], deps.diagnostic) : probeRecord('probe.pester', 'pester-query', 'global'));
  const typescript = deps ? undefined : checkDirectDependency('typescript', '05');
  const vitest = deps ? undefined : checkDirectDependency('vitest', '07');
  probes.push(typescript ? blockedProbe('probe.typescript-direct', 'typescript-direct', 'row_local', ['05'], typescript.diagnostic) : probeRecord('probe.typescript-direct', 'typescript-direct', 'row_local', ['05']));
  probes.push(vitest ? blockedProbe('probe.vitest-direct', 'vitest-direct', 'row_local', ['07'], vitest.diagnostic) : probeRecord('probe.vitest-direct', 'vitest-direct', 'row_local', ['07']));
  if (deps || global || hashFailure || paths || baselineFailure) {
    const failure = deps ?? global ?? (hashFailure ? globalFailure('workflow_inventory_stale', '.github/workflows/scope-guard.yml', hashDiagnostic.expected, hashDiagnostic.actual, hashDiagnostic.remediation) : paths ?? baselineFailure)!;
    applyBlock(rows, failure.reason, failure.diagnostic);
    return result(rows, probes, 'blocked', failure.reason, undefined, repoRoot);
  }
  const baselineOutputs = new Set(outputMembers(repoRoot));
  if (typescript) rowBlock(rows[4], typescript.reason, typescript.diagnostic);
  if (vitest) rowBlock(rows[5], vitest.reason, vitest.diagnostic);
  let finalIndex = -1;
  for (let i = 0; i < TABLE.length; i++) {
    if ((i === 4 && typescript) || (i === 5 && vitest)) continue;
    const env = TABLE[i].row_id === 'vitest.light-lane-all' ? Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^OPK_(?:VITEST_TOPOLOGY_PLAN_PATH|CHANGED_VITEST_FILES|VITEST_PR_SCOPE_MODE|.*PR.*|.*SCOPE.*)$/.test(key))) : undefined;
    const executed = await execute(TABLE[i], env);
    rows[i] = executed.row; if (executed.row.termination !== 'not_started') finalIndex = i;
    const pg = processGroupObservation(executed.pgid);
    if (pg?.observation === 'present' || pg?.observation === 'probe_error') {
      rows[i].cleanup_status = pg.observation === 'present' ? 'process_group_member_survived' : 'process_group_probe_error';
    }
  }
  for (const name of outputMembers(repoRoot)) baselineOutputs.add(name);
  for (const name of outputMembers(repoRoot)) if (!baselineOutputs.has(name)) unlinkSync(join(repoRoot, name));
  const changed = status(repoRoot) !== baselineStatus || outputMembers(repoRoot).some(name => !baselineOutputs.has(name));
  if (finalIndex >= 0) rows[finalIndex].snapshot_status = changed ? 'changed' : 'unchanged';
  const blocked = rows.find(row => row.command_verdict === 'blocked');
  const failed = rows.some(row => row.command_verdict === 'failed' || row.snapshot_status === 'changed');
  const summary = blocked ? 'blocked' : failed ? 'failed' : 'passed';
  return result(rows, probes, summary, blocked?.reason_code ?? rows.find(row => row.reason_code)?.reason_code ?? (changed ? 'snapshot_changed' : null), finalIndex >= 0 ? rows[finalIndex] : undefined, repoRoot, changed);
}
function result(rows: Row[], probes: Probe[], summary: 'passed' | 'failed' | 'blocked', reason: string | null, carrier?: Row, repoRoot = REPO, changed = false): Record<string, unknown> {
  const entries = rows.filter(row => row.diagnostic).map(row => ({ row_id: row.row_id, phase: 'row', diagnostic: row.diagnostic }));
  if (carrier && changed) entries.push({ row_id: carrier.row_id, phase: 'run_final', diagnostic: diagnostic('snapshot_changed', repoRoot, { status: '', outputs: {} }, { status: status(repoRoot), outputs: outputCensus(repoRoot) }, 'Remove caller-visible changes; this command never restores them.') });
  return { schema: 'ci-preflight-result/v1', summary, summary_reason: reason, exit_code: summary === 'passed' ? 0 : summary === 'blocked' ? 2 : 1, rows, probes: { schema: 'ci-preflight-probes/v1', records: probes }, diagnostics: { schema: 'ci-preflight-diagnostics/v1', entries }, workflow_coverage: workflowCoverage() };
}
if (import.meta.main) {
  runPreflight().then(value => { process.stdout.write(`${JSON.stringify(value)}\n`); process.exitCode = Number(value.exit_code); }).catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
}
