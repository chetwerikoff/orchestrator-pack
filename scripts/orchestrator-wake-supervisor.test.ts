import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runProcessSync } from './kernel/subprocess.ts';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProcessIdentity } from './lib/cutover/activation-cordon.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const observerBridge = path.join(repoRoot, 'scripts/lib/Orchestrator-WakeSupervisor.ps1');
const supervisorScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ts');

function runStatus(stateDir: string) {
  return runProcessSync({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      supervisorScript,
      'status',
      '--state-dir',
      stateDir,
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
}

describe('Issue #948 wake-supervisor observer bridge', () => {
  it('returns the canonical three-child registry without loading D928', () => {
    const command = [
      `. '${observerBridge.replaceAll("'", "''")}'`,
      '$rows = @(Get-OrchestratorWakeSupervisorChildRegistry)',
      '[ordered]@{ count = $rows.Count; ids = @($rows | ForEach-Object { $_.Id }) } | ConvertTo-Json -Compress',
    ].join('; ');
    const result = runProcessSync({
      command: 'pwsh', args: ['-NoProfile', '-Command', command], cwd: repoRoot,
      inheritParentEnv: true,
    });
    expect(result.ok, result.stderr || result.error).toBe(true);
    const payload = JSON.parse(result.stdout.trim()) as { count: number; ids: string[] };
    expect(payload.count).toBe(3);
    expect(payload.ids).toEqual([
      'review-trigger-reconcile',
      'review-trigger-reeval',
      'review-ready-report-state-seed',
    ]);
  });
});

describe('Issue #1484 truthful supervisor status', () => {
  it('accepts schema v2 only when supervisor and running child PID/startTicks both match', () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'opk-1484-status-'));
    try {
      const identity = readProcessIdentity(process.pid);
      const statusPath = path.join(stateDir, 'typescript-supervisor-status.json');
      const status = {
        schemaVersion: 2,
        supervisorPid: process.pid,
        supervisorStartTicks: identity.startTicks,
        childPid: process.pid,
        childStartTicks: identity.startTicks,
        restartState: 'running',
      };
      writeFileSync(statusPath, `${JSON.stringify(status)}\n`, 'utf8');
      const before = readFileSync(statusPath, 'utf8');

      const result = runStatus(stateDir);

      expect(result.ok, result.stderr || result.error).toBe(true);
      expect(JSON.parse(result.stdout.trim())).toEqual({ status });
      expect(readFileSync(statusPath, 'utf8')).toBe(before);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('fails closed on stale or PID-reused child identity without mutating status', () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'opk-1484-stale-child-'));
    try {
      const identity = readProcessIdentity(process.pid);
      const statusPath = path.join(stateDir, 'typescript-supervisor-status.json');
      const status = {
        schemaVersion: 2,
        supervisorPid: process.pid,
        supervisorStartTicks: identity.startTicks,
        childPid: process.pid,
        childStartTicks: `${identity.startTicks}-stale`,
        restartState: 'running',
      };
      writeFileSync(statusPath, `${JSON.stringify(status)}\n`, 'utf8');
      const before = readFileSync(statusPath, 'utf8');

      const result = runStatus(stateDir);

      expect(result.ok).toBe(false);
      expect(JSON.parse(result.stdout.trim())).toEqual({ status });
      expect(readFileSync(statusPath, 'utf8')).toBe(before);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('treats legacy schema v1 as non-live and performs no replacement effect', () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'opk-1484-v1-status-'));
    try {
      const identity = readProcessIdentity(process.pid);
      const statusPath = path.join(stateDir, 'typescript-supervisor-status.json');
      const status = {
        schemaVersion: 1,
        supervisorPid: process.pid,
        supervisorStartTicks: identity.startTicks,
        childPid: process.pid,
        restartState: 'running',
      };
      writeFileSync(statusPath, `${JSON.stringify(status)}\n`, 'utf8');
      const before = readFileSync(statusPath, 'utf8');

      const result = runStatus(stateDir);

      expect(result.ok).toBe(false);
      expect(JSON.parse(result.stdout.trim())).toEqual({ status });
      expect(readFileSync(statusPath, 'utf8')).toBe(before);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
