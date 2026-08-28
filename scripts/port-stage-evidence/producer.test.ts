import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '#opk-kernel/subprocess';
import { generateCurrentHeadProjection, serializeCurrentHeadProjection } from '../gate-runner/census-generator.ts';
import {
  ARTIFACT_PATHS,
  ARTIFACT_ROLES,
  parseRetainedDispositions,
  SOURCE_KINDS,
  classifyInstructionOccurrence,
  producePortStageEvidence,
  unclassifiedPowerShellPathOccurrence,
  verifyEvidenceIntegrity,
  writePortStageEvidence,
} from './producer.ts';
import { createScriptTargetResolver } from './target-resolver.ts';
import { jsonStringValueRanges, scanPowerShellTokens, tsStringRanges, yamlScalarRanges } from './tokens.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const HISTORICAL_PRODUCER_REVISION = 'a172e02ddf0a57d4d43d10e16ba59f2b45539bbd';
const producerIntegrationTestTimeoutMs = 120_000;

function scan(source: string, ranges?: readonly { start: number; end: number }[]) {
  return scanPowerShellTokens({
    sourcePath: 'fixture.txt',
    bytes: Buffer.from(source, 'utf8'),
    ranges,
    resolvesWholePath: (candidate) => candidate.replaceAll('\\', '/') === 'scripts/path with spaces/check.ps1',
  });
}

function workflowTokens(source: string): readonly string[] {
  const bytes = Buffer.from(source, 'utf8');
  return scanPowerShellTokens({
    sourcePath: '.github/workflows/x.yml',
    bytes,
    ranges: yamlScalarRanges(bytes),
    resolvesWholePath: () => false,
  }).map((token) => token.matchedBytes);
}

