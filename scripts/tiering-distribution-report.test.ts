import { describe, expect, it } from 'vitest';
import { analyzeDistribution, classifyAuthoredIssue, formatDistribution, type IssueBodyRecord } from './tiering-distribution-report.ts';

function issue(number: number, tier: 'T1' | 'T2' | 'T3', behavior: 'record-only' | 'action-producing' = 'action-producing'): IssueBodyRecord {
  return { number, body: `\`\`\`behavior-kind\n${behavior}\n\`\`\`\n\n\`\`\`complexity-tier\ntier: ${tier}\nadvisory-prior: ${tier}\n\`\`\`` };
}

describe('Issue #1142 read-only tier distribution report', () => {
  it('reports the audited 27/30 claimed-T3 fixture at 90% and alarms', () => {
    const fixture = Array.from({ length: 30 }, (_, index) => issue(1030 + index, index < 27 ? 'T3' : 'T2', index === 0 ? 'record-only' : 'action-producing'));
    const result = analyzeDistribution(fixture);
    expect(result.claimedT3).toBe(27);
    expect(result.claimedT3Share).toBe(0.9);
    expect(result.alarms).toContain('claimed-T3-above-70-percent');
    expect(result.alarms).toContain('record-only-at-T3');
    expect(formatDistribution(result)).toContain('27/30 (90%)');
    expect(formatDistribution(result)).toContain('unverified-diagnostic');
  });

  it('exits cleanly at or below 70% with no record-only T3, independent of body deltas', () => {
    const fixture = Array.from({ length: 30 }, (_, index) => issue(2000 + index, index < 21 ? 'T3' : 'T2'));
    expect(analyzeDistribution(fixture).alarms).toEqual([]);
  });

  it('alarms on incomplete/ambiguous window and excludes pull requests', () => {
    const fixture = Array.from({ length: 29 }, (_, index) => issue(3000 + index, 'T2'));
    fixture.push({ ...issue(4000, 'T3'), pull_request: { url: 'x' } });
    expect(analyzeDistribution(fixture).alarms).toContain('incomplete-or-ambiguous-window');

    const duplicate = [...Array.from({ length: 30 }, (_, index) => issue(5000 + index, 'T2')), issue(5000, 'T2')];
    expect(analyzeDistribution(duplicate).alarms).toContain('incomplete-or-ambiguous-window');
  });

  it('requires canonical behavior and parseable tier declarations', () => {
    expect(classifyAuthoredIssue({ number: 1, body: 'no fences' })).toBeNull();
    expect(classifyAuthoredIssue(issue(2, 'T2'))).toMatchObject({ number: 2, claimedTier: 'T2' });
  });
});
