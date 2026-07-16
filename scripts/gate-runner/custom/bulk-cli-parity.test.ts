import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { runProcessSync, type ProcessResult } from '#opk-kernel/subprocess';
import { afterAll, describe, expect, it } from 'vitest';
import { bulkDeclarativeGateDefinitions } from '../bulk-declarative-gates.ts';
import { evaluateDeclarativeGate } from '../declarative.ts';
import { loadCensus } from '../census.ts';
import { aggregateLane, type GateResult, type GateStatus } from '../contracts.ts';
import { formatGateRunnerReport, runGateRunner } from '../runner.ts';
import { captureSourceSnapshot, memorySnapshot, type SourceSnapshot } from '../source-snapshot.ts';
import {
  evaluateAgentsReportContract,
  evaluateCoworkerDelegationThreshold,
  evaluateReview010Vocabulary,
  evaluateReviewCommandNotAo,
  evaluateVerifyStructureContract,
} from './bulk-static-gates.ts';
import { evaluateNodeBackedGate, nodeBackedGateCommands } from './node-backed-gates.ts';

interface Capture {
  readonly gateId: string;
  readonly legacyScript: string;
  readonly legacyReplayScript?: string;
  readonly sourceBlobSha: string;
  readonly case: string;
  readonly captureMode: 'real-clean-tree' | 'fixture-replay';
  readonly scenario?: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
  readonly expectedRunnerStatus?: GateStatus;
  readonly expectedRunnerStdout?: string;
  readonly expectedRunnerDiagnostics?: readonly string[];
  readonly stdoutNormalization?: 'launch-argv-counts';
  readonly parityDisposition?: string;
  readonly artifacts: readonly string[];
}

interface FrozenVerifySpan {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly sha256: string;
}

interface FrozenVerifyProvenance {
  readonly version: number;
  readonly sourcePath: string;
  readonly sourceBlobSha: string;
  readonly spans: readonly FrozenVerifySpan[];
}

