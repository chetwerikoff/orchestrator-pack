import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contract = readFileSync(new URL('../.claude/skills/create-issue-draft/SKILL.md', import.meta.url), 'utf8');
const ghTransport = readFileSync(new URL('./lib/create-issue-stage-record-gh.ts', import.meta.url), 'utf8');
const journalCore = readFileSync(new URL('./lib/create-issue-stage-record-core.ts', import.meta.url), 'utf8');
const authorityStart = contract.indexOf('## Flow-manager authority and bounded terminal outcomes — Issue #1197');
const authorityEnd = contract.indexOf('## Mechanical parity edits', authorityStart);
const authority = authorityStart >= 0 && authorityEnd > authorityStart
  ? contract.slice(authorityStart, authorityEnd)
  : '';

describe('Issue #1197 flow-manager authority contract', () => {
  it('defines a closed self-authorized action list and explicit prohibitions', () => {
    const expectedActions = [
      'reread-authority',
      'mechanical-repair',
      'invoke-existing-producer',
      'verify-evidence',
      'diagnostic-page-probe',
      'bounded-wait',
      'legal-zero-send-retry',
      'settle-terminal-outcome',
      'publish-procedural-exception',
    ];
    const actionSet = authority.match(/^self-authorized-action-set: (.+)$/m)?.[1]
      .split(', ')
      .filter(Boolean);
    expect(actionSet).toEqual(expectedActions);
    expect(actionSet).toHaveLength(9);
    for (const action of [
      '1. Reread the authoritative Issue/revision',
      '2. Repair mechanical formatting',
      '3. Invoke or re-invoke an already named producer',
      '4. Verify evidence and recompute hashes',
      '5. Perform an already-authorized bounded page probe',
      '6. Wait for a named local or external result',
      '7. Retry only an invocation whose existing transport contract',
      '8. Settle `done`, `blocked`, or `refused`',
      '9. Publish a bounded exception',
    ]) {
      expect(authority).toContain(action);
    }
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
      ['WI-01', '1_800_000 ms', 'owner: named producer', ['done', 'blocked', 'refused']],
      ['WI-02', '10_000 ms', 'owner: page-probe', ['done', 'blocked']],
      ['WI-03', '1_800_000 ms', 'owner: preceding stage producer', ['done', 'blocked', 'refused']],
      ['WI-04', '1_800_000 ms', 'owner: reviewer source', ['done', 'blocked']],
      ['WI-05', '5_000 ms', 'owner: launcher waiter', ['done', 'blocked', 'refused']],
      ['WI-06', 'GH_TIMEOUT_MS = 10_000 ms', 'owner: exception publisher', ['done', 'blocked']],
    ] as const;
    for (const [waitId, deadline, owner, terminalStates] of expectedRows) {
      const row = authority.split('\n').find((line) => line.includes(`\`${waitId}\``));
      expect(row).toBeDefined();
      expect(row).toContain(deadline);
      expect(row).toContain(owner);
      expect(row).toContain('deadline-miss-record:');
      for (const terminalState of terminalStates) {
        expect(row).toContain(`\`${terminalState}\``);
      }
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
    expect(wi06).toContain('GH_TIMEOUT_MS');
    expect(wi06).not.toContain('comment id and URL');
    expect(wi06).not.toContain('exactly what to re-publish');
    expect(ghTransport).toContain('export const GH_TIMEOUT_MS = 10_000;');
    expect(ghTransport).toContain('runGh(argv: string[], timeoutMs = GH_TIMEOUT_MS)');
    expect(ghTransport).toContain('remainingMs');
    expect(ghTransport).toContain('withGhDeadline');
    expect(ghTransport).toContain('return transport.runGh(argv, remainingMs)');
    expect(journalCore).toContain('const publicationDeadline = Date.now() + GH_TIMEOUT_MS');
    expect(journalCore).toContain('withGhDeadline(transport, publicationDeadline)');
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
