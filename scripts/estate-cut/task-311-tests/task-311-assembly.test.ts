import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path, { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';

import { startPackReview } from '../../pack-review-runner.js';
import {
  fixture,
  installEgressTrap,
  readCapture,
  repoRoot,
  runGit,
  tempRoot,
} from './task-311-common.test-support.js';

declare global {
  interface Array<T> {
    findLast(
      predicate: (value: T, index: number, array: T[]) => unknown,
      thisArg?: unknown,
    ): T | undefined;
  }
}

function executable(file: string, content: string): void {
  writeFileSync(file, content, 'utf8');
  if (process.platform !== 'win32') chmodSync(file, 0o700);
}

describe('TASK-311 real surviving review-cycle assembly gate', () => {
  it('diagnostic: drives the real reviewer wrapper chain with a minimal final executable', async () => {
    const trapRoot = tempRoot('task-311-egress-');
    const storeRoot = tempRoot('task-311-runner-');
    const claimRoot = tempRoot('task-311-claim-');
    const boundaryRoot = tempRoot('task-311-reviewer-boundary-');
    const trap = installEgressTrap(trapRoot);
    const originalEnv = { ...process.env };
    try {
      const bin = path.join(boundaryRoot, 'bin');
      mkdirSync(bin, { recursive: true });
      const fakeReviewer = path.join(boundaryRoot, 'fake-reviewer.cjs');
      writeFileSync(fakeReviewer, "process.stdout.write(JSON.stringify({verdict:'clean',findingCount:0,findings:[]})+'\\n');\n", 'utf8');
      if (process.platform === 'win32') {
        executable(path.join(bin, 'node.cmd'), `@echo off\r\necho %* | findstr /C:"plugins\\ao-codex-pr-reviewer\\bin\\review.ts" >nul\r\nif %errorlevel%==0 ("${process.execPath}" "${fakeReviewer}" %*) else ("${process.execPath}" %*)\r\n`);
        executable(path.join(bin, 'npm.cmd'), '@echo off\r\nexit /b 0\r\n');
      } else {
        executable(path.join(bin, 'node'), `#!/usr/bin/env sh\ncase "$*" in *plugins/ao-codex-pr-reviewer/bin/review.ts*) exec "${process.execPath}" "${fakeReviewer}" "$@" ;; *) exec "${process.execPath}" "$@" ;; esac\n`);
        executable(path.join(bin, 'npm'), '#!/usr/bin/env sh\nexit 0\n');
      }

      const { row: session } = readCapture();
      const headSha = runGit(['rev-parse', 'HEAD']).trim().toLowerCase();
      const sessionId = String(session.id);
      const statusRows: Array<Record<string, unknown>> = [];
      const workerRows: Array<Record<string, unknown>> = [];
      process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
      process.env.PACK_REVIEWER = fixture.assembly.reviewer;
      process.env.OPK_VITEST_HARNESS = '1';
      process.env.AO_REVIEW_CLAIM_DIR = claimRoot;
      process.env.AO_REVIEW_START_MONOTONIC_NOW_MS = '1000';
      const result = await startPackReview({
        projectId: 'orchestrator-pack',
        sessionId,
        prNumber: fixture.assembly.prNumber,
        headSha,
        repoRoot,
        sourceRepoRoot: repoRoot,
        baseRef: 'origin/main',
        startReason: 'task_311_wrapper_diagnostic',
        surface: 'task-311-wrapper-diagnostic',
        storeRoot,
        fixtureRepoSlug: fixture.repoSlug,
        fixtureGithubReviewId: 31101,
        fixtureRequiredStatusWriter: async (request) => { statusRows.push({ ...request }); },
        fixtureWorkerNotifier: async (request) => {
          workerRows.push({ ...request, sessionId });
          return { state: 'delivered', reason: 'diagnostic_delivered' };
        },
      });
      expect(result).toMatchObject({ ok: true, created: true, status: 'up_to_date' });
      expect(statusRows.some((row) => row.state === 'success')).toBe(true);
      expect(workerRows).toHaveLength(1);
      expect(trap.attempts()).toEqual([]);
    } finally {
      trap.restore();
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
      rmSync(trapRoot, { recursive: true, force: true });
      rmSync(storeRoot, { recursive: true, force: true });
      rmSync(claimRoot, { recursive: true, force: true });
      rmSync(boundaryRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
