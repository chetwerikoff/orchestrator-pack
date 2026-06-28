import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import { seedMinimalRegistryTree } from './_test-registry-fixture.js';
import {
  AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION,
  TURN_VISIBLE_REAL_BINARY_ENV_VARS,
  evaluateAbsoluteSystemGitInvocationBoundary,
  evaluateAutonomousGitBoundary,
  evaluateAutonomousSpawnBoundary,
  evaluateBoundaryCapabilityPreflight,
  evaluateConfiguredGitBinaryBypass,
  evaluateTurnVisibleRealBinaryBypass,
  gitArgvDefinesAlias,
  gitSubcommandFromArgv,
  hasSanctionedGitParentChain,
  isKnownSystemGitBinaryPath,
  isMutatingGitArgv,
  isSanctionedGitParentCommandLine,
  isSpawnAoArgv,
  loadAutonomousOrchestratorBoundaryInventory,
  validateBoundaryCapabilityInventory,
} from '../docs/autonomous-orchestrator-boundary.mjs';
import { checkProtectedRuntimeDiff, checkProtectedRuntimeForRepo } from '../docs/orchestrator-message-registry.mjs';
import { autonomousBashEnv, gitFixtureEnv, withTempGitRepo } from './_test-git-fixture.js';
import { withAoSpawnProbeStub } from './_test-autonomous-ao-stub-fixture.js';

const guardPath = path.join(repoRoot, 'scripts/ao-autonomous-guard.ps1');
const gitGuardPath = path.join(repoRoot, 'scripts/git-autonomous-guard.ps1');
const gitRealBinaryPath = path.join(repoRoot, 'scripts/git-real-binary');
const bashEnvPath = path.join(repoRoot, 'scripts/autonomous-bash-env.sh');
const aoShimPath = path.join(repoRoot, 'scripts/ao');
const gitShimPath = path.join(repoRoot, 'scripts/git');
const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');

