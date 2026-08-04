import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('review-trigger reconciliation after PR2 cutover', () => {
  it('keeps the terminalized PowerShell reconciler absent', () => {
    expect(existsSync(path.resolve('scripts/review-trigger-reconcile.ps1'))).toBe(false);
  });

  it('routes the active child topology through the Node scheduler only', () => {
    const registry = JSON.parse(readFileSync(
      path.resolve('scripts/orchestrator-side-process-registry.json'),
      'utf8',
    )) as { children?: Array<{ id?: string; runtime?: string; script?: string }> };
    expect(registry.children).toEqual([
      expect.objectContaining({
        id: 'pr2-scheduler',
        runtime: 'node',
        script: 'pr2-foundation/scheduler.ts',
      }),
    ]);
  });
});
