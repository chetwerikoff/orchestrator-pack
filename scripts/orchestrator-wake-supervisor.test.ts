// @vitest-ci-lane parked
// @vitest-pre-topology-seconds 120
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runProcessSync } from './kernel/subprocess.ts';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProcessIdentity } from './lib/cutover/activation-cordon.ts';
import { FileEpochAuthority } from './lib/cutover/activation-epoch-authority.ts';
import {
  observeGreenfieldFoundationInertProof,
  type CanonicalFoundationPaths,
} from './lib/cutover/foundation-observation.ts';
import { childRegistry } from './lib/orchestrator-side-process-observer.ts';
import { sha256Bytes } from './lib/cutover/stable-stringify.ts';
import { supervisorChildExitTransition } from './lib/orchestrator-side-process-supervisor.ts';
import { EMPTY_CRASH_BACKOFF_STATE, type CrashBackoffPolicy } from './runtime/crash-backoff.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
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

function greenfieldPaths(root: string): { repoRoot: string; paths: CanonicalFoundationPaths } {
  const fakeRepo = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  const supervisorStateDir = path.join(stateRoot, 'supervisor');
  mkdirSync(path.join(fakeRepo, 'scripts'), { recursive: true });
  mkdirSync(supervisorStateDir, { recursive: true });
  writeFileSync(
    path.join(fakeRepo, 'scripts', 'orchestrator-side-process-registry.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      requiredChildIds: ['pr2-scheduler'],
      children: [{
        id: 'pr2-scheduler',
        runtime: 'node',
        script: 'pr2-foundation/scheduler.ts',
        sideEffecting: true,
        cadenceSeconds: 5,
        stallGraceMultiplier: 14,
      }],
    })}\n`,
    'utf8',
  );
  return {
    repoRoot: fakeRepo,
    paths: {
      stateRoot,
      supervisorStateDir,
      epochAuthorityPath: path.join(stateRoot, 'epoch-authority.json'),
      evidencePath: path.join(stateRoot, 'foundation-923-adoption.json'),
      configPath: path.join(stateRoot, 'foundation-config.json'),
      appStatePath: path.join(stateRoot, 'app-state.json'),
      cordonPath: path.join(stateRoot, 'cordon.json'),
      phaseOnePath: path.join(stateRoot, 'phase-one.json'),
      followupPath: path.join(stateRoot, 'followups.json'),
      projectedRegistryPath: path.join(supervisorStateDir, 'projected-registry.json'),
      snapshotDir: path.join(stateRoot, 'snapshots'),
    },
  };
}

describe('Issue #948 wake-supervisor observer bridge', () => {
  it('returns the canonical Node scheduler registry without the retired PowerShell route', () => {
    expect(childRegistry().map((child) => child.Id)).toEqual(['pr2-scheduler']);
    expect(childRegistry()[0]).toMatchObject({
      ScriptMarker: 'pr2-foundation/scheduler.ts',
      SideEffecting: true,
    });
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

  it('runs the shipped supervisor loop in a separate process through cadence/backoff to the terminal fuse', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'opk-1484-supervisor-loop-'));
    try {
      const fakeRepo = path.join(root, 'repo');
      const stateDir = path.join(root, 'state');
      const schedulerDir = path.join(fakeRepo, 'scripts', 'pr2-foundation');
      const schedulerPath = path.join(schedulerDir, 'scheduler.ts');
      const targetRegistryPath = path.join(root, 'target-registry.json');
      const projectedRegistryPath = path.join(stateDir, 'projected-registry.json');
      const epochAuthorityPath = path.join(root, 'epoch-authority.json');
      mkdirSync(schedulerDir, { recursive: true });
      writeFileSync(
        schedulerPath,
        "process.stderr.write('scheduler exploded\\n'); process.exitCode = 7;\n",
        'utf8',
      );
      const registry = {
        schemaVersion: 2,
        requiredChildIds: ['pr2-scheduler'],
        children: [{
          id: 'pr2-scheduler',
          runtime: 'node',
          script: 'pr2-foundation/scheduler.ts',
          sideEffecting: true,
          cadenceSeconds: 1,
        }],
      };
      writeFileSync(targetRegistryPath, `${JSON.stringify(registry)}\n`, 'utf8');
      const epochId = 'epoch-1484-supervisor-loop';
      const nonce = 'nonce-1484-supervisor-loop';
      new FileEpochAuthority(epochAuthorityPath).commit(null, {
        epochId,
        nonce,
        hostId: 'test-host',
        repoRoot: fakeRepo,
        installedCommitSha: 'a'.repeat(40),
        snapshotDigests: { reconcile: 'snapshot-r', reevaluation: 'snapshot-e', reportStateSeed: 'snapshot-s' },
        importDigests: { reconcile: 'import-r', reevaluation: 'import-e', reportStateSeed: 'import-s' },
        registryHash: sha256Bytes(readFileSync(targetRegistryPath)),
        preCommitLogDigest: 'phase-one-fixture',
        commitAt: new Date().toISOString(),
      });

      const result = runProcessSync({
        command: process.execPath,
        args: [
          '--experimental-strip-types',
          supervisorScript,
          'run',
          '--state-dir', stateDir,
          '--repo-root', fakeRepo,
          '--epoch-authority', epochAuthorityPath,
          '--epoch-id', epochId,
          '--nonce', nonce,
          '--target-registry', targetRegistryPath,
          '--projected-registry', projectedRegistryPath,
        ],
        cwd: repoRoot,
        inheritParentEnv: true,
        env: {
          OPK_SUPERVISOR_CRASH_RAPID_EXIT_THRESHOLD_MS: '1000',
          OPK_SUPERVISOR_CRASH_MAX_RAPID_EXITS: '1',
          OPK_SUPERVISOR_CRASH_TERMINAL_RAPID_EXITS: '2',
          OPK_SUPERVISOR_CRASH_BASE_BACKOFF_MS: '1',
          OPK_SUPERVISOR_CRASH_MAX_BACKOFF_MS: '1',
        },
        timeoutMs: 15_000,
      });

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(false);
      const status = JSON.parse(readFileSync(
        path.join(stateDir, 'typescript-supervisor-status.json'),
        'utf8',
      )) as {
        schemaVersion: number;
        childPid: number | null;
        childStartTicks: string | null;
        childGeneration: number;
        childRestarts: number;
        restartState: string;
        refusalReason: string | null;
        crashBackoff: { terminal: boolean; rapidExits: number; terminalReason: string | null };
      };
      expect(status).toMatchObject({
        schemaVersion: 2,
        childPid: null,
        childStartTicks: null,
        childGeneration: 2,
        childRestarts: 2,
        restartState: 'refused',
        crashBackoff: {
          terminal: true,
          rapidExits: 2,
          terminalReason: 'crash_loop:2_rapid_exits',
        },
      });
      expect(status.refusalReason).toContain('scheduler_child_');
      expect(status.refusalReason).toContain('scheduler exploded');
      expect(status.refusalReason).not.toBe(status.crashBackoff.terminalReason);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accumulates repeated child failures to the existing fuse while retaining the concrete cause', () => {
    const policy: CrashBackoffPolicy = {
      rapidExitThresholdMs: 1_000,
      maxRapidExitsBeforeBackoff: 2,
      terminalRapidExits: 3,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    };
    let crashBackoff = EMPTY_CRASH_BACKOFF_STATE;
    let transition = supervisorChildExitTransition({
      previous: crashBackoff,
      startedAtMs: 1_000,
      exitedAtMs: 1_001,
      result: { ok: false, outcome: 'exit_nonzero', stderr: 'scheduler exploded', exitCode: 7 },
      policy,
    });
    expect(transition.restartState).toBe('waiting-restart');
    expect(transition.refusalReason).toBe('scheduler_child_exit_nonzero:scheduler exploded');
    crashBackoff = transition.crashBackoff;

    transition = supervisorChildExitTransition({
      previous: crashBackoff,
      startedAtMs: 2_000,
      exitedAtMs: 2_001,
      result: { ok: false, outcome: 'exit_nonzero', stderr: 'scheduler exploded', exitCode: 7 },
      policy,
    });
    expect(transition.restartState).toBe('waiting-restart');
    crashBackoff = transition.crashBackoff;

    transition = supervisorChildExitTransition({
      previous: crashBackoff,
      startedAtMs: 3_000,
      exitedAtMs: 3_001,
      result: { ok: false, outcome: 'exit_nonzero', stderr: 'scheduler exploded', exitCode: 7 },
      policy,
    });

    expect(transition.restartState).toBe('refused');
    expect(transition.crashBackoff).toMatchObject({
      terminal: true,
      rapidExits: 3,
      terminalReason: 'crash_loop:3_rapid_exits',
    });
    expect(transition.refusalReason).toBe('scheduler_child_exit_nonzero:scheduler exploded');
    expect(transition.refusalReason).not.toBe(transition.crashBackoff.terminalReason);
  });
});

describe('Issue #1484 cutover supervisor identity consumers', () => {
  it('treats a valid dead v2 status as inert greenfield history', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'opk-1484-greenfield-dead-v2-'));
    try {
      const fixture = greenfieldPaths(root);
      writeFileSync(path.join(fixture.paths.supervisorStateDir, 'typescript-supervisor-status.json'), `${JSON.stringify({
        schemaVersion: 2,
        supervisorPid: 999_991,
        supervisorStartTicks: 'dead-supervisor',
        childId: 'pr2-scheduler',
        childPid: 999_992,
        childStartTicks: 'dead-child',
        childGeneration: 4,
        childRestarts: 4,
        restartState: 'running',
        refusalReason: null,
        crashBackoff: EMPTY_CRASH_BACKOFF_STATE,
        updatedAt: new Date().toISOString(),
      })}\n`, 'utf8');

      expect(observeGreenfieldFoundationInertProof(fixture)).toMatchObject({
        result: 'greenfield-dormant-layer-not-active',
        observations: {
          supervisorChanged: false,
          schedulerRegistered: false,
          schedulerRunning: false,
          schedulerClaimAcquirer: false,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not promote a PID-reused v2 child to live greenfield authority', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'opk-1484-greenfield-pid-reuse-'));
    try {
      const fixture = greenfieldPaths(root);
      const identity = readProcessIdentity(process.pid);
      writeFileSync(path.join(fixture.paths.supervisorStateDir, 'typescript-supervisor-status.json'), `${JSON.stringify({
        schemaVersion: 2,
        supervisorPid: process.pid,
        supervisorStartTicks: `${identity.startTicks}-stale`,
        childId: 'pr2-scheduler',
        childPid: process.pid,
        childStartTicks: `${identity.startTicks}-stale-child`,
        childGeneration: 2,
        childRestarts: 1,
        restartState: 'running',
        refusalReason: null,
        crashBackoff: EMPTY_CRASH_BACKOFF_STATE,
        updatedAt: new Date().toISOString(),
      })}\n`, 'utf8');

      expect(observeGreenfieldFoundationInertProof(fixture)).toMatchObject({
        result: 'greenfield-dormant-layer-not-active',
        observations: {
          supervisorChanged: false,
          schedulerRunning: false,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a live v2 process generation and keeps legacy v1 fail-closed', () => {
    const identity = readProcessIdentity(process.pid);
    for (const [label, status] of [
      ['live-v2', {
        schemaVersion: 2,
        supervisorPid: process.pid,
        supervisorStartTicks: identity.startTicks,
        childId: 'pr2-scheduler',
        childPid: process.pid,
        childStartTicks: identity.startTicks,
        childGeneration: 1,
        childRestarts: 0,
        restartState: 'running',
        refusalReason: null,
        crashBackoff: EMPTY_CRASH_BACKOFF_STATE,
        updatedAt: new Date().toISOString(),
      }],
      ['legacy-v1', {
        schemaVersion: 1,
        supervisorPid: 999_993,
        supervisorStartTicks: 'legacy-dead',
        childPid: null,
        childGeneration: 0,
        childRestarts: 0,
        restartState: 'running',
        refusalReason: null,
        crashBackoff: EMPTY_CRASH_BACKOFF_STATE,
        updatedAt: new Date().toISOString(),
      }],
    ] as const) {
      const root = mkdtempSync(path.join(tmpdir(), `opk-1484-greenfield-${label}-`));
      try {
        const fixture = greenfieldPaths(root);
        writeFileSync(
          path.join(fixture.paths.supervisorStateDir, 'typescript-supervisor-status.json'),
          `${JSON.stringify(status)}\n`,
          'utf8',
        );
        expect(() => observeGreenfieldFoundationInertProof(fixture))
          .toThrow('foundation_inert_proof_unobservable:supervisor_changed');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe('Issue #1880 supervisor epoch-authority admission', () => {
  it('surfaces classified pointer corruption before projection or child start and writes only refused status', () => {
    for (const [label, currentEpochId, expected] of [
      ['null-history', null, 'epoch_authority_current_pointer_invalid:null_with_history'],
      ['unbound-current', 'epoch-1880-orphan', 'epoch_authority_current_pointer_invalid:unbound_current'],
      ['malformed-current', 7, 'epoch_authority_current_pointer_invalid:malformed_current'],
      ['empty-current', '', 'epoch_authority_current_pointer_invalid:malformed_current'],
    ] as const) {
      const root = mkdtempSync(path.join(tmpdir(), `opk-1880-supervisor-${label}-`));
      try {
        const fakeRepo = path.join(root, 'repo');
        const stateDir = path.join(root, 'state');
        const schedulerDir = path.join(fakeRepo, 'scripts', 'pr2-foundation');
        const schedulerMarker = path.join(root, 'scheduler-started.txt');
        const targetRegistryPath = path.join(root, 'target-registry.json');
        const projectedRegistryPath = path.join(stateDir, 'projected-registry.json');
        const epochAuthorityPath = path.join(root, 'epoch-authority.json');
        mkdirSync(schedulerDir, { recursive: true });
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(
          path.join(schedulerDir, 'scheduler.ts'),
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(schedulerMarker)}, 'started', 'utf8');\n`,
          'utf8',
        );
        const registry = {
          schemaVersion: 2,
          requiredChildIds: ['pr2-scheduler'],
          children: [{
            id: 'pr2-scheduler',
            runtime: 'node',
            script: 'pr2-foundation/scheduler.ts',
            sideEffecting: true,
            cadenceSeconds: 5,
          }],
        };
        const registryBytes = `${JSON.stringify(registry)}\n`;
        writeFileSync(targetRegistryPath, registryBytes, 'utf8');

        const epochId = 'epoch-1880-supervisor';
        const nonce = 'nonce-1880-private';
        const record = {
          epochId,
          nonce,
          hostId: 'test-host',
          repoRoot: fakeRepo,
          installedCommitSha: 'a'.repeat(40),
          snapshotDigests: { reconcile: 'snapshot-r', reevaluation: 'snapshot-e', reportStateSeed: 'snapshot-s' },
          importDigests: { reconcile: 'import-r', reevaluation: 'import-e', reportStateSeed: 'import-s' },
          registryHash: sha256Bytes(Buffer.from(registryBytes)),
          preCommitLogDigest: 'phase-one-fixture',
          commitAt: new Date().toISOString(),
        };
        writeFileSync(
          epochAuthorityPath,
          `${JSON.stringify({ schemaVersion: 1, currentEpochId, records: [record] }, null, 2)}\n`,
          'utf8',
        );

        const result = runProcessSync({
          command: process.execPath,
          args: [
            '--experimental-strip-types',
            supervisorScript,
            'run',
            '--state-dir', stateDir,
            '--repo-root', fakeRepo,
            '--epoch-authority', epochAuthorityPath,
            '--epoch-id', epochId,
            '--nonce', nonce,
            '--target-registry', targetRegistryPath,
            '--projected-registry', projectedRegistryPath,
          ],
          cwd: repoRoot,
          inheritParentEnv: true,
        });

        expect(result.ok).toBe(false);
        expect(result.stderr.trim().split(/\r?\n/u)).toContain(expected);
        expect(result.stderr).not.toContain(nonce);
        expect(result.stderr).not.toContain(root);
        expect(existsSync(projectedRegistryPath)).toBe(false);
        expect(existsSync(schedulerMarker)).toBe(false);
        expect(readFileSync(targetRegistryPath, 'utf8')).toBe(registryBytes);

        const statusPath = path.join(stateDir, 'typescript-supervisor-status.json');
        const status = JSON.parse(readFileSync(statusPath, 'utf8')) as {
          registryHash: string | null;
          childPid: number | null;
          childStartTicks: string | null;
          childGeneration: number;
          restartState: string;
          refusalReason: string | null;
        };
        expect(status).toMatchObject({
          registryHash: null,
          childPid: null,
          childStartTicks: null,
          childGeneration: 0,
          restartState: 'refused',
          refusalReason: expected,
        });
        expect(status.refusalReason).not.toContain(nonce);
        expect(status.refusalReason).not.toContain(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

