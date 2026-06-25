import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import {
  AUTONOMOUS_SPAWN_POLICY_VERSION,
  classifySpawnAction,
  evaluateAutonomousSpawnPolicyBoundary,
  evaluateAutonomousSpawnPolicyDecision,
  evaluateClaimPrResumeSafety,
  loadAutonomousSpawnPolicy,
  parseClaimPrNumberFromSpawnArgv,
  validateAutonomousSpawnPolicy,
} from '../docs/autonomous-orchestrator-boundary.mjs';
import { autonomousBashEnv } from './_test-git-fixture.js';
import { withAoSpawnProbeStub } from './_test-autonomous-ao-stub-fixture.js';

const guardPath = path.join(repoRoot, 'scripts/ao-autonomous-guard.ps1');
const aoShimPath = path.join(repoRoot, 'scripts/ao');
const gitGuardPath = path.join(repoRoot, 'scripts/git-autonomous-guard.ps1');
const spawnGateLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousSpawnGate.ps1');
const exampleYamlPath = path.join(repoRoot, 'agent-orchestrator.yaml.example');
const migrationNotesPath = path.join(repoRoot, 'docs/migration_notes.md');

function withTempSpawnPolicy(
  policy: Record<string, unknown>,
  run: (policyDir: string) => void,
) {
  const policyDir = mkdtempSync(path.join(tmpdir(), 'spawn-policy-pack-'));
  const docsDir = path.join(policyDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(docsDir, 'autonomous-spawn-policy.json'), JSON.stringify(policy, null, 2));
  try {
    run(policyDir);
  } finally {
    rmSync(policyDir, { recursive: true, force: true });
  }
}

describe('spawn policy load', () => {
  it('spawn policy: explicit default-on and fail-closed on load error', () => {
    const loaded = loadAutonomousSpawnPolicy(repoRoot);
    expect(loaded.ok).toBe(true);
    expect(loaded.policy).toEqual({ allowSpawnNew: true, allowClaimPrResume: true });

    expect(validateAutonomousSpawnPolicy({ version: AUTONOMOUS_SPAWN_POLICY_VERSION, allowSpawnNew: true, allowClaimPrResume: true }).ok).toBe(true);
    expect(validateAutonomousSpawnPolicy({ version: AUTONOMOUS_SPAWN_POLICY_VERSION, allowSpawnNew: 'yes', allowClaimPrResume: true }).ok).toBe(false);
    expect(validateAutonomousSpawnPolicy(null).reason).toMatch(/spawn_policy/);

    withTempSpawnPolicy({ version: 'autonomous-spawn-policy/v0', allowSpawnNew: true, allowClaimPrResume: true }, (dir) => {
      expect(loadAutonomousSpawnPolicy(dir).ok).toBe(false);
    });
  });
});

describe('spawn policy matrix', () => {
  const matrix = [
    { allowSpawnNew: true, allowClaimPrResume: true, spawnNew: true, claimPr: true },
    { allowSpawnNew: false, allowClaimPrResume: true, spawnNew: false, claimPr: true },
    { allowSpawnNew: true, allowClaimPrResume: false, spawnNew: true, claimPr: false },
    { allowSpawnNew: false, allowClaimPrResume: false, spawnNew: false, claimPr: false },
  ] as const;

  it('spawn policy matrix: independent toggles', () => {
    for (const row of matrix) {
      const policy = { allowSpawnNew: row.allowSpawnNew, allowClaimPrResume: row.allowClaimPrResume };
      const spawnNew = evaluateAutonomousSpawnPolicyBoundary({
        argv: ['spawn', 'opk-1'],
        autonomousSurface: true,
        policy,
        policyLoadOk: true,
      });
      expect(spawnNew.allowed).toBe(row.spawnNew);

      const claimPr = evaluateAutonomousSpawnPolicyBoundary({
        argv: ['spawn', '--claim-pr', '999991'],
        autonomousSurface: true,
        policy,
        policyLoadOk: true,
        claimPrResumeSafe: true,
      });
      expect(claimPr.allowed).toBe(row.claimPr);
    }

    const malformed = evaluateAutonomousSpawnPolicyBoundary({
      argv: ['spawn', 'opk-1'],
      autonomousSurface: true,
      policyLoadOk: false,
      policyLoadReason: 'spawn_policy_malformed',
    });
    expect(malformed.allowed).toBe(false);
    expect(malformed.reason).toMatch(/spawn_policy/);
  });
});

