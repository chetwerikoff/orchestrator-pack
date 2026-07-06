import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './_test-pwsh-helpers.js';

function runTrustScript(home: string, args: string[]) {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(repoRoot, 'scripts/trust-ao-worktree.ps1'),
      ...args,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: '/snap/bin:/usr/bin:/bin',
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`trust script failed ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

function readTrustedPayloads(home: string) {
  const projectsDir = path.join(home, '.cursor/projects');
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsDir, entry.name, '.workspace-trusted'))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')));
}

describe('trust-ao-worktree.ps1', () => {
  it('trusts AO 0.10+ worktrees under ~/.ao/data/worktrees by session id', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'opk-trust-home-'));
    try {
      const workspace = path.join(home, '.ao/data/worktrees/orchestrator-pack/orchestrator-pack-6');
      mkdirSync(workspace, { recursive: true });

      runTrustScript(home, ['-SessionId', 'orchestrator-pack-6', '-Quiet']);

      const [payload] = readTrustedPayloads(home);
      expect(payload.workspacePath).toBe(workspace);
      expect(payload.trustMethod).toBe('orchestrator-pack-script');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('trusts both new and legacy worktree roots when asked to trust the root', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'opk-trust-home-'));
    try {
      const newRoot = path.join(home, '.ao/data/worktrees/orchestrator-pack');
      const legacyRoot = path.join(home, '.agent-orchestrator/projects/orchestrator-pack/worktrees');
      mkdirSync(newRoot, { recursive: true });
      mkdirSync(legacyRoot, { recursive: true });

      runTrustScript(home, ['-TrustWorktreesRoot', '-Quiet']);

      const trustedPaths = readTrustedPayloads(home)
        .map((payload) => payload.workspacePath)
        .sort();
      expect(trustedPaths).toEqual([legacyRoot, newRoot].sort());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
