import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '#opk-kernel/subprocess';

const cleanupPids = new Set<number>();

function nodeArgs(source: string, ...args: string[]): string[] {
  return ['-e', source, ...args];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForDead(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} is still alive`);
}

function firstPid(stdout: string): number {
  const match = /\b(\d+)\b/.exec(stdout);
  if (!match?.[1]) throw new Error(`no pid in output: ${JSON.stringify(stdout)}`);
  return Number(match[1]);
}

afterEach(async () => {
  for (const pid of cleanupPids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  cleanupPids.clear();
});

describe('sanctioned subprocess kernel', () => {
  it('reports a real exit-code completion distinctly', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs("process.stdout.write('ok')"),
    });
    expect(result).toMatchObject({ outcome: 'exit', exitCode: 0, ok: true, stdout: 'ok' });
  });

  it('reports signal termination distinctly', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs('setInterval(() => {}, 1000)'),
      onSpawn(pid) {
        setTimeout(() => process.kill(pid, 'SIGTERM'), 20);
      },
    });
    expect(result.outcome).toBe('signal');
    expect(result.signal).toBe('SIGTERM');
  });

  it('reports spawn failure and invalid cwd distinctly', async () => {
    const missing = await runProcess({ command: 'opk-command-that-does-not-exist-800' });
    expect(missing.outcome).toBe('spawn-failure');

    const invalidCwd = await runProcess({
      command: process.execPath,
      args: nodeArgs("console.log('never')"),
      cwd: join(tmpdir(), `opk-missing-${crypto.randomUUID()}`),
    });
    expect(invalidCwd.outcome).toBe('spawn-failure');
  });

  it('returns cancellation without spawning for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs("console.log('never')"),
      signal: controller.signal,
      onSpawn() {
        spawned = true;
      },
    });
    expect(result.outcome).toBe('cancelled');
    expect(spawned).toBe(false);
  });

  it('kills a spawned grandchild on timeout', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs(`
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        console.log(child.pid);
        setInterval(() => {}, 1000);
      `),
      timeoutMs: 500,
      killGraceMs: 100,
    });
    expect(result.outcome).toBe('timeout');
    const grandchild = firstPid(result.stdout);
    await waitForDead(grandchild);
  });

  it('escalates to SIGKILL for a descendant that ignores SIGTERM', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs(`
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
        console.log(child.pid);
        setInterval(() => {}, 1000);
      `),
      timeoutMs: 500,
      killGraceMs: 100,
    });
    expect(result.outcome).toBe('timeout');
    await waitForDead(firstPid(result.stdout));
  });

  it('leaves an unrelated sibling process alive during tree termination', async () => {
    const sibling = spawn(process.execPath, nodeArgs('setInterval(() => {}, 1000)'), {
      detached: true,
      stdio: 'ignore',
    });
    expect(sibling.pid).toBeDefined();
    cleanupPids.add(sibling.pid!);

    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs('setInterval(() => {}, 1000)'),
      timeoutMs: 50,
      killGraceMs: 30,
    });
    expect(result.outcome).toBe('timeout');
    expect(isAlive(sibling.pid!)).toBe(true);
  });

  it.each([
    ['cancellation-first', 500, 300, 20, 'cancelled'],
    ['timeout-first', 500, 20, 200, 'timeout'],
    ['exit-first', 20, 300, 200, 'exit'],
  ] as const)('settles exactly once for %s ordering', async (_name, exitMs, timeoutMs, abortMs, outcome) => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), abortMs);
    let settlements = 0;
    let childPid = 0;
    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs(`setTimeout(() => { console.log('done'); }, ${exitMs})`),
      timeoutMs,
      killGraceMs: 30,
      signal: controller.signal,
      onSpawn(pid) {
        childPid = pid;
      },
    }).then((value) => {
      settlements += 1;
      return value;
    });
    clearTimeout(abortTimer);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(result.outcome).toBe(outcome);
    expect(settlements).toBe(1);
    await waitForDead(childPid);
  });

  it('cancels a running process through AbortSignal with tree cleanup', async () => {
    const controller = new AbortController();
    const resultPromise = runProcess({
      command: process.execPath,
      args: nodeArgs(`
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        console.log(child.pid);
        setInterval(() => {}, 1000);
      `),
      signal: controller.signal,
      killGraceMs: 30,
      onStdoutChunk() {
        controller.abort();
      },
    });
    const result = await resultPromise;
    expect(result.outcome).toBe('cancelled');
    await waitForDead(firstPid(result.stdout));
  });

  it('cleans up if the spawn observer throws', async () => {
    let childPid = 0;
    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs('setInterval(() => {}, 1000)'),
      killGraceMs: 30,
      onSpawn(pid) {
        childPid = pid;
        throw new Error('spawn observer failed');
      },
    });
    expect(result.outcome).toBe('consumer-error');
    expect(result.error).toContain('spawn observer failed');
    await waitForDead(childPid);
  });

  it('cleans up after a throwing incremental consumer', async () => {
    let childPid = 0;
    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs("setInterval(() => process.stdout.write('tick\\n'), 10)"),
      killGraceMs: 30,
      onSpawn(pid) {
        childPid = pid;
      },
      onStdoutChunk() {
        throw new Error('consumer failed');
      },
    });
    expect(result.outcome).toBe('consumer-error');
    expect(result.error).toContain('consumer failed');
    await waitForDead(childPid);
  });

  it('streams incrementally and does not deadlock on large output', async () => {
    let streamed = 0;
    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs("process.stdout.write('x'.repeat(2_000_000))"),
      onStdoutChunk(chunk) {
        streamed += chunk.length;
      },
    });
    expect(result.outcome).toBe('exit');
    expect(result.stdout.length).toBe(2_000_000);
    expect(streamed).toBe(2_000_000);
  });

  it('transports spaces and quotes literally without a shell', async () => {
    const values = ['space value', 'double"quote', "single'quote", '$HOME; echo injected'];
    const result = await runProcess({
      command: process.execPath,
      args: nodeArgs('process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values),
    });
    expect(JSON.parse(result.stdout)).toEqual(values);
  });

  it('does not treat empty stdout as success unless explicitly allowed', async () => {
    const denied = await runProcess({ command: process.execPath, args: nodeArgs('process.exit(0)') });
    expect(denied).toMatchObject({ outcome: 'exit', exitCode: 0, ok: false, stdout: '' });

    const allowed = await runProcess({
      command: process.execPath,
      args: nodeArgs('process.exit(0)'),
      allowEmptyStdout: true,
    });
    expect(allowed.ok).toBe(true);
  });

  it('does not inherit or serialize the parent environment by default', async () => {
    const key = 'OPK_ISSUE_800_SENSITIVE';
    const secret = 'sensitive-parent-value-800';
    process.env[key] = secret;
    try {
      const result = await runProcess({
        command: process.execPath,
        args: nodeArgs(`process.stdout.write(String(process.env.${key} ?? ''))`),
        allowEmptyStdout: true,
      });
      expect(result.stdout).toBe('');
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(key);
    } finally {
      delete process.env[key];
    }
  });

  it('honors an explicit working directory and explicit environment', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opk-subprocess-'));
    try {
      const result = await runProcess({
        command: process.execPath,
        args: nodeArgs("process.stdout.write(`${process.cwd()}|${process.env.OPK_VALUE}`)"),
        cwd: directory,
        env: { OPK_VALUE: 'explicit' },
      });
      expect(result.stdout).toBe(`${directory}|explicit`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
