import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { managedChildRoles as survivors } from './supervisor-recovery.test-helpers.js';

const repoRoot = join(import.meta.dirname, '..');
const guardPath = join(repoRoot, 'scripts', 'check-vestigial-fleet-children-retired.ps1');
const launchContractPath = join(repoRoot, 'scripts', 'check-side-process-launch-contract.ps1');
const survivorSmokePath = join(repoRoot, 'scripts', 'side-process-launch-contract.test.ts');
const listenerEvidencePath = join(
  repoRoot,
  'tests',
  'fixtures',
  'listener-disposition',
  'retire.json',
);
const retired = [
  ['review-run-recovery', 'review-run-recovery.ps1', 'review-run-recovery-side-effect.lock'],
  ['review-stuck-run-reaper', 'review-stuck-run-reaper.ps1', 'review-stuck-run-reaper-side-effect.lock'],
  ['review-finding-delivery-confirm', 'review-finding-delivery-confirm.ps1', 'delivery-confirm-side-effect.lock'],
  ['ci-failure-notification-reaction', 'ci-failure-notification-reaction.ps1', ''],
  ['listener', 'orchestrator-wake-listener.ps1', 'listener-side-effect.lock'],
] as const;
type GuardResult = {
  status: 'pass' | 'fail';
  retiredChildIds?: string[];
  listenerDisposition?: string;
  expectedNegativeCases?: number;
  negativeCases?: number;
  cleanCases?: number;
  failures?: unknown[];
};

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runGuard(...args: string[]) {
  return spawnSync('pwsh', ['-NoProfile', '-File', guardPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function parseGuardJson(stdout: string): GuardResult {
  return JSON.parse(stdout.trim()) as GuardResult;
}

describe('vestigial fleet retirement (Issue #745 PR-A + PR-B)', () => {
  it('all retired children are absent from the registry', () => {
    const registry = readJson(join(repoRoot, 'scripts', 'orchestrator-side-process-registry.json'));
    const required = new Set<string>(registry.requiredChildIds);
    const childIds = new Set<string>(registry.children.map((child: { id: string }) => child.id));
    const serialized = JSON.stringify(registry);
    for (const [id, script, lock] of retired) {
      expect(required.has(id), `${id} in requiredChildIds`).toBe(false);
      expect(childIds.has(id), `${id} in children`).toBe(false);
      expect(serialized).not.toContain(script);
      if (lock) expect(serialized).not.toContain(lock);
    }
    expect([...required]).toEqual(survivors);
  });

  it('retired entrypoints and the exclusive reaper helper are deleted', () => {
    for (const [, script] of retired) {
      expect(existsSync(join(repoRoot, 'scripts', script)), script).toBe(false);
    }
    expect(existsSync(join(repoRoot, 'scripts/lib/Invoke-ReviewStuckRunReaper.ps1'))).toBe(false);
  });

  it('survivors remain registered and satisfy the static launch contract', () => {
    const registry = readJson(join(repoRoot, 'scripts', 'orchestrator-side-process-registry.json'));
    const byId = new Map<string, { id: string; script: string }>(
      registry.children.map((child: { id: string; script: string }) => [child.id, child]),
    );
    for (const id of survivors) {
      const child = byId.get(id);
      expect(child, `missing survivor row: ${id}`).toBeDefined();
      expect(existsSync(join(repoRoot, 'scripts', child!.script)), child!.script).toBe(true);
    }
    const result = spawnSync('pwsh', ['-NoProfile', '-File', launchContractPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/validated 9 registry children/i);
  });

  it('retains the real survivor supervisor-launch smoke', () => {
    const source = readFileSync(survivorSmokePath, 'utf8');
    expect(source).toContain("Start-OrchestratorWakeSupervisorChild -ChildId 'escalation-router'");
    expect(source).toMatch(/tick complete redelivered=/i);
    expect(source).not.toContain('Invoke-ReviewStuckRunReaper');
  });

  it('preserves issue 744 escalation surfaces', () => {
    for (const file of [
      'scripts/lib/Orchestrator-Escalation.ps1',
      'scripts/orchestrator-escalation-router.ps1',
      'scripts/worker-message-submit-reconcile.ps1',
    ]) {
      expect(existsSync(join(repoRoot, file)), file).toBe(true);
    }
    const emitter = readJson(join(repoRoot, 'scripts/orchestrator-escalation-emitter-inventory.json'));
    expect(
      emitter.emitters.some(
        (row: { file: string }) => row.file === 'scripts/worker-message-submit-reconcile.ps1',
      ),
    ).toBe(true);
  });

  it('records the probe-gated listener retirement evidence', () => {
    const evidence = readJson(listenerEvidencePath);
    expect(evidence.issue).toBe(745);
    expect(evidence.baseCommitSha).toBe('9728896230f8f66de09c485dff613dfdee5cfd9f');
    expect(evidence.aoVersion).toBe('0.10.2');
    expect(evidence.disposition).toBe('retire');
    expect(evidence.productionAudit.inboundWebhookPosts).toBe(0);
    expect(evidence.finalBaseProbe.bindingVerified).toBe(true);
    expect(evidence.finalBaseProbe.inboundWebhookPosts).toBe(0);
    expect(evidence.finalBaseProbe.observationWindowSeconds).toBeGreaterThanOrEqual(60);
  });

  it('reintroduction guard passes on the real clean tree', () => {
    const result = runGuard('-RepoRoot', repoRoot, '-Json');
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = parseGuardJson(result.stdout);
    expect(payload.status).toBe('pass');
    expect(payload.listenerDisposition).toBe('retire');
    expect(payload.retiredChildIds).toEqual(retired.map(([id]) => id));
    expect(payload.failures).toEqual([]);
  });

  it('negative matrix covers every retired child across registry and binding surfaces', () => {
    const result = runGuard('-SelfTest', '-Json');
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = parseGuardJson(result.stdout);
    expect(payload.status).toBe('pass');
    expect(payload.cleanCases).toBe(1);
    expect(payload.expectedNegativeCases).toBe(60);
    expect(payload.negativeCases).toBe(60);
    expect(payload.failures).toEqual([]);
  });
});