async function exactCandidateHead(): Promise<string> {
  const resolved = await runProcess({
    command: 'git',
    args: ['rev-parse', '--verify', `${HISTORICAL_PRODUCER_REVISION}^{commit}`],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
  });
  if (!resolved.ok) throw new Error(`cannot resolve exact historical test candidate ${HISTORICAL_PRODUCER_REVISION}: ${resolved.stderr || resolved.error || resolved.outcome}`);
  const candidate = resolved.stdout.trim();
  if (candidate !== HISTORICAL_PRODUCER_REVISION) {
    throw new Error(`historical test candidate resolved to unexpected commit: ${candidate}`);
  }
  return candidate;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({ command: 'git', args, cwd, inheritParentEnv: true, allowEmptyStdout: true });
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error || result.outcome}`);
  return result.stdout.trim();
}

async function cloneCandidate(measuredHead: string): Promise<string> {
  const root = mkdtempSync(`${tmpdir()}/opk-1415-evidence-`);
  await git(repoRoot, ['clone', '--local', '--no-hardlinks', repoRoot, root]);
  await git(root, ['checkout', '--detach', measuredHead]);
  return root;
}

async function commitFixture(root: string, paths: readonly string[]): Promise<string> {
  await git(root, ['add', '--', ...paths]);
  await git(root, ['-c', 'user.name=Issue 1415 test', '-c', 'user.email=issue-1415@example.invalid', 'commit', '--no-gpg-sign', '-m', 'Issue 1415 fixture']);
  return git(root, ['rev-parse', 'HEAD']);
}

describe('Issue #1415 role-neutral port-stage evidence', () => {
  it('has exactly the three stable role mappings', () => {
    expect(ARTIFACT_ROLES).toEqual(['baseline', 'post-port', 'final']);
    expect(ARTIFACT_PATHS).toEqual({
      baseline: 'docs/investigations/orca-pwsh-zero-estate/baseline.json',
      'post-port': 'docs/investigations/orca-pwsh-zero-estate/post-port.json',
      final: 'docs/investigations/orca-pwsh-zero-estate/final.json',
    });
  });

  it('keeps exactly the seven contract source kinds', () => {
    expect(SOURCE_KINDS).toEqual([
      'tracked-ps1-file',
      'script-token-reference',
      'workflow-token-reference',
      'package-config-token-reference',
      'instruction-command',
      'instruction-directive',
      'instruction-reference-only',
    ]);
  });

  it('records exact LF/UTF-8 byte coordinates and preserves matched bytes', () => {
    const source = 'α run scripts/verify.ps1\r\npwsh -File scripts/check-reusable.ps1\n';
    const tokens = scan(source);
    expect(tokens.map(({ line, column, tokenKind, matchedBytes }) => ({ line, column, tokenKind, matchedBytes }))).toEqual([
      { line: 1, column: 8, tokenKind: 'script', matchedBytes: 'scripts/verify.ps1' },
      { line: 2, column: 1, tokenKind: 'runtime', matchedBytes: 'pwsh' },
      { line: 2, column: 12, tokenKind: 'script', matchedBytes: 'scripts/check-reusable.ps1' },
    ]);
  });

  it('handles whole-delimited paths, quoted commands and unmatched delimiters deterministically', () => {
    const tokens = scan('"scripts/path with spaces/check.ps1" "pwsh -File scripts/verify.ps1" `scripts/verify.ps1\n');
    expect(tokens.map((token) => [token.tokenKind, token.matchedBytes])).toEqual([
      ['script', 'scripts/path with spaces/check.ps1'],
      ['runtime', 'pwsh'],
      ['script', 'scripts/verify.ps1'],
      ['script', 'scripts/verify.ps1'],
    ]);
  });

  it('limits workflow scanning to scalar values across block, sequence, and flow forms', () => {
    const source = [
      'pwsh_key: harmless',
      'run: pwsh -File scripts/verify.ps1',
      'script: |',
      '  scripts/check-reusable.ps1',
      'matrix: [pwsh, scripts/verify.ps1]',
      'env: { pwsh_key: harmless, SHELL: powershell.exe, SCRIPT: scripts/check-reusable.ps1 }',
      'steps:',
      '  - scripts/verify.ps1',
      '',
    ].join('\n');
    expect(workflowTokens(source)).toEqual([
      'pwsh',
      'scripts/verify.ps1',
      'scripts/check-reusable.ps1',
      'pwsh',
      'scripts/verify.ps1',
      'powershell.exe',
      'scripts/check-reusable.ps1',
      'scripts/verify.ps1',
    ]);
  });

  it('scans a PowerShell token that exists only on a plain scalar continuation line', () => {
    const source = [
      'steps:',
      '  - run: echo start',
      '      && pwsh -File scripts/verify.ps1',
      '',
    ].join('\n');
    expect(workflowTokens(source)).toEqual(['pwsh', 'scripts/verify.ps1']);
  });

  it('keeps escaped YAML quotes and embedded comment/colon bytes inside the scalar range', () => {
    const slash = String.fromCharCode(0x5c);
    const source = `run: "echo ${slash}"#:${slash}"; pwsh -File scripts/verify.ps1"\n`;
    expect(workflowTokens(source)).toEqual(['pwsh', 'scripts/verify.ps1']);
  });

  it('does not treat a non-separated hash in a plain scalar as a YAML comment', () => {
    expect(workflowTokens('run: echo#tag pwsh -File scripts/verify.ps1\n')).toEqual(['pwsh', 'scripts/verify.ps1']);
  });

  it('binds directive negation to the qualifying action or modal/action span', () => {
    const positive = 'Do not use the old wrapper; you must run scripts/verify.ps1 for the current check.';
    expect(classifyInstructionOccurrence(positive, positive.indexOf('scripts/verify.ps1') + 1)).toBe('instruction-directive');
    const positiveActionClause = 'Do not use the old wrapper; run scripts/verify.ps1 for the current check.';
    expect(classifyInstructionOccurrence(positiveActionClause, positiveActionClause.indexOf('scripts/verify.ps1') + 1)).toBe('instruction-directive');
    const negative = 'You must not run scripts/verify.ps1 for the current check.';
    expect(classifyInstructionOccurrence(negative, negative.indexOf('scripts/verify.ps1') + 1)).toBe('instruction-reference-only');
  });

  it('does not treat dots inside an earlier script path as sentence boundaries', () => {
    const line = 'Run scripts/helper.ps1 then scripts/verify.ps1 for the current check.';
    expect(classifyInstructionOccurrence(line, line.indexOf('scripts/verify.ps1') + 1)).toBe('instruction-directive');
  });

  it('emits an outside-root tracked PowerShell path even when the file has no token bytes', () => {
    expect(unclassifiedPowerShellPathOccurrence('examples/legacy.PS1')).toEqual({
      sourcePath: 'examples/legacy.PS1',
      line: 1,
      column: 1,
      tokenKind: 'tracked-ps1-file',
      matchedBytes: 'examples/legacy.PS1',
    });
    expect(unclassifiedPowerShellPathOccurrence('examples/readme.md')).toBeUndefined();
  });

  it('accepts a valid retained row and rejects invalid retained-row mutations', () => {
    const valid = JSON.stringify({
      version: 1,
      owningIssue: 1415,
      dispositions: [{
        path: 'scripts/dormant.ps1',
        disposition: 'retained-for-1251-zero-estate',
        reason: 'dormant survivor is owned by the final zero-estate child',
        owningReference: '#1251',
      }],
    });
    expect(parseRetainedDispositions(valid)).toEqual([{
      path: 'scripts/dormant.ps1',
      disposition: 'retained-for-1251-zero-estate',
      reason: 'dormant survivor is owned by the final zero-estate child',
      owningReference: '#1251',
    }]);

    const mutations = [
      { name: 'wrong owner', mutate: (row: Record<string, unknown>) => { row.owningReference = '#1415'; } },
      { name: 'non-PowerShell target', mutate: (row: Record<string, unknown>) => { row.path = 'scripts/dormant.ts'; } },
      { name: 'empty reason', mutate: (row: Record<string, unknown>) => { row.reason = ' '; } },
      { name: 'wrong disposition', mutate: (row: Record<string, unknown>) => { row.disposition = 'current-prescriptive'; } },
    ];
    for (const mutation of mutations) {
      const row = {
        path: 'scripts/dormant.ps1',
        disposition: 'retained-for-1251-zero-estate',
        reason: 'dormant survivor',
        owningReference: '#1251',
      } as Record<string, unknown>;
      mutation.mutate(row);
      expect(() => parseRetainedDispositions(JSON.stringify({ version: 1, owningIssue: 1415, dispositions: [row] })), mutation.name).toThrow(/invalid retained disposition/u);
    }
  });

  it('scans JSON/TypeScript string values but not JSON keys or TS comments', () => {
    const json = Buffer.from('{"pwsh":"scripts/verify.ps1","other":"pwsh"}', 'utf8');
    expect(scanPowerShellTokens({ sourcePath: 'package.json', bytes: json, ranges: jsonStringValueRanges(json), resolvesWholePath: () => false }).map((token) => token.matchedBytes)).toEqual(['scripts/verify.ps1', 'pwsh']);
    const ts = Buffer.from('// pwsh\nexport default { value: "scripts/verify.ps1", shell: `pwsh` };', 'utf8');
    expect(scanPowerShellTokens({ sourcePath: 'tool.config.ts', bytes: ts, ranges: tsStringRanges(ts), resolvesWholePath: () => false }).map((token) => token.matchedBytes)).toEqual(['scripts/verify.ps1', 'pwsh']);
  });

  it('resolves only exact repo/source-relative or PSScriptRoot targets without suffix guessing', () => {
    const resolver = createScriptTargetResolver([
      'scripts/tools/check.ps1',
      'scripts/other/check.ps1',
      'scripts/work/run.ps1',
    ]);
    expect(resolver.resolve('scripts/work/caller.ts', '../tools/check.ps1')).toBe('scripts/tools/check.ps1');
    expect(resolver.resolve('scripts/work/caller.ts', '$PSScriptRoot/run.ps1')).toBe('scripts/work/run.ps1');
    expect(resolver.resolve('scripts/work/caller.ts', 'scripts/tools/check.ps1')).toBe('scripts/tools/check.ps1');
    expect(resolver.resolve('scripts/work/caller.ts', 'check.ps1')).toBeUndefined();
    expect(resolver.resolve('scripts/work/caller.ts', '../../../scripts/tools/check.ps1')).toBeUndefined();
  });

  it('replays staged, deleted, renamed, and retained-metadata mutations fail-closed', async () => {
    const measuredHead = await exactCandidateHead();
    const cases: readonly { name: string; mutate: (root: string) => Promise<void> }[] = [
      {
        name: 'staged tracked input bytes',
        mutate: async (root) => {
          appendFileSync(resolve(root, 'scripts/verify.ts'), '\n// staged mutation replay\n');
          await git(root, ['add', '--', 'scripts/verify.ts']);
        },
      },
      {
        name: 'staged tracked input deletion',
        mutate: async (root) => {
          rmSync(resolve(root, 'scripts/verify.ts'));
          await git(root, ['add', '-u', '--', 'scripts/verify.ts']);
        },
      },
      {
        name: 'staged tracked input rename',
        mutate: async (root) => {
          await git(root, ['mv', 'scripts/verify.ts', 'scripts/verify-renamed.ts']);
        },
      },
      {
        name: 'staged retained metadata bytes',
        mutate: async (root) => {
          appendFileSync(resolve(root, 'docs/investigations/orca-pwsh-zero-estate/retained-dispositions.json'), '\n');
          await git(root, ['add', '-f', '--', 'docs/investigations/orca-pwsh-zero-estate/retained-dispositions.json']);
        },
      },
    ];

    for (const mutation of cases) {
      const root = await cloneCandidate(measuredHead);
      try {
        await mutation.mutate(root);
        await expect(producePortStageEvidence({
          repoRoot: root,
          artifactRole: 'baseline',
          measuredHead,
          producerRevision: measuredHead,
        }), mutation.name).rejects.toThrow(/measured tracked input/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, producerIntegrationTestTimeoutMs);

  it('proves an end-to-end oracle for all seven source kinds', async () => {
    const measuredBase = await exactCandidateHead();
    const root = await cloneCandidate(measuredBase);
    try {
      mkdirSync(resolve(root, '.github/workflows'), { recursive: true });
      mkdirSync(resolve(root, 'docs'), { recursive: true });
      writeFileSync(resolve(root, 'scripts/fixture-source-kind.ps1'), 'Write-Output fixture\n');
      writeFileSync(resolve(root, 'scripts/fixture-source-kind.ts'), 'const command = "pwsh -File scripts/fixture-source-kind.ps1";\n');
      writeFileSync(resolve(root, '.github/workflows/fixture-source-kind.yml'), 'jobs:\n  check:\n    steps:\n      - run: pwsh -File scripts/fixture-source-kind.ps1\n');
      writeFileSync(resolve(root, 'source-kind.config.json'), JSON.stringify({ command: 'pwsh -File scripts/fixture-source-kind.ps1' }));
      appendFileSync(resolve(root, 'README.md'), '\npwsh -File scripts/fixture-source-kind.ps1\n');
      appendFileSync(resolve(root, 'AGENTS.md'), '\nRun scripts/fixture-source-kind.ps1 for the fixture check.\n');
      writeFileSync(resolve(root, 'docs/fixture-source-kind.md'), 'See scripts/fixture-source-kind.ps1 for context.\n');
      const measuredHead = await commitFixture(root, [
        'scripts/fixture-source-kind.ps1',
        'scripts/fixture-source-kind.ts',
        '.github/workflows/fixture-source-kind.yml',
        'source-kind.config.json',
        'README.md',
        'AGENTS.md',
        'docs/fixture-source-kind.md',
      ]);
      const evidence = await producePortStageEvidence({
        repoRoot: root,
        artifactRole: 'baseline',
        measuredHead,
        producerRevision: measuredHead,
      });
      expect(new Set(evidence.entries.map((entry) => entry.sourceKind))).toEqual(new Set(SOURCE_KINDS));
      const fixtureEntries = evidence.entries.filter((entry) => (
        entry.occurrence.matchedBytes === 'scripts/fixture-source-kind.ps1'
        || entry.occurrence.sourcePath === 'scripts/fixture-source-kind.ps1'
      ));
      expect(fixtureEntries).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceKind: 'tracked-ps1-file', resolvedScriptPath: 'scripts/fixture-source-kind.ps1', targetResolution: 'exact' }),
        expect.objectContaining({ sourceKind: 'script-token-reference', targetResolution: 'exact' }),
        expect.objectContaining({ sourceKind: 'workflow-token-reference', targetResolution: 'exact' }),
        expect.objectContaining({ sourceKind: 'package-config-token-reference', targetResolution: 'exact' }),
        expect.objectContaining({ sourceKind: 'instruction-command', targetResolution: 'exact' }),
        expect.objectContaining({ sourceKind: 'instruction-directive', targetResolution: 'exact' }),
        expect.objectContaining({ sourceKind: 'instruction-reference-only', targetResolution: 'exact' }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, producerIntegrationTestTimeoutMs);

  it('produces canonical current-head census and emits an untracked baseline for the exact PR-head candidate', async () => {
    const measuredHead = await exactCandidateHead();
    const projection = await generateCurrentHeadProjection(repoRoot, measuredHead);
    const canonical = serializeCurrentHeadProjection(projection);
    const cli = await runProcess({
      command: 'node',
      args: ['--experimental-strip-types', 'scripts/gate-runner/census-generator.ts', '--current-head', measuredHead],
      cwd: repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
    });
    expect(cli.ok, cli.stderr || cli.error || cli.outcome).toBe(true);
    expect(cli.stderr).toBe('');
    expect(cli.stdout).toBe(canonical.bytes);
    expect(cli.stdout.endsWith('\n')).toBe(true);
    expect(cli.stdout.endsWith('\n\n')).toBe(false);

    const cleanRoot = await cloneCandidate(measuredHead);
    try {
      const evidence = await producePortStageEvidence({ repoRoot: cleanRoot, artifactRole: 'baseline', measuredHead, producerRevision: measuredHead });
      expect(evidence.measuredHead).toBe(measuredHead);
      expect(evidence.producerRevision).toBe(measuredHead);
      expect(evidence.gateCensus.populationCount).toBeGreaterThan(0);
      expect(evidence.gateCensus.populationDigest).toBe(projection.populationDigest);
      expect(evidence.gateCensus.outputDigest).toBe(canonical.outputDigest);
      expect(() => verifyEvidenceIntegrity(evidence)).not.toThrow();
      for (const entry of evidence.entries) expect(SOURCE_KINDS).toContain(entry.sourceKind);

      const outputPath = await writePortStageEvidence(cleanRoot, evidence);
      expect(outputPath).toBe(ARTIFACT_PATHS.baseline);
      const written = JSON.parse(readFileSync(resolve(cleanRoot, outputPath), 'utf8'));
      expect(written.integrityDigest).toBe(evidence.integrityDigest);
      const tracked = await runProcess({ command: 'git', args: ['ls-files', '--error-unmatch', outputPath], cwd: cleanRoot, inheritParentEnv: true, allowEmptyStdout: true });
      expect(tracked.ok).toBe(false);
      rmSync(resolve(cleanRoot, outputPath), { force: true });
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  }, producerIntegrationTestTimeoutMs);
});
