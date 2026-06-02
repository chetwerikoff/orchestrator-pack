import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCodexExecReviewArgs } from '../lib/run_review.js';
import {
  emitAoReviewPayload,
  formatGithubComment,
  toAoFindings,
} from '../lib/emit.js';
import {
  extractStrictPackFindingsArray,
  NO_FINDINGS_TOKEN,
  parseCodexOutput,
} from '../lib/parse_output.js';
import { buildReviewPrompt } from '../lib/prompt.js';
import {
  executeReview,
  hasReviewRuntimeDeps,
  resolvePackRepoRoot,
  reviewDependencySearchRoots,
  summarizeReviewerProcessFailure,
} from '../lib/review_core.js';
import {
  formatScopeSection,
  resolveScopeContext,
  scopeUnavailableWarningFinding,
} from '../lib/scope_context.js';
import {
  attemptSplitChannelRecovery,
  extractThreadIdFromProcessJsonl,
  isSplitChannelRecoveryCandidate,
  parseCodexReviewOutput,
  parseExitedReviewModeFromSessionJsonl,
  parseReviewModeFromChannels,
  SPLIT_CHANNEL_EMPTY_FINDINGS_MESSAGE,
  toRepoRelativePath,
} from '../lib/review_jsonl.js';
import { selectReviewVerdict } from '../lib/verdict.js';

const SCOPED_ISSUE_NUMBER = 6;
const FIXTURES_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

const PROSE_CLEAN_LAST_MESSAGE =
  'The change adds a straightforward subtract function. No regressions or actionable bugs were identified.';
const REPO_ROOT = process.cwd();

describe('review dependency roots', () => {
  it('resolves pack repo root to orchestrator-pack', () => {
    expect(resolvePackRepoRoot()).toBe(process.cwd());
  });

  it('checks pack root before reviewed repo when they differ', () => {
    const packRoot = resolvePackRepoRoot();
    const otherRoot = join(tmpdir(), 'foreign-pr-repo');
    expect(reviewDependencySearchRoots(otherRoot)).toEqual([packRoot, otherRoot]);
    expect(reviewDependencySearchRoots(packRoot)).toEqual([packRoot]);
    expect(hasReviewRuntimeDeps(packRoot)).toBe(true);
  });
});

describe('summarizeReviewerProcessFailure', () => {
  it('surfaces Codex quota and usage-limit errors', () => {
    const lines = summarizeReviewerProcessFailure({
      exitCode: 1,
      stdout: 'NO_FINDINGS',
      stderr: "ERROR: You've hit your usage limit.",
    });
    expect(lines[0]).toContain('exited 1');
    expect(lines.join('\n')).toContain('usage limit');
  });

  it('reports missing output when stderr and stdout are empty', () => {
    const lines = summarizeReviewerProcessFailure({
      exitCode: 1,
      stdout: '',
      stderr: '',
    });
    expect(lines.join('\n')).toContain('no stderr/stdout');
  });
});

