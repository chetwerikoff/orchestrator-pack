import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { failGate, passGate, type EvidenceObservation, type GateResult } from './contracts.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

export const CENSUS_CLASSIFICATIONS = [
  'ported-declarative',
  'ported-custom',
  'still-enforced-by-legacy',
  'retired-with-justification',
] as const;

export type CensusClassification = (typeof CENSUS_CLASSIFICATIONS)[number];
export const CENSUS_SOURCE_KINDS = ['check-script', 'verify-script-member', 'verify-inline', 'check-reusable-behavior'] as const;
export type CensusSourceKind = (typeof CENSUS_SOURCE_KINDS)[number];

export interface CensusEntry {
  readonly id: string;
  readonly sourceKind: CensusSourceKind;
  readonly sourcePath: string;
  readonly marker: string;
  readonly classification: CensusClassification;
  readonly gateIds?: readonly string[];
  readonly legacyReference?: { readonly path: string; readonly marker: string };
  readonly retirementJustification?: {
    readonly reasonCode: string;
    readonly behavior: string;
    readonly replacement: string;
  };
}

export interface GateCensus {
  readonly version: 1;
  readonly issue: 830;
  readonly wave: '3.a';
  readonly baseCommitSha: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly populationCount: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly entries: readonly CensusEntry[];
}

const VALID_RETIREMENT_CODES = new Set([
  'dead-legacy-surface',
  'superseded-contract',
  'unfalsifiable-surface',
  'non-proving-observation',
]);

export const CENSUS_PATH = 'scripts/gate-runner/census/pre-change-baseline.json';

export function loadCensus(repoRoot: string): GateCensus {
  return JSON.parse(readFileSync(resolve(repoRoot, CENSUS_PATH), 'utf8')) as GateCensus;
}

function currentCheckScripts(snapshot: SourceSnapshot): Set<string> {
  return new Set(snapshot.paths.filter((path) => /^scripts\/check-.*\.ps1$/u.test(path)));
}

function currentVerifyScriptMembers(verify: string): Set<string> {
  return new Set(verify.match(/scripts\/check-[A-Za-z0-9._-]+\.ps1/gu) ?? []);
}

function addMatches(target: Set<string>, text: string, pattern: RegExp, prefix: string): void {
  for (const match of text.matchAll(pattern)) {
    const value = match[1];
    if (value) target.add(`${prefix}${value}`);
  }
}

export function discoverVerifyInlineIds(verify: string): Set<string> {
  const ids = new Set<string>();
  addMatches(ids, verify, /Test-CommandVersion\s+-Command\s+'([^']+)'/gu, 'verify-inline:command-version:');
  addMatches(ids, verify, /Test-ContractMarkers\s+'([^']+)'/gu, 'verify-inline:contract-marker:');
  for (const match of verify.matchAll(/Write-Check\s+'([^']+)'/gu)) {
    const name = match[1];
    if (!name || /^scripts\/check-.*\.ps1(?:\s+-SelfTest)?$/u.test(name) || name === 'gate-runner/core') continue;
    ids.add(`verify-inline:write-check:${name}`);
  }

  const requiredBlock = /\$requiredFiles\s*=\s*@\(([\s\S]*?)\)\s*foreach\s*\(\$file/gu.exec(verify)?.[1] ?? '';
  addMatches(ids, requiredBlock, /'([^']+)'/gu, 'verify-inline:required-file:');
  return ids;
}

export function validateCensusSchema(census: GateCensus): string[] {
  const failures: string[] = [];
  if (census.version !== 1 || census.issue !== 830 || census.wave !== '3.a') failures.push('census header must bind to issue 830 / wave 3.a / schema version 1');
  if (census.populationCount !== census.entries.length) failures.push(`populationCount=${census.populationCount} does not match entries=${census.entries.length}`);
  const ids = new Set<string>();
  const classifiedCounts = new Map<CensusClassification, number>();
  for (const entry of census.entries) {
    if (ids.has(entry.id)) failures.push(`duplicate census id: ${entry.id}`);
    ids.add(entry.id);
    if (!CENSUS_CLASSIFICATIONS.includes(entry.classification)) failures.push(`${entry.id}: invalid classification ${String(entry.classification)}`);
    classifiedCounts.set(entry.classification, (classifiedCounts.get(entry.classification) ?? 0) + 1);
    if (entry.classification === 'still-enforced-by-legacy') {
      if (!entry.legacyReference?.path || !entry.legacyReference.marker) failures.push(`${entry.id}: legacy row lacks a cited invocation`);
    }
    if (entry.classification === 'ported-declarative' || entry.classification === 'ported-custom') {
      if (!entry.gateIds || entry.gateIds.length === 0) failures.push(`${entry.id}: ported row lacks gateIds`);
    }
    if (entry.classification === 'retired-with-justification') {
      const justification = entry.retirementJustification;
      if (!justification) {
        failures.push(`${entry.id}: retired row lacks justification`);
      } else {
        if (!VALID_RETIREMENT_CODES.has(justification.reasonCode)) failures.push(`${entry.id}: invalid retirement reasonCode ${justification.reasonCode}`);
        if (justification.behavior.trim().length < 80) failures.push(`${entry.id}: retirement behavior justification is not substantive`);
        if (justification.replacement.trim().length < 40) failures.push(`${entry.id}: retirement replacement explanation is not substantive`);
        if (/no (current )?caller|unreferenced|not used/iu.test(`${justification.behavior} ${justification.replacement}`)) {
          failures.push(`${entry.id}: retirement justification relies on caller absence instead of behavior`);
        }
      }
    }
  }
  if (!/^[0-9a-f]{40}$/u.test(census.baseCommitSha)) failures.push('baseCommitSha must be a full lowercase Git SHA');
  for (const [path, hash] of Object.entries(census.sourceHashes)) {
    if (!path || !/^[0-9a-f]{64}$/u.test(hash)) failures.push(`invalid frozen source hash for ${path || '<empty>'}`);
  }

  const sourceCounts = new Map<CensusSourceKind, number>();
  for (const entry of census.entries) {
    if (!CENSUS_SOURCE_KINDS.includes(entry.sourceKind)) failures.push(`${entry.id}: invalid sourceKind ${String(entry.sourceKind)}`);
    sourceCounts.set(entry.sourceKind, (sourceCounts.get(entry.sourceKind) ?? 0) + 1);
  }
  const committedCountKeys = Object.keys(census.counts).sort();
  const expectedCountKeys = [...CENSUS_SOURCE_KINDS].sort();
  if (committedCountKeys.join('\0') !== expectedCountKeys.join('\0')) failures.push('counts must contain exactly the four census source kinds');
  for (const kind of CENSUS_SOURCE_KINDS) {
    const count = census.counts[kind] ?? -1;
    if (!Number.isInteger(count) || count < 0) failures.push(`invalid committed count for ${kind}`);
    if ((sourceCounts.get(kind) ?? 0) !== count) failures.push(`source-kind count drift for ${kind}: committed=${String(count)} actual=${sourceCounts.get(kind) ?? 0}`);
  }
  if ([...classifiedCounts.values()].reduce((sum, value) => sum + value, 0) !== census.populationCount) failures.push('not every baseline row has exactly one classification');
  return failures;
}

