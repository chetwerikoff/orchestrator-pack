import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { assertHarnessWritePathSafe } from './lib/vitest-live-store-harness.mjs';

if (process.env.OPK_VITEST_HARNESS === '1') {
  const wrapSyncPath = (name, index = 0, shouldGuard = () => true) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function opkVitestGuardedFsSyncCall(...args) {
      if (shouldGuard(args)) {
        assertHarnessWritePathSafe(args[index], `fs.${name}`);
      }
      return original.apply(this, args);
    };
  };

  const wrapCallbackPath = (name, index = 0, shouldGuard = () => true) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function opkVitestGuardedFsCallbackCall(...args) {
      if (shouldGuard(args)) {
        assertHarnessWritePathSafe(args[index], `fs.${name}`);
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
    assertHarnessWritePathSafe(source, 'fs.renameSync.source');
    assertHarnessWritePathSafe(destination, 'fs.renameSync.destination');
    return nativeRenameSync.call(this, source, destination, ...rest);
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
      assertHarnessWritePathSafe(source, 'fs.rename.source');
      assertHarnessWritePathSafe(destination, 'fs.rename.destination');
      return nativeRename.call(this, source, destination, ...rest);
    };
  }

  const promises = fs.promises;
  const wrapPromisePath = (name, index = 0, shouldGuard = () => true) => {
    const original = promises?.[name];
    if (typeof original !== 'function') return;
    promises[name] = async function opkVitestGuardedFsPromise(...args) {
      if (shouldGuard(args)) {
        assertHarnessWritePathSafe(args[index], `fs.promises.${name}`);
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
      assertHarnessWritePathSafe(source, 'fs.promises.rename.source');
      assertHarnessWritePathSafe(destination, 'fs.promises.rename.destination');
      return nativePromiseRename(source, destination);
    };
  }
  if (typeof promises?.open === 'function') {
    const nativePromiseOpen = promises.open.bind(promises);
    promises.open = async (path, flags, ...rest) => {
      if (writeOpenFlags(flags)) {
        assertHarnessWritePathSafe(path, 'fs.promises.open');
      }
      return nativePromiseOpen(path, flags, ...rest);
    };
  }

  syncBuiltinESMExports();
}