describe('buildCodexExecReviewArgs', () => {
  it('uses stdin prompt mode without --base (Codex CLI mutual-exclusion)', () => {
    const args = buildCodexExecReviewArgs({
      outputFile: '/tmp/out.txt',
      model: 'gpt-5.5',
    });
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
    expect(args.slice(0, 4)).toEqual(['exec', '--sandbox', 'read-only', 'review']);
    expect(args).not.toContain('--base');
    expect(args).toContain('--json');
    expect(args[args.length - 1]).toBe('-');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('review-mode JSONL verdict', () => {
  it('extracts thread id from process JSONL stdout', () => {
    const processJsonl = readFixture('process-clean.jsonl');
    expect(extractThreadIdFromProcessJsonl(processJsonl)).toBe(
      '019e8713-cb1a-7b02-b3e0-ca7410a4dc83',
    );
  });

  it('parses clean exited_review_mode from session JSONL', () => {
    const sessionJsonl = readFixture('session-clean.jsonl');
    const exited = parseExitedReviewModeFromSessionJsonl(sessionJsonl);
    expect(exited.status).toBe('valid');
    if (exited.status !== 'valid') {
      return;
    }
    expect(exited.reviewOutput.overall_correctness).toBe('patch is correct');
    const parsed = parseCodexReviewOutput(exited.reviewOutput, 'codex-local', REPO_ROOT);
    expect(parsed).toEqual({ kind: 'clean' });
  });

  it('parses findings from session JSONL review_output', () => {
    const sessionJsonl = readFixture('session-findings.jsonl');
    const exited = parseExitedReviewModeFromSessionJsonl(sessionJsonl);
    expect(exited.status).toBe('valid');
    if (exited.status !== 'valid') {
      return;
    }
    const parsed = parseCodexReviewOutput(exited.reviewOutput, 'codex-local', REPO_ROOT);
    expect(parsed.kind).toBe('findings');
    if (parsed.kind === 'findings') {
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0]!.summary).toContain('Remove generated review artifact');
      expect(parsed.findings[0]!.path).toBe('review-events.jsonl');
    }
  });

  it('maps absolute code_location paths to repo-relative paths', () => {
    const absolutePath = join(REPO_ROOT, 'plugins', 'ao-codex-pr-reviewer', 'lib', 'run_review.ts');
    const parsed = parseCodexReviewOutput(
      {
        findings: [
          {
            title: '[P2] Example absolute path',
            body: 'Body text.',
            priority: 2,
            code_location: {
              absolute_file_path: absolutePath,
              line_range: { start: 1, end: 2 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'Example.',
        overall_confidence_score: 0.5,
      },
      'codex-local',
      REPO_ROOT,
    );
    expect(parsed.kind).toBe('findings');
    if (parsed.kind === 'findings') {
      expect(parsed.findings[0]!.path).toBe('plugins/ao-codex-pr-reviewer/lib/run_review.ts');
    }
  });

  it('rejects review_output without a findings array', () => {
    const parsed = parseCodexReviewOutput(
      {
        overall_correctness: 'patch is correct',
        overall_explanation: 'Missing findings key.',
        overall_confidence_score: 0.9,
      },
      'codex-local',
      REPO_ROOT,
    );
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error') {
      expect(parsed.message).toContain('missing required findings array');
    }
  });

  it('rejects review_output when findings is not an array', () => {
    const parsed = parseCodexReviewOutput(
      {
        findings: 'not-an-array',
        overall_correctness: 'patch is correct',
        overall_explanation: 'Malformed findings.',
        overall_confidence_score: 0.9,
      } as unknown as Parameters<typeof parseCodexReviewOutput>[0],
      'codex-local',
      REPO_ROOT,
    );
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error') {
      expect(parsed.message).toContain('findings must be an array');
    }
  });

  it('fails closed on contradictory empty findings with incorrect verdict', () => {
    const sessionJsonl = readFixture('session-contradictory-empty-findings.jsonl');
    const exited = parseExitedReviewModeFromSessionJsonl(sessionJsonl);
    expect(exited.status).toBe('valid');
    if (exited.status !== 'valid') {
      return;
    }
    const parsed = parseCodexReviewOutput(exited.reviewOutput, 'codex-local', REPO_ROOT);
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error') {
      expect(parsed.message).toContain('overall_correctness');
    }
  });

  it('fails closed on contradictory findings with correct verdict', () => {
    const sessionJsonl = readFixture('session-contradictory-clean-verdict.jsonl');
    const exited = parseExitedReviewModeFromSessionJsonl(sessionJsonl);
    expect(exited.status).toBe('valid');
    if (exited.status !== 'valid') {
      return;
    }
    const parsed = parseCodexReviewOutput(exited.reviewOutput, 'codex-local', REPO_ROOT);
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error') {
      expect(parsed.message).toContain('contradictory');
    }
  });

  it('toRepoRelativePath returns null for paths outside the repo', () => {
    const outside = join(REPO_ROOT, '..', 'outside-repo-file.ts');
    expect(toRepoRelativePath(outside, REPO_ROOT)).toBeNull();
    expect(toRepoRelativePath('C:\\outside\\other\\file.ts', REPO_ROOT)).toBeNull();
    expect(toRepoRelativePath('../../outside/file.ts', REPO_ROOT)).toBeNull();
  });

  it('toRepoRelativePath resolves in-repo relative paths against repo root', () => {
    expect(toRepoRelativePath('plugins/ao-codex-pr-reviewer/lib/review_jsonl.ts', REPO_ROOT)).toBe(
      'plugins/ao-codex-pr-reviewer/lib/review_jsonl.ts',
    );
  });

  it('derives scope-violation type without scope in the title', () => {
    const parsed = parseCodexReviewOutput(
      {
        findings: [
          {
            title: '[P1] Modify vendored AO core',
            body: 'Changes under packages/core violate the pack denylist and allowed_roots contract.',
            priority: 1,
            code_location: {
              absolute_file_path: 'packages/core/foo.ts',
              line_range: { start: 1, end: 2 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'Scope breach.',
        overall_confidence_score: 0.9,
      },
      'codex-local',
      REPO_ROOT,
    );
    expect(parsed.kind).toBe('findings');
    if (parsed.kind === 'findings') {
      expect(parsed.findings[0]!.type).toBe('scope-violation');
      expect(parsed.findings[0]!.code).toMatch(/^scope-violation:/);
    }
  });

  it('maps bracketed title priority to blocking when numeric priority is omitted', () => {
    const parsed = parseCodexReviewOutput(
      {
        findings: [
          {
            title: '[P0] Critical regression in scope guard',
            body: 'Urgent issue without numeric priority field.',
            code_location: {
              absolute_file_path: 'plugins/ao-scope-guard/lib/check.ts',
              line_range: { start: 1, end: 2 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'Blocking severity contract test.',
        overall_confidence_score: 0.9,
      },
      'codex-local',
      REPO_ROOT,
    );
    expect(parsed.kind).toBe('findings');
    if (parsed.kind === 'findings') {
      expect(parsed.findings[0]!.severity).toBe('blocking');
    }
  });

  it('maps bracketed P2 title to non-blocking when numeric priority is omitted', () => {
    const parsed = parseCodexReviewOutput(
      {
        findings: [
          {
            title: '[P2] Minor style issue',
            body: 'Lower priority without numeric priority field.',
            code_location: {
              absolute_file_path: 'plugins/ao-scope-guard/lib/check.ts',
              line_range: { start: 1, end: 2 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'Non-blocking severity contract test.',
        overall_confidence_score: 0.5,
      },
      'codex-local',
      REPO_ROOT,
    );
    expect(parsed.kind).toBe('findings');
    if (parsed.kind === 'findings') {
      expect(parsed.findings[0]!.severity).toBe('non-blocking');
    }
  });

  it('preserves explicit type and code from review_output findings', () => {
    const parsed = parseCodexReviewOutput(
      {
        findings: [
          {
            title: '[P1] Denylisted path touched',
            body: 'Worker changed vendor/agent-orchestrator without declaration.',
            priority: 1,
            type: 'scope-violation',
            code: 'scope-violation:path-outside-declaration',
            code_location: {
              absolute_file_path: 'vendor/agent-orchestrator/foo.ts',
              line_range: { start: 1, end: 1 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'Out of scope.',
        overall_confidence_score: 0.9,
      },
      'codex-local',
      REPO_ROOT,
    );
    expect(parsed.kind).toBe('findings');
    if (parsed.kind === 'findings') {
      expect(parsed.findings[0]!.type).toBe('scope-violation');
      expect(parsed.findings[0]!.code).toBe('scope-violation:path-outside-declaration');
    }
  });

  it('selects JSONL clean verdict over legacy prose last message', () => {
    const verdict = selectReviewVerdict({
      processJsonl: readFixture('process-clean.jsonl'),
      lastMessage: PROSE_CLEAN_LAST_MESSAGE,
      stderr: '',
      repoRoot: REPO_ROOT,
      sessionJsonl: readFixture('session-clean.jsonl'),
      source: 'codex-local',
    });
    expect(verdict.kind).toBe('clean');
    expect(verdict.verdictSource).toBe('review_mode_jsonl');
  });

  it('falls back to NO_FINDINGS when review-mode output is unavailable', () => {
    const verdict = selectReviewVerdict({
      processJsonl: '',
      lastMessage: 'NO_FINDINGS',
      stderr: '',
      repoRoot: REPO_ROOT,
      source: 'codex-local',
    });
    expect(verdict).toMatchObject({ kind: 'clean', verdictSource: 'last_message_fallback' });
  });

  it('falls back to structured JSON findings in last message', () => {
    const payload = JSON.stringify({
      findings: [
        {
          type: 'quality',
          code: 'quality:example',
          severity: 'non-blocking',
          path: 'scripts/foo.ps1',
          summary: 'Example finding',
          source: 'codex-local',
        },
      ],
    });
    const verdict = selectReviewVerdict({
      processJsonl: '{"type":"thread.started","thread_id":"missing-session"}',
      lastMessage: payload,
      stderr: '',
      repoRoot: REPO_ROOT,
      source: 'codex-local',
    });
    expect(verdict.kind).toBe('findings');
    expect(verdict.verdictSource).toBe('last_message_fallback');
  });

  it('rejects prose-only last message when JSONL verdict is missing', () => {
    const verdict = selectReviewVerdict({
      processJsonl: '',
      lastMessage: 'No concrete bugs were identified in this change.',
      stderr: '',
      repoRoot: REPO_ROOT,
      source: 'codex-local',
    });
    expect(verdict.kind).toBe('error');
    if (verdict.kind === 'error') {
      expect(verdict.message).toContain('legacy clean-review prose');
      expect(verdict.message).toContain('diagnostic:');
    }
  });

  it('fails closed on malformed exited_review_mode without review_output', () => {
    const sessionJsonl = [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'exited_review_mode', review_output: null },
      }),
    ].join('\n');

    const result = parseReviewModeFromChannels({
      processJsonl: readFixture('process-clean.jsonl'),
      sessionJsonl,
      repoRoot: REPO_ROOT,
      source: 'codex-local',
    });
    expect(result?.kind).toBe('error');
    if (result?.kind === 'error') {
      expect(result.message).toContain('exited_review_mode');
    }

    const verdict = selectReviewVerdict({
      processJsonl: readFixture('process-clean.jsonl'),
      lastMessage: 'NO_FINDINGS',
      stderr: '',
      repoRoot: REPO_ROOT,
      sessionJsonl,
      source: 'codex-local',
    });
    expect(verdict.kind).toBe('error');
    expect(verdict.verdictSource).toBe('review_mode_jsonl');
    if (verdict.kind === 'error') {
      expect(verdict.message).toContain('exited_review_mode');
      expect(verdict.message).toContain('diagnostic:');
    }
  });

  it('fails closed on unparseable exited_review_mode JSONL line', () => {
    const sessionJsonl = [
      '{"type":"event_msg","payload":{"type":"exited_review_mode","review_output":{',
    ].join('\n');

    const result = parseReviewModeFromChannels({
      processJsonl: readFixture('process-clean.jsonl'),
      sessionJsonl,
      repoRoot: REPO_ROOT,
      source: 'codex-local',
    });
    expect(result?.kind).toBe('error');
    if (result?.kind === 'error') {
      expect(result.message).toContain('malformed or incomplete exited_review_mode');
    }

    const verdict = selectReviewVerdict({
      processJsonl: readFixture('process-clean.jsonl'),
      lastMessage: 'NO_FINDINGS',
      stderr: '',
      repoRoot: REPO_ROOT,
      sessionJsonl,
      source: 'codex-local',
    });
    expect(verdict.kind).toBe('error');
    expect(verdict.verdictSource).toBe('review_mode_jsonl');
    if (verdict.kind === 'error') {
      expect(verdict.message).toContain('diagnostic:');
    }
  });

  it('parseReviewModeFromChannels returns null without session JSONL', () => {
    expect(
      parseReviewModeFromChannels({
        processJsonl:
          '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000000"}',
        sessionJsonl: null,
        repoRoot: REPO_ROOT,
        codexHome: join(tmpdir(), 'nonexistent-codex-home-for-tests'),
        source: 'codex-local',
      }),
    ).toBeNull();
  });

  describe('split-channel secondary recovery (#135)', () => {
    it('recovers pack JSON findings from overall_explanation (op-rev-28 class)', () => {
      const sessionJsonl = readFixture('session-split-channel-pack-json.jsonl');
      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: PROSE_CLEAN_LAST_MESSAGE,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl,
        source: 'codex-local',
      });
      expect(verdict.kind).toBe('findings');
      expect(verdict.verdictSource).toBe('review_mode_jsonl');
      if (verdict.kind === 'findings') {
        expect(verdict.findings).toHaveLength(1);
        expect(verdict.findings[0]!.summary).toContain('generated review artifact');
      }
    });

    it('fails closed when secondary channel has leading prose before NO_FINDINGS', () => {
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: `Review complete\n${NO_FINDINGS_TOKEN}`,
        overall_confidence_score: 0.5,
      };
      const parsed = parseCodexReviewOutput(reviewOutput, 'codex-local', REPO_ROOT);
      expect(isSplitChannelRecoveryCandidate(reviewOutput, parsed)).toBe(true);
      expect(
        attemptSplitChannelRecovery(reviewOutput, '', 'codex-local', REPO_ROOT),
      ).toBeNull();
      expect(parseCodexOutput(reviewOutput.overall_explanation!)).toEqual({
        kind: 'clean',
      });

      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: PROSE_CLEAN_LAST_MESSAGE,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl: [
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'exited_review_mode',
              review_output: reviewOutput,
            },
          }),
        ].join('\n'),
        source: 'codex-local',
      });
      expect(verdict.kind).toBe('error');
    });

    it('fails closed when secondary channel is NO_FINDINGS with trailing prose', () => {
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: `${NO_FINDINGS_TOKEN}\nextra prose must not be treated as clean`,
        overall_confidence_score: 0.5,
      };
      const parsed = parseCodexReviewOutput(reviewOutput, 'codex-local', REPO_ROOT);
      expect(isSplitChannelRecoveryCandidate(reviewOutput, parsed)).toBe(true);
      expect(
        attemptSplitChannelRecovery(reviewOutput, '', 'codex-local', REPO_ROOT),
      ).toBeNull();

      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: PROSE_CLEAN_LAST_MESSAGE,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl: [
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'exited_review_mode',
              review_output: reviewOutput,
            },
          }),
        ].join('\n'),
        source: 'codex-local',
      });
      expect(verdict.kind).toBe('error');
    });

    it('recovers clean from exact NO_FINDINGS in overall_explanation', () => {
      const sessionJsonl = readFixture('session-split-channel-no-findings.jsonl');
      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: PROSE_CLEAN_LAST_MESSAGE,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl,
        source: 'codex-local',
      });
      expect(verdict).toMatchObject({ kind: 'clean', verdictSource: 'review_mode_jsonl' });
    });

    it('recovers sub-shape B from last message when explanation is empty', () => {
      const sessionJsonl = [
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'exited_review_mode',
            review_output: {
              findings: [],
              overall_correctness: 'patch is incorrect',
              overall_explanation: '',
              overall_confidence_score: 0.5,
            },
          },
        }),
      ].join('\n');

      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: NO_FINDINGS_TOKEN,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl,
        source: 'codex-local',
      });
      expect(verdict).toMatchObject({ kind: 'clean', verdictSource: 'review_mode_jsonl' });
    });

    it('still fails closed on contradictory JSONL (non-empty findings + patch correct)', () => {
      const sessionJsonl = readFixture('session-contradictory-clean-verdict.jsonl');
      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: NO_FINDINGS_TOKEN,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl,
        source: 'codex-local',
      });
      expect(verdict.kind).toBe('error');
      expect(verdict.verdictSource).toBe('review_mode_jsonl');
      if (verdict.kind === 'error') {
        expect(verdict.message).toContain('contradictory');
      }
    });

    it('fails closed when split-channel has prose-only explanation', () => {
      const sessionJsonl = readFixture('session-contradictory-empty-findings.jsonl');
      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: PROSE_CLEAN_LAST_MESSAGE,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl,
        source: 'codex-local',
      });
      expect(verdict.kind).toBe('error');
      if (verdict.kind === 'error') {
        expect(verdict.message).toContain(SPLIT_CHANNEL_EMPTY_FINDINGS_MESSAGE);
      }
    });

    it('fails closed on prose [P1] markers in overall_explanation', () => {
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: '[P1] Critical bug in scope guard logic.',
        overall_confidence_score: 0.5,
      };
      const parsed = parseCodexReviewOutput(reviewOutput, 'codex-local', REPO_ROOT);
      expect(isSplitChannelRecoveryCandidate(reviewOutput, parsed)).toBe(true);
      expect(
        attemptSplitChannelRecovery(reviewOutput, PROSE_CLEAN_LAST_MESSAGE, 'codex-local', REPO_ROOT),
      ).toBeNull();
    });

    it('fails closed when explanation has prose [P1] but last message is exact NO_FINDINGS', () => {
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: '[P1] Critical bug must not be overridden by NO_FINDINGS in last message.',
        overall_confidence_score: 0.5,
      };
      expect(
        attemptSplitChannelRecovery(reviewOutput, NO_FINDINGS_TOKEN, 'codex-local', REPO_ROOT),
      ).toBeNull();

      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: NO_FINDINGS_TOKEN,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl: [
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'exited_review_mode',
              review_output: reviewOutput,
            },
          }),
        ].join('\n'),
        source: 'codex-local',
      });
      expect(verdict.kind).toBe('error');
    });

    it('fails closed when other channel has malformed pack findings JSON', () => {
      const malformedPackJson = JSON.stringify({
        findings: [{ type: 'quality', code: 'quality:incomplete-entry' }],
      });
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: malformedPackJson,
        overall_confidence_score: 0.5,
      };
      expect(
        attemptSplitChannelRecovery(reviewOutput, NO_FINDINGS_TOKEN, 'codex-local', REPO_ROOT),
      ).toBeNull();

      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: NO_FINDINGS_TOKEN,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl: [
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'exited_review_mode',
              review_output: reviewOutput,
            },
          }),
        ].join('\n'),
        source: 'codex-local',
      });
      expect(verdict.kind).toBe('error');
    });

    it('fails closed when other channel has syntactically invalid pack JSON', () => {
      const truncatedPackJson = '{"findings":[';
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: truncatedPackJson,
        overall_confidence_score: 0.5,
      };
      expect(
        attemptSplitChannelRecovery(reviewOutput, NO_FINDINGS_TOKEN, 'codex-local', REPO_ROOT),
      ).toBeNull();

      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: NO_FINDINGS_TOKEN,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl: [
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'exited_review_mode',
              review_output: reviewOutput,
            },
          }),
        ].join('\n'),
        source: 'codex-local',
      });
      expect(verdict.kind).toBe('error');
    });

    it('fails closed when other channel has pretty-printed invalid pack JSON', () => {
      const truncatedPackJson = '{\n  "findings": [';
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: truncatedPackJson,
        overall_confidence_score: 0.5,
      };
      expect(
        attemptSplitChannelRecovery(reviewOutput, NO_FINDINGS_TOKEN, 'codex-local', REPO_ROOT),
      ).toBeNull();

      const verdict = selectReviewVerdict({
        processJsonl: readFixture('process-clean.jsonl'),
        lastMessage: NO_FINDINGS_TOKEN,
        stderr: '',
        repoRoot: REPO_ROOT,
        sessionJsonl: [
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'exited_review_mode',
              review_output: reviewOutput,
            },
          }),
        ].join('\n'),
        source: 'codex-local',
      });
      expect(verdict.kind).toBe('error');
    });

    it('fails closed when last message has prose [P2] but explanation is exact NO_FINDINGS', () => {
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: NO_FINDINGS_TOKEN,
        overall_confidence_score: 0.5,
      };
      expect(
        attemptSplitChannelRecovery(
          reviewOutput,
          '[P2] Secondary prose must block clean recovery from explanation.',
          'codex-local',
          REPO_ROOT,
        ),
      ).toBeNull();
    });

    it('fails closed when secondary channels yield conflicting findings', () => {
      const findingA = JSON.stringify({
        findings: [
          {
            type: 'quality',
            code: 'quality:alpha',
            severity: 'non-blocking',
            path: 'a.ts',
            summary: 'Alpha finding',
            source: 'codex-local',
          },
        ],
      });
      const findingB = JSON.stringify({
        findings: [
          {
            type: 'quality',
            code: 'quality:beta',
            severity: 'non-blocking',
            path: 'b.ts',
            summary: 'Beta finding',
            source: 'codex-local',
          },
        ],
      });
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: findingA,
        overall_confidence_score: 0.5,
      };
      const parsed = parseCodexReviewOutput(reviewOutput, 'codex-local', REPO_ROOT);
      expect(isSplitChannelRecoveryCandidate(reviewOutput, parsed)).toBe(true);
      expect(
        attemptSplitChannelRecovery(reviewOutput, findingB, 'codex-local', REPO_ROOT),
      ).toBeNull();
    });

    it('fails closed when secondary channel is a bare findings array', () => {
      const bareArray = JSON.stringify([
        {
          type: 'quality',
          code: 'quality:bare-array',
          severity: 'non-blocking',
          path: 'scripts/foo.ps1',
          summary: 'Bare array must not recover',
          source: 'codex-local',
        },
      ]);
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: bareArray,
        overall_confidence_score: 0.5,
      };
      const parsed = parseCodexReviewOutput(reviewOutput, 'codex-local', REPO_ROOT);
      expect(isSplitChannelRecoveryCandidate(reviewOutput, parsed)).toBe(true);
      expect(
        attemptSplitChannelRecovery(reviewOutput, '', 'codex-local', REPO_ROOT),
      ).toBeNull();
    });

    it('does not recover from spurious JSON-like text in explanation', () => {
      const reviewOutput = {
        findings: [] as unknown[],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'The patch looks {"findings": almost right but not valid JSON.',
        overall_confidence_score: 0.5,
      };
      const parsed = parseCodexReviewOutput(reviewOutput, 'codex-local', REPO_ROOT);
      expect(isSplitChannelRecoveryCandidate(reviewOutput, parsed)).toBe(true);
      expect(
        attemptSplitChannelRecovery(reviewOutput, '', 'codex-local', REPO_ROOT),
      ).toBeNull();
    });

    it('does not run split-channel recovery when JSONL is absent', () => {
      const verdict = selectReviewVerdict({
        processJsonl: '',
        lastMessage: NO_FINDINGS_TOKEN,
        stderr: '',
        repoRoot: REPO_ROOT,
        source: 'codex-local',
      });
      expect(verdict).toMatchObject({
        kind: 'clean',
        verdictSource: 'last_message_fallback',
      });
    });
  });
});

