import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  compareManagerReviewBrief,
  readManagerReviewCanon,
  renderManagerReviewBrief,
  renderManagerReviewBriefBatch,
  type ManagerReviewBriefContext,
} from './lib/manager-review-brief.ts';
import { runStateLightEntry } from './chatgpt-browser-turn/state-light-entry.ts';
import { runCli as runLegacyBrowserTurnCli } from './chatgpt-browser-turn.ts';
import { runBrowserAdapter } from './flow-manager-browser-gpt-long-run.ts';
import { observePublishedArtifact, runWait } from './flow-manager-long-running-child.ts';

const contract = readFileSync(new URL('../.claude/skills/create-issue-draft/SKILL.md', import.meta.url), 'utf8');
const ghTransport = readFileSync(new URL('./lib/create-issue-stage-record-gh.ts', import.meta.url), 'utf8');
const journalCore = readFileSync(new URL('./lib/create-issue-stage-record-core.ts', import.meta.url), 'utf8');
const browserRunbook = readFileSync(new URL('../docs/browser-gpt-turn-runbook.md', import.meta.url), 'utf8');
const authorityStart = contract.indexOf('## Flow-manager authority and bounded terminal outcomes — Issue #1197');
const authorityEnd = contract.indexOf('## Mechanical parity edits', authorityStart);
const authority = authorityStart >= 0 && authorityEnd > authorityStart
  ? contract.slice(authorityStart, authorityEnd)
  : '';

const reviewContext: ManagerReviewBriefContext = {
  repositoryFullName: 'chetwerikoff/orchestrator-pack',
  issueNumber: 1431,
  sourceRevision: 'r07',
  stage: 'architectural-review',
  sourceSlot: '01',
  invocationId: '11111111-2222-4333-8444-555555555555',
};

function runGit(root: string, args: readonly string[]): void {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: root,
    inheritParentEnv: true,
    timeoutMs: 10_000,
  });
  if (!result.ok) throw new Error(`git fixture failed: ${args.join(' ')}: ${result.stderr}`);
}

function createCanonFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-canon-'));
  mkdirSync(join(root, '.claude/skills/create-issue-draft'), { recursive: true });
  mkdirSync(join(root, '.cursor/rules'), { recursive: true });
  writeFileSync(join(root, '.claude/skills/create-issue-draft/SKILL.md'), [
    '# fixture skill',
    '',
    '```manager-review-brief-canon',
    '.claude/skills/create-issue-draft/SKILL.md :: ### Frame',
    '.cursor/rules/flow-manager-browser-turn-monitoring.mdc :: ## Launch and observation',
    '```',
    '',
    '### Frame',
    'Role: reviewer for <REPOSITORY> issue <ISSUE_NUMBER>.',
    'Stage <STAGE> slot <SLOT> revision <EXPECTED_REVISION>.',
    'INVOCATION_ID_TO_ECHO: <INVOCATION_ID>',
    '',
    '## Other',
    'unselected skill bytes',
    '',
  ].join('\n'));
  writeFileSync(join(root, '.cursor/rules/flow-manager-browser-turn-monitoring.mdc'), [
    '## Launch and observation',
    'Open <ISSUE_URL> and publish the complete review.',
    '',
    '## Other',
    'outside-v1',
    '',
  ].join('\n'));
  runGit(root, ['init']);
  runGit(root, ['config', 'user.email', 'fixture@example.invalid']);
  runGit(root, ['config', 'user.name', 'Fixture']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'fixture canon']);
  return root;
}

function captureWrite(stream: NodeJS.WriteStream): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, 'write');
  spy.mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stream.write);
  return { chunks, restore: () => spy.mockRestore() };
}

function publicationComment(input: {
  id: number;
  body: string;
  principal?: string;
  edited?: boolean;
}): Record<string, unknown> {
  return {
    id: input.id,
    body: input.body,
    created_at: '2026-08-19T01:00:00Z',
    updated_at: input.edited ? '2026-08-19T01:01:00Z' : '2026-08-19T01:00:00Z',
    user: { login: input.principal ?? 'chetwerikoff' },
    author_association: 'OWNER',
  };
}

