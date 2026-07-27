import { describe, expect, it } from 'vitest';
import { buildReviewPrompt } from '../plugins/ao-codex-pr-reviewer/lib/prompt.ts';
import {
  CANONICAL_CONTRACT_CLAUSE_MARKERS,
  buildGptReviewPrompt,
  codexPromptIncludesCanonicalContract,
  gptPromptIncludesCanonicalContract,
  loadCanonicalReviewContract,
} from './lib/pack-pr-review-contract.ts';

describe('pack PR review canonical contract (Issue #1031)', () => {
  it('loads one canonical contract with all seven required clauses', () => {
    const contract = loadCanonicalReviewContract();
    for (const marker of CANONICAL_CONTRACT_CLAUSE_MARKERS) {
      expect(contract).toContain(marker);
    }
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
});
