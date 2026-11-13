import { describe, expect, it } from 'vitest';
import { buildReviewPrompt } from '../plugins/codex-pr-reviewer/lib/prompt.ts';
import {
  CANONICAL_CONTRACT_CLAUSE_MARKERS,
  buildGptReviewPrompt,
  codexPromptIncludesCanonicalContract,
  gptPromptIncludesCanonicalContract,
  loadCanonicalReviewContract,
  loadGptPromptTemplate,
} from './lib/pack-pr-review-contract.ts';

describe('pack PR review canonical contract (Issue #1031)', () => {
  it('loads one canonical contract with all seven required clauses', () => {
    const contract = loadCanonicalReviewContract();
    for (const marker of CANONICAL_CONTRACT_CLAUSE_MARKERS) {
      expect(contract).toContain(marker);
    }
  });

  it('Issue #2796 keeps native-Linux concurrent race evaluation in reviewer prose', () => {
    const contract = loadCanonicalReviewContract();
    expect(contract).toContain('native Linux workstation');
    expect(contract).toContain('moderate local concurrency');
    expect(contract).toContain('shared Browser-GPT panes');
    expect(contract).toContain('exact-reviewed-head file:line');
    expect(contract).toContain('proportionate blocking or non-blocking reviewer judgment');
    expect(contract).not.toContain('REJECT a race');
    expect(contract).not.toContain('Otherwise choose FIX_NOW or DEFER');
  });

  it('Issue #2831 keeps unexecutable criteria non-blocking and unread sources fail-closed', () => {
    const cleanReview = loadGptPromptTemplate().split('### Clean review')[1]?.split('### Findings review')[0] ?? '';
    const text = cleanReview.replace(/\s+/gu, ' ');
    expect(text).toContain('read the linked Issue in full, read every changed file and the whole diff at the bound head');
    expect(text).toContain('command execution (such as tests or `make check`)');
    expect(text).toContain('GitHub search returning `incomplete_results`');
    expect(text).toContain('required CI that checks it is confirmed successful for the exact bound head');
    expect(text).toContain('otherwise classify it as `unverified-by-reviewer`');
    expect(text).toContain('Such a criterion alone must not block `NO_FINDINGS`');
    expect(text).toContain('Preserve the normal exact `NO_FINDINGS` or findings payload format');
    expect(text).toContain(
      'Withhold the verdict only if the linked Issue, a changed file, or the diff at the bound head could not be read completely.',
    );
    expect(text).toContain('do not emit `NO_FINDINGS`, fabricate findings, or publish a canonical source comment/payload');
    expect(text).toContain('An `unverified-by-reviewer` criterion after complete required reads is not an unread-source case.');
  });

  it('composes GPT and Codex prompts from the same canonical contract', () => {
    const gptPrompt = buildGptReviewPrompt({
      prUrl: 'https://github.com/example/repo/pull/1',
      headSha: 'a'.repeat(40),
      scope: {
        hasScope: false,
        issueNumber: null,
        issueConstraints: null,
        declaredPaths: [],
        declaredGlobs: [],
        unverifiedIssueConstraints: false,
      },
    });
    const codexPrompt = buildReviewPrompt({
      scope: {
        hasScope: false,
        issueNumber: null,
        issueConstraints: null,
        declaredPaths: [],
        declaredGlobs: [],
        unverifiedIssueConstraints: false,
      },
      source: 'codex-local',
      baseRef: 'origin/main',
    });

    expect(gptPromptIncludesCanonicalContract(gptPrompt)).toBe(true);
    expect(codexPromptIncludesCanonicalContract(codexPrompt)).toBe(true);
    expect(gptPrompt).toContain('https://github.com/example/repo/pull/1');
    expect(gptPrompt).toContain('a'.repeat(40));
    expect(gptPrompt).toContain('Do **not** create GitHub reviews');
    expect(gptPrompt).toContain('Do **not** rely on a pasted diff');
  });

  it('makes managed runner-shaped frozen scope non-authoritative for guard mode', () => {
    const frozenScope = {
      hasScope: true,
      issueNumber: 22,
      issueConstraints: { denylist: ['vendor/**'], allowed_roots: ['tests/**'] },
      declaredPaths: [],
      declaredGlobs: [],
      unverifiedIssueConstraints: false,
    };
    const unguardedPrompt = buildGptReviewPrompt({
      prUrl: 'https://github.com/example/unguarded/pull/22',
      headSha: 'b'.repeat(40),
      scope: frozenScope,
    });
    const guardedPrompt = buildGptReviewPrompt({
      prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/22',
      headSha: 'b'.repeat(40),
      scope: frozenScope,
    });

    for (const prompt of [unguardedPrompt, guardedPrompt]) {
      expect(prompt).toContain('Target PR scope-guard applicability: unverified');
      expect(prompt).toContain('full live linked Issue body');
      expect(prompt).toContain("PR target's authoritative base");
      expect(prompt).toContain('active `pr-scope-guard` job');
      expect(prompt).toContain('Confirmed guard-free');
      expect(prompt).toContain('Confirmed guard-enabled');
      expect(prompt).toContain('Check every actually changed path');
      expect(prompt).toContain('missing or pending CI is');
      expect(prompt).toContain('Guard applicability is unverified');
      expect(prompt).toContain('canonical validity and Issue-policy compatibility');
    }
    expect(unguardedPrompt).toContain('declarations are not scope authority');
    expect(unguardedPrompt).toContain('An untouched historical artifact alone is irrelevant');
    expect(guardedPrompt).toContain('Report missing/invalid');
  });
});
