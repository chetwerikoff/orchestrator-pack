import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { assertHarnessWritePathSafe } from './lib/vitest-live-store-harness.mjs';

if (process.env.OPK_VITEST_HARNESS === '1') {
  const wrapPath = (name, index = 0, extra = () => true) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function opkVitestGuardedFsCall(...args) {
      if (extra(args)) assertHarnessWritePathSafe(args[index], `fs.${name}`);
      return original.apply(this, args);
    };
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
  ]) wrapPath(name);

  wrapPath('copyFileSync', 1);
  wrapPath('renameSync', 0);
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function opkVitestGuardedRenameSync(source, destination, ...rest) {
    assertHarnessWritePathSafe(source, 'fs.renameSync.source');
    assertHarnessWritePathSafe(destination, 'fs.renameSync.destination');
    return originalRenameSync.call(this, source, destination, ...rest);
  };

  wrapPath('openSync', 0, (args) => {
    const flags = args[1];
    if (typeof flags === 'number') {
      const access = flags & 3;
      return access === 1 || access === 2 || Boolean(flags & fs.constants.O_CREAT) || Boolean(flags & fs.constants.O_TRUNC) || Boolean(flags & fs.constants.O_APPEND);
    }
    return /[wax+]/i.test(String(flags ?? 'r'));
  });
  wrapPath('createWriteStream');

  const promises = fs.promises;
  const wrapPromisePath = (name, index = 0) => {
    const original = promises?.[name];
    if (typeof original !== 'function') return;
    promises[name] = async function opkVitestGuardedFsPromise(...args) {
      assertHarnessWritePathSafe(args[index], `fs.promises.${name}`);
      return original.apply(this, args);
    };
  };
  for (const name of ['writeFile', 'appendFile', 'truncate', 'unlink', 'rm', 'rmdir', 'mkdir', 'chmod', 'chown', 'utimes']) wrapPromisePath(name);
  wrapPromisePath('copyFile', 1);
  if (typeof promises?.rename === 'function') {
    const originalRename = promises.rename.bind(promises);
    promises.rename = async (source, destination) => {
      assertHarnessWritePathSafe(source, 'fs.promises.rename.source');
      assertHarnessWritePathSafe(destination, 'fs.promises.rename.destination');
      return originalRename(source, destination);
    };
  }
  if (typeof promises?.open === 'function') {
    const originalOpen = promises.open.bind(promises);
    promises.open = async (path, flags, ...rest) => {
      if (/[wax+]/i.test(String(flags ?? 'r'))) assertHarnessWritePathSafe(path, 'fs.promises.open');
      return originalOpen(path, flags, ...rest);
    };
  }

  syncBuiltinESMExports();
}
