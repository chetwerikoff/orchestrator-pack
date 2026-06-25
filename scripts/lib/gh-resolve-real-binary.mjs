#!/usr/bin/env node
/**
 * Resolve the real gh binary — identity-based terminality (Issue #442).
 * Delegates only to native gh executables, never shell/node wrapper shims.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACK_SCRIPTS_DIR = resolve(__dirname, '..');
export const PACK_ROOT = resolve(PACK_SCRIPTS_DIR, '..');
export const WRAPPER_PATH = join(PACK_SCRIPTS_DIR, 'gh');

/** Max non-native gh candidates on PATH before fail-closed (defense-in-depth). */
export const MAX_NON_NATIVE_GH_CANDIDATES = 64;

function maxNonNativeBudget() {
  const override = process.env.GH_RESOLVE_MAX_NON_NATIVE;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return MAX_NON_NATIVE_GH_CANDIDATES;
}

const SYSTEM_FALLBACKS = ['/usr/bin/gh', '/usr/local/bin/gh'];

function isExecutable(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * True when path is a native gh executable (ELF/Mach-O/PE), not a script shim.
 * @param {string} path
 */
export function isNativeGhExecutable(path) {
  if (!isExecutable(path)) {
    return false;
  }
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 2) {
      return false;
    }
    // Reject shebang scripts (bash/node wrappers re-enter PATH dispatch).
    if (buf[0] === 0x23 && buf[1] === 0x21) {
      return false;
    }
    if (bytesRead >= 4) {
      // ELF (Linux and many Unix gh builds)
      if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
        return true;
      }
      // Mach-O (macOS): 32/64-bit LE/BE and universal fat headers
      const le32 = buf[0] === 0xce && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe;
      const le64 = buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe;
      const be32 = buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && buf[3] === 0xce;
      const be64 = buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && buf[3] === 0xcf;
      const fat = buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe;
      const fatRev = buf[0] === 0xbe && buf[1] === 0xba && buf[2] === 0xfe && buf[3] === 0xca;
      if (le32 || le64 || be32 || be64 || fat || fatRev) {
        return true;
      }
    }
    // PE (Windows)
    if (buf[0] === 0x4d && buf[1] === 0x5a) {
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function readAutonomousConfig() {
  const configPath = join(PACK_ROOT, '.ao', 'autonomous-real-binaries.json');
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} candidate
 * @param {string} wrapperRealPath
 * @returns {string | null}
 */
function resolvePathCandidate(candidate, wrapperRealPath) {
  if (!candidate || candidate === 'gh') {
    return null;
  }
  const resolved = resolve(candidate);
  if (resolved === wrapperRealPath) {
    return null;
  }
  if (isNativeGhExecutable(resolved)) {
    return resolved;
  }
  return null;
}

/**
 * @param {string} candidate
 * @param {string} wrapperRealPath
 * @param {{ nonNativeCount: number }} stats
 * @returns {string | null}
 */
function acceptNativeCandidate(candidate, wrapperRealPath, stats) {
  const resolved = resolve(candidate);
  if (resolved === wrapperRealPath) {
    return null;
  }
  if (isNativeGhExecutable(resolved)) {
    return resolved;
  }
  stats.nonNativeCount += 1;
  if (stats.nonNativeCount >= maxNonNativeBudget()) {
    throw new Error(
      `gh-resolve-real-binary: wrapper hop budget exceeded (${stats.nonNativeCount} non-native gh candidates on PATH)`,
    );
  }
  return null;
}

/**
 * @param {string} [wrapperRealPath]
 * @returns {string}
 */
export function resolveRealGhBinary(wrapperRealPath = resolve(WRAPPER_PATH)) {
  const stats = { nonNativeCount: 0 };

  const config = readAutonomousConfig();
  if (config?.gh) {
    const fromConfig = resolvePathCandidate(config.gh, wrapperRealPath);
    if (fromConfig) {
      return fromConfig;
    }
  }

  const envBinary = process.env.GH_REAL_BINARY;
  if (envBinary && envBinary !== 'gh') {
    const fromEnv = resolvePathCandidate(envBinary, wrapperRealPath);
    if (fromEnv) {
      return fromEnv;
    }
  }

  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, 'gh');
    if (!isExecutable(candidate)) {
      continue;
    }
    const native = acceptNativeCandidate(candidate, wrapperRealPath, stats);
    if (native) {
      return native;
    }
  }

  for (const fallback of SYSTEM_FALLBACKS) {
    const native = acceptNativeCandidate(fallback, wrapperRealPath, stats);
    if (native) {
      return native;
    }
  }

  throw new Error(
    `gh-resolve-real-binary: no native gh executable found (skipped ${stats.nonNativeCount} non-native candidate(s))`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    console.log(resolveRealGhBinary());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
