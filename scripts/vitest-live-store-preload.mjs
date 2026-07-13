import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertHarnessWritePathSafe } from './lib/vitest-live-store-harness.mjs';

if (process.env.OPK_VITEST_HARNESS === '1') {
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
  const guardPath = (candidate, operation) => {
    // Most test writes are already redirected below the per-invocation root.
    // Resolve the nearest existing ancestor once so a symlink inside that root
    // cannot hide a destination outside it, then skip the full 30-store catalog.
    const canonical = canonicalizeFast(candidate);
    if (canonical && harnessRoot && pathIsSameOrWithin(canonical, harnessRoot)) return;
    assertHarnessWritePathSafe(candidate, operation);
  };

  const wrapSyncPath = (name, index = 0, shouldGuard = () => true) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function opkVitestGuardedFsSyncCall(...args) {
      if (shouldGuard(args)) {
        guardPath(args[index], `fs.${name}`);
      }
      return original.apply(this, args);
    };
  };

  const wrapCallbackPath = (name, index = 0, shouldGuard = () => true) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function opkVitestGuardedFsCallbackCall(...args) {
      if (shouldGuard(args)) {
        guardPath(args[index], `fs.${name}`);
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
    guardPath(source, 'fs.renameSync.source');
    guardPath(destination, 'fs.renameSync.destination');
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
      guardPath(source, 'fs.rename.source');
      guardPath(destination, 'fs.rename.destination');
      return nativeRename.call(this, source, destination, ...rest);
    };
  }

  const promises = fs.promises;
  const wrapPromisePath = (name, index = 0, shouldGuard = () => true) => {
    const original = promises?.[name];
    if (typeof original !== 'function') return;
    promises[name] = async function opkVitestGuardedFsPromise(...args) {
      if (shouldGuard(args)) {
        guardPath(args[index], `fs.promises.${name}`);
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
      guardPath(source, 'fs.promises.rename.source');
      guardPath(destination, 'fs.promises.rename.destination');
      return nativePromiseRename(source, destination);
    };
  }
  if (typeof promises?.open === 'function') {
    const nativePromiseOpen = promises.open.bind(promises);
    promises.open = async (path, flags, ...rest) => {
      if (writeOpenFlags(flags)) {
        guardPath(path, 'fs.promises.open');
      }
      return nativePromiseOpen(path, flags, ...rest);
    };
  }

  syncBuiltinESMExports();
}
