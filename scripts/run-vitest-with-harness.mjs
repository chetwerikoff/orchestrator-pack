#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from './kernel/subprocess.mjs';
import {
  applyOpkVitestHarnessEnv,
  cleanupHarnessRoot,
  createHarnessRoot,
  repoRoot,
} from './lib/vitest-live-store-harness.mjs';
import { startParentLiveStoreGuard } from './lib/vitest-live-store-parent-guard.mjs';

function appendNodeImport(nodeOptions, modulePath) {
  const flag = `--import=${pathToFileURL(modulePath).href}`;
  return [String(nodeOptions ?? '').trim(), flag].filter(Boolean).join(' ');
}

function signalExitCode(signal) {
  return { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal] ?? 1;
}

function runVitestChild(entrypoint, args, env) {
  return runProcess({
    command: process.execPath,
    args: [entrypoint, ...args],
    cwd: repoRoot,
    env,
    inheritParentEnv: false,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  }).then((result) => result.exitCode ?? signalExitCode(result.signal));
}

const reentryRoot = String(process.env.OPK_VITEST_REENTRY_HARNESS_ROOT ?? '').trim();
const invocationRoot = reentryRoot ? resolve(reentryRoot) : createHarnessRoot();
const ownsInvocationRoot = !reentryRoot;
const isPreTopologyMeasurement = process.env.OPK_VITEST_PRE_TOPOLOGY_MEASUREMENT === '1';
const guard = isPreTopologyMeasurement
  ? { stop() {} }
  : startParentLiveStoreGuard({ ...process.env });
const childEnv = { ...process.env };
let childStatus = 1;
let childFailure = null;
let guardFailure = null;

try {
  applyOpkVitestHarnessEnv(invocationRoot, childEnv);
  childEnv.OPK_TESTMODE_LEASE_ROOT = join(invocationRoot, 'state', 'testmode-fleet-leases');
  childEnv.NODE_OPTIONS = appendNodeImport(
    childEnv.NODE_OPTIONS,
    join(repoRoot, 'scripts', 'vitest-live-store-preload.mjs'),
  );

  const vitestEntrypoint = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitestEntrypoint)) throw new Error(`vitest entrypoint missing: ${vitestEntrypoint}`);
  childStatus = await runVitestChild(vitestEntrypoint, process.argv.slice(2), childEnv);
} catch (error) {
  childFailure = error;
  console.error(`OPK vitest child failed: ${error instanceof Error ? error.message : String(error)}`);
  childStatus = 1;
} finally {
  await new Promise((resolveFlush) => setTimeout(resolveFlush, 50));
  try {
    guard.stop();
  } catch (error) {
    guardFailure = error;
    console.error(error instanceof Error ? error.message : String(error));
  }
  try {
    if (ownsInvocationRoot) cleanupHarnessRoot(invocationRoot);
  } catch (error) {
    console.error(`OPK harness cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    guardFailure ??= error;
  }
}

if (childStatus !== 0 && !childFailure) console.error(`OPK vitest child exited status=${childStatus}`);
if ((childFailure || childStatus !== 0) && guardFailure) {
  console.error('OPK vitest reported both child and live-store guard failures');
}
process.exit(childStatus !== 0 ? childStatus : guardFailure ? 1 : 0);
