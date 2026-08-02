import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contract = readFileSync(new URL('../.claude/skills/create-issue-draft/SKILL.md', import.meta.url), 'utf8');
const authorityStart = contract.indexOf('## Flow-manager authority and bounded terminal outcomes — Issue #1197');
const authorityEnd = contract.indexOf('## Mechanical parity edits', authorityStart);
const authority = authorityStart >= 0 && authorityEnd > authorityStart
  ? contract.slice(authorityStart, authorityEnd)
  : '';

describe('Issue #1197 flow-manager authority contract', () => {
  it('defines a closed self-authorized action list and explicit prohibitions', () => {
    expect(authority).toContain('### Closed self-authorized actions');
    expect(authority).toContain('Repair mechanical');
    expect(authority).toContain('Verify evidence');
    expect(authority).toContain('Retry only');
    expect(authority).toContain('Publish a bounded exception');
    expect(authority).toContain('must not author or rewrite substantive Issue content');
    expect(authority).toContain('choose\na finding disposition');
    expect(authority).toContain('resend after\npossible delivery');
    expect(authority).toContain('expand frozen scope');
  });

  it('contains exactly the three operator-only escalation classes', () => {
    expect(authority).toContain('business-contract-change');
    expect(authority).toContain('material-reviewer-conflict');
    expect(authority).toContain('terminal-infrastructure-refusal');
    expect(authority).toContain('There are exactly three operator-only escalation classes');
    expect(authority).not.toContain('Two non-converging author-fix cycles escalate to the operator.');
  });

  it('enumerates every bounded wait with authoritative evidence and terminal mapping', () => {
    for (const waitId of ['WI-01', 'WI-02', 'WI-03', 'WI-04', 'WI-05', 'WI-06']) {
      expect(authority).toContain(waitId);
    }
    expect(authority).toContain('Exact declared deadline');
    expect(authority).toContain('time basis');
    expect(authority).toContain('visible deadline-miss metadata');
    expect(authority).toContain('undeclared wait');
    expect(authority).toContain('done');
    expect(authority).toContain('blocked');
    expect(authority).toContain('refused');
  });

  it('requires complete published exceptions and producer-backed gates', () => {
    expect(authority).toContain('independently proven infeasible');
    expect(authority).toContain('underlying business invariant is already proven');
    expect(authority).toContain('required audience');
    expect(authority).toContain('visibility proof');
    expect(authority).toContain('existing authority basis');
    expect(authority).toContain('acceptance evidence');
    expect(authority).toContain('material\nreview evidence');
    expect(authority).toContain('Every new gate');
    expect(authority).toContain('missing producer');
    expect(authority).toContain('orchestrator-only remedy is forbidden');
  });

  it('classifies the complete scenario matrix without hidden recovery machinery', () => {
    for (const scenario of [
      'normal completion',
      'mechanical repair',
      'missing producer',
      'legal retry',
      'post-send ambiguity',
      'deadline expiry',
      'published exception',
      'business-contract change',
      'material reviewer conflict',
      'terminal infrastructure refusal',
      'no legal action',
      'premature stage transition',
      'ambiguous authority',
      'two non-converging author-fix cycles',
    ]) {
      expect(authority).toContain(scenario);
    }
    expect(authority).toContain('add a lease');
    expect(authority).toContain('heartbeat');
    expect(authority).toContain('service');
    expect(authority).toContain('durable store');
  });
});
