import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseVitestReportFile } from './vitest-json-report.mjs';

export const PRE_TOPOLOGY_MAX_FILES = 32;
export const PRE_TOPOLOGY_MAX_CONCURRENCY = 3;
export const PRE_TOPOLOGY_MEASUREMENT_ESTIMATES = Object.freeze({
  // This light-lane manifest self-test observes generated repository artifacts.
  // The topology emitter rewrites scripts/vitest-heavy-topology.plan.json before
  // measurement, so timing it inside the pre-topology pass can create manifest
  // drift that the real light lane correctly owns.
  'scripts/reachability-purge.test.ts': 120,
});
// The longest known changed wallclock suite is about 430 seconds. Keep the
// producer bounded at eight minutes per file so the topology job remains
// bounded while fleet-sensitive measurements stay on one serialized lane.
export const PRE_TOPOLOGY_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function requiresExclusiveFleetMeasurement(file) {
  return /(?:^|\/)(?:testmode-fleet|supervisor-|orchestrator-wake-supervisor)/.test(file);
}

export function shouldMeasurePreTopology(repoRoot, options = {}) {
  if (options.preTopologyMeasurements || process.env.OPK_DISABLE_PRE_TOPOLOGY_MEASUREMENT === '1') return false;
  if (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID) return false;
  return existsSync(join(repoRoot, '.git'));
}

export function resolvePreTopologyMeasurementTargets(result, options = {}) {
  const maxFiles = Number(options.maxFiles ?? PRE_TOPOLOGY_MAX_FILES);
  const targets = [...new Set(
    (result?.topology?.unresolvedGuardWeights ?? [])
      .map((entry) => String(entry?.file ?? '').replace(/\\/g, '/'))
      .filter((file) => file.endsWith('.test.ts')),
  )].sort();
  if (targets.length > maxFiles) {
    throw new Error(
      `pre-topology measurement bound exceeded: ${targets.length} files > ${maxFiles}; ` +
      'split the change or refresh measured runtime history',
    );
  }
  return targets;
}

export function resolvePreTopologyMeasurementPlan(result, options = {}) {
  const allTargets = resolvePreTopologyMeasurementTargets(result, options);
  const classification = result?.config?.classification ?? result?.lanesConfig?.classification ?? {};
  const measurements = {};
  const targets = [];
  for (const file of allTargets) {
    const estimate = PRE_TOPOLOGY_MEASUREMENT_ESTIMATES[file];
    if (classification[file] === 'light' && Number.isFinite(estimate) && estimate > 0) {
      measurements[file] = estimate;
      continue;
    }
    targets.push(file);
  }
  return { targets, measurements, allTargets };
}

function buildHarnessEnvironment(repoRoot, runRoot) {
  const env = { ...process.env };
  delete env.VITEST_CI_LIGHT_LANE;
  const inboxDir = join(runRoot, 'operator-inbox');
  const healthDir = join(runRoot, 'health-spool');
  const leaseDir = join(runRoot, 'fleet-leases');
  for (const dir of [inboxDir, healthDir, leaseDir]) mkdirSync(dir, { recursive: true });
  return {
    ...env,
    CI: 'true',
    OPK_VITEST_PRE_TOPOLOGY_MEASUREMENT: '1',
    OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
    OPK_TESTMODE_LEASE_ROOT: leaseDir,
    AO_ORCHESTRATOR_ESCALATION_STATE: join(runRoot, 'escalation-state.json'),
    AO_OPERATOR_ESCALATION_INBOX: inboxDir,
    AO_ESCALATION_HEALTH_SPOOL: healthDir,
  };
}

function killProcessTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
}

