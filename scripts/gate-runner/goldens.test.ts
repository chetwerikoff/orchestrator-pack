import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGateRunner } from './runner.ts';

interface Capture {
  gateId: string;
  legacyScript: string;
  sourceBlobSha: string;
  case: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  artifacts: string[];
}

const repoRoot = resolve(import.meta.dirname, '../..');
const golden = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'goldens/pre-delete-captures.json'), 'utf8'),
) as { version: number; baseCommitSha: string; captures: Capture[] };

describe('pre-delete legacy captures', () => {
  it('binds every representative deleted gate to argv, exit, stdout, artifacts, and source identity', () => {
    expect(golden.version).toBe(1);
    expect(golden.baseCommitSha).toBe('b7394065b9ee1b046abb4cf29aff456df1935571');
    expect(new Set(golden.captures.map((capture) => capture.legacyScript))).toEqual(new Set([
      'scripts/check-agent-rules-grep-inventory.ps1',
      'scripts/check-agent-rules-line-budget.ps1',
      'scripts/check-agent-rules-moved-content.ps1',
      'scripts/check-vestigial-fleet-children-retired.ps1',
    ]));
    for (const capture of golden.captures) {
      expect(capture.argv.length).toBeGreaterThan(3);
      expect(capture.sourceBlobSha).toMatch(/^[0-9a-f]{40}$/u);
      expect([0, 1]).toContain(capture.exitCode);
      expect(capture.stdout.endsWith('\n')).toBe(true);
      expect(Array.isArray(capture.artifacts)).toBe(true);
    }
  });

  it('keeps real-tree PASS stdout byte-compatible with positive captures', () => {
    const report = runGateRunner(repoRoot);
    const positives = golden.captures.filter((capture) => capture.case === 'real-clean-tree');
    for (const capture of positives) {
      const result = report.results.find((candidate) => candidate.gateId === capture.gateId);
      expect(result?.status, capture.gateId).toBe('PASS');
      expect(result?.legacyStdout, capture.gateId).toBe(capture.stdout);
    }
  });
});
