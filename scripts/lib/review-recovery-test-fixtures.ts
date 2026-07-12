import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roots: string[] = [];

export function trackTempRoot(root: string) {
  roots.push(root);
}

export function drainTempRoots(onRoot: (root: string) => void) {
  for (const root of roots.splice(0)) onRoot(root);
}

export function tempRecoveryStore() {
  const root = mkdtempSync(join(tmpdir(), 'review-run-recovery-'));
  trackTempRoot(root);
  mkdirSync(join(root, 'runs'), { recursive: true });
  return root;
}

export function writeRecoveryRun(store: string, patch: Record<string, unknown> = {}) {
  const run = {
    id: `review-run-${patch.idSuffix ?? 'a'}`,
    projectId: 'orchestrator-pack',
    linkedSessionId: 'opk-worker',
    reviewerSessionId: 'opk-rev-a',
    status: 'running',
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    startedAt: '2026-06-13T00:00:00.000Z',
    targetSha: 'abc123',
    prNumber: 287,
    summary: 'fixture',
    ...patch,
  };
  delete (run as Record<string, unknown>).idSuffix;
  const path = join(store, 'runs', `${run.id}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  return { run, path };
}

export function readRecoveryRun(store: string, id = 'review-run-a') {
  return JSON.parse(readFileSync(join(store, 'runs', `${id}.json`), 'utf8'));
}

export function readRecoveryAudit(store: string) {
  const livenessAudit = join(store, 'review-run-liveness-audit.json');
  const recoveryAudit = join(store, 'review-run-recovery-audit.json');
  const path = existsSync(livenessAudit) ? livenessAudit : recoveryAudit;
  return JSON.parse(readFileSync(path, 'utf8'));
}
