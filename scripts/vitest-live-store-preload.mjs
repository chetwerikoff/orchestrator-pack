import fs from 'node:fs';
import childProcess from 'node:child_process';
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
  const text = typeof flags === 'number' ? flags : String(flags ?? 'r');
  if (typeof text === 'number') {
    return Boolean(text & fs.constants.O_WRONLY) || Boolean(text & fs.constants.O_RDWR)
      || Boolean(text & fs.constants.O_CREAT) || Boolean(text & fs.constants.O_TRUNC)
      || Boolean(text & fs.constants.O_APPEND);
  }
  return /[wax+]/.test(text);
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
    const nextPath = writeFlags(flags) ? redirect(path, 'openSync') : path;
    return originalOpenSync.call(this, nextPath, flags, ...rest);
  };

  const originalOpen = fs.open;
  fs.open = function patchedOpen(path, flags, ...rest) {
    const nextPath = writeFlags(flags) ? redirect(path, 'open') : path;
    return originalOpen.call(this, nextPath, flags, ...rest);
  };

  if (fs.promises?.open) {
    const originalPromiseOpen = fs.promises.open;
    fs.promises.open = async function patchedPromiseOpen(path, flags, ...rest) {
      const nextPath = writeFlags(flags) ? redirect(path, 'promises.open') : path;
      return originalPromiseOpen.call(this, nextPath, flags, ...rest);
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

const HARNESS_ENV_KEYS = new Set([
  'HOME', 'USERPROFILE', 'XDG_STATE_HOME', 'TMPDIR', 'TEMP', 'TMP',
  'OPK_BASE_DIR', 'OPK_WAKE_SUPERVISOR_STATE_DIR',
  'ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR', 'OPK_SIDE_PROCESS_STATE_DIR',
  'OPK_MECHANICAL_TRANSPORT_TEMP', 'OPK_OPERATOR_ESCALATION_INBOX',
  'OPK_ESCALATION_HEALTH_SPOOL', 'OPK_ORCHESTRATOR_ESCALATION_STATE',
  'OPK_WORKER_MESSAGE_DISPATCH_JOURNAL', 'OPK_WORKER_MESSAGE_SUBMIT_STATE',
  'OPK_WORKER_STATUS_STORE', 'OPK_WORKER_REPORT_STORE',
  'OPK_PR_SESSION_BINDING_CACHE', 'OPK_REVIEW_CLAIM_DIR',
  'OPK_WORKER_NUDGE_CLAIM_DIR', 'OPK_REPORT_STATE_SEED_STATE',
  'OPK_REVIEW_TRIGGER_REEVAL_WATCH_STATE', 'OPK_CI_GREEN_WAKE_RECONCILE_STATE',
  'OPK_DEAD_WORKER_RECONCILE_STATE', 'OPK_REVIEW_TRIGGER_RECONCILE_STATE',
  'OPK_WAKE_DEDUP_STATE', 'OPK_REAL_PWSH', 'PATH', 'NODE_OPTIONS',
]);

function harnessEnvironment(base = {}) {
  const env = { ...base };
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('OPK_VITEST_') || HARNESS_ENV_KEYS.has(name)) env[name] = value;
  }
  return env;
}

function nestedHarnessArgs(command, args) {
  const values = [String(command ?? ''), ...(Array.isArray(args) ? args.map(String) : [])];
  return values.some((value) => value.includes('run-vitest-with-harness.mjs'));
}

function childOptions(command, args, options) {
  const next = { ...(options ?? {}) };
  next.env = harnessEnvironment(options?.env ?? process.env);
  if (nestedHarnessArgs(command, args) && process.env.OPK_VITEST_HARNESS_ROOT) {
    next.env.OPK_VITEST_REENTRY_HARNESS_ROOT = process.env.OPK_VITEST_HARNESS_ROOT;
  }
  return next;
}

function patchChild(name, shape) {
  const original = childProcess[name];
  if (typeof original !== 'function') return;
  childProcess[name] = function patchedChild(...args) {
    const { commandIndex, argsIndex, optionsIndex } = shape;
    const command = args[commandIndex];
    const commandArgs = argsIndex === null ? [] : args[argsIndex];
    const options = args[optionsIndex];
    args[optionsIndex] = childOptions(command, commandArgs, options);
    return original.apply(this, args);
  };
}

if (ACTIVE) {
  patchChild('spawn', { commandIndex: 0, argsIndex: 1, optionsIndex: 2 });
  patchChild('spawnSync', { commandIndex: 0, argsIndex: 1, optionsIndex: 2 });
  patchChild('execFile', { commandIndex: 0, argsIndex: 1, optionsIndex: 2 });
  patchChild('execFileSync', { commandIndex: 0, argsIndex: 1, optionsIndex: 2 });
  patchChild('fork', { commandIndex: 0, argsIndex: 1, optionsIndex: 2 });

  for (const name of ['exec', 'execSync']) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    childProcess[name] = function patchedExec(command, options, ...rest) {
      return original.call(this, command, childOptions(command, [], options), ...rest);
    };
  }
  syncBuiltinESMExports();
}
