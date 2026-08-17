import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '#opk-kernel/subprocess';
import { generateCurrentHeadProjection, serializeCurrentHeadProjection } from '../gate-runner/census-generator.ts';
import {
  ARTIFACT_PATHS,
  ARTIFACT_ROLES,
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
  const parents = await runProcess({ command: 'git', args: ['rev-list', '--parents', '-n', '1', 'HEAD'], cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: false });
  if (!parents.ok) throw new Error(`cannot read test candidate parents: ${parents.stderr || parents.error || parents.outcome}`);
  const parts = parents.stdout.trim().split(/\s+/u);
  const candidate = parts.length >= 3 ? parts[2] : parts[0];
  if (!candidate || !/^[0-9a-f]{40}$/u.test(candidate)) throw new Error(`cannot derive exact test candidate SHA: ${parents.stdout.trim()}`);
  return candidate;
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

    const evidence = await producePortStageEvidence({ repoRoot, artifactRole: 'baseline', measuredHead, producerRevision: measuredHead });
    expect(evidence.measuredHead).toBe(measuredHead);
    expect(evidence.producerRevision).toBe(measuredHead);
    expect(evidence.gateCensus.populationCount).toBeGreaterThan(0);
    expect(evidence.gateCensus.populationDigest).toBe(projection.populationDigest);
    expect(evidence.gateCensus.outputDigest).toBe(canonical.outputDigest);
    expect(() => verifyEvidenceIntegrity(evidence)).not.toThrow();
    for (const entry of evidence.entries) expect(SOURCE_KINDS).toContain(entry.sourceKind);

    const outputPath = await writePortStageEvidence(repoRoot, evidence);
    try {
      expect(outputPath).toBe(ARTIFACT_PATHS.baseline);
      const written = JSON.parse(readFileSync(resolve(repoRoot, outputPath), 'utf8'));
      expect(written.integrityDigest).toBe(evidence.integrityDigest);
      const tracked = await runProcess({ command: 'git', args: ['ls-files', '--error-unmatch', outputPath], cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: true });
      expect(tracked.ok).toBe(false);
    } finally {
      rmSync(resolve(repoRoot, outputPath), { force: true });
    }
  });
});
