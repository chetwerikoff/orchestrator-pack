import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { readTerminalEnvelope, runLaunch } from './flow-manager-long-running-child.ts';

const contract = readFileSync(new URL('../.cursor/skills/create-issue-draft/SKILL.md', import.meta.url), 'utf8');
const ghTransport = readFileSync(new URL('./lib/create-issue-stage-record-gh.ts', import.meta.url), 'utf8');
const journalCore = readFileSync(new URL('./lib/create-issue-stage-record-core.ts', import.meta.url), 'utf8');
const stateLightTurn = readFileSync(new URL('./chatgpt-browser-turn/state-light-turn.ts', import.meta.url), 'utf8');
const pageProbe = readFileSync(new URL('./browser-gpt-page-probe.ts', import.meta.url), 'utf8');
const browserRunbook = readFileSync(new URL('../docs/browser-gpt-turn-runbook.md', import.meta.url), 'utf8');
const authorityStart = contract.indexOf('## Flow-manager recovery ownership through task_ready — Issue #1514');
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
  mkdirSync(join(root, '.cursor/skills/create-issue-draft'), { recursive: true });
  mkdirSync(join(root, '.cursor/rules'), { recursive: true });
  writeFileSync(join(root, '.cursor/skills/create-issue-draft/SKILL.md'), [
    '# fixture skill',
    '',
    '```manager-review-brief-canon',
    '.cursor/skills/create-issue-draft/SKILL.md :: ### Frame',
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

describe('Issue #1514 flow-manager recovery ownership contract', () => {
  it('replaces the #1197 closed authority model with one recovery ownership rule', () => {
    expect(authority).not.toBe('');
    expect(authority).toContain('## Flow-manager recovery ownership through task_ready — Issue #1514');
    for (const retired of [
      '## Flow-manager authority and bounded terminal outcomes — Issue #1197',
      '### Closed self-authorized actions',
      'self-authorized-action-set:',
      'bounded-wait-inventory:',
      '### Complete scenario matrix',
      'Every other path settles locally as',
      'The flow-manager transports and verifies evidence and performs mechanical',
    ]) {
      expect(authority).not.toContain(retired);
    }

    expect(authority).toContain('owns the complete assigned manager goal, not the last command');
    expect(authority).toContain('recovery is allowed by default');
    expect(authority.replace(/\s+/g, ' ')).toContain(
      'On a guard, helper, schema, input, path, metadata, or configuration failure, the flow-manager must reread authoritative state and the owning source',
    );
    expect(authority).not.toContain(
      'On a recoverable guard, helper, schema, input, path, metadata, or configuration',
    );
    expect(authority.replace(/\s+/g, ' ')).toContain('retain the same manager Task and Dispatch through `task_ready`');
    expect(authority).toContain('reread authoritative state and the owning source');
    expect(authority.replace(/\s+/g, ' ')).toContain(
      'It must correct manager-owned pre-invocation input, artifact, metadata, configuration, or invocation before consumption when that boundary exists',
    );
    expect(authority).not.toContain('It may\ncorrect manager-owned pre-invocation input');
    expect(authority.replace(/\s+/g, ' ')).toContain('rerun or reinvoke only when the owning action\'s existing contract permits');
    expect(authority).toContain('An error message without a ready-made remedy requires source inspection');
  });

  it('defines exactly the short role denylist without recreating an allowlist or scenario taxonomy', () => {
    const denyStart = authority.indexOf('### Short manager denylist');
    const denyEnd = authority.indexOf('### Stage result is not parent-manager completion', denyStart);
    const denySection = denyStart >= 0 && denyEnd > denyStart
      ? authority.slice(denyStart, denyEnd)
      : '';
    const bullets = denySection.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets).toHaveLength(6);
    for (const expected of [
      'fabricate evidence, delivery, acceptance, or success',
      'resend after possible or proven delivery',
      'make substantive Issue, business-contract, defect, remedy, or reviewer-finding',
      'expand frozen scope, allowed roots, or the Issue denylist',
      'destructive, cross-task, merge, or runtime effect',
      'reopen a consumed semantic stage slot',
    ]) {
      expect(denySection).toContain(expected);
    }
    expect(denySection).toContain('exact composite identity');
    expect(denySection.replace(/\s+/g, ' ')).toContain(
      'Do not replace this denylist with action categories, scenario matrices, wait inventories, per-error action lists, or another closed allowlist.',
    );
    expect(denySection).not.toContain('self-authorized-action-set');
  });

  it('keeps stage-local blocked/refused nonterminal and leaves whole-task completion to #1486', () => {
    expect(authority).toContain('Existing `blocked` and `refused` values may remain');
    expect(authority).toContain('They describe the current operation or stage only');
    expect(authority).toContain('they do not complete the parent manager Task');
    expect(authority).toContain('Whole-task `worker_done`, cancellation, and external termination remain owned\nsolely by #1486 §6');
    expect(authority.match(/`worker_done`/g)).toHaveLength(1);
    expect(authority).not.toContain('`done` means the awaited condition was proven');
    expect(authority).not.toContain('Every other path settles locally');
  });

  it('preserves action-specific Browser-GPT retry and no-resend boundaries', () => {
    expect(authority).toContain('Allow-by-default recovery never converts `send_count: 0` into generic retry\nauthority');
    expect(authority).toContain('proven pre-send quota/composer/fill failure with `send_count: 0`');
    expect(authority).toContain('generic\n`input_invalid` or canonical-input refusal is not retryable');
    expect(authority).toContain('before cycle, stage-attempt,\nor reviewer-invocation consumption');
    expect(authority).toContain('Possible or proven\ndelivery remains no-resend');
    expect(authority).toContain('reopen a consumed semantic stage slot');
  });

  it('preserves bounded deadlines and the exact existing waiter/publication bindings without a wait inventory', () => {
    expect(authority).not.toContain('bounded-wait-inventory:');
    expect(authority).toContain('DEFAULT_TIMEOUT_MS = 1_800_000 ms');
    expect(authority).toContain('CDP_REQUEST_TIMEOUT_MS = 10_000 ms');
    expect(stateLightTurn).toContain('const DEFAULT_TIMEOUT_MS = 1_800_000;');
    expect(pageProbe).toContain('const CDP_REQUEST_TIMEOUT_MS = 10_000;');

    const waiterBlock = authority.match(/```bash\nnpm run --silent flow-manager-long-running-child -- wait \\\n[\s\S]*?```/)?.[0];
    expect(waiterBlock).toBeDefined();
    const waiterLines = waiterBlock!
      .split('\n')
      .filter((line) => line.startsWith('  --'));
    expect(waiterLines).toEqual([
      '  --run-identity "$runIdentity" \\',
      '  --attempt-identity "$attemptIdentity" \\',
      '  --handoff-receipt "$handoffReceipt" \\',
      '  --terminal-envelope "$terminalEnvelope" \\',
      '  --deadline-ms 5000',
    ]);

    expect(authority).toContain('GH_TIMEOUT_MS = 10_000');
    expect(authority).toContain('publishJournalEvent -> createIssueComment -> confirmCanonicalEvent');
    expect(authority).toContain('full comment census');
    expect(authority).toContain('withGhDeadline');
    expect(authority).toContain('const publicationDeadline = Date.now() + GH_TIMEOUT_MS');
    expect(authority).toContain('ambiguous or timed-out\n  publication does not auto-resend');
    expect(authority.replace(/\s+/g, ' ')).toContain(
      'A deadline miss remains visible evidence on the existing owning surface with its cause, remedy and owner when already known, and the next legal routing action; it does not become parent-manager completion, permission to invent another wait, or a new retry authority.',
    );
    expect(ghTransport).toContain('export const GH_TIMEOUT_MS = 10_000;');
    expect(ghTransport).toContain('runGh(argv: string[], timeoutMs = GH_TIMEOUT_MS)');
    expect(ghTransport).toContain('remainingMs');
    expect(ghTransport).toContain('withGhDeadline');
    expect(ghTransport).toContain('return transport.runGh(argv, remainingMs)');
    expect(journalCore).toContain('const publicationDeadline = Date.now() + GH_TIMEOUT_MS');
    expect(journalCore).toContain('withGhDeadline(transport, publicationDeadline)');
  });

  it('keeps anti-silent-idle, existing escalation/publication authority, and producer-before-validator', () => {
    expect(authority).toContain('Nonterminality does not authorize an indefinite or silent wait');
    expect(authority).toContain('leave visible bounded-wait or\nrouting evidence');
    expect(authority).toContain('fleet-reconciliation-handoff/v1');
    expect(authority).toContain('operator-only-escalation-classes: business-contract-change, material-reviewer-conflict, terminal-infrastructure-refusal');
    expect(authority).toContain('The existing published-exception authority remains limited');
    expect(authority).toContain('independently proven infeasible');
    expect(authority).toContain('required audience');
    expect(authority).toContain('visibility proof');
    expect(authority).toContain('Every new gate must arrive with its producer in the same change');
    expect(authority).toContain('does not fabricate an\nartifact or treat an orchestrator-only workaround as a producer');
  });

  it('keeps substantive decisions with their owners while allowing manager-owned recovery', () => {
    expect(authority).toContain('The GPT author owns substantive Issue edits, defect/remedy dispositions, and\nfinding dispositions');
    expect(authority).toContain('reviewer/architect/operator decisions remain with their\nexisting owners');
    expect(authority).toContain('may inspect and correct manager-owned\nrecoverable state');
    expect(authority).toContain('must not consolidate reviewer findings or make\nthose substantive decisions itself');
    expect(authority).not.toContain('The flow-manager transports and verifies evidence and performs mechanical\nchecks.');
  });

  it('limits coordinator work to routing and preserves normal worker repair/direct-fix authority', () => {
    expect(authority).toContain('The coordinator routes; it does not diagnose ordinary manager failures');
    expect(authority).toContain('hand the existing normal worker-repair route only the failing action\nand authoritative evidence already held');
    expect(authority).toContain('receiving worker/author owns repair\nscope, reproducer design, and focused regression proof');
    expect(authority).toContain('Direct-fix remains legal only when the current top-level user has\nexplicitly authorized that specific direct-PR change');
    expect(authority.replace(/\s+/g, ' ')).toContain(
      'original manager remains nonterminal in the same Task and Dispatch while repair is routed, waits for authoritative repaired-head evidence, and resumes only from that evidence',
    );
    expect(authority).not.toContain('authoritative repair evidence is available');
    expect(authority).toContain('No repair-packet schema, firefighter service, scheduler, queue, lease, watcher');
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

describe('Issue #1752 startup allowance covers canonical admission', () => {
  const entryUrl = new URL('./chatgpt-browser-turn/state-light-entry.ts', import.meta.url).href;
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));

  function writeSlowGitWrapper(root: string): string {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, 'git');
    writeFileSync(wrapper, [
      '#!/bin/sh',
      'sleep "${OPK_TEST_GIT_DELAY_SEC:-0}"',
      'PATH="${PATH#*:}" exec git "$@"',
      '',
    ].join('\n'));
    chmodSync(wrapper, 0o755);
    return bin;
  }

  async function runAdmissionCase(input: {
    startupMs: number;
    gitDelaySeconds: string;
    emitNoise?: boolean;
  }) {
    const root = mkdtempSync(join(tmpdir(), 'opk-1752-entry-launcher-'));
    const previous = {
      path: process.env.PATH,
      delay: process.env.OPK_TEST_GIT_DELAY_SEC,
      startup: process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS,
      gap: process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS,
      idle: process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS,
    };
    try {
      const promptPath = join(root, 'review.txt');
      writeFileSync(promptPath, renderManagerReviewBrief(readManagerReviewCanon(), reviewContext).text);
      const bin = writeSlowGitWrapper(root);
      process.env.PATH = bin + ':' + (previous.path ?? '');
      process.env.OPK_TEST_GIT_DELAY_SEC = input.gitDelaySeconds;
      process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS = String(input.startupMs);
      process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '50';
      process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '150';

      const heartbeat = {
        schema: 'observation-heartbeat/v1',
        phase: 'admitted_pre_send',
        poll_count: 0,
        observation_state: 'waiting',
        stable_reads: 0,
        completion_ready: false,
      };
      const turnResult = {
        schema: 'turn-result/v1',
        state: 'ok',
        scope: 'none',
        cause: 'ok',
        invocation_id: reviewContext.invocationId,
        configured_profile_key: 'fixture-profile',
        witness: {
          user_message_id: 'u1',
          assistant_message_id: 'a1',
          relation: 'reply_to',
          source: 'service',
        },
        observation_uncertainty_diagnostics: {
          cause: 'ok',
          send_count: 1,
          owned_prompt_seen: true,
        },
      };
      const source = [
        '(async () => {',
        '  const { runStateLightEntry } = await import(' + JSON.stringify(entryUrl) + ');',
        input.emitNoise ? '  process.stdout.write(JSON.stringify({ schema: "noise/v1" }) + "\\n");' : '',
        '  const heartbeat = ' + JSON.stringify(heartbeat) + ';',
        '  const turnResult = ' + JSON.stringify(turnResult) + ';',
        '  const code = await runStateLightEntry(process.argv.slice(1), {',
        '    runTurn: async () => {',
        '      process.stdout.write(JSON.stringify(heartbeat) + "\\n");',
        '      process.stdout.write(JSON.stringify(turnResult) + "\\n");',
        '      return 0;',
        '    },',
        '  });',
        '  process.exit(code);',
        '})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });',
      ].filter(Boolean).join('\n');

      const attempt = join(root, 'attempt');
      const envelopePath = join(attempt, 'terminal-envelope.json');
      const code = await runLaunch({
        runIdentity: 'run-1752-' + input.startupMs,
        attemptIdentity: 'attempt-1752-' + input.startupMs,
        handoffReceiptPath: join(attempt, 'handoff-receipt.json'),
        terminalEnvelopePath: envelopePath,
        browserOutputPath: join(attempt, 'browser-output.txt'),
        cwd: repoRoot,
        childCommand: process.execPath,
        childArgs: [
          '--experimental-strip-types',
          '-e',
          source,
          '--',
          'turn',
          '--invocation-id', reviewContext.invocationId,
          '--input', promptPath,
          '--reviewer-source-output', join(root, 'source.txt'),
          '--reviewer-source', 'direct-publication/v1',
          '--repository', reviewContext.repositoryFullName,
          '--issue-number', String(reviewContext.issueNumber),
          '--source-revision', reviewContext.sourceRevision,
          '--stage', reviewContext.stage,
          '--source-slot', reviewContext.sourceSlot,
        ],
      });
      return { code, envelope: readTerminalEnvelope(envelopePath) };
    } finally {
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      if (previous.delay === undefined) delete process.env.OPK_TEST_GIT_DELAY_SEC;
      else process.env.OPK_TEST_GIT_DELAY_SEC = previous.delay;
      if (previous.startup === undefined) delete process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS;
      else process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS = previous.startup;
      if (previous.gap === undefined) delete process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS;
      else process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = previous.gap;
      if (previous.idle === undefined) delete process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS;
      else process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = previous.idle;
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('admits a delayed direct-publication turn inside the shared startup allowance', async () => {
    const result = await runAdmissionCase({ startupMs: 2_000, gitDelaySeconds: '0.02' });
    expect(result.code).toBe(0);
    expect(result.envelope).toMatchObject({
      lifecycle_outcome: 'success',
      delivery: 'landed',
    });
  });

  it('times out truthfully when canonical admission exceeds startup allowance and noise cannot refresh it', async () => {
    const result = await runAdmissionCase({
      startupMs: 50,
      gitDelaySeconds: '0.2',
      emitNoise: true,
    });
    expect(result.code).toBe(1);
    expect(result.envelope).toMatchObject({
      incident: 'child_startup_timeout',
      child_exit_code: null,
    });
    expect(JSON.stringify(result.envelope)).not.toContain('child_stdout_eof_timeout');
  });
});

