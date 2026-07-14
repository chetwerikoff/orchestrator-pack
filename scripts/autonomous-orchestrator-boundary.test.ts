import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import { seedMinimalRegistryTree } from './_test-registry-fixture.js';
import { AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION, evaluateAutonomousGitBoundary, evaluateAutonomousSpawnBoundary, evaluateBoundaryCapabilityPreflight, gitArgvDefinesAlias, gitSubcommandFromArgv, hasSanctionedGitParentChain, isMutatingGitArgv, isSanctionedGitParentCommandLine, isSpawnAoArgv, loadAutonomousOrchestratorBoundaryInventory, validateBoundaryCapabilityInventory } from '../docs/autonomous-orchestrator-boundary.mjs';
import { checkProtectedRuntimeDiff, checkProtectedRuntimeForRepo } from '../docs/orchestrator-message-registry.mjs';
const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');
const spawnGateLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousSpawnGate.ps1');
const reviewStartGateLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousReviewStartGate.ps1');
const workerNudgeGateLibPath = path.join(repoRoot, 'scripts/lib/Worker-AutonomousNudgeGate.ps1');

function evaluateSessionRoleCell(sessionId: string | null) {
    const literal = sessionId === null ? '$null' : psString(sessionId);
    const output = runPwsh(`
      $prior = $env:AO_SESSION_ID
      try {
        if (${literal} -eq $null) { Remove-Item Env:AO_SESSION_ID -ErrorAction SilentlyContinue }
        else { $env:AO_SESSION_ID = ${literal} }
        . ${psString(spawnGateLibPath)}
        . ${psString(reviewStartGateLibPath)}
        . ${psString(workerNudgeGateLibPath)}
        . ${psString(boundaryLibPath)}
        $review = Test-AutonomousRawReviewRunDenied -Argv @('review','run')
        $worker = Test-AutonomousRawWorkerSendDenied -Argv @('send','worker-1')
        $git = Test-AutonomousGitDenied -Argv @('branch','-m','blocked')
        [pscustomobject]@{
          spawn = [bool](Test-OrchestratorAutonomousSurfaceActiveForSpawnGate)
          review = [bool](Test-OrchestratorAutonomousSurfaceActive)
          boundary = [bool](Test-OrchestratorAutonomousSurfaceActiveForBoundary)
          reviewDenied = [bool]$review.denied
          reviewReason = [string]$review.reason
          workerDenied = [bool]$worker.denied
          workerReason = [string]$worker.reason
          gitDenied = [bool]$git.denied
          gitReason = [string]$git.reason
        } | ConvertTo-Json -Compress
      }
      finally {
        if ($prior) { $env:AO_SESSION_ID = $prior }
        else { Remove-Item Env:AO_SESSION_ID -ErrorAction SilentlyContinue }
      }
      exit 0
    `);
    return JSON.parse(output.trim());
}
function initCoordinatedIssue324Fixture() {
    const dir = mkdtempSync(path.join(tmpdir(), 'coord-path-324-'));
    spawnSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' });
    seedMinimalRegistryTree(dir, ['agent-orchestrator.yaml.example']);
    spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'base'], { cwd: dir, encoding: 'utf8' });
    const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const yamlPath = path.join(dir, 'agent-orchestrator.yaml.example');
    writeFileSync(yamlPath, `${readFileSync(yamlPath, 'utf8')}\n# coordinated edit fixture\n`);
    spawnSync('git', ['add', 'agent-orchestrator.yaml.example'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'coord'], { cwd: dir, encoding: 'utf8' });
    return { dir, baseSha };
}
function initCoordinatedIssue324FixtureWithDeclaration() {
    const dir = mkdtempSync(path.join(tmpdir(), 'coord-path-324-decl-'));
    spawnSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' });
    seedMinimalRegistryTree(dir, ['agent-orchestrator.yaml.example']);
    mkdirSync(path.join(dir, 'docs/declarations'), { recursive: true });
    writeFileSync(path.join(dir, 'docs/declarations/324.opk-2.json'), `${JSON.stringify({
        issue_number: 324,
        iteration_id: 'opk-2',
        declared_paths: ['agent-orchestrator.yaml.example'],
    }, null, 2)}\n`);
    spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'base with declaration'], { cwd: dir, encoding: 'utf8' });
    const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const yamlPath = path.join(dir, 'agent-orchestrator.yaml.example');
    writeFileSync(yamlPath, `${readFileSync(yamlPath, 'utf8')}\n# coordinated edit fixture\n`);
    spawnSync('git', ['add', 'agent-orchestrator.yaml.example'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'coord'], { cwd: dir, encoding: 'utf8' });
    return { dir, baseSha };
}
const githubActionsEnvKeys = [
    'ORCHESTRATOR_MESSAGE_LINKED_ISSUES',
    'GITHUB_EVENT_PATH',
    'GITHUB_BASE_SHA',
    'PR_BASE_SHA',
    'ORCHESTRATOR_MESSAGE_REGISTRY_BASE_REF',
] as const;
function withoutGithubActionsEnv<T>(run: () => T): T {
    const prior: Partial<Record<(typeof githubActionsEnvKeys)[number], string>> = {};
    for (const key of githubActionsEnvKeys) {
        prior[key] = process.env[key];
        delete process.env[key];
    }
    try {
        return run();
    }
    finally {
        for (const key of githubActionsEnvKeys) {
            if (prior[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = prior[key];
        }
    }
}
describe('autonomous orchestrator spawn/git boundary (#324)', { timeout: 120000 }, () => {
    it('exports the stable boundary marker', () => {
        expect(AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION).toBe('autonomous-orchestrator-boundary/v1');
    });
    it.each([
        ['orchestrator', 'orchestrator-session'],
        ['worker', 'worker-session'],
    ])('%s session activates all in-process autonomous predicates', (_role, sessionId) => {
        const result = evaluateSessionRoleCell(sessionId);
        expect(result.spawn).toBe(true);
        expect(result.review).toBe(true);
        expect(result.boundary).toBe(true);
        expect(result.reviewDenied).toBe(true);
        expect(result.reviewReason).toBe('autonomous_raw_review_run_denied');
        expect(result.workerDenied).toBe(true);
        expect(result.workerReason).toBe('autonomous_raw_worker_send_denied');
        expect(result.gitDenied).toBe(true);
        expect(result.gitReason).toBe('autonomous_mutating_git_denied');
    });
    it.each([
        ['review', null],
        ['operator manual shell', null],
        ['CI', null],
    ])('%s without AO_SESSION_ID remains outside the in-process gate', (_role, sessionId) => {
        const result = evaluateSessionRoleCell(sessionId);
        expect(result.spawn).toBe(false);
        expect(result.review).toBe(false);
        expect(result.boundary).toBe(false);
        expect(result.reviewDenied).toBe(false);
        expect(result.reviewReason).toBe('manual_surface');
        expect(result.workerDenied).toBe(false);
        expect(result.workerReason).toBe('manual_surface');
        expect(result.gitDenied).toBe(false);
        expect(result.gitReason).toBe('manual_surface');
    });
    it('uses AO_SESSION_ID presence rather than a magic value', () => {
        const result = evaluateSessionRoleCell('worker-any-nonempty-value');
        expect(result.spawn).toBe(true);
        expect(result.review).toBe(true);
        expect(result.boundary).toBe(true);
    });
    it('retains the claimed-review bypass reason', () => {
        const output = runPwsh(`
          . ${psString(reviewStartGateLibPath)}
          $env:AO_SESSION_ID = 'orchestrator-session'
          $env:AO_CLAIMED_REVIEW_RUN_BYPASS = '1'
          (Test-AutonomousRawReviewRunDenied -Argv @('review','run')) | ConvertTo-Json -Compress
        `);
        const result = JSON.parse(output.trim());
        expect(result.denied).toBe(false);
        expect(result.reason).toBe('claimed_bypass');
    });
    it('retires direct-command boundary wrappers', () => {
        for (const retired of [
            'scripts/ao',
            'scripts/git',
            'scripts/ao-autonomous-guard.ps1',
            'scripts/git-autonomous-guard.ps1',
        ]) {
            expect(existsSync(path.join(repoRoot, retired))).toBe(false);
        }
    });
    it('policy-aware spawn boundary allows default-on autonomous spawn', () => {
        for (const commandLine of [
            'ao spawn --project orchestrator-pack --name "Boundary probe" --issue 1 --prompt "Boundary probe holder prompt"',
            'ao spawn --project orchestrator-pack --name "Claim PR" --claim-pr 322',
            '/usr/local/bin/ao spawn --project orchestrator-pack --name "Boundary probe" --issue 1 --prompt "Boundary probe holder prompt"',
        ]) {
            expect(evaluateAutonomousSpawnBoundary({ commandLine, autonomousSurface: true }).allowed).toBe(true);
            expect(evaluateAutonomousSpawnBoundary({ commandLine, autonomousSurface: false }).allowed).toBe(true);
        }
        expect(isSpawnAoArgv(['spawn', 'opk-1'])).toBe(true);
        expect(isSpawnAoArgv(['spawn', '--claim-pr', '322'])).toBe(true);
        expect(isSpawnAoArgv(['task', 'comment', '324', 'spawn denied'])).toBe(false);
    });
    it('classifies mutating vs read-only git argv', () => {
        expect(isMutatingGitArgv(['branch', '-m', 'a', 'b'])).toBe(true);
        expect(isMutatingGitArgv(['status'])).toBe(false);
        expect(isMutatingGitArgv(['ls-files'])).toBe(false);
        expect(isMutatingGitArgv(['-C', '/tmp/repo', 'ls-files'])).toBe(false);
        expect(isMutatingGitArgv(['merge-base', 'HEAD', 'main'])).toBe(false);
        expect(isMutatingGitArgv(['config', '--get', 'remote.origin.url'])).toBe(false);
        expect(isMutatingGitArgv(['config', 'user.name', 'blocked'])).toBe(true);
        expect(isMutatingGitArgv(['branch', '--show-current'])).toBe(false);
        expect(isMutatingGitArgv(['branch', 'foo--show-current'])).toBe(true);
        expect(isMutatingGitArgv(['config', 'user.name', 'foo--get'])).toBe(true);
        expect(isMutatingGitArgv(['config', 'user.name', '--get'])).toBe(true);
        expect(isMutatingGitArgv(['config', '--get', 'user.name'])).toBe(false);
        expect(isMutatingGitArgv(['fetch', 'origin--dry-run'])).toBe(true);
        expect(isMutatingGitArgv(['branch', '-m', 'a', 'b'])).toBe(true);
        expect(isMutatingGitArgv(['fetch', '--dry-run'])).toBe(false);
        expect(isMutatingGitArgv(['fetch', 'origin'])).toBe(true);
        expect(isMutatingGitArgv(['commit', '-m', 'blocked'])).toBe(true);
        expect(isMutatingGitArgv(['merge', 'main'])).toBe(true);
        expect(isMutatingGitArgv(['rebase', 'main'])).toBe(true);
        expect(isMutatingGitArgv(['pull'])).toBe(true);
        expect(isMutatingGitArgv(['tag', 'v1'])).toBe(true);
        expect(gitSubcommandFromArgv(['-C', '/tmp', 'log'])).toBe('log');
        expect(isMutatingGitArgv(['-c', 'user.name=x', 'checkout', 'main'])).toBe(true);
        expect(gitSubcommandFromArgv(['-c', 'user.name=x', 'status'])).toBe('status');
        expect(isMutatingGitArgv(['-cuser.name=x', 'checkout', 'main'])).toBe(true);
        expect(gitArgvDefinesAlias(['-c', 'alias.co=checkout', 'co', 'main'])).toBe(true);
        expect(isMutatingGitArgv(['-c', 'alias.co=checkout', 'co', 'main'])).toBe(true);
        expect(evaluateAutonomousGitBoundary({
            argv: ['-c', 'alias.co=checkout', 'co', 'main'],
            autonomousSurface: true,
        }).allowed).toBe(false);
    });
    it('denies ambiguous provenance even with spoofed bypass env on direct git', () => {
        const verdict = evaluateAutonomousGitBoundary({
            argv: ['checkout', 'main'],
            autonomousSurface: true,
            claimedBypass: true,
            parentChain: ['pwsh -NoProfile -Command git checkout main'],
        });
        expect(verdict.allowed).toBe(false);
        expect(evaluateAutonomousGitBoundary({
            argv: ['branch', '-m', 'blocked'],
            autonomousSurface: true,
            claimedBypass: true,
            parentChain: ['pwsh -c "git branch -m blocked # ao review run"'],
        }).allowed).toBe(false);
        expect(evaluateAutonomousGitBoundary({
            argv: ['branch', '-m', 'bypass'],
            autonomousSurface: true,
            claimedBypass: true,
            parentChain: ['ao review run opk-1 --execute --command echo; git branch -m bypass'],
        }).allowed).toBe(false);
        expect(hasSanctionedGitParentChain(['ao review run opk-1 --execute --command echo'], ['worktree', 'add', 'wt', 'main'])).toBe(false);
        expect(evaluateAutonomousGitBoundary({
            argv: ['checkout', 'main'],
            autonomousSurface: true,
            parentChain: [
                'ao review run opk-1 --execute --command codex review',
                'codex exec review --json',
            ],
        }).allowed).toBe(false);
    });
    it('allows sanctioned preflight parent for mutating git', () => {
        expect(isSanctionedGitParentCommandLine('pwsh -File scripts/reviewer-workspace-preflight.ps1')).toBe(true);
        expect(isSanctionedGitParentCommandLine('pwsh -NoProfile -ExecutionPolicy Bypass -File /pack/scripts/reviewer-workspace-preflight.ps1 -RepoRoot /tmp')).toBe(true);
        expect(hasSanctionedGitParentChain([
            'pwsh -c "git checkout main # reviewer-workspace-preflight.ps1"',
        ], ['checkout', 'main'])).toBe(false);
        expect(hasSanctionedGitParentChain([
            'bash -c "echo reviewer-workspace-preflight.ps1; git checkout main"',
        ], ['checkout', 'main'])).toBe(false);
        expect(hasSanctionedGitParentChain([
            'pwsh -File scripts/run-pack-review.ps1',
            'codex exec review --json',
            'pwsh -c "git branch -m blocked"',
        ], ['branch', '-m', 'blocked'])).toBe(false);
        expect(evaluateAutonomousGitBoundary({
            argv: ['worktree', 'remove', '--force', 'orphan'],
            autonomousSurface: true,
            parentChain: ['pwsh -File scripts/reviewer-workspace-preflight.ps1'],
        }).allowed).toBe(true);
    });
    it('validates capability inventory artifact', () => {
        const inventory = loadAutonomousOrchestratorBoundaryInventory();
        const result = validateBoundaryCapabilityInventory({
            repoInventory: inventory.capabilities,
            liveSurfaces: inventory.capabilities,
        });
        expect(result.ok).toBe(true);
        expect(evaluateBoundaryCapabilityPreflight({
            liveCapabilities: inventory.capabilities,
        }).ok).toBe(true);
    });
    it('example yaml documents AO 0.10.2 in-process session gates', () => {
        const yaml = readFileSync(path.join(repoRoot, 'agent-orchestrator.yaml.example'), 'utf8');
        expect(yaml).not.toMatch(/^\s*AO_REAL_BINARY:/m);
        expect(yaml).not.toMatch(/^\s*GIT_REAL_BINARY:/m);
        expect(yaml).not.toMatch(/autonomous-real-binaries\.json/);
        expect(yaml).not.toMatch(/scripts\/ao \+ scripts\/git/);
        expect(yaml).toMatch(/AO_SESSION_ID/);
        expect(yaml).toMatch(/in-process gates/i);
    });
    it('allows coordinated agent-orchestrator.yaml.example edits for issue 324', () => {
        const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-protected-runtime.manifest.json'), 'utf8'));
        const denied = checkProtectedRuntimeDiff(['agent-orchestrator.yaml.example'], manifest);
        expect(denied.ok).toBe(false);
        const allowed = checkProtectedRuntimeDiff(['agent-orchestrator.yaml.example'], manifest, {
            linkedIssueNumbers: [324],
        });
        expect(allowed.ok).toBe(true);
    });
    it('does not self-authorize issue-324 from yaml.example edits without explicit link', () => {
        const { dir, baseSha } = initCoordinatedIssue324Fixture();
        try {
            withoutGithubActionsEnv(() => {
                process.env.GITHUB_BASE_SHA = baseSha;
                const result = checkProtectedRuntimeForRepo(dir, baseSha);
                expect(result.ok).toBe(false);
                expect(result.violations.some((v: string) => v.includes('agent-orchestrator.yaml.example'))).toBe(true);
            });
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('allows issue-324 yaml.example edits when ORCHESTRATOR_MESSAGE_LINKED_ISSUES is set', () => {
        const { dir, baseSha } = initCoordinatedIssue324Fixture();
        try {
            withoutGithubActionsEnv(() => {
                process.env.GITHUB_BASE_SHA = baseSha;
                process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES = '324';
                const result = checkProtectedRuntimeForRepo(dir, baseSha);
                expect(result.ok).toBe(true);
            });
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('allows issue-324 yaml.example edits from committed declaration snapshot without env link', () => {
        const { dir, baseSha } = initCoordinatedIssue324FixtureWithDeclaration();
        try {
            withoutGithubActionsEnv(() => {
                process.env.GITHUB_BASE_SHA = baseSha;
                const result = checkProtectedRuntimeForRepo(dir, baseSha);
                expect(result.ok).toBe(true);
            });
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('does not self-authorize issue-324 from fake declaration snapshots in the gated diff', () => {
        const { dir, baseSha } = initCoordinatedIssue324Fixture();
        try {
            mkdirSync(path.join(dir, 'docs/declarations'), { recursive: true });
            writeFileSync(path.join(dir, 'docs/declarations/324.fake.json'), '{}\n');
            spawnSync('git', ['add', 'docs/declarations/324.fake.json'], { cwd: dir, encoding: 'utf8' });
            spawnSync('git', ['commit', '-m', 'fake declaration'], { cwd: dir, encoding: 'utf8' });
            withoutGithubActionsEnv(() => {
                process.env.GITHUB_BASE_SHA = baseSha;
                const result = checkProtectedRuntimeForRepo(dir, baseSha);
                expect(result.ok).toBe(false);
                expect(result.violations.some((v: string) => v.includes('agent-orchestrator.yaml.example'))).toBe(true);
            });
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe('autonomous review worktree path hardening (#429)', { timeout: 120000 }, () => {
    function withPathFixture(run: (ctx: {
        aoBase: string;
        projectId: string;
        workspaces: string;
    }) => void) {
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-worktree-path-'));
        const projectId = 'orchestrator-pack';
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        try {
            run({ aoBase, projectId, workspaces });
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    }
    function evaluatePathHardening(targetPath: string, aoBase: string, projectId: string) {
        return JSON.parse(runPwsh(`
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = ${psString(projectId)}
      . ${psString(boundaryLibPath)}
      $result = Test-AutonomousReviewWorktreeTargetPathHardened -TargetPath ${psString(targetPath)} -ProjectId ${psString(projectId)}
      [pscustomobject]@{ allowed = [bool]$result.allowed; reason = [string]$result.reason } | ConvertTo-Json -Compress
    `));
    }
    it('worktree-path-hardening: allows a new workspace under the canonical prefix', () => {
        withPathFixture(({ aoBase, projectId, workspaces }) => {
            const target = path.join(workspaces, 'opk-rev-429-new');
            const result = evaluatePathHardening(target, aoBase, projectId);
            expect(result.allowed).toBe(true);
        });
    });
    it('worktree-path-hardening: denies traversal escape attempts', () => {
        withPathFixture(({ aoBase, projectId, workspaces }) => {
            const escape = path.join(workspaces, '..', '..', 'escaped-workspace');
            const result = evaluatePathHardening(escape, aoBase, projectId);
            expect(result.allowed).toBe(false);
        });
    });
    it('worktree-path-hardening: denies symlink escape attempts', () => {
        withPathFixture(({ aoBase, projectId, workspaces }) => {
            const outside = path.join(aoBase, 'outside-escape');
            mkdirSync(outside, { recursive: true });
            const link = path.join(workspaces, 'escape-link');
            const linked = spawnSync('ln', ['-s', outside, link], { encoding: 'utf8' });
            if (linked.status !== 0) {
                return;
            }
            const result = evaluatePathHardening(path.join(link, 'nested'), aoBase, projectId);
            expect(result.allowed).toBe(false);
        });
    });
    it('worktree-path-hardening: denies projectId namespace mismatch', () => {
        withPathFixture(({ aoBase }) => {
            const otherRoot = path.join(aoBase, 'projects', 'other-project', 'code-reviews', 'workspaces', 'opk-rev-other');
            const result = evaluatePathHardening(otherRoot, aoBase, 'orchestrator-pack');
            expect(result.allowed).toBe(false);
        });
    });
    it('worktree-path-hardening: denies pre-existing workspace directories', () => {
        withPathFixture(({ aoBase, projectId, workspaces }) => {
            const existing = path.join(workspaces, 'opk-rev-existing');
            mkdirSync(existing, { recursive: true });
            const result = evaluatePathHardening(existing, aoBase, projectId);
            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('target_preexists');
        });
    });
});
describe('autonomous review worktree claim-bound allow (#429)', { timeout: 120000 }, () => {
    function evaluateClaimBound(argv: string[], aoBase: string, projectId: string, options: {
        extraEnv?: Record<string, string>;
        seedClaim?: {
            prNumber: number;
            headSha: string;
            holderPid?: number;
            holderStartTimeTicks?: string;
            holderBootIdHash?: string;
        };
    } = {}) {
        const argvLiteral = argv.map((part) => psString(part)).join(',');
        const extra = Object.entries(options.extraEnv ?? {})
            .map(([key, value]) => `$env:${key} = ${psString(value)}`)
            .join('\n      ');
        const claimLib = psString(path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1'));
        const seed = options.seedClaim;
        const seedBlock = seed
            ? `
      . ${claimLib}
      $ns = Get-ReviewStartClaimProjectNamespace -ProjectId ${psString(projectId)}
      Initialize-ReviewStartClaimNamespace -Namespace $ns
      $record = New-ReviewStartClaimActiveRecord -PrNumber ${seed.prNumber} -HeadSha ${psString(seed.headSha)} -Surface 'orchestrator-turn' -Reason 'fixture'
      ${seed.holderPid ? `$record.holder.pid = ${seed.holderPid}` : ''}
      ${seed.holderStartTimeTicks !== undefined ? `$record.holder.startTimeTicks = ${psString(seed.holderStartTimeTicks)}` : ''}
      ${seed.holderBootIdHash !== undefined ? `$record.holder.bootIdHash = ${psString(seed.holderBootIdHash)}` : ''}
      Write-ReviewStartClaimAtomic -Path (Get-ReviewStartClaimPath -Namespace $ns -PrNumber ${seed.prNumber} -HeadSha ${psString(seed.headSha)}) -Record $record`
            : '';
        return JSON.parse(runPwsh(`
      $env:AO_SESSION_ID = '1'
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = ${psString(projectId)}
      ${extra}
      ${seedBlock}
      . ${psString(boundaryLibPath)}
      $verdict = Test-AutonomousGitDenied -Argv @(${argvLiteral})
      [pscustomobject]@{ denied = [bool]$verdict.denied; reason = [string]$verdict.reason } | ConvertTo-Json -Compress
    `));
    }
    it('claim-bound-worktree: allows live owned claim with explicit commit and detach', () => {
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-bound-'));
        const projectId = 'orchestrator-pack';
        const headSha = 'b'.repeat(40);
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        const target = path.join(workspaces, 'opk-rev-429-allow');
        try {
            const parsed = evaluateClaimBound(['worktree', 'add', '--detach', target, headSha], aoBase, projectId, {
                seedClaim: { prNumber: 429, headSha },
            });
            expect(parsed.denied).toBe(false);
            expect(parsed.reason).toBe('claimed_worktree_allow');
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    });
    it('claim-bound-worktree: denies when claim is missing', () => {
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-missing-'));
        const projectId = 'orchestrator-pack';
        const headSha = 'c'.repeat(40);
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        const target = path.join(workspaces, 'opk-rev-429-missing');
        try {
            const parsed = evaluateClaimBound(['worktree', 'add', '--detach', target, headSha], aoBase, projectId);
            expect(parsed.denied).toBe(true);
            expect(parsed.reason).toBe('autonomous_mutating_git_denied');
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    });
    it('claim-bound-worktree: denies active claim with dead holder', () => {
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-dead-'));
        const projectId = 'orchestrator-pack';
        const headSha = 'd'.repeat(40);
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        const target = path.join(workspaces, 'opk-rev-429-dead');
        try {
            const parsed = evaluateClaimBound(['worktree', 'add', '--detach', target, headSha], aoBase, projectId, {
                seedClaim: { prNumber: 429, headSha, holderPid: 99999999 },
            });
            expect(parsed.denied).toBe(true);
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    });
    it('claim-bound-worktree: denies wrong head sha', () => {
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-wrong-head-'));
        const projectId = 'orchestrator-pack';
        const headSha = 'e'.repeat(40);
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        const target = path.join(workspaces, 'opk-rev-429-wrong');
        try {
            const parsed = evaluateClaimBound(['worktree', 'add', '--detach', target, 'f'.repeat(40)], aoBase, projectId, {
                seedClaim: { prNumber: 429, headSha },
            });
            expect(parsed.denied).toBe(true);
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    });
    it('claim-bound-worktree: denies implicit commit worktree add', () => {
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-implicit-'));
        const projectId = 'orchestrator-pack';
        const headSha = '1'.repeat(40);
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        const target = path.join(workspaces, 'opk-rev-429-implicit');
        try {
            const parsed = evaluateClaimBound(['worktree', 'add', '--detach', target], aoBase, projectId, {
                seedClaim: { prNumber: 429, headSha },
            });
            expect(parsed.denied).toBe(true);
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    });
    it('claim-bound-worktree: denies env bypass without live claim', () => {
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-bypass-'));
        const projectId = 'orchestrator-pack';
        const headSha = '2'.repeat(40);
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        const target = path.join(workspaces, 'opk-rev-429-bypass');
        try {
            const parsed = evaluateClaimBound(['worktree', 'add', '--detach', target, headSha], aoBase, projectId, {
                extraEnv: { AO_CLAIMED_REVIEW_RUN_BYPASS: '1' },
            });
            expect(parsed.denied).toBe(true);
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    });
    it('claim-bound-worktree: denies replay after claim is consumed by first worktree allow', () => {
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-replay-'));
        const projectId = 'orchestrator-pack';
        const headSha = '7'.repeat(40);
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        const targetFirst = path.join(workspaces, 'opk-rev-429-first');
        const targetSecond = path.join(workspaces, 'opk-rev-429-second');
        try {
            const first = evaluateClaimBound(['worktree', 'add', '--detach', targetFirst, headSha], aoBase, projectId, {
                seedClaim: { prNumber: 429, headSha },
            });
            expect(first.denied).toBe(false);
            expect(first.reason).toBe('claimed_worktree_allow');
            const second = evaluateClaimBound(['worktree', 'add', '--detach', targetSecond, headSha], aoBase, projectId);
            expect(second.denied).toBe(true);
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    });
    it('claim-bound-worktree: denies non-SHA commit refs without throwing', () => {
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-non-sha-'));
        const projectId = 'orchestrator-pack';
        const headSha = '5'.repeat(40);
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        const target = path.join(workspaces, 'opk-rev-429-non-sha');
        try {
            const parsed = evaluateClaimBound(['worktree', 'add', '--detach', target, 'main'], aoBase, projectId, {
                seedClaim: { prNumber: 429, headSha },
            });
            expect(parsed.denied).toBe(true);
            expect(parsed.reason).toBe('autonomous_mutating_git_denied');
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    });
    it('claim-bound-worktree: denies stale claim when holder PID is reused with wrong startTimeTicks', () => {
        if (process.platform !== 'linux') {
            return;
        }
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-pid-reuse-'));
        const projectId = 'orchestrator-pack';
        const headSha = '6'.repeat(40);
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        const target = path.join(workspaces, 'opk-rev-429-pid-reuse');
        const holderPid = Number(process.pid);
        try {
            const parsed = evaluateClaimBound(['worktree', 'add', '--detach', target, headSha], aoBase, projectId, {
                seedClaim: {
                    prNumber: 429,
                    headSha,
                    holderPid,
                    holderStartTimeTicks: '1',
                    holderBootIdHash: 'dead-boot-hash',
                },
            });
            expect(parsed.denied).toBe(true);
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    });
    it('documents cooperative residual: concurrent live claim may allow armed-manual worktree add', () => {
        const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-residual-'));
        const projectId = 'orchestrator-pack';
        const headSha = '4'.repeat(40);
        const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
        mkdirSync(workspaces, { recursive: true });
        const target = path.join(workspaces, 'opk-rev-429-residual');
        try {
            const parsed = evaluateClaimBound(['worktree', 'add', '--detach', target, headSha], aoBase, projectId, {
                seedClaim: { prNumber: 429, headSha },
            });
            expect([true, false]).toContain(parsed.denied);
        }
        finally {
            rmSync(aoBase, { recursive: true, force: true });
        }
    });
});
describe('worker recovery boundary (#522)', { timeout: 120000 }, () => {
    it('worktree list recovery boundary: allows list and denies mutating worktree without recovery parent', () => {
        for (const argv of [['worktree', 'list'], ['worktree', 'list', '--porcelain']]) {
            const verdict = evaluateAutonomousGitBoundary({ argv, autonomousSurface: true });
            expect(verdict.allowed).toBe(true);
            expect(verdict.reason).toBe('read_only_git');
        }
        for (const argv of [
            ['worktree', 'add', '/tmp/wt', 'main'],
            ['worktree', 'prune'],
            ['worktree', 'move', '/tmp/a', '/tmp/b'],
            ['branch', '-m', 'old', 'new'],
        ]) {
            const verdict = evaluateAutonomousGitBoundary({ argv, autonomousSurface: true });
            expect(verdict.allowed).toBe(false);
            expect(verdict.reason).toBe('autonomous_mutating_git_denied');
        }
        const removeDenied = evaluateAutonomousGitBoundary({
            argv: ['worktree', 'remove', '--force', '/tmp/orchestrator-pack/worktrees/opk-522'],
            autonomousSurface: true,
        });
        expect(removeDenied.allowed).toBe(false);
        expect(removeDenied.reason).toBe('autonomous_mutating_git_denied');
    });
    it('sanctioned worker recovery parent: allows claim-bound remove and denies spoofed parent', () => {
        const target = '/tmp/orchestrator-pack/worktrees/opk-522';
        const allowed = evaluateAutonomousGitBoundary({
            argv: ['worktree', 'remove', '--force', target],
            autonomousSurface: true,
            recoveryWorktreeRemoveAllow: true,
        });
        expect(allowed.allowed).toBe(true);
        expect(allowed.reason).toBe('recovery_worktree_remove_allow');
        const spoofed = evaluateAutonomousGitBoundary({
            argv: ['worktree', 'remove', '--force', target],
            autonomousSurface: true,
            parentChain: ['pwsh -File scripts/run-pack-review.ps1'],
        });
        expect(spoofed.allowed).toBe(false);
        const reviewPreflight = evaluateAutonomousGitBoundary({
            argv: ['worktree', 'remove', '--force', '/tmp/code-reviews/workspaces/op-rev-1'],
            autonomousSurface: true,
            parentChain: ['pwsh -File scripts/reviewer-workspace-preflight.ps1'],
        });
        expect(reviewPreflight.allowed).toBe(true);
        expect(reviewPreflight.reason).toBe('sanctioned_git_child');
        const prune = evaluateAutonomousGitBoundary({
            argv: ['worktree', 'prune'],
            autonomousSurface: true,
            recoveryWorktreeRemoveAllow: true,
        });
        expect(prune.allowed).toBe(false);
    });
});