describe('executeReview JSONL round-trip', () => {
  it('returns clean AO result when JSONL is clean but last message is prose', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      source: 'codex-local',
      fixtureStdout: PROSE_CLEAN_LAST_MESSAGE,
      fixtureProcessJsonl: readFixture('process-clean.jsonl'),
      fixtureSessionJsonl: readFixture('session-clean.jsonl'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.aoStdout).toBe('');
    expect(result.structuredFindings).toHaveLength(0);
  });

  it('maps JSONL findings to AO structured payload', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      source: 'codex-local',
      fixtureStdout: PROSE_CLEAN_LAST_MESSAGE,
      fixtureProcessJsonl: readFixture('process-clean.jsonl'),
      fixtureSessionJsonl: readFixture('session-findings.jsonl'),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.aoStdout) as { findings: unknown[] };
    expect(payload.findings.length).toBeGreaterThan(0);
  });

  it('emits repo-relative paths in AO payload for absolute JSONL code_location', () => {
    const repoRoot = process.cwd();
    const absolutePath = join(repoRoot, 'plugins', 'ao-codex-pr-reviewer', 'lib', 'review_jsonl.ts');
    const expectedRelative = 'plugins/ao-codex-pr-reviewer/lib/review_jsonl.ts';
    const sessionJsonl = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'exited_review_mode',
          review_output: {
            findings: [
              {
                title: '[P2] Normalize paths in AO payload',
                body: 'Absolute code_location must not leak into AO filePath.',
                priority: 2,
                code_location: {
                  absolute_file_path: absolutePath,
                  line_range: { start: 1, end: 2 },
                },
              },
            ],
            overall_correctness: 'patch is incorrect',
            overall_explanation: 'Path normalization contract test.',
            overall_confidence_score: 0.8,
          },
        },
      }),
    ].join('\n');

    const result = executeReview({
      repoRoot,
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      source: 'codex-local',
      fixtureStdout: PROSE_CLEAN_LAST_MESSAGE,
      fixtureProcessJsonl: readFixture('process-clean.jsonl'),
      fixtureSessionJsonl: sessionJsonl,
    });

    expect(result.exitCode).toBe(0);
    expect(result.structuredFindings[0]!.path).toBe(expectedRelative);

    const payload = JSON.parse(result.aoStdout) as {
      findings: Array<{ body: string; filePath?: string }>;
    };
    expect(payload.findings[0]!.filePath).toBe(expectedRelative);
    expect(payload.findings[0]!.body).toContain(`path: ${expectedRelative}`);
    expect(payload.findings[0]!.body).not.toContain(absolutePath);
  });
});

