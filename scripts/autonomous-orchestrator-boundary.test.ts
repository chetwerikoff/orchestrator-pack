import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import { seedMinimalRegistryTree } from './_test-registry-fixture.js';
import { AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION, TURN_VISIBLE_REAL_BINARY_ENV_VARS, evaluateAutonomousGitBoundary, evaluateAutonomousSpawnBoundary, evaluateBoundaryCapabilityPreflight, evaluateTurnVisibleRealBinaryBypass, gitArgvDefinesAlias, gitSubcommandFromArgv, hasSanctionedGitParentChain, isMutatingGitArgv, isSanctionedGitParentCommandLine, isSpawnAoArgv, loadAutonomousOrchestratorBoundaryInventory, validateBoundaryCapabilityInventory } from '../docs/autonomous-orchestrator-boundary.mjs';
import { checkProtectedRuntimeDiff, checkProtectedRuntimeForRepo } from '../docs/orchestrator-message-registry.mjs';
const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');
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
    it('exports stable boundary markers', () => {
        expect(AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION).toBe('autonomous-orchestrator-boundary/v1');
        expect(TURN_VISIBLE_REAL_BINARY_ENV_VARS).toContain('AO_REAL_BINARY');
        expect(TURN_VISIBLE_REAL_BINARY_ENV_VARS).toContain('GIT_REAL_BINARY');
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
    it('example yaml documents out-of-band real binaries and git shim PATH', () => {
        const yaml = readFileSync(path.join(repoRoot, 'agent-orchestrator.yaml.example'), 'utf8');
        expect(yaml).not.toMatch(/^\s*AO_REAL_BINARY:/m);
        expect(yaml).not.toMatch(/^\s*GIT_REAL_BINARY:/m);
        expect(yaml).toMatch(/autonomous-real-binaries\.json/);
        expect(yaml).toMatch(/scripts\/ao \+ scripts\/git/);
        expect(yaml).toMatch(/AO_SESSION_ID/);
    });
    it('detects turn-visible real-binary bypass vectors', () => {
        expect(evaluateTurnVisibleRealBinaryBypass({
            env: { AO_REAL_BINARY: '/usr/bin/ao' },
            pathValue: '/pack/scripts:/usr/bin',
        }).bypassPresent).toBe(true);
        const misorderedPath = `/usr/bin:${path.join(repoRoot, 'scripts')}:/usr/bin`;
        const misordered = evaluateTurnVisibleRealBinaryBypass({
            env: {},
            pathValue: misorderedPath,
        });
        if (existsSync('/usr/bin/git') || existsSync('/usr/bin/ao')) {
            expect(misordered.bypassPresent).toBe(true);
            expect(misordered.reason).toBe('real_binary_before_shim_on_path');
        }
        const emptyDir = mkdtempSync(path.join(tmpdir(), 'autonomous-path-empty-'));
        try {
            expect(evaluateTurnVisibleRealBinaryBypass({
                env: {},
                pathValue: `${emptyDir}:${path.join(repoRoot, 'scripts')}:/usr/bin`,
            }).bypassPresent).toBe(false);
        }
        finally {
            rmSync(emptyDir, { recursive: true, force: true });
        }
        expect(evaluateTurnVisibleRealBinaryBypass({
            env: {},
            pathValue: '/pack/scripts:/usr/bin:/bin',
        }).bypassPresent).toBe(false);
    });
    describe('broken explicit ao pointer policy (Issue #495)', { timeout: 120000 }, () => {
        const BROKEN_POINTER_RE = /autonomous real-binary config: explicit ao pointer missing or not executable:/;
        const INVALID_JSON_RE = /autonomous real-binary config: invalid JSON/;
        function spawnAoFixtureBash(argv: string[], cwd: string, extraEnv: Record<string, string | undefined>) {
            return spawnSync('bash', argv, {
                cwd,
                encoding: 'utf8',
                env: {
                    ...stripInterposerBashEnvBlockers(process.env),
                    ...extraEnv,
                },
            });
        }
        function withBrokenAoPointerFixture(run: (ctx: {
            packRoot: string;
            brokenAo: string;
            fallbackAo: string;
            pathBin: string;
            configPath: string;
        }) => void) {
            const packRoot = mkdtempSync(path.join(tmpdir(), 'autonomous-broken-ao-'));
            const brokenAo = path.join(packRoot, 'deleted-ao-stub.sh');
            const pathBin = path.join(packRoot, 'bin');
            const fallbackAo = path.join(pathBin, 'ao');
            const configPath = path.join(packRoot, '.ao/autonomous-real-binaries.json');
            try {
                mkdirSync(path.join(packRoot, '.ao'), { recursive: true });
                mkdirSync(pathBin, { recursive: true });
                writeFileSync(fallbackAo, `#!/usr/bin/env bash
case "\${1:-}" in
  status) printf '{"data":[]}\n'; exit 0 ;;
  help) printf 'fallback-ao-help\n'; exit 0 ;;
esac
exit 0
`);
                chmodSync(fallbackAo, 0o755);
                mkdirSync(path.join(packRoot, 'scripts'), { recursive: true });
                for (const name of ['ao', '_resolve-pwsh.sh', 'ao-autonomous-guard.ps1']) {
                    cpSync(path.join(repoRoot, 'scripts', name), path.join(packRoot, 'scripts', name));
                    chmodSync(path.join(packRoot, 'scripts', name), 0o755);
                }
                cpSync(path.join(repoRoot, 'scripts/lib'), path.join(packRoot, 'scripts/lib'), { recursive: true });
                writeFileSync(configPath, `${JSON.stringify({ ao: brokenAo, git: path.join(repoRoot, 'scripts/git-real-binary'), gitSystemBinary: '/usr/bin/git' }, null, 2)}\n`);
                run({ packRoot, brokenAo, fallbackAo, pathBin, configPath });
            }
            finally {
                rmSync(packRoot, { recursive: true, force: true });
            }
        }
        it('emits resolver-path warning and falls back on autonomous surface bash fast path', () => {
            withBrokenAoPointerFixture(({ packRoot, pathBin }) => {
                const result = spawnAoFixtureBash([path.join(packRoot, 'scripts/ao'), 'status', '--json'], packRoot, {
                    AO_SESSION_ID: '1',
                    PATH: `${pathBin}:${path.join(packRoot, 'scripts')}:${process.env.PATH ?? ''}`,
                });
                expect(result.status).toBe(0);
                expect(result.stderr).toMatch(BROKEN_POINTER_RE);
                expect(() => JSON.parse(result.stdout)).not.toThrow();
            });
        });
        it('emits resolver-path warning and falls back on autonomous surface PS guard path', () => {
            withBrokenAoPointerFixture(({ packRoot, pathBin, fallbackAo, brokenAo }) => {
                const scriptsDir = path.join(packRoot, 'scripts');
                const minimalPath = `${pathBin}:${scriptsDir}:/usr/bin:/bin`;
                const output = runPwsh(`
          $env:AO_SESSION_ID = '1'
          $env:PATH = ${psString(minimalPath)}
          . ${psString(boundaryLibPath)}
          Invoke-AutonomousExplicitAoConfigSurfacePolicy -PackRoot ${psString(packRoot)} | Out-Null
          $resolved = Resolve-RealAoExecutable -PackRoot ${psString(packRoot)}
          [pscustomobject]@{
            resolved = [string]$resolved
            usesFallback = [bool]($resolved -eq ${psString(fallbackAo)})
            avoidsBroken = [bool]($resolved -ne ${psString(brokenAo)})
          } | ConvertTo-Json -Compress
        `);
                const parsed = JSON.parse(output);
                expect(parsed.usesFallback).toBe(true);
                expect(parsed.avoidsBroken).toBe(true);
            });
        });
    });
    it('resolves pack root from boundary lib without explicit PackRoot', () => {
        const output = runPwsh(`
      . ${psString(boundaryLibPath)}
      $packRoot = Get-PackRootFromBoundaryLib
      $scripts = Join-Path $packRoot 'scripts'
      $resolved = Resolve-AutonomousRealBinaryPath -BinaryName 'git'
      [pscustomobject]@{
        packRootEndsScripts = [bool]($packRoot -notlike '*\\scripts' -and $packRoot -notlike '*/scripts')
        scriptsDirExists = [bool](Test-Path -LiteralPath $scripts)
        resolvedNotScriptsScripts = [bool]($resolved -notlike '*scripts/scripts*')
      } | ConvertTo-Json -Compress
    `);
        const parsed = JSON.parse(output);
        expect(parsed.packRootEndsScripts).toBe(true);
        expect(parsed.scriptsDirExists).toBe(true);
        expect(parsed.resolvedNotScriptsScripts).toBe(true);
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