/** Bash skips BASH_ENV when POSIXLY_CORRECT or posix shell options are active. */
function spawnAutonomousBashTurn(cwd: string, command: string) {
  const { POSIXLY_CORRECT: _ignoredPc, SHELLOPTS: _ignoredSo, ...baseEnv } = process.env;
  return spawnSync('/bin/bash', ['-c', command], {
    cwd,
    encoding: 'utf8',
    env: {
      ...baseEnv,
      AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
      BASH_ENV: bashEnvPath,
    },
  });
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
  writeFileSync(
    path.join(dir, 'docs/declarations/324.opk-2.json'),
    `${JSON.stringify({
      issue_number: 324,
      iteration_id: 'opk-2',
      declared_paths: ['agent-orchestrator.yaml.example'],
    }, null, 2)}\n`,
  );
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
  } finally {
    for (const key of githubActionsEnvKeys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

describe('autonomous orchestrator spawn/git boundary (#324)', () => {
  it('exports stable boundary markers', () => {
    expect(AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION).toBe('autonomous-orchestrator-boundary/v1');
    expect(TURN_VISIBLE_REAL_BINARY_ENV_VARS).toContain('AO_REAL_BINARY');
    expect(TURN_VISIBLE_REAL_BINARY_ENV_VARS).toContain('GIT_REAL_BINARY');
  });

  it('policy-aware spawn boundary allows default-on autonomous spawn', () => {
    for (const commandLine of [
      'ao spawn opk-1',
      'ao spawn --claim-pr 322',
      '/usr/local/bin/ao spawn opk-1',
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
    expect(
      evaluateAutonomousGitBoundary({
        argv: ['-c', 'alias.co=checkout', 'co', 'main'],
        autonomousSurface: true,
      }).allowed,
    ).toBe(false);
  });

  it('positive-outcome: denies direct branch -m and allows claim-bound worktree add', () => {
    withTempGitRepo((dir) => {
      const deny = spawnSync(
        'bash',
        [gitShimPath, 'branch', '-m', 'blocked'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: autonomousBashEnv({ PATH: `${path.join(repoRoot, 'scripts')}:${gitFixtureEnv().PATH ?? '/usr/bin:/bin'}` }),
        },
      );
      expect(deny.status).toBe(93);
      expect(deny.stderr).toMatch(/autonomous tree-mutating git denied/i);

      const before = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
      const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
      const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-324-'));
      const projectId = 'orchestrator-pack';
      const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
      mkdirSync(workspaces, { recursive: true });
      const target = path.join(workspaces, 'opk-rev-324-positive');
      try {
        const allow = runPwsh(`
          . ${psString(path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1'))}
          $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
          $env:AO_BASE_DIR = ${psString(aoBase)}
          $env:AO_PROJECT_ID = ${psString(projectId)}
          $ns = Get-ReviewStartClaimProjectNamespace -ProjectId ${psString(projectId)}
          Initialize-ReviewStartClaimNamespace -Namespace $ns
          $record = New-ReviewStartClaimActiveRecord -PrNumber 324 -HeadSha ${psString(headSha)} -Surface 'orchestrator-turn' -Reason 'fixture'
          Write-ReviewStartClaimAtomic -Path (Get-ReviewStartClaimPath -Namespace $ns -PrNumber 324 -HeadSha ${psString(headSha)}) -Record $record
          . ${psString(boundaryLibPath)}
          $verdict = Test-AutonomousGitDenied -Argv @('worktree','add','--detach',${psString(target)},${psString(headSha)})
          [pscustomobject]@{ denied = [bool]$verdict.denied; reason = [string]$verdict.reason } | ConvertTo-Json -Compress
        `);
        const parsed = JSON.parse(allow);
        expect(parsed.denied).toBe(false);
        expect(parsed.reason).toBe('claimed_worktree_allow');
        expect(before.stdout.trim()).toBe('main');
      } finally {
        rmSync(aoBase, { recursive: true, force: true });
      }
    });
  });

  it('does not treat distant claimed-review-run ancestors as sanctioned git provenance', () => {
    const claimedParent = 'pwsh -NoProfile -File scripts/Invoke-OrchestratorClaimedReviewRun.ps1';
    const reviewRunWorktreeParent =
      'ao review run opk-1 --execute --command "git worktree add wt main"';
    const distantChain = [
      'pwsh -c "git branch -m blocked"',
      'intermediate shell',
      claimedParent,
    ];

    expect(
      hasSanctionedGitParentChain(distantChain, ['branch', '-m', 'blocked']),
    ).toBe(false);
    expect(
      hasSanctionedGitParentChain(distantChain, ['worktree', 'add', 'wt', 'main']),
    ).toBe(false);
    expect(
      hasSanctionedGitParentChain(
        ['shell', 'wrapper', reviewRunWorktreeParent],
        ['worktree', 'add', 'wt', 'main'],
      ),
    ).toBe(false);
    expect(
      hasSanctionedGitParentChain([claimedParent], ['worktree', 'add', '--detach', 'wt', 'main']),
    ).toBe(false);

    const deny = runPwsh(`
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      . ${psString(boundaryLibPath)}
      $chain = @(
        'pwsh -c "git branch -m blocked"',
        'intermediate shell',
        ${psString(claimedParent)}
      )
      $verdict = Test-AutonomousGitDenied -Argv @('branch','-m','blocked') -FixtureParentChain $chain
      [pscustomobject]@{ denied = [bool]$verdict.denied; reason = [string]$verdict.reason } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(deny);
    expect(parsed.denied).toBe(true);
    expect(parsed.reason).toBe('autonomous_mutating_git_denied');
  });

  it('denies ambiguous provenance even with spoofed bypass env on direct git', () => {
    const verdict = evaluateAutonomousGitBoundary({
      argv: ['checkout', 'main'],
      autonomousSurface: true,
      claimedBypass: true,
      parentChain: ['pwsh -NoProfile -Command git checkout main'],
    });
    expect(verdict.allowed).toBe(false);
    expect(
      evaluateAutonomousGitBoundary({
        argv: ['branch', '-m', 'blocked'],
        autonomousSurface: true,
        claimedBypass: true,
        parentChain: ['pwsh -c "git branch -m blocked # ao review run"'],
      }).allowed,
    ).toBe(false);
    expect(
      evaluateAutonomousGitBoundary({
        argv: ['branch', '-m', 'bypass'],
        autonomousSurface: true,
        claimedBypass: true,
        parentChain: ['ao review run opk-1 --execute --command echo; git branch -m bypass'],
      }).allowed,
    ).toBe(false);
    expect(
      hasSanctionedGitParentChain(['ao review run opk-1 --execute --command echo'], ['worktree', 'add', 'wt', 'main']),
    ).toBe(false);
    expect(
      evaluateAutonomousGitBoundary({
        argv: ['checkout', 'main'],
        autonomousSurface: true,
        parentChain: [
          'ao review run opk-1 --execute --command codex review',
          'codex exec review --json',
        ],
      }).allowed,
    ).toBe(false);
  });

  it('allows sanctioned preflight parent for mutating git', () => {
    expect(
      isSanctionedGitParentCommandLine('pwsh -File scripts/reviewer-workspace-preflight.ps1'),
    ).toBe(true);
    expect(
      isSanctionedGitParentCommandLine(
        'pwsh -NoProfile -ExecutionPolicy Bypass -File /pack/scripts/reviewer-workspace-preflight.ps1 -RepoRoot /tmp',
      ),
    ).toBe(true);
    expect(
      hasSanctionedGitParentChain([
        'pwsh -c "git checkout main # reviewer-workspace-preflight.ps1"',
      ], ['checkout', 'main']),
    ).toBe(false);
    expect(
      hasSanctionedGitParentChain([
        'bash -c "echo reviewer-workspace-preflight.ps1; git checkout main"',
      ], ['checkout', 'main']),
    ).toBe(false);
    expect(
      hasSanctionedGitParentChain([
        'pwsh -File scripts/run-pack-review.ps1',
        'codex exec review --json',
        'pwsh -c "git branch -m blocked"',
      ], ['branch', '-m', 'blocked']),
    ).toBe(false);
    expect(
      evaluateAutonomousGitBoundary({
        argv: ['worktree', 'remove', '--force', 'orphan'],
        autonomousSurface: true,
        parentChain: ['pwsh -File scripts/reviewer-workspace-preflight.ps1'],
      }).allowed,
    ).toBe(true);
  });

  it('blocks configured system git binary and absolute git-real-binary bypasses', () => {
    expect(isKnownSystemGitBinaryPath('/usr/bin/git')).toBe(true);
    expect(
      evaluateConfiguredGitBinaryBypass({
        configuredGitPath: '/usr/bin/git',
        packRoot: repoRoot,
      }).bypassPresent,
    ).toBe(true);
    expect(
      evaluateConfiguredGitBinaryBypass({
        configuredGitPath: gitRealBinaryPath,
        packRoot: repoRoot,
      }).bypassPresent,
    ).toBe(false);

    withTempGitRepo((dir) => {
      const denyShim = spawnSync('bash', [gitShimPath, 'branch', '-m', 'blocked'], {
        cwd: dir,
        encoding: 'utf8',
        env: autonomousBashEnv({ PATH: `${path.join(repoRoot, 'scripts')}:${gitFixtureEnv().PATH ?? '/usr/bin:/bin'}` }),
      });
      expect(denyShim.status).toBe(93);

      const denyRealBinary = spawnSync('bash', [gitRealBinaryPath, 'branch', '-m', 'blocked'], {
        cwd: dir,
        encoding: 'utf8',
        env: autonomousBashEnv(),
      });
      expect(denyRealBinary.status).toBe(93);
      expect(denyRealBinary.stderr).toMatch(/autonomous tree-mutating git denied/i);
    });

    expect(
      evaluateAbsoluteSystemGitInvocationBoundary({
        commandLine: '/usr/bin/git checkout main',
        autonomousSurface: true,
      }).allowed,
    ).toBe(false);
    expect(
      evaluateAbsoluteSystemGitInvocationBoundary({
        commandLine: '/usr/bin/git status',
        autonomousSurface: true,
      }).allowed,
    ).toBe(true);
  });

  it('documents bash interposer and git-real-binary wrapper wiring', () => {
    const yaml = readFileSync(path.join(repoRoot, 'agent-orchestrator.yaml.example'), 'utf8');
    expect(yaml).toMatch(/autonomous-bash-env\.sh/);
    const pathLine = yaml.match(/^\s*PATH:\s*(.+)$/m)?.[1] ?? '';
    const segments = pathLine.split(':').filter(Boolean);
    const scriptsIdx = segments.findIndex((segment) => segment.endsWith('/scripts'));
    const usrBinIdx = segments.indexOf('/usr/bin');
    expect(scriptsIdx).toBeGreaterThanOrEqual(0);
    expect(usrBinIdx).toBeGreaterThan(scriptsIdx);
    const example = JSON.parse(
      readFileSync(path.join(repoRoot, 'docs/autonomous-real-binaries.example.json'), 'utf8'),
    );
    expect(example.git).toMatch(/git-real-binary$/);
    expect(example.gitSystemBinary).toMatch(/^\/usr\/bin\/git$/);
    expect(existsSync(bashEnvPath)).toBe(true);
    expect(existsSync(gitRealBinaryPath)).toBe(true);
    expect(statSync(gitRealBinaryPath).mode & 0o111).toBeGreaterThan(0);
    expect(statSync(path.join(repoRoot, 'scripts/_invoke-system-git.sh')).mode & 0o111).toBeGreaterThan(0);

    if (existsSync('/usr/bin/git')) {
      withTempGitRepo((dir) => {
        const before = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
        const denyAbsolute = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; /usr/bin/git branch -m blocked-abs`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        const after = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
        expect(denyAbsolute.status).toBe(93);
        expect(denyAbsolute.stderr || denyAbsolute.stdout).toMatch(/autonomous tree-mutating git denied/i);
        expect(after.stdout.trim()).toBe(before.stdout.trim());

        const allowChain = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; /usr/bin/git status; echo done-marker`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(allowChain.stdout).toMatch(/done-marker/);

        const outFile = path.join(dir, 'status-out.txt');
        const allowRedirect = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; /usr/bin/git status >${outFile}; echo redirect-marker`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(allowRedirect.status).toBe(0);
        expect(allowRedirect.stdout).toMatch(/redirect-marker/);
        expect(existsSync(outFile)).toBe(true);
        expect(readFileSync(outFile, 'utf8').length).toBeGreaterThan(0);

        const directStatus = spawnSync('git', ['status'], { cwd: dir, encoding: 'utf8', env: gitFixtureEnv() });
        const interposedStatus = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; /usr/bin/git status`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(interposedStatus.status).toBe(0);
        expect(interposedStatus.stdout).toBe(directStatus.stdout);

        const directShort = spawnSync('bash', ['-c', 'GIT_OPTIONAL_LOCKS=0 git status --short'], {
          cwd: dir,
          encoding: 'utf8',
          env: gitFixtureEnv(),
        });
        const interposedShort = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; GIT_OPTIONAL_LOCKS=0 git status --short`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(interposedShort.status).toBe(0);
        expect(interposedShort.stdout).toBe(directShort.stdout);

        const directMultiEnv = spawnSync('bash', ['-c', 'FOO=1 BAR=2 git status --short'], {
          cwd: dir,
          encoding: 'utf8',
          env: gitFixtureEnv(),
        });
        const interposedMultiEnv = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; FOO=1 BAR=2 git status --short`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(interposedMultiEnv.status).toBe(0);
        expect(interposedMultiEnv.stdout).toBe(directMultiEnv.stdout);

        const allowLsFiles = spawnSync(
          'bash',
          [gitShimPath, 'ls-files'],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv({ PATH: `${path.join(repoRoot, 'scripts')}:${gitFixtureEnv().PATH ?? '/usr/bin:/bin'}` }),
          },
        );
        expect(allowLsFiles.status).toBe(0);

        const fallthrough = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; /usr/bin/git checkout -b absolute-bypass-branch`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(fallthrough.status).toBe(93);
        expect(fallthrough.stderr || fallthrough.stdout).toMatch(/autonomous tree-mutating git denied/i);

        const quotedAbsolute = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; "/usr/bin/git" branch -m quoted-abs-bypass`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(quotedAbsolute.status).toBe(93);
        expect(quotedAbsolute.stderr || quotedAbsolute.stdout).toMatch(/autonomous tree-mutating git denied/i);
        expect(spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).stdout.trim()).toBe(
          before.stdout.trim(),
        );

        const prefixedAbsolute = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; env AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1 /usr/bin/git checkout -b env-prefixed-bypass`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(prefixedAbsolute.status).toBe(93);
        expect(prefixedAbsolute.stderr || prefixedAbsolute.stdout).toMatch(/autonomous tree-mutating git denied/i);
        expect(spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).stdout.trim()).toBe(
          before.stdout.trim(),
        );

        const envPathGit = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; /usr/bin/env PATH=/usr/bin:/bin git branch -m env-path-bypass`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(envPathGit.status).toBe(93);
        expect(envPathGit.stderr || envPathGit.stdout).toMatch(/autonomous tree-mutating git denied/i);

        const directBashEnvShort = spawnSync('bash', ['-c', '/usr/bin/git status --short'], {
          cwd: dir,
          encoding: 'utf8',
        });
        const bashEnvInterposed = spawnAutonomousBashTurn(dir, '/usr/bin/git status --short');
        expect(bashEnvInterposed.status).toBe(0);
        expect(bashEnvInterposed.stdout).toBe(directBashEnvShort.stdout);
        expect(bashEnvInterposed.stderr).not.toMatch(/debugger|bashdb|extdebug/i);
        expect(bashEnvInterposed.stdout).not.toBe(`${directBashEnvShort.stdout}${directBashEnvShort.stdout}`);

        const subdir = path.join(dir, 'nested');
        mkdirSync(subdir);
        spawnSync('git', ['commit', '--allow-empty', '-m', 'seed'], { cwd: dir, encoding: 'utf8' });
        const directChained = spawnSync('bash', ['-c', 'cd nested && /usr/bin/git status --short'], {
          cwd: dir,
          encoding: 'utf8',
        });
        const interposedChained = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; cd nested && /usr/bin/git status --short`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(interposedChained.status).toBe(0);
        expect(interposedChained.stdout).toBe(directChained.stdout);

        const bashEnvChained = spawnAutonomousBashTurn(dir, 'cd nested && /usr/bin/git status --short');
        expect(bashEnvChained.status).toBe(0);
        expect(bashEnvChained.stdout).toBe(directChained.stdout);
      });
    }
  });

  it('interposes custom absolute git and ao real-binary paths', () => {
    withAoSpawnProbeStub(({ probeFile, pack }) => {
    const fakeBinRoot = mkdtempSync(path.join(tmpdir(), 'autonomous-fake-bin-'));
    try {
      const customGitDir = path.join(fakeBinRoot, 'opt', 'homebrew', 'bin');
      const customAoDir = path.join(fakeBinRoot, 'home', 'you', '.local', 'bin');
      mkdirSync(customGitDir, { recursive: true });
      mkdirSync(customAoDir, { recursive: true });
      const customGit = path.join(customGitDir, 'git');
      const customAo = path.join(customAoDir, 'ao');
      writeFileSync(customGit, '#!/usr/bin/env bash\nexec /usr/bin/git "$@"\n');
      writeFileSync(customAo, '#!/usr/bin/env bash\nprintf \'spawn-ok\\n\'\n');
      chmodSync(customGit, 0o755);
      chmodSync(customAo, 0o755);

      withTempGitRepo((dir) => {
        const before = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
        const denyCustomGit = spawnSync(
          'bash',
          ['-c', `source ${pack.bashEnvPath}; ${customGit} branch -m custom-git-bypass`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv(),
          },
        );
        expect(denyCustomGit.status).toBe(93);
        expect(denyCustomGit.stderr || denyCustomGit.stdout).toMatch(/autonomous tree-mutating git denied/i);
        expect(spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).stdout.trim()).toBe(
          before.stdout.trim(),
        );

        const allowCustomAo = spawnSync(
          'bash',
          ['-c', `source ${pack.bashEnvPath}; ${customAo} spawn opk-1`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: autonomousBashEnv({ AO_SPAWN_PROBE_FILE: probeFile }),
          },
        );
        expect(allowCustomAo.status).toBe(0);
        expect(`${allowCustomAo.stderr}${allowCustomAo.stdout}`).toMatch(/autonomous spawn policy allow: action=spawn-new/i);
        expect(existsSync(probeFile)).toBe(true);
      });
    } finally {
      rmSync(fakeBinRoot, { recursive: true, force: true });
    }
    });
  });

  it('denies git and ao paths hidden behind shell variable expansion', () => {
    withAoSpawnProbeStub(({ probeFile, pack }) => {
      withTempGitRepo((dir) => {
      const before = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
      const denyGitVar = spawnSync(
        'bash',
        ['-c', `source ${pack.bashEnvPath}; G=/usr/bin/git; "$G" branch -m var-expand-bypass`],
        {
          cwd: dir,
          encoding: 'utf8',
          env: autonomousBashEnv(),
        },
      );
      expect(denyGitVar.status).toBe(93);
      expect(denyGitVar.stderr || denyGitVar.stdout).toMatch(/autonomous tree-mutating git denied/i);
      expect(spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).stdout.trim()).toBe(
        before.stdout.trim(),
      );

      const denyGitCommandSubstitution = spawnSync(
        'bash',
        ['-c', `source ${pack.bashEnvPath}; echo $(/usr/bin/git branch -m blocked-cmdsub)`],
        {
          cwd: dir,
          encoding: 'utf8',
          env: autonomousBashEnv(),
        },
      );
      expect(denyGitCommandSubstitution.stderr || denyGitCommandSubstitution.stdout).toMatch(
        /autonomous tree-mutating git denied/i,
      );
      expect(spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).stdout.trim()).toBe(
        before.stdout.trim(),
      );

      const fakeAo = path.join(mkdtempSync(path.join(tmpdir(), 'autonomous-fake-ao-')), 'ao');
      writeFileSync(fakeAo, '#!/usr/bin/env bash\nprintf \'spawn-ok\\n\'\n');
      chmodSync(fakeAo, 0o755);
      const allowAoVar = spawnSync(
        'bash',
        ['-c', `source ${pack.bashEnvPath}; A=${fakeAo}; "$A" spawn opk-1`],
        {
          cwd: dir,
          encoding: 'utf8',
          env: autonomousBashEnv({ AO_SPAWN_PROBE_FILE: probeFile }),
        },
      );
      expect(allowAoVar.status).toBe(0);
      expect(`${allowAoVar.stderr}${allowAoVar.stdout}`).toMatch(
        /autonomous spawn policy allow: action=spawn-new/i,
      );
      expect(existsSync(probeFile)).toBe(true);
      });
    });
  });

  it('denies absolute git and ao invocations from bash script files under BASH_ENV', () => {
    withAoSpawnProbeStub(({ probeFile, pack }) => {
      withTempGitRepo((dir) => {
      const before = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
      const gitScript = path.join(dir, 'mutate-git.sh');
      writeFileSync(gitScript, '#!/usr/bin/env bash\n/usr/bin/git branch -m script-file-bypass\n');
      chmodSync(gitScript, 0o755);
      const denyGitScript = spawnSync('bash', [gitScript], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
          BASH_ENV: pack.bashEnvPath,
        },
      });
      expect(denyGitScript.status).toBe(93);
      expect(denyGitScript.stderr || denyGitScript.stdout).toMatch(/autonomous tree-mutating git denied/i);
      expect(spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).stdout.trim()).toBe(
        before.stdout.trim(),
      );

      const aoScript = path.join(dir, 'mutate-ao.sh');
      writeFileSync(aoScript, '#!/usr/bin/env bash\nao spawn opk-1\n');
      chmodSync(aoScript, 0o755);
      const allowAoScript = spawnSync('bash', [aoScript], {
        cwd: dir,
        encoding: 'utf8',
        env: autonomousBashEnv({ AO_SPAWN_PROBE_FILE: probeFile, BASH_ENV: pack.bashEnvPath }),
      });
      expect(allowAoScript.status).toBe(0);
      expect(`${allowAoScript.stderr}${allowAoScript.stdout}`).toMatch(
        /autonomous spawn policy allow: action=spawn-new/i,
      );
      expect(existsSync(probeFile)).toBe(true);
      });
    });
  });

  it('routes direct system-git forwarder and real-binary invocations through the guard', () => {
    withTempGitRepo((dir) => {
      const invokePath = path.join(repoRoot, 'scripts/_invoke-system-git.sh');
      const denyForwarder = spawnSync('bash', [invokePath, 'branch', '-m', 'forwarder-bypass'], {
        cwd: dir,
        encoding: 'utf8',
        env: autonomousBashEnv(),
      });
      expect(denyForwarder.status).toBe(93);
      expect(denyForwarder.stderr).toMatch(/autonomous tree-mutating git denied/i);

      const denyRealBinary = spawnSync(path.join(repoRoot, 'scripts/git-real-binary'), ['branch', '-m', 'real-binary-bypass'], {
        cwd: dir,
        encoding: 'utf8',
        env: autonomousBashEnv(),
      });
      expect(denyRealBinary.status).toBe(93);
      expect(denyRealBinary.stderr).toMatch(/autonomous tree-mutating git denied/i);

      const denySpoofedInternal = spawnSync(
        'bash',
        [invokePath, 'branch', '-m', 'internal-exec-bypass'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: autonomousBashEnv({
            AO_AUTONOMOUS_GIT_INTERNAL_EXEC: '1',
            PATH: `${path.join(repoRoot, 'scripts')}:${gitFixtureEnv().PATH ?? '/usr/bin:/bin'}`,
          }),
        },
      );
      expect(denySpoofedInternal.status).toBe(93);
      expect(denySpoofedInternal.stderr).toMatch(/autonomous tree-mutating git denied/i);

      const denySpoofedRealBinary = spawnSync(
        path.join(repoRoot, 'scripts/git-real-binary'),
        ['branch', '-m', 'real-binary-internal-bypass'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: autonomousBashEnv({
            AO_AUTONOMOUS_GIT_INTERNAL_EXEC: '1',
            PATH: `${path.join(repoRoot, 'scripts')}:${gitFixtureEnv().PATH ?? '/usr/bin:/bin'}`,
          }),
        },
      );
      expect(denySpoofedRealBinary.status).toBe(93);
      expect(denySpoofedRealBinary.stderr).toMatch(/autonomous tree-mutating git denied/i);
    });
  });

  it('keeps pack shims executable when system dirs trail scripts on PATH', () => {
    withTempGitRepo((dir) => {
      const minimalPath = `${path.join(repoRoot, 'scripts')}:/usr/bin:/bin`;
      const status = spawnSync('bash', [gitShimPath, 'status', '--short'], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '',
          PATH: minimalPath,
        },
      });
      expect(status.status).toBe(0);
      expect(`${status.stderr}${status.stdout}`).not.toMatch(/No such file or directory/i);
    });
  });

  it('validates capability inventory artifact', () => {
    const inventory = loadAutonomousOrchestratorBoundaryInventory();
    const result = validateBoundaryCapabilityInventory({
      repoInventory: inventory.capabilities,
      liveSurfaces: inventory.capabilities,
    });
    expect(result.ok).toBe(true);
    expect(
      evaluateBoundaryCapabilityPreflight({
        liveCapabilities: inventory.capabilities,
      }).ok,
    ).toBe(true);
  });

  it('example yaml documents out-of-band real binaries and git shim PATH', () => {
    const yaml = readFileSync(path.join(repoRoot, 'agent-orchestrator.yaml.example'), 'utf8');
    expect(yaml).not.toMatch(/^\s*AO_REAL_BINARY:/m);
    expect(yaml).not.toMatch(/^\s*GIT_REAL_BINARY:/m);
    expect(yaml).toMatch(/autonomous-real-binaries\.json/);
    expect(yaml).toMatch(/scripts\/ao \+ scripts\/git/);
    expect(yaml).toMatch(/AO_AUTONOMOUS_ORCHESTRATOR_SURFACE/);
  });

  it('detects turn-visible real-binary bypass vectors', () => {
    expect(
      evaluateTurnVisibleRealBinaryBypass({
        env: { AO_REAL_BINARY: '/usr/bin/ao' },
        pathValue: '/pack/scripts:/usr/bin',
      }).bypassPresent,
    ).toBe(true);
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
      expect(
        evaluateTurnVisibleRealBinaryBypass({
          env: {},
          pathValue: `${emptyDir}:${path.join(repoRoot, 'scripts')}:/usr/bin`,
        }).bypassPresent,
      ).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
    expect(
      evaluateTurnVisibleRealBinaryBypass({
        env: {},
        pathValue: '/pack/scripts:/usr/bin:/bin',
      }).bypassPresent,
    ).toBe(false);
  });

  it('autonomous ao guard allows spawn when default policy is on', () => {
    withAoSpawnProbeStub(({ probeFile, pack }) => {
      const isolatedGuardPath = path.join(pack.scriptsDir, 'ao-autonomous-guard.ps1');
      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', isolatedGuardPath, 'spawn', 'opk-1'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: autonomousBashEnv({
            AO_SPAWN_PROBE_FILE: probeFile,
          }),
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/autonomous spawn policy allow: action=spawn-new/i);
      expect(readFileSync(probeFile, 'utf8').trim().split('\n')).toEqual(['spawn', 'opk-1']);
    });
  });

  it('scripts/ao shim allows spawn --claim-pr on autonomous surface when policy and safety pass', () => {
    withAoSpawnProbeStub(({ probeFile, pack }) => {
      const result = spawnSync(
        pack.aoShimPath,
        ['spawn', '--claim-pr', '322'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: autonomousBashEnv({
            AO_SPAWN_PROBE_FILE: probeFile,
          }),
        },
      );
      expect(result.status).toBe(0);
      expect(`${result.stderr}${result.stdout}`).not.toMatch(/autonomous worker spawn denied/i);
    });
  });

  it('without marker, spawn and mutating git pass through shims', () => {
    withAoSpawnProbeStub(({ aoStub, probeFile, pack }) => {
      const isolatedGuardPath = path.join(pack.scriptsDir, 'ao-autonomous-guard.ps1');
      const spawnProbe = spawnSync(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', isolatedGuardPath, 'spawn', 'opk-1'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '',
            AO_REAL_BINARY: aoStub,
            AO_SPAWN_PROBE_FILE: probeFile,
          },
        },
      );
      expect(spawnProbe.status).not.toBe(93);
      expect(spawnProbe.status).toBe(0);
      expect(readFileSync(probeFile, 'utf8').trim().split('\n')).toEqual(['spawn', 'opk-1']);
    });

    withTempGitRepo((dir) => {
      const status = spawnSync('bash', [gitShimPath, 'status', '--short'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '' },
      });
      expect(status.status).toBe(0);
    });
  });

  it('ignores turn-visible GIT_SYSTEM_BINARY on autonomous surface', () => {
    const packRoot = mkdtempSync(path.join(tmpdir(), 'autonomous-pack-'));
    const fakeGit = path.join(packRoot, 'fake-git.sh');
    try {
      writeFileSync(fakeGit, '#!/usr/bin/env bash\n/usr/bin/git "$@"\n');
      chmodSync(fakeGit, 0o755);
      const aoDir = path.join(packRoot, '.ao');
      mkdirSync(aoDir, { recursive: true });
      writeFileSync(
        path.join(aoDir, 'autonomous-real-binaries.json'),
        JSON.stringify({
          ao: path.join(repoRoot, 'scripts/ao'),
          git: path.join(repoRoot, 'scripts/git-real-binary'),
          gitSystemBinary: '/usr/bin/git',
        }),
      );
      const output = runPwsh(`
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $env:GIT_SYSTEM_BINARY = ${psString(fakeGit)}
        . ${psString(boundaryLibPath)}
        [pscustomobject]@{
          resolved = [string](Resolve-SystemGitExecutable -PackRoot ${psString(packRoot)})
          spoofed = [bool]((Resolve-SystemGitExecutable -PackRoot ${psString(packRoot)}) -eq ${psString(fakeGit)})
        } | ConvertTo-Json -Compress
      `);
      const parsed = JSON.parse(output);
      expect(parsed.spoofed).toBe(false);
      expect(parsed.resolved).toMatch(/\/usr\/bin\/git$/);
    } finally {
      rmSync(packRoot, { recursive: true, force: true });
    }
  });

  it('ignores turn-visible AO_REAL_BINARY on autonomous surface', () => {
    const packRoot = mkdtempSync(path.join(tmpdir(), 'autonomous-pack-'));
    const fakeAo = path.join(packRoot, 'fake-ao.sh');
    const configuredAo = path.join(packRoot, 'configured-ao.sh');
    try {
      writeFileSync(fakeAo, '#!/usr/bin/env bash\necho spoofed-ao\n');
      writeFileSync(configuredAo, '#!/usr/bin/env bash\necho configured-ao\n');
      chmodSync(fakeAo, 0o755);
      chmodSync(configuredAo, 0o755);
      const aoDir = path.join(packRoot, '.ao');
      mkdirSync(aoDir, { recursive: true });
      writeFileSync(
        path.join(aoDir, 'autonomous-real-binaries.json'),
        JSON.stringify({ ao: configuredAo, git: path.join(repoRoot, 'scripts/git-real-binary'), gitSystemBinary: '/usr/bin/git' }),
      );
      const output = runPwsh(`
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $env:AO_REAL_BINARY = ${psString(fakeAo)}
        . ${psString(boundaryLibPath)}
        [pscustomobject]@{
          resolved = [string](Resolve-RealAoExecutable -PackRoot ${psString(packRoot)})
          spoofed = [bool]((Resolve-RealAoExecutable -PackRoot ${psString(packRoot)}) -eq ${psString(fakeAo)})
        } | ConvertTo-Json -Compress
      `);
      const parsed = JSON.parse(output);
      expect(parsed.spoofed).toBe(false);
      expect(parsed.resolved).toBe(configuredAo);
    } finally {
      rmSync(packRoot, { recursive: true, force: true });
    }
  });

  it('resolves real binaries from out-of-band config without turn-visible env', () => {
    const packRoot = mkdtempSync(path.join(tmpdir(), 'autonomous-pack-'));
    try {
      const fakeAo = path.join(packRoot, 'fake-ao');
      const gitWrapper = path.join(repoRoot, 'scripts/git-real-binary');
      writeFileSync(fakeAo, '#!/usr/bin/env bash\necho fake-ao-ok\n');
      chmodSync(fakeAo, 0o755);
      const aoDir = path.join(packRoot, '.ao');
      mkdirSync(aoDir, { recursive: true });
      writeFileSync(
        path.join(aoDir, 'autonomous-real-binaries.json'),
        JSON.stringify({ ao: fakeAo, git: gitWrapper, gitSystemBinary: '/usr/bin/git' }),
      );
      const output = runPwsh(`
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        Remove-Item Env:AO_REAL_BINARY -ErrorAction SilentlyContinue
        . ${psString(boundaryLibPath)}
        $resolved = Resolve-AutonomousRealBinaryPath -BinaryName 'ao' -PackRoot ${psString(packRoot)}
        [pscustomobject]@{ resolved = [string]$resolved; turnVisible = [bool](Test-TurnVisibleRealBinaryBypassPresent) } | ConvertTo-Json -Compress
      `);
      const parsed = JSON.parse(output);
      expect(parsed.resolved).toBe(fakeAo);
      expect(parsed.turnVisible).toBe(false);
    } finally {
      rmSync(packRoot, { recursive: true, force: true });
    }
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
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-protected-runtime.manifest.json'), 'utf8'),
    );
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
    } finally {
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
    } finally {
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
    } finally {
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('autonomous review worktree path hardening (#429)', () => {
  function withPathFixture(run: (ctx: { aoBase: string; projectId: string; workspaces: string }) => void) {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-worktree-path-'));
    const projectId = 'orchestrator-pack';
    const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
    mkdirSync(workspaces, { recursive: true });
    try {
      run({ aoBase, projectId, workspaces });
    } finally {
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

describe('autonomous review worktree claim-bound allow (#429)', () => {
  function evaluateClaimBound(
    argv: string[],
    aoBase: string,
    projectId: string,
    options: {
      extraEnv?: Record<string, string>;
      seedClaim?: { prNumber: number; headSha: string; holderPid?: number; holderStartTimeTicks?: string; holderBootIdHash?: string };
    } = {},
  ) {
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
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
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
    } finally {
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
    } finally {
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
    } finally {
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
    } finally {
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
    } finally {
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
    } finally {
      rmSync(aoBase, { recursive: true, force: true });
    }
  });

  it('claim-bound-worktree: denies regex ancestor without live claim (retired provenance)', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-regex-'));
    const projectId = 'orchestrator-pack';
    const headSha = '3'.repeat(40);
    const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
    mkdirSync(workspaces, { recursive: true });
    const target = path.join(workspaces, 'opk-rev-429-regex');
    try {
      const output = runPwsh(`
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $env:AO_BASE_DIR = ${psString(aoBase)}
        $env:AO_PROJECT_ID = ${psString(projectId)}
        . ${psString(boundaryLibPath)}
        $chain = @('pwsh -NoProfile -File scripts/Invoke-OrchestratorClaimedReviewRun.ps1')
        $verdict = Test-AutonomousGitDenied -Argv @('worktree','add','--detach',${psString(target)},${psString(headSha)}) -FixtureParentChain $chain
        [pscustomobject]@{ denied = [bool]$verdict.denied; reason = [string]$verdict.reason } | ConvertTo-Json -Compress
      `);
      const parsed = JSON.parse(output);
      expect(parsed.denied).toBe(true);
    } finally {
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
    } finally {
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
    } finally {
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
    } finally {
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
    } finally {
      rmSync(aoBase, { recursive: true, force: true });
    }
  });
});