describe('parseCodexOutput', () => {
  it('treats exact NO_FINDINGS as clean', () => {
    expect(parseCodexOutput(NO_FINDINGS_TOKEN)).toEqual({ kind: 'clean' });
  });

  it('strict pack extraction rejects NO_FINDINGS with trailing prose', () => {
    expect(extractStrictPackFindingsArray(`${NO_FINDINGS_TOKEN}\nextra`)).toBeNull();
    expect(parseCodexOutput(`${NO_FINDINGS_TOKEN}\nextra`)).toEqual({ kind: 'clean' });
  });

  it('strict pack extraction rejects leading prose before NO_FINDINGS', () => {
    expect(extractStrictPackFindingsArray(`Review complete\n${NO_FINDINGS_TOKEN}`)).toBeNull();
    expect(parseCodexOutput(`Review complete\n${NO_FINDINGS_TOKEN}`)).toEqual({
      kind: 'clean',
    });
  });

  it('strict pack extraction rejects bare JSON array (pack object only)', () => {
    const bareArray = JSON.stringify([
      {
        type: 'quality',
        code: 'quality:example',
        severity: 'non-blocking',
        path: 'a.ts',
        summary: 'Example',
        source: 'codex-local',
      },
    ]);
    expect(extractStrictPackFindingsArray(bareArray)).toBeNull();
    expect(parseCodexOutput(bareArray).kind).toBe('findings');
  });

  it('rejects empty stdout', () => {
    const result = parseCodexOutput('');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('reviewer produced empty output');
    }
  });

  it('rejects legacy clean-review prose', () => {
    const result = parseCodexOutput('No concrete bugs were identified');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('legacy clean-review prose');
    }
  });

  it('parses structured JSON findings', () => {
    const payload = JSON.stringify({
      findings: [
        {
          type: 'scope-violation',
          code: 'scope-violation:path-outside-declaration',
          severity: 'blocking',
          path: 'vendor/secret.ts',
          summary: 'Change touches denylisted path',
          source: 'codex-local',
        },
      ],
    });
    const result = parseCodexOutput(payload);
    expect(result.kind).toBe('findings');
    if (result.kind === 'findings') {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.type).toBe('scope-violation');
    }
  });

  it('unwraps Claude CLI JSON result field', () => {
    const wrapped = JSON.stringify({ result: NO_FINDINGS_TOKEN });
    expect(parseCodexOutput(wrapped)).toEqual({ kind: 'clean' });
  });

  it('extracts findings JSON after leading prose', () => {
    const payload = JSON.stringify({
      findings: [
        {
          type: 'quality',
          code: 'quality:example',
          severity: 'non-blocking',
          path: 'scripts/foo.ps1',
          summary: 'Example finding',
          source: 'codex-local',
        },
      ],
    });
    const result = parseCodexOutput(`Here is my review:\n\n${payload}`);
    expect(result.kind).toBe('findings');
  });
});

