import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import { AUTONOMOUS_SPAWN_POLICY_VERSION, classifySpawnAction, evaluateAutonomousSpawnPolicyBoundary, evaluateAutonomousSpawnPolicyDecision, evaluateClaimPrResumeSafety, loadAutonomousSpawnPolicy, parseClaimPrNumberFromSpawnArgv, validateAutonomousSpawnPolicy } from '../docs/autonomous-orchestrator-boundary.mjs';
import { evaluateRecoverySpawnRoute } from '../docs/worker-recovery.mjs';
const spawnGateLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousSpawnGate.ps1');
const exampleYamlPath = path.join(repoRoot, 'agent-orchestrator.yaml.example');
const migrationNotesPath = path.join(repoRoot, 'docs/migration_notes.md');
function withTempSpawnPolicy(policy: Record<string, unknown>, run: (policyDir: string) => void) {
    const policyDir = mkdtempSync(path.join(tmpdir(), 'spawn-policy-pack-'));
    const docsDir = path.join(policyDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, 'autonomous-spawn-policy.json'), JSON.stringify(policy, null, 2));
    try {
        run(policyDir);
    }
    finally {
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
it('classifies AO 0.10.2 recovery-shaped spawn argv (#638)', () => {
    const spawnNew = [
        'spawn',
        '--project',
        'orchestrator-pack',
        '--name',
        'wr-i638',
        '--issue',
        '638',
        '--prompt',
        'Implement GitHub issue #638: read the issue body and prerequisites. Continue the task and open a PR when ready.',
    ];
    const claimPr = [
        'spawn',
        '--project',
        'orchestrator-pack',
        '--name',
        'wr-pr589',
        '--claim-pr',
        '589',
        '--no-takeover',
        '--prompt',
        'Resume work on PR #589: Continue implementation and keep the PR ready for review.',
    ];
    expect(classifySpawnAction(spawnNew)).toBe('spawn-new');
    expect(classifySpawnAction(claimPr)).toBe('claim-pr-resume');
    expect(parseClaimPrNumberFromSpawnArgv(claimPr)).toBe(589);
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
        expect(evaluateClaimPrResumeSafety({
            prNumber: 458,
            liveOwnerPresent: true,
            ownerLivenessKnown: true,
        }).reason).toBe('claim_pr_resume_cleanup_required');
        expect(evaluateClaimPrResumeSafety({
            prNumber: 458,
            liveOwnerPresent: false,
            ownerLivenessKnown: false,
        }).reason).toBe('claim_pr_resume_cleanup_required');
        expect(evaluateClaimPrResumeSafety({
            prNumber: 458,
            staleArtifactPresent: true,
        }).reason).toBe('claim_pr_resume_cleanup_required');
    });
    it('duplicate resume: concurrent attempt loses mutex', () => {
        expect(evaluateClaimPrResumeSafety({ prNumber: 458, resumeMutexHeld: true }).reason).toBe('claim_pr_resume_already_in_progress');
        expect(evaluateClaimPrResumeSafety({ prNumber: 458, concurrentAttemptLost: true }).reason).toBe('claim_pr_resume_already_in_progress');
    });
    it('cleanup-required: pack gate denies claim-pr when fixture live owner exists', () => {
        const output = runPwsh(`
      . ${psString(spawnGateLibPath)}
      $env:AO_SESSION_ID = '1'
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
      $env:AO_SESSION_ID = '1'
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
    it('cleanup-required: denies claim-pr when terminated owner left residual worktree', () => {
        const output = runPwsh(`
      . ${psString(spawnGateLibPath)}
      $env:AO_SESSION_ID = '1'
      $fixtureSessions = @(
        @{ role = 'worker'; prNumber = 458; status = 'terminated'; name = 'opk-stale' }
      )
      $residual = @{ 'opk-stale' = $true }
      $result = Test-AutonomousSpawnDenied -Argv @('spawn','--claim-pr','458') -FixtureMode -FixtureSessions $fixtureSessions -FixtureResidualWorktrees $residual
      $result | ConvertTo-Json -Compress
    `);
        const parsed = JSON.parse(output.trim());
        expect(parsed.denied).toBe(true);
        expect(parsed.reason).toBe('claim_pr_resume_cleanup_required');
    });
    it('allows claim-pr when terminated owner has no residual worktree artifacts', () => {
        const output = runPwsh(`
      . ${psString(spawnGateLibPath)}
      $env:AO_SESSION_ID = '1'
      $fixtureSessions = @(
        @{ role = 'worker'; prNumber = 458; status = 'terminated'; name = 'opk-clean' }
      )
      $result = Test-AutonomousClaimPrResumePreconditions -PrNumber 458 -FixtureMode -FixtureSessions $fixtureSessions
      $result | ConvertTo-Json -Compress
    `);
        const parsed = JSON.parse(output.trim());
        expect(parsed.safe).toBe(true);
        expect(parsed.reason).toBe('claim_pr_resume_safe');
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
    it('denies spawn when policy toggle is false via fixture policy', () => {
        withTempSpawnPolicy({ version: AUTONOMOUS_SPAWN_POLICY_VERSION, allowSpawnNew: false, allowClaimPrResume: true }, (policyDir) => {
            const output = runPwsh(`
          . ${psString(spawnGateLibPath)}
          $env:AO_SESSION_ID = '1'
          $result = Test-AutonomousSpawnDenied -Argv @('spawn','opk-1') -PackRoot ${psString(policyDir)} -FixtureMode -FixturePolicy @{ version='${AUTONOMOUS_SPAWN_POLICY_VERSION}'; allowSpawnNew=$false; allowClaimPrResume=$true }
          $result | ConvertTo-Json -Compress
        `);
            const parsed = JSON.parse(output.trim());
            expect(parsed.denied).toBe(true);
            expect(parsed.reason).toBe('spawn_policy_allowSpawnNew_false');
        });
    });
});
describe('worker recovery spawn policy routing (#522)', () => {
    it('worker recovery: allowSpawnNew=false denies recovery spawn-new route', () => {
        const route = evaluateRecoverySpawnRoute({
            policyLoadOk: true,
            policy: { allowSpawnNew: false, allowClaimPrResume: true },
            spawnAction: 'spawn-new',
        });
        expect(route.allowed).toBe(false);
        expect(route.reason).toBe('spawn_new_denied');
    });
    it('worker recovery: allowClaimPrResume=false denies claim-pr resume', () => {
        const route = evaluateRecoverySpawnRoute({
            policyLoadOk: true,
            policy: { allowSpawnNew: true, allowClaimPrResume: false },
            spawnAction: 'claim-pr-resume',
        });
        expect(route.allowed).toBe(false);
        expect(route.reason).toBe('claim_pr_resume_denied');
    });
    it('worker recovery: missing policy fails closed', () => {
        const route = evaluateRecoverySpawnRoute({
            policyLoadOk: false,
            policy: null,
            spawnAction: 'spawn-new',
        });
        expect(route.allowed).toBe(false);
        expect(route.reason).toBe('spawn_policy_missing_or_unreadable');
    });
});
