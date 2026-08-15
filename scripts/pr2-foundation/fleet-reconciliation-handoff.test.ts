import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publishFleetReconciliationHandoff,
  readFleetReconciliationHandoff,
} from './fleet-reconciliation-handoff.ts';

const roots: string[] = [];
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function file(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1420-handoff-'));
  roots.push(root);
  return path.join(root, 'latest.json');
}

describe('fleet reconciliation handoff', () => {
  it('survives producer lifetime and contains persistence-safe facts only', () => {
    const target = file();
    const published = publishFleetReconciliationHandoff({
      file: target,
      repository: 'chetwerikoff/orchestrator-pack',
      activationLineage: 'al-deadbeef',
      schedulerGeneration: 'sg-generation',
      tickSequence: 3,
      reason: 'target_unresolved',
      role: 'worker',
      issueNumber: 1420,
      taskId: 'task_1',
      assignmentId: 'wa-safe',
      assignmentGeneration: 2,
    });
    expect(published.ok).toBe(true);
    expect(readFleetReconciliationHandoff(target)).toMatchObject({
      decision: 'orchestrator_required',
      reason: 'target_unresolved',
      issueNumber: 1420,
      assignmentGeneration: 2,
    });
    const bytes = readFileSync(target, 'utf8');
    expect(bytes).not.toMatch(/runtimeWorkerIdentity|observationToken|terminalOutput|prompt|reply|workspacePath|pid/i);
  });

  it('fails closed when the destination cannot be committed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'opk-1420-handoff-dir-'));
    roots.push(root);
    const published = publishFleetReconciliationHandoff({
      file: root,
      repository: 'chetwerikoff/orchestrator-pack',
      activationLineage: 'al-deadbeef',
      schedulerGeneration: 'sg-generation',
      tickSequence: 1,
      reason: 'effect_untrusted',
    });
    expect(published.ok).toBe(false);
  });
});
