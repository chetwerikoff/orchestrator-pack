import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess, type ProcessResult } from '../kernel/subprocess.ts';

import {
  exportDetachedRollbackDrain,
  readProcessIdentity,
  sameProcess,
  validateRollbackDrainArtifact,
  type RollbackDrainArtifact,
} from './rollback-drain.ts';

const children: Array<{ pid: number; controller: AbortController; result: Promise<ProcessResult> }> = [];
const roots: string[] = [];

afterEach(async () => {
  const active = children.splice(0);
  for (const child of active) child.controller.abort();
  await Promise.allSettled(active.map((child) => child.result));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #948 detached rollback drain', () => {
  it('exports self-contained bytes and drains only the fenced process identity', async () => {
    const controller = new AbortController();
    let pid = 0;
    const childResult = runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      inheritParentEnv: true,
      signal: controller.signal,
      timeoutMs: 60_000,
      allowEmptyStdout: true,
      onSpawn: (value) => { pid = value; },
    });
    expect(pid).toBeGreaterThan(1);
    children.push({ pid, controller, result: childResult });
    const identity = readProcessIdentity(pid);
    expect(identity).not.toBeNull();

    const output = mkdtempSync(path.join(tmpdir(), 'opk-pr2a-drain-'));
    roots.push(output);
    const exported = exportDetachedRollbackDrain(output, 'candidate-generation-1', [pid]);
    const artifact = JSON.parse(readFileSync(exported.artifactPath, 'utf8')) as RollbackDrainArtifact;
    expect(() => validateRollbackDrainArtifact(artifact)).not.toThrow();

    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', exported.runnerPath, 'drain', '--artifact', exported.artifactPath],
      inheritParentEnv: true,
      timeoutMs: 30_000,
      allowEmptyStdout: false,
    });
    expect(result.ok, result.stderr || result.error).toBe(true);
    expect(JSON.parse(result.stdout) as { drained: number[] }).toMatchObject({ drained: expect.arrayContaining([pid]) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sameProcess(identity!)).toBe(false);
  });

  it('refuses a tampered artifact', () => {
    const artifact: RollbackDrainArtifact = {
      schemaVersion: 1,
      issue: 948,
      candidateGeneration: 'candidate-generation-2',
      entryBlocked: true,
      createdAtUtc: new Date().toISOString(),
      processes: [{ pid: 999_999, startTimeTicks: '1', bootId: 'boot' }],
      digest: 'sha256:bad',
    };
    expect(() => validateRollbackDrainArtifact(artifact)).toThrow('rollback_artifact_digest_invalid');
  });
});
