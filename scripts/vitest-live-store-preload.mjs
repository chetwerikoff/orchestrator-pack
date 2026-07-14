import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertHarnessWritePathSafe, redirectHarnessWritePath } from './lib/vitest-live-store-harness.mjs';

const preloadInstalledKey = Symbol.for('opk.vitest.liveStorePreloadInstalled');

if (process.env.OPK_VITEST_HARNESS === '1' && !globalThis[preloadInstalledKey]) {
  globalThis[preloadInstalledKey] = true;
  const asPathText = (candidate) => {
    if (candidate instanceof URL) return fileURLToPath(candidate);
    if (Buffer.isBuffer(candidate)) return candidate.toString();
    return typeof candidate === 'string' ? candidate : '';
  };

  const canonicalizeFast = (candidate) => {
    const text = asPathText(candidate).trim();
    if (!text) return '';
    const absolute = isAbsolute(text) ? resolve(text) : resolve(process.cwd(), text);
    let cursor = absolute;
    const suffix = [];
    while (true) {
      try {
        let canonical = fs.realpathSync.native(cursor);
        for (const part of suffix) canonical = join(canonical, part);
        return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return '';
        const parent = dirname(cursor);
        if (parent === cursor) {
          return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
        }
        suffix.unshift(cursor.slice(parent.length).replace(/^[/\\]+/, ''));
        cursor = parent;
      }
    }
  };

  const pathIsSameOrWithin = (candidate, root) => {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  };

  const harnessRoot = canonicalizeFast(process.env.OPK_VITEST_HARNESS_ROOT);
  const remapPath = (candidate, operation) => {
    // Most test writes are already redirected below the per-invocation root.
    // Resolve the nearest existing ancestor once so a symlink inside that root
    // cannot hide a destination outside it, then skip the full 30-store catalog.
    const canonical = canonicalizeFast(candidate);
    if (canonical && harnessRoot && pathIsSameOrWithin(canonical, harnessRoot)) return candidate;
    const redirected = redirectHarnessWritePath(candidate);
    if (redirected) return redirected;
    assertHarnessWritePathSafe(candidate, operation);
    return candidate;
  };

  const wrapSyncPath = (name, index = 0, shouldGuard = () => true) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function opkVitestGuardedFsSyncCall(...args) {
      if (shouldGuard(args)) {
        args[index] = remapPath(args[index], `fs.${name}`);
      }
      return original.apply(this, args);
    };
  };

  const wrapCallbackPath = (name, index = 0, shouldGuard = () => true) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function opkVitestGuardedFsCallbackCall(...args) {
      if (shouldGuard(args)) {
        args[index] = remapPath(args[index], `fs.${name}`);
      }
      return original.apply(this, args);
    };
  };

  const writeOpenFlags = (flags) => {
    if (typeof flags === 'number') {
      const access = flags & 3;
      return access === 1
        || access === 2
        || Boolean(flags & fs.constants.O_CREATE)
        || Boolean(flags & fs.constants.O_TRUNC)
        || Boolean(flags & fs.constants.O_APPEND);
    }
    return /[wax+]/i.test(String(flags ?? 'r'));
  };

  for (const name of [
    'writeFileSync',
    'appendFileSync',
    'truncateSync',
    'unlinkSync',
    'rmSync',
    'rmdirSync',
    'mkdirSync',
    'chmodSync',
    'chownSync',
    'utimesSync',
  ]) {
    wrapSyncPath(name);
  }
  wrapSyncPath('copyFileSync', 1);
  wrapSyncPath('linkSync', 1);
  wrapSyncPath('symlinkSync', 1);
  wrapSyncPath('openSync', 0, (args) => writeOpenFlags(args[1]));
  wrapSyncPath('createWriteStream');

  const nativeRenameSync = fs.renameSync;
  fs.renameSync = function opkVitestGuardedRenameSync(source, destination, ...rest) {
    const nextSource = remapPath(source, 'fs.renameSync.source');
    const nextDestination = remapPath(destination, 'fs.renameSync.destination');
    return nativeRenameSync.call(this, nextSource, nextDestination, ...rest);
  };

  for (const name of [
    'writeFile',
    'appendFile',
    'truncate',
    'unlink',
    'rm',
    'rmdir',
    'mkdir',
    'chmod',
    'chown',
    'utimes',
  ]) {
    wrapCallbackPath(name);
  }
  wrapCallbackPath('copyFile', 1);
  wrapCallbackPath('link', 1);
  wrapCallbackPath('symlink', 1);
  wrapCallbackPath('open', 0, (args) => writeOpenFlags(args[1]));

  if (typeof fs.rename === 'function') {
    const nativeRename = fs.rename;
    fs.rename = function opkVitestGuardedRename(source, destination, ...rest) {
      const nextSource = remapPath(source, 'fs.rename.source');
      const nextDestination = remapPath(destination, 'fs.rename.destination');
      return nativeRename.call(this, nextSource, nextDestination, ...rest);
    };
  }

  const promises = fs.promises;
  const wrapPromisePath = (name, index = 0, shouldGuard = () => true) => {
    const original = promises?.[name];
    if (typeof original !== 'function') return;
    promises[name] = async function opkVitestGuardedFsPromise(...args) {
      if (shouldGuard(args)) {
        args[index] = remapPath(args[index], `fs.promises.${name}`);
      }
      return original.apply(this, args);
    };
  };

  for (const name of [
    'writeFile',
    'appendFile',
    'truncate',
    'unlink',
    'rm',
    'rmdir',
    'mkdir',
    'chmod',
    'chown',
    'utimes',
  ]) {
    wrapPromisePath(name);
  }
  wrapPromisePath('copyFile', 1);
  wrapPromisePath('link', 1);
  wrapPromisePath('symlink', 1);

  if (typeof promises?.rename === 'function') {
    const nativePromiseRename = promises.rename.bind(promises);
    promises.rename = async (source, destination) => {
      return nativePromiseRename(
        remapPath(source, 'fs.promises.rename.source'),
        remapPath(destination, 'fs.promises.rename.destination'),
      );
    };
  }
  if (typeof promises?.open === 'function') {
    const nativePromiseOpen = promises.open.bind(promises);
    promises.open = async (path, flags, ...rest) => {
      if (writeOpenFlags(flags)) {
        path = remapPath(path, 'fs.promises.open');
      }
      return nativePromiseOpen(path, flags, ...rest);
    };
  }

  const resolveProductionHomeForChild = (env) => {
    const explicitHome = String(env.HOME ?? '').trim();
    if (String(env.OPK_VITEST_PRODUCTION_HOME ?? '').trim()) {
      return env.OPK_VITEST_PRODUCTION_HOME;
    }
    return explicitHome;
  };

  const resolveProductionTmpForChild = (env) => {
    if (String(env.OPK_VITEST_PRODUCTION_TMP ?? '').trim()) {
      return env.OPK_VITEST_PRODUCTION_TMP;
    }
    return env.TMPDIR || env.TEMP || env.TMP || '';
  };

  const getPowerShellSwitchValue = (argv, switchName) => {
    const values = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
    for (let index = 0; index < values.length; index += 1) {
      const token = values[index];
      if (token === switchName) {
        const next = values[index + 1];
        if (next && !next.startsWith('-')) return next;
        return 'true';
      }
      if (token.startsWith(`${switchName}=`) && token.length > switchName.length + 1) {
        return token.slice(switchName.length + 1);
      }
    }
    return '';
  };

  const explicitChildPassthroughKeys = new Set([
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'XDG_STATE_HOME',
    'ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR',
  ]);

  const harnessSnapshotEnv = { ...process.env };
  const stableHarnessKeys = new Set([
    ...Object.keys(harnessSnapshotEnv).filter((name) =>
      name.startsWith('AO_')
      || name.startsWith('OPK_VITEST_')
      || explicitChildPassthroughKeys.has(name),
    ),
    'PATH',
    'OPK_REAL_PWSH',
    'OPK_REAL_AO',
    'OPK_REAL_AO_BINARY',
    'GIT_REAL_BINARY',
    'GIT_SYSTEM_BINARY',
  ]);
  const explicitBypassKeys = [
    'OPK_VITEST_HARNESS_ROOT',
    'OPK_VITEST_HARNESS_INVENTORY',
    'AO_ORCHESTRATOR_ESCALATION_STATE',
    'AO_OPERATOR_ESCALATION_INBOX',
    'AO_ESCALATION_HEALTH_SPOOL',
    'AO_WAKE_SUPERVISOR_STATE_DIR',
    'ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR',
    'AO_SIDE_PROCESS_STATE_DIR',
    'AO_BASE_DIR',
    'AO_MECHANICAL_TRANSPORT_TEMP',
    'TMPDIR',
    'TEMP',
    'TMP',
    'XDG_STATE_HOME',
  ];

  const hasExplicitHarnessBypass = (env) => {
    if (!env || env.OPK_VITEST_HARNESS !== '') return false;
    if (env.OPK_VITEST_SKIP_CHILD_ENV_MERGE === '1') return true;
    return explicitBypassKeys.some((name) =>
      Object.prototype.hasOwnProperty.call(env, name) && String(env[name] ?? '') === '',
    );
  };

  const restoreStableHarnessEnv = (env) => {
    if (!env || env.OPK_VITEST_HARNESS !== '' || hasExplicitHarnessBypass(env)) {
      return env;
    }
    const restored = { ...env };
    for (const name of stableHarnessKeys) {
      const snapshotValue = harnessSnapshotEnv[name];
      if (snapshotValue == null || snapshotValue === '') {
        continue;
      }
      restored[name] = snapshotValue;
    }
    return restored;
  };

  const mergeHarnessChildEnv = (targetEnv) => {
    const mergedEnv = {
      ...restoreStableHarnessEnv(targetEnv ?? {}),
    };
    for (const [name, value] of Object.entries(harnessSnapshotEnv)) {
      if (!name || value == null) {
        continue;
      }
      if (stableHarnessKeys.has(name)) {
        if (!Object.prototype.hasOwnProperty.call(mergedEnv, name)) {
          mergedEnv[name] = value;
        }
      }
    }
    return mergedEnv;
  };

  const normalizeChildEnv = (command, explicitEnv, argv = []) => {
    if (explicitEnv?.OPK_VITEST_SKIP_CHILD_ENV_MERGE === '1') {
      const passthroughEnv = {
        ...(explicitEnv ?? {}),
      };
      delete passthroughEnv.OPK_VITEST_SKIP_CHILD_ENV_MERGE;
      return passthroughEnv;
    }
    const mergedEnv = explicitEnv
      ? mergeHarnessChildEnv(explicitEnv)
      : mergeHarnessChildEnv(process.env);
    if (explicitEnv && Object.prototype.hasOwnProperty.call(explicitEnv, 'HOME')
      && !Object.prototype.hasOwnProperty.call(explicitEnv, 'OPK_VITEST_PRODUCTION_HOME')) {
      mergedEnv.OPK_VITEST_PRODUCTION_HOME = resolveProductionHomeForChild(mergedEnv);
    }
    if ((explicitEnv && (
      Object.prototype.hasOwnProperty.call(explicitEnv, 'TMPDIR')
      || Object.prototype.hasOwnProperty.call(explicitEnv, 'TEMP')
      || Object.prototype.hasOwnProperty.call(explicitEnv, 'TMP')
    )) && !Object.prototype.hasOwnProperty.call(explicitEnv, 'OPK_VITEST_PRODUCTION_TMP')) {
      const productionTmp = resolveProductionTmpForChild(mergedEnv);
      if (String(productionTmp).trim()) {
        mergedEnv.OPK_VITEST_PRODUCTION_TMP = productionTmp;
      }
    }
    if (explicitEnv && Object.prototype.hasOwnProperty.call(explicitEnv, 'AO_BASE_DIR')
      && !Object.prototype.hasOwnProperty.call(explicitEnv, 'OPK_VITEST_PRODUCTION_AO_BASE')) {
      const explicitAoBase = String(mergedEnv.AO_BASE_DIR ?? '').trim();
      if (explicitAoBase) {
        mergedEnv.OPK_VITEST_PRODUCTION_AO_BASE = explicitAoBase;
      }
    }
    const explicitWake = String(
      mergedEnv.AO_WAKE_SUPERVISOR_STATE_DIR
      || mergedEnv.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR
      || '',
    ).trim();
    if (explicitEnv && (
      Object.prototype.hasOwnProperty.call(explicitEnv, 'AO_WAKE_SUPERVISOR_STATE_DIR')
      || Object.prototype.hasOwnProperty.call(explicitEnv, 'ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR')
    ) && !Object.prototype.hasOwnProperty.call(explicitEnv, 'OPK_VITEST_PRODUCTION_WAKE_ROOT')
      && explicitWake) {
      mergedEnv.OPK_VITEST_PRODUCTION_WAKE_ROOT = explicitWake;
    }
    const commandBase = basename(String(command ?? '')).toLowerCase();
    const explicitStateDir = getPowerShellSwitchValue(argv, '-StateDir');
    if ((commandBase === 'pwsh' || commandBase === 'pwsh.exe' || commandBase === 'powershell' || commandBase === 'powershell.exe')
      && explicitStateDir) {
      mergedEnv.AO_SIDE_PROCESS_STATE_DIR = explicitStateDir;
    }
    if (commandBase === 'ao' || commandBase === 'ao.cmd' || commandBase === 'ao.exe' || commandBase === 'ao.bat') {
      const productionHome = String(harnessSnapshotEnv.OPK_VITEST_PRODUCTION_HOME ?? '').trim();
      if (productionHome && !Object.prototype.hasOwnProperty.call(explicitEnv ?? {}, 'HOME')) {
        mergedEnv.HOME = productionHome;
      }
    }
    return mergedEnv;
  };

  const wrapChildOptions = (command, args, optionsIndex) => {
    const nextArgs = [...args];
    const options = nextArgs[optionsIndex];
    const argv = Array.isArray(nextArgs[0]) ? nextArgs[0] : [];
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      nextArgs[optionsIndex] = {
        ...options,
        env: normalizeChildEnv(command, options.env, argv),
      };
      return nextArgs;
    }
    const normalizedOptions = {
      env: normalizeChildEnv(command, undefined, argv),
    };
    if (optionsIndex <= nextArgs.length) {
      nextArgs.splice(optionsIndex, 0, normalizedOptions);
    } else {
      nextArgs[optionsIndex] = normalizedOptions;
    }
    return nextArgs;
  };

  const nativeSpawn = childProcess.spawn;
  childProcess.spawn = function opkVitestGuardedSpawn(command, ...args) {
    return nativeSpawn.call(this, command, ...wrapChildOptions(command, args, Array.isArray(args[0]) ? 1 : 0));
  };

  const nativeSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function opkVitestGuardedSpawnSync(command, ...args) {
    return nativeSpawnSync.call(this, command, ...wrapChildOptions(command, args, Array.isArray(args[0]) ? 1 : 0));
  };

  const nativeExecFile = childProcess.execFile;
  childProcess.execFile = function opkVitestGuardedExecFile(file, ...args) {
    return nativeExecFile.call(this, file, ...wrapChildOptions(file, args, Array.isArray(args[0]) ? 1 : 0));
  };

  const nativeExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function opkVitestGuardedExecFileSync(file, ...args) {
    return nativeExecFileSync.call(this, file, ...wrapChildOptions(file, args, Array.isArray(args[0]) ? 1 : 0));
  };

  if (typeof childProcess.fork === 'function') {
    const nativeFork = childProcess.fork;
    childProcess.fork = function opkVitestGuardedFork(modulePath, ...args) {
      return nativeFork.call(this, modulePath, ...wrapChildOptions(modulePath, args, Array.isArray(args[0]) ? 1 : 0));
    };
  }

  syncBuiltinESMExports();
}
