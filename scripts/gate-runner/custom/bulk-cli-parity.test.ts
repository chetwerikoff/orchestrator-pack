import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCensus } from '../census.ts';
import { formatGateRunnerReport, runGateRunner } from '../runner.ts';

interface Capture {
  readonly gateId: string;
  readonly legacyScript: string;
  readonly sourceBlobSha: string;
  readonly case: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly expectedRunnerStdout?: string;
  readonly parityDisposition?: string;
  readonly artifacts: readonly string[];
}

interface CaptureManifest {
  readonly version: number;
  readonly issue: number;
  readonly baseCommitSha: string;
  readonly captures: readonly Capture[];
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const wave3a = JSON.parse(readFileSync(resolve(import.meta.dirname, '../goldens/pre-delete-captures.json'), 'utf8')) as CaptureManifest;
const wave3b = JSON.parse(readFileSync(resolve(import.meta.dirname, '../goldens/wave-3b-pre-delete-captures.json'), 'utf8')) as CaptureManifest;

function capturesByScript(): Map<string, Capture[]> {
  const result = new Map<string, Capture[]>();
  for (const capture of [...wave3a.captures, ...wave3b.captures]) {
    const values = result.get(capture.legacyScript) ?? [];
    values.push(capture);
    result.set(capture.legacyScript, values);
  }
  return result;
}

describe('Wave 3.b per-entrypoint CLI parity', () => {
  it('binds every ported standalone PowerShell gate to a pre-delete capture', () => {
    expect(wave3b.version).toBe(1);
    expect(wave3b.issue).toBe(841);
    expect(wave3b.baseCommitSha).toBe('0e8846b1e7caf063d73792700968971d75e0524f');
    const byScript = capturesByScript();
    const census = loadCensus(repoRoot);
    for (const entry of census.entries) {
      if (entry.sourceKind !== 'check-script' || !entry.classification.startsWith('ported-')) continue;
      const captures = byScript.get(entry.sourcePath) ?? [];
      expect(captures.length, entry.sourcePath).toBeGreaterThan(0);
      for (const gateId of entry.gateIds ?? []) {
        expect(captures.some((capture) => capture.gateId === gateId), `${entry.sourcePath} -> ${gateId}`).toBe(true);
      }
    }
  });

  it('preserves exit class, gate stdout, and runner report semantics for every Wave 3.b capture', () => {
    expect(wave3b.captures.every((capture) => capture.exitCode === 0)).toBe(true);
    const report = runGateRunner(repoRoot, wave3b.captures.map((capture) => capture.gateId));
    const formatted = formatGateRunnerReport(report);
    expect(report.aggregate.exitCode).toBe(0);

    for (const capture of wave3b.captures) {
      expect(capture.argv.slice(0, 4)).toEqual(['pwsh', '-NoProfile', '-File', capture.legacyScript]);
      expect(capture.sourceBlobSha).toMatch(/^[0-9a-f]{40}$/u);
      expect(capture.artifacts).toEqual([]);
      const expectedStdout = capture.expectedRunnerStdout ?? capture.stdout;
      if (expectedStdout !== capture.stdout) expect(capture.parityDisposition?.length).toBeGreaterThan(20);

      const result = report.results.find((candidate) => candidate.gateId === capture.gateId);
      expect(result?.status, capture.gateId).toBe('PASS');
      expect(result?.legacyStdout, capture.gateId).toBe(expectedStdout);
      expect(formatted, capture.gateId).toContain(expectedStdout.trimEnd());
      expect(formatted, capture.gateId).toContain(`[${result!.status}] ${capture.gateId}:`);
    }
    expect(formatted).toContain('exit=0');
  });
});
