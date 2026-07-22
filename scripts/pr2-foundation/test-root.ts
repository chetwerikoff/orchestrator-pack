import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TestRootRegistry {
  create(prefix: string): string;
  cleanup(): void;
}

export function createTestRootRegistry(): TestRootRegistry {
  const roots: string[] = [];
  return {
    create(prefix: string): string {
      const root = mkdtempSync(path.join(tmpdir(), prefix));
      roots.push(root);
      return root;
    },
    cleanup(): void {
      for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
