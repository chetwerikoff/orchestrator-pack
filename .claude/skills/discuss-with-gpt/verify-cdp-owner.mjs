// Verify the process listening on a CDP port was launched with the expected
// --user-data-dir before discuss-with-gpt reuses an existing Chrome session.
//
// Usage:
//   node verify-cdp-owner.mjs verify --profile <user-data-dir> [--cdp url]
//   node verify-cdp-owner.mjs record --profile <user-data-dir> [--cdp url]

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const __testOwnerProbe = {
  stallExecFile: false,
  stallFetch: false,
};

export function parseCdpPort(cdpUrl) {
  const u = new URL(cdpUrl);
  if (u.port) return u.port;
  return u.protocol === 'https:' ? '443' : '80';
}

function toWslPath(p) {
  let s = String(p).trim().replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s)) {
    return `/mnt/${s[0].toLowerCase()}${s.slice(2)}`;
  }
  return s;
}

export function normalizeProfilePath(p) {
  if (!p) return '';
  const wsl = toWslPath(p);
  try {
    if (existsSync(wsl)) {
      return realpathSync.native(wsl).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    }
  } catch { /* ignore */ }
  return wsl.toLowerCase().replace(/\/+$/, '');
}

function extractUserDataDir(cmdline) {
  const m = cmdline.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return m ? (m[1] || m[2] || m[3]) : null;
}

function execFileBounded(file, args, timeoutMs) {
  if (timeoutMs <= 0) {
    return Promise.reject(Object.assign(new Error('owner_probe_timeout'), { code: 'TIMEOUT' }));
  }
  if (__testOwnerProbe.stallExecFile) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error('owner_probe_timeout'), { code: 'TIMEOUT' })), timeoutMs);
    });
  }
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout) => {
        if (error) {
          if (error.killed || error.signal === 'SIGTERM' || error.code === 'ERR_CHILD_PROCESS_TERMINATED') {
            reject(Object.assign(new Error('owner_probe_timeout'), { code: 'TIMEOUT' }));
            return;
          }
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function findWindowsListenerPidSync(port) {
  const netstat = '/mnt/c/Windows/System32/netstat.exe';
  if (!existsSync(netstat)) return null;
  const out = execFileSync(netstat, ['-ano'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const m = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'));
    if (m) return m[1];
  }
  return null;
}

async function findWindowsListenerPidBounded(port, timeoutMs) {
  const netstat = '/mnt/c/Windows/System32/netstat.exe';
  if (!existsSync(netstat)) return null;
  const out = await execFileBounded(netstat, ['-ano'], timeoutMs);
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const m = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'));
    if (m) return m[1];
  }
  return null;
}

function findLinuxListenerPidSync(port) {
  try {
    const out = execFileSync('ss', ['-tlnp'], { encoding: 'utf8' });
    const m = out.match(new RegExp(`:${port}\\s+[^\\n]*pid=(\\d+)`, 'i'));
    if (m) return m[1];
  } catch { /* ignore */ }
  try {
    const out = execFileSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pid = out.trim().split('\n').find(Boolean);
    if (pid) return pid;
  } catch { /* ignore */ }
  return null;
}

async function findLinuxListenerPidBounded(port, timeoutMs) {
  try {
    const out = await execFileBounded('ss', ['-tlnp'], timeoutMs);
    const m = out.match(new RegExp(`:${port}\\s+[^\\n]*pid=(\\d+)`, 'i'));
    if (m) return m[1];
  } catch (error) {
    if (error?.code === 'TIMEOUT') throw error;
    /* try lsof */
  }
  try {
    const out = await execFileBounded('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'], timeoutMs);
    const pid = out.trim().split('\n').find(Boolean);
    if (pid) return pid;
  } catch (error) {
    if (error?.code === 'TIMEOUT') throw error;
  }
  return null;
}

function getWindowsCmdlineSync(pid) {
  const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (!existsSync(ps)) return null;
  try {
    return execFileSync(
      ps,
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    ).trim();
  } catch {
    return null;
  }
}

async function getWindowsCmdlineBounded(pid, timeoutMs) {
  const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (!existsSync(ps)) return null;
  try {
    return (await execFileBounded(
      ps,
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      timeoutMs,
    )).trim();
  } catch (error) {
    if (error?.code === 'TIMEOUT') throw error;
    return null;
  }
}

function getLinuxCmdlineSync(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replace(/\0/g, ' ').trim();
  } catch {
    return null;
  }
}

