import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseVitestReportFile } from './vitest-json-report.mjs';

// Issue #695 bounded same-run producer: at most 12 files, at most three isolated
// Vitest processes, and a seven-minute wall so the ten-minute topology job retains
// cleanup/output time. Isolated processes prevent one long wallclock suite from
// serially blocking fresh measurements for unrelated changed files.
export const PRE_TOPOLOGY_MAX_FILES = 12;
export const PRE_TOPOLOGY_MAX_CONCURRENCY = 3;
export const PRE_TOPOLOGY_TIMEOUT_MS = 7 * 60 * 1000;
const PRE_TOPOLOGY_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function shouldMeasurePreTopology(repoRoot, options = {}) {
  if (options.preTopologyMeasurements || process.env.OPK_DISABLE_PRE_TOPOLOGY_MEASUREMENT === '1') {
    return false;
  }
  if (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID) {
    return false;
  }
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

function buildHarnessEnvironment(harnessRoot) {
  const env = { ...process.env };
  delete env.VITEST_CI_LIGHT_LANE;
  const inboxDir = join(harnessRoot, 'operator-inbox');
  const healthDir = join(harnessRoot, 'health-spool');
  const leaseDir = join(harnessRoot, 'fleet-leases');
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(healthDir, { recursive: true });
  mkdirSync(leaseDir, { recursive: true });
  return {
    ...env,
    CI: 'true',
    OPK_VITEST_HARNESS: '1',
    OPK_TESTMODE_FLEET_WORKSPACE_ROOT: harnessRoot,
    OPK_TESTMODE_LEASE_ROOT: leaseDir,
    AO_ORCHESTRATOR_ESCALATION_STATE: join(harnessRoot, 'escalation-state.json'),
    AO_OPERATOR_ESCALATION_INBOX: inboxDir,
    AO_ESCALATION_HEALTH_SPOOL: healthDir,
  };
}

function killProcessTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Process already exited.
    }
  }
}

function runPreTopologyFile(repoRoot, file, root, index, timeoutMs) {
  const runRoot = join(root, `run-${String(index + 1).padStart(2, '0')}`);
  mkdirSync(runRoot, { recursive: true });
  const reportPath = join(runRoot, 'vitest-pre-topology.json');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = [
    'test',
    '--',
    file,
    '--reporter=json',
    `--outputFile=${reportPath}`,
  ];

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(npm, args, {
      cwd: repoRoot,
      env: buildHarnessEnvironment(runRoot),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (target, chunk) => {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text, 'utf8');
      if (outputBytes > PRE_TOPOLOGY_MAX_OUTPUT_BYTES) {
        overflow = true;
        killProcessTree(child);
        return target;
      }
      return target + text;
    };

    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

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

      if (overflow) {
        reject(new Error(`pre-topology measurement output exceeded ${PRE_TOPOLOGY_MAX_OUTPUT_BYTES} bytes for: ${file}`));
        return;
      }
      if (timedOut) {
        reject(new Error(`pre-topology measurement timed out after ${timeoutMs}ms for: ${file}`));
        return;
      }
      if (status !== 0) {
        const output = `${stdout}\n${stderr}`.trim().slice(-4000);
        reject(new Error(
          `pre-topology measurement tests failed (exit ${status}, signal ${signal ?? 'none'}) for: ${file}\n${output}`,
        ));
        return;
      }
      if (!existsSync(reportPath)) {
        reject(new Error(`pre-topology measurement completed without a Vitest JSON report for: ${file}`));
        return;
      }

      try {
        const parsed = parseVitestReportFile(reportPath, repoRoot);
        const entry = parsed?.files?.find(
          (candidate) => String(candidate.file ?? '').replace(/\\/g, '/') === file,
        );
        const durationMs = Number(entry?.durationMs);
        if (!entry || !Number.isFinite(durationMs) || durationMs < 0) {
          reject(new Error(`pre-topology measurement report omitted: ${file}`));
          return;
        }
        resolve([file, Math.max(0.001, durationMs / 1000)]);
      } catch (error) {
        reject(new Error(
          `pre-topology measurement report is unreadable for ${file}: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    });
  });
}

export async function measurePreTopologyFiles(repoRoot, files, options = {}) {
  if (files.length === 0) return {};
  const timeoutMs = Number(options.timeoutMs ?? PRE_TOPOLOGY_TIMEOUT_MS);
  const maxConcurrency = Math.max(
    1,
    Math.min(Number(options.maxConcurrency ?? PRE_TOPOLOGY_MAX_CONCURRENCY), files.length),
  );
  const root = mkdtempSync(join(tmpdir(), 'opk-pre-topology-'));

  try {
    const results = new Array(files.length);
    let nextIndex = 0;
    const workers = Array.from({ length: maxConcurrency }, async () => {
      while (nextIndex < files.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await runPreTopologyFile(repoRoot, files[index], root, index, timeoutMs);
      }
    });
    const settlements = await Promise.allSettled(workers);
    const failure = settlements.find((entry) => entry.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }

    const measurements = Object.fromEntries(results);
    process.stderr.write(
      `[pre-topology] measured ${files.length} changed/stale Vitest file(s) with ${maxConcurrency} isolated worker(s)\n`,
    );
    return measurements;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
