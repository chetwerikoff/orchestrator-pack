import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, renderNativeDiffScope } from '../plugins/codex-pr-reviewer/lib/prompt.ts';
import {
  CANONICAL_CONTRACT_CLAUSE_MARKERS,
  buildGptReviewPrompt,
  codexPromptIncludesCanonicalContract,
  gptPromptIncludesCanonicalContract,
  loadCanonicalReviewContract,
  loadGptPromptTemplate,
  renderGptReviewRangeTemplate,
  renderAuthenticatedGptFinalCapSection,
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
    const cleanReview = renderGptReviewRangeTemplate(loadGptPromptTemplate(), false)
      .split('### Clean review')[1]?.split('### Findings review')[0] ?? '';
    const text = cleanReview.replace(/\s+/gu, ' ');
    expect(text).toContain('read the linked Issue in full, read every changed file and the complete PR-level net diff/patch hunks at the verified live PR base/head');
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

describe('Issue #2835 ordinary templates remain unchanged in unbound mode', () => {
  it('does not claim a F..T context without an authenticated persisted runner record', () => {
    const scope = { hasScope: false, issueNumber: null, issueConstraints: null,
      declaredPaths: [], declaredGlobs: [], unverifiedIssueConstraints: false } as const;
    const gpt = buildGptReviewPrompt({
      prUrl: 'https://github.com/example/repo/pull/2835',
      headSha: '1'.repeat(40), scope: { ...scope, declaredPaths: [], declaredGlobs: [] },
    });
    const native = buildReviewPrompt({
      scope: { ...scope, declaredPaths: [], declaredGlobs: [] },
      source: 'codex-local', baseRef: 'origin/main',
    });
    expect(gpt).not.toContain('Authenticated final-cap delta review');
    expect(native).not.toContain('Authenticated final-cap delta');
    expect(gpt).toContain('read every changed file and the complete PR-level net diff/patch hunks at the verified live PR base/head');
    expect(native).toContain('Review **only** the changes between `origin/main` and `HEAD`');
  });
});

describe('Issue #2864 PR net-diff selection and specific prior-finding closure instructions', () => {
  const scope = {
    hasScope: false, issueNumber: null, issueConstraints: null,
    declaredPaths: [], declaredGlobs: [], unverifiedIssueConstraints: false,
  };
  const browser = () => buildGptReviewPrompt({
    prUrl: 'https://github.com/example/repository/pull/2864',
    headSha: 'f'.repeat(40),
    scope,
  });

  it('emits live PR-level base/head net-path and hunk reads, not merge-history selection', () => {
    const prompt = browser();
    expect(prompt).toContain('exact bound head T');
    expect(prompt).toContain('base.ref and base.sha');
    expect(prompt).toContain('complete PR-level changed-file inventory');
    expect(prompt).toContain('every per-file net patch/hunk');
    expect(prompt).toContain('same verified PR base/head snapshot');
    expect(prompt).toContain('base-to-T net paths AND hunks');
    expect(prompt).toContain('Exclude M-only paths/hunks');
    expect(prompt).toContain('include conflict-resolution hunks');
    expect(prompt).toContain('PR base/head drifts');
    expect(prompt).toContain('comparison is truncated');
    expect(prompt).toContain('Do not assert P-only');
    expect(prompt).toContain('no-valid-review outcome');
    expect(prompt).not.toContain('Independently inspect the PR diff/code for the bound head.');
    expect(prompt).not.toContain('{{REVIEW_DIFF_RANGE_INSTRUCTIONS}}');
    expect(prompt).not.toContain('{{REVIEW_CHANGED_CODE_READ}}');
  });

  it('requires authenticated, independently authorized and applicable closure, never preinjects ruling bytes', () => {
    const prompt = browser();
    for (const witness of [
      'authenticated **top-level comments**', 'exact reviewed PR', 'live linked Issue',
      'GitHub comment URL/id', 'authenticated `user.login`', 'quoted explicit `closed` decision',
      'stable finding code', 'specific prior review/finding occurrence',
      'reviewed head/code state', 'independently authorized ARCH/operator principal',
    ]) expect(prompt).toContain(witness);
    for (const negative of [
      'self-description', 'author_association', 'OWNER status',
      'Other-repository/PR', 'wrong-code/head', 'spoofed', 'ambiguous',
      'unverified context', 'later heads', 'different file',
    ]) expect(prompt).toContain(negative);
    expect(prompt).toContain('does not establish that role');
    expect(prompt).toContain('Do not repeat it solely from the historical review');
    expect(prompt).toContain('no longer outstanding');
    expect(prompt).toContain('new scope/security violations');
    expect(prompt).toContain('Closing a reviewer finding never expands');
    expect(prompt).not.toContain('scope:backfill-file-explicitly-excluded');
    expect(prompt).not.toContain('7073860279');
  });

  it('keeps normal review and authenticated final-cap F..T instruction branches disjoint and fails on slot drift', () => {
    const template = loadGptPromptTemplate();
    const ordinary = renderGptReviewRangeTemplate(template, false);
    const finalCap = renderGptReviewRangeTemplate(template, true);
    expect(ordinary).toContain('- Ordinary review:');
    expect(ordinary).not.toContain('- Authenticated final-cap F..T review:');
    expect(finalCap).toContain('- Authenticated final-cap F..T review:');
    expect(finalCap).toContain('inspect only the complete connected GitHub F..T changed paths AND hunks');
    expect(finalCap).toContain('read every changed F..T file and the complete F..T diff');
    expect(finalCap).not.toContain('- Ordinary review:');
    expect(finalCap).not.toContain('read every changed file and the complete PR-level net diff');
    expect(finalCap).toContain('Applicable verified closed prior instances remain closed');
    expect(finalCap).toContain('newly offending F..T code');
    expect(finalCap).toContain('independent security/scope defects');
    expect(() => renderGptReviewRangeTemplate(
      template.replace('{{REVIEW_DIFF_RANGE_INSTRUCTIONS}}', 'moved'), true,
    )).toThrow('missing or duplicate range slot');
    expect(() => renderGptReviewRangeTemplate(
      template.replace('{{REVIEW_CHANGED_CODE_READ}}', 'moved'), true,
    )).toThrow('missing or duplicate range slot');
    expect(() => renderGptReviewRangeTemplate(
      template + '\n{{REVIEW_DIFF_RANGE_INSTRUCTIONS}}', true,
    )).toThrow('missing or duplicate range slot');
  });

  it('renders historical F..T prior findings without turning a verified same-PR closure into an outstanding blocker', () => {
    // The run-store authenticates F/T in production. These are synthetic section
    // inputs, not proof of a GitHub comment read or a model NO_FINDINGS result.
    const priorCode = 'scope:historical-instance-2864';
    const deltaSection = renderAuthenticatedGptFinalCapSection({
      originalRunId: 'old-reviewed-run',
      originalCycleId: 'review-cycle-1',
      fromSha: 'a'.repeat(40),
      toSha: 'b'.repeat(40),
      priorFindings: [{ code: priorCode, head: 'a'.repeat(40), severity: 'blocking' }],
    });
    expect(deltaSection).toContain('Authenticated final-cap delta review');
    expect(deltaSection).toContain('frozen reviewed frontier F');
    expect(deltaSection).toContain(priorCode);
    expect(deltaSection).toContain('historical inputs, not proof');
    expect(deltaSection).toContain('still-applicable ARCH/operator closure');
    expect(deltaSection).toContain('do not re-raise an unchanged closed instance');
    expect(deltaSection).toContain('remains in priorFindings');
    expect(deltaSection).toContain('new F..T defect');
    expect(deltaSection).toContain('semantically relevant changes outside an old filename');
    expect(deltaSection).toContain('independent scope/security violations');
    expect(deltaSection).toContain('Unverified closure evidence cannot suppress');
    expect(deltaSection).not.toContain('Report every still-unresolved old blocker');
    // The frozen historical row is deliberately still serialized, not erased.
  });

  it('keeps native local comparison explicitly unverified; simulated authenticated F..T retains closed-instance precedence', () => {
    const normal = renderNativeDiffScope('origin/main');
    expect(normal).toContain('git diff origin/main...HEAD');
    expect(normal).toContain('NOT authenticated as this live PR target base');
    expect(normal).toContain('stale origin/main');
    expect(normal).toContain('overlap/conflict-resolution hunk');
    expect(normal).toContain('label PR ownership unverified');
    const fromSha = 'a'.repeat(40);
    const toSha = 'b'.repeat(40);
    const finalCap = renderNativeDiffScope(fromSha, {
      fromSha, toSha,
      priorFindings: [{ code: 'scope:historical', severity: 'blocking' }],
    });
    expect(finalCap).toContain('Authenticated final-cap delta');
    expect(finalCap).toContain(`git diff ${fromSha}...HEAD`);
    expect(finalCap).toContain('no longer outstanding even if it remains in priorFindings');
    expect(finalCap).toContain('semantically relevant other-file changes');
    expect(finalCap).toContain('independent scope/security violations');
    expect(finalCap).toContain('cannot be verified from evidence actually available');
    expect(finalCap).not.toContain('caller-supplied local comparison');
    expect(finalCap).not.toContain('Review **only** the changes between');
  });
});
