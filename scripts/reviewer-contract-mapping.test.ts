import { readFileSync } from 'node:fs';
import path, { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildContractMappingQuestion,
  scrubPathForProviderPrompt,
  scrubAmbiguousPathsForProviderPrompt,
  buildCoworkerInvokeArgv,
  buildSpecArtifactContent,
  buildStructuredStatusRecord,
  classifyChangedTestFiles,
  collectAuthoritativeReferences,
  coerceMappingLedger,
  countDiffLines,
  computeBoundDiffArtifactHash,
  isMissingTestClaim,
  isValidMappingCandidate,
  CONTRACT_MAPPING_QUESTION,
  CONTRACT_SECTION_HEADINGS,
  evaluateFinalUsability,
  hashIssueBodySnapshot,
  sha256Hex,
  evaluateMappingPreflight,
  finalizeMappingFromLedger,
  extractChangedFileContentFromDiff,
  collectIncompleteDiffEvidencePaths,
  hasCompleteChangedFileEvidence,
  isResolvedPathInsideDir,
  extractContractSections,
  hasCompleteTestFileCoverage,
  hasTestableAcceptanceCriteria,
  loadPromptContractMarkers,
  parseAcceptanceCriteria,
  prepareMappingArtifacts,
  resolveContractSet,
  resolveStatusPrecedence,
  scrubForProviderInput,
  specsDeclareCoApplicability,
  STATUS_PRECEDENCE,
  validateMappingLedger,
  type ContractSpecMember,
  type MappingLedger,
} from './lib/reviewer-contract-mapping.js';
import {
  applyMappedOutputFinalUsability,
  loadSpecBodiesFromOptions,
  parseIssueSpecAssignments,
  recomputeCurrentSpecHashes,
  tryRecomputeCurrentSpecHashes,
  createLocalIssueBodyResolver,
  createGitHubIssueBodyResolver,
  createSpecFreshnessResolver,
  buildSpecRereadFallbackOutput,
  mergeSpecRereadFailure,
  shouldInvokeCoworkerForStatus,
  resolveLiveHeadSha,
  resolveCoworkerLedgerInput,
} from './invoke-reviewer-contract-mapping.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/reviewer-contract-mapping',
);

function fixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

function loadIssue(name: string, issueNumber: number) {
  return { issueNumber, body: fixture(name) };
}

function memberFromIssue(name: string, issueNumber: number): ContractSpecMember {
  const body = fixture(name);
  const extracted = extractContractSections(body);
  return {
    issueNumber,
    snapshotHash: 'hash-' + issueNumber,
    sections: extracted.sections,
    acceptanceCriteria: parseAcceptanceCriteria(extracted.sections['Acceptance criteria']),
  };
}

const satisfiedEvidence = {
  implementationLocation: 'scripts/lib/reviewer-contract-mapping.ts',
  testEvidence: 'scripts/reviewer-contract-mapping.test.ts',
};