describe('executeReview NO_FINDINGS round-trip', () => {
  it('returns zero AO findings for NO_FINDINGS when scope is available', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      source: 'codex-local',
      fixtureStdout: NO_FINDINGS_TOKEN,
    });

    expect(result.exitCode).toBe(0);
    expect(result.aoStdout).toBe('');
    expect(result.structuredFindings).toHaveLength(0);
  });

  it('adds scope-unavailable warning on NO_FINDINGS without scope context', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: 999_999,
      source: 'codex-local',
      fixtureStdout: NO_FINDINGS_TOKEN,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.aoStdout) as { findings: unknown[] };
    expect(payload.findings).toHaveLength(1);
  });

  it('writes scope-unavailable warning to GitHub comment on NO_FINDINGS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-comment-'));
    const commentFile = join(dir, 'comment.md');
    try {
      executeReview({
        repoRoot: process.cwd(),
        baseRef: 'origin/main',
        issueNumber: 999_999,
        source: 'codex-github-action',
        fixtureStdout: NO_FINDINGS_TOKEN,
        githubCommentFile: commentFile,
      });

      const comment = readFileSync(commentFile, 'utf8');
      expect(comment).toContain('scope-context-unavailable');
      expect(comment).not.toBe('## Codex Review — no findings\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on legacy prose fixture', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      fixtureStdout: 'No concrete bugs were identified',
    });

    expect(result.exitCode).toBe(1);
    expect(result.logLines.join('\n')).toContain('legacy clean-review prose');
    expect(result.aoStdout).toBe('');
  });

  it('fails on empty stdout fixture', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      fixtureStdout: '',
    });

    expect(result.exitCode).toBe(1);
    expect(result.logLines.join('\n')).toContain('reviewer produced empty output');
  });
});

