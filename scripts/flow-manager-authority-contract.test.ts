import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  compareManagerReviewBrief,
  readManagerReviewCanon,
  renderManagerReviewBrief,
  renderManagerReviewBriefBatch,
  type ManagerReviewBriefContext,
} from './lib/manager-review-brief.ts';
import { buildManagerReviewTerminalBundle } from './lib/manager-review-terminal-bundle.ts';
import { runStateLightEntry } from './chatgpt-browser-turn/state-light-entry.ts';
import { runCli as runLegacyBrowserTurnCli } from './chatgpt-browser-turn.ts';
import { runBrowserAdapter } from './flow-manager-browser-gpt-long-run.ts';
import {
  HANDOFF_SCHEMA,
  TERMINAL_SCHEMA,
  readTerminalEnvelope,
  runLaunch,
} from './flow-manager-long-running-child.ts';
import { runStageFinalizeCli } from './lib/create-issue-stage-record-cli.ts';
import type { GhTransport } from './lib/create-issue-stage-record-types.ts';
import {
  publishSettledStageRecord,
  semanticStageAttemptId,
} from './lib/create-issue-stage-record-core.ts';
import { createMockGhState, createMockTransport } from './lib/create-issue-stage-record-test-helpers.ts';
import {
  ensureLifecycleStageEvidenceSeed,
  ensureLifecycleTierIntake,
  inspectLifecycleInvocationBinding,
  loadCanonicalLifecycleAuthority,
  recordLifecycleInvocationAdmission,
} from './lib/create-issue-stage-lifecycle.ts';
import { evaluateStageCredentialingSettlement } from './lib/create-issue-stage-lifecycle-acceptance.ts';
import {
  createIssueExternalPauseResult,
  createIssueNextAction,
  createIssueRecoverableResult,
  projectBlockedOnToExternalPause,
  validateCreateIssueBlockedOn,
  type CreateIssueManagerResult,
} from './lib/create-issue-next-action.ts';
import {
  createIssueEscalationThreadId,
  evaluateCreateIssueManagerBoundary,
} from './lib/create-issue-manager-boundary.ts';

const contract = readFileSync(new URL('../.cursor/skills/create-issue-draft/SKILL.md', import.meta.url), 'utf8');
const defaultGhTransportSlot = vi.hoisted(() => ({
  current: undefined as GhTransport | undefined,
}));
vi.mock('./lib/create-issue-stage-record-gh.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/create-issue-stage-record-gh.ts')>();
  return {
    ...actual,
    defaultGhTransport: () => {
      if (!defaultGhTransportSlot.current) throw new Error('scenario-1 fixture defaultGhTransport is not configured');
      return defaultGhTransportSlot.current;
    },
  };
});
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

function createTerminalBundleFixture(root: string, sourceRevision = 'r08') {
  const reviewDir = join(root, '.review', '1431');
  mkdirSync(reviewDir, { recursive: true });
  const reviewEpisodeId = 'issue:1431@r01';
  const draft = `<!-- source-revision: ${sourceRevision} -->\n\n# terminal fixture\n`;
  const finding = {
    id: 'scope-fixture',
    type: 'scope-violation',
    defectDisposition: 'rejected-as-false',
    remedyDisposition: 'accepted',
    occurrences: ['sha256:fixture:pass-01-architectural-review-01.capture.txt:1'],
    architectPending: false,
    architectRequired: false,
    protectedActivation: null,
    protectedOccurrences: [],
  };
  const captureTexts = ['reviewer one\n', 'reviewer two\n', 'reviewer three\n'];
  const captures = captureTexts.map((captureText, index) => {
    const name = `pass-01-architectural-review-${String(index + 1).padStart(2, '0')}.capture.txt`;
    return {
      captureIdentity: `sha256:fixture:${name}`,
      name,
      byteLength: Buffer.byteLength(captureText),
      sha256: createHash('sha256').update(captureText, 'utf8').digest('hex'),
      rawFindingCount: index === 0 ? 1 : 0,
    };
  });
  const invocations = captures.map((capture, index) => ({
    schema: 'reviewer-invocation-envelope/v1',
    reviewEpisodeId,
    stageAttemptId: 'architectural-review-attempt',
    policyVersion: 'triple-source/v1',
    reviewerCardinality: 3,
    cardinalityConfigIdentity: 'env:OPK_GPT_REVIEWER_CARDINALITY',
    stage: 'architectural-review',
    sourceRevision,
    invocationId: `architectural-review-invocation-${index + 1}`,
    terminalResultIdentity: `result:architectural-review:${index + 1}`,
    reviewerSource: `source-architectural-review-${index + 1}`,
    reviewerSlot: String(index + 1).padStart(2, '0'),
    reviewerOrdinal: index + 1,
    attemptOrdinal: 1,
    retryAttempt: false,
    terminal: true,
    terminalClassification: 'complete',
    sendCount: 1,
    retryClass: 'none',
    revisionCheck: 'matched',
    capacityOutcome: 'admitted',
    capacityWaitMs: 0,
    capture,
  }));
  writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({
    schema: 'tier-intake/v1',
    producer: 'fixture',
    taskIdentity: 'issue:1431',
    kind: 'fresh',
    priorTier: 'T2',
    firstRevision: 'r01',
  }, null, 2));
  writeFileSync(join(reviewDir, 'author-dispositions.json'), JSON.stringify({
    schema: 'create-issue-author-dispositions/v1',
    producer: 'governed-author-output/v1',
    reviewEpisodeId,
    sourceRevision,
    predecessorStage: 'architectural-review',
    draft,
    findings: [finding],
    m4: {
      reviewEpisodeId,
      sourceRevision,
      predecessorStage: 'architectural-review',
      inventory: [
        { mechanism: 'terminal prior-state bundle', disposition: 'keep' },
      ],
    },
  }, null, 2));
  writeFileSync(join(reviewDir, `issue-${sourceRevision}-body.json`), JSON.stringify({
    schema: 'create-issue-live-snapshot/v1',
    issueNumber: reviewContext.issueNumber,
    sourceRevision,
    title: 'fixture issue',
    body: draft,
  }, null, 2) + '\n');
  writeFileSync(join(reviewDir, 'finding-disposition-ledger.json'), JSON.stringify({
    version: 2,
    reviewEpisodeId,
    sourceRevision,
    predecessorStage: 'architectural-review',
    draft,
    counts: {
      rawFindingCount: 1,
      distinctFindingCount: 1,
      processedDistinctCount: 1,
    },
    findings: [finding],
  }, null, 2));
  writeFileSync(join(reviewDir, 'review-episode-inventory.json'), JSON.stringify({
    source: 'canonical-review-directory',
    taskIdentity: 'issue:1431',
    episodeFirstRevision: 'r01',
    reviewEpisodeId,
    stageReceiptIds: [`${reviewEpisodeId}:stage-receipt:0001`],
  }, null, 2));
  writeFileSync(join(reviewDir, 'verified-relay-evidence.json'), JSON.stringify(captures.map((capture, index) => ({
    relayAttemptId: `relay-${index + 1}`,
    captureIdentity: capture.captureIdentity,
    sourceLabel: `${capture.name}|${capture.captureIdentity}`,
    name: capture.name,
    byteLength: capture.byteLength,
    sha256: capture.sha256,
    verified: true,
  })), null, 2));
  const receiptName = 'stage-completeness-receipt-ar.json';
  writeFileSync(join(reviewDir, receiptName), JSON.stringify({
    schema: 'stage-completeness-receipt/v1',
    tier: 'T2',
    taskIdentity: 'issue:1431',
    episodeFirstRevision: 'r01',
    reviewEpisodeId,
    stageReceiptId: `${reviewEpisodeId}:stage-receipt:0001`,
    previousStageReceiptId: null,
    receiptCensus: [`${reviewEpisodeId}:stage-receipt:0001`],
    stageAttemptId: 'architectural-review-attempt',
    stageSequence: 1,
    stage: 'architectural-review',
    policyVersion: 'triple-source/v1',
    reviewerCardinality: 3,
    cardinalityConfigIdentity: 'env:OPK_GPT_REVIEWER_CARDINALITY',
    sourceRevision,
    outcome: 'complete',
    producerEvidence: 'not-applicable',
    revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
    settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
    invocations,
    credentialingCaptures: captures,
    relayEligibleCaptures: captures,
  }, null, 2));
  writeFileSync(join(reviewDir, 'acceptance-artifacts.json'), JSON.stringify({
    schema: 'create-issue-acceptance-artifacts/v1',
    reviewEpisodeId,
    acceptanceBasis: 'authoritative-github-artifact',
    files: [
      receiptName,
      'verified-relay-evidence.json',
      'finding-disposition-ledger.json',
      'review-episode-inventory.json',
      'acceptance-artifacts.json',
    ],
  }, null, 2));
  const bundle = buildManagerReviewTerminalBundle({
    repositoryFullName: reviewContext.repositoryFullName,
    issueNumber: reviewContext.issueNumber,
    sourceRevision,
    reviewDir,
    liveIssueBody: draft,
  });
  return { reviewDir, draft, bundle };
}

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
    expect(authority).toContain('For this manager, the only self-initiated terminal message is\n`worker_done --outcome succeeded` after whole-task acceptance');
    expect(authority).toContain('`worker_done --outcome failed` is legal only after a direct\ncoordinator/operator cancellation message');
    expect(authority).toContain('`recoverable`, `external_pause`,\nand `contract_defect` never complete or settle the parent manager Task');
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
    expect(authority.replace(/\s+/g, ' ')).toContain(
      'If no legal repository-owned continuation is currently available, classify the result at the shared boundary: external reality becomes `external_pause` with remedy/evidence/resumption, and a missing or malformed producer becomes `contract_defect`.',
    );
    expect(authority).toContain('fleet-reconciliation-handoff/v1');
    expect(authority).toContain('operator-only-escalation-classes: business-contract-change, material-reviewer-conflict');
    expect(authority).not.toContain('terminal-infrastructure-refusal');
    expect(authority).toContain('Repository-owned infrastructure/bookkeeping failures are not an operator-only\nterminal class');
    expect(authority).toContain('The existing published-exception authority remains limited');
    expect(authority).toContain('independently proven infeasible');
    expect(authority).toContain('required audience');
    expect(authority).toContain('visibility proof');
    expect(authority).toContain('Every new gate must arrive with its producer in the same change');
    expect(authority).toContain('does not fabricate\nan artifact or treat an orchestrator-only workaround as a producer');
    expect(authority).toContain('the GitHub producer records\nfacts from its authenticated stable reads');
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