describe('reviewer contract-mapping (Issue #362)', () => {
  it('collects authoritative references and ignores weak mentions', () => {
    const refs = collectAuthoritativeReferences({
      explicitIssueNumber: 362,
      prBody: 'Closes #362\n\nSee also #999 in prose',
      declarationIssueNumber: 362,
    });
    expect(refs).toEqual([362]);
  });

  it('collects every closing reference in the PR body', () => {
    const refs = collectAuthoritativeReferences({
      prBody: 'Closes #100\n\nCloses #200',
    });
    expect(refs).toEqual([100, 200]);
    const a = loadIssue('issue-with-acceptance.md', 100);
    const b = loadIssue('issue-with-acceptance.md', 200);
    const resolved = resolveContractSet(refs, [a, b]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.status).toBe('ambiguous_spec');
    }
  });

  it('ignores closing keywords inside fenced PR-body examples', () => {
    const refs = collectAuthoritativeReferences({
      prBody: 'Closes #362\n\n```markdown\nCloses #123\n```',
    });
    expect(refs).toEqual([362]);
  });


  it('finds issue links in later relationship sections', () => {
    const parentBody = [
      '## Goal',
      '',
      'Parent spec.',
      '',
      '## Related',
      '',
      '- Unrelated tracker item',
      '',
      '## Parent',
      '',
      '- GitHub #901 — child prerequisite fixture',
      '',
      '## Acceptance criteria',
      '',
      '1. Parent criterion.',
    ].join('\n');
    const child = loadIssue('issue-child-901.md', 901);
    expect(
      specsDeclareCoApplicability([
        { issueNumber: 900, body: parentBody },
        { issueNumber: 901, body: child.body },
      ]),
    ).toBe(true);
  });


  it('matches renamed files when extracting diff evidence', () => {
    const diff = [
      'diff --git a/tests/old-name.test.ts b/tests/new-name.test.ts',
      'similarity index 95%',
      'rename from tests/old-name.test.ts',
      'rename to tests/new-name.test.ts',
      'index abc..def 100644',
      '--- a/tests/old-name.test.ts',
      '+++ b/tests/new-name.test.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(extractChangedFileContentFromDiff(diff, 'tests/new-name.test.ts')).toContain(
      'rename to tests/new-name.test.ts',
    );
    expect(hasCompleteChangedFileEvidence(diff, 'tests/new-name.test.ts')).toBe(true);
    expect(collectIncompleteDiffEvidencePaths(['tests/new-name.test.ts'], diff)).toEqual([]);
  });

  it('treats changed text paths missing from the diff as incomplete evidence', () => {
    const diff = fixture('large.diff');
    expect(collectIncompleteDiffEvidencePaths(['scripts/missing.ts'], diff)).toEqual([
      'scripts/missing.ts',
    ]);
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['scripts/missing.ts', 'scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('incomplete_evidence');
    expect(result.shouldInvokeCoworker).toBe(false);
  });

  it('clears invocation readiness after spec reread failure', () => {
    expect(shouldInvokeCoworkerForStatus('mapping_pending')).toBe(true);
    expect(shouldInvokeCoworkerForStatus('stale_spec')).toBe(false);
    expect(shouldInvokeCoworkerForStatus('lookup_unavailable')).toBe(false);
    const merged = mergeSpecRereadFailure({
      status: 'mapped',
      statusRecord: buildStructuredStatusRecord({
        status: 'mapped',
        prHeadSha: 'head-sha',
        members: [memberFromIssue('issue-with-acceptance.md', 362)],
      }),
      ledger: { exhaustive: true, entries: [] },
      fallback: buildSpecRereadFallbackOutput({
        status: 'stale_spec',
        prHeadSha: 'head-sha',
        contractSet: [memberFromIssue('issue-with-acceptance.md', 362)],
        diffContent: fixture('small.diff'),
        preflightStatusRecord: buildStructuredStatusRecord({
          status: 'mapped',
          prHeadSha: 'head-sha',
          members: [memberFromIssue('issue-with-acceptance.md', 362)],
        }),
      }),
      specRereadStatus: 'stale_spec',
    });
    expect(merged.status).toBe('stale_spec');
    expect(shouldInvokeCoworkerForStatus(merged.status)).toBe(false);
  });


  it('rejects generic Related links as contract co-applicability', () => {
    const relatedOnly = [
      '## Goal',
      '',
      'Unrelated spec.',
      '',
      '## Related',
      '',
      '- GitHub #901 — mentioned only in Related',
      '',
      '## Acceptance criteria',
      '',
      '1. Criterion.',
    ].join('\n');
    const otherBody = [
      '## Goal',
      '',
      'Second unrelated spec.',
      '',
      '## Related',
      '',
      '- GitHub #900 — mentioned only in Related',
      '',
      '## Acceptance criteria',
      '',
      '1. Other criterion.',
    ].join('\n');
    expect(
      specsDeclareCoApplicability([
        { issueNumber: 900, body: relatedOnly },
        { issueNumber: 901, body: otherBody },
      ]),
    ).toBe(false);
    const resolved = resolveContractSet([900, 901], [
      { issueNumber: 900, body: relatedOnly },
      { issueNumber: 901, body: otherBody },
    ]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.status).toBe('ambiguous_spec');
    }
  });

  it('fails closed when safe credential redaction precedes decision-bearing secrets', () => {
    const diff = `${fixture('large.diff')}\ntoken=ghp_1234567890123456789012345678901234\n+const key = "AKIAIOSFODNN7EXAMPLE"`;
    expect(scrubForProviderInput(diff, { allowSafeSecretRedaction: true }).ok).toBe(false);
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('skipped_provider_fence');
    expect(result.shouldInvokeCoworker).toBe(false);
  });

  it('resolves co-applicable multi-spec sets via prerequisite links', () => {
    const parent = loadIssue('issue-parent-900.md', 900);
    const child = loadIssue('issue-child-901.md', 901);
    expect(
      specsDeclareCoApplicability([
        { issueNumber: 900, body: parent.body },
        { issueNumber: 901, body: child.body },
      ]),
    ).toBe(true);
    const resolved = resolveContractSet([900, 901], [parent, child]);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.members).toHaveLength(2);
    }
  });

  it('returns ambiguous_spec for conflicting authoritative references', () => {
    const a = loadIssue('issue-with-acceptance.md', 100);
    const b = loadIssue('issue-with-acceptance.md', 200);
    const resolved = resolveContractSet([100, 200], [a, b]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.status).toBe('ambiguous_spec');
    }
  });

  it('extracts complete contract-bearing sections or falls back', () => {
    const extracted = extractContractSections(fixture('issue-with-acceptance.md'));
    expect(extracted.complete).toBe(true);
    for (const heading of CONTRACT_SECTION_HEADINGS) {
      expect(extracted.sections[heading]?.length).toBeGreaterThan(0);
    }
  });

  it('skips_no_acceptance when linked issue lacks testable criteria', () => {
    const issue = loadIssue('issue-without-acceptance.md', 50);
    const resolved = resolveContractSet([50], [issue]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.status).toBe('skipped_no_acceptance');
    }
    const sections = extractContractSections(issue.body).sections;
    expect(hasTestableAcceptanceCriteria(sections)).toBe(false);
  });

  it('parses bullet and checkbox acceptance criteria', () => {
    const extracted = extractContractSections(fixture('issue-with-bullet-acceptance.md'));
    const criteria = parseAcceptanceCriteria(extracted.sections['Acceptance criteria']);
    expect(criteria).toEqual([
      'First bullet acceptance criterion for fixture mapping.',
      'Second bullet acceptance criterion for fixture mapping.',
      'Checkbox acceptance criterion remains testable.',
      'Completed checkbox acceptance criterion is also parsed.',
    ]);
    expect(hasTestableAcceptanceCriteria(extracted.sections)).toBe(true);
    const issue = loadIssue('issue-with-bullet-acceptance.md', 410);
    const resolved = resolveContractSet([410], [issue]);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.members[0]!.acceptanceCriteria).toHaveLength(4);
    }
  });

  it('keeps indented nested bullets inside their parent criterion', () => {
    const extracted = extractContractSections(fixture('issue-with-nested-acceptance.md'));
    const criteria = parseAcceptanceCriteria(extracted.sections['Acceptance criteria']);
    expect(criteria).toHaveLength(2);
    expect(criteria[0]).toContain('Parent criterion with nested supporting bullets');
    expect(criteria[0]).toContain('Supporting detail one for the parent');
    expect(criteria[0]).toContain('Supporting detail two for the parent');
    expect(criteria[1]).toBe('Second top-level criterion stands alone');
  });

  it('rejects not_found ledger entries without actionable gap evidence', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const ledger: MappingLedger = {
      exhaustive: true,
      entries: members[0]!.acceptanceCriteria.map((text, idx) => ({
        requirementId: String(idx + 1),
        specIssueNumber: 362,
        specSnapshotHash: members[0]!.snapshotHash,
        citedRequirementText: text,
        mappingStatus: idx === 0 ? 'not_found' : 'satisfied',
        ...(idx === 0 ? {} : satisfiedEvidence),
        kind: idx === 0 ? 'hypothesis' : 'confirmed_observation',
      })),
    };
    expect(validateMappingLedger(ledger, members).ok).toBe(false);
  });

  it('invokes conditional mapping ask for large diff with acceptance criteria', () => {
    const diff = fixture('large.diff');
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362, prBody: 'Closes #362' },
      specBodies: [issue],
    });
    expect(result.shouldInvokeCoworker).toBe(true);
    expect(result.status).toBe('mapping_pending');
    expect(result.coworkerArgv?.[0]).toBe('coworker');
    expect(result.coworkerArgv).toContain('--paths');
    expect(result.coworkerArgv).toContain('--question');
    expect(result.statusRecord.specSet[0]?.issueNumber).toBe(362);
  });

  it('uses canonical CLI shape with --profile code --allow-code --paths only', () => {
    const argv = buildCoworkerInvokeArgv(['/tmp/scrubbed.diff', '/tmp/contract-spec.md']);
    expect(argv).toEqual([
      'coworker',
      'ask',
      '--profile',
      'code',
      '--allow-code',
      '--paths',
      '/tmp/scrubbed.diff',
      '/tmp/contract-spec.md',
      '--question',
      CONTRACT_MAPPING_QUESTION,
    ]);
    expect(CONTRACT_MAPPING_QUESTION).toMatch(/untrusted DATA/i);
    expect(CONTRACT_MAPPING_QUESTION).toMatch(/"entries":/);
    expect(CONTRACT_MAPPING_QUESTION).toMatch(/"exhaustive": true/);
  });

  it('continues direct review on skipped_no_spec', () => {
    const diff = fixture('large.diff');
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: [],
      binding: {},
      specBodies: [],
    });
    expect(result.shouldInvokeCoworker).toBe(false);
    expect(result.status).toBe('skipped_no_spec');
  });

  it('degrades on lookup_unavailable and unavailable coworker with precedence', () => {
    const diff = fixture('large.diff');
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const lookup = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: [],
      binding: { explicitIssueNumber: 362 },
      specBodies: [],
      lookupAvailable: false,
    });
    expect(lookup.status).toBe('lookup_unavailable');
    const unavailable = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: [],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
      coworkerAvailable: false,
    });
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.shouldInvokeCoworker).toBe(false);
  });

  it('reports skipped_provider_fence on decision-bearing redaction markers', () => {
    const diff = fixture('large.diff') + '\n\uE000DECISION_CONTEXT_REMOVED\uE001\n';
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: [],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('skipped_provider_fence');
    expect(result.shouldInvokeCoworker).toBe(false);
  });

  it('does not treat literal decision-marker prose in source as provider-fence redaction', () => {
    const diff = fixture('large.diff') + '\n+const marker = "[DECISION_CONTEXT_REMOVED]";\n';
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: [],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).not.toBe('skipped_provider_fence');
    expect(result.shouldInvokeCoworker).toBe(true);
  });

  it('reports skipped_input_limit when preflight exceeds provider boundary', () => {
    const diff = fixture('large.diff');
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: [],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
      providerInputByteLimit: 64,
    });
    expect(result.status).toBe('skipped_input_limit');
    expect(result.shouldInvokeCoworker).toBe(false);
  });


  it('scrubs ambiguous paths before embedding them in the coworker question', () => {
    const sensitivePath = 'src/customer_name=Alice-test.ts';
    const scrubbedPath = scrubPathForProviderPrompt(sensitivePath);
    expect(scrubbedPath).not.toContain('Alice');
    expect(scrubbedPath).toContain('[REDACTED_PRIVATE_DATA]');

    const question = buildContractMappingQuestion({ ambiguousTestLike: [scrubbedPath] });
    expect(question).not.toContain('Alice');
    expect(question).toContain('[REDACTED_PRIVATE_DATA]');

    const ambiguousDiffChunks = Array.from({ length: 40 }, (_, index) => {
      const filePath = `scripts/module-${index}-testy.ts`;
      return [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        '@@ -0,0 +1 @@',
        '+export const marker = 1;',
      ].join('\n');
    }).join('\n');
    const diff = `${fixture('large.diff')}\n${ambiguousDiffChunks}`;
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const baseline = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(baseline.status).toBe('mapping_pending');
    expect(baseline.coworkerQuestion?.length ?? 0).toBeGreaterThan(2_000);
    const combinedByteSize = baseline.artifactPrep!.combinedByteSize;
    const questionByteSize = Buffer.byteLength(baseline.coworkerQuestion ?? '', 'utf8');
    const limited = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
      providerInputByteLimit: combinedByteSize + questionByteSize - 1,
    });
    expect(limited.status).toBe('skipped_input_limit');
    expect(limited.shouldInvokeCoworker).toBe(false);
  });

  it('fails closed on credential assignments in source diffs', () => {
    const diff = `${fixture('large.diff')}\n+token = process.env.API_TOKEN\n`;
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('skipped_provider_fence');
    expect(result.shouldInvokeCoworker).toBe(false);
    expect(scrubForProviderInput(diff, { allowSafeSecretRedaction: true }).ok).toBe(false);
  });

  it('classifies test evidence and blocks missing-test claims when ambiguous', () => {
    const diff = fixture('large.diff');
    const classification = classifyChangedTestFiles(
      ['scripts/example.ts', 'scripts/weird-testy-module.ts'],
      diff,
    );
    expect(classification.ambiguousTestLike).toContain('scripts/weird-testy-module.ts');
    expect(hasCompleteTestFileCoverage(diff, ['scripts/example.ts'])).toBe(true);
    expect(hasCompleteTestFileCoverage(diff, ['scripts/missing.test.ts'])).toBe(false);

    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const ledger: MappingLedger = {
      exhaustive: true,
      entries: members[0]!.acceptanceCriteria.map((text, idx) => ({
        requirementId: String(idx + 1),
        specIssueNumber: 362,
        specSnapshotHash: members[0]!.snapshotHash,
        citedRequirementText: text,
        mappingStatus: 'gap_candidate',
        concreteFailureScenario: 'No test covers the new branch.',
        kind: 'missing_validation',
      })),
    };
    expect(
      validateMappingLedger(ledger, members, {
        ambiguousTestLike: classification.ambiguousTestLike,
      }).ok,
    ).toBe(false);

    const question = buildContractMappingQuestion({
      ambiguousTestLike: classification.ambiguousTestLike,
    });
    expect(question).toContain('scripts/weird-testy-module.ts');
    expect(question).toMatch(/missing_validation/i);
  });

  it('extracts complete changed test file hunks for missing-test eligibility', () => {
    const diff = [
      'diff --git a/tests/a.test.ts b/tests/a.test.ts',
      'index 111..222 100644',
      '--- a/tests/a.test.ts',
      '+++ b/tests/a.test.ts',
      '@@ -1 +1,2 @@',
      '+it("covers criterion", () => {});',
    ].join('\n');
    const hunk = extractChangedFileContentFromDiff(diff, 'tests/a.test.ts');
    expect(hunk).toContain('covers criterion');
  });

  it('marks stale head/spec and prevents promoting mapped evidence', () => {
    const prior = buildStructuredStatusRecord({
      status: 'mapped',
      prHeadSha: 'abc',
      members: [memberFromIssue('issue-with-acceptance.md', 362)],
    });
    const staleHead = evaluateFinalUsability({
      prior,
      currentHeadSha: 'def',
      currentSpecHashes: [{ issueNumber: 362, snapshotHash: prior.specSet[0]!.snapshotHash }],
    });
    expect(staleHead.status).toBe('stale_head');
    expect(staleHead.usability).toBe('not_usable');
    const staleSpec = evaluateFinalUsability({
      prior,
      currentHeadSha: 'abc',
      currentSpecHashes: [{ issueNumber: 362, snapshotHash: 'changed' }],
    });
    expect(staleSpec.status).toBe('stale_spec');
    expect(staleSpec.staleDimensions?.spec).toBe(true);
  });

  it('prefers stale_head when both head and spec drift', () => {
    const prior = buildStructuredStatusRecord({
      status: 'mapped',
      prHeadSha: 'abc',
      members: [memberFromIssue('issue-with-acceptance.md', 362)],
    });
    const stale = evaluateFinalUsability({
      prior,
      currentHeadSha: 'def',
      currentSpecHashes: [{ issueNumber: 362, snapshotHash: 'changed' }],
    });
    expect(stale.status).toBe('stale_head');
    expect(stale.staleDimensions).toEqual({ head: true, spec: true });
  });

  it('uses live git HEAD for freshness instead of an explicit bind override', () => {
    const explicit = 'explicit-bound-head-sha';
    const live = resolveLiveHeadSha();
    expect(live).not.toBe('unknown');
    expect(live).not.toBe(explicit);
  });

  it('recomputes spec snapshot hashes from disk before final usability', () => {
    const issuePath = path.join(fixturesDir, 'issue-with-acceptance.md');
    const opts = {
      prBodyFile: null,
      issueFile: null,
      issuesFile: null,
      issueSpecs: [{ issueNumber: 362, filePath: issuePath }],
      diffFile: null,
      changedPathsFile: null,
      explicitIssue: null,
      declarationIssue: null,
      prHeadSha: null,
      ledgerFile: null,
      invokeCoworker: false,
      json: true,
      lookupAvailable: true,
      coworkerAvailable: true,
    };
    const hashes = recomputeCurrentSpecHashes(opts, [{ issueNumber: 362 }]);
    expect(hashes).toEqual([
      { issueNumber: 362, snapshotHash: hashIssueBodySnapshot(fixture('issue-with-acceptance.md')) },
    ]);

    const prior = buildStructuredStatusRecord({
      status: 'mapped',
      prHeadSha: resolveLiveHeadSha(),
      members: [memberFromIssue('issue-with-acceptance.md', 362)],
    });
    const staleSpec = applyMappedOutputFinalUsability({
      status: 'mapped',
      statusRecord: prior,
      ledger: { exhaustive: true, entries: [] },
      currentHeadSha: prior.prHeadSha,
      diffContent: fixture('small.diff'),
      currentSpecHashes: [{ issueNumber: 362, snapshotHash: 'changed-on-disk' }],
    });
    expect(staleSpec.status).toBe('stale_spec');
    expect(staleSpec.ledger).toBeUndefined();
  });

  it('emits reevaluated stale status before returning mapped output', () => {
    const diff = fixture('small.diff');
    const prior = buildStructuredStatusRecord({
      status: 'mapped',
      prHeadSha: 'bound-head',
      diffArtifactHash: computeBoundDiffArtifactHash(diff) ?? undefined,
      members: [memberFromIssue('issue-with-acceptance.md', 362)],
    });
    const ledger: MappingLedger = {
      exhaustive: true,
      entries: [
        {
          requirementId: '1',
          specIssueNumber: 362,
          specSnapshotHash: prior.specSet[0]!.snapshotHash,
          citedRequirementText: 'example',
          mappingStatus: 'satisfied',
          ...satisfiedEvidence,
          kind: 'confirmed_observation',
        },
      ],
    };
    const stale = applyMappedOutputFinalUsability({
      status: 'mapped',
      statusRecord: prior,
      ledger,
      currentHeadSha: 'new-head-after-coworker',
      diffContent: diff,
      currentSpecHashes: [{ issueNumber: 362, snapshotHash: prior.specSet[0]!.snapshotHash }],
    });
    expect(stale.status).toBe('stale_head');
    expect(stale.statusRecord.usability).toBe('not_usable');
    expect(stale.ledger).toBeUndefined();
  });

  it('reports artifact_prep_failed and binds hashes to finalized files', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const prep = prepareMappingArtifacts({
      scrubbedDiff: fixture('large.diff'),
      scrubbedSpec: buildSpecArtifactContent(members),
      members,
    });
    expect(prep.ok).toBe(true);
    if (prep.ok) {
      expect(prep.diffArtifactHash).toHaveLength(64);
      expect(prep.specArtifactHashes[0]?.issueNumber).toBe(362);
      const argv = buildCoworkerInvokeArgv([prep.diffPath, ...prep.specPaths]);
      expect(argv).toContain(prep.diffPath);
      const onDisk = readFileSync(prep.diffPath, 'utf8');
      expect(onDisk.length).toBeGreaterThan(0);
      expect(prep.specArtifactHashes[0]?.snapshotHash).toBe(members[0]!.snapshotHash);
    }
  });


  it('preserves malformed status when coworker output is not valid JSON', () => {
    const resolved = resolveCoworkerLedgerInput({
      invokeCoworker: true,
      coworkerArgv: ['coworker', 'ask'],
      ledgerRaw: null,
      invokeCoworkerArgvFn: () => 'not-json',
    });
    expect(resolved.coworkerInvocationFailed).toBe(false);
    expect(resolved.ledgerPayload).toBeNull();
    const preflight = evaluateMappingPreflight({
      diffLineCount: fixture('small.diff').split(/\r?\n/).length,
      diffContent: fixture('small.diff'),
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [loadIssue('issue-with-acceptance.md', 362)],
    });
    const finalized = finalizeMappingFromLedger({
      preflight,
      ledgerPayload: resolved.ledgerPayload,
      diffContent: fixture('small.diff'),
      currentHeadSha: preflight.statusRecord.prHeadSha,
      coworkerInvocationFailed: resolved.coworkerInvocationFailed,
    });
    expect(finalized.status).toBe('malformed');
  });

  it('reports unavailable only when coworker invocation fails', () => {
    const resolved = resolveCoworkerLedgerInput({
      invokeCoworker: true,
      coworkerArgv: ['coworker', 'ask'],
      ledgerRaw: null,
      invokeCoworkerArgvFn: () => {
        throw new Error('coworker missing');
      },
    });
    expect(resolved.coworkerInvocationFailed).toBe(true);
    const preflight = evaluateMappingPreflight({
      diffLineCount: fixture('small.diff').split(/\r?\n/).length,
      diffContent: fixture('small.diff'),
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [loadIssue('issue-with-acceptance.md', 362)],
    });
    const finalized = finalizeMappingFromLedger({
      preflight,
      ledgerPayload: resolved.ledgerPayload,
      diffContent: fixture('small.diff'),
      currentHeadSha: preflight.statusRecord.prHeadSha,
      coworkerInvocationFailed: resolved.coworkerInvocationFailed,
    });
    expect(finalized.status).toBe('unavailable');
  });

  it('rejects malformed/non-exhaustive ledger responses', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const partial: MappingLedger = {
      exhaustive: false,
      entries: [],
    };
    expect(validateMappingLedger(partial, members).ok).toBe(false);
    const oneShort: MappingLedger = {
      exhaustive: true,
      entries: [
        {
          requirementId: '1',
          specIssueNumber: 362,
          specSnapshotHash: members[0]!.snapshotHash,
          citedRequirementText: members[0]!.acceptanceCriteria[0]!,
          mappingStatus: 'satisfied',
          ...satisfiedEvidence,
          kind: 'confirmed_observation',
        },
      ],
    };
    expect(validateMappingLedger(oneShort, members).ok).toBe(false);
  });

  it('allows missing-implementation candidates with owning surface and absence proof', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const ledger: MappingLedger = {
      exhaustive: true,
      entries: members[0]!.acceptanceCriteria.map((text, idx) => ({
        requirementId: String(idx + 1),
        specIssueNumber: 362,
        specSnapshotHash: members[0]!.snapshotHash,
        citedRequirementText: text,
        mappingStatus: idx === 0 ? 'gap_candidate' : 'satisfied',
        ...(idx === 0 ? {} : satisfiedEvidence),
        expectedOwningSurface: 'scripts/reviewer-helper.ts',
        verifiedAbsenceFromDiff: true,
        concreteFailureScenario: 'Required wiring never appears in the PR diff.',
        kind: 'hypothesis',
      })),
    };
    expect(validateMappingLedger(ledger, members).ok).toBe(true);
  });

  it('fails closed on provider redaction unless explicitly allowlisted', () => {
    const blocked = scrubForProviderInput('token=ghp_1234567890123456789012345678901234');
    expect(blocked.ok).toBe(false);
    const allowed = scrubForProviderInput('token=ghp_1234567890123456789012345678901234', {
      allowSafeSecretRedaction: true,
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.scrubbed).toContain('[REDACTED_SECRET]');
    }
  });

  it('redacts every secret occurrence in provider input', () => {
    const content = 'token=alpha-secret\ntoken=beta-secret\n';
    const scrubbed = scrubForProviderInput(content, { allowSafeSecretRedaction: true });
    expect(scrubbed.ok).toBe(true);
    if (scrubbed.ok) {
      expect(scrubbed.scrubbed).not.toMatch(/token=\S+/);
      expect(scrubbed.scrubbed.match(/\[REDACTED_SECRET\]/g)?.length).toBe(2);
    }
  });

  it('writes scrubbed spec content to the artifact', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const rawSpec = `${buildSpecArtifactContent(members)}\ntoken=ghp_1234567890123456789012345678901234\n`;
    const specScrub = scrubForProviderInput(rawSpec, { allowSafeSecretRedaction: true });
    expect(specScrub.ok).toBe(true);
    if (!specScrub.ok) {
      return;
    }
    const prep = prepareMappingArtifacts({
      scrubbedDiff: fixture('large.diff'),
      scrubbedSpec: specScrub.scrubbed,
      members,
    });
    expect(prep.ok).toBe(true);
    if (prep.ok) {
      const specOnDisk = readFileSync(prep.specPaths[0]!, 'utf8');
      expect(specOnDisk).toContain('[REDACTED_SECRET]');
      expect(specOnDisk).not.toContain('ghp_');
    }
  });

  it('coerces coworker ledger payloads to the validator shape', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const fromEntries = coerceMappingLedger({
      entries: members[0]!.acceptanceCriteria.map((text, idx) => ({
        requirementId: String(idx + 1),
        specIssueNumber: 362,
        specSnapshotHash: members[0]!.snapshotHash,
        citedRequirementText: text,
        mappingStatus: 'satisfied',
        ...satisfiedEvidence,
        kind: 'confirmed_observation',
      })),
      exhaustive: true,
    });
    expect(fromEntries).not.toBeNull();
    expect(validateMappingLedger(fromEntries!, members).ok).toBe(true);

    expect(coerceMappingLedger({ ledger: fromEntries!.entries })).toBeNull();
    expect(coerceMappingLedger({ entries: fromEntries!.entries })).toBeNull();
  });

  it('resolves overlapping failures with deterministic precedence', () => {
    expect(
      resolveStatusPrecedence(['malformed', 'skipped_provider_fence', 'stale_head']),
    ).toBe('stale_head');
    expect(STATUS_PRECEDENCE[0]).toBe('stale_head');
  });

  it('reports incomplete_evidence for binary contract fixtures without full scrubbed content', () => {
    const diff = fixture('large.diff');
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['assets/logo.png'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('incomplete_evidence');
  });

  it('does not invoke mapping below diff delegation floor', () => {
    const diff = fixture('small.diff');
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.shouldInvokeCoworker).toBe(false);
  });

  it('builds spec artifacts from complete extracted sections only', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const content = buildSpecArtifactContent(members);
    expect(content).toContain('## Acceptance criteria');
    expect(content).toContain('snapshot_hash:');
  });

  it('rejects ledger entries with stale or missing snapshot hashes', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const ledger: MappingLedger = {
      exhaustive: true,
      entries: members[0]!.acceptanceCriteria.map((text, idx) => ({
        requirementId: String(idx + 1),
        specIssueNumber: 362,
        specSnapshotHash: 'stale-hash',
        citedRequirementText: text,
        mappingStatus: 'satisfied',
        ...satisfiedEvidence,
        kind: 'confirmed_observation',
      })),
    };
    expect(validateMappingLedger(ledger, members).ok).toBe(false);
  });


  it('detects extensionless binary files from diff markers', () => {
    const binarySummary = [
      'diff --git a/scripts/model.dat b/scripts/model.dat',
      'Binary files a/scripts/model.dat and b/scripts/model.dat differ',
    ].join('\n');
    expect(collectIncompleteDiffEvidencePaths([], binarySummary)).toEqual(['scripts/model.dat']);
    expect(collectIncompleteDiffEvidencePaths(['scripts/example.ts'], binarySummary)).toEqual([
      'scripts/example.ts',
      'scripts/model.dat',
    ]);

    const diff = `${binarySummary}\n${fixture('large.diff')}`;
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('incomplete_evidence');
    expect(result.shouldInvokeCoworker).toBe(false);
  });

  it('fails closed when redaction removes decision-bearing implementation evidence', () => {
    const diff = `${fixture('large.diff')}\n+  const token = "ghp_1234567890123456789012345678901234";\n`;
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('skipped_provider_fence');
    expect(result.shouldInvokeCoworker).toBe(false);
    expect(scrubForProviderInput(diff, { allowSafeSecretRedaction: true }).ok).toBe(false);
  });

  it('redacts the entire PEM private key block for provider input', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAfakebase64material',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const diff = `${fixture('large.diff')}\n+${pem.replace(/\n/g, '\n+')}\n`;
    const scrubbed = scrubForProviderInput(diff, { allowSafeSecretRedaction: true });
    expect(scrubbed.ok).toBe(true);
    if (!scrubbed.ok) {
      return;
    }
    expect(scrubbed.scrubbed).not.toContain('MIIEpAIBAAKCAQEAfakebase64material');
    expect(scrubbed.scrubbed).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(scrubbed.scrubbed).not.toContain('END RSA PRIVATE KEY');
    expect(scrubbed.scrubbed).toContain('[REDACTED_SECRET]');
  });

  it('treats binary summary markers as incomplete evidence', () => {
    const binarySummary = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 111..222 100644',
      'Binary files a/assets/logo.png and b/assets/logo.png differ',
    ].join('\n');
    expect(hasCompleteChangedFileEvidence(binarySummary, 'assets/logo.png')).toBe(false);

    const diff = `${binarySummary}\n${fixture('large.diff')}`;
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['assets/logo.png', 'scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('incomplete_evidence');
    expect(result.shouldInvokeCoworker).toBe(false);
  });

  it('allows safe private-data redaction during mapping preflight', () => {
    const diff = `${fixture('large.diff')}\n+customer_name: Jane Customer\n+notify user@customer.example about rollout\n`;
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('mapping_pending');
    expect(result.shouldInvokeCoworker).toBe(true);
    const scrubbed = scrubForProviderInput(diff, { allowSafeSecretRedaction: true });
    expect(scrubbed.ok).toBe(true);
  });

  it('redacts private data only when safe redaction is explicitly allowlisted', () => {
    const diff = `${fixture('large.diff')}\n+customer_name: Jane Customer\n+notify user@customer.example about rollout\n`;
    const scrubbed = scrubForProviderInput(diff, { allowSafeSecretRedaction: true });
    expect(scrubbed.ok).toBe(true);
    if (!scrubbed.ok) {
      return;
    }
    expect(scrubbed.scrubbed).toContain('[REDACTED_PRIVATE_DATA]');
    expect(scrubbed.scrubbed).not.toContain('user@customer.example');
  });


  it('rejects missing-test claims regardless of coworker kind label', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const diff = fixture('large.diff');
    const classification = classifyChangedTestFiles(['scripts/missing.test.ts'], diff);
    const entry = {
      requirementId: '1',
      specIssueNumber: 362,
      specSnapshotHash: members[0]!.snapshotHash,
      citedRequirementText: members[0]!.acceptanceCriteria[0]!,
      mappingStatus: 'gap_candidate' as const,
      concreteFailureScenario: 'No test covers the new branch.',
      kind: 'hypothesis' as const,
    };
    expect(isMissingTestClaim(entry)).toBe(true);
    const ledger: MappingLedger = {
      exhaustive: true,
      entries: members[0]!.acceptanceCriteria.map((text, idx) => ({
        ...entry,
        requirementId: String(idx + 1),
        citedRequirementText: text,
        mappingStatus: idx === 0 ? 'gap_candidate' : 'satisfied',
        ...(idx === 0 ? {} : satisfiedEvidence),
        concreteFailureScenario: idx === 0 ? entry.concreteFailureScenario : undefined,
        kind: idx === 0 ? 'hypothesis' : 'confirmed_observation',
      })),
    };
    expect(
      validateMappingLedger(ledger, members, {
        diffContent: diff,
        testFiles: classification.testFiles,
        ambiguousTestLike: classification.ambiguousTestLike,
      }).ok,
    ).toBe(false);
  });


  it('loads multiple authoritative issue specs for the executable helper', () => {
    const parent = loadIssue('issue-parent-900.md', 900);
    const child = loadIssue('issue-child-901.md', 901);
    const specs = loadSpecBodiesFromOptions({
      prBodyFile: null,
      issueFile: null,
      issuesFile: null,
      issueSpecs: [
        { issueNumber: 900, filePath: path.join(fixturesDir, 'issue-parent-900.md') },
        { issueNumber: 901, filePath: path.join(fixturesDir, 'issue-child-901.md') },
      ],
      diffFile: null,
      changedPathsFile: null,
      explicitIssue: null,
      declarationIssue: null,
      prHeadSha: null,
      ledgerFile: null,
      invokeCoworker: false,
      json: true,
      lookupAvailable: true,
      coworkerAvailable: true,
    });
    expect(specs).toHaveLength(2);
    expect(specs[0]?.body).toBe(parent.body);
    expect(specs[1]?.body).toBe(child.body);
    expect(parseIssueSpecAssignments(['900=scripts/a.md', '901:scripts/b.md'])).toEqual([
      { issueNumber: 900, filePath: 'scripts/a.md' },
      { issueNumber: 901, filePath: 'scripts/b.md' },
    ]);
  });


  it('allows safe secret redaction during mapping preflight', () => {
    const diff = [
      fixture('large.diff'),
      '+Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature',
      '+Cookie: session=super-secret-session-id',
      '+AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    ].join('\n');
    const issue = loadIssue('issue-with-acceptance.md', 362);
    for (const probe of [
      '+Authorization: Bearer token-value\n',
      '+Cookie: session=secret\n',
      '+token: eyJhbGciOiJIUzI1NiJ9.payload.sig\n',
      '+key=AKIAIOSFODNN7EXAMPLE\n',
    ]) {
      const result = evaluateMappingPreflight({
        diffLineCount: (fixture('large.diff') + probe).split(/\r?\n/).length,
        diffContent: fixture('large.diff') + probe,
        changedPaths: ['scripts/example.ts'],
        binding: { explicitIssueNumber: 362 },
        specBodies: [issue],
      });
      expect(result.status).toBe('mapping_pending');
      expect(result.shouldInvokeCoworker).toBe(true);
      expect(scrubForProviderInput(fixture('large.diff') + probe).ok).toBe(false);
    }
  });

  it('finalizes mapped status only after ledger validation succeeds', () => {
    const diff = fixture('large.diff');
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const prHeadSha = 'abc123';
    const preflight = evaluateMappingPreflight({
      diffLineCount: countDiffLines(diff),
      diffContent: diff,
      prHeadSha,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(preflight.status).toBe('mapping_pending');
    expect(preflight.statusRecord.diffArtifactHash).toBeTruthy();

    const members = preflight.contractSet;
    const validLedger: MappingLedger = {
      exhaustive: true,
      entries: members[0]!.acceptanceCriteria.map((text, idx) => ({
        requirementId: String(idx + 1),
        specIssueNumber: 362,
        specSnapshotHash: members[0]!.snapshotHash,
        citedRequirementText: text,
        mappingStatus: 'satisfied',
        ...satisfiedEvidence,
        kind: 'confirmed_observation',
      })),
    };
    const mapped = finalizeMappingFromLedger({
      preflight,
      ledgerPayload: validLedger,
      diffContent: diff,
      currentHeadSha: prHeadSha,
    });
    expect(mapped.status).toBe('mapped');
    expect(mapped.statusRecord.usability).toBe('usable');

    const malformed = finalizeMappingFromLedger({
      preflight,
      ledgerPayload: { entries: [], exhaustive: false },
      diffContent: diff,
      currentHeadSha: prHeadSha,
    });
    expect(malformed.status).toBe('malformed');

    const unavailable = finalizeMappingFromLedger({
      preflight,
      ledgerPayload: null,
      diffContent: diff,
      currentHeadSha: prHeadSha,
      coworkerInvocationFailed: true,
    });
    expect(unavailable.status).toBe('unavailable');
  });


  it('rejects malformed coworker ledger enum values before mapping', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const base = {
      requirementId: '1',
      specIssueNumber: 362,
      specSnapshotHash: members[0]!.snapshotHash,
      citedRequirementText: members[0]!.acceptanceCriteria[0]!,
    };
    expect(
      coerceMappingLedger({
        exhaustive: true,
        entries: [{ ...base, mappingStatus: 'complete', kind: 'confirmed_observation' }],
      }),
    ).toBeNull();
    expect(
      coerceMappingLedger({
        exhaustive: true,
        entries: [{ ...base, mappingStatus: 'satisfied', kind: 'observation' }],
      }),
    ).toBeNull();
    expect(isValidMappingCandidate({ ...base, mappingStatus: 'satisfied', ...satisfiedEvidence, kind: 'confirmed_observation' })).toBe(true);
  });

  it('returns stale_head when ledger finalization head or diff binding drifts', () => {
    const diff = fixture('large.diff');
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const prHeadSha = 'bound-head';
    const preflight = evaluateMappingPreflight({
      diffLineCount: countDiffLines(diff),
      diffContent: diff,
      prHeadSha,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    const members = preflight.contractSet;
    const validLedger: MappingLedger = {
      exhaustive: true,
      entries: members[0]!.acceptanceCriteria.map((text, idx) => ({
        requirementId: String(idx + 1),
        specIssueNumber: 362,
        specSnapshotHash: members[0]!.snapshotHash,
        citedRequirementText: text,
        mappingStatus: 'satisfied',
        ...satisfiedEvidence,
        kind: 'confirmed_observation',
      })),
    };
    const staleHead = finalizeMappingFromLedger({
      preflight,
      ledgerPayload: validLedger,
      diffContent: diff,
      currentHeadSha: 'new-head',
    });
    expect(staleHead.status).toBe('stale_head');

    const staleDiff = finalizeMappingFromLedger({
      preflight,
      ledgerPayload: validLedger,
      diffContent: diff + '\n+stale drift\n',
      currentHeadSha: prHeadSha,
    });
    expect(staleDiff.status).toBe('stale_head');
  });

  it('counts trailing-newline diffs at the delegation floor without off-by-one', () => {
    const lines = Array.from({ length: 200 }, (_, idx) => `+line-${idx}`);
    const diff = `${lines.join('\n')}\n`;
    expect(countDiffLines(diff)).toBe(200);
    expect(diff.split(/\r?\n/).length).toBe(201);
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const atFloor = evaluateMappingPreflight({
      diffLineCount: countDiffLines(diff),
      diffContent: diff,
      changedPaths: [],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(atFloor.shouldInvokeCoworker).toBe(false);

    const aboveFloor = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: [],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(aboveFloor.shouldInvokeCoworker).toBe(true);
    expect(aboveFloor.status).toBe('mapping_pending');
  });

  it('allows safe connection-string redaction during mapping preflight', () => {
    const diff = fixture('large.diff') + '\n+DATABASE_URL=postgres://alice:s3cr3t@db/prod\n';
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: countDiffLines(diff),
      diffContent: diff,
      changedPaths: ['scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('mapping_pending');
    expect(result.shouldInvokeCoworker).toBe(true);
    expect(scrubForProviderInput(diff).ok).toBe(false);
    expect(scrubForProviderInput(diff, { allowSafeSecretRedaction: true }).ok).toBe(true);
  });


  it('rejects ledgers that reuse one entry for duplicate acceptance criteria', () => {
    const duplicateCriterion = 'The helper must redact provider input safely.';
    const members: ContractSpecMember[] = [
      {
        issueNumber: 362,
        snapshotHash: 'spec-hash',
        sections: {},
        acceptanceCriteria: [duplicateCriterion, duplicateCriterion],
      },
    ];
    const ledger: MappingLedger = {
      exhaustive: true,
      entries: [
        {
          requirementId: '1',
          specIssueNumber: 362,
          specSnapshotHash: 'spec-hash',
          citedRequirementText: duplicateCriterion,
          mappingStatus: 'satisfied',
          implementationLocation: 'scripts/example.ts',
          kind: 'confirmed_observation',
        },
        {
          requirementId: '2',
          specIssueNumber: 362,
          specSnapshotHash: 'spec-hash',
          citedRequirementText: 'Unrelated criterion text',
          mappingStatus: 'satisfied',
          implementationLocation: 'scripts/other.ts',
          kind: 'confirmed_observation',
        },
      ],
    };
    expect(validateMappingLedger(ledger, members).ok).toBe(false);
  });

  it('preserves stale_head when spec reread also drifts', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const diff = fixture('small.diff');
    const staleHeadRecord = buildStructuredStatusRecord({
      status: 'stale_head',
      prHeadSha: 'new-head',
      diffArtifactHash: computeBoundDiffArtifactHash(diff) ?? undefined,
      members,
      staleDimensions: { head: true },
    });
    const fallback = buildSpecRereadFallbackOutput({
      status: 'stale_spec',
      prHeadSha: 'new-head',
      contractSet: members,
      diffContent: diff,
      preflightStatusRecord: staleHeadRecord,
    });
    const merged = mergeSpecRereadFailure({
      status: 'stale_head',
      statusRecord: staleHeadRecord,
      ledger: undefined,
      fallback,
      specRereadStatus: 'stale_spec',
    });
    expect(merged.status).toBe('stale_head');
    expect(merged.statusRecord.staleDimensions).toEqual({ head: true, spec: true });
    expect(merged.ledger).toBeUndefined();
  });

  it('exposes prompt contract markers for static checks', () => {
    const markers = loadPromptContractMarkers();
    expect(markers.requiredInAgentRules).toContain('candidate evidence');
    expect(markers.forbiddenInPrompts.join(' ')).toMatch(/assign severity/i);
  });

  it('rejects satisfied ledger entries without implementation or test evidence', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const ledger: MappingLedger = {
      exhaustive: true,
      entries: members[0]!.acceptanceCriteria.map((text, idx) => ({
        requirementId: String(idx + 1),
        specIssueNumber: 362,
        specSnapshotHash: members[0]!.snapshotHash,
        citedRequirementText: text,
        mappingStatus: 'satisfied',
        kind: 'confirmed_observation',
      })),
    };
    expect(validateMappingLedger(ledger, members).ok).toBe(false);
  });

  it('returns lookup_unavailable when bound spec files cannot be reread', () => {
    const outcome = tryRecomputeCurrentSpecHashes(
      {} as never,
      [{ issueNumber: 362, snapshotHash: 'bound-hash' }],
      () => {
        throw new Error('gh issue view failed');
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe('lookup_unavailable');
    }
  });

  it('returns stale_spec when reread hash drifts from the bound snapshot', () => {
    const opts = {
      prBodyFile: null,
      issueFile: path.join(fixturesDir, 'issue-with-acceptance.md'),
      issuesFile: null,
      issueSpecs: [],
      diffFile: null,
      changedPathsFile: null,
      explicitIssue: 362,
      declarationIssue: null,
      prHeadSha: null,
      ledgerFile: null,
      invokeCoworker: false,
      json: true,
      lookupAvailable: true,
      coworkerAvailable: true,
    };
    const outcome = tryRecomputeCurrentSpecHashes(
      opts,
      [{ issueNumber: 362, snapshotHash: 'stale-bound-hash' }],
      createLocalIssueBodyResolver(opts),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe('stale_spec');
    }
    const fallback = buildSpecRereadFallbackOutput({
      status: 'stale_spec',
      prHeadSha: 'head-sha',
      contractSet: [memberFromIssue('issue-with-acceptance.md', 362)],
      diffContent: fixture('small.diff'),
      preflightStatusRecord: buildStructuredStatusRecord({
        status: 'mapped',
        prHeadSha: 'head-sha',
        members: [memberFromIssue('issue-with-acceptance.md', 362)],
      }),
    });
    expect(fallback.status).toBe('stale_spec');
    expect(fallback.statusRecord.usability).toBe('not_usable');
    expect(fallback.ledger).toBeUndefined();
  });

  it('normalizes line endings and trailing newlines before freshness hashing', () => {
    const body = fixture('issue-with-acceptance.md');
    const resolved = resolveContractSet([362], [{ issueNumber: 362, body: `${body}\n` }]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    const bound = resolved.members[0]!;
    const withoutCliNewline = tryRecomputeCurrentSpecHashes(
      {} as never,
      [{ issueNumber: bound.issueNumber, snapshotHash: bound.snapshotHash }],
      () => body,
    );
    expect(withoutCliNewline.ok).toBe(true);
    const withCrlf = tryRecomputeCurrentSpecHashes(
      {} as never,
      [{ issueNumber: bound.issueNumber, snapshotHash: bound.snapshotHash }],
      () => body.replace(/\n/g, '\r\n'),
    );
    expect(withCrlf.ok).toBe(true);
  });

  it('re-fetches bound specs through the GitHub resolver by default', () => {
    const calls: number[] = [];
    const body = fixture('issue-with-acceptance.md');
    const outcome = tryRecomputeCurrentSpecHashes(
      {} as never,
      [{ issueNumber: 362, snapshotHash: hashIssueBodySnapshot(body) }],
      (issueNumber) => {
        calls.push(issueNumber);
        return body;
      },
    );
    expect(calls).toEqual([362]);
    expect(outcome.ok).toBe(true);
    expect(createGitHubIssueBodyResolver).toBeTypeOf('function');
  });

  it('accepts child artifact paths inside controlled dirs on Windows separators', () => {
    expect(
      isResolvedPathInsideDir('C:\\tmp\\artifact', 'C:\\tmp\\artifact\\scrubbed.diff', win32),
    ).toBe(true);
    expect(
      isResolvedPathInsideDir('C:\\tmp\\artifact', 'C:\\tmp\\other\\scrubbed.diff', win32),
    ).toBe(false);
  });


  it('ignores literal binary marker strings inside diff hunks', () => {
    const diff = [
      'diff --git a/scripts/reviewer-contract-mapping.ts b/scripts/reviewer-contract-mapping.ts',
      '--- a/scripts/reviewer-contract-mapping.ts',
      '+++ b/scripts/reviewer-contract-mapping.ts',
      '@@ -1,3 +1,4 @@',
      "+if (chunk.includes('GIT binary patch')) {",
      '+  return false;',
      '+}',
      "+// Binary files a/foo and b/foo differ",
    ].join('\n');
    expect(hasCompleteChangedFileEvidence(diff, 'scripts/reviewer-contract-mapping.ts')).toBe(true);
    expect(hasCompleteChangedFileEvidence(diff, 'scripts/reviewer-contract-mapping.test.ts')).toBe(false);
  });

  it('re-fetches authoritative spec from GitHub for freshness even with local issue files', () => {
    const issuePath = path.join(fixturesDir, 'issue-with-acceptance.md');
    const opts = {
      prBodyFile: null,
      issueFile: issuePath,
      issuesFile: null,
      issueSpecs: [],
      diffFile: null,
      changedPathsFile: null,
      explicitIssue: 362,
      declarationIssue: null,
      prHeadSha: null,
      ledgerFile: null,
      invokeCoworker: false,
      json: true,
      lookupAvailable: true,
      coworkerAvailable: true,
      preflightOnly: false,
    };
    const fileHash = hashIssueBodySnapshot(fixture('issue-with-acceptance.md'));
    const localOutcome = tryRecomputeCurrentSpecHashes(
      opts,
      [{ issueNumber: 362, snapshotHash: fileHash }],
      createLocalIssueBodyResolver(opts),
    );
    expect(localOutcome.ok).toBe(true);
    const members = [{ issueNumber: 362, snapshotHash: 'stale-bound-hash' }];
    const githubCalls: number[] = [];
    const githubOutcome = tryRecomputeCurrentSpecHashes(opts, members, (issueNumber) => {
      githubCalls.push(issueNumber);
      return fixture('issue-with-acceptance.md');
    });
    expect(githubCalls).toEqual([362]);
    expect(githubOutcome.ok).toBe(false);
    if (!githubOutcome.ok) {
      expect(githubOutcome.status).toBe('stale_spec');
    }
    expect(createSpecFreshnessResolver(opts)).toBeTypeOf('function');
  });

  it('redacts encrypted PKCS#8 private key blocks', () => {
    const pem = [
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      'MIIEfakeencryptedmaterial',
      '-----END ENCRYPTED PRIVATE KEY-----',
    ].join('\n');
    const scrubbed = scrubForProviderInput(pem, { allowSafeSecretRedaction: true });
    expect(scrubbed.ok).toBe(true);
    if (!scrubbed.ok) {
      return;
    }
    expect(scrubbed.scrubbed).not.toContain('MIIEfakeencryptedmaterial');
    expect(scrubbed.scrubbed).toContain('[REDACTED_SECRET]');
  });

  it('fails closed on unrecognized private-key PEM headers', () => {
    const pem = '-----BEGIN CUSTOM PRIVATE KEY-----\nsecret\n-----END CUSTOM PRIVATE KEY-----';
    expect(scrubForProviderInput(pem, { allowSafeSecretRedaction: true }).ok).toBe(false);
  });

  it('treats opaque GIT binary patches as incomplete evidence', () => {
    const binaryPatch = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 111..222 100644',
      '--- a/assets/logo.png',
      '+++ b/assets/logo.png',
      'GIT binary patch',
      'literal 120',
      'zcmVhbCBiaW5hcnkgZGF0YQ==',
    ].join('\n');
    expect(hasCompleteChangedFileEvidence(binaryPatch, 'assets/logo.png')).toBe(false);
    const diff = `${binaryPatch}\n${fixture('large.diff')}`;
    const issue = loadIssue('issue-with-acceptance.md', 362);
    const result = evaluateMappingPreflight({
      diffLineCount: diff.split(/\r?\n/).length,
      diffContent: diff,
      changedPaths: ['assets/logo.png', 'scripts/example.ts'],
      binding: { explicitIssueNumber: 362 },
      specBodies: [issue],
    });
    expect(result.status).toBe('incomplete_evidence');
  });

});
