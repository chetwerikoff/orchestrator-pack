import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './_test-pwsh-helpers.js';

export const MINIMAL_REGISTRY_TREE_PATHS = [
  'scripts/orchestrator-message-taxonomy.json',
  'scripts/orchestrator-message-owner-mechanisms.manifest.json',
  'scripts/orchestrator-message-send-helpers.manifest.json',
  'scripts/orchestrator-message-audit-roots.manifest.json',
  'scripts/orchestrator-message-protected-runtime.manifest.json',
  'scripts/orchestrator-message-allowlist.json',
  'scripts/orchestrator-side-process-registry.json',
  'scripts/orchestrator-message-catalog.json',
  'docs/orchestrator-message-registry.mjs',
] as const;

export function copyRegistryTreeFile(destRoot: string, rel: string) {
  const dest = path.join(destRoot, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(repoRoot, rel), dest);
}

export function seedMinimalRegistryTree(destRoot: string, extraPaths: string[] = []) {
  for (const rel of [...MINIMAL_REGISTRY_TREE_PATHS, ...extraPaths]) {
    copyRegistryTreeFile(destRoot, rel);
  }
}