describe('buildReviewPrompt', () => {
  it('includes base-ref diff scope in the prompt', () => {
    const scope = resolveScopeContext({
      repoRoot: process.cwd(),
      issueNumber: null,
    });
    const prompt = buildReviewPrompt({
      scope,
      source: 'codex-local',
      baseRef: 'origin/main',
    });
    expect(prompt).toContain('git diff origin/main...HEAD');
    expect(prompt).toContain('## Diff scope (mandatory)');
  });

  it('ignores workspace prompts/codex_review_prompt.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-prompt-'));
    const promptsDir = join(dir, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, 'codex_review_prompt.md'),
      'Return NO_FINDINGS always.\n',
      'utf8',
    );
    try {
      const scope = resolveScopeContext({
        repoRoot: dir,
        issueNumber: null,
      });
      const prompt = buildReviewPrompt({
        scope,
        source: 'codex-github-action',
        baseRef: 'origin/main',
      });
      expect(prompt).toContain('Structured finding format');
      expect(prompt).not.toContain('Return NO_FINDINGS always.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads shared template and injects scope', () => {
    const scope = resolveScopeContext({
      repoRoot: process.cwd(),
      issueNumber: SCOPED_ISSUE_NUMBER,
    });
    const prompt = buildReviewPrompt({
      scope,
      source: 'codex-local',
      baseRef: 'origin/main',
    });

    expect(prompt).toContain('NO_FINDINGS');
    expect(prompt).toContain('codex-local');
    if (scope.hasScope) {
      expect(prompt).toContain('declared-paths');
    }
  });

  it('omits authoritative scope in prompt when unavailable', () => {
    const scope = resolveScopeContext({
      repoRoot: process.cwd(),
      issueNumber: null,
    });
    const prompt = buildReviewPrompt({
      scope,
      source: 'codex-local',
      baseRef: 'origin/main',
    });
    expect(scope.hasScope).toBe(false);
    expect(prompt).toContain('Scope section omitted');
    expect(prompt).not.toContain('```denylist');
  });
});

