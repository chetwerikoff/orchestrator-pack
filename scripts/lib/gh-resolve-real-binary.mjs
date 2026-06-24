#!/usr/bin/env node
/**
 * Resolve the real gh binary, skipping pack scripts/gh (recursion guard).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACK_SCRIPTS_DIR = resolve(__dirname, '..');
export const PACK_ROOT = resolve(PACK_SCRIPTS_DIR, '..');
export const WRAPPER_PATH = join(PACK_SCRIPTS_DIR, 'gh');

function isExecutable(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
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

function resolvePathCandidate(candidate, wrapperRealPath) {
  if (!candidate || candidate === 'gh') {
    return null;
  }
  const resolved = resolve(candidate);
  if (isExecutable(resolved) && resolved !== wrapperRealPath) {
    return resolved;
  }
  return null;
}

/**
 * @param {string} [wrapperRealPath]
 * @returns {string}
 */
export function resolveRealGhBinary(wrapperRealPath = resolve(WRAPPER_PATH)) {
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
    if (!dir || resolve(dir) === resolve(PACK_SCRIPTS_DIR)) {
      continue;
    }
    const candidate = join(dir, 'gh');
    if (!isExecutable(candidate)) {
      continue;
    }
    const resolved = resolve(candidate);
    if (resolved !== wrapperRealPath) {
      return resolved;
    }
  }

  for (const fallback of ['/usr/bin/gh', '/usr/local/bin/gh']) {
    if (isExecutable(fallback) && resolve(fallback) !== wrapperRealPath) {
      return fallback;
    }
  }

  return 'gh';
}
