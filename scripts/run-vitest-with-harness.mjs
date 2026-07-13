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
  startLiveStoreGuard,
} from './lib/vitest-live-store-harness.mjs';

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
  const helper = join(repoRoot, 'scripts', 'lib', 'OpkVitestStoreIsolation.ps1');
  writeFileSync(shimModule, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const real = process.env.OPK_REAL_PWSH;
const helper = process.env.OPK_VITEST_PWSH_HELPER;
if (!real || !helper) { console.error('OPK pwsh shim is missing configuration'); process.exit(70); }
const argv = process.argv.slice(2);
const lower = argv.map((value) => String(value).toLowerCase());
const encodedIndex = lower.findIndex((value) => value === '-encodedcommand' || value === '-enc' || value === '-e');
if (encodedIndex >= 0) { console.error('OPK_VITEST_LIVE_STORE_BLOCKED encoded PowerShell commands are unsupported by the harness'); process.exit(64); }
const commandIndex = lower.findIndex((value) => value === '-command' || value === '-c');
const fileIndex = lower.findIndex((value) => value === '-file' || value === '-f');
const bypassFile = process.env.OPK_VITEST_PWSH_BYPASS_FILE;
if (fileIndex >= 0 && bypassFile && argv[fileIndex + 1] && resolve(argv[fileIndex + 1]) === resolve(bypassFile)) {
  const direct = spawnSync(real, argv, { env: process.env, stdio: 'inherit' });
  if (direct.error) { console.error(direct.error.message); process.exit(70); }
  process.exit(direct.status ?? 1);
}
let childArgs = [...argv];
const quote = (value) => \`'\${String(value).replaceAll("'", "''")}'\`;
const prelude = \`. \${quote(helper)}; Enable-OpkVitestStoreIsolation;\`;
if (commandIndex >= 0) {
  const command = argv.slice(commandIndex + 1).join(' ');
  childArgs = [...argv.slice(0, commandIndex), '-Command', \`\${prelude} \${command}\`];
} else if (fileIndex >= 0) {
  const file = argv[fileIndex + 1];
  if (!file || file === '-') { console.error('OPK pwsh shim cannot safely guard -File -'); process.exit(64); }
  const payload = Buffer.from(JSON.stringify({ file, args: argv.slice(fileIndex + 2) }), 'utf8').toString('base64');
  const envName = \`OPK_PWSH_SHIM_ARGS_\${process.pid}\`;
  process.env[envName] = payload;
  const script = \`\${prelude} $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:\${envName}))|ConvertFrom-Json; $a=@($p.args|ForEach-Object {[string]$_}); & ([string]$p.file) @a; exit $LASTEXITCODE\`;
  childArgs = [...argv.slice(0, fileIndex), '-Command', script];
}
const child = spawnSync(real, childArgs, { env: process.env, stdio: 'inherit' });
if (child.error) { console.error(child.error.message); process.exit(70); }
process.exit(child.status ?? 1);
`, 'utf8');
  chmodSync(shimModule, 0o700);

  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, 'pwsh.cmd'),
      `@echo off\r\n"${process.execPath}" "${shimModule}" %*\r\n`,
      'utf8',
    );
  } else {
    const shim = join(binDir, 'pwsh');
    writeFileSync(
      shim,
      `#!/usr/bin/env sh\nexec "${process.execPath}" "${shimModule}" "$@"\n`,
      'utf8',
    );
    chmodSync(shim, 0o700);
  }
  env.OPK_REAL_PWSH = realPwsh;
  env.OPK_VITEST_PWSH_HELPER = helper;
  env.OPK_VITEST_PWSH_BYPASS_FILE = join(repoRoot, 'scripts', 'invoke-testmode-fleet-reaper.ps1');
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
const guard = startLiveStoreGuard({ ...process.env });
const childEnv = { ...process.env };
let childStatus = 1;
let childFailure = null;
let guardFailure = null;
try {
  applyOpkVitestHarnessEnv(invocationRoot, childEnv);
  installPwshShim(invocationRoot, childEnv);
  childEnv.NODE_OPTIONS = appendNodeImport(
    childEnv.NODE_OPTIONS,
    join(repoRoot, 'scripts', 'vitest-live-store-preload.mjs'),
  );

  const vitestEntrypoint = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitestEntrypoint)) {
    throw new Error(`vitest entrypoint missing: ${vitestEntrypoint}`);
  }
  const args = process.argv.slice(2);
  childStatus = await runVitestChild(vitestEntrypoint, args, childEnv);
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

if (childStatus !== 0 && !childFailure) {
  console.error(`OPK vitest child exited status=${childStatus}`);
}
if ((childFailure || childStatus !== 0) && guardFailure) {
  console.error('OPK vitest reported both child and live-store guard failures');
}
process.exit(childStatus !== 0 ? childStatus : guardFailure ? 1 : 0);