describe('claim-pr classification', () => {
  it('claim-pr classification: robust argv parsing', () => {
    expect(classifySpawnAction(['spawn', '--claim-pr', '322'])).toBe('claim-pr-resume');
    expect(classifySpawnAction(['spawn', '322', '--claim-pr', '322'])).toBe('claim-pr-resume');
    expect(classifySpawnAction(['spawn', '--claim-pr=458'])).toBe('claim-pr-resume');
    expect(classifySpawnAction(['spawn', 'feat/claim-pr-branch'])).toBe('spawn-new');
    expect(classifySpawnAction(['spawn', '--claim-pr', 'abc'])).toBe('claim-pr-malformed');
    expect(classifySpawnAction(['spawn', '--claim-pr='])).toBe('claim-pr-malformed');
    expect(classifySpawnAction(['spawn', '--claim-pr', '123abc'])).toBe('claim-pr-malformed');
    expect(classifySpawnAction(['spawn', '--claim-pr=123abc'])).toBe('claim-pr-malformed');
    expect(parseClaimPrNumberFromSpawnArgv(['spawn', 'feat/claim-pr-branch'])).toBeNull();
    expect(parseClaimPrNumberFromSpawnArgv(['spawn', '--claim-pr', 'abc'])).toBeNull();
    expect(parseClaimPrNumberFromSpawnArgv(['spawn', '--claim-pr', '123abc'])).toBeNull();
    expect(parseClaimPrNumberFromSpawnArgv(['spawn', '--claim-pr=123abc'])).toBeNull();
    expect(parseClaimPrNumberFromSpawnArgv(['spawn', '--claim-pr', '999991'])).toBe(999991);
  });
});


  it('denies malformed claim-pr spawns with invalid_pr instead of spawn-new', () => {
    const malformed = evaluateAutonomousSpawnPolicyDecision({
      argv: ['spawn', '--claim-pr', 'abc'],
      autonomousSurface: true,
      policyLoadOk: true,
      policy: { allowSpawnNew: true, allowClaimPrResume: false },
    });
    expect(malformed.allowed).toBe(false);
    expect(malformed.reason).toBe('claim_pr_resume_invalid_pr');
    expect(malformed.action).toBe('claim-pr-malformed');
    expect(malformed.auditLine).toMatch(/claim-pr-malformed reason=claim_pr_resume_invalid_pr/);

    const prefixMalformed = evaluateAutonomousSpawnPolicyDecision({
      argv: ['spawn', '--claim-pr', '123abc'],
      autonomousSurface: true,
      policyLoadOk: true,
      policy: { allowSpawnNew: true, allowClaimPrResume: true },
    });
    expect(prefixMalformed.allowed).toBe(false);
    expect(prefixMalformed.reason).toBe('claim_pr_resume_invalid_pr');
    expect(prefixMalformed.action).toBe('claim-pr-malformed');

    const manualMalformed = evaluateAutonomousSpawnPolicyDecision({
      argv: ['spawn', '--claim-pr', 'abc'],
      autonomousSurface: false,
      policyLoadOk: true,
      policy: { allowSpawnNew: true, allowClaimPrResume: true },
    });
    expect(manualMalformed.allowed).toBe(true);
    expect(manualMalformed.reason).toBe('manual_surface');
    expect(manualMalformed.action).toBe('claim-pr-malformed');
  });

describe('spawn policy audit', () => {
  it('spawn policy audit: emits allow and deny lines', () => {
    const allow = evaluateAutonomousSpawnPolicyDecision({
      argv: ['spawn', 'opk-1'],
      autonomousSurface: true,
      policyLoadOk: true,
      policy: { allowSpawnNew: true, allowClaimPrResume: true },
    });
    expect(allow.auditLine).toMatch(/autonomous spawn policy allow: action=spawn-new/);

    const deny = evaluateAutonomousSpawnPolicyDecision({
      argv: ['spawn', 'opk-1'],
      autonomousSurface: true,
      policyLoadOk: true,
      policy: { allowSpawnNew: false, allowClaimPrResume: true },
    });
    expect(deny.auditLine).toMatch(/autonomous spawn policy deny: action=spawn-new/);
  });
});

