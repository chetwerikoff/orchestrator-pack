#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  applyOpkVitestHarnessEnv,
  canonicalizeStorePath,
  classifyLiveStorePath,
  cleanupHarnessRoot,
  createHarnessRoot,
  expandInventoryTemplate,
  liveStoreInventory,
  repoRoot,
  resolvedClassFences,
  resolvedLiveStores,
} from './lib/vitest-live-store-harness.mjs';

const SIGNAL_GRACE_MS = 2_000;
const MAX_WATCHED_DIRECTORIES = 512;

function pathIsSameOrWithin(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function hashFile(path) {
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  const stat = lstatSync(path);
  return { type: 'file', hash, size: stat.size, mtimeMs: stat.mtimeMs };
}

function hashDirectory(path) {
  const hash = createHash('sha256');
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const full = join(dir, entry.name);
      const rel = join(prefix, entry.name).replaceAll('\\', '/');
      hash.update(entry.isDirectory() ? `d:${rel}\n` : `f:${rel}\n`);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) hash.update(readFileSync(full));
      else hash.update(`other:${rel}\n`);
    }
  };
  walk(path);
  return { type: 'directory', hash: hash.digest('hex'), mtimeMs: lstatSync(path).mtimeMs };
}

function snapshotPath(path) {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path);
  if (stat.isDirectory()) return { exists: true, ...hashDirectory(path) };
  if (stat.isFile()) return { exists: true, ...hashFile(path) };
  return { exists: true, type: 'other', size: stat.size, mtimeMs: stat.mtimeMs };
}

function listPatternPaths(rootPath, matchers) {
  if (!existsSync(rootPath)) return [];
  try {
    return readdirSync(rootPath)
      .filter((name) => matchers.some((matcher) => matcher.test(name.replaceAll('\\', '/'))))
      .map((name) => join(rootPath, name))
      .sort();
  } catch {
    return [];
  }
}

function storeSnapshot(store) {
  let paths;
  if (store.kind === 'pattern') {
    paths = listPatternPaths(
      store.defaultPath,
      [store.basenameMatcher, ...store.sidecarMatchers].filter(Boolean),
    );
  } else {
    paths = [store.defaultPath];
    if (existsSync(store.parentPath)) {
      try {
        for (const name of readdirSync(store.parentPath)) {
          if (store.sidecarMatchers.some((matcher) => matcher.test(name.replaceAll('\\', '/')))) {
            paths.push(join(store.parentPath, name));
          }
        }
      } catch {
        // Primary path remains snapshotted.
      }
    }
  }
  return Object.fromEntries([...new Set(paths)].sort().map((path) => [
    createHash('sha256').update(path).digest('hex'),
    snapshotPath(path),
  ]));
}

function classFenceSnapshot(fence) {
  return Object.fromEntries(listPatternPaths(fence.rootPath, fence.matchers).map((path) => [
    createHash('sha256').update(path).digest('hex'),
    snapshotPath(path),
  ]));
}

