import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendSanctionedWorkerKillRecord,
  readSanctionedWorkerKillSurface,
} from './sanctioned-worker-kill-record.ts';

const repoRoot = process.cwd();
const golden = readFileSync(
  join(repoRoot, 'tests/external-output-references/variants/opk-json-producers/sanctioned-worker-kill-record/single.json'),
);

describe('sanctioned worker kill JSON producer', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('emits a single-entry surface byte-identical to the committed baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-831-sanctioned-'));
    roots.push(root);
    const path = join(root, 'surface.json');
    const result = appendSanctionedWorkerKillRecord(path, {
      sessionId: 'opk-831-worker',
      issueNumber: 831,
      prNumber: 832,
      killKind: 'manual',
      timestampMs: 1_784_102_400_000,
    });
    expect(result.healthy).toBe(true);
    expect(readFileSync(path)).toEqual(golden);
  });

  it('accepts the legacy bare-array shape and rewrites the authoritative object shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-831-sanctioned-'));
    roots.push(root);
    const path = join(root, 'surface.json');
    writeFileSync(path, '[{"sessionId":"old","issueNumber":1,"prNumber":0,"killKind":"manual","timestampMs":1}]\n');
    appendSanctionedWorkerKillRecord(path, {
      sessionId: 'new', issueNumber: 2, prNumber: 0, killKind: 'reconcile', timestampMs: 2,
    });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { records: unknown[] };
    expect(parsed.records).toHaveLength(2);
    expect(readSanctionedWorkerKillSurface(path).healthy).toBe(true);
  });

  it('fails closed on unreadable JSON rather than blessing an empty replacement', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-831-sanctioned-'));
    roots.push(root);
    const path = join(root, 'surface.json');
    writeFileSync(path, '{bad');
    expect(() => appendSanctionedWorkerKillRecord(path, { sessionId: 'x' })).toThrow(/Unexpected token|JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{bad');
  });
});
