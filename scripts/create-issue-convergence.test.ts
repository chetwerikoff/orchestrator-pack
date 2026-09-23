import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertCreateIssueActionCurrent,
  createIssueNextAction,
  createIssueRecoverableResult,
  createIssueTerminalResult,
  existingPacedBoundedRetryAction,
  projectBlockedOnToExternalPause,
  projectZeroSendManagerResult,
  validateCreateIssueBlockedOn,
  validateCreateIssueManagerResult,
  validateCreateIssueNextAction,
  type CreateIssueActionBinding,
} from './lib/create-issue-next-action.ts';
import { runStageFinalizeCli } from './lib/create-issue-stage-record-cli.ts';
import { resolveCreateIssueBrowserOperatorConfig } from './lib/create-issue-browser-gpt-preflight.ts';
import {
  reconcileCreateIssueStage,
  produceAcceptanceArtifacts,
  classifyZeroSendCausePolicy,
} from './lib/create-issue-stage-record-artifacts.ts';
import { buildManagerReviewTerminalBundle } from './lib/manager-review-terminal-bundle.ts';
import { canonicalStagePlan } from './lib/create-issue-stage-topology.ts';
import {
  selectPrincipalOwnedCanonicalArtifact,
  sameGithubPrincipal,
  type PrincipalOwnedIssueComment,
} from './lib/create-issue-github-artifact-authority.ts';

const roots: string[] = [];
const originalCreateIssueStateRoot = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-create-issue-convergence-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalCreateIssueStateRoot === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
  else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = originalCreateIssueStateRoot;
});

const binding: CreateIssueActionBinding = {
  repository: 'chetwerikoff/orchestrator-pack',
  issueNumber: 1935,
  sourceRevision: 'r03',
  stage: 'architectural-review',
  stageAttemptId: 'attempt-1935',
};

