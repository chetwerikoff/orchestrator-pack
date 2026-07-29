import { readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquirePackReviewStageClaim } from './lib/pack-review-stage-claim.ts';

const mockRunProcess = vi.fn(async () => ({
  outcome: 'exit' as const,
  ok: true,
  exitCode: 0,
  signal: null,
  stdout: '4321\n',
  stderr: '',
  timedOut: false,
  cancelled: false,
}));

vi.mock('./kernel/subprocess.ts', () => ({
  runProcess: mockRunProcess,
}));

const { defaultSpawnDetachedReview } = await import('./lib/pack-review-launcher.ts');

const tempRoots: string[] = [];

function tempNamespace(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-pack-review-detached-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  mockRunProcess.mockClear();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack-review detached launch (SIGTERM regression)', () => {
  it('launches through bash/nohup and writes a survival witness', async () => {
    const namespace = tempNamespace();
    const claim = acquirePackReviewStageClaim({
      prNumber: 1111,
      headSha: 'a'.repeat(40),
      surface: 'test',
      namespace,
      startReason: 'fixture',
    });
    expect(claim.acquired).toBe(true);

    const workDir = join(namespace, 'work', 'sigterm');
    const result = await defaultSpawnDetachedReview({
      repoRoot: process.cwd(),
      repoSlug: 'chetwerikoff/orchestrator-pack',
      prNumber: 1111,
      headSha: 'a'.repeat(40),
      claim,
      workDir,
      surface: 'pack-review-launcher-test',
    });

    expect(result.childPid).toBe(4321);
    expect(mockRunProcess).toHaveBeenCalledTimes(1);
    const call = mockRunProcess.mock.calls[0]?.[0] as { command?: string; args?: string[]; env?: Record<string, string> };
    expect(call.command).toBe('bash');
    expect(call.args?.[0]).toBe('-lc');
    expect(String(call.args?.[1])).toContain('nohup');
    expect(call.env?.OPK_PACK_REVIEW_LAUNCHER_WORKER).toBe('1');

    const marker = JSON.parse(readFileSync(join(workDir, 'launcher-started.json'), 'utf8')) as { childPid?: number };
    expect(marker.childPid).toBe(4321);
  });
});