function readFailureReportSummary(reportPath) {
  if (!existsSync(reportPath)) return '';
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const failures = (report.testResults ?? []).flatMap((result) => (
      (result.assertionResults ?? [])
        .filter((assertion) => assertion.status === 'failed')
        .map((assertion) => ({
          fullName: assertion.fullName,
          failureMessages: assertion.failureMessages,
        }))
    ));
    return failures.length > 0 ? JSON.stringify({ failures }) : '';
  } catch (error) {
    return `Vitest failure report was unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function measureFile(repoRoot, file, root, index, timeoutMs) {
  const runRoot = join(root, `run-${String(index + 1).padStart(2, '0')}`);
  mkdirSync(runRoot, { recursive: true });
  const reportPath = join(runRoot, 'vitest-pre-topology.json');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['test', '--', file, '--reporter=json', `--outputFile=${reportPath}`];

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(npm, args, {
      cwd: repoRoot,
      env: buildHarnessEnvironment(repoRoot, runRoot),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (target, chunk) => {
      const text = chunk.toString();
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        killProcessTree(child);
        return target;
      }
      return target + text;
    };
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`pre-topology measurement failed to start for ${file}: ${error.message}`));
    });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (overflow) return reject(new Error(`pre-topology measurement output exceeded ${MAX_OUTPUT_BYTES} bytes for: ${file}`));
      if (timedOut) return reject(new Error(`pre-topology measurement timed out after ${timeoutMs}ms for: ${file}`));
      if (status !== 0) {
        const report = readFailureReportSummary(reportPath);
        const output = `${stdout}\n${stderr}\n${report}`.trim().slice(-8000);
        return reject(new Error(`pre-topology measurement tests failed (exit ${status}, signal ${signal ?? 'none'}) for: ${file}\n${output}`));
      }
      if (!existsSync(reportPath)) return reject(new Error(`pre-topology measurement completed without a Vitest JSON report for: ${file}`));
      try {
        const parsed = parseVitestReportFile(reportPath, repoRoot);
        const entry = parsed?.files?.find((candidate) => String(candidate.file ?? '').replace(/\\/g, '/') === file);
        const durationMs = Number(entry?.durationMs);
        if (!entry || !Number.isFinite(durationMs) || durationMs < 0) {
          return reject(new Error(`pre-topology measurement report omitted: ${file}`));
        }
        resolve([file, Math.max(0.001, durationMs / 1000)]);
      } catch (error) {
        reject(new Error(`pre-topology measurement report is unreadable for ${file}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

export async function measurePreTopologyFiles(repoRoot, files, options = {}) {
  if (files.length === 0) return {};
  const timeoutMs = Number(options.timeoutMs ?? PRE_TOPOLOGY_TIMEOUT_MS);
  const concurrency = Math.max(1, Math.min(Number(options.maxConcurrency ?? PRE_TOPOLOGY_MAX_CONCURRENCY), files.length));
  const root = mkdtempSync(join(tmpdir(), 'opk-pre-topology-'));
  try {
    const results = new Array(files.length);
    const runQueue = async (indexes) => {
      while (indexes.length > 0) {
        const index = indexes.shift();
        results[index] = await measureFile(repoRoot, files[index], root, index, timeoutMs);
      }
    };
    const allIndexes = files.map((_, index) => index);
    const exclusiveIndexes = allIndexes.filter((index) => requiresExclusiveFleetMeasurement(files[index]));
    const regularIndexes = allIndexes.filter((index) => !requiresExclusiveFleetMeasurement(files[index]));
    const workers = concurrency === 1 || exclusiveIndexes.length === 0
      ? Array.from({ length: concurrency }, () => runQueue(allIndexes))
      : [
          runQueue(exclusiveIndexes),
          ...Array.from({ length: concurrency - 1 }, () => runQueue(regularIndexes)),
        ];
    const settlements = await Promise.allSettled(workers);
    const failure = settlements.find((entry) => entry.status === 'rejected');
    if (failure) throw failure.reason;
    process.stderr.write(`[pre-topology] measured ${files.length} changed/stale Vitest file(s) with ${concurrency} isolated worker(s)\n`);
    return Object.fromEntries(results);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
