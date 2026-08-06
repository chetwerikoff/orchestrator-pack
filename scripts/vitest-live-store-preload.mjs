import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  assertHarnessWritePathSafe,
  redirectHarnessWritePath,
} from './lib/vitest-live-store-harness.mjs';

const ACTIVE = process.env.OPK_VITEST_HARNESS === '1';

function pathValue(value) {
  return value instanceof URL ? value : String(value);
}

function redirect(value, operation) {
  if (!ACTIVE || typeof value === 'number') return value;
  return redirectHarnessWritePath(pathValue(value), operation, process.env);
}

function assertSafe(value, operation) {
  if (!ACTIVE || typeof value === 'number') return value;
  assertHarnessWritePathSafe(pathValue(value), operation, process.env);
  return value;
}

function writeFlags(flags) {
  if (typeof flags === 'number') {
    return Boolean(flags & fs.constants.O_WRONLY) || Boolean(flags & fs.constants.O_RDWR)
      || Boolean(flags & fs.constants.O_CREAT) || Boolean(flags & fs.constants.O_TRUNC)
      || Boolean(flags & fs.constants.O_APPEND);
  }
  return /[wax+]/.test(String(flags ?? 'r'));
}

function patchSync(name, pathIndexes, operation = name) {
  const original = fs[name];
  if (typeof original !== 'function') return;
  fs[name] = function patchedSync(...args) {
    for (const index of pathIndexes) args[index] = redirect(args[index], operation);
    return original.apply(this, args);
  };
}

function patchCallback(name, pathIndexes, operation = name) {
  const original = fs[name];
  if (typeof original !== 'function') return;
  fs[name] = function patchedCallback(...args) {
    for (const index of pathIndexes) args[index] = redirect(args[index], operation);
    return original.apply(this, args);
  };
}

function patchPromise(name, pathIndexes, operation = `promises.${name}`) {
  const original = fs.promises?.[name];
  if (typeof original !== 'function') return;
  fs.promises[name] = async function patchedPromise(...args) {
    for (const index of pathIndexes) args[index] = redirect(args[index], operation);
    return original.apply(this, args);
  };
}

if (ACTIVE) {
  for (const name of [
    'writeFileSync', 'appendFileSync', 'truncateSync', 'unlinkSync', 'rmSync',
    'rmdirSync', 'mkdirSync', 'chmodSync', 'chownSync', 'utimesSync', 'lutimesSync',
  ]) patchSync(name, [0]);
  patchSync('renameSync', [0, 1]);
  patchSync('copyFileSync', [1]);
  patchSync('cpSync', [1]);

  for (const name of [
    'writeFile', 'appendFile', 'truncate', 'unlink', 'rm', 'rmdir', 'mkdir',
    'chmod', 'chown', 'utimes', 'lutimes',
  ]) patchCallback(name, [0]);
  patchCallback('rename', [0, 1]);
  patchCallback('copyFile', [1]);
  patchCallback('cp', [1]);

  for (const name of [
    'writeFile', 'appendFile', 'truncate', 'unlink', 'rm', 'rmdir', 'mkdir',
    'chmod', 'chown', 'utimes', 'lutimes',
  ]) patchPromise(name, [0]);
  patchPromise('rename', [0, 1]);
  patchPromise('copyFile', [1]);
  patchPromise('cp', [1]);

  const originalOpenSync = fs.openSync;
  fs.openSync = function patchedOpenSync(path, flags, ...rest) {
    return originalOpenSync.call(this, writeFlags(flags) ? redirect(path, 'openSync') : path, flags, ...rest);
  };

  const originalOpen = fs.open;
  fs.open = function patchedOpen(path, flags, ...rest) {
    return originalOpen.call(this, writeFlags(flags) ? redirect(path, 'open') : path, flags, ...rest);
  };

  if (fs.promises?.open) {
    const originalPromiseOpen = fs.promises.open;
    fs.promises.open = async function patchedPromiseOpen(path, flags, ...rest) {
      return originalPromiseOpen.call(
        this,
        writeFlags(flags) ? redirect(path, 'promises.open') : path,
        flags,
        ...rest,
      );
    };
  }

  const originalCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = function patchedCreateWriteStream(path, ...rest) {
    return originalCreateWriteStream.call(this, redirect(path, 'createWriteStream'), ...rest);
  };

  const originalSymlinkSync = fs.symlinkSync;
  fs.symlinkSync = function patchedSymlinkSync(target, path, ...rest) {
    assertSafe(target, 'symlinkSync-target');
    return originalSymlinkSync.call(this, target, redirect(path, 'symlinkSync'), ...rest);
  };

  const originalSymlink = fs.symlink;
  fs.symlink = function patchedSymlink(target, path, ...rest) {
    assertSafe(target, 'symlink-target');
    return originalSymlink.call(this, target, redirect(path, 'symlink'), ...rest);
  };

  if (fs.promises?.symlink) {
    const originalPromiseSymlink = fs.promises.symlink;
    fs.promises.symlink = async function patchedPromiseSymlink(target, path, ...rest) {
      assertSafe(target, 'promises.symlink-target');
      return originalPromiseSymlink.call(this, target, redirect(path, 'promises.symlink'), ...rest);
    };
  }

  syncBuiltinESMExports();
}
