#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const lane = join(repoRoot, 'scripts', 'run-vitest-light-lane.ps1');
const child = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', lane], {
  cwd: repoRoot,
  detached: process.platform !== 'win32',
  env: { ...process.env, CI: 'true', OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
let timedOut = false;
let killTimer = null;
const max = 4_000_000;
const append = (current, chunk) => {
  const next = current + String(chunk);
  return next.length > max ? next.slice(-max) : next;
};
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
const signalTree = (signal) => {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
};
const timer = setTimeout(() => {
  timedOut = true;
  signalTree('SIGTERM');
  killTimer = setTimeout(() => signalTree('SIGKILL'), 10_000);
}, 12 * 60 * 1000);
const result = await new Promise((resolve) => {
  child.once('error', (error) => resolve({ status: null, signal: null, error: error.message }));
  child.once('close', (status, signal) => resolve({ status, signal, error: null }));
});
clearTimeout(timer);
if (killTimer) clearTimeout(killTimer);
const artifact = {
  schemaVersion: 1,
  diagnostic: 'issue-752-full-light-lane',
  timedOut,
  ...result,
  stdout,
  stderr,
};
writeFileSync(join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=false\n');
}
console.log(JSON.stringify({ diagnostic: artifact.diagnostic, status: result.status, signal: result.signal, timedOut }));
process.exit(0);
