#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  applyOpkVitestHarnessEnv,
  cleanupHarnessRoot,
  createHarnessRoot,
  repoRoot,
} from './lib/vitest-live-store-harness.mjs';
import { startParentLiveStoreGuard } from './lib/vitest-live-store-parent-guard.mjs';

const SIGNAL_GRACE_MS = 2_000;

function findExecutable(name, pathValue = process.env.PATH ?? '') {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function installPwshShim(root, env) {
  const realPwsh = env.OPK_REAL_PWSH || findExecutable('pwsh', env.PATH ?? '');
  if (!realPwsh) return;
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const shimModule = join(binDir, 'pwsh-shim.mjs');
  const preflightModule = pathToFileURL(
    join(repoRoot, 'scripts', 'lib', 'vitest-live-store-parent-guard.mjs'),
  ).href;
  writeFileSync(shimModule, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { preflightPowerShellInvocation } from ${JSON.stringify(preflightModule)};
const real = process.env.OPK_REAL_PWSH;
if (!real) { console.error('OPK pwsh shim is missing configuration'); process.exitCode = 70; }
else {
  const argv = process.argv.slice(2);
  try {
    preflightPowerShellInvocation(argv, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 64;
  }
  if (process.exitCode === undefined) {
    const child = spawn(real, argv, {
      env: process.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
    const handlers = new Map();
    let forwardedSignal = null;
    let forceTimer = null;
    const childRunning = () => child.exitCode === null && child.signalCode === null;
    const signalTree = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // The child process group may already have exited.
      }
    };
    const cleanupSignals = () => {
      if (forceTimer) clearTimeout(forceTimer);
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
      const handler = () => {
        if (!childRunning()) return;
        if (forwardedSignal) {
          signalTree('SIGKILL');
          return;
        }
        forwardedSignal = signal;
        signalTree(signal);
        forceTimer = setTimeout(() => {
          if (childRunning()) signalTree('SIGKILL');
        }, 2_000);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    const status = await new Promise((resolveChild) => {
      child.once('error', (error) => {
        cleanupSignals();
        console.error(error.message);
        resolveChild(70);
      });
      child.once('close', (code, signal) => {
        cleanupSignals();
        resolveChild(code ?? signalCodes[forwardedSignal ?? signal] ?? 1);
      });
    });
    process.exitCode = status;
  }
}
`, 'utf8');
  chmodSync(shimModule, 0o700);

  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'pwsh.cmd'), `@echo off\r\n"${process.execPath}" "${shimModule}" %*\r\n`, 'utf8');
  } else {
    const shim = join(binDir, 'pwsh');
    writeFileSync(shim, `#!/usr/bin/env sh\nexec "${process.execPath}" "${shimModule}" "$@"\n`, 'utf8');
    chmodSync(shim, 0o700);
  }
  env.OPK_REAL_PWSH = realPwsh;
  env.PATH = `${binDir}${delimiter}${env.PATH ?? ''}`;
}

function appendNodeImport(nodeOptions, modulePath) {
  const flag = `--import=${pathToFileURL(modulePath).href}`;
  return [String(nodeOptions ?? '').trim(), flag].filter(Boolean).join(' ');
}

function signalExitCode(signal) {
  return { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal] ?? 1;
}

function runVitestChild(entrypoint, args, env) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    });
    const handlers = new Map();
    let terminatingSignal = null;
    let forceTimer = null;
    const childRunning = () => child.exitCode === null && child.signalCode === null;

    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
      const handler = () => {
        if (!childRunning()) return;
        if (terminatingSignal) {
          child.kill('SIGKILL');
          return;
        }
        terminatingSignal = signal;
        child.kill(signal);
        forceTimer = setTimeout(() => {
          if (childRunning()) child.kill('SIGKILL');
        }, SIGNAL_GRACE_MS);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    const cleanupSignals = () => {
      if (forceTimer) clearTimeout(forceTimer);
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
    child.once('error', (error) => {
      cleanupSignals();
      rejectChild(error);
    });
    child.once('close', (code, signal) => {
      cleanupSignals();
      resolveChild(code ?? signalExitCode(terminatingSignal ?? signal));
    });
  });
}

const invocationRoot = createHarnessRoot();
const guard = startParentLiveStoreGuard({ ...process.env });
const childEnv = { ...process.env };
let childStatus = 1;
let childFailure = null;
let guardFailure = null;
try {
  applyOpkVitestHarnessEnv(invocationRoot, childEnv);
  childEnv.OPK_TESTMODE_LEASE_ROOT = join(invocationRoot, 'state', 'testmode-fleet-leases');
  installPwshShim(invocationRoot, childEnv);
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
    cleanupHarnessRoot(invocationRoot);
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