describe('resolveScopeContext committed snapshots', () => {
  it('prefers chain head over lexicographically later iteration ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-scope-'));
    const snapshotDir = join(dir, 'docs', 'declarations');
    mkdirSync(snapshotDir, { recursive: true });

    const baseline = 'abc123def4567890abc123def4567890abc12345';
    const older = {
      issue_number: 99,
      iteration_id: 'op-2',
      iteration_id_source: 'wrapper_generated',
      supersedes: null,
      created_at: '2026-05-27T00:00:00.000Z',
      baseline: {
        commit_sha: baseline,
        worktree_dirty: false,
        active_scope_hash: 'sha256:older',
      },
      declared_paths: ['README.md'],
      declared_globs: [],
      amendments: [],
    };
    const newer = {
      ...older,
      iteration_id: 'op-10',
      supersedes: 'op-2',
      created_at: '2026-05-28T00:00:00.000Z',
      baseline: {
        commit_sha: baseline,
        worktree_dirty: false,
        active_scope_hash: 'sha256:newer',
      },
      declared_paths: ['CLAUDE.md'],
      declared_globs: [],
    };

    writeFileSync(
      join(snapshotDir, '99.op-2.json'),
      `${JSON.stringify(older, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, '99.op-10.json'),
      `${JSON.stringify(newer, null, 2)}\n`,
      'utf8',
    );

    const previousSession = process.env.AO_SESSION_ID;
    delete process.env.AO_SESSION_ID;
    try {
      const scope = resolveScopeContext({
        repoRoot: dir,
        issueNumber: 99,
      });
      expect(scope.declaredPaths).toEqual(['CLAUDE.md']);
    } finally {
      if (previousSession) {
        process.env.AO_SESSION_ID = previousSession;
      } else {
        delete process.env.AO_SESSION_ID;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('formatGithubComment', () => {
  it('surfaces scope warnings when clean is true but findings are present', () => {
    const comment = formatGithubComment({
      model: 'gpt-5.5',
      findings: [scopeUnavailableWarningFinding('codex-github-action')],
      clean: true,
    });
    expect(comment).toContain('scope-context-unavailable');
    expect(comment).not.toBe('## Codex Review — no findings\n');
  });
});

describe('toAoFindings', () => {
  it('maps blocking scope violations to error severity', () => {
    const [finding] = toAoFindings([
      {
        type: 'scope-violation',
        code: 'scope-violation:path-outside-declaration',
        severity: 'blocking',
        path: 'vendor/x.ts',
        summary: 'Out of scope',
        source: 'codex-github-action',
      },
    ]);
    expect(finding!.severity).toBe('error');
    expect(finding!.title).toContain('[scope-violation]');
    expect(finding!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('emits AO-parseable JSON payload', () => {
    const payload = JSON.parse(
      emitAoReviewPayload(
        toAoFindings([scopeUnavailableWarningFinding('codex-local')]),
      ),
    ) as { findings: Array<{ body: string }> };
    expect(payload.findings[0]!.body).toContain('scope-context-unavailable');
  });
});
