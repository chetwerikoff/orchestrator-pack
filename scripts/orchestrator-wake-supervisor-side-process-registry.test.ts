import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEntry, childRegistry } from './lib/orchestrator-side-process-observer.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

describe('Issue #948 pruned side-process registry observer', () => {
  it('lists exactly the three retained starter children', () => {
    const registryPath = path.join(repoRoot, 'scripts/orchestrator-side-process-registry.json');
    const doc = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
      requiredChildIds: string[];
      children: { id: string; script: string }[];
    };
    const observed = childRegistry();
    expect(observed.map((child) => child.Id)).toEqual(doc.requiredChildIds);
    expect(doc.children.map((child) => child.id)).toEqual(doc.requiredChildIds);
    for (const child of doc.children) {
      expect(fs.existsSync(path.join(repoRoot, 'scripts', child.script))).toBe(true);
      expect(childEntry(child.id)?.ScriptMarker).toBe(child.script);
    }
  });
});
