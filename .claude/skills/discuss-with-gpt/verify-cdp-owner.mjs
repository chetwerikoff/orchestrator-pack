// Verify the process listening on a CDP port was launched with the expected
// --user-data-dir before discuss-with-gpt reuses an existing Chrome session.
//
// Usage:
//   node verify-cdp-owner.mjs verify --profile <user-data-dir> [--cdp url]
//   node verify-cdp-owner.mjs record --profile <user-data-dir> [--cdp url]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function findWindowsListenerPid(port) {
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

function findLinuxListenerPid(port) {
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

function getWindowsCmdline(pid) {
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

function getLinuxCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replace(/\0/g, ' ').trim();
  } catch {
    return null;
  }
}

export function findCdpListenerPid(cdpUrl) {
  return findWindowsListenerPid(parseCdpPort(cdpUrl)) || findLinuxListenerPid(parseCdpPort(cdpUrl));
}

function getCmdline(pid) {
  return getWindowsCmdline(pid) || getLinuxCmdline(pid);
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
  const cmdline = getCmdline(pid);
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