describe('Issue #2039 T1 author-disposition producer authority', () => {
  it('routes a harvested T1 author reply through the producer before first architectural start-cycle', () => {
    const start = contract.indexOf('## Review artifacts');
    const end = contract.indexOf('## GitHub issue journal', start);
    const reviewArtifacts = contract.slice(start, end);
    expect(reviewArtifacts).toContain(
      'scripts/create-issue-stage-finalize.ts produce-author-dispositions',
    );
    expect(reviewArtifacts).toContain(
      'before the first `architectural` `start-cycle`',
    );
    expect(reviewArtifacts).toContain(
      'The manager invokes lifecycle, reconciliation and acceptance producers; it does\nnot create or repair these files by hand.',
    );
    expect(reviewArtifacts).toContain(
      'It creates no\nreview cycle, stage receipt, finding ledger, relay evidence, acceptance\nmanifest, reviewer invocation, Issue comment, or label projection.',
    );
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
          buildTerminalBundle: () => bundle,
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

  it('requires a current governed bundle for terminal architectural review before browser delegation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-terminal-bundle-'));
    const previousStateRoot = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = root;
    try {
      const { reviewDir, draft, bundle } = createTerminalBundleFixture(root);
      const t1Root = join(root, 't1-root');
      const t1Dir = join(t1Root, '.review', '1431');
      mkdirSync(t1Dir, { recursive: true });
      const t1Draft = '<!-- source-revision: r01 -->\n\n# T1 fixture\n';
      process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = t1Root;
      writeFileSync(join(t1Dir, 'tier-intake.json'), JSON.stringify({
        schema: 'tier-intake/v1',
        producer: 'fixture',
        taskIdentity: 'issue:1431',
        kind: 'fresh',
        priorTier: 'T1',
        firstRevision: 'r01',
      }, null, 2));
      writeFileSync(join(t1Dir, 'author-dispositions.json'), JSON.stringify({
        schema: 'create-issue-author-dispositions/v1',
        producer: 'lifecycle-zero-state/v1',
        reviewEpisodeId: 'issue:1431@r01',
        sourceRevision: 'r01',
        predecessorStage: null,
        draft: t1Draft,
        findings: [],
        m4: {
          reviewEpisodeId: 'issue:1431@r01',
          sourceRevision: 'r01',
          predecessorStage: null,
          inventory: [],
        },
      }, null, 2));
      writeFileSync(join(t1Dir, 'issue-r01-body.json'), JSON.stringify({
        schema: 'create-issue-live-snapshot/v1',
        issueNumber: 1431,
        sourceRevision: 'r01',
        title: 'T1 fixture',
        body: t1Draft,
      }, null, 2) + '\n');
      const t1Bundle = buildManagerReviewTerminalBundle({
        repositoryFullName: reviewContext.repositoryFullName,
        issueNumber: reviewContext.issueNumber,
        sourceRevision: 'r01',
        reviewDir: t1Dir,
        liveIssueBody: t1Draft,
      });
      const t1AuthorPath = join(t1Dir, 'author-dispositions.json');
      const originalT1Author = readFileSync(t1AuthorPath, 'utf8');
      const nonZeroStateT1Author = JSON.parse(originalT1Author) as {
        m4: { inventory: Array<Record<string, string>> };
      };
      nonZeroStateT1Author.m4.inventory = [{ mechanism: 'fabricated prior state', disposition: 'keep' }];
      writeFileSync(t1AuthorPath, JSON.stringify(nonZeroStateT1Author, null, 2));
      expect(() => buildManagerReviewTerminalBundle({
        repositoryFullName: reviewContext.repositoryFullName,
        issueNumber: reviewContext.issueNumber,
        sourceRevision: 'r01',
        reviewDir: t1Dir,
        liveIssueBody: t1Draft,
      })).toThrow('terminal_bundle_zero_state_m4_invalid');
      writeFileSync(t1AuthorPath, originalT1Author);
      process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = root;
      expect(t1Bundle.predecessorStage).toBeNull();
      expect(t1Bundle.reviewEconomics.stageReceipts).toEqual([]);
      expect(t1Bundle.reviewEconomics.counts).toEqual({
        rawFindingCount: 0,
        distinctFindingCount: 0,
        processedDistinctCount: 0,
      });

      for (const [tier, intakeExtras] of [
        ['T2', {}],
        ['T3', { competitiveDecision: 'required', competitiveRationale: 'fixture rationale' }],
      ] as const) {
        const invalidRoot = join(root, `invalid-${tier.toLowerCase()}`);
        const invalidDir = join(invalidRoot, '.review', '1431');
        process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = invalidRoot;
        mkdirSync(invalidDir, { recursive: true });
        writeFileSync(join(invalidDir, 'tier-intake.json'), JSON.stringify({
          schema: 'tier-intake/v1', producer: 'fixture', taskIdentity: 'issue:1431', kind: 'fresh',
          priorTier: tier, firstRevision: 'r01', ...intakeExtras,
        }, null, 2));
        writeFileSync(join(invalidDir, 'author-dispositions.json'), JSON.stringify({
          schema: 'create-issue-author-dispositions/v1', producer: 'governed-author-output/v1', reviewEpisodeId: 'issue:1431@r01',
          sourceRevision: 'r01', predecessorStage: null, draft: t1Draft, findings: [],
          m4: { reviewEpisodeId: 'issue:1431@r01', sourceRevision: 'r01', predecessorStage: null, inventory: [] },
        }, null, 2));
        writeFileSync(join(invalidDir, 'issue-r01-body.json'), JSON.stringify({
          schema: 'create-issue-live-snapshot/v1',
          issueNumber: 1431,
          sourceRevision: 'r01',
          title: 'T1 fixture',
          body: t1Draft,
        }, null, 2) + '\n');
        expect(() => buildManagerReviewTerminalBundle({
          repositoryFullName: reviewContext.repositoryFullName, issueNumber: reviewContext.issueNumber,
          sourceRevision: 'r01', reviewDir: invalidDir, liveIssueBody: t1Draft,
        })).toThrow('terminal_bundle_predecessor_invalid');
      }
      process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = root;

      const receiptPath = join(reviewDir, 'stage-completeness-receipt-ar.json');
      const originalReceipt = readFileSync(receiptPath, 'utf8');
      const incompleteReceipt = JSON.parse(originalReceipt) as Record<string, unknown>;
      delete incompleteReceipt.settlement;
      writeFileSync(receiptPath, JSON.stringify(incompleteReceipt, null, 2));
      expect(() => buildManagerReviewTerminalBundle({
        repositoryFullName: reviewContext.repositoryFullName, issueNumber: reviewContext.issueNumber,
        sourceRevision: 'r08', reviewDir, liveIssueBody: draft,
      })).toThrow('terminal_bundle_governed_artifacts_invalid');
      writeFileSync(receiptPath, originalReceipt);

      expect(bundle.draft).toBe(draft);
      expect(bundle.rejectPartition).toHaveLength(1);
      expect(bundle.protectedM3).toHaveLength(1);
      expect(bundle.authorM4).toEqual([
        { mechanism: 'terminal prior-state bundle', disposition: 'keep' },
      ]);
      expect(() => buildManagerReviewTerminalBundle({
        repositoryFullName: reviewContext.repositoryFullName,
        issueNumber: reviewContext.issueNumber,
        sourceRevision: 'r08',
        reviewDir,
        liveIssueBody: '<!-- source-revision: r09 -->\nchanged\n',
      })).toThrow('terminal_bundle_live_issue_mismatch');

      const authorPath = join(reviewDir, 'author-dispositions.json');
      const originalAuthor = readFileSync(authorPath, 'utf8');
      const staleM4Author = JSON.parse(originalAuthor) as {
        m4: { sourceRevision: string };
      };
      staleM4Author.m4.sourceRevision = 'r07';
      writeFileSync(authorPath, JSON.stringify(staleM4Author, null, 2));
      expect(() => buildManagerReviewTerminalBundle({
        repositoryFullName: reviewContext.repositoryFullName,
        issueNumber: reviewContext.issueNumber,
        sourceRevision: 'r08',
        reviewDir,
        liveIssueBody: draft,
      })).toThrow('terminal_bundle_author_m4_stale');
      writeFileSync(authorPath, originalAuthor);

      const ledgerPath = join(reviewDir, 'finding-disposition-ledger.json');
      const originalLedger = readFileSync(ledgerPath, 'utf8');
      const conflictingLedger = JSON.parse(originalLedger) as {
        findings: Array<Record<string, unknown>>;
        counts: Record<string, unknown>;
      };
      conflictingLedger.findings[0]!.defectDisposition = 'addressed';
      writeFileSync(ledgerPath, JSON.stringify(conflictingLedger, null, 2));
      expect(() => buildManagerReviewTerminalBundle({
        repositoryFullName: reviewContext.repositoryFullName,
        issueNumber: reviewContext.issueNumber,
        sourceRevision: 'r08',
        reviewDir,
        liveIssueBody: draft,
      })).toThrow('terminal_bundle_ledger_disposition_mismatch');
      conflictingLedger.findings[0]!.defectDisposition = 'rejected-as-false';
      conflictingLedger.counts.rawFindingCount = 0;
      writeFileSync(ledgerPath, JSON.stringify(conflictingLedger, null, 2));
      expect(() => buildManagerReviewTerminalBundle({
        repositoryFullName: reviewContext.repositoryFullName,
        issueNumber: reviewContext.issueNumber,
        sourceRevision: 'r08',
        reviewDir,
        liveIssueBody: draft,
      })).toThrow('terminal_bundle_review_economics_invalid');
      writeFileSync(ledgerPath, originalLedger);

      const terminalContext: ManagerReviewBriefContext = {
        ...reviewContext,
        sourceRevision: 'r08',
        stage: 'architectural',
        terminalBundle: bundle,
      };
      expect(() => renderManagerReviewBrief(
        readManagerReviewCanon(),
        { ...terminalContext, terminalBundle: undefined },
      )).toThrow('canonical_prompt_terminal_bundle_missing');

      const promptPath = join(root, 'terminal-review.txt');
      const bundlePath = join(root, 'terminal-bundle.json');
      const rendered = renderManagerReviewBrief(readManagerReviewCanon(), terminalContext);
      writeFileSync(promptPath, rendered.text);
      writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
      expect(rendered.text).toContain('## Governed terminal prior-state bundle');
      expect(rendered.text).toContain('"reviewEpisodeId": "issue:1431@r01"');

      const delegated: string[][] = [];
      const args = [
        'turn',
        '--invocation-id', terminalContext.invocationId,
        '--input', promptPath,
        '--reviewer-source-output', join(root, 'source.txt'),
        '--reviewer-source', 'direct-publication/v1',
        '--repository', terminalContext.repositoryFullName,
        '--issue-number', String(terminalContext.issueNumber),
        '--source-revision', terminalContext.sourceRevision,
        '--stage', terminalContext.stage,
        '--source-slot', terminalContext.sourceSlot,
        '--terminal-input-bundle', bundlePath,
        '--review-dir', reviewDir,
      ];
      expect(await runStateLightEntry(args, {
        runTurn: async (argv) => {
          delegated.push([...argv]);
          return 0;
        },
        buildTerminalBundle: () => bundle,
      })).toBe(0);
      expect(delegated).toHaveLength(1);
      expect(delegated[0]).not.toContain('--terminal-input-bundle');

      writeFileSync(bundlePath, `${JSON.stringify({ ...bundle, sourceRevision: 'r09' }, null, 2)}\n`);
      const stdout = captureWrite(process.stdout);
      try {
        const before = delegated.length;
        expect(await runStateLightEntry(args, {
          runTurn: async (argv) => {
            delegated.push([...argv]);
            return 0;
          },
          buildTerminalBundle: () => bundle,
        })).not.toBe(0);
        expect(delegated).toHaveLength(before);
        const refusal = JSON.parse(stdout.chunks.join('').trim()) as {
          cause: string;
          send_count: number;
        };
        expect(refusal.cause).toBe('canonical_prompt_terminal_bundle_stale');
        expect(refusal.send_count).toBe(0);
      } finally {
        stdout.restore();
      }

      const missingBundleStdout = captureWrite(process.stdout);
      try {
        const withoutBundle = args.filter((token, index) => token !== '--terminal-input-bundle' && args[index - 1] !== '--terminal-input-bundle');
        expect(await runStateLightEntry(withoutBundle, {
          runTurn: async () => 0,
        })).not.toBe(0);
        const refusal = JSON.parse(missingBundleStdout.chunks.join('').trim()) as {
          cause: string;
          send_count: number;
        };
        expect(refusal.cause).toBe('canonical_prompt_terminal_bundle_missing');
        expect(refusal.send_count).toBe(0);
      } finally {
        missingBundleStdout.restore();
      }
    } finally {
      if (previousStateRoot === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previousStateRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps direct-publication stage binding and operator config ownership aligned with the adapter', () => {
    const adapter = readFileSync(new URL('./flow-manager-browser-gpt-long-run.ts', import.meta.url), 'utf8');
    const monitoringRule = readFileSync(new URL('../.cursor/rules/flow-manager-browser-turn-monitoring.mdc', import.meta.url), 'utf8');
    expect(browserRunbook).toContain('--stage-attempt-id "${STAGE_ATTEMPT_ID}"');
    expect(adapter).toContain("'stage-attempt-id'");
    expect(monitoringRule).toContain('--operator-browser-config <absolute-path>');
    expect(monitoringRule).toContain('Never copy `local.config.json`');
    expect(monitoringRule).not.toContain('copy `local.config.json` from the operator checkout');
  });

  it('routes a stale direct-publication handoff receipt to readonly reconciliation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-create-issue-stale-handoff-'));
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    const stderr = captureWrite(process.stderr);
    try {
      const handoff = join(root, 'handoff.json');
      writeFileSync(handoff, JSON.stringify({
        schema: HANDOFF_SCHEMA,
        run_identity: 'older-run',
        attempt_identity: 'older-attempt',
      }));
      const code = await runBrowserAdapter([
        '--run-identity', 'current-run',
        '--attempt-identity', 'current-attempt',
        '--handoff-receipt', handoff,
        '--invocation-id', reviewContext.invocationId,
        '--terminal-envelope', join(root, 'terminal.json'),
        '--output', join(root, 'output.json'),
        '--profile', root,
        '--cdp', 'http://127.0.0.1:9222',
        '--input', join(root, 'input.txt'),
        '--reviewer-source-output', join(root, 'source.txt'),
        '--reviewer-source', 'slot-01#capture=direct-publication/v1',
        '--repository', reviewContext.repositoryFullName,
        '--issue-number', String(reviewContext.issueNumber),
        '--source-revision', reviewContext.sourceRevision,
        '--stage', reviewContext.stage,
        '--source-slot', reviewContext.sourceSlot,
        '--stage-attempt-id', 'stage-attempt-r07',
      ]);
      expect(code).toBe(3);
      const output = JSON.parse(logs.at(-1) ?? '{}') as Record<string, unknown>;
      expect(output).toMatchObject({
        ok: false,
        cause: 'stale_handoff_receipt',
        nextAction: {
          kind: 'reconcile-stage-read-only',
          binding: {
            repository: reviewContext.repositoryFullName,
            issueNumber: reviewContext.issueNumber,
            sourceRevision: reviewContext.sourceRevision,
            stage: reviewContext.stage,
            stageAttemptId: 'stage-attempt-r07',
          },
        },
      });
    } finally {
      logSpy.mockRestore();
      stderr.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('revalidates a preflight retry against the live Issue before any lifecycle mutation or Browser-GPT launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-create-issue-browser-stale-retry-'));
    const stderr = captureWrite(process.stderr);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    try {
      const argv = [
        '--run-identity', 'run-stale-retry',
        '--attempt-identity', 'attempt-stale-retry',
        '--handoff-receipt', join(root, 'handoff.json'),
        '--invocation-id', reviewContext.invocationId,
        '--terminal-envelope', join(root, 'terminal.json'),
        '--output', join(root, 'output.json'),
        '--profile', root,
        '--cdp', 'http://127.0.0.1:9222',
        '--input', join(root, 'input.txt'),
        '--reviewer-source-output', join(root, 'source.txt'),
        '--reviewer-source', 'slot-01#capture=direct-publication/v1',
        '--repository', reviewContext.repositoryFullName,
        '--issue-number', String(reviewContext.issueNumber),
        '--source-revision', reviewContext.sourceRevision,
        '--stage', reviewContext.stage,
        '--source-slot', reviewContext.sourceSlot,
        '--stage-attempt-id', 'stage-attempt-r07',
      ];
      const spawnLauncher = vi.fn(async () => 10001);
      const first = await runBrowserAdapter(argv, {
        runPreflight: (input) => ({
          ok: false,
          schema: 'create-issue-browser-gpt-preflight/v1',
          cause: 'target_repository_unavailable',
          blocker: 'fixture transport failure',
          remedy: 'retry',
          nextAction: createIssueNextAction({
            kind: 'retry-create-issue-browser-preflight',
            binding: input.binding!,
            argv: input.retryArgv!,
          }),
        }),
        spawnLauncher,
      });
      expect(first).toBe(3);
      const firstResult = JSON.parse(logs.at(-1) ?? '{}') as {
        nextAction?: { argv?: string[] };
      };
      const retryCommand = firstResult.nextAction?.argv ?? [];
      expect(retryCommand.length).toBeGreaterThan(3);
      logs.length = 0;

      const inspectLifecycleBinding = vi.fn();
      const recordAdmission = vi.fn();
      const retry = await runBrowserAdapter(retryCommand.slice(3), {
        runPreflight: () => ({
          ok: true,
          schema: 'create-issue-browser-gpt-preflight/v1',
          principalLogin: 'chetwerikoff',
          repository: reviewContext.repositoryFullName,
          config: {
            projectUrl: 'https://chatgpt.com/g/g-test/project',
            chromeUserDataDir: root,
            source: 'operator-config',
            operatorConfigPath: join(root, 'local.config.json'),
          },
          childEnv: {
            DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/g-test/project',
            DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: root,
          },
          nextAction: null,
        }),
        readIssueRevision: () => ({
          title: 'fixture',
          body: '<!-- source-revision: r08 -->\nfixture',
          labels: [],
        }),
        inspectLifecycleBinding,
        recordAdmission,
        spawnLauncher,
      });
      expect(retry).toBe(3);
      const stale = JSON.parse(logs.at(-1) ?? '{}') as Record<string, unknown>;
      expect(stale).toMatchObject({
        schema: 'create-issue-stale-next-action/v1',
        cause: 'stale_next_action',
        nextAction: { kind: 'reconcile-stage-read-only' },
        observed: { sourceRevision: 'r08' },
      });
      expect(inspectLifecycleBinding).not.toHaveBeenCalled();
      expect(recordAdmission).not.toHaveBeenCalled();
      expect(spawnLauncher).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      stderr.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'external reviewer transport causes',
      causes: ['HTTP 503 from GitHub', 'HTTP 503 from GitHub'],
      expectedCode: 4,
      expectedCause: 'external:github_unavailable',
    },
    {
      label: 'non-external reviewer causes',
      causes: ['canonical_input_invalid', 'canonical_input_invalid'],
      expectedCode: 5,
      expectedCause: 'producer_contract_defect',
    },
  ] as const)('classifies exhausted retry budget from recorded $label without a third launch', async ({ causes, expectedCode, expectedCause }) => {
    const root = mkdtempSync(join(tmpdir(), 'opk-create-issue-retry-budget-'));
    const previousStateRoot = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = root;
    const reviewDir = join(root, '.review', String(reviewContext.issueNumber));
    mkdirSync(reviewDir, { recursive: true });
    for (const [index, cause] of causes.entries()) {
      writeFileSync(join(reviewDir, `terminal-01-${index + 1}.json`), JSON.stringify({
        turn_result_cause: cause,
      }));
    }
    writeFileSync(join(reviewDir, 'attempt-001.json'), JSON.stringify({
      stage: reviewContext.stage,
      sourceRevision: reviewContext.sourceRevision,
      stageAttemptId: 'stage-attempt-r07',
      invocations: causes.map((_, index) => ({
        reviewerSlot: reviewContext.sourceSlot,
        attemptOrdinal: index + 1,
        terminalEnvelopePath: `terminal-01-${index + 1}.json`,
      })),
    }));
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    const spawnLauncher = vi.fn(async () => 10001);
    const recordAdmission = vi.fn(() => {
      throw new Error(`reviewerSlot ${reviewContext.sourceSlot} retry budget is exhausted`);
    });
    try {
      const code = await runBrowserAdapter([
        '--run-identity', 'run-retry-budget',
        '--attempt-identity', 'attempt-retry-budget',
        '--handoff-receipt', join(root, 'handoff.json'),
        '--invocation-id', reviewContext.invocationId,
        '--terminal-envelope', join(root, 'terminal.json'),
        '--output', join(root, 'output.json'),
        '--profile', root,
        '--cdp', 'http://127.0.0.1:9222',
        '--input', join(root, 'input.txt'),
        '--reviewer-source-output', join(root, 'source.txt'),
        '--reviewer-source', 'slot-01#capture=direct-publication/v1',
        '--repository', reviewContext.repositoryFullName,
        '--issue-number', String(reviewContext.issueNumber),
        '--source-revision', reviewContext.sourceRevision,
        '--stage', reviewContext.stage,
        '--source-slot', reviewContext.sourceSlot,
        '--stage-attempt-id', 'stage-attempt-r07',
      ], {
        runPreflight: (input) => ({
          ok: true,
          schema: 'create-issue-browser-gpt-preflight/v1',
          principalLogin: 'chetwerikoff',
          repository: reviewContext.repositoryFullName,
          config: {
            projectUrl: 'https://chatgpt.com/g/g-test/project',
            chromeUserDataDir: root,
            source: 'operator-config',
            operatorConfigPath: join(root, 'local.config.json'),
          },
          childEnv: {
            DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/g-test/project',
            DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: root,
          },
          nextAction: null,
        }),
        readIssueRevision: () => ({
          title: 'fixture',
          body: `<!-- source-revision: ${reviewContext.sourceRevision} -->\nfixture`,
          labels: [],
        }),
        inspectLifecycleBinding: () => ({
          ok: true,
          observed: {},
        }),
        recordAdmission,
        spawnLauncher,
      });
      expect(code).toBe(expectedCode);
      const output = JSON.parse(logs.at(-1) ?? '{}') as Record<string, unknown>;
      expect(output).toMatchObject({
        ok: false,
        cause: expectedCause,
        nextAction: null,
      });
      expect(recordAdmission).toHaveBeenCalledTimes(1);
      expect(spawnLauncher).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      if (previousStateRoot === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previousStateRoot;
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

    const terminalStdout = captureWrite(process.stderr);
    try {
      expect(await runBrowserAdapter([
        '--run-identity', 'run-terminal',
        '--attempt-identity', 'attempt-terminal',
        '--handoff-receipt', 'handoff-terminal.json',
        '--invocation-id', reviewContext.invocationId,
        '--terminal-envelope', 'terminal-envelope.json',
        '--output', 'browser-output.json',
        '--reviewer-source-output', 'source.txt',
        '--reviewer-source', 'direct-publication/v1',
        '--repository', reviewContext.repositoryFullName,
        '--issue-number', String(reviewContext.issueNumber),
        '--source-revision', 'r08',
        '--stage', 'architectural',
        '--source-slot', '01',
        '--stage-attempt-id', 'attempt-terminal',
      ])).toBe(3);
      expect(terminalStdout.chunks.join('')).toContain('direct_publication_terminal_bundle_required');
    } finally {
      terminalStdout.restore();
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
      ])).toBe(5);
      expect(stderr.chunks.join('')).toContain('direct_publication_arguments_required');
    } finally {
      stderr.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Issue #2078 complete scenario-1 smoke replay fixture', () => {
  it('replays stale revision reconciliation through terminal stage acceptance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2078-scenario-1-replay-'));
    const stateRoot = join(root, 'state');
    const repo = 'chetwerikoff/orchestrator-pack';
    const issueNumber = 2078;
    const stage = 'architectural-review' as const;
    const liveIssueBody = '<!-- source-revision: r02 -->\nscenario-1 live Issue fixture\n';
    const canonicalAttemptId = semanticStageAttemptId(repo, issueNumber, stage);
    const previousStateRoot = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    const previousHome = process.env.HOME;
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = stateRoot;
    process.env.HOME = root;
    mkdirSync(stateRoot, { recursive: true });
    const state = createMockGhState({
      issue: { title: 'Issue #2078 scenario-1 fixture', body: liveIssueBody, labels: [] },
      nextCommentId: 207800,
    });
    const baseTransport = createMockTransport(state);
    const ghCalls: string[][] = [];
    const fixtureTransport = {
      runGh(argv: string[], timeoutMs?: number) {
        ghCalls.push([...argv]);
        return baseTransport.runGh(argv, timeoutMs);
      },
    };
    const reviewDir = join(stateRoot, '.review', String(issueNumber));
    const reviewEpisodeId = `issue:${issueNumber}@r01`;
    const inputPath = join(root, 'review-input.txt');
    const sourcePath = join(root, 'review-source.txt');
    writeFileSync(inputPath, 'scenario-1 prompt\n');
    writeFileSync(sourcePath, 'scenario-1 source\n');
    ensureLifecycleTierIntake({
      issueNumber,
      tier: 'T2',
      firstRevision: 'r01',
      stateRootOverride: stateRoot,
    });
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(reviewDir, 'author-dispositions.json'), JSON.stringify({
      schema: 'create-issue-author-dispositions/v1',
      producer: 'scenario-1-fixture',
      reviewEpisodeId,
      sourceRevision: 'r02',
      predecessorStage: null,
      draft: liveIssueBody,
      findings: [],
      m4: { reviewEpisodeId, sourceRevision: 'r02', predecessorStage: null, inventory: [] },
    }, null, 2));
    writeFileSync(join(reviewDir, 'finding-disposition-ledger.json'), JSON.stringify({
      version: 2,
      reviewEpisodeId,
      sourceRevision: 'r02',
      predecessorStage: null,
      draft: liveIssueBody,
      counts: { rawFindingCount: 0, distinctFindingCount: 0, processedDistinctCount: 0 },
      findings: [],
    }, null, 2));
    writeFileSync(join(reviewDir, 'issue-r02-body.json'), JSON.stringify({
      schema: 'create-issue-live-snapshot/v1',
      issueNumber,
      sourceRevision: 'r02',
      title: state.issue.title,
      body: liveIssueBody,
    }, null, 2) + '\n');
    writeFileSync(join(reviewDir, 'review-episode-inventory.json'), JSON.stringify({
      source: 'canonical-review-directory',
      taskIdentity: `issue:${issueNumber}`,
      episodeFirstRevision: 'r01',
      reviewEpisodeId,
      stageReceiptIds: [],
    }, null, 2));

    const handoffReceipt = join(root, 'handoff.json');
    const terminalEnvelope = join(root, 'terminal.json');
    const browserOutput = join(root, 'browser-output.txt');
    const adapterArgv = (sourceRevision: string, stageAttemptId: string, runIdentity: string, attemptIdentity: string) => [
      '--run-identity', runIdentity,
      '--attempt-identity', attemptIdentity,
      '--handoff-receipt', handoffReceipt,
      '--invocation-id', '2078-scenario-1-invocation',
      '--terminal-envelope', terminalEnvelope,
      '--output', browserOutput,
      '--profile', root,
      '--cdp', 'http://127.0.0.1:9222',
      '--input', inputPath,
      '--reviewer-source-output', sourcePath,
      '--reviewer-source', 'slot-01#capture=direct-publication/v1',
      '--repository', repo,
      '--issue-number', String(issueNumber),
      '--source-revision', sourceRevision,
      '--stage', stage,
      '--source-slot', '01',
      '--stage-attempt-id', stageAttemptId,
    ];
    const preflight = () => ({
      ok: true as const,
      schema: 'create-issue-browser-gpt-preflight/v1' as const,
      principalLogin: 'chetwerikoff',
      repository: repo,
      config: {
        projectUrl: 'https://chatgpt.com/g/g-test/project',
        chromeUserDataDir: root,
        source: 'operator-config' as const,
        operatorConfigPath: join(root, 'local.config.json'),
      },
      childEnv: {
        DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/g-test/project',
        DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: root,
      },
      nextAction: null,
    });
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    const stderr = captureWrite(process.stderr);
    const spawnLauncher = vi.fn(async (launcherArgs: readonly string[]) => {
      const valueAfter = (flag: string): string => {
        const index = launcherArgs.indexOf(flag);
        const value = index >= 0 ? launcherArgs[index + 1] : undefined;
        if (typeof value !== 'string') throw new Error(`fixture launcher missing ${flag}`);
        return value;
      };
      writeFileSync(valueAfter('--handoff-receipt'), JSON.stringify({
        schema: HANDOFF_SCHEMA,
        run_identity: valueAfter('--run-identity'),
        attempt_identity: valueAfter('--attempt-identity'),
        launcher_started_at: '2026-09-23T00:00:00.000Z',
        handoff_committed_at: '2026-09-23T00:00:00.001Z',
        completion_mode: 'browser-turn-result-v1',
      }));
      return 2078001;
    });

    try {
      const first = await runBrowserAdapter(adapterArgv('r01', 'scenario-1-r01-attempt', 'scenario-1-run-r01', 'scenario-1-attempt-r01'), {
        runPreflight: preflight,
        readIssueRevision: () => ({ title: state.issue.title, body: liveIssueBody, labels: [] }),
        inspectLifecycleBinding: vi.fn(),
        recordAdmission: vi.fn(),
        spawnLauncher,
      });
      expect(first).toBe(3);
      expect(logs).toHaveLength(1);
      const stale = JSON.parse(logs[0]!) as {
        ok: boolean;
        cause: string;
        nextAction: { kind: string; binding: Record<string, unknown>; argv: string[] };
      };
      expect(stale).toMatchObject({
        ok: false,
        cause: 'stale_next_action',
        nextAction: {
          kind: 'reconcile-stage-read-only',
          binding: { sourceRevision: 'r01', stageAttemptId: 'scenario-1-r01-attempt' },
        },
      });
      expect(spawnLauncher).not.toHaveBeenCalled();
      logs.length = 0;

      defaultGhTransportSlot.current = fixtureTransport;
      const cliArgv = (argv: string[]) => argv.filter((token) => token !== '--experimental-strip-types');
      const reconciledCode = runStageFinalizeCli(cliArgv(stale.nextAction.argv));
      expect(reconciledCode).toBe(3);
      expect(logs).toHaveLength(1);
      const reconciled = JSON.parse(logs[0]!) as {
        ok: boolean;
        cause: string;
        nextAction: { kind: string; binding: Record<string, unknown>; argv: string[] };
      };
      expect(reconciled.cause, logs[0]).toBe('reconciliation_failed');
      expect(reconciled.nextAction.binding.stageAttemptId).not.toBe('scenario-1-r01-attempt');
      expect(reconciled.nextAction.argv).toContain('r02');
      expect(reconciled.nextAction.argv).toContain(canonicalAttemptId);
      expect(ghCalls.some((argv) => argv.includes('--jq') && argv.some((value) => value.includes(`/issues/${issueNumber}`)))).toBe(true);
      logs.length = 0;
      const startedCode = runStageFinalizeCli(cliArgv(reconciled.nextAction.argv));
      expect(startedCode).toBe(0);
      expect(logs).toHaveLength(1);
      const started = JSON.parse(logs[0]!) as {
        ok: boolean;
        cause: string;
        nextAction: null;
        stageAttemptId?: string;
        cycleId?: string;
      };
      expect(started).toMatchObject({
        ok: true,
        cause: 'completed',
        nextAction: null,
        stageAttemptId: canonicalAttemptId,
      });
      expect(started.cycleId).toEqual(expect.any(String));
      const evidencePath = join(reviewDir, 'attempt-001.json');
      const evidenceBeforeBrowser = JSON.parse(readFileSync(evidencePath, 'utf8')) as Record<string, any>;
      const fixtureInvocations = ['02', '03'].map((reviewerSlot) => ({
        schema: 'reviewer-invocation-envelope/v1',
        reviewEpisodeId,
        stageAttemptId: canonicalAttemptId,
        policyVersion: 'triple-source/v1',
        reviewerCardinality: 3,
        cardinalityConfigIdentity: 'triple-source/v1',
        stage,
        sourceRevision: 'r02',
        invocationId: `scenario-1-fixture-${reviewerSlot}`,
        reviewerSlot,
        reviewerOrdinal: Number(reviewerSlot),
        attemptOrdinal: 1,
        retryAttempt: false,
        terminal: true,
        terminalClassification: 'complete',
        sendCount: 1,
        retryClass: 'none',
        revisionCheck: 'matched',
        capacityOutcome: 'admitted',
        capacityWaitMs: 0,
        terminalResultIdentity: `result:scenario-1:fixture-${reviewerSlot}`,
        capture: {
          captureIdentity: `sha256:fixture:scenario-1-${reviewerSlot}`,
          name: `scenario-1-${reviewerSlot}.capture.txt`,
          byteLength: 1,
          sha256: `fixture-${reviewerSlot}`,
          rawFindingCount: 0,
        },
      }));
      evidenceBeforeBrowser.invocations = fixtureInvocations;
      writeFileSync(evidencePath, JSON.stringify(evidenceBeforeBrowser, null, 2) + '\n');
      const seeded = ensureLifecycleStageEvidenceSeed({
        issueNumber, tier: 'T2', stage, stageAttemptId: canonicalAttemptId,
        sourceRevision: 'r02', cycleId: started.cycleId!, stateRootOverride: stateRoot,
      });
      expect(seeded.evidence.stageAttemptId).toBe(canonicalAttemptId);
      logs.length = 0;

      const admissionCalls: unknown[] = [];
      const browserRetry = await runBrowserAdapter(adapterArgv('r02', canonicalAttemptId, 'scenario-1-run-r02', 'scenario-1-attempt-r02'), {
        runPreflight: preflight,
        readIssueRevision: () => ({ title: state.issue.title, body: liveIssueBody, labels: state.issue.labels }),
        inspectLifecycleBinding: (input) => inspectLifecycleInvocationBinding({ ...input, stateRootOverride: stateRoot }),
        recordAdmission: (input) => {
          admissionCalls.push(input);
          return recordLifecycleInvocationAdmission({ ...input, stateRootOverride: stateRoot });
        },
        spawnLauncher,
      });
      expect(browserRetry).toBe(0);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        ok: true,
        cause: 'completed',
        nextAction: null,
        completion_mode: 'browser-turn-result-v1',
      });
      expect(spawnLauncher).toHaveBeenCalledTimes(1);
      expect(admissionCalls).toHaveLength(1);
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as Record<string, any>;
      expect(evidence.invocations).toHaveLength(3);
      const admittedInvocation = evidence.invocations.find((item: Record<string, unknown>) => item.invocationId === '2078-scenario-1-invocation');
      expect(admittedInvocation).toMatchObject({ reviewerSlot: '01', sourceRevision: 'r02' });

      const browserText = 'scenario-1 completed browser evidence\n';
      writeFileSync(browserOutput, browserText);
      writeFileSync(sourcePath, 'scenario-1 reviewer source\n');
      writeFileSync(terminalEnvelope, JSON.stringify({
        schema: TERMINAL_SCHEMA,
        run_identity: 'scenario-1-run-r02',
        attempt_identity: 'scenario-1-attempt-r02',
        completion_mode: 'browser-turn-result-v1',
        handoff_receipt_path: handoffReceipt,
        launcher_started_at: '2026-09-23T00:00:00.000Z',
        handoff_committed_at: '2026-09-23T00:00:00.001Z',
        terminal_at: '2026-09-23T00:00:00.002Z',
        lifecycle_outcome: 'success',
        delivery: 'landed',
        recovery_available: false,
      }));
      const capture = {
        captureIdentity: 'sha256:fixture:scenario-1-browser-output',
        name: 'scenario-1-browser-output.txt',
        byteLength: Buffer.byteLength(browserText),
        sha256: createHash('sha256').update(browserText, 'utf8').digest('hex'),
        rawFindingCount: 0,
      };
      evidence.invocations = evidence.invocations.map((invocation: Record<string, unknown>) => invocation.invocationId === '2078-scenario-1-invocation'
        ? {
            ...invocation,
            terminal: true,
            terminalClassification: 'complete',
            sendCount: 1,
            retryClass: 'none',
            terminalResultIdentity: 'result:scenario-1:complete',
            capture,
          }
        : invocation);
      evidence.revisionChecks = { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' };
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
      const receipt = {
        schema: 'stage-completeness-receipt/v1',
        tier: 'T2',
        taskIdentity: `issue:${issueNumber}`,
        episodeFirstRevision: 'r01',
        reviewEpisodeId,
        stage,
        stageAttemptId: canonicalAttemptId,
        stageSequence: 1,
        cycleId: started.cycleId,
        policyVersion: 'triple-source/v1',
        reviewerCardinality: 3,
        completedSourceCount: 3,
        sourceRevision: 'r02',
        outcome: 'complete',
        producerEvidence: 'not-applicable',
        tierTransition: 'none',
        cycleBinding: { cycleId: started.cycleId, sourceRevision: 'r02', boundBeforeLaunch: true },
        invocations: evidence.invocations,
        credentialingCaptures: evidence.invocations.map((invocation: Record<string, any>) => invocation.capture),
        settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
      };
      const published = publishSettledStageRecord(fixtureTransport, {
        repo, issueNumber, receipt, workdir: join(root, 'journal'),
      });
      expect(published.ok).toBe(true);
      const receiptPath = join(reviewDir, 'stage-completeness-receipt-architectural-review.json');
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
      const authorityAfter = loadCanonicalLifecycleAuthority(issueNumber, stateRoot);
      expect(authorityAfter.receiptValues).toHaveLength(1);
      expect(authorityAfter.receiptValues[0]).toMatchObject({ outcome: 'complete', stageAttemptId: canonicalAttemptId, sourceRevision: 'r02' });
      const acceptance = evaluateStageCredentialingSettlement(authorityAfter.receiptValues[0], 3, stage, 'final-acceptance');
      expect(acceptance).toMatchObject({ credentialed: true, errors: [], missingSlots: [] });

      const terminalWorkerEvents: Array<{ type: 'worker_done'; outcome: 'succeeded' | 'failed' }> = [];
      const managerHarness = (accepted: boolean) => {
        if (!accepted) throw new Error('whole-task acceptance was not proven');
        terminalWorkerEvents.push({ type: 'worker_done', outcome: 'succeeded' });
      };
      managerHarness(acceptance.credentialed && (authorityAfter.receiptValues[0] as Record<string, unknown>)?.outcome === 'complete');
      expect(terminalWorkerEvents).toHaveLength(1);
      expect(terminalWorkerEvents).toEqual([{ type: 'worker_done', outcome: 'succeeded' }]);
      expect(terminalWorkerEvents.filter((event) => event.outcome === 'failed')).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
      stderr.restore();
      defaultGhTransportSlot.current = undefined;
      if (previousStateRoot === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previousStateRoot;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
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



describe('Issue #1953 manager-controlled Browser-GPT review convergence contract', () => {
  const executeSkill = readFileSync(
    new URL('../.cursor/skills/execute-issue-with-gpt/SKILL.md', import.meta.url),
    'utf8',
  );
  const executionRunbook = readFileSync(
    new URL('../docs/chatgpt-task-execution-runbook.md', import.meta.url),
    'utf8',
  );
  const orchestrationRunbook = readFileSync(
    new URL('../docs/orchestration-runbook.md', import.meta.url),
    'utf8',
  );
  const smokeRunbook = readFileSync(
    new URL('../docs/worker-smoke-testing.md', import.meta.url),
    'utf8',
  );

  it('routes candidate-complete Browser-GPT implementation into the canonical manager review phase', () => {
    expect(executeSkill).toContain('reusable manager-owned PR-review convergence phase');
    expect(executeSkill).toContain('npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>');
    expect(executeSkill).toContain('does not report overall `VERIFIED_COMPLETE`');
    expect(executionRunbook).toContain('## Manager-owned PR-review convergence');
    expect(executionRunbook).toContain(
      'npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>',
    );
    expect(executionRunbook).toContain(
      'does not create scheduler `ready_for_review`, WorkerReport/WorkerStatus',
    );
  });

  it('requires three fresh reviewer chats and one fresh fixer per findings round', () => {
    expect(executionRunbook).toContain('`PACK_GPT_BROWSER_PROJECT_URL` is present');
    expect(executionRunbook).toContain('`PACK_GPT_BROWSER_CHAT_URL` is absent');
    expect(executionRunbook).toMatch(
      /source slots `source-01\.\.03` as independent fresh\s+ChatGPT project chats/,
    );
    expect(executionRunbook).toMatch(
      /implementation conversation, fixer conversations, and sibling\s+reviewer conversations are never reused as reviewer sources/,
    );
    expect(executionRunbook).toContain(
      'one **fresh GPT fixer conversation for that findings-bearing round**',
    );
    expect(executionRunbook).toMatch(
      /reviewer-authored runner-bound GitHub source comments plus canonical runner\s+state are the progression authority/,
    );
  });

  it('preserves logical-round caps and the existing 15-minute recovery authority', () => {
    expect(executionRunbook).toContain('T1 -> 1 logical round x 3 GPT sources');
    expect(executionRunbook).toContain('T2 -> 1 logical round x 3 GPT sources');
    expect(executionRunbook).toContain('T3 -> 2 logical rounds x 3 GPT sources');
    expect(executionRunbook).toContain('do not launch a cap+1 round');
    expect(executionRunbook).toContain(
      'scripts/pack-review-runner.ts reconcile \\',
    );
    expect(executionRunbook).toMatch(
      /still generating below 15 minutes remains\s+active and receives no replacement/,
    );
    expect(executionRunbook).not.toContain('16-minute');
  });

  it('ends manager work at an exact settled-review handoff and keeps overall completion supervisor-owned', () => {
    expect(executionRunbook).toContain('### Settled-review manager handoff');
    expect(executionRunbook).toContain('next legal action: **launch local independent-smoke worker**');
    expect(executionRunbook).toMatch(
      /The manager\s+does not run independent smoke itself/,
    );
    expect(executionRunbook).toMatch(
      /Overall `VERIFIED_COMPLETE` is\s+possible only after independent smoke passes on the final exact head/,
    );
    expect(orchestrationRunbook).toContain(
      'manager whole-role Task/Dispatch handoff',
    );
    expect(orchestrationRunbook).toContain(
      'orchestrator launches/reuses a local supervised worker as independent-smoke parent',
    );
    expect(orchestrationRunbook).toContain(
      'does not wait for scheduler\n`ready_for_review`',
    );
  });

  it('keeps ordinary worker smoke-before-review while exempting only the manager-controlled Browser-GPT path', () => {
    const ordinaryStart = smokeRunbook.indexOf('### Ordinary local coding-worker path');
    const managerStart = smokeRunbook.indexOf('### Manager-controlled Browser-GPT path');
    const nextSection = smokeRunbook.indexOf('## Pre-smoke prerequisite preparation', managerStart);
    expect(ordinaryStart).toBeGreaterThanOrEqual(0);
    expect(managerStart).toBeGreaterThan(ordinaryStart);
    expect(nextSection).toBeGreaterThan(managerStart);

    const ordinary = smokeRunbook.slice(ordinaryStart, managerStart);
    const manager = smokeRunbook.slice(managerStart, nextSection);
    expect(ordinary).toContain('implementation\n  -> worker-owned smoke PASS\n  -> pack-review cycle');
    expect(manager).toContain('manager-owned canonical pack-review cycle');
    expect(manager).toContain('There is no synthetic pre-review worker-owned smoke on this path');
    expect(manager).toContain('supervisor launches local independent-smoke parent');
    expect(manager).toContain('independent finding: local worker fix + fresh independent smoke');
    expect(manager).not.toContain('-> worker-owned smoke PASS');
  });
});

describe('Issue #2050 execute-Issue identity-bound re-observation contract', () => {
  const executeSkill = readFileSync(
    new URL('../.cursor/skills/execute-issue-with-gpt/SKILL.md', import.meta.url),
    'utf8',
  );
  const executionRunbook = readFileSync(
    new URL('../docs/chatgpt-task-execution-runbook.md', import.meta.url),
    'utf8',
  );
  const transportReadme = readFileSync(
    new URL('./chatgpt-browser-turn/README.md', import.meta.url),
    'utf8',
  );
  const compact = (value: string) => value.replace(/\s+/gu, ' ').trim();

  it('binds execute-Issue checkpoint inspection to the exact durable invocation without fallback', () => {
    const skill = compact(executeSkill);
    const execution = compact(executionRunbook);
    const shared = compact(browserRunbook);
    const transport = compact(transportReadme);

    expect(skill).toContain(
      'browser-gpt-page-probe inspect --cdp <exact retained endpoint> --profile <exact retained configured profile> --invocation-id <exact retained invocation id>',
    );
    expect(execution).toContain(
      'browser-gpt-page-probe inspect --cdp <exact retained endpoint> --profile <exact retained configured profile> --invocation-id <exact retained invocation id>',
    );
    expect(shared).toContain(
      '`--profile` and `--invocation-id` are a pair. Identity-bound inspect derives the configured profile key and reads exactly that `state-light-turn-observation/v1` record.',
    );
    expect(shared).toContain(
      'there is no sibling-record, alternate-profile, or page-wide marker fallback',
    );
    expect(shared).toContain(
      '`not_sent` and `prepared` project no marker and therefore no recovery cause',
    );
    expect(shared).toContain(
      'different historical transport markers elsewhere on the page are irrelevant',
    );
    expect(transport).toContain(
      '`--profile` and `--invocation-id` must be supplied together',
    );
    expect(transport).toContain(
      '`diagnostic_only: true`, and `workflow_authority: none`',
    );
    expect(transport).toContain(
      'Its snapshot omits prompt/marker text witnesses',
    );
  });

  it('keeps observer-slice expiry non-terminal and one post-checkpoint budget non-resetting', () => {
    const skill = compact(executeSkill);
    const execution = compact(executionRunbook);

    expect(skill).toContain(
      'A bounded observer/wait slice is not the lifetime of the Browser-GPT turn.',
    );
    expect(skill).toContain(
      'preserves the exact run identity, attempt identity, invocation id, profile, CDP endpoint, and conversation binding',
    );
    expect(execution).toContain(
      'treat expiry or loss of a bounded observer/wait slice as observation loss only. It does not settle the turn.',
    );
    expect(execution).toContain(
      'Preserve the exact run identity, attempt identity, invocation id, profile, CDP endpoint, and conversation binding',
    );
    expect(skill).toContain(
      'The first post-checkpoint continuation starts one recovery-observation episode with the existing `DEFAULT_TIMEOUT_MS = 1_800_000 ms` ceiling',
    );
    expect(execution).toContain(
      'The first post-checkpoint continuation starts one recovery-observation episode whose total automatic-continuation ceiling is the existing `DEFAULT_TIMEOUT_MS = 1_800_000 ms`',
    );
    expect(execution).toContain(
      'every later slice consumes the same remaining budget and cannot reset or extend it',
    );
    expect(execution).toContain(
      'stop automatic re-observation and hand the exact fail-closed condition to the existing supervisor boundary',
    );
    expect(execution).toContain(
      'send zero new user messages and continue observation of the same invocation inside the one post-checkpoint recovery-observation episode',
    );
  });

  it('keeps D2 as manager contract evidence rather than a new executable recovery state machine', () => {
    const skill = compact(executeSkill);
    const execution = compact(executionRunbook);
    expect(skill).toContain(
      'Exhaustion creates no resend, replacement-invocation, or fresh-chat authority.',
    );
    expect(execution).toContain(
      'Exhaustion grants no resend, replacement invocation, or fresh-chat authority',
    );
    expect(execution).toContain(
      'do not add a second monitor, watcher, daemon, polling loop, durable timer, or recovery store',
   );
    expect(pageProbe).not.toContain('recoveryObservationEpisodeStore');
    expect(pageProbe).not.toContain('replacementEligible');
  });
});

describe('Issue #2004 derived external-dependency parking contract', () => {
  const orchestrationRunbook = readFileSync(
    new URL('../docs/orchestration-runbook.md', import.meta.url),
    'utf8',
  );
  const chatExecutorRules = readFileSync(
    new URL('../docs/chat-executor-rules.md', import.meta.url),
    'utf8',
  );
  const issueBlockedOn = {
    issue: 1977,
    condition: 'issue_closed',
    evidence: 'coordinator parking replay waits for Issue #1977 to close',
  } as const;
  const prBlockedOn = {
    pr: 1885,
    condition: 'pr_merged',
    evidence: 'already-satisfied wake observes PR #1885 merged',
  } as const;

  function wakeProjection(
    blockedOn: typeof issueBlockedOn | typeof prBlockedOn,
    observed: { issueState?: 'open' | 'closed'; prMerged?: boolean },
  ) {
    expect(validateCreateIssueBlockedOn(blockedOn)).toEqual([]);
    if ('issue' in blockedOn) {
      return {
        read: { selector: 'issue', number: blockedOn.issue, field: 'state' },
        state: observed.issueState === 'closed' ? 'resume' : 'parked',
        unchangedRedispatches: 0,
      } as const;
    }
    return {
      read: { selector: 'pr', number: blockedOn.pr, field: 'merged' },
      state: observed.prMerged === true ? 'resume' : 'parked',
      unchangedRedispatches: 0,
    } as const;
  }

  it('replays #926-b with one waiting-on-issue external_pause and zero unchanged reconcile redispatch until #1977 closes', () => {
    const emittedManagerResults = [projectBlockedOnToExternalPause(issueBlockedOn)];
    const firstWake = wakeProjection(issueBlockedOn, { issueState: 'open' });
    const secondWake = wakeProjection(issueBlockedOn, { issueState: 'open' });
    const closedWake = wakeProjection(issueBlockedOn, { issueState: 'closed' });

    expect(emittedManagerResults).toHaveLength(1);
    expect(emittedManagerResults[0]).toMatchObject({
      cause: 'external:waiting_on_issue',
      nextAction: null,
      pause: {
        resume_when: { issue: 1977, condition: 'issue_closed' },
        evidence: issueBlockedOn.evidence,
      },
    });
    expect(firstWake).toEqual({
      read: { selector: 'issue', number: 1977, field: 'state' },
      state: 'parked',
      unchangedRedispatches: 0,
    });
    expect(secondWake.state).toBe('parked');
    expect(secondWake.unchangedRedispatches).toBe(0);
    expect(closedWake.state).toBe('resume');
  });

  it('resumes immediately when the typed predicate is already satisfied at wake start', () => {
    expect(wakeProjection(issueBlockedOn, { issueState: 'closed' })).toMatchObject({
      read: { selector: 'issue', number: 1977, field: 'state' },
      state: 'resume',
    });
    expect(wakeProjection(prBlockedOn, { prMerged: true })).toMatchObject({
      read: { selector: 'pr', number: 1885, field: 'merged' },
      state: 'resume',
    });
  });

  it('guards the canonical authority boundary, derived parking, and compact dispatch payload', () => {
    for (const required of [
      '## Structured external-dependency parking',
      'projects it to\n`external_pause(external:waiting_on_issue|external:waiting_on_pr)`',
      'On `recoverable` execute the returned `nextAction.argv` once',
      'If the next\nresult recommends a byte-identical argv, do not execute it again',
      'Before ending a turn without\n`worker_done`, drain the inbox',
      'Never send `worker_done --outcome failed` for\nany of these',
      'Derive `escalation-id` deterministically from\n`(issue, stage, cause, resume_when)`',
      'If the escalation send\nitself fails, retry it exactly once',
      'A live Dispatch whose most recent manager message is that escalation is a\n**paused unit**',
      'must not re-dispatch the same argv into it',
      'Until a separate coordinator sweep/wake\nchange lands',
      'Browser-GPT\n`TerminalEnvelope` remains a separate transport and is unchanged',
    ]) {
      expect(orchestrationRunbook).toContain(required);
    }
    expect(chatExecutorRules).toContain('### Structured external-dependency parking');
    expect(chatExecutorRules).toContain('is a **paused unit** when');
    expect(chatExecutorRules).toContain('do not re-dispatch the same argv into it');
    expect(chatExecutorRules).toContain('Browser-GPT `TerminalEnvelope` remains a separate unchanged\ntransport');
  });
});

describe('Issue #1954 standalone GPT PR-review manager entry contract', () => {
  const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  const reviewSkill = readFileSync(
    new URL('../.cursor/skills/review-pr-with-gpt/SKILL.md', import.meta.url),
    'utf8',
  );
  const reviewPointer = readFileSync(
    new URL('../.claude/skills/review-pr-with-gpt/SKILL.md', import.meta.url),
    'utf8',
  );
  const executeSkill = readFileSync(
    new URL('../.cursor/skills/execute-issue-with-gpt/SKILL.md', import.meta.url),
    'utf8',
  );
  const executionRunbook = readFileSync(
    new URL('../docs/chatgpt-task-execution-runbook.md', import.meta.url),
    'utf8',
  );

  const normalizedAgents = agents.replace(/\s+/g, ' ').trim();

  it('routes orchestrator implementation-review intent without stealing direct chat or existing Issue flows', () => {
    expect(normalizedAgents).toContain(
      '| [`review-pr-with-gpt`](.cursor/skills/review-pr-with-gpt/SKILL.md)',
    );
    expect(normalizedAgents).toContain(
      'when acting as orchestrator/supervisor, route an explicit operator request to review an existing implementation PR',
    );
    expect(normalizedAgents).toContain(
      'When acting as the orchestrator/supervisor, exact implementation-review wording such as `PR #N review`, `review PR #N`, `pack review #N`, or `Issue #N review` loads `review-pr-with-gpt`',
    );
    expect(normalizedAgents).toContain(
      'In a standalone connected-GitHub chat reviewer context, a direct top-level PR review or pack-review request remains owned by the connected-GitHub direct-review procedure above and does not activate `review-pr-with-gpt`',
    );
    expect(normalizedAgents).toContain(
      'A direct top-level request to review or pack-review an `orchestrator-pack` PR uses the connected-GitHub direct-review procedure',
    );
    expect(normalizedAgents).toContain(
      '`<Issue> выполни задачу`, `<Issue> выполни Issue`, or `<Issue> доделай Issue` loads `execute-issue-with-gpt`, even when `manager` / `менеджер` also appears',
    );
    expect(normalizedAgents).toContain(
      '`<Issue> manager`, `<Issue> менеджер`, `<Issue> continue review`, and `<Issue> продолжи ревью` load `create-issue-draft`',
    );
    expect(normalizedAgents).toContain(
      'Explicit task-spec review continuation remains with `create-issue-draft`',
    );
    expect(reviewSkill).toContain(
      'Use this skill only when the active role is the orchestrator/supervisor and the\noperator request contains both an exact PR or Issue target',
    );
    expect(reviewSkill).toContain(
      'A connected-GitHub chat executor acting as the direct\nreviewer for a top-level PR review or pack-review request follows the direct-review',
    );
    expect(reviewSkill).toContain(
      'do not activate this skill in\nthat standalone direct-review context',
    );
    expect(reviewSkill).toContain(
      'Ordinary discussion containing “review”\nwithout an exact PR/Issue target does not activate this skill',
    );
  });

  it('binds a direct PR and requires exact Issue-to-PR uniqueness before review effects', () => {
    expect(reviewSkill).toContain('Before any reviewer, fixer, or model effect');
    expect(reviewSkill).toContain('require the exact PR to be **OPEN**');
    expect(reviewSkill).toContain('current exact head, and closing Issue\n   reference');
    expect(reviewSkill).toContain(
      '**exactly one open implementation PR whose closing reference binds\nthat Issue**',
    );
    expect(reviewSkill).toContain('do not guess by branch\nname, recency, author, or first match');
    expect(reviewSkill).toContain('do not fall back to initial\nimplementation');
  });

  it('reuses the existing supervised manager and shared #1953 review phase without duplicating mechanics', () => {
    expect(reviewSkill).toContain('work-class=manager');
    expect(reviewSkill).toContain(
      '[Manager-owned PR-review convergence](../../../docs/chatgpt-task-execution-runbook.md#manager-owned-pr-review-convergence)',
    );
    expect(executionRunbook).toContain('## Manager-owned PR-review convergence');
    expect(reviewSkill).toContain('resume/reconcile that existing authority');
    expect(reviewSkill).toContain('perform no redundant reviewer-model\ncall');
    expect(reviewSkill).not.toContain('PACK_GPT_BROWSER_PROJECT_URL');
    expect(reviewSkill).not.toContain('source-01');
    expect(reviewSkill).not.toContain('pack-review-runner.ts');
  });

  it('keeps pack-review recovery single-owned by the execution runbook with thin skill pointers', () => {
    const ownerRule = 'When the canonical runner returns a runner-owned `nextAction`, execute that';
    expect(executionRunbook).toContain(ownerRule);
    expect(executionRunbook).toContain('A scrubbed foreign-owner diagnostic from another');
    expect(reviewSkill).toContain(
      '[Manager-owned PR-review convergence](../../../docs/chatgpt-task-execution-runbook.md#manager-owned-pr-review-convergence)',
    );
    expect(executeSkill).toContain(
      '[`docs/chatgpt-task-execution-runbook.md`](../../../docs/chatgpt-task-execution-runbook.md)',
    );
    expect(reviewSkill).not.toContain(ownerRule);
    expect(executeSkill).not.toContain(ownerRule);
    expect(reviewSkill).not.toContain('shared_cdp_busy');
    expect(executeSkill).not.toContain('shared_cdp_busy');
  });

  it('keeps completion supervisor-owned and maintains generated Claude pointer parity', () => {
    expect(reviewSkill).toContain('local supervised\nindependent-smoke worker');
    expect(reviewSkill).toContain('Review settlement by\nitself is not overall `VERIFIED_COMPLETE`');
    expect(reviewPointer).toContain('name: review-pr-with-gpt');
    expect(reviewPointer).toContain(
      'Read and execute [`.cursor/skills/review-pr-with-gpt/SKILL.md`]',
    );
    expect(reviewPointer).not.toContain('# review-pr-with-gpt');
  });
});

interface Issue2078FixtureManagerHooks {
  sendEscalation(threadId: string): void;
  drainInbox(): readonly string[];
  executeNextAction(argv: readonly string[]): void;
  sendWorkerDone(): void;
}

function runIssue2078FixtureManager(result: CreateIssueManagerResult, hooks: Issue2078FixtureManagerHooks) {
  let escalationSendAttempts = 0;
  let inboxDrainCalls = 0;
  let actionExecutions = 0;
  let workerDoneCount = 0;
  let escalationThreadId: string | undefined;
  let turnEndedWithoutWorkerDone = false;

  if (result.ok) {
    hooks.sendWorkerDone();
    workerDoneCount += 1;
  } else if ('pause' in result || 'defect' in result) {
    escalationThreadId = createIssueEscalationThreadId({
      issueNumber: 2078,
      stage: 'architectural-review',
      cause: result.cause,
      resumeWhen: 'pause' in result ? result.pause.resume_when : null,
    });
    const send = () => {
      escalationSendAttempts += 1;
      hooks.sendEscalation(escalationThreadId!);
    };
    try {
      send();
    } catch {
      send();
    }
    inboxDrainCalls += 1;
    if (hooks.drainInbox().length !== 0) throw new Error('fixture_manager_inbox_not_drained');
    turnEndedWithoutWorkerDone = workerDoneCount === 0;
  } else {
    actionExecutions += 1;
    hooks.executeNextAction(result.nextAction.argv);
  }

  return {
    escalationThreadId,
    escalationSendAttempts,
    inboxDrainCalls,
    inboxDrained: inboxDrainCalls > 0,
    actionExecutions,
    workerDoneCount,
    turnEndedWithoutWorkerDone,
    taskTerminal: workerDoneCount > 0,
    dispatchTerminal: workerDoneCount > 0,
  };
}

describe('Issue #2078 smoke scenarios 3 and 5 fixture manager', () => {
  const binding = {
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 2078,
    sourceRevision: 'r02',
    stage: 'architectural-review' as const,
    stageAttemptId: 'scenario-3-attempt',
  };

  it('scenario 3 escalates the boundary self-recommendation without re-executing its argv', () => {
    const argv = [
      'node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage',
      '--expected-stage-attempt-id', '316369ff',
    ];
    const boundary = evaluateCreateIssueManagerBoundary({
      producer: 'reconcile-stage',
      currentArgv: argv,
      produce: () => createIssueRecoverableResult({
        cause: 'reconciliation_ready',
        nextAction: createIssueNextAction({
          kind: 'reconcile-stage-read-only',
          binding,
          argv,
        }),
      }),
    });
    const sentThreadIds: string[] = [];
    const executedArgvs: string[][] = [];
    const trace = runIssue2078FixtureManager(boundary.result, {
      sendEscalation: (threadId) => sentThreadIds.push(threadId),
      drainInbox: () => [],
      executeNextAction: (nextArgv) => executedArgvs.push([...nextArgv]),
      sendWorkerDone: () => { throw new Error('unexpected_worker_done'); },
    });
    const expectedThreadId = createIssueEscalationThreadId({
      issueNumber: 2078,
      stage: 'architectural-review',
      cause: 'self_recommendation',
      resumeWhen: null,
    });

    expect(boundary.exitCode).toBe(5);
    expect(boundary.result).toMatchObject({
      ok: false,
      cause: 'self_recommendation',
      defect: { producer: 'reconcile-stage' },
      nextAction: null,
    });
    expect(sentThreadIds).toEqual([expectedThreadId]);
    expect(executedArgvs).toEqual([]);
    expect(trace).toMatchObject({
      escalationThreadId: expectedThreadId,
      escalationSendAttempts: 1,
      inboxDrainCalls: 1,
      inboxDrained: true,
      actionExecutions: 0,
      workerDoneCount: 0,
      turnEndedWithoutWorkerDone: true,
      taskTerminal: false,
      dispatchTerminal: false,
    });
  });

  it('scenario 5 retries one failed escalation send, drains the inbox, and leaves the manager live', () => {
    const result = createIssueExternalPauseResult({
      cause: 'external:github_unavailable',
      remedy: 'resume after the fixture transport becomes available',
      resumeWhen: { operator: true },
      evidence: 'fixture HTTP 503',
    });
    const sentThreadIds: string[] = [];
    const executedArgvs: string[][] = [];
    let sendAttempts = 0;
    let inboxDrainCalls = 0;
    const trace = runIssue2078FixtureManager(result, {
      sendEscalation: (threadId) => {
        sendAttempts += 1;
        if (sendAttempts === 1) throw new Error('fixture_send_rejected_before_delivery');
        sentThreadIds.push(threadId);
      },
      drainInbox: () => {
        inboxDrainCalls += 1;
        return [];
      },
      executeNextAction: (argv) => executedArgvs.push([...argv]),
      sendWorkerDone: () => { throw new Error('unexpected_worker_done'); },
    });
    const expectedThreadId = createIssueEscalationThreadId({
      issueNumber: 2078,
      stage: 'architectural-review',
      cause: 'external:github_unavailable',
      resumeWhen: { operator: true },
    });

    expect(sendAttempts).toBe(2);
    expect(sentThreadIds).toEqual([expectedThreadId]);
    expect(executedArgvs).toEqual([]);
    expect(inboxDrainCalls).toBe(1);
    expect(trace).toMatchObject({
      escalationThreadId: expectedThreadId,
      escalationSendAttempts: 2,
      inboxDrainCalls: 1,
      inboxDrained: true,
      actionExecutions: 0,
      workerDoneCount: 0,
      turnEndedWithoutWorkerDone: true,
      taskTerminal: false,
      dispatchTerminal: false,
    });
  });
});

describe('Issue #2094 execute-Issue product-error continuation contract', () => {
  const executeSkill = readFileSync(new URL('../.cursor/skills/execute-issue-with-gpt/SKILL.md', import.meta.url), 'utf8');
  const executionRunbook = readFileSync(new URL('../docs/chatgpt-task-execution-runbook.md', import.meta.url), 'utf8');

  it('recognizes all three reserved causes and continues in the same owned chat before fallback', () => {
    expect(executeSkill).toContain('`message_delivery_timed_out`, `product_network_error`, and `message_stream_error`');
    expect(executionRunbook).toContain('same exact owned ChatGPT conversation');
    expect(executionRunbook).toContain('Error in message stream');
    expect(executionRunbook).toContain('Never press the product `Retry` control.');
    expect(executionRunbook).toContain('minimum **10-minute grace window**');
  });

  it('requires settlement and unchanged PR, branch, or no-work baseline before replacement', () => {
    expect(executionRunbook).toContain('The 10-minute grace is not turn-settlement');
    expect(executionRunbook).toContain('authoritatively');
    expect(executionRunbook).toContain('**No observed Issue-bound work:** still no Issue-bound PR');
    expect(executionRunbook).toContain('Do not create a replacement branch or PR');
    expect(executionRunbook).toContain('close only the exact old owned');
    expect(executionRunbook).toContain('candidate-complete');
  });

  it('keeps message-stream classification exact and preserves page-probe gates', () => {
    const pageProbe = readFileSync(new URL('./browser-gpt-page-probe.ts', import.meta.url), 'utf8');
    expect(pageProbe).toContain("${JSON.stringify('Error in message stream')}");
    expect(pageProbe).toContain("stripped === STREAM_TEXT + '…'");
    expect(pageProbe).toContain("stripped === STREAM_TEXT + '...'");
    expect(pageProbe).toContain('classifyExecutionRecoveryProductError(');
  });
});
