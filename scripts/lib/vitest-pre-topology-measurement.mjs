import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseVitestReportFile } from './vitest-json-report.mjs';

// Issue #695 bounded same-run producer: one ordered invocation, at most 12 files,
// and a seven-minute wall so the ten-minute topology job retains cleanup/output time.
export const PRE_TOPOLOGY_MAX_FILES = 12;
export const PRE_TOPOLOGY_TIMEOUT_MS = 7 * 60 * 1000;

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

function buildHarnessEnvironment(repoRoot, harnessRoot) {
  const env = { ...process.env };
  delete env.VITEST_CI_LIGHT_LANE;
  const inboxDir = join(harnessRoot, 'operator-inbox');
  const healthDir = join(harnessRoot, 'health-spool');
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(healthDir, { recursive: true });
  return {
    ...env,
    CI: 'true',
    OPK_VITEST_HARNESS: '1',
    OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
    AO_ORCHESTRATOR_ESCALATION_STATE: join(harnessRoot, 'escalation-state.json'),
    AO_OPERATOR_ESCALATION_INBOX: inboxDir,
    AO_ESCALATION_HEALTH_SPOOL: healthDir,
  };
}

export function measurePreTopologyFiles(repoRoot, files, options = {}) {
  if (files.length === 0) return {};
  const timeoutMs = Number(options.timeoutMs ?? PRE_TOPOLOGY_TIMEOUT_MS);
  const root = mkdtempSync(join(tmpdir(), 'opk-pre-topology-'));
  const reportPath = join(root, 'vitest-pre-topology.json');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = [
    'test',
    '--',
    ...files,
    '--reporter=json',
    `--outputFile=${reportPath}`,
  ];
  try {
    const result = spawnSync(npm, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: buildHarnessEnvironment(repoRoot, root),
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) {
      const timedOut = result.error.code === 'ETIMEDOUT';
      throw new Error(
        timedOut
          ? `pre-topology measurement timed out after ${timeoutMs}ms for: ${files.join(', ')}`
          : `pre-topology measurement failed to start: ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-4000);
      let report = '';
      if (existsSync(reportPath)) {
        try {
          report = readFileSync(reportPath, 'utf8').slice(-20000);
        } catch {
          report = '<report unreadable>';
        }
      }
      throw new Error(
        `pre-topology measurement tests failed (exit ${result.status}) for: ${files.join(', ')}\n${output}\nREPORT:\n${report}`,
      );
    }
    if (!existsSync(reportPath)) {
      throw new Error('pre-topology measurement completed without a Vitest JSON report');
    }
    const parsed = parseVitestReportFile(reportPath, repoRoot);
    if (!parsed || !Array.isArray(parsed.files)) {
      throw new Error('pre-topology measurement report is unreadable');
    }
    const measurements = {};
    for (const entry of parsed.files) {
      const file = String(entry.file ?? '').replace(/\\/g, '/');
      const durationMs = Number(entry.durationMs);
      if (files.includes(file) && Number.isFinite(durationMs) && durationMs >= 0) {
        measurements[file] = Math.max(0.001, durationMs / 1000);
      }
    }
    const missing = files.filter((file) => !Object.prototype.hasOwnProperty.call(measurements, file));
    if (missing.length > 0) {
      throw new Error(`pre-topology measurement report omitted: ${missing.join(', ')}`);
    }
    process.stderr.write(
      `[pre-topology] measured ${files.length} changed/stale Vitest file(s) in one bounded run\n`,
    );
    return measurements;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
