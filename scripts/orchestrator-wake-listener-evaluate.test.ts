import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(import.meta.dirname, '..');

describe('wake listener retirement tombstone (Issue #745 PR-B)', () => {
  it('keeps the retired listener entrypoint and registry binding absent', () => {
    const listenerPath = path.join(repoRoot, 'scripts/orchestrator-wake-listener.ps1');
    const registryPath = path.join(repoRoot, 'scripts/orchestrator-side-process-registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      requiredChildIds: string[];
      children: Array<{ id: string; script: string; sideEffectLockFile?: string }>;
    };

    expect(existsSync(listenerPath)).toBe(false);
    expect(registry.requiredChildIds).not.toContain('listener');
    expect(registry.children.some((child) => child.id === 'listener')).toBe(false);
    expect(registry.children.some((child) => child.script === 'orchestrator-wake-listener.ps1')).toBe(false);
    expect(registry.children.some((child) => child.sideEffectLockFile === 'listener-side-effect.lock')).toBe(false);
  });
});