export function evaluateCensus(
  census: GateCensus,
  snapshot: SourceSnapshot,
  registeredGateIds: ReadonlySet<string>,
): GateResult {
  const failures = validateCensusSchema(census);
  const baselineScripts = new Map(
    census.entries
      .filter((entry) => entry.sourceKind === 'check-script')
      .map((entry) => [entry.sourcePath, entry] as const),
  );
  const currentScripts = currentCheckScripts(snapshot);
  for (const path of currentScripts) {
    if (!baselineScripts.has(path)) failures.push(`unaccounted check script added after frozen baseline: ${path}`);
  }

  for (const entry of census.entries) {
    const ported = entry.classification === 'ported-declarative' || entry.classification === 'ported-custom';
    const retired = entry.classification === 'retired-with-justification';
    if (ported) {
      for (const gateId of entry.gateIds ?? []) {
        if (!registeredGateIds.has(gateId)) failures.push(`${entry.id}: registered gate missing: ${gateId}`);
      }
    }

    if (entry.sourceKind === 'check-script') {
      const exists = currentScripts.has(entry.sourcePath);
      if ((ported || retired) && exists) failures.push(`${entry.id}: migrated/retired PowerShell gate still exists`);
      if (entry.classification === 'still-enforced-by-legacy' && !exists) failures.push(`${entry.id}: deferred legacy gate was dropped`);
    }

    if (entry.sourceKind === 'verify-script-member') {
      const verify = snapshot.files.get('scripts/verify.ps1') ?? '';
      const present = verify.includes(entry.marker);
      if ((ported || retired) && present) failures.push(`${entry.id}: migrated/retired verify invocation still exists`);
      if (entry.classification === 'still-enforced-by-legacy' && !present) failures.push(`${entry.id}: deferred verify invocation was dropped`);
    }

    if (entry.classification === 'still-enforced-by-legacy') {
      const reference = entry.legacyReference;
      if (!reference) continue;
      const text = snapshot.files.get(reference.path);
      if (text === undefined || !text.includes(reference.marker)) failures.push(`${entry.id}: cited legacy invocation is no longer wired at ${reference.path}`);
    }
  }

  const verify = snapshot.files.get('scripts/verify.ps1') ?? '';
  const baselineVerifyMembers = new Set(
    census.entries
      .filter((entry) => entry.sourceKind === 'verify-script-member')
      .map((entry) => entry.marker),
  );
  for (const path of currentVerifyScriptMembers(verify)) {
    if (!baselineVerifyMembers.has(path)) failures.push(`unaccounted verify.ps1 check-script member: ${path}`);
  }

  const currentInlineIds = discoverVerifyInlineIds(verify);
  const baselineInlineRows = census.entries.filter((entry) => entry.sourceKind === 'verify-inline');
  const baselineInlineIds = new Set(baselineInlineRows.map((entry) => entry.id));
  for (const id of currentInlineIds) {
    if (!baselineInlineIds.has(id)) failures.push(`unaccounted verify.ps1 inline aggregation member: ${id}`);
  }
  for (const entry of baselineInlineRows) {
    const present = currentInlineIds.has(entry.id);
    if (entry.classification === 'still-enforced-by-legacy' && !present) failures.push(`${entry.id}: deferred verify inline aggregation member was dropped`);
    if (entry.classification !== 'still-enforced-by-legacy' && present) failures.push(`${entry.id}: migrated/retired verify inline aggregation member still exists`);
  }

  const dispatchMatches = verify.match(/scripts\/gate-runner\/runner\.ts/gu) ?? [];
  if (dispatchMatches.length !== 1) failures.push(`verify.ps1 must contain exactly one gate-runner dispatch marker; found ${dispatchMatches.length}`);

  const evidence: EvidenceObservation[] = [
    { class: 'static-source', state: 'present', source: CENSUS_PATH },
    { class: 'fixture', state: 'present', source: 'frozen pre-change population' },
  ];
  if (failures.length > 0) {
    return failGate('gate-census', 'Gate population census reconciliation failed.', evidence, failures);
  }
  return passGate(
    'gate-census',
    `All ${census.populationCount} pre-change enforcement surfaces remain accounted for.`,
    ['static-source', 'fixture'],
    evidence,
  );
}
