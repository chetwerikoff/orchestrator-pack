// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bulkDeclarativeGateDefinitions, VERIFY_REQUIRED_FILES, VERIFY_RETIRED_FILES } from '../bulk-declarative-gates.ts';
import { evaluateDeclarativeGate } from '../declarative.ts';
import { loadCensus } from '../census.ts';
import { aggregateLane, type GateResult, type GateStatus } from '../contracts.ts';
import { formatGateRunnerReport, registeredGateIds, runGateRunner } from '../runner.ts';
import { captureSourceSnapshot, memorySnapshot, type SourceSnapshot } from '../source-snapshot.ts';
import {
  evaluateAgentsReportContract,
  evaluateReview010Vocabulary,
  evaluateReviewCommandNotAo,
  evaluateVerifyStructureContract,
  VERIFY_CONTRACT_MARKERS,
  VERIFY_PROMPT_GLOB,
} from './bulk-static-gates.ts';
import { evaluateNodeBackedGate, nodeBackedGateCommands } from './node-backed-gates.ts';
import {
  WAVE_3B_MIGRATION_INVENTORY_PATH,
  parseWave3bMigrationInventory,
  validateWave3bMigrationInventory,
  type Wave3bReplacementSurface,
} from '../wave-3b-migration-inventory.ts';