function startParentLiveStoreGuard(env) {
  const stores = resolvedLiveStores(env);
  const fences = resolvedClassFences(env);
  const roots = (liveStoreInventory.liveRoots ?? [])
    .filter((root) => root.watchTransient !== false)
    .map((root) => ({
      ...root,
      path: canonicalizeStorePath(expandInventoryTemplate(root.defaultTemplate, env)),
    }));
  const before = new Map(stores.map((store) => [store.id, storeSnapshot(store)]));
  const fenceBefore = new Map(fences.map((fence) => [fence.id, classFenceSnapshot(fence)]));
  const touched = new Set();
  const watchers = [];
  const watchedDirs = new Set();
  let watchTree;

  const watchDir = (requestedDir) => {
    let dir = requestedDir;
    while (dir && !existsSync(dir)) {
      const parent = dirname(dir);
      if (parent === dir) return;
      dir = parent;
    }
    if (!dir || watchedDirs.has(dir) || watchedDirs.size >= MAX_WATCHED_DIRECTORIES) return;
    watchedDirs.add(dir);
    try {
      const watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;
        const candidate = canonicalizeStorePath(join(dir, String(filename)));
        const match = classifyLiveStorePath(candidate, env);
        if (match) touched.add(match.storeId);

        // When a scoped parent did not exist at bootstrap, fs.watch reports the
        // newly-created ancestor. That ancestor is not itself a store mutation:
        // unrelated sibling state may share it. Expand the watch chain instead
        // of attributing the event to every descendant.
        for (const target of [
          ...stores.map((store) => store.defaultPath),
          ...fences.map((fence) => fence.rootPath),
          ...roots.map((root) => root.path),
        ]) {
          if (candidate && pathIsSameOrWithin(target, candidate)) watchTree(candidate);
        }
      });
      watchers.push(watcher);
    } catch {
      // Hash snapshots remain authoritative if the platform cannot watch a path.
    }
  };

  watchTree = (requestedRoot) => {
    watchDir(requestedRoot);
    if (!existsSync(requestedRoot)) return;
    const visit = (dir) => {
      if (watchedDirs.size >= MAX_WATCHED_DIRECTORIES) return;
      watchDir(dir);
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) visit(join(dir, entry.name));
      }
    };
    visit(requestedRoot);
  };

  for (const store of stores) {
    if (store.kind === 'directory') {
      watchDir(store.parentPath);
      watchTree(store.defaultPath);
    } else if (store.kind === 'pattern') {
      watchDir(store.defaultPath);
    } else {
      watchDir(store.parentPath);
    }
  }
  for (const fence of fences) {
    if (fence.watchTransient !== false) watchDir(fence.rootPath);
  }
  for (const root of roots) watchTree(root.path);

  return {
    stop() {
      for (const watcher of watchers) watcher.close();
      const failures = [];
      for (const store of stores) {
        if (JSON.stringify(before.get(store.id)) !== JSON.stringify(storeSnapshot(store))) {
          failures.push(`${store.id}:snapshot_changed`);
        }
        if (touched.has(store.id)) failures.push(`${store.id}:transient_write_observed`);
      }
      for (const fence of fences) {
        if (JSON.stringify(fenceBefore.get(fence.id)) !== JSON.stringify(classFenceSnapshot(fence))) {
          failures.push(`${fence.id}:snapshot_changed`);
        }
        if (touched.has(fence.id)) failures.push(`${fence.id}:transient_write_observed`);
      }
      for (const root of roots) {
        if (touched.has(root.id)) failures.push(`${root.id}:transient_write_observed`);
      }
      if (failures.length > 0) {
        const error = new Error(`OPK_VITEST_LIVE_STORE_GUARD_FAILED ${failures.join(',')}`);
        error.code = 'OPK_VITEST_LIVE_STORE_GUARD_FAILED';
        error.failures = failures;
        throw error;
      }
    },
  };
}

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
const prelude = \`. \${quote(helper)}; $global:OpkVitestOriginalAssert = (Get-Command Assert-OpkVitestStorePathSafe -CommandType Function).ScriptBlock; function global:Assert-OpkVitestStorePathSafe { param([Parameter(Mandatory=$true)][string]$Path, [string]$Operation = 'write') if ($env:OPK_VITEST_HARNESS_ROOT) { $candidate = Resolve-OpkVitestCanonicalPath -Path $Path; $harnessRoot = Resolve-OpkVitestCanonicalPath -Path $env:OPK_VITEST_HARNESS_ROOT; if (Test-OpkVitestPathWithin -Candidate $candidate -Root $harnessRoot) { return } }; & $global:OpkVitestOriginalAssert -Path $Path -Operation $Operation }; Enable-OpkVitestStoreIsolation;\`;
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
    writeFileSync(join(binDir, 'pwsh.cmd'), `@echo off\r\n"${process.execPath}" "${shimModule}" %*\r\n`, 'utf8');
  } else {
    const shim = join(binDir, 'pwsh');
    writeFileSync(shim, `#!/usr/bin/env sh\nexec "${process.execPath}" "${shimModule}" "$@"\n`, 'utf8');
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