function publicationTransport(
  comments: readonly Record<string, unknown>[],
  principal = 'chetwerikoff',
) {
  return {
    runGh: vi.fn((argv: string[]) => {
      const target = argv[2] ?? '';
      if (target === 'user') {
        return { exitCode: 0, stdout: `${principal}\n`, stderr: '' };
      }
      if (/\/issues\/1441\/comments\?/u.test(target)) {
        return { exitCode: 0, stdout: JSON.stringify(comments), stderr: '' };
      }
      const rejected = target.match(/\/issues\/comments\/([0-9]+)$/u);
      if (rejected) {
        const id = Number(rejected[1]);
        const comment = comments.find((candidate) => Number(candidate.id) === id);
        return comment
          ? { exitCode: 0, stdout: JSON.stringify(comment), stderr: '' }
          : { exitCode: 1, stdout: '', stderr: `missing comment ${id}` };
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected:${argv.join(' ')}` };
    }),
  };
}

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

  it('rejects wait references that have no bounded-wait table row', () => {
    const inventory = authority.match(/^bounded-wait-inventory: (.+)$/m)?.[1]
      .split(', ')
      .filter(Boolean);
    expect(inventory).toBeDefined();
    const rowIds = [...authority.matchAll(/^\| `(WI-\d+)`/gm)].map((match) => match[1]);
    const referencedIds = [...new Set([...authority.matchAll(/\bWI-\d+\b/g)].map((match) => match[0]))];
    expect(inventory).toEqual([...rowIds].sort());
    expect(referencedIds.sort()).toEqual([...rowIds].sort());
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
      'two non-converging author corrections',
    ]) {
      expect(authority).toContain(scenario);
    }
    expect(authority).toContain('second retry');
    expect(authority).toContain('heartbeat');
    expect(authority).toContain('service');
    expect(authority).toContain('durable store');
  });
});

describe('Issue #1431 manager reviewer canon', () => {
  it('keeps one canon declaration and retires the runbook reviewer template', () => {
    expect(contract.match(/```manager-review-brief-canon/g)).toHaveLength(1);
    expect(contract).toContain('### Generated independent reviewer binding frame');
    expect(contract).toContain('### Direct GitHub publication and manager receipts — Issue #1225');
    expect(browserRunbook).toContain('## Generated independent reviewer prompt');
    expect(browserRunbook).not.toContain('## Universal independent reviewer prompt template');
  });

  it('renders one frozen plural snapshot while fresh selected-section drift fails exact-byte comparison', () => {
    const root = createCanonFixture();
    try {
      const frozen = readManagerReviewCanon({ repositoryRoot: root });
      const sibling = {
        ...reviewContext,
        sourceSlot: '02',
        invocationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      };
      const rendered = renderManagerReviewBriefBatch(frozen, [reviewContext, sibling]);
      expect(rendered[0]!.text).toContain('Role: reviewer for chetwerikoff/orchestrator-pack issue 1431.');
      expect(rendered[1]!.text).toContain('slot 02 revision r07');

      writeFileSync(join(root, '.cursor/rules/flow-manager-browser-turn-monitoring.mdc'), [
        '## Launch and observation',
        'Changed selected bytes for <ISSUE_URL>.',
        '',
        '## Other',
        'outside-v1',
        '',
      ].join('\n'));
      runGit(root, ['add', '.']);
      runGit(root, ['commit', '-m', 'selected canon drift']);

      const comparison = compareManagerReviewBrief(rendered[1]!.text, sibling, { repositoryRoot: root });
      expect(comparison.ok).toBe(false);
      if (comparison.ok) throw new Error('expected canonical mismatch');
      expect(comparison.mismatch.cause).toMatch(/^canonical_prompt_mismatch:/);
      expect(comparison.mismatch.cause).toContain('expected_sha256=');
      expect(comparison.mismatch.cause).toContain('observed_sha256=');
      expect(comparison.mismatch.cause).toContain('.cursor/rules/flow-manager-browser-turn-monitoring.mdc@');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('admits exact current unmarked bytes and rejects a mutation before transport delegation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-entry-'));
    try {
      const input = join(root, 'review.txt');
      const rendered = renderManagerReviewBrief(readManagerReviewCanon(), reviewContext);
      writeFileSync(input, rendered.text);
      const delegated: string[][] = [];
      const baseArgs = [
        'turn',
        '--invocation-id', reviewContext.invocationId,
        '--input', input,
        '--reviewer-source-output', join(root, 'source.txt'),
        '--reviewer-source', 'direct-publication/v1',
        '--repository', reviewContext.repositoryFullName,
        '--issue-number', String(reviewContext.issueNumber),
        '--source-revision', reviewContext.sourceRevision,
        '--stage', reviewContext.stage,
        '--source-slot', reviewContext.sourceSlot,
      ];

      expect(await runStateLightEntry(baseArgs, {
        runTurn: async (argv) => {
          delegated.push([...argv]);
          const delegatedInputIndex = argv.indexOf('--input');
          const delegatedInput = delegatedInputIndex >= 0 ? argv[delegatedInputIndex + 1] : undefined;
          expect(delegatedInput).toBeDefined();
          expect(delegatedInput).not.toBe(input);
          writeFileSync(input, `${rendered.text}mutation\n`);
          expect(readFileSync(delegatedInput!, 'utf8')).toBe(rendered.text);
          return 0;
        },
      })).toBe(0);
      expect(delegated).toHaveLength(1);
      expect(delegated[0]).not.toContain('--stage');
      expect(delegated[0]).not.toContain('--source-slot');

      writeFileSync(input, `${rendered.text}mutation\n`);
      const stdout = captureWrite(process.stdout);
      try {
        const before = delegated.length;
        expect(await runStateLightEntry(baseArgs, {
          runTurn: async (argv) => {
            delegated.push([...argv]);
            return 0;
          },
        })).not.toBe(0);
        expect(delegated).toHaveLength(before);
        const refusal = JSON.parse(stdout.chunks.join('').trim()) as {
          state: string;
          cause: string;
          send_count: number;
        };
        expect(refusal.state).toBe('input_invalid');
        expect(refusal.send_count).toBe(0);
        expect(refusal.cause).toMatch(/^canonical_prompt_mismatch:/);
      } finally {
        stdout.restore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses legacy direct publication and requires long-run stage context before spawn', async () => {
    const stdout = captureWrite(process.stdout);
    try {
      expect(await runLegacyBrowserTurnCli([
        'turn',
        '--invocation-id', reviewContext.invocationId,
        '--reviewer-source-output', 'unused.txt',
      ])).not.toBe(0);
      const refusal = JSON.parse(stdout.chunks.join('').trim()) as {
        cause: string;
        send_count: number;
      };
      expect(refusal.cause).toBe('input_invalid:legacy_direct_publication_turn_refused');
      expect(refusal.send_count).toBe(0);

      stdout.chunks.length = 0;
      expect(await runLegacyBrowserTurnCli([
        'turn',
        '--invocation-id', reviewContext.invocationId,
        '--capture-too-many-requests-source', 'unused-capture.html',
        '--reviewer-source-output', 'unused.txt',
      ])).not.toBe(0);
      const combinedRefusal = JSON.parse(stdout.chunks.join('').trim()) as {
        cause: string;
        send_count: number;
      };
      expect(combinedRefusal.cause).toBe('input_invalid:legacy_direct_publication_turn_refused');
      expect(combinedRefusal.send_count).toBe(0);
    } finally {
      stdout.restore();
    }

    const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-long-run-'));
    const stderr = captureWrite(process.stderr);
    try {
      expect(await runBrowserAdapter([
        '--run-identity', 'run-1',
        '--attempt-identity', 'attempt-1',
        '--handoff-receipt', join(root, 'handoff.json'),
        '--invocation-id', reviewContext.invocationId,
        '--terminal-envelope', join(root, 'terminal.json'),
        '--output', join(root, 'output.json'),
        '--reviewer-source-output', join(root, 'source.txt'),
        '--reviewer-source', 'direct-publication/v1',
        '--repository', reviewContext.repositoryFullName,
        '--issue-number', String(reviewContext.issueNumber),
        '--source-revision', reviewContext.sourceRevision,
      ])).toBe(2);
      expect(stderr.chunks.join('')).toContain('direct_publication_arguments_required');
    } finally {
      stderr.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Issue #1441 publication authority regressions', () => {
  const currentInvocation = '14410000-1111-4222-8333-111111111111';
  const siblingInvocation = '14410000-1111-4222-8333-222222222222';
  const currentBody = [
    'Read revision: #1441 r05',
    `INVOCATION_ID_TO_ECHO: ${currentInvocation}`,
    'stage: architectural-review',
    'source-slot: 01',
    'VERDICT: NO_FINDINGS',
  ].join('\n');
  const expectation = {
    kind: 'reviewer' as const,
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1441,
    sourceRevision: 'r05',
    invocationId: currentInvocation,
    stage: 'architectural-review',
    sourceSlot: '01',
  };

  it('blocks matching foreign or edited publications without blocking unrelated foreign comments', () => {
    const foreign = observePublishedArtifact(expectation, publicationTransport([
      publicationComment({ id: 11, body: currentBody, principal: 'foreign-reviewer' }),
    ]) as never);
    expect(foreign).toMatchObject({
      status: 'blocked',
      reason: 'reviewer_publication_foreign_principal',
      diagnostics: ['comment:11'],
    });

    const edited = observePublishedArtifact(expectation, publicationTransport([
      publicationComment({ id: 12, body: currentBody, edited: true }),
    ]) as never);
    expect(edited).toMatchObject({
      status: 'blocked',
      reason: 'reviewer_publication_edited_comment',
      diagnostics: ['comment:12'],
    });

    const unrelated = observePublishedArtifact(expectation, publicationTransport([
      publicationComment({
        id: 13,
        principal: 'foreign-reviewer',
        body: [
          'Read revision: #1441 r05',
          'INVOCATION_ID_TO_ECHO: unrelated-invocation',
          'stage: architectural-review',
          'source-slot: 99',
        ].join('\n'),
      }),
    ]) as never);
    expect(unrelated).toMatchObject({
      status: 'missing',
      reason: 'reviewer_publication_not_visible',
    });
  });

  it('settles a silent batch slot as incident/no-resend from a REST-visible sibling', async () => {
    const siblingBody = [
      'Read revision: #1441 r05',
      `INVOCATION_ID_TO_ECHO: ${siblingInvocation}`,
      'stage: architectural-review',
      'source-slot: 02',
      'VERDICT: NO_FINDINGS',
    ].join('\n');
    const transport = publicationTransport([
      publicationComment({ id: 21, body: siblingBody }),
    ]);
    const root = mkdtempSync(join(tmpdir(), 'opk-1441-batch-settlement-'));
    const stdout = captureWrite(process.stdout);
    try {
      await runWait({
        runIdentity: 'run-1441-batch',
        attemptIdentity: 'attempt-1441-batch',
        terminalEnvelopePath: join(root, 'terminal.json'),
        handoffReceiptPath: join(root, 'handoff.json'),
        deadlineMs: 1_000,
        publicationExpectation: expectation,
        concurrentBatchExpectations: [
          expectation,
          {
            ...expectation,
            invocationId: siblingInvocation,
            sourceSlot: '02',
          },
        ],
        transport: transport as never,
      });
      const result = JSON.parse(stdout.chunks.join('').trim()) as Record<string, unknown>;
      expect(result).toMatchObject({
        non_terminal: false,
        no_success_authority: true,
        no_retry_authority: true,
        completion_authority: 'concurrent_batch_publication',
        batch_settlement_terminal: true,
        concurrent_batch_incident: {
          schema: 'flow-manager-concurrent-batch-incident/v1',
          invocation_id: currentInvocation,
          classification: 'possible-or-actual',
          resend_forbidden: true,
          settlement: 'incident',
          published_sibling_invocation_ids: [siblingInvocation],
        },
      });
    } finally {
      stdout.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
