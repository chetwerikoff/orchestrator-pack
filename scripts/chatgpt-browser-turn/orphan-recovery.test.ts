import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Issue #2827 is a manager/runbook-only change. These offline fixtures execute
// the ordered decision table published in the runbook; they do not pretend to
// exercise the Browser-GPT launcher or real GitHub writes.
const runbook = readFileSync(
  fileURLToPath(new URL('../../docs/browser-gpt-turn-runbook.md', import.meta.url)), 'utf8',
);
const skill = readFileSync(
  fileURLToPath(new URL('../../.cursor/skills/execute-issue-with-gpt/SKILL.md', import.meta.url)), 'utf8',
);
const recovery = runbook.split('### Same-invocation recovery\n')[1]
  ?.split('### Diagnostic recurrence journal\n')[0] ?? '';

type Action =
  | 'adopt_existing_no_send'
  | 'reconcile_original_no_send'
  | 'observe_original_no_send'
  | 'reconcile_successor_no_send'
  | 'admit_one_fresh_new_chat';
type DecisionRow = { predicate: string; action: Action };

const expectedRows: DecisionRow[] = [
  { predicate: 'effect_found', action: 'adopt_existing_no_send' },
  { predicate: '!no_effects_verified', action: 'reconcile_original_no_send' },
  { predicate: '!launcher_positively_dead', action: 'observe_original_no_send' },
  { predicate: 'page_generating_or_unproven', action: 'observe_original_no_send' },
  { predicate: '!deadline_passed', action: 'observe_original_no_send' },
  { predicate: '!same_task_dispatch_owner', action: 'reconcile_original_no_send' },
  { predicate: 'fresh_turn_already_admitted', action: 'reconcile_successor_no_send' },
  { predicate: 'page_idle_or_unavailable', action: 'admit_one_fresh_new_chat' },
  { predicate: 'otherwise', action: 'reconcile_original_no_send' },
];

function documentedRows(): DecisionRow[] {
  const table = recovery.split('| Predicate | Action |\n| --- | --- |\n')[1] ?? '';
  const rows: DecisionRow[] = [];
  for (const line of table.split('\n')) {
    const match = /^\| `(!?[a-z_]+)` \| `([a-z_]+)` \|$/.exec(line);
    if (!match) break;
    rows.push({ predicate: match[1]!, action: match[2]! as Action });
  }
  return rows;
}

type Facts = {
  effect_found: boolean;
  no_effects_verified: boolean;
  launcher_positively_dead: boolean;
  page_generating_or_unproven: boolean;
  deadline_passed: boolean;
  same_task_dispatch_owner: boolean;
  fresh_turn_already_admitted: boolean;
  page_idle_or_unavailable: boolean;
};

function projectDocumentedDecision(facts: Facts): Action {
  const rows = documentedRows();
  if (rows.length !== expectedRows.length) throw new Error('Missing or partial recovery decision table');
  for (const { predicate, action } of rows) {
    if (predicate === 'otherwise') return action;
    const negated = predicate.startsWith('!');
    const key = (negated ? predicate.slice(1) : predicate) as keyof Facts;
    if ((negated ? !facts[key] : facts[key])) return action;
  }
  throw new Error('No recovery action');
}

const ready: Facts = {
  effect_found: false,
  no_effects_verified: true,
  launcher_positively_dead: true,
  page_generating_or_unproven: false,
  deadline_passed: true,
  same_task_dispatch_owner: true,
  fresh_turn_already_admitted: false,
  page_idle_or_unavailable: true,
};

describe('Issue #2827: documented uncertain-turn manager recovery', () => {
  it('binds an ordered, fail-closed decision table to the live runbook', () => {
    expect(recovery).toBeTruthy();
    expect(documentedRows()).toEqual(expectedRows);
    expect(skill).toContain('post-launch GitHub');
    expect(skill).toContain('At **every executor-manager wake**');
  });

  it.each([
    ['newly published executor PR effect', { effect_found: true }],
    ['post-launch author body edit or comment effect', { effect_found: true }],
  ])('%s is adopted even with an uncertain original Page', (_name, update) => {
    expect(projectDocumentedDecision({
      ...ready, ...update, launcher_positively_dead: false, page_generating_or_unproven: true,
    })).toBe('adopt_existing_no_send');
    expect(recovery).toContain('open PRs explicitly linked to Issue N');
    expect(recovery).toContain('published branches');
    expect(recovery).toContain('newly created Issue comments');
    expect(recovery).toContain('body revision or comment');
    expect(recovery).toContain('later than that start');
    expect(recovery).toContain('send a new turn');
  });

  it('admits one distinct fresh new-chat intent only after deadline and positive death/idle evidence', () => {
    expect(projectDocumentedDecision(ready)).toBe('admit_one_fresh_new_chat');
    expect(recovery).toContain('genuinely distinct continuation intent');
    expect(recovery).toContain('fresh invocation, attempt, output');
    expect(recovery).toMatch(/no\\s+new ledger/);
    expect(skill).toContain('architect/operator decision');
  });

  it.each([
    ['incomplete GitHub effects', { no_effects_verified: false }, 'reconcile_original_no_send'],
    ['live or unproven launcher', { launcher_positively_dead: false }, 'observe_original_no_send'],
    ['generating or unreadable Page', { page_generating_or_unproven: true }, 'observe_original_no_send'],
    ['before original deadline', { deadline_passed: false }, 'observe_original_no_send'],
    ['foreign Task/Dispatch', { same_task_dispatch_owner: false }, 'reconcile_original_no_send'],
    ['successor already admitted', { fresh_turn_already_admitted: true }, 'reconcile_successor_no_send'],
    ['no proof Page idle or absent', { page_idle_or_unavailable: false }, 'reconcile_original_no_send'],
  ] as const)('%s never sends a replacement', (_name, update, expected) => {
    expect(projectDocumentedDecision({ ...ready, ...update })).toBe(expected);
  });
});

type OpenPr = { number: number; createdAt: string };
function selectKeptPrFixture(open: OpenPr[], adopted: number | null): number {
  const presentAdopted = open.find(pr => pr.number === adopted);
  if (presentAdopted) return presentAdopted.number;
  return [...open].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.number - b.number)[0]!.number;
}

describe('Issue #2827: twin-PR manager wake fixture', () => {
  const open: OpenPr[] = [
    { number: 586, createdAt: '2026-11-10T12:00:00Z' },
    { number: 587, createdAt: '2026-11-10T12:00:00Z' },
    { number: 588, createdAt: '2026-11-10T12:01:00Z' },
  ];

  it.each([
    ['adopted open PR wins', 588, 588, [586, 587]],
    ['otherwise earliest PR wins with number tie-break', null, 586, [587, 588]],
    ['closed former adoption falls back to earliest', 589, 586, [587, 588]],
  ] as const)('%s', (_name, adopted, kept, duplicates) => {
    const decision = selectKeptPrFixture(open, adopted);
    expect(decision).toBe(kept);
    expect(open.filter(pr => pr.number !== decision).map(pr => pr.number)).toEqual(duplicates);
    expect(recovery).toContain('keep the already-adopted **open**');
    expect(recovery).toContain('otherwise keep the earliest-created PR (tie-break by smaller PR number)');
    expect(recovery).toContain('publish a comment naming the Issue and the kept PR, **then');
    expect(recovery).toContain('close that duplicate PR');
    expect(recovery).toContain('Never delete the');
    expect(skill).toContain('then close the duplicates without deleting their branches');
  });
});
