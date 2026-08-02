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
    const expected = [
      'business-contract-change',
      'material-reviewer-conflict',
      'terminal-infrastructure-refusal',
    ];
    const classes = authority.match(/^operator-only-escalation-classes: (.+)$/m)?.[1]
      .split(', ')
      .filter(Boolean);
    expect(classes).toEqual(expected);
    expect(classes).toHaveLength(3);
    expect(authority).toContain('There are exactly three operator-only escalation classes');
    expect(authority).not.toContain('Two non-converging author-fix cycles escalate to the operator.');
  });

  it('enumerates every bounded wait with authoritative evidence and terminal mapping', () => {
    for (const waitId of ['WI-01', 'WI-02', 'WI-03', 'WI-04', 'WI-05', 'WI-06']) {
      expect(authority).toContain(waitId);
    }
    const expectedRows = [
      ['WI-01', '1_800_000 ms', 'owner: named producer'],
      ['WI-02', '10_000 ms', 'owner: page-probe'],
      ['WI-03', '1_800_000 ms', 'owner: preceding stage producer'],
      ['WI-04', '1_800_000 ms', 'owner: reviewer source'],
      ['WI-05', '5_000 ms', 'owner: launcher waiter'],
      ['WI-06', 'inherited from the enclosing stage deadline', 'owner: exception publisher'],
    ];
    for (const [waitId, deadline, owner] of expectedRows) {
      const row = authority.split('\n').find((line) => line.includes(`\`${waitId}\``));
      expect(row).toBeDefined();
      expect(row).toContain(deadline);
      expect(row).toContain(owner);
      expect(row).toContain('deadline-miss-record:');
    }
    expect(authority).not.toContain('Exact declared deadline and time basis');
    expect(authority).toContain('deadline-miss-record: wait_id, condition, started_at, deadline_at, observed_at, terminal_result, cause, remedy, owner, next_deadline');
    const wi06 = authority.split('\n').find((line) => line.includes('`WI-06`'));
    for (const argument of [
      '--run-identity "$runIdentity"',
      '--attempt-identity "$attemptIdentity"',
      '--handoff-receipt "$handoffReceipt"',
      '--terminal-envelope "$terminalEnvelope"',
      '--deadline-ms 5000',
    ]) {
      expect(authority).toContain(argument);
    }
    expect(wi06).toContain('publishJournalEvent');
    expect(wi06).toContain('createIssueComment');
    expect(wi06).toContain('confirmCanonicalEvent');
    expect(wi06).toContain('full comment census');
    expect(wi06).toContain('publication_requested_at');
    expect(wi06).toContain('call_outcome');
    expect(wi06).toContain('census_result');
    expect(wi06).not.toContain('GH_TIMEOUT_MS');
    expect(wi06).not.toContain('comment id and URL');
    expect(wi06).not.toContain('exactly what to re-publish');
    expect(authority).toContain('undeclared');
    expect(authority).toContain('done');
    expect(authority).toContain('blocked');
    expect(authority).toContain('refused');
  });

  it('requires complete published exceptions and producer-backed gates', () => {
    expect(authority).toContain('independently proven infeasible');
    expect(authority).toContain('underlying business invariant is already proven');
    expect(authority).toContain('required audience');
    expect(authority).toContain('full comment-census confirmation succeeds');
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
      'existing producer completion',
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
