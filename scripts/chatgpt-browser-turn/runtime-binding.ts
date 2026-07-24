import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityBinding } from './state.ts';
import { sha256 } from './storage-common.ts';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = dirname(MODULE_DIR);
const REPO_ROOT = dirname(SCRIPTS_DIR);
const CDP_OWNER_VERIFIER = join(REPO_ROOT, '.claude', 'skills', 'discuss-with-gpt', 'verify-cdp-owner.mjs');

function digestFiles(paths: readonly string[]): string {
  const parts: Buffer[] = [];
  for (const path of [...paths].sort()) {
    const identity = relative(REPO_ROOT, path).replaceAll('\\', '/');
    parts.push(Buffer.from(`${identity}\0`, 'utf8'));
    parts.push(readFileSync(path));
    parts.push(Buffer.from('\0', 'utf8'));
  }
  return sha256(Buffer.concat(parts));
}

function runtimeFiles(): string[] {
  const modules = readdirSync(MODULE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(MODULE_DIR, name));
  return [join(SCRIPTS_DIR, 'chatgpt-browser-turn.ts'), ...modules, CDP_OWNER_VERIFIER];
}

export function candidateDigest(): string {
  return digestFiles(runtimeFiles());
}

export function buildDigest(): string {
  return sha256(`${candidateDigest()}\nnode:${process.versions.node}\nplatform:${process.platform}\narch:${process.arch}\nstrip-types`);
}

export function gateDigest(): string {
  const testPaths = [
    join(SCRIPTS_DIR, 'toolchain', 'chatgpt-browser-turn.test.ts'),
    join(SCRIPTS_DIR, 'toolchain', 'chatgpt-browser-turn.review-fixes.test.ts'),
  ];
  let testDigest = 'test-not-present';
  try {
    testDigest = digestFiles(testPaths);
  } catch {
    // A retained recovery copy does not require Gate-B source files.
  }
  return sha256(`${candidateDigest()}\n${testDigest}\nissue-964-gate-b-v1`);
}

export function runtimeCapabilityBinding(profileKey: string, cdp: string): CapabilityBinding {
  const endpoint = new URL(cdp);
  endpoint.hash = '';
  endpoint.search = '';
  return {
    candidate_digest: candidateDigest(),
    build_digest: buildDigest(),
    config_digest: sha256(`${profileKey}\n${endpoint.toString().replace(/\/$/, '').toLowerCase()}`),
    gate_digest: gateDigest(),
  };
}
