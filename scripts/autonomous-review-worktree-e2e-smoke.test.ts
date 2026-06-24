import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import { autonomousBashEnv, withTempGitRepo } from './_test-git-fixture.js';

const gitShimPath = path.join(repoRoot, 'scripts/git');
const captureDir = path.join(repoRoot, 'tests/external-output-references/autonomous-review-worktree-e2e-smoke');

function withLiveClaimHolder(run: (holderPid: number) => void) {
  const holder = spawn('pwsh', ['-NoProfile', '-Command', 'while ($true) { Start-Sleep -Seconds 30 }'], {
    detached: true,
    stdio: 'ignore',
  });
  holder.unref();
  if (!holder.pid) {
    throw new Error('failed to start live claim holder process');
  }
  try {
    run(holder.pid);
  } finally {
    try {
      process.kill(holder.pid, 'SIGTERM');
    } catch {
      // holder already exited
    }
  }
}

describe('autonomous review worktree e2e smoke (#429)', () => {
  it('autonomous-review-worktree-e2e-smoke: claim-bound worktree add via git shim with isolated fixture root', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-e2e-429-'));
    const projectId = 'orchestrator-pack-e2e';
    mkdirSync(captureDir, { recursive: true });
    const captureFile = path.join(captureDir, 'isolated-smoke-redacted.json');

    withTempGitRepo((gitDir) => {
      const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: gitDir, encoding: 'utf8' }).stdout.trim();
      const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
      mkdirSync(workspaces, { recursive: true });
      const target = path.join(workspaces, 'opk-rev-429-e2e');

      withLiveClaimHolder((holderPid) => {
        try {
          runPwsh(`
            . ${psString(path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1'))}
            $env:AO_BASE_DIR = ${psString(aoBase)}
            $env:AO_PROJECT_ID = ${psString(projectId)}
            $ns = Get-ReviewStartClaimProjectNamespace -ProjectId ${psString(projectId)}
            Initialize-ReviewStartClaimNamespace -Namespace $ns
            . ${psString(path.join(repoRoot, 'scripts/lib/Review-RunLiveness.ps1'))}
            $record = New-ReviewStartClaimActiveRecord -PrNumber 429 -HeadSha ${psString(headSha)} -Surface 'orchestrator-turn' -Reason 'e2e-smoke'
            $record.holder.pid = ${holderPid}
            $holderStartTicks = Get-ReviewRecoveryProcessStartTicks -ProcessId ${holderPid}
            $holderBootHash = Get-ReviewRecoveryBootIdHash
            if ($holderStartTicks) { $record.holder.startTimeTicks = $holderStartTicks }
            if ($holderBootHash) { $record.holder.bootIdHash = $holderBootHash }
            Write-ReviewStartClaimAtomic -Path (Get-ReviewStartClaimPath -Namespace $ns -PrNumber 429 -HeadSha ${psString(headSha)}) -Record $record
          `);

          const denyBranch = spawnSync(
            'bash',
            [gitShimPath, 'branch', '-m', 'e2e-blocked'],
            {
              cwd: gitDir,
              encoding: 'utf8',
              env: autonomousBashEnv({
                AO_BASE_DIR: aoBase,
                AO_PROJECT_ID: projectId,
                PATH: `${path.join(repoRoot, 'scripts')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
              }),
            },
          );
          expect(denyBranch.status).toBe(93);

          const allowWorktree = spawnSync(
            'bash',
            [gitShimPath, 'worktree', 'add', '--detach', target, headSha],
            {
              cwd: gitDir,
              encoding: 'utf8',
              env: autonomousBashEnv({
                AO_BASE_DIR: aoBase,
                AO_PROJECT_ID: projectId,
                PATH: `${path.join(repoRoot, 'scripts')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
              }),
            },
          );

          const smoke = {
            projectId,
            targetBasename: path.basename(target),
            denyBranchExit: denyBranch.status,
            allowWorktreeExit: allowWorktree.status,
            worktreeExists: existsSync(target),
          };
          writeFileSync(captureFile, `${JSON.stringify(smoke, null, 2)}\n`);

          expect(allowWorktree.status).toBe(0);
          expect(existsSync(target)).toBe(true);
        } finally {
          if (existsSync(target)) {
            spawnSync('git', ['worktree', 'remove', '--force', target], { cwd: gitDir, encoding: 'utf8' });
          }
          rmSync(aoBase, { recursive: true, force: true });
        }
      });
    });
  });

  it.skip('autonomous-review-worktree-e2e-smoke: optional ao review run path when AO core is available', () => {
    const ao = spawnSync('ao', ['--version'], { encoding: 'utf8' });
    if (ao.status !== 0) {
      return;
    }
    expect(readFileSync(path.join(repoRoot, 'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1'), 'utf8')).toContain(
      'Acquire-ReviewStartClaim',
    );
  });
});
