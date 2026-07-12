import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');
const guardPath = join(repoRoot, 'scripts', 'check-vestigial-fleet-children-retired.ps1');
const launchContractPath = join(repoRoot, 'scripts', 'check-side-process-launch-contract.ps1');
const supervisorLib = join(repoRoot, 'scripts', 'lib', 'Orchestrator-WakeSupervisor.ps1');
const retired = [
  ['review-run-recovery', 'review-run-recovery.ps1', 'review-run-recovery-side-effect.lock'],
  ['review-stuck-run-reaper', 'review-stuck-run-reaper.ps1', 'review-stuck-run-reaper-side-effect.lock'],
  ['review-finding-delivery-confirm', 'review-finding-delivery-confirm.ps1', 'delivery-confirm-side-effect.lock'],
  ['ci-failure-notification-reaction', 'ci-failure-notification-reaction.ps1', ''],
] as const;
const survivors = [
  'listener',
  'review-trigger-reconcile',
  'review-trigger-reeval',
  'review-ready-report-state-seed',
  'ci-green-wake-reconcile',
  'worker-message-submit-reconcile',
  'review-start-claim-reaper',
  'ci-failure-notification-reconcile',
  'dead-worker-reconcile',
  'escalation-router',
];
const bindingSurfaces = [
  ['supervisor', 'scripts/orchestrator-wake-supervisor.ps1'],
  ['launch inventory', 'scripts/launch-argv-inventory.json'],
  ['escalation inventory', 'scripts/orchestrator-escalation-emitter-inventory.json'],
  ['message audit manifest', 'scripts/orchestrator-message-audit-roots.manifest.json'],
  ['protected runtime manifest', 'scripts/orchestrator-message-protected-runtime.manifest.json'],
  ['send helpers manifest', 'scripts/orchestrator-message-send-helpers.manifest.json'],
  ['state coverage manifest', 'scripts/fixtures/mechanical-json-state/state-coverage-manifest.json'],
  ['spawn budget facade', 'docs/review-pipeline-spawn-budget.mjs'],
  ['spawn budget attribution', 'docs/review-pipeline-spawn-budget-attribution.mjs'],
] as const;
const tempDirs: string[] = [];

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runGuard(root: string) {
  return spawnSync('pwsh', ['-NoProfile', '-File', guardPath, '-RepoRoot', root, '-Json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function runPwsh(script: string) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseLastJson(stdout: string): unknown {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}';
  return JSON.parse(line);
}

function write(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function cleanFixture() {
  const root = mkdtempSync(join(tmpdir(), 'opk-745-retirement-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(guardPath, join(root, 'scripts', 'check-vestigial-fleet-children-retired.ps1'));
  const registry = {
    schemaVersion: 1,
    requiredChildIds: survivors,
    children: survivors.map((id) => ({ id, script: `${id}.ps1` })),
  };
  write(join(root, 'scripts', 'orchestrator-side-process-registry.json'), JSON.stringify(registry));
  for (const [, rel] of bindingSurfaces) {
    write(join(root, rel), rel.endsWith('.json') ? JSON.stringify({ schemaVersion: 1 }) : '# clean fixture\n');
  }
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('vestigial fleet retirement (Issue #745 PR-A)', () => {
  it('vestigial children absent', () => {
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

  it('PR-A entrypoints and exclusive reaper helper are deleted', () => {
    for (const [, script] of retired) {
      expect(existsSync(join(repoRoot, 'scripts', script)), script).toBe(false);
    }
    expect(existsSync(join(repoRoot, 'scripts/lib/Invoke-ReviewStuckRunReaper.ps1'))).toBe(false);
  });

  it('survivors remain registered and satisfy the static supervised launch contract', () => {
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
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/validated 10 registry children/i);
  });

  it('real survivor launch completes without the retired reaper helper', { timeout: 180_000 }, () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'opk-745-survivor-smoke-'));
    tempDirs.push(stateRoot);
    const escalationState = join(stateRoot, 'escalation-state.json');
    writeFileSync(
      escalationState,
      JSON.stringify({ schemaVersion: 1, records: {}, wakeWindows: {}, audit: {} }),
    );
    const result = runPwsh(`
      . ${ps(supervisorLib)}
      $stateRoot = ${ps(stateRoot)}
      $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot
      $env:AO_ORCHESTRATOR_ESCALATION_STATE = ${ps(escalationState)}
      $pidVal = Start-OrchestratorWakeSupervisorChild -ChildId 'escalation-router' -OrchestratorSessionId 'orch-745' -Paths $paths -ProjectId 'orchestrator-pack' -ExtraChildArgs @('-Once','-PollSeconds','1')
      if ($pidVal -le 0) { throw 'invalid survivor pid' }
      $mainLogPath = Join-Path $stateRoot 'escalation-router.log'
      $errLogPath = Join-Path $stateRoot 'escalation-router.log.err'
      $deadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
      $mainLog = ''
      while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if ((Test-Path -LiteralPath $mainLogPath) -and ((Get-Item -LiteralPath $mainLogPath).Length -gt 0)) {
          $mainLog = Get-Content -LiteralPath $mainLogPath -Raw
          if ($mainLog -match 'tick complete redelivered=') { break }
        }
        if (-not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 200
      }
      if (-not $mainLog -and (Test-Path -LiteralPath $mainLogPath)) {
        $mainLog = Get-Content -LiteralPath $mainLogPath -Raw
      }
      if (Get-Process -Id $pidVal -ErrorAction SilentlyContinue) {
        Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
      }
      $errLog = if (Test-Path -LiteralPath $errLogPath) {
        [string](Get-Content -LiteralPath $errLogPath -Raw -ErrorAction SilentlyContinue)
      } else { '' }
      [pscustomobject]@{ mainLog = [string]$mainLog; errLog = [string]$errLog } |
        ConvertTo-Json -Compress -Depth 4
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = parseLastJson(result.stdout) as { mainLog: string; errLog: string | null };
    expect(payload.errLog ?? '').not.toMatch(/Invoke-ReviewStuckRunReaper|not recognized|not found/i);
    expect(payload.mainLog).toMatch(/\[orchestrator-escalation-router\] tick complete redelivered=/i);
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
    expect(emitter.emitters.some((row: { file: string }) => row.file === 'scripts/worker-message-submit-reconcile.ps1')).toBe(true);
  });

  it('reintroduction guard passes on clean tree', () => {
    const root = cleanFixture();
    try {
      const result = runGuard(root);
      expect(result.status, result.stderr || result.stdout).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [id, script] of retired) {
    it(`reintroduction guard fails for ${id} in registry`, () => {
      const root = cleanFixture();
      try {
        const path = join(root, 'scripts', 'orchestrator-side-process-registry.json');
        const registry = readJson(path);
        registry.requiredChildIds.push(id);
        registry.children.push({ id, script });
        write(path, JSON.stringify(registry));
        const result = runGuard(root);
        expect(result.status, result.stderr || result.stdout).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    for (const [surface, rel] of bindingSurfaces) {
      it(`reintroduction guard fails for ${id} in ${surface}`, () => {
        const root = cleanFixture();
        try {
          write(join(root, rel), rel.endsWith('.json') ? JSON.stringify({ marker: script }) : `# launches ${script}\n`);
          const result = runGuard(root);
          expect(result.status, result.stderr || result.stdout).toBe(1);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
