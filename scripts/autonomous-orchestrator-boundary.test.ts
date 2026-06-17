import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
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

const guardPath = path.join(repoRoot, 'scripts/ao-autonomous-guard.ps1');
const gitGuardPath = path.join(repoRoot, 'scripts/git-autonomous-guard.ps1');
const gitRealBinaryPath = path.join(repoRoot, 'scripts/git-real-binary');
const bashEnvPath = path.join(repoRoot, 'scripts/autonomous-bash-env.sh');
const aoShimPath = path.join(repoRoot, 'scripts/ao');
const gitShimPath = path.join(repoRoot, 'scripts/git');
const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');

function withTempGitRepo(run: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autonomous-boundary-'));
  try {
    spawnSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' });
    writeFileSync(path.join(dir, 'README.md'), 'test\n');
    spawnSync('git', ['add', 'README.md'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf8' });
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('autonomous orchestrator spawn/git boundary (#324)', () => {
  it('exports stable boundary markers', () => {
    expect(AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION).toBe('autonomous-orchestrator-boundary/v1');
    expect(TURN_VISIBLE_REAL_BINARY_ENV_VARS).toContain('AO_REAL_BINARY');
    expect(TURN_VISIBLE_REAL_BINARY_ENV_VARS).toContain('GIT_REAL_BINARY');
  });

  it('denies autonomous spawn across command spellings', () => {
    for (const commandLine of [
      'ao spawn opk-1',
      'ao spawn --claim-pr 322',
      '/usr/local/bin/ao spawn opk-1',
    ]) {
      expect(evaluateAutonomousSpawnBoundary({ commandLine, autonomousSurface: true }).allowed).toBe(false);
      expect(evaluateAutonomousSpawnBoundary({ commandLine, autonomousSurface: false }).allowed).toBe(true);
    }
    expect(isSpawnAoArgv(['spawn', 'opk-1'])).toBe(true);
    expect(isSpawnAoArgv(['spawn', '--claim-pr', '322'])).toBe(true);
    expect(isSpawnAoArgv(['task', 'comment', '324', 'spawn denied'])).toBe(false);
  });

  it('classifies mutating vs read-only git argv', () => {
    expect(isMutatingGitArgv(['branch', '-m', 'a', 'b'])).toBe(true);
    expect(isMutatingGitArgv(['status'])).toBe(false);
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

  it('positive-outcome: denies direct branch -m and allows ao-review-run child worktree add', () => {
    withTempGitRepo((dir) => {
      const deny = spawnSync(
        'bash',
        [gitShimPath, 'branch', '-m', 'blocked'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1', PATH: `${path.join(repoRoot, 'scripts')}:${process.env.PATH ?? ''}` },
        },
      );
      expect(deny.status).toBe(93);
      expect(deny.stderr).toMatch(/autonomous tree-mutating git denied/i);

      const before = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
      const allow = runPwsh(`
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $env:AO_CLAIMED_REVIEW_RUN_BYPASS = '1'
        $env:PATH = ${psString(path.join(repoRoot, 'scripts'))} + ':' + $env:PATH
        . ${psString(boundaryLibPath)}
        $verdict = Test-AutonomousGitDenied -Argv @('worktree','add','${dir.replace(/\\/g, '/')}/wt','main') -FixtureParentChain @('ao review run opk-1 --execute --command echo')
        [pscustomobject]@{ denied = [bool]$verdict.denied; reason = [string]$verdict.reason } | ConvertTo-Json -Compress
      `);
      const parsed = JSON.parse(allow);
      expect(parsed.denied).toBe(false);
      expect(parsed.reason).toBe('sanctioned_git_child');
      expect(before.stdout.trim()).toBe('main');
    });
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
      hasSanctionedGitParentChain(['ao review run opk-1 --execute --command echo'], true),
    ).toBe(true);
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
      ]),
    ).toBe(false);
    expect(
      hasSanctionedGitParentChain([
        'bash -c "echo reviewer-workspace-preflight.ps1; git checkout main"',
      ]),
    ).toBe(false);
    expect(
      hasSanctionedGitParentChain([
        'pwsh -File scripts/run-pack-review.ps1',
        'codex exec review --json',
        'pwsh -c "git branch -m blocked"',
      ]),
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
        env: {
          ...process.env,
          AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
          PATH: `${path.join(repoRoot, 'scripts')}:${process.env.PATH ?? ''}`,
        },
      });
      expect(denyShim.status).toBe(93);

      const denyRealBinary = spawnSync('bash', [gitRealBinaryPath, 'branch', '-m', 'blocked'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1' },
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

    if (existsSync('/usr/bin/git')) {
      withTempGitRepo((dir) => {
        const before = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
        const denyAbsolute = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; /usr/bin/git branch -m blocked-abs; echo done-marker`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: {
              ...process.env,
              AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
            },
          },
        );
        const after = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
        expect(denyAbsolute.stdout).toMatch(/done-marker/);
        expect(denyAbsolute.stderr || denyAbsolute.stdout).toMatch(/autonomous tree-mutating git denied/i);
        expect(after.stdout.trim()).toBe(before.stdout.trim());

        const allowChain = spawnSync(
          'bash',
          ['-c', `source ${bashEnvPath}; /usr/bin/git status; echo done-marker`],
          {
            cwd: dir,
            encoding: 'utf8',
            env: {
              ...process.env,
              AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
            },
          },
        );
        expect(allowChain.stdout).toMatch(/done-marker/);
      });
    }
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

  it('autonomous ao guard denies spawn when surface marker is set', () => {
    const result = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, 'spawn', 'opk-1'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1' },
      },
    );
    expect(result.status).toBe(93);
    expect(result.stderr).toMatch(/autonomous worker spawn denied/i);
  });

  it('scripts/ao shim denies spawn --claim-pr on autonomous surface', () => {
    const result = spawnSync(
      aoShimPath,
      ['spawn', '--claim-pr', '322'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1' },
      },
    );
    expect(result.status).toBe(93);
    expect(result.stderr).toMatch(/autonomous worker spawn denied/i);
  });

  it('without marker, spawn and mutating git pass through shims', () => {
    const spawnProbe = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, 'spawn', 'opk-1'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '' },
      },
    );
    expect(spawnProbe.status).not.toBe(93);

    withTempGitRepo((dir) => {
      const status = spawnSync('bash', [gitShimPath, 'status', '--short'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '' },
      });
      expect(status.status).toBe(0);
    });
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
});