interface CaptureManifest {
  readonly version: number;
  readonly issue: number;
  readonly baseCommitSha: string;
  readonly captures: readonly Capture[];
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const frozenFixtureRoot = resolve(import.meta.dirname, '../../fixtures/gate-runner/legacy-wave-3b');
const wave3b = JSON.parse(readFileSync(resolve(import.meta.dirname, '../goldens/wave-3b-pre-delete-captures.json'), 'utf8')) as CaptureManifest;
const frozenVerifySource = readFileSync(resolve(frozenFixtureRoot, 'verify-frozen.ps1'), 'utf8');
const verifyProvenance = JSON.parse(readFileSync(resolve(frozenFixtureRoot, 'verify-source-spans.json'), 'utf8')) as FrozenVerifyProvenance;
const liveSnapshot = captureSourceSnapshot(repoRoot);
const tempDirs: string[] = [];

function normalizeOutput(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function normalizeCaptureStdout(capture: Capture, text: string): string {
  const normalized = normalizeOutput(text);
  if (capture.stdoutNormalization !== 'launch-argv-counts') return normalized;
  return normalized.replace(
    /\[PASS\] generated launch-argv inventory audit \(\d+ production hits, \d+ rows\)/gu,
    '[PASS] generated launch-argv inventory audit (<production-hits> production hits, <rows> rows)',
  );
}

function gitBlobSha(text: string): string {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function capturesByScript(captures: readonly Capture[]): Map<string, Capture[]> {
  const result = new Map<string, Capture[]>();
  for (const capture of captures) {
    const values = result.get(capture.legacyScript) ?? [];
    values.push(capture);
    result.set(capture.legacyScript, values);
  }
  return result;
}

function isPorted(entry: ReturnType<typeof loadCensus>['entries'][number]): boolean {
  return entry.classification === 'ported-declarative' || entry.classification === 'ported-custom';
}

function wave3bParityCompletenessFailures(captures: readonly Capture[]): string[] {
  const census = loadCensus(repoRoot);
  const failures: string[] = [];
  const migrated = census.entries.filter((entry) => isPorted(entry) && entry.portedInWave === '3.b');
  const standalone = migrated.filter((entry) => entry.sourceKind === 'check-script');
  const byScript = capturesByScript(captures);
  for (const entry of standalone) {
    const evidence = byScript.get(entry.sourcePath) ?? [];
    if (!evidence.some((capture) => capture.exitCode === 0)) failures.push(`${entry.sourcePath}: missing successful legacy capture`);
    if (!evidence.some((capture) => capture.exitCode !== 0)) failures.push(`${entry.sourcePath}: missing failing legacy capture`);
    for (const gateId of entry.gateIds ?? []) {
      if (!evidence.some((capture) => capture.gateId === gateId)) failures.push(`${entry.sourcePath}: missing capture for ${gateId}`);
    }
  }

  const migratedVerifyMembers = migrated.filter((entry) => entry.sourceKind === 'verify-script-member');
  for (const member of migratedVerifyMembers) {
    const source = standalone.find((entry) => entry.sourcePath === member.marker);
    if (!source) failures.push(`${member.id}: missing Wave 3.b standalone migration owner`);
    for (const gateId of member.gateIds ?? []) {
      if (!source?.gateIds?.includes(gateId)) failures.push(`${member.id}: gate ${gateId} is not covered by its standalone migration`);
    }
  }

  const verifyRows = migrated.filter((entry) => entry.sourceKind === 'verify-inline');
  const verifyGateIds = new Set(verifyRows.flatMap((entry) => [...(entry.gateIds ?? [])]));
  for (const gateId of verifyGateIds) {
    const evidence = captures.filter((capture) => capture.legacyScript === 'scripts/verify.ps1' && capture.gateId === gateId);
    if (!evidence.some((capture) => capture.exitCode === 0)) failures.push(`scripts/verify.ps1:${gateId}: missing successful legacy capture`);
    if (!evidence.some((capture) => capture.exitCode !== 0)) failures.push(`scripts/verify.ps1:${gateId}: missing failing legacy capture`);
  }
  for (const row of verifyRows) {
    for (const gateId of row.gateIds ?? []) {
      if (!captures.some((capture) => capture.legacyScript === 'scripts/verify.ps1' && capture.gateId === gateId)) {
        failures.push(`${row.id}: missing verify behavior capture for ${gateId}`);
      }
    }
  }
  return failures;
}

function extractPowerShellFunction(text: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`^function ${escaped}\\s*\\{[\\s\\S]*?^\\}`, 'mu').exec(normalizeOutput(text));
  return match ? `${match[0].trim()}\n` : undefined;
}

function verifyReplayProvenanceFailures(replay: string, frozenSource = frozenVerifySource): string[] {
  const failures: string[] = [];
  if (verifyProvenance.version !== 1) failures.push('verify replay provenance version must be 1');
  if (verifyProvenance.sourcePath !== 'scripts/verify.ps1') failures.push('verify replay provenance source path drifted');
  if (verifyProvenance.sourceBlobSha !== '6e1c57e8a8114e0e74618bb6e8129463ca4ae881') failures.push('verify replay provenance source blob drifted');
  if (gitBlobSha(frozenSource) !== verifyProvenance.sourceBlobSha) failures.push('frozen verify.ps1 blob is not the recorded source');
  const sourceLines = normalizeOutput(frozenSource).split('\n');
  for (const span of verifyProvenance.spans) {
    if (span.startLine <= 0 || span.endLine < span.startLine || span.endLine > sourceLines.length) {
      failures.push(`${span.name}: invalid frozen source offsets`);
      continue;
    }
    const offsetSpan = `${sourceLines.slice(span.startLine - 1, span.endLine).join('\n').trim()}\n`;
    const frozen = extractPowerShellFunction(frozenSource, span.name);
    const replayed = extractPowerShellFunction(replay, span.name);
    if (!frozen) {
      failures.push(`${span.name}: frozen source span missing`);
      continue;
    }
    if (offsetSpan !== frozen) failures.push(`${span.name}: recorded offsets no longer select the frozen function`);
    if (sha256(offsetSpan) !== span.sha256) failures.push(`${span.name}: frozen source span hash drifted`);
    if (replayed !== offsetSpan) failures.push(`${span.name}: replay predicate drifted from frozen source span`);
  }
  return failures;
}

function overlaySnapshot(overrides: Readonly<Record<string, string>> = {}, removed: readonly string[] = []): SourceSnapshot {
  const files = Object.fromEntries(liveSnapshot.files);
  for (const path of removed) delete files[path];
  return memorySnapshot({ ...files, ...overrides });
}

function processResult(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    outcome: 'exit',
    ok: false,
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

function evaluateNegativeCapture(capture: Capture): GateResult {
  switch (capture.scenario) {
    case 'agents-removed-command':
      return evaluateAgentsReportContract(memorySnapshot({ 'AGENTS.md': 'pack-worker-report\nskip silently\nao report\n' }));
    case 'coworker-stale-600':
      return evaluateCoworkerDelegationThreshold(memorySnapshot({
        'AGENTS.md': 'more than 400 lines\n',
        'CLAUDE.md': 'more than 600 lines\n',
      }));
    case 'review-dead-argv':
      return evaluateReview010Vocabulary(memorySnapshot({ 'scripts/bad.mjs': 'const argv = ["review", "run"];\n' }));
    case 'review-command-ao-path':
      return evaluateReviewCommandNotAo(memorySnapshot({
        'agent-orchestrator.yaml.example': 'NAMED REVIEW_COMMAND\n  pwsh .ao/review.ps1\n  RUNTIME\n',
      }));
    case 'verify-missing-required-file': {
      const definition = bulkDeclarativeGateDefinitions.find((candidate) => candidate.gateId === capture.gateId)!;
      return evaluateDeclarativeGate(definition, overlaySnapshot({}, ['AGENTS.md']));
    }
    case 'verify-missing-contract-marker': {
      const path = 'plugins/ao-scope-guard/README.md';
      const original = liveSnapshot.files.get(path) ?? '';
      return evaluateVerifyStructureContract(overlaySnapshot({ [path]: original.replaceAll(/runtime guard/giu, 'runtime_guard_removed') }));
    }
    case 'external-shape-violation': {
      const command = nodeBackedGateCommands.find((candidate) => candidate.gateId === capture.gateId)!;
      return evaluateNodeBackedGate(command, '<fixture>', () => processResult({ stderr: capture.stderr ?? '' }));
    }
    case 'launch-unmapped-site': {
      const command = nodeBackedGateCommands.find((candidate) => candidate.gateId === capture.gateId)!;
      return evaluateNodeBackedGate(command, '<fixture>', () => processResult({ stderr: capture.stderr ?? '' }));
    }
    default:
      throw new Error(`unknown negative parity scenario: ${capture.scenario ?? '<missing>'}`);
  }
}

function writeFixture(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function createReplayRoot(capture: Capture): { root: string; script: string; args: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'opk-wave3b-parity-'));
  tempDirs.push(root);
  const replaySource = capture.legacyReplayScript
    ? resolve(repoRoot, capture.legacyReplayScript)
    : resolve(frozenFixtureRoot, basename(capture.legacyScript));
  const script = capture.legacyReplayScript
    ? join(root, 'scripts', basename(capture.legacyReplayScript))
    : join(root, capture.legacyScript);
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(replaySource, script);

  switch (capture.scenario) {
    case 'agents-removed-command':
      writeFixture(join(root, 'AGENTS.md'), 'pack-worker-report\nskip silently\nao report\n');
      return { root, script, args: [] };
    case 'coworker-stale-600':
      writeFixture(join(root, 'AGENTS.md'), 'more than 400 lines\n');
      writeFixture(join(root, 'CLAUDE.md'), 'more than 600 lines\n');
      writeFixture(join(root, 'scripts/lib/Initialize-PackGateCheck.ps1'), [
        "function Initialize-PackGateCheck {",
        "  param([string]$RepoRoot, [string]$CallerScriptRoot)",
        "  return [pscustomobject]@{ RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path; Violations = [System.Collections.Generic.List[string]]::new() }",
        "}",
        "",
      ].join('\n'));
      return { root, script, args: ['-RepoRoot', root] };
    case 'external-shape-violation':
      writeFixture(join(root, 'scripts/external-output-shape-guard.mjs'), `process.stderr.write(${JSON.stringify(capture.stderr ?? '')});\nprocess.exitCode = 1;\n`);
      return { root, script, args: ['-RepoRoot', root] };
    case 'launch-unmapped-site':
      writeFixture(join(root, 'docs/generated-launch-argv-inventory.mjs'), `process.stderr.write(${JSON.stringify(capture.stderr ?? '')});\nprocess.exitCode = 1;\n`);
      return { root, script, args: ['-Root', root] };
    case 'review-dead-argv':
      writeFixture(join(root, 'scripts/bad.mjs'), 'const argv = ["review", "run"];\n');
      writeFixture(join(root, 'docs/.keep'), 'fixture\n');
      return { root, script, args: [] };
    case 'review-command-ao-path':
      writeFixture(join(root, 'agent-orchestrator.yaml.example'), 'NAMED REVIEW_COMMAND\n  pwsh .ao/review.ps1\n  RUNTIME\n');
      writeFixture(join(root, 'scripts/lib/Get-PackReviewCommand.ps1'), [
        "function Get-PackReviewCommandFromYaml {",
        "  param([Parameter(Mandatory)][string]$YamlPath)",
        "  if (-not (Test-Path -LiteralPath $YamlPath -PathType Leaf)) { return $null }",
        "  $text = Get-Content -LiteralPath $YamlPath -Raw",
        "  $match = [regex]::Match($text, '(?ms)NAMED\\s+REVIEW_COMMAND[^\\r\\n]*\\r?\\n\\s+(.+?)(?:\\r?\\n\\s+Alternate|\\r?\\n\\s+RUNTIME|\\r?\\n\\s+[A-Z]{2,})')",
        "  if (-not $match.Success) { return $null }",
        "  return (($match.Groups[1].Value.Trim() -split \"`r?`n\")[0]).Trim()",
        "}",
        "",
      ].join('\n'));
      return { root, script, args: [] };
    case 'verify-required-file-present':
      writeFixture(join(root, 'AGENTS.md'), 'fixture\n');
      return { root, script, args: ['-Scenario', 'required-file', '-RepoRoot', root] };
    case 'verify-contract-markers-present':
      writeFixture(join(root, 'plugins/ao-scope-guard/README.md'), 'DD-024 runtime guard git add commit PR-level CI second line\n');
      return { root, script, args: ['-Scenario', 'contract-marker', '-RepoRoot', root] };
    case 'verify-missing-required-file':
      return { root, script, args: ['-Scenario', 'required-file', '-RepoRoot', root] };
    case 'verify-missing-contract-marker':
      writeFixture(join(root, 'plugins/ao-scope-guard/README.md'), 'DD-024 git add commit PR-level CI second line\n');
      return { root, script, args: ['-Scenario', 'contract-marker', '-RepoRoot', root] };
    default:
      throw new Error(`unknown replay scenario: ${capture.scenario ?? '<missing>'}`);
  }
}

function pwshAvailable(): boolean {
  const probe = runProcessSync({
    command: 'pwsh',
    args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  return probe.outcome === 'exit' && probe.exitCode === 0;
}

function replayLegacyCapture(capture: Capture): { exitCode: number | null; stdout: string; stderr: string } {
  const fixture = createReplayRoot(capture);
  const result = runProcessSync({
    command: 'pwsh',
    args: ['-NoProfile', '-File', fixture.script, ...fixture.args],
    cwd: fixture.root,
    inheritParentEnv: true,
  });
  if (result.outcome !== 'exit') throw new Error(`legacy replay did not exit normally: ${result.outcome}`);
  return { exitCode: result.exitCode, stdout: normalizeOutput(result.stdout), stderr: normalizeOutput(result.stderr) };
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Wave 3.b per-entrypoint CLI parity', () => {
  it('derives the complete Wave 3.b parity population from census migration ownership', () => {
    expect(wave3b.version).toBe(2);
    expect(wave3b.issue).toBe(841);
    expect(wave3b.baseCommitSha).toBe('0e8846b1e7caf063d73792700968971d75e0524f');
    expect(wave3bParityCompletenessFailures(wave3b.captures)).toEqual([]);
  });

  it('fails completeness when one migrated script is removed from the evidence manifest', () => {
    const census = loadCensus(repoRoot);
    const sourcePath = census.entries.find((entry) => entry.portedInWave === '3.b' && entry.sourceKind === 'check-script')?.sourcePath;
    expect(sourcePath).toBeDefined();
    const mutated = wave3b.captures.filter((capture) => capture.legacyScript !== sourcePath);
    expect(wave3bParityCompletenessFailures(mutated).join('\n')).toContain(`${sourcePath}: missing successful legacy capture`);
  });

  it('binds standalone fixtures and verify replay predicates to frozen source evidence', () => {
    const exactCaptures = wave3b.captures.filter((capture) => capture.captureMode === 'fixture-replay' && !capture.legacyReplayScript);
    for (const capture of exactCaptures) {
      const source = readFileSync(resolve(frozenFixtureRoot, basename(capture.legacyScript)), 'utf8');
      expect(gitBlobSha(source), capture.legacyScript).toBe(capture.sourceBlobSha);
    }
    const verifyReplay = readFileSync(resolve(frozenFixtureRoot, 'verify-behavior-replay.ps1'), 'utf8');
    expect(verifyReplayProvenanceFailures(verifyReplay)).toEqual([]);
    for (const capture of wave3b.captures.filter((candidate) => candidate.legacyScript === 'scripts/verify.ps1')) {
      expect(capture.sourceBlobSha).toBe(verifyProvenance.sourceBlobSha);
    }
  });

  it('fails verify replay provenance when a predicate drifts but the SHA comment remains', () => {
    const verifyReplay = readFileSync(resolve(frozenFixtureRoot, 'verify-behavior-replay.ps1'), 'utf8');
    const mutated = verifyReplay.replace(
      'if (Test-Path -LiteralPath $path -PathType Leaf) {',
      'if ($true -or (Test-Path -LiteralPath $path -PathType Leaf)) {',
    );
    expect(mutated).toContain('6e1c57e8a8114e0e74618bb6e8129463ca4ae881');
    expect(verifyReplayProvenanceFailures(mutated).join('\n')).toContain('Test-RequiredFile: replay predicate drifted');
  });

  it('preserves positive exit class, gate stdout, and report semantics', () => {
    const captures = wave3b.captures.filter((capture) => capture.exitCode === 0);
    const report = runGateRunner(repoRoot, captures.map((capture) => capture.gateId));
    const formatted = formatGateRunnerReport(report);
    expect(report.aggregate.exitCode).toBe(0);
    for (const capture of captures) {
      expect(capture.argv.slice(0, 4)).toEqual(['pwsh', '-NoProfile', '-File', capture.legacyScript]);
      expect(capture.sourceBlobSha).toMatch(/^[0-9a-f]{40}$/u);
      expect(capture.artifacts).toEqual([]);
      const expectedStdout = capture.expectedRunnerStdout ?? capture.stdout;
      if (expectedStdout !== capture.stdout) expect(capture.parityDisposition?.length).toBeGreaterThan(20);
      const result = report.results.find((candidate) => candidate.gateId === capture.gateId);
      expect(result?.status, capture.gateId).toBe(capture.expectedRunnerStatus ?? 'PASS');
      expect(normalizeCaptureStdout(capture, result?.legacyStdout ?? ''), capture.gateId)
        .toBe(normalizeCaptureStdout(capture, expectedStdout));
      expect(normalizeCaptureStdout(capture, formatted), capture.gateId)
        .toContain(normalizeCaptureStdout(capture, expectedStdout).trimEnd());
    }
  });

  it.each(wave3b.captures.filter((capture) => capture.exitCode !== 0))(
    'preserves negative exit class and diagnostics for $legacyScript ($case)',
    (capture) => {
      const result = evaluateNegativeCapture(capture);
      const formatted = formatGateRunnerReport({ results: [result], aggregate: aggregateLane([result]) });
      expect(result.status).toBe(capture.expectedRunnerStatus ?? 'FAIL');
      expect(result.status).toBe(capture.exitCode === 0 ? 'PASS' : 'FAIL');
      expect(result.legacyStdout).toBe(capture.expectedRunnerStdout);
      for (const diagnostic of capture.expectedRunnerDiagnostics ?? []) {
        expect(result.details?.join('\n') ?? '').toContain(diagnostic);
        expect(formatted).toContain(diagnostic);
      }
      if (capture.expectedRunnerStdout) expect(formatted).toContain(capture.expectedRunnerStdout.trimEnd());
      expect(formatted).toContain(`[${result.status}] ${capture.gateId}:`);
      expect(formatted).toContain('exit=1');
    },
  );

  it('replays every frozen PowerShell fixture when pwsh is available and requires it in CI', () => {
    const available = pwshAvailable();
    if (process.env.GITHUB_ACTIONS === 'true') expect(available, 'pwsh is required for legacy parity replay in GitHub Actions').toBe(true);
    if (!available) return;
    for (const capture of wave3b.captures.filter((candidate) => candidate.captureMode === 'fixture-replay')) {
      const replayed = replayLegacyCapture(capture);
      expect(replayed.exitCode, `${capture.legacyScript} exit`).toBe(capture.exitCode);
      expect(replayed.stdout, `${capture.legacyScript} stdout`).toBe(capture.stdout);
      expect(replayed.stderr, `${capture.legacyScript} stderr`).toBe(capture.stderr ?? '');
    }
  });
});