describe('create-Issue nextAction contract', () => {
  it('uses one validated argv-bearing action shape and terminal null shape', () => {
    const action = createIssueNextAction({
      kind: 'reconcile-stage-read-only',
      binding,
      argv: ['node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage'],
    });
    expect(validateCreateIssueNextAction(action)).toEqual([]);
    const recoverable = createIssueRecoverableResult({ cause: 'observation_lost', nextAction: action });
    expect(recoverable).toMatchObject({
      ok: false,
      cause: 'observation_lost',
      nextAction: action,
    });
    expect(validateCreateIssueManagerResult(recoverable)).toEqual([]);
    const terminal = createIssueTerminalResult({ ok: true, cause: 'completed' });
    expect(terminal).toEqual({
      ok: true,
      cause: 'completed',
      nextAction: null,
    });
    expect(validateCreateIssueManagerResult(terminal)).toEqual([]);
    expect(validateCreateIssueManagerResult({ ok: false, cause: 'stuck', nextAction: null })).toContain(
      'recoverable manager result.nextAction must be non-null',
    );
  });

  it('returns canonical stale_next_action when any state binding moves', () => {
    const action = createIssueNextAction({
      kind: 'reconcile-stage-read-only',
      binding,
      argv: ['node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage'],
    });
    const stale = assertCreateIssueActionCurrent({
      action,
      observed: { ...binding, sourceRevision: 'r04' },
      nextAction: action,
    });
    expect(stale).toMatchObject({
      ok: false,
      schema: 'create-issue-stale-next-action/v1',
      cause: 'stale_next_action',
      binding,
      observed: { sourceRevision: 'r04' },
      nextAction: action,
    });
    expect(validateCreateIssueManagerResult(stale)).toEqual([]);
  });

  it('uses the shared result dialect for journal stage-record continuations and revalidates before mutation', () => {
    const cliSource = readFileSync(join(process.cwd(), 'scripts', 'lib', 'create-issue-stage-record-cli.ts'), 'utf8');
    expect(cliSource).toContain("kind: 'retry-start-cycle'");
    expect(cliSource).toContain("kind: 'retry-stage-record-publication'");
    expect(cliSource).toContain("'stage_record_retry_exhausted'");
    expect(cliSource).toContain("'--expected-source-revision'");
    expect(cliSource).toContain("'--expected-stage'");
    expect(cliSource).toContain("'--expected-stage-attempt-id'");
    expect(cliSource).toContain('validateCreateIssueManagerResult(output)');

    expect(cliSource).toContain('semanticStageAttemptId(opts.repo, issueNumber, stage)');
    expect(cliSource).toContain('stageAttemptId: canonicalAttemptId');
    expect(cliSource).toContain('argv: startCycleRetryArgv(retryOpts, issueNumber, binding)');
    const coreSource = readFileSync(join(process.cwd(), 'scripts', 'lib', 'create-issue-stage-record-core.ts'), 'utf8');
    const functionStart = coreSource.indexOf('export function startReviewCycle(');
    const admission = coreSource.indexOf('admitStageLaunch(admissionInput)', functionStart);
    const projection = coreSource.indexOf('ensureProjectionLabels(transport, input.repo)', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(admission).toBeGreaterThan(functionStart);
    expect(projection).toBeGreaterThan(admission);
    expect(coreSource).toContain('export function semanticStageAttemptId(');
  });
});

describe('structured blocked_on manager contract (Issue #2004)', () => {
  const issueBlockedOn = {
    issue: 1977,
    condition: 'issue_closed',
    evidence: 'slot 01 is blocked on Issue #1977',
  } as const;
  const prBlockedOn = {
    pr: 1885,
    condition: 'pr_merged',
    evidence: 'implementation is blocked on PR #1885 merging',
  } as const;

  it('accepts only the two selector-compatible closed predicate variants', () => {
    expect(validateCreateIssueBlockedOn(issueBlockedOn)).toEqual([]);
    expect(validateCreateIssueBlockedOn(prBlockedOn)).toEqual([]);
    expect(projectBlockedOnToExternalPause(issueBlockedOn)).toMatchObject({
      ok: false,
      cause: 'external:waiting_on_issue',
      pause: {
        resume_when: { issue: 1977, condition: 'issue_closed' },
        evidence: issueBlockedOn.evidence,
      },
      nextAction: null,
    });
    expect(projectBlockedOnToExternalPause(prBlockedOn)).toMatchObject({
      ok: false,
      cause: 'external:waiting_on_pr',
      pause: {
        resume_when: { pr: 1885, condition: 'pr_merged' },
        evidence: prBlockedOn.evidence,
      },
      nextAction: null,
    });

    for (const invalid of [
      { condition: 'issue_closed', evidence: 'missing selector' },
      { issue: 1977, pr: 1885, condition: 'issue_closed', evidence: 'dual selector' },
      { issue: 1977, condition: 'pr_merged', evidence: 'selector mismatch' },
      { pr: 1885, condition: 'issue_closed', evidence: 'selector mismatch' },
      { issue: 0, condition: 'issue_closed', evidence: 'bad selector' },
      { pr: 1885, condition: 'unknown', evidence: 'unknown predicate' },
      { issue: 1977, condition: 'issue_closed', evidence: '' },
      { issue: 1977, condition: 'issue_closed', evidence: 'x', alias: 'not allowed' },
    ]) {
      expect(validateCreateIssueBlockedOn(invalid).length).toBeGreaterThan(0);
    }

    expect(validateCreateIssueManagerResult({
      ok: false,
      cause: 'external_prerequisite',
      blocked_on: issueBlockedOn,
      nextAction: createIssueNextAction({
        kind: 'reconcile-stage-read-only',
        binding,
        argv: ['node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage'],
      }),
    })).toContain('manager result.blocked_on is retired; project the coordinator-supplied predicate to external_pause');

    expect(validateCreateIssueManagerResult({
      ok: true,
      cause: 'completed',
      blocked_on: issueBlockedOn,
      nextAction: null,
    })).toContain('manager result.blocked_on is retired; project the coordinator-supplied predicate to external_pause');
  });

  it.each([
    ['issue predicate', issueBlockedOn],
    ['PR predicate', prBlockedOn],
  ])('propagates an authoritative %s through the stage-record CLI only on terminal null', (_label, blockedOn) => {
    const root = tempRoot();
    const evidencePath = join(root, 'attempt-001.json');
    writeFileSync(
      evidencePath,
      readFileSync(
        join(process.cwd(), 'tests', 'external-output-references', 'create-issue-926-terminal-competitive-01.json'),
        'utf8',
      ),
    );
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    try {
      const code = runStageFinalizeCli([
        'node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage',
        '--repo', 'chetwerikoff/orchestrator-pack',
        '--issue-number', '2004',
        '--review-dir', root,
        '--stage-evidence', evidencePath,
        '--blocked-on-json', JSON.stringify(blockedOn),
        '--json',
      ]);
      expect(code).toBe(4);
      const output = JSON.parse(logs.at(-1) ?? '{}') as Record<string, unknown>;
      expect(output.nextAction).toBeNull();
      expect(output).not.toHaveProperty('blocked_on');
      expect(output.cause).toBe('issue' in blockedOn ? 'external:waiting_on_issue' : 'external:waiting_on_pr');
      expect(output.pause).toMatchObject({
        resume_when: 'issue' in blockedOn
          ? { issue: blockedOn.issue, condition: 'issue_closed' }
          : { pr: blockedOn.pr, condition: 'pr_merged' },
        evidence: blockedOn.evidence,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('omits blocked_on from an unrelated terminal null invocation when the dispatch omits the flag', () => {
    const root = tempRoot();
    const evidencePath = join(root, 'attempt-001.json');
    writeFileSync(
      evidencePath,
      readFileSync(
        join(process.cwd(), 'tests', 'external-output-references', 'create-issue-926-terminal-competitive-01.json'),
        'utf8',
      ),
    );
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    try {
      const code = runStageFinalizeCli([
        'node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage',
        '--repo', 'chetwerikoff/orchestrator-pack',
        '--issue-number', '2004',
        '--review-dir', root,
        '--stage-evidence', evidencePath,
        '--json',
      ]);
      expect(code).toBe(5);
      const output = JSON.parse(logs.at(-1) ?? '{}') as Record<string, unknown>;
      expect(output).toMatchObject({
        cause: 'producer_contract_defect',
        nextAction: null,
      });
      expect(output).not.toHaveProperty('blocked_on');
      expect(output).not.toHaveProperty('pause');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('rejects malformed --blocked-on-json before stage work and leaves TerminalEnvelope unchanged', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = runStageFinalizeCli([
        'node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage',
        '--repo', 'chetwerikoff/orchestrator-pack',
        '--issue-number', '2004',
        '--review-dir', '/unused',
        '--stage-evidence', '/unused/attempt.json',
        '--blocked-on-json', JSON.stringify({
          issue: 1977,
          condition: 'pr_merged',
          evidence: 'selector mismatch',
        }),
        '--json',
      ]);
      expect(code).toBe(5);
      expect(stderr.mock.calls.flat().join('')).toContain('--blocked-on-json is invalid');
    } finally {
      stderr.mockRestore();
    }

    const terminalEnvelopeSource = readFileSync(
      join(process.cwd(), 'scripts', 'flow-manager-long-running-child.ts'),
      'utf8',
    );
    expect(terminalEnvelopeSource).not.toContain('blocked_on');
  });
});

describe('principal-owned reviewer artifact authority', () => {
  const comment = (id: number, userLogin: string | null, body: string): PrincipalOwnedIssueComment => ({
    id,
    body,
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    userLogin,
    htmlUrl: `https://github.com/chetwerikoff/orchestrator-pack/issues/1935#issuecomment-${id}`,
  });

  it('matches authenticated login case-insensitively before uniqueness', () => {
    expect(sameGithubPrincipal('ChetWerikoff', 'chetwerikoff')).toBe(true);
    const selected = selectPrincipalOwnedCanonicalArtifact(
      [comment(1, 'other', 'match'), comment(2, 'CHETWERIKOFF', 'match')],
      'chetwerikoff',
      (candidate) => candidate.body === 'match',
    );
    expect(selected).toMatchObject({ ok: true, principalLogin: 'chetwerikoff', comment: { id: 2 } });
  });

  it('fails closed on duplicate principal-owned canonical matches even when bytes are identical', () => {
    const selected = selectPrincipalOwnedCanonicalArtifact(
      [comment(1, 'chetwerikoff', 'same'), comment(2, 'CHETWERIKOFF', 'same')],
      'chetwerikoff',
      (candidate) => candidate.body === 'same',
    );
    expect(selected).toMatchObject({ ok: false, cause: 'duplicate_principal_owned_match' });
  });

  it('reports wrong publisher rather than treating foreign canonical publication as principal authority', () => {
    const selected = selectPrincipalOwnedCanonicalArtifact(
      [comment(3, 'foreign-reviewer', 'canonical')],
      'chetwerikoff',
      (candidate) => candidate.body === 'canonical',
    );
    expect(selected).toMatchObject({ ok: false, cause: 'wrong_publisher' });
  });
});

describe('create-Issue Browser-GPT operator config', () => {
  it('accepts the two required environment values without a local config copy', () => {
    const root = tempRoot();
    const profile = join(root, 'chrome-profile');
    mkdirSync(profile);
    const result = resolveCreateIssueBrowserOperatorConfig({
      env: {
        DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/g-test/project',
        DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: profile,
      },
    });
    expect(result).toEqual({
      ok: true,
      config: {
        projectUrl: 'https://chatgpt.com/g/g-test/project',
        chromeUserDataDir: profile,
        source: 'environment',
      },
    });
  });

  it('requires one explicit absolute operator-owned config locator when the env pair is incomplete', () => {
    const result = resolveCreateIssueBrowserOperatorConfig({
      env: { DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/g-test/project' },
    });
    expect(result).toMatchObject({
      ok: false,
      cause: 'operator_browser_config_required',
    });
  });

  it('reads only the exact caller-supplied operator config path', () => {
    const root = tempRoot();
    const profile = join(root, 'chrome-profile');
    mkdirSync(profile);
    const configPath = join(root, 'operator-local.config.json');
    writeFileSync(configPath, JSON.stringify({
      projectUrl: 'https://chatgpt.com/g/g-test/project',
      chromeUserDataDir: profile,
    }));
    const result = resolveCreateIssueBrowserOperatorConfig({ env: {}, operatorBrowserConfig: configPath });
    expect(result).toEqual({
      ok: true,
      config: {
        projectUrl: 'https://chatgpt.com/g/g-test/project',
        chromeUserDataDir: profile,
        source: 'operator-config',
        operatorConfigPath: configPath,
      },
    });
  });
});

describe('create-Issue send-boundary adoption', () => {
  it('runs inline preflight before detached Browser-GPT launch', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'flow-manager-browser-gpt-long-run.ts'), 'utf8');
    const preflight = source.indexOf('preflightRunner({');
    const launch = source.indexOf('spawnLauncher(launcherArgs, browserChildEnv)');
    expect(preflight).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(preflight);
    expect(source).toContain("options.get('operator-browser-config')");
  });

  it('inventories exactly the canonical tracked GET /user principal read for Issue 1935', () => {
    const inventory = JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'lib', 'graphql-quota-github-read-inventory.json'), 'utf8')) as {
      rows: Array<{ id?: string; ownerClass?: string; pattern?: string; ownerIssue?: number }>;
    };
    const rows = inventory.rows.filter((row) => row.ownerIssue === 1935);
    expect(rows).toEqual([{
      id: 'rest-authenticated-principal-login',
      ownerClass: 'rest_direct',
      pattern: '^gh api user --jq \\.login$',
      ownerIssue: 1935,
    }]);
  });
});


describe('Issue #1935 sanitized measured convergence replay', () => {
  it('reconciles #1923 r02 publication loss without transport rewrite or resend authority', () => {
    const replay = JSON.parse(readFileSync(
      join(process.cwd(), 'tests', 'external-output-references', 'create-issue-1923-r02-convergence.json'),
      'utf8',
    )) as {
      source: {
        issueNumber: number;
        sourceRevision: string;
        cycleId: string;
        stage: 'architectural-review';
        stageAttemptId: string;
        tier: 'T2';
      };
      recordedTransport: {
        state: string;
        cause: string;
        delivery: string;
        recovery_available: boolean;
        recurrence_cause: string;
        child_terminal: string;
        lifecycle_outcome: string;
        send_count: number;
      };
      publisherLogin: string;
      issue: { title: string; body: string };
      slots: Array<{ reviewerSlot: string; invocationId: string; commentId: number; findingId: string }>;
    };
    const root = tempRoot();
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = root;
    const reviewDir = join(root, '.review', String(replay.source.issueNumber));
    mkdirSync(reviewDir, { recursive: true });
    const evidencePath = join(reviewDir, 'attempt-001.json');
    const recurrencePath = join(reviewDir, 'measured-recurrence-symptom.json');
    const episode = 'issue:' + replay.source.issueNumber + '@' + replay.source.sourceRevision;

    writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({
      schema: 'tier-intake/v1',
      producer: 'create-issue-stage-finalize/start-cycle',
      taskIdentity: 'issue:' + replay.source.issueNumber,
      kind: 'fresh',
      priorTier: replay.source.tier,
      firstRevision: replay.source.sourceRevision,
    }, null, 2) + '\n');
    writeFileSync(recurrencePath, JSON.stringify(replay.recordedTransport, null, 2) + '\n');
    const recurrenceBefore = readFileSync(recurrencePath, 'utf8');

    const commentBodies = new Map<string, string>();
    for (const slot of replay.slots) {
      const body = [
        'Read revision: #' + replay.source.issueNumber + ' ' + replay.source.sourceRevision,
        'INVOCATION_ID_TO_ECHO: ' + slot.invocationId,
        'review-economics-contract: v1',
        'VERDICT: FINDINGS',
        'FINDING_COUNT: 1',
        '',
        'id: ' + slot.findingId,
        'type: spec',
        'severity: P1',
        'title: Sanitized measured #1923 r02 finding',
        'evidence: Sanitized replay evidence preserving the measured invocation and transport incident.',
        'recommendation: Preserve the existing fail-closed recovery boundary.',
        'persistent-machinery: no',
        '',
        'SIMPLIFICATION_CLEAN',
        '',
      ].join('\n');
      commentBodies.set(slot.invocationId, body);
      const envelopePath = join(reviewDir, 'terminal-' + slot.reviewerSlot + '.json');
      writeFileSync(envelopePath, JSON.stringify({
        schema: 'flow-manager-long-running-child-terminal/v1',
        terminal_at: '2026-09-16T00:00:00Z',
        lifecycle_outcome: replay.recordedTransport.lifecycle_outcome,
        send_count: replay.recordedTransport.send_count,
        turn_result_state: replay.recordedTransport.state,
        turn_result_cause: replay.recordedTransport.cause,
        delivery: replay.recordedTransport.delivery,
        recovery_available: replay.recordedTransport.recovery_available,
        recurrence_cause: replay.recordedTransport.recurrence_cause,
        child_terminal: replay.recordedTransport.child_terminal,
      }, null, 2) + '\n');
    }

    writeFileSync(evidencePath, JSON.stringify({
      schema: 'create-issue-stage-evidence/v1',
      producer: 'create-issue-stage-finalize/start-cycle',
      taskIdentity: 'issue:' + replay.source.issueNumber,
      tier: replay.source.tier,
      stage: replay.source.stage,
      stageAttemptId: replay.source.stageAttemptId,
      stageSequence: 1,
      cycleId: replay.source.cycleId,
      cycleBinding: {
        cycleId: replay.source.cycleId,
        sourceRevision: replay.source.sourceRevision,
        boundBeforeLaunch: true,
      },
      policyVersion: 'triple-source/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: 'triple-source/v1',
      sourceRevision: replay.source.sourceRevision,
      revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'pending' },
      invocations: replay.slots.map((slot) => ({
        schema: 'reviewer-invocation-envelope/v1',
        reviewEpisodeId: episode,
        stageAttemptId: replay.source.stageAttemptId,
        policyVersion: 'triple-source/v1',
        reviewerCardinality: 3,
        cardinalityConfigIdentity: 'triple-source/v1',
        stage: replay.source.stage,
        sourceRevision: replay.source.sourceRevision,
        invocationId: slot.invocationId,
        reviewerSlot: slot.reviewerSlot,
        reviewerOrdinal: Number(slot.reviewerSlot),
        attemptOrdinal: 1,
        retryAttempt: false,
        revisionCheck: 'matched',
        capacityOutcome: 'admitted',
        capacityWaitMs: 0,
        terminalEnvelopePath: 'terminal-' + slot.reviewerSlot + '.json',
        reviewerSource: 'slot-' + slot.reviewerSlot + '#capture=direct-publication/v1',
      })),
    }, null, 2) + '\n');

    const reviewerComments = replay.slots.map((slot) => ({
      id: slot.commentId,
      html_url: 'https://github.com/chetwerikoff/orchestrator-pack/issues/' + replay.source.issueNumber + '#issuecomment-' + slot.commentId,
      issue_url: 'https://api.github.com/repos/chetwerikoff/orchestrator-pack/issues/' + replay.source.issueNumber,
      body: commentBodies.get(slot.invocationId)!,
      created_at: '2026-09-16T00:05:00Z',
      updated_at: '2026-09-16T00:05:00Z',
      author_association: 'OWNER',
      user: { login: replay.publisherLogin },
    }));
    const cycleCommentId = 5694603675;
    const cycleComment = {
      id: cycleCommentId,
      html_url: 'https://github.com/chetwerikoff/orchestrator-pack/issues/' + replay.source.issueNumber + '#issuecomment-' + cycleCommentId,
      issue_url: 'https://api.github.com/repos/chetwerikoff/orchestrator-pack/issues/' + replay.source.issueNumber,
      body: [
        '<!-- opk-create-issue-journal:create-issue-review-cycle/v1:' + replay.source.cycleId + ' -->',
        '```json',
        JSON.stringify({
          schema: 'create-issue-review-cycle/v1',
          'event-key': replay.source.cycleId,
          'cycle-id': replay.source.cycleId,
          'predecessor-cycle-id': 'none',
          'source-revision': replay.source.sourceRevision,
          tier: replay.source.tier,
          'public-actor': 'cursor-flow-manager',
        }, null, 2),
        '```',
      ].join('\n'),
      created_at: '2026-09-16T00:00:00Z',
      updated_at: '2026-09-16T00:00:00Z',
      author_association: 'OWNER',
      user: { login: replay.publisherLogin },
    };
    const census = [...reviewerComments, cycleComment];

    const transport = {
      runGh: (argv: string[]) => {
        if (argv[2] === 'user') return { exitCode: 0, stdout: replay.publisherLogin + '\n', stderr: '' };
        const target = argv[2] ?? '';
        if (target === 'repos/chetwerikoff/orchestrator-pack') {
          return { exitCode: 0, stdout: replay.publisherLogin + '\n', stderr: '' };
        }
        if (target === 'repos/chetwerikoff/orchestrator-pack/issues/' + replay.source.issueNumber && argv.includes('--jq')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ title: replay.issue.title, body: replay.issue.body, labels: [] }),
            stderr: '',
          };
        }
        if (target === 'repos/chetwerikoff/orchestrator-pack/issues/' + replay.source.issueNumber + '/comments?per_page=100&page=1') {
          return { exitCode: 0, stdout: JSON.stringify(census), stderr: '' };
        }
        if (target === 'repos/chetwerikoff/orchestrator-pack/issues/' + replay.source.issueNumber + '/comments?per_page=100&page=2') {
          return { exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (target.startsWith('repos/chetwerikoff/orchestrator-pack/issues/comments/')) {
          const id = Number(target.split('/').at(-1));
          const found = census.find((comment) => comment.id === id);
          return found
            ? { exitCode: 0, stdout: JSON.stringify(found), stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'not found' };
        }
        throw new Error('unexpected replay gh call: ' + argv.join(' '));
      },
    };

    // The enforced send boundary is part of the replay contract even though this
    // deterministic replay intentionally performs no live Browser-GPT send.
    const adapterSource = readFileSync(join(process.cwd(), 'scripts', 'flow-manager-browser-gpt-long-run.ts'), 'utf8');
    expect(adapterSource.indexOf('preflightRunner({')).toBeLessThan(
      adapterSource.indexOf('spawnLauncher(launcherArgs, browserChildEnv)'),
    );

    const reconciled = reconcileCreateIssueStage({
      reviewDir,
      stageEvidencePath: evidencePath,
      repositoryFullName: 'chetwerikoff/orchestrator-pack',
      issueNumber: replay.source.issueNumber,
      artifactSourceTransport: transport,
    });
    expect(reconciled.ok, reconciled.errors.join('\n')).toBe(true);
    expect(reconciled.capturePaths).toHaveLength(3);

    const blockedOn = {
      issue: 1977,
      condition: 'issue_closed',
      evidence: 'slot 01 is blocked on Issue #1977',
    } as const;
    const continuationLogs: string[] = [];
    const continuationLogSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      continuationLogs.push(String(line));
    });
    try {
      const code = runStageFinalizeCli([
        'node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage',
        '--repo', 'chetwerikoff/orchestrator-pack',
        '--issue-number', String(replay.source.issueNumber),
        '--review-dir', reviewDir,
        '--stage-evidence', evidencePath,
        '--blocked-on-json', JSON.stringify(blockedOn),
        '--json',
      ], transport);
      expect(code).toBe(4);
      const output = JSON.parse(continuationLogs.at(-1) ?? '{}') as {
        cause?: string;
        nextAction?: unknown;
        pause?: { resume_when?: unknown; evidence?: string };
      };
      expect(output).toMatchObject({
        cause: 'external:waiting_on_issue',
        nextAction: null,
        pause: {
          resume_when: { issue: 1977, condition: 'issue_closed' },
          evidence: blockedOn.evidence,
        },
      });
    } finally {
      continuationLogSpy.mockRestore();
    }

    const reconciledEvidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      invocations: Array<Record<string, unknown>>;
    };
    for (const invocation of reconciledEvidence.invocations) {
      expect(invocation).toMatchObject({
        terminal: true,
        terminalClassification: 'post-send-failure',
        sendCount: 1,
        retryClass: 'retry-forbidden',
        artifactAuthority: { kind: 'authoritative-github-artifact', publisherLogin: replay.publisherLogin },
      });
      expect(invocation.terminalResultIdentity).toBeUndefined();
      expect(invocation.captureSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(invocation.rawFindingCount).toBe(1);
    }
    expect(readFileSync(recurrencePath, 'utf8')).toBe(recurrenceBefore);

    const findings = replay.slots.map((slot) => {
      const name = 'pass-01-architectural-review-' + slot.reviewerSlot + '.capture.txt';
      const body = commentBodies.get(slot.invocationId)!;
      const digest = createHash('sha256').update(body, 'utf8').digest('hex');
      return {
        id: slot.findingId,
        type: 'spec',
        severity: 'P1',
        title: 'Sanitized measured #1923 r02 finding',
        evidence: 'Sanitized replay evidence.',
        recommendation: 'Preserve the existing fail-closed recovery boundary.',
        occurrences: ['sha256:' + digest + ':' + name + ':1'],
        defectDisposition: 'addressed',
        remedyDisposition: 'accepted',
        'persistent-machinery': 'no',
        simplificationCutCandidate: false,
      };
    });
    writeFileSync(join(reviewDir, 'round-01-author-reply.md'), [
      'Governed author output:',
      '',
      '```create-issue-author-dispositions/v1',
      JSON.stringify({
        schema: 'create-issue-author-dispositions/v1',
        sourceRevision: replay.source.sourceRevision,
        predecessorStage: replay.source.stage,
        findings,
        m4: { inventory: [] },
      }),
      '```',
      '',
    ].join('\n'));

    const action = createIssueNextAction({
      kind: 'produce-acceptance-artifacts',
      binding: {
        repository: 'chetwerikoff/orchestrator-pack',
        issueNumber: replay.source.issueNumber,
        sourceRevision: replay.source.sourceRevision,
        stage: replay.source.stage,
        stageAttemptId: replay.source.stageAttemptId,
      },
      argv: [
        'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
        'produce-artifacts', '--repo', 'chetwerikoff/orchestrator-pack',
        '--issue-number', String(replay.source.issueNumber), '--review-dir', reviewDir,
        '--phase', 'pre-lens',
        '--expected-source-revision', replay.source.sourceRevision,
        '--expected-stage', replay.source.stage,
        '--expected-stage-attempt-id', replay.source.stageAttemptId,
        '--json',
      ],
    });
    expect(validateCreateIssueNextAction(action)).toEqual([]);

    const produced = produceAcceptanceArtifacts({
      reviewDir,
      outputDir: reviewDir,
      tierIntakePath: join(reviewDir, 'tier-intake.json'),
      stageEvidencePaths: [],
      authorDispositionsPath: join(reviewDir, 'author-dispositions.json'),
      phase: 'pre-lens',
      repositoryFullName: 'chetwerikoff/orchestrator-pack',
      artifactSourceTransport: transport,
    });
    expect(produced.ok, produced.errors.join('\n')).toBe(true);
    expect(readFileSync(recurrencePath, 'utf8')).toBe(recurrenceBefore);

    const receipt = JSON.parse(readFileSync(
      join(reviewDir, 'stage-completeness-receipt-' + replay.source.stageAttemptId + '.json'),
      'utf8',
    )) as { invocations: Array<Record<string, unknown>> };
    expect(receipt.invocations.every((invocation) => invocation.terminalClassification === 'post-send-failure')).toBe(true);
    expect(receipt.invocations.every((invocation) => invocation.retryClass === 'retry-forbidden')).toBe(true);

    const terminalBundle = buildManagerReviewTerminalBundle({
      repositoryFullName: 'chetwerikoff/orchestrator-pack',
      issueNumber: replay.source.issueNumber,
      sourceRevision: replay.source.sourceRevision,
      reviewDir,
      liveIssueBody: replay.issue.body,
    });
    expect(terminalBundle.predecessorStage).toBe('architectural-review');
    expect(canonicalStagePlan('T2').stages.at(-1)?.stage).toBe('architectural');

    const replayed = reconcileCreateIssueStage({
      reviewDir,
      stageEvidencePath: evidencePath,
      repositoryFullName: 'chetwerikoff/orchestrator-pack',
      issueNumber: replay.source.issueNumber,
      artifactSourceTransport: transport,
    });
    expect(replayed).toMatchObject({ ok: true, alreadySettled: true, stageAttemptId: replay.source.stageAttemptId });
    expect(readFileSync(recurrencePath, 'utf8')).toBe(recurrenceBefore);

    const terminalLogs: string[] = [];
    const terminalLogSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      terminalLogs.push(String(line));
    });
    try {
      const code = runStageFinalizeCli([
        'node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage',
        '--repo', 'chetwerikoff/orchestrator-pack',
        '--issue-number', String(replay.source.issueNumber),
        '--review-dir', reviewDir,
        '--stage-evidence', evidencePath,
        '--json',
      ], transport);
      expect(code).toBe(3);
      const output = JSON.parse(terminalLogs.at(-1) ?? '{}') as {
        ok?: boolean;
        cause?: string;
        nextAction?: { kind?: string } | null;
      };
      expect(output).toMatchObject({
        ok: false,
        cause: 'reconciliation_failed',
        nextAction: { kind: 'produce-acceptance-artifacts' },
      });
      expect(output).not.toHaveProperty('blocked_on');
      expect(output).not.toHaveProperty('pause');
    } finally {
      terminalLogSpy.mockRestore();
    }
  });
});