describe('claim-pr collision safety', () => {
  it('claim-pr collision: cleanup-required when live owner present', () => {
    expect(
      evaluateClaimPrResumeSafety({
        prNumber: 458,
        liveOwnerPresent: true,
        ownerLivenessKnown: true,
      }).reason,
    ).toBe('claim_pr_resume_cleanup_required');

    expect(
      evaluateClaimPrResumeSafety({
        prNumber: 458,
        liveOwnerPresent: false,
        ownerLivenessKnown: false,
      }).reason,
    ).toBe('claim_pr_resume_cleanup_required');
  });

  it('duplicate resume: concurrent attempt loses mutex', () => {
    expect(evaluateClaimPrResumeSafety({ prNumber: 458, resumeMutexHeld: true }).reason).toBe(
      'claim_pr_resume_already_in_progress',
    );
    expect(evaluateClaimPrResumeSafety({ prNumber: 458, concurrentAttemptLost: true }).reason).toBe(
      'claim_pr_resume_already_in_progress',
    );
  });

  it('cleanup-required: pack gate denies claim-pr when fixture live owner exists', () => {
    const output = runPwsh(`
      . ${psString(spawnGateLibPath)}
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $fixtureSessions = @(
        @{ role = 'worker'; prNumber = 458; status = 'working'; name = 'opk-live' }
      )
      $result = Test-AutonomousSpawnDenied -Argv @('spawn','--claim-pr','458') -FixtureMode -FixtureSessions $fixtureSessions
      $result | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(output.trim());
    expect(parsed.denied).toBe(true);
    expect(parsed.reason).toBe('claim_pr_resume_cleanup_required');
  });

  it('allows claim-pr when live owner holds a different PR (no param shadowing)', () => {
    const output = runPwsh(`
      . ${psString(spawnGateLibPath)}
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $fixtureSessions = @(
        @{ role = 'worker'; prNumber = 460; status = 'working'; name = 'opk-other' }
      )
      $result = Test-AutonomousClaimPrLiveOwner -PrNumber 458 -FixtureMode -FixtureSessions $fixtureSessions
      $result | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(output.trim());
    expect(parsed.liveOwnerPresent).toBe(false);
    expect(parsed.livenessKnown).toBe(true);
  });

  it('internal git: mutating git still denied during allowed claim-pr path', () => {
    withAoSpawnProbeStub(({ probeFile }) => {
      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, 'spawn', '--claim-pr', '999991'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: autonomousBashEnv({ AO_SPAWN_PROBE_FILE: probeFile }),
        },
      );
      expect(result.status).toBe(0);
      expect(readFileSync(probeFile, 'utf8').trim().split('\n')).toEqual(['spawn', '--claim-pr', '999991']);

      const gitDeny = spawnSync(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', gitGuardPath, 'branch', '-m', 'blocked'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: autonomousBashEnv(),
        },
      );
      expect(gitDeny.status).toBe(93);
      expect(gitDeny.stderr).toMatch(/autonomous tree-mutating git denied/i);
    });
  });
});

describe('spawn policy adoption', () => {
  it('operator adoption: documents live yaml override and preserves per-path fences', () => {
    const example = readFileSync(exampleYamlPath, 'utf8');
    expect(example).toMatch(/Plan from open GitHub Issues, spawn coding workers/i);
    expect(example).toMatch(/never ao spawn, never --claim-pr/i);

    const notes = readFileSync(migrationNotesPath, 'utf8');
    expect(notes).toMatch(/Autonomous orchestrator spawn policy/i);
    expect(notes).toMatch(/OPERATOR-GATED/i);
  });
});

describe('spawn policy guard integration', () => {
  it('allows bare spawn with committed default policy', () => {
    withAoSpawnProbeStub(({ probeFile }) => {
      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, 'spawn', 'opk-1'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: autonomousBashEnv({ AO_SPAWN_PROBE_FILE: probeFile }),
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/autonomous spawn policy allow: action=spawn-new/);
      expect(readFileSync(probeFile, 'utf8').trim().split('\n')).toEqual(['spawn', 'opk-1']);
    });
  });

  it('denies spawn when policy toggle is false via fixture policy', () => {
    withTempSpawnPolicy(
      { version: AUTONOMOUS_SPAWN_POLICY_VERSION, allowSpawnNew: false, allowClaimPrResume: true },
      (policyDir) => {
        const output = runPwsh(`
          . ${psString(spawnGateLibPath)}
          $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
          $result = Test-AutonomousSpawnDenied -Argv @('spawn','opk-1') -PackRoot ${psString(policyDir)} -FixtureMode -FixturePolicy @{ version='${AUTONOMOUS_SPAWN_POLICY_VERSION}'; allowSpawnNew=$false; allowClaimPrResume=$true }
          $result | ConvertTo-Json -Compress
        `);
        const parsed = JSON.parse(output.trim());
        expect(parsed.denied).toBe(true);
        expect(parsed.reason).toBe('spawn_policy_allowSpawnNew_false');
      },
    );
  });

  it('surface scoping: manual surface pass-through unchanged', () => {
    withAoSpawnProbeStub(({ probeFile }) => {
      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, 'spawn', 'opk-1'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '',
            AO_SPAWN_PROBE_FILE: probeFile,
          },
        },
      );
      expect(result.status).toBe(0);
    });
  });

  it('ao shim allows spawn on autonomous surface with default policy', () => {
    withAoSpawnProbeStub(({ probeFile }) => {
      const result = spawnSync(aoShimPath, ['spawn', 'opk-probe'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: autonomousBashEnv({ AO_SPAWN_PROBE_FILE: probeFile }),
      });
      expect(result.status).toBe(0);
      expect(`${result.stderr}${result.stdout}`).not.toMatch(/autonomous worker spawn denied/i);
    });
  });
});