function getLinuxCmdlineBounded(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replace(/\0/g, ' ').trim();
  } catch {
    return null;
  }
}

function getCmdlineSync(pid) {
  return getWindowsCmdlineSync(pid) || getLinuxCmdlineSync(pid);
}

async function getCmdlineBounded(pid, timeoutMs) {
  const windows = await getWindowsCmdlineBounded(pid, timeoutMs).catch((error) => {
    if (error?.code === 'TIMEOUT') throw error;
    return null;
  });
  if (windows) return windows;
  return getLinuxCmdlineBounded(pid);
}

export function findCdpListenerPid(cdpUrl) {
  return findWindowsListenerPidSync(parseCdpPort(cdpUrl)) || findLinuxListenerPidSync(parseCdpPort(cdpUrl));
}

async function findCdpListenerPidBounded(cdpUrl, timeoutMs) {
  const port = parseCdpPort(cdpUrl);
  const windows = await findWindowsListenerPidBounded(port, timeoutMs).catch((error) => {
    if (error?.code === 'TIMEOUT') throw error;
    return null;
  });
  if (windows) return windows;
  return await findLinuxListenerPidBounded(port, timeoutMs);
}

function remainingMs(deadlineMs) {
  return Math.max(0, deadlineMs - Date.now());
}

/** True when the CDP HTTP endpoint responds (listener up, owner may still be unknown). */
export async function isCdpReachable(cdpUrl, options = {}) {
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    const err = new Error('cdp_reachability_timeout');
    err.name = 'CdpReachabilityTimeoutError';
    throw err;
  }
  if (__testOwnerProbe.stallFetch) {
    await new Promise((_, reject) => {
      const wait = timeoutMs ?? 30_000;
      setTimeout(() => {
        const err = new Error('cdp_reachability_timeout');
        err.name = 'CdpReachabilityTimeoutError';
        reject(err);
      }, wait);
    });
  }
  const controller = new AbortController();
  let timeoutId;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const base = String(cdpUrl).replace(/\/$/, '');
    const res = await fetch(`${base}/json/version`, { signal: controller.signal });
    return res.ok;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      const err = new Error('cdp_reachability_timeout');
      err.name = 'CdpReachabilityTimeoutError';
      throw err;
    }
    return false;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function ownerStatePath(port) {
  return join(homedir(), '.local/state/discuss-with-gpt', `cdp-${port}-owner.json`);
}

