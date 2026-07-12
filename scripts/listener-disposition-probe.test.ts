import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const listenerPath = join(repoRoot, 'scripts', 'orchestrator-wake-listener.ps1');
const evidencePath = join(
  repoRoot,
  'scripts',
  'fixtures',
  'listener-disposition',
  'retire.json',
);

type ListenerDispositionEvidence = {
  issue: number;
  baseCommitSha: string;
  aoVersion: string;
  disposition: 'retire' | 'keep-fix';
  productionAudit: {
    inboundWebhookPosts: number;
    source: string;
  };
  finalBaseProbe: {
    command: string;
    observationWindowSeconds: number;
    readinessRequest: string;
    inboundWebhookPosts: number;
    bindingVerified: boolean;
    observedAtUtc: string;
  };
};

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to reserve a loopback port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBoundListener(
  port: number,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`listener exited before binding (exit=${child.exitCode})\n${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ao-wake`, {
        method: 'GET',
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 404) return;
    } catch {
      // Listener is still starting.
    }
    await sleep(200);
  }
  throw new Error(`listener did not bind within 20 seconds\n${output()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

describe('Issue #745 PR-B listener disposition probe', () => {
  it(
    'binds on the PR-A merge base for a fixed window with zero webhook POSTs',
    async () => {
      const evidence = JSON.parse(
        readFileSync(evidencePath, 'utf8'),
      ) as ListenerDispositionEvidence;
      expect(evidence.issue).toBe(745);
      expect(evidence.baseCommitSha).toBe(
        '9728896230f8f66de09c485dff613dfdee5cfd9f',
      );
      expect(evidence.aoVersion).toBe('0.10.2');
      expect(evidence.disposition).toBe('retire');
      expect(evidence.productionAudit.inboundWebhookPosts).toBe(0);
      expect(evidence.finalBaseProbe.inboundWebhookPosts).toBe(0);
      expect(evidence.finalBaseProbe.bindingVerified).toBe(true);
      expect(evidence.finalBaseProbe.readinessRequest).toMatch(/GET.*zero POST/i);
      expect(evidence.finalBaseProbe.observationWindowSeconds).toBeGreaterThanOrEqual(60);

      const root = mkdtempSync(join(tmpdir(), 'opk-listener-disposition-'));
      const runtimeFixture = join(root, 'runtime-fixture.json');
      writeFileSync(
        runtimeFixture,
        `${JSON.stringify({ openPrs: [], reviewRuns: [], sessions: [] }, null, 2)}\n`,
      );
      const port = await getFreePort();
      let stdout = '';
      let stderr = '';
      const child = spawn(
        'pwsh',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          listenerPath,
          '-Port',
          String(port),
          '-OrchestratorSessionId',
          'op-listener-disposition-probe',
          '-ProjectId',
          'orchestrator-pack',
          '-SideEffectStateDir',
          root,
          '-FixturePath',
          runtimeFixture,
          '-DryRun',
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, OPK_VITEST_HARNESS: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const output = () => `${stdout}\n${stderr}`.trim();

      try {
        await waitForBoundListener(port, child, output);
        await sleep(evidence.finalBaseProbe.observationWindowSeconds * 1_000);
        expect(child.exitCode, output()).toBeNull();
      } finally {
        await stopChild(child);
        rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
