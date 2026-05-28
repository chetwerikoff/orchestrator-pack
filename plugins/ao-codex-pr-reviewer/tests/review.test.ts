import { describe, expect, it } from 'vitest';
import { buildCodexExecReviewArgs } from '../lib/run_review.js';
import { emitAoReviewPayload, toAoFindings } from '../lib/emit.js';
import { NO_FINDINGS_TOKEN, parseCodexOutput } from '../lib/parse_output.js';
import { buildReviewPrompt } from '../lib/prompt.js';
import { executeReview } from '../lib/review_core.js';
import {
  formatScopeSection,
  resolveScopeContext,
  scopeUnavailableWarningFinding,
} from '../lib/scope_context.js';
const SCOPED_ISSUE_NUMBER = 6;

describe('buildCodexExecReviewArgs', () => {
  it('places model flag before --base and keeps base ref as its value', () => {
    const args = buildCodexExecReviewArgs({
      baseRef: 'origin/main',
      outputFile: '/tmp/out.txt',
      model: 'gpt-5.5',
    });
    const baseIndex = args.indexOf('--base');
    expect(baseIndex).toBeGreaterThan(-1);
    expect(args[baseIndex + 1]).toBe('origin/main');
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
    expect(args.indexOf('-m')).toBeLessThan(baseIndex);
  });
});

describe('parseCodexOutput', () => {
  it('treats exact NO_FINDINGS as clean', () => {
    expect(parseCodexOutput(NO_FINDINGS_TOKEN)).toEqual({ kind: 'clean' });
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
  it('loads shared template and injects scope', () => {
    const scope = resolveScopeContext({
      repoRoot: process.cwd(),
      issueNumber: SCOPED_ISSUE_NUMBER,
    });
    const prompt = buildReviewPrompt({
      repoRoot: process.cwd(),
      scope,
      source: 'codex-local',
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
      repoRoot: process.cwd(),
      scope,
      source: 'codex-local',
    });
    expect(scope.hasScope).toBe(false);
    expect(prompt).toContain('Scope section omitted');
    expect(prompt).not.toContain('```denylist');
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
