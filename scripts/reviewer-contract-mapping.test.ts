import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCoworkerInvokeArgv,
  buildSpecArtifactContent,
  buildStructuredStatusRecord,
  classifyChangedTestFiles,
  collectAuthoritativeReferences,
  coerceMappingLedger,
  CONTRACT_MAPPING_QUESTION,
  CONTRACT_SECTION_HEADINGS,
  evaluateFinalUsability,
  evaluateMappingPreflight,
  extractChangedFileContentFromDiff,
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

describe('reviewer contract-mapping (Issue #362)', () => {
  it('collects authoritative references and ignores weak mentions', () => {
    const refs = collectAuthoritativeReferences({
      explicitIssueNumber: 362,
      prBody: 'Closes #362\n\nSee also #999 in prose',
      declarationIssueNumber: 362,
    });
    expect(refs).toEqual([362]);
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
    expect(result.status).toBe('mapped');
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

  it('classifies test evidence and blocks missing-test claims when ambiguous', () => {
    const diff = fixture('large.diff');
    const classification = classifyChangedTestFiles(
      ['scripts/example.ts', 'scripts/weird-testy-module.ts'],
      diff,
    );
    expect(classification.ambiguousTestLike).toContain('scripts/weird-testy-module.ts');
    expect(hasCompleteTestFileCoverage(diff, ['scripts/example.ts'])).toBe(true);
    expect(hasCompleteTestFileCoverage(diff, ['scripts/missing.test.ts'])).toBe(false);
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
        expectedOwningSurface: 'scripts/reviewer-helper.ts',
        verifiedAbsenceFromDiff: true,
        concreteFailureScenario: 'Required wiring never appears in the PR diff.',
        kind: 'hypothesis',
      })),
    };
    expect(validateMappingLedger(ledger, members).ok).toBe(true);
  });

  it('scrubs secrets safely without decision-bearing loss', () => {
    const scrubbed = scrubForProviderInput('token=ghp_1234567890123456789012345678901234');
    expect(scrubbed.ok).toBe(true);
    if (scrubbed.ok) {
      expect(scrubbed.scrubbed).toContain('[REDACTED_SECRET]');
    }
  });

  it('redacts every secret occurrence in provider input', () => {
    const content = 'token=alpha-secret\nother token=beta-secret\n';
    const scrubbed = scrubForProviderInput(content);
    expect(scrubbed.ok).toBe(true);
    if (scrubbed.ok) {
      expect(scrubbed.scrubbed).not.toMatch(/token=\S+/);
      expect(scrubbed.scrubbed.match(/\[REDACTED_SECRET\]/g)?.length).toBe(2);
    }
  });

  it('writes scrubbed spec content to the artifact', () => {
    const members = [memberFromIssue('issue-with-acceptance.md', 362)];
    const rawSpec = `${buildSpecArtifactContent(members)}\ntoken=ghp_1234567890123456789012345678901234\n`;
    const specScrub = scrubForProviderInput(rawSpec);
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
        kind: 'confirmed_observation',
      })),
      exhaustive: true,
    });
    expect(fromEntries).not.toBeNull();
    expect(validateMappingLedger(fromEntries!, members).ok).toBe(true);

    const fromLegacyLedger = coerceMappingLedger({
      ledger: fromEntries!.entries,
    });
    expect(fromLegacyLedger?.exhaustive).toBe(true);
    expect(validateMappingLedger(fromLegacyLedger!, members).ok).toBe(true);
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

  it('exposes prompt contract markers for static checks', () => {
    const markers = loadPromptContractMarkers();
    expect(markers.requiredInAgentRules).toContain('candidate evidence');
    expect(markers.forbiddenInPrompts.join(' ')).toMatch(/assign severity/i);
  });
});