export function recordCdpOwner(cdpUrl, profile) {
  const port = parseCdpPort(cdpUrl);
  const path = ownerStatePath(port);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      port,
      profile: normalizeProfilePath(profile),
      recordedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

/**
 * @returns {{ ok: true } | { ok: false, reason: 'not_listening'|'uninspectable'|'no_user_data_dir'|'profile_mismatch', message: string }}
 */
export function verifyCdpProfile({ cdp = 'http://localhost:9222', profile }) {
  if (!profile) {
    return { ok: false, reason: 'uninspectable', message: 'profile path required' };
  }
  const port = parseCdpPort(cdp);
  const pid = findCdpListenerPid(cdp);
  if (!pid) {
    return {
      ok: false,
      reason: 'not_listening',
      message: `no process listening on CDP port :${port}`,
    };
  }
  const cmdline = getCmdlineSync(pid);
  if (!cmdline) {
    return {
      ok: false,
      reason: 'uninspectable',
      message: `cannot read command line for PID ${pid} on :${port}`,
    };
  }
  const actualDir = extractUserDataDir(cmdline);
  if (!actualDir) {
    return {
      ok: false,
      reason: 'no_user_data_dir',
      message: `process on :${port} (PID ${pid}) has no --user-data-dir`,
    };
  }
  const expected = normalizeProfilePath(profile);
  const actual = normalizeProfilePath(actualDir);
  if (expected !== actual) {
    return {
      ok: false,
      reason: 'profile_mismatch',
      message:
        `:${port} is owned by profile "${actualDir}", not configured "${profile}"` +
        ' — close the foreign Chrome or fix DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR',
    };
  }
  recordCdpOwner(cdp, profile);
  return { ok: true };
}

/**
 * Caller-bounded owner inspection for tracked browser turns.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, message: string, timedOut?: boolean }>}
 */
export async function verifyCdpProfileBounded({ cdp = 'http://localhost:9222', profile, timeoutMs }) {
  if (!profile) {
    return { ok: false, reason: 'uninspectable', message: 'profile path required' };
  }
  if (!timeoutMs || timeoutMs <= 0) {
    return { ok: false, reason: 'uninspectable', message: 'owner_probe_timeout', timedOut: true };
  }
  const deadlineMs = Date.now() + timeoutMs;
  try {
    const port = parseCdpPort(cdp);
    const pidBudget = remainingMs(deadlineMs);
    if (pidBudget <= 0) {
      return { ok: false, reason: 'uninspectable', message: 'owner_probe_timeout', timedOut: true };
    }
    const pid = await findCdpListenerPidBounded(cdp, pidBudget);
    if (!pid) {
      return {
        ok: false,
        reason: 'not_listening',
        message: `no process listening on CDP port :${port}`,
      };
    }
    const cmdBudget = remainingMs(deadlineMs);
    if (cmdBudget <= 0) {
      return { ok: false, reason: 'uninspectable', message: 'owner_probe_timeout', timedOut: true };
    }
    const cmdline = await getCmdlineBounded(pid, cmdBudget);
    if (!cmdline) {
      return {
        ok: false,
        reason: 'uninspectable',
        message: `cannot read command line for PID ${pid} on :${port}`,
      };
    }
    const actualDir = extractUserDataDir(cmdline);
    if (!actualDir) {
      return {
        ok: false,
        reason: 'no_user_data_dir',
        message: `process on :${port} (PID ${pid}) has no --user-data-dir`,
      };
    }
    const expected = normalizeProfilePath(profile);
    const actual = normalizeProfilePath(actualDir);
    if (expected !== actual) {
      return {
        ok: false,
        reason: 'profile_mismatch',
        message:
          `:${port} is owned by profile "${actualDir}", not configured "${profile}"` +
          ' — close the foreign Chrome or fix DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR',
      };
    }
    recordCdpOwner(cdp, profile);
    return { ok: true };
  } catch (error) {
    if (error?.code === 'TIMEOUT' || error?.message === 'owner_probe_timeout') {
      return { ok: false, reason: 'uninspectable', message: 'owner_probe_timeout', timedOut: true };
    }
    throw error;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const mode = args[0];
  const get = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : def;
  };
  const cdp = get('--cdp', 'http://localhost:9222');
  const expectedProfile = get('--profile');

  if (mode === 'verify') {
    const result = verifyCdpProfile({ cdp, profile: expectedProfile });
    if (!result.ok) {
      console.error(`discuss-with-gpt: ${result.message} — refuse to reuse`);
      const code = result.reason === 'profile_mismatch' ? 1 : 2;
      process.exit(code);
    }
  } else if (mode === 'record') {
    if (!expectedProfile) {
      console.error('USAGE: verify-cdp-owner.mjs record --profile <path> [--cdp url]');
      process.exit(64);
    }
    recordCdpOwner(cdp, expectedProfile);
  } else {
    console.error('USAGE: verify-cdp-owner.mjs verify|record --profile <path> [--cdp url]');
    process.exit(64);
  }
}
