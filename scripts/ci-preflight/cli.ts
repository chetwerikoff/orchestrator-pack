import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, accessSync, constants } from 'node:fs';
import { join, relative } from 'node:path';
import { runProcess, runProcessSync, type ProcessResult } from '../kernel/subprocess.ts';
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
  const result = runProcessSync({ command: 'git', args: ['status', '--porcelain=v1', '--untracked-files=all'], cwd: root, inheritParentEnv: true });
  return String(result.stdout ?? '');
}
function probeRecord(probe_id: string, kind: string, attribution: 'global' | 'row_local', affected_rows: string[] = []): Probe {
  return { probe_id, kind, attribution, affected_rows, execution_kind: 'in_process', execution: 'completed', probe_verdict: 'passed', diagnostic: null };
}
function blockedProbe(probe_id: string, kind: string, attribution: 'global' | 'row_local', affected_rows: string[], d: Diagnostic): Probe {
  return { probe_id, kind, attribution, affected_rows, execution_kind: 'in_process', execution: 'completed', probe_verdict: 'failed', diagnostic: { reason_code: 'preflight_probe_failed', subject: d.path, expected: d.expected, actual: d.actual, remediation: d.remediation } };
}
function notStartedProbe(probe_id: string, kind: string, attribution: 'global' | 'row_local', affected_rows: string[] = []): Probe {
  return { probe_id, kind, attribution, affected_rows, execution_kind: 'in_process', execution: 'not_started', probe_verdict: 'blocked', diagnostic: null };
}
function globalFailure(reason: string, path: string, expected: unknown, actual: unknown, remediation: string | null, probe?: Probe): GateFailure {
  return { reason, diagnostic: diagnostic(reason, path, expected, actual, remediation), probe };
}
function checkRuntime(root = REPO): GateFailure | undefined {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const npm = runProcessSync({ command: 'npm', args: ['--version'], cwd: root, inheritParentEnv: true });
  const npmMajor = Number(String(npm.stdout ?? '').trim().split('.')[0]);
  if (process.platform !== 'linux' || process.arch !== 'x64' || nodeMajor !== 22 || !npm.ok || npmMajor !== 10) {
    return globalFailure('unsupported_local_environment', 'node/npm runtime', { platform: 'linux', arch: 'x64', node_major: 22, npm_major: 10 }, { platform: process.platform, arch: process.arch, node_major: nodeMajor, npm_major: npmMajor }, 'Use Linux x86_64 with Node 22 and npm 10.');
  }
  for (const command of ['git', 'bash', 'pwsh']) {
    const found = runProcessSync({ command: 'bash', args: ['-lc', `command -v ${command}`], cwd: root, inheritParentEnv: true });
    if (!found.ok) return globalFailure('unsupported_local_environment', command, 'executable available', String(found.stderr ?? ''), `Install or expose ${command}.`);
  }
  try {
    const probe = join(root, `.ci-preflight-symlink-${process.pid}`);
    const link = runProcessSync({ command: 'bash', args: ['-lc', `ln -s . "${probe}" && rm -f "${probe}"`], cwd: root, inheritParentEnv: true });
    if (!link.ok) return globalFailure('unsupported_local_environment', root, 'symlink-capable filesystem', String(link.stderr ?? ''), 'Use a symlink-capable checkout.');
  } catch (error) {
    return globalFailure('unsupported_local_environment', REPO, 'symlink-capable filesystem', String(error), 'Use a symlink-capable checkout.');
  }
  return undefined;
}
function checkPaths(root = REPO): GateFailure | undefined {
  for (const tableRow of TABLE) for (const path of tableRow.paths) {
    const full = join(root, path);
    if (!existsSync(full)) return globalFailure('preflight_input_missing_or_invalid', path, 'existing accessible path', 'missing', 'Restore the checked-in prerequisite.');
    try { accessSync(full, constants.R_OK); } catch (error) { return globalFailure('preflight_input_missing_or_invalid', path, 'readable', String(error), 'Restore access to the checked-in prerequisite.'); }
  }
  for (const path of ['package.json', 'package-lock.json', 'node_modules/.package-lock.json', 'tsconfig.base.json', 'scripts/vitest-ci-lanes.config.json']) {
    try { JSON.parse(readFileSync(join(root, path), 'utf8')); } catch (error) {
      if (path === 'tsconfig.base.json') continue;
      return globalFailure('preflight_input_missing_or_invalid', path, 'parseable checked-in configuration', String(error), 'Restore a valid configuration file.');
    }
  }
  for (const output of outputMembers(root)) return globalFailure('caller_owned_output', output, 'absent', outputCensus(root)[output], 'Remove or move the caller-owned runtime output.');
  return undefined;
}
function checkDependencies(root = REPO): GateFailure | undefined {
  let pkg: any; let lock: any; let installed: any;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    installed = JSON.parse(readFileSync(join(root, 'node_modules/.package-lock.json'), 'utf8'));
  } catch (error) { return globalFailure('dependency_installation_invalid', 'package-lock.json', 'valid package and lockfile metadata', String(error), 'Restore the pre-existing lockfile installation.'); }
  if (lock.name !== pkg.name || lock.version !== pkg.version || installed.lockfileVersion !== lock.lockfileVersion) return globalFailure('dependency_installation_invalid', 'package-lock.json', { name: pkg.name, version: pkg.version, lockfileVersion: lock.lockfileVersion }, { name: lock.name, version: lock.version, lockfileVersion: installed.lockfileVersion }, 'Restore the matching pre-existing installation.');
  const census = runProcessSync({ command: 'npm', args: ['ls', '--all', '--include=dev', '--json', '--offline'], cwd: root, inheritParentEnv: true });
  if (!census.ok) return globalFailure('dependency_installation_invalid', 'npm ls --all --include=dev --json', 'complete valid integrity census', { status: census.exitCode, stdout: census.stdout, stderr: census.stderr }, 'Restore dependencies without installing from this command.');
  const pester = runProcessSync({ command: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', '(Get-Module -ListAvailable Pester | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty Version).ToString()'], cwd: root, inheritParentEnv: true });
  if (!pester.ok || !/^(?:5|[6-9]|[1-9]\d)\./.test(String(pester.stdout ?? '').trim())) return globalFailure('dependency_missing', 'Pester', '>= 5.0.0', { status: pester.exitCode, stdout: pester.stdout, stderr: pester.stderr }, 'Install Pester >= 5 outside this command.');
  return undefined;
}
function checkDirectDependency(name: 'typescript' | 'vitest', rowId: '05' | '07', root = REPO): GateFailure | undefined {
  const pkgPath = join(root, 'node_modules', name, 'package.json');
  const binPath = join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  try {
    const declared = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies ?? {})[name];
    const installed = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages?.[`node_modules/${name}`]?.version;
    if (!declared || !installed || !existsSync(binPath)) return globalFailure('dependency_missing', `node_modules/${name}`, { declared, lockfile: lock, executable: true }, { installed, lockfile: lock, executable: existsSync(binPath) }, `Restore the local ${name} installation.`);
    if (installed !== lock || !satisfiesRange(installed, declared)) return globalFailure('dependency_incompatible', `node_modules/${name}`, { declared, lockfile: lock }, { installed, lockfile: lock }, `Restore a compatible local ${name} executable.`);
    const version = runProcessSync({ command: binPath, args: ['--version'], cwd: root, inheritParentEnv: true });
    if (!version.ok || !String(version.stdout ?? '').trim()) return globalFailure('dependency_incompatible', `node_modules/${name}`, { declared, executable: true }, { installed, status: version.exitCode, stderr: version.stderr }, `Restore a compatible local ${name} executable.`);
    return undefined;
  } catch (error) {
    return globalFailure('dependency_missing', `node_modules/${name}`, { row: rowId }, String(error), `Restore the local ${name} installation.`);
  }
}
function satisfiesRange(version: string, range: string): boolean {
  const actual = version.split('.').map(Number);
  const match = range.match(/([~^]?)(\d+)\.(\d+)\.(\d+)/);
  if (!match || actual.some(Number.isNaN)) return range === '*' || range === version;
  const [, operator, major, minor, patch] = match;
  const expected = [Number(major), Number(minor), Number(patch)];
  const compare = actual[0] - expected[0] || actual[1] - expected[1] || actual[2] - expected[2];
  if (compare < 0) return false;
  if (operator === '^') return actual[0] === expected[0];
  if (operator === '~') return actual[0] === expected[0] && actual[1] === expected[1];
  return actual.every((part, index) => part === expected[index]);
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
async function execute(rowDef: typeof TABLE[number], root = REPO, env?: NodeJS.ProcessEnv, inheritParentEnv = true): Promise<{ row: Row; pgid?: number }> {
  const row = rowBase(rowDef.row_id);
  let pgid: number | undefined;
  let result: ProcessResult;
  try {
    result = await runProcess({ command: rowDef.command, args: [...rowDef.args], cwd: root, env, inheritParentEnv, timeoutMs: rowDef.timeout, killGraceMs: rowDef.grace, allowEmptyStdout: true, onSpawn: pid => { pgid = pid; }, onStdoutChunk: () => undefined, onStderrChunk: () => undefined });
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
function vitestChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'PSModulePath', 'POWERSHELL_TELEMETRY_OPTOUT', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT'];
  return Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}
export async function runPreflight(repoRoot = REPO): Promise<Record<string, unknown>> {
  const rows = TABLE.map(row => rowBase(row.row_id));
  const probes: Probe[] = [];
  const global = checkRuntime(repoRoot);
  probes.push(global ? blockedProbe('probe.platform-tools', 'platform-tools', 'global', [], global.diagnostic) : probeRecord('probe.platform-tools', 'platform-tools', 'global'));
  const hashes = (() => { try { return workflowHashes(repoRoot); } catch (error) { return { blob: '', content: String(error) }; } })();
  const hashFailure = hashes.blob !== WORKFLOW_BLOB_SHA || hashes.content !== WORKFLOW_CONTENT_SHA256;
  const hashDiagnostic = diagnostic('workflow_inventory_stale', '.github/workflows/scope-guard.yml', { git_blob_sha: WORKFLOW_BLOB_SHA, content_sha256: WORKFLOW_CONTENT_SHA256 }, hashes, 'Restore the bound workflow revision.');
  probes.push(hashFailure ? blockedProbe('probe.workflow-hashes', 'workflow-hashes', 'global', [], hashDiagnostic) : probeRecord('probe.workflow-hashes', 'workflow-hashes', 'global'));
  const paths = global ?? (hashFailure ? globalFailure('workflow_inventory_stale', '.github/workflows/scope-guard.yml', hashDiagnostic.expected, hashDiagnostic.actual, hashDiagnostic.remediation) : checkPaths(repoRoot));
  probes.push(global || hashFailure ? notStartedProbe('probe.global-paths', 'global-paths', 'global') : paths ? blockedProbe('probe.global-paths', 'global-paths', 'global', [], paths.diagnostic) : probeRecord('probe.global-paths', 'global-paths', 'global'));
  const outputs = paths ?? checkPaths(repoRoot);
  probes.push(global || hashFailure || paths ? notStartedProbe('probe.caller-outputs', 'caller-outputs', 'global') : outputs ? blockedProbe('probe.caller-outputs', 'caller-outputs', 'global', [], outputs.diagnostic) : probeRecord('probe.caller-outputs', 'caller-outputs', 'global'));
  const baselineStatus = status(repoRoot);
  const baselineFailure = baselineStatus ? globalFailure('dirty_worktree', repoRoot, '', baselineStatus, 'Clean caller changes before running preflight.') : undefined;
  probes.push(global || hashFailure || paths || outputs ? notStartedProbe('probe.baseline', 'baseline', 'global') : baselineFailure ? blockedProbe('probe.baseline', 'baseline', 'global', [], baselineFailure.diagnostic) : probeRecord('probe.baseline', 'baseline', 'global'));
  const deps = baselineFailure ?? paths ?? checkDependencies(repoRoot);
  probes.push(global || hashFailure || paths || outputs || baselineFailure ? notStartedProbe('probe.lockfile-root', 'lockfile-root', 'global') : deps ? blockedProbe('probe.lockfile-root', 'lockfile-root', 'global', [], deps.diagnostic) : probeRecord('probe.lockfile-root', 'lockfile-root', 'global'));
  probes.push(global || hashFailure || paths || outputs || baselineFailure || deps ? notStartedProbe('probe.npm-census', 'npm-integrity-census', 'global') : probeRecord('probe.npm-census', 'npm-integrity-census', 'global'));
  probes.push(global || hashFailure || paths || outputs || baselineFailure || deps ? notStartedProbe('probe.pester', 'pester-query', 'global') : probeRecord('probe.pester', 'pester-query', 'global'));
  const typescript = deps ? undefined : checkDirectDependency('typescript', '05', repoRoot);
  const vitest = deps ? undefined : checkDirectDependency('vitest', '07', repoRoot);
  const preflightBlocked = Boolean(global || hashFailure || paths || outputs || baselineFailure || deps);
  probes.push(preflightBlocked ? notStartedProbe('probe.typescript-direct', 'typescript-direct', 'row_local', ['05']) : typescript ? blockedProbe('probe.typescript-direct', 'typescript-direct', 'row_local', ['05'], typescript.diagnostic) : probeRecord('probe.typescript-direct', 'typescript-direct', 'row_local', ['05']));
  probes.push(preflightBlocked ? notStartedProbe('probe.vitest-direct', 'vitest-direct', 'row_local', ['07']) : vitest ? blockedProbe('probe.vitest-direct', 'vitest-direct', 'row_local', ['07'], vitest.diagnostic) : probeRecord('probe.vitest-direct', 'vitest-direct', 'row_local', ['07']));
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
    const env = TABLE[i].row_id === 'vitest.light-lane-all' ? vitestChildEnvironment() : undefined;
    const inheritParentEnv = TABLE[i].row_id !== 'vitest.light-lane-all';
    const executed = await execute(TABLE[i], repoRoot, env, inheritParentEnv);
    rows[i] = executed.row; if (executed.row.termination !== 'not_started') finalIndex = i;
    const pg = processGroupObservation(executed.pgid);
    if (pg?.observation === 'present' || pg?.observation === 'probe_error') {
      rows[i].cleanup_status = pg.observation === 'present' ? 'process_group_member_survived' : 'process_group_probe_error';
    }
  }
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