describe('zero-send manager result is action or structured reason (Issue #1999)', () => {
  const binding: CreateIssueActionBinding = {
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1999,
    sourceRevision: 'r04',
    stage: 'competitive',
    stageAttemptId: '1977-poisoned-canonical-attempt',
  };
  const fixtureDir = join(process.cwd(), 'tests/external-output-references');

  function managerReconcileAction() {
    return createIssueNextAction({
      kind: 'reconcile-stage-read-only',
      binding,
      argv: [
        'node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage',
        '--repo', binding.repository,
        '--issue-number', String(binding.issueNumber),
        '--expected-source-revision', binding.sourceRevision,
        '--expected-stage', binding.stage,
        '--expected-stage-attempt-id', binding.stageAttemptId!,
        '--json',
      ],
    });
  }

  function envelope(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as Record<string, unknown>;
  }

  it('returns readonly reconciliation with a structured reason for deterministic zero-send input', () => {
    for (const name of [
      'create-issue-926-terminal-competitive-01.json',
      'create-issue-926-terminal-competitive-01-final.json',
    ]) {
      const body = envelope(name);
      const policy = classifyZeroSendCausePolicy(body);
      const projected = projectZeroSendManagerResult({
        policy,
        attemptOrdinal: 1,
        binding,
        invocationId: 'original-invocation',
        reviewerSlot: '01',
        pacedRetryAction: existingPacedBoundedRetryAction(binding, '01'),
        reconcileAction: managerReconcileAction(),
        freshInvocationId: 'fresh-invocation-id',
      });
      expect(projected?.nextAction).toMatchObject({ kind: 'reconcile-stage-read-only' });
      expect(projected).toEqual(expect.objectContaining({
        ok: false,
        cause: policy?.code,
        blocker: policy?.rawCause,
        reason: expect.objectContaining({
          class: policy?.class,
          code: policy?.code,
          rawCause: policy?.rawCause,
          binding,
        }),
      }));
      expect(JSON.stringify(projected)).not.toContain('fresh-invocation-id');
      expect(typeof projected?.blocker).toBe('string');
      expect(projected && 'reason' in projected).toBe(true);
    }
  });

  it('projects marker conflict to readonly reconciliation and exhausted external transient to a typed pause', () => {
    const reconcile = projectZeroSendManagerResult({
      policy: {
        class: 'state-conflict',
        code: 'marker_conflict',
        rawCause: 'marker_conflict: canonical lineage disagrees',
      },
      attemptOrdinal: 1,
      binding,
      pacedRetryAction: existingPacedBoundedRetryAction(binding, '01'),
      reconcileAction: managerReconcileAction(),
    });
    expect(reconcile).toMatchObject({
      ok: false,
      cause: 'marker_conflict',
      nextAction: { kind: 'reconcile-stage-read-only' },
    });

    const paused = projectZeroSendManagerResult({
      policy: {
        class: 'transient',
        code: 'transport_unavailable',
        rawCause: 'GitHub HTTP 503 unavailable',
      },
      attemptOrdinal: 2,
      binding,
      reviewerSlot: '01',
      pacedRetryAction: existingPacedBoundedRetryAction(binding, '01'),
      reconcileAction: managerReconcileAction(),
    });
    expect(paused).toMatchObject({
      ok: false,
      cause: 'external:github_unavailable',
      pause: {
        resume_when: { operator: true },
        evidence: 'GitHub HTTP 503 unavailable',
      },
      nextAction: null,
    });
  });
});