interface Capture {
  readonly gateId: string;
  readonly legacyScript: string;
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
interface CaptureManifest {
  readonly version: number;
  readonly issue: number;
  readonly baseCommitSha: string;
  readonly captures: readonly Capture[];
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const wave3b = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../goldens/wave-3b-pre-delete-captures.json'), 'utf8'),
) as CaptureManifest;
const wave3bInventory = parseWave3bMigrationInventory(
  readFileSync(resolve(repoRoot, WAVE_3B_MIGRATION_INVENTORY_PATH), 'utf8'),
);
const liveSnapshot = captureSourceSnapshot(repoRoot);
const RETIRED_LIVE_GATE_IDS = new Set(['coworker-delegation-threshold-drift']);

function liveParityCaptures(captures: readonly Capture[] = wave3b.captures): Capture[] {
  return captures.filter((capture) => !RETIRED_LIVE_GATE_IDS.has(capture.gateId));
}
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
function capturesByScript(captures: readonly Capture[]): Map<string, Capture[]> {
  const result = new Map<string, Capture[]>();
  for (const capture of captures) {
    const values = result.get(capture.legacyScript) ?? [];
    values.push(capture);
    result.set(capture.legacyScript, values);
  }
  return result;
}
function replacementSurface(overrides: Partial<Wave3bReplacementSurface> = {}): Wave3bReplacementSurface {
  return {
    requiredFiles: VERIFY_REQUIRED_FILES,
    absentFiles: VERIFY_RETIRED_FILES,
    contractMarkers: VERIFY_CONTRACT_MARKERS,
    promptGlob: VERIFY_PROMPT_GLOB,
    ...overrides,
  };
}
function parityCompletenessFailures(
  captures: readonly Capture[],
  surface: Wave3bReplacementSurface = replacementSurface(),
): string[] {
  const failures = validateWave3bMigrationInventory(
    wave3bInventory,
    loadCensus(repoRoot).entries,
    registeredGateIds,
    surface,
  );
  const byScript = capturesByScript(captures);
  for (const entry of wave3bInventory.entries.filter((candidate) => candidate.sourceKind === 'check-script')) {
    const evidence = byScript.get(entry.sourcePath) ?? [];
    if (!evidence.some((capture) => capture.exitCode === 0)) failures.push(`${entry.sourcePath}: missing successful legacy capture`);
    if (!evidence.some((capture) => capture.exitCode !== 0)) failures.push(`${entry.sourcePath}: missing failing legacy capture`);
    for (const gateId of entry.gateIds) {
      if (!evidence.some((capture) => capture.gateId === gateId)) failures.push(`${entry.sourcePath}: missing capture for ${gateId}`);
    }
  }
  const members = wave3bInventory.entries.filter((entry) => entry.sourceKind === 'verify-script-member');
  for (const member of members) {
    const ownerId = member.replacement.kind === 'standalone-owner' ? member.replacement.ownerId : '';
    const source = wave3bInventory.entries.find((entry) => entry.id === ownerId);
    if (!source) failures.push(`${member.id}: missing Wave 3.b standalone migration owner`);
    for (const gateId of member.gateIds) {
      if (!source?.gateIds.includes(gateId)) failures.push(`${member.id}: gate ${gateId} is not covered by its standalone migration`);
    }
  }
  const verifyRows = wave3bInventory.entries.filter((entry) => entry.sourceKind === 'verify-inline');
  for (const gateId of new Set(verifyRows.flatMap((entry) => [...entry.gateIds]))) {
    const evidence = captures.filter((capture) => capture.legacyScript === 'scripts/verify.ps1' && capture.gateId === gateId);
    if (!evidence.some((capture) => capture.exitCode === 0)) failures.push(`scripts/verify.ps1:${gateId}: missing successful legacy capture`);
    if (!evidence.some((capture) => capture.exitCode !== 0)) failures.push(`scripts/verify.ps1:${gateId}: missing failing legacy capture`);
  }
  return failures;
}
function overlaySnapshot(overrides: Readonly<Record<string, string>> = {}, removed: readonly string[] = []): SourceSnapshot {
  const current = Object.fromEntries(liveSnapshot.files);
  for (const path of removed) delete current[path];
  return memorySnapshot({ ...current, ...overrides });
}
function evaluateNegativeCapture(capture: Capture): GateResult {
  switch (capture.scenario) {
    case 'agents-removed-command':
      return evaluateAgentsReportContract(memorySnapshot({ 'AGENTS.md': 'pack-worker-report\nskip silently\na\u006f report\n' }));
    case 'review-dead-argv':
      return evaluateReview010Vocabulary(memorySnapshot({ 'scripts/bad.mjs': 'const argv = ["review", "run"];\n' }));
    case 'review-command-ao-path':
      return evaluateReviewCommandNotAo(memorySnapshot({
        'agent-\u006frchestrator.yaml.example': 'NAMED REVIEW_COMMAND\n  pwsh .orchestrator-pack/review.ps1\n  RUNTIME\n',
      }));
    case 'verify-missing-required-file': {
      const definition = bulkDeclarativeGateDefinitions.find((candidate) => candidate.gateId === capture.gateId)!;
      return evaluateDeclarativeGate(definition, overlaySnapshot({}, ['AGENTS.md']));
    }
    case 'verify-missing-contract-marker': {
      const path = 'plugins/scope-guard/README.md';
      const original = liveSnapshot.files.get(path) ?? '';
      return evaluateVerifyStructureContract(overlaySnapshot({ [path]: original.replaceAll(/runtime guard/giu, 'runtime_guard_removed') }));
    }
    case 'external-shape-violation':
    case 'launch-unmapped-site': {
      const command = nodeBackedGateCommands.find((candidate) => candidate.gateId === capture.gateId)!;
      return evaluateNodeBackedGate(command, '<fixture>', () => ({
        outcome: 'exit', ok: false, exitCode: 1, signal: null, stdout: '', stderr: capture.stderr ?? '',
        timedOut: false, cancelled: false,
      }));
    }
    default:
      throw new Error(`unknown negative parity scenario: ${capture.scenario ?? '<missing>'}`);
  }
}

describe('Wave 3.b historical-to-Node parity', () => {
  it('keeps the complete historical capture population bound to current migration ownership', () => {
    expect(wave3b.version).toBe(2);
    expect(wave3b.issue).toBe(841);
    expect(wave3b.baseCommitSha).toBe('0e8846b1e7caf063d73792700968971d75e0524f');
    expect(parityCompletenessFailures(wave3b.captures)).toEqual([]);
  });

  it('fails completeness when one migrated script loses historical evidence', () => {
    const sourcePath = wave3bInventory.entries.find((entry) => entry.sourceKind === 'check-script')?.sourcePath;
    expect(sourcePath).toBeDefined();
    const mutated = wave3b.captures.filter((capture) => capture.legacyScript !== sourcePath);
    expect(parityCompletenessFailures(mutated).join('\n')).toContain(`${sourcePath}: missing successful legacy capture`);
  });

  it('fails completeness when a concrete required-file replacement disappears', () => {
    const row = wave3bInventory.entries.find((entry) => entry.replacement.kind === 'required-file-rule');
    expect(row).toBeDefined();
    if (row!.replacement.kind !== 'required-file-rule') throw new Error('expected required-file replacement');
    const replacement = row!.replacement;
    const failures = parityCompletenessFailures(
      wave3b.captures,
      replacementSurface({ requiredFiles: VERIFY_REQUIRED_FILES.filter((path) => path !== replacement.path) }),
    );
    expect(failures.join('\n')).toContain(`${row!.id}: required-file replacement rule is missing`);
  });

  it('fails completeness when a concrete contract marker replacement disappears', () => {
    const row = wave3bInventory.entries.find((entry) => entry.replacement.kind === 'contract-marker-rule');
    expect(row).toBeDefined();
    if (row!.replacement.kind !== 'contract-marker-rule') throw new Error('expected contract-marker replacement');
    const replacement = row!.replacement;
    const marker = replacement.markers[0]!;
    const failures = parityCompletenessFailures(wave3b.captures, replacementSurface({
      contractMarkers: {
        ...VERIFY_CONTRACT_MARKERS,
        [replacement.path]: (VERIFY_CONTRACT_MARKERS[replacement.path] ?? []).filter((value) => value !== marker),
      },
    }));
    expect(failures.join('\n')).toContain(`${row!.id}: concrete replacement marker is missing: ${marker}`);
  });

  it('preserves historical positive exit/report semantics through current Node gates', () => {
    const captures = liveParityCaptures().filter((capture) => capture.exitCode === 0);
    const report = runGateRunner(repoRoot, captures.map((capture) => capture.gateId));
    const formatted = formatGateRunnerReport(report);
    expect(report.aggregate.exitCode, JSON.stringify(report.aggregate, null, 2)).toBe(0);
    for (const capture of captures) {
      expect(capture.argv.slice(0, 4)).toEqual(['pwsh', '-NoProfile', '-File', capture.legacyScript]);
      expect(capture.sourceBlobSha).toMatch(/^[0-9a-f]{40}$/u);
      expect(capture.artifacts).toEqual([]);
      const expectedStdout = capture.expectedRunnerStdout ?? capture.stdout;
      const result = report.results.find((candidate) => candidate.gateId === capture.gateId);
      expect(result?.status, capture.gateId).toBe(capture.expectedRunnerStatus ?? 'PASS');
      expect(normalizeCaptureStdout(capture, result?.legacyStdout ?? '')).toBe(normalizeCaptureStdout(capture, expectedStdout));
      expect(normalizeCaptureStdout(capture, formatted)).toContain(normalizeCaptureStdout(capture, expectedStdout).trimEnd());
    }
  });

  it.each(liveParityCaptures().filter((capture) => capture.exitCode !== 0))(
    'preserves historical negative diagnostics through the current Node gate for $legacyScript ($case)',
    (capture) => {
      const result = evaluateNegativeCapture(capture);
      const formatted = formatGateRunnerReport({ results: [result], aggregate: aggregateLane([result]) });
      expect(result.status).toBe(capture.expectedRunnerStatus ?? 'FAIL');
      for (const diagnostic of capture.expectedRunnerDiagnostics ?? []) {
        expect(result.details?.join('\n') ?? '').toContain(diagnostic);
        expect(formatted).toContain(diagnostic);
      }
      expect(formatted).toContain(`[${result.status}] ${capture.gateId}:`);
    },
  );
});
