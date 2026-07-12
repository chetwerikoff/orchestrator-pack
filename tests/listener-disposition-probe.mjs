#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testsDir, '..');
const listenerPath = join(repoRoot, 'scripts', 'orchestrator-wake-listener.ps1');
const evidencePath = join(testsDir, 'fixtures', 'listener-disposition', 'retire.json');

function fail(message) {
  process.stderr.write(`[FAIL] listener disposition probe: ${message}\n`);
  process.exit(1);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to reserve loopback port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBoundListener(port, child, output) {
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
      // Still starting.
    }
    await sleep(200);
  }
  throw new Error(`listener did not bind within 20 seconds\n${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
if (evidence.issue !== 745) fail('fixture issue must be 745');
if (evidence.baseCommitSha !== '9728896230f8f66de09c485dff613dfdee5cfd9f') {
  fail('fixture must bind to the PR-A merge commit');
}
if (evidence.aoVersion !== '0.10.2') fail('fixture AO baseline must be 0.10.2');
if (evidence.disposition !== 'retire') fail('fixture disposition must be retire');
if (Number(evidence.productionAudit?.inboundWebhookPosts) !== 0) {
  fail('production audit must record zero inbound webhook POSTs');
}
const windowSeconds = Number(evidence.finalBaseProbe?.observationWindowSeconds ?? 0);
if (!Number.isFinite(windowSeconds) || windowSeconds < 60) {
  fail('observation window must be at least 60 seconds');
}
if (Number(evidence.finalBaseProbe?.inboundWebhookPosts) !== 0) {
  fail('final-base probe must record zero webhook POSTs');
}

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
child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
const output = () => `${stdout}\n${stderr}`.trim();

try {
  await waitForBoundListener(port, child, output);
  await sleep(windowSeconds * 1_000);
  if (child.exitCode !== null) {
    throw new Error(`listener exited during observation (exit=${child.exitCode})\n${output()}`);
  }
  process.stdout.write(
    `[PASS] listener disposition probe: bound on 127.0.0.1:${port}; ` +
    `${windowSeconds}s observation; zero POST requests\n`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await stopChild(child);
  rmSync(root, { recursive: true, force: true });
}
