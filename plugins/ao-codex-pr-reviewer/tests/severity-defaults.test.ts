import { describe, expect, it } from 'vitest';
import { toAoFindings } from '../lib/emit.js';
import { parseCodexReviewOutput } from '../lib/review_jsonl.js';
import type { StructuredFinding } from '../lib/types.js';

function finding(severity: string): StructuredFinding {
  return {
    type: 'quality',
    code: 'quality:severity-default',
    severity,
    path: null,
    summary: 'Severity default',
    details: 'Exercises the producer default branch.',
    source: 'codex-local',
  };
}

describe('review finding severity defaults (Issue #866)', () => {
  it('fails closed to error for any unrecognized structured severity', () => {
    // Unknown and future producer values stay blocking across every producer path.
    expect(toAoFindings([finding('unexpected')])[0]?.severity).toBe('error');
  });

  it('fails closed to blocking when JSONL omits priority and a title bracket', () => {
    const parsed = parseCodexReviewOutput({
      findings: [{
        title: 'Finding without priority',
        body: 'No numeric priority and no [Pn] title prefix are present.',
      }],
      overall_correctness: 'patch is incorrect',
    }, 'codex-local', process.cwd());
    expect(parsed.kind).toBe('findings');
    if (parsed.kind !== 'findings') throw new Error('expected parsed findings');
    expect(parsed.findings[0]?.severity).toBe('blocking');
    expect(toAoFindings(parsed.findings)[0]?.severity).toBe('error');
  });
});
