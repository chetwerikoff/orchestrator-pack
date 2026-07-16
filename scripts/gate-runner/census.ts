import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { failGate, passGate, type EvidenceObservation, type GateResult } from './contracts.ts';
import { populationDigest } from './census-generator.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

export const LEGACY_CENSUS_CLASSIFICATIONS = [
  'ported-declarative',
  'ported-custom',
  'still-enforced-by-legacy',
  'retired-with-justification',
] as const;

export const TERMINAL_CENSUS_CLASSIFICATIONS = [
  'ported-declarative',
  'ported-custom',
  'retired-with-reason',
  'deferred-to-named-wave',
] as const;

export const CENSUS_CLASSIFICATIONS = [
  'ported-declarative',
  'ported-custom',
  'still-enforced-by-legacy',
  'retired-with-justification',
  'retired-with-reason',
  'deferred-to-named-wave',
] as const;

export const DEFERRED_WAVES = [
  'E1 lock/claim/recovery core',
  'Wave C gh-transport',
  'Wave D polling/send/tmux',
  'E2 supervisors',
  'PR 9 workflow sweep',
  'PR 10 harness retirement',
] as const;

export type CensusClassification = (typeof CENSUS_CLASSIFICATIONS)[number];
export type DeferredWave = (typeof DEFERRED_WAVES)[number];
export const CENSUS_SOURCE_KINDS = ['check-script', 'verify-script-member', 'verify-inline', 'check-reusable-behavior'] as const;
export type CensusSourceKind = (typeof CENSUS_SOURCE_KINDS)[number];
export const LEGACY_REFERENCE_KINDS = [
  'verify-script-call',
  'verify-inline-call',
  'behavior-container',
  'powershell-delegation',
  'powershell-wrapper-binding',
  'workflow-step',
  'operator-command',
  'test-invocation',
  'delegated-test-invocation',
] as const;
export type LegacyReferenceKind = (typeof LEGACY_REFERENCE_KINDS)[number];

export interface CensusEntry {
  readonly id: string;
  readonly sourceKind: CensusSourceKind;
  readonly sourcePath: string;
  readonly marker: string;
  readonly classification: CensusClassification;
  readonly gateIds?: readonly string[];
  readonly legacyReference?: {
    readonly path: string;
    readonly marker: string;
    readonly kind: LegacyReferenceKind;
  };
  readonly deferredWave?: DeferredWave;
  readonly retirementJustification?: {
    readonly reasonCode: string;
    readonly behavior: string;
    readonly replacement: string;
  };
}

export interface GateCensus {
  readonly version: 1 | 2;
  readonly issue: 830;
  readonly wave: '3.a' | '3.b';
  readonly migrationIssue?: 841;
  readonly baseCommitSha: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly generation: {
    readonly tool: 'scripts/gate-runner/census-generator.ts';
    readonly baseCommitSha: string;
    readonly populationDigest: string;
  };
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
const VALID_DEFERRED_WAVES = new Set<string>(DEFERRED_WAVES);

export const CENSUS_PATH = 'scripts/gate-runner/census/pre-change-baseline.json';
export const CENSUS_GENERATION_PATH = 'scripts/gate-runner/census/generation.json';

const EXPECTED_BASE_COMMIT = 'b7394065b9ee1b046abb4cf29aff456df1935571';
const EXPECTED_SOURCE_HASHES = {
  'scripts/verify.ps1': '6bf8b3459885d603fa112d56c1a5afff6e472c2676c71eeb3e1510f0553562c9',
  'scripts/check-reusable.ps1': 'dafb1766d1d7b60181527dbb24593051270d21814291909000355541da26e0eb',
} as const;

export function loadCensus(repoRoot: string): GateCensus {
  const census = JSON.parse(readFileSync(resolve(repoRoot, CENSUS_PATH), 'utf8')) as Omit<GateCensus, 'generation'>;
  const generation = JSON.parse(readFileSync(resolve(repoRoot, CENSUS_GENERATION_PATH), 'utf8')) as GateCensus['generation'];
  return { ...census, generation };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isPorted(entry: CensusEntry): boolean {
  return entry.classification === 'ported-declarative' || entry.classification === 'ported-custom';
}

function isDeferred(entry: CensusEntry): boolean {
  return entry.classification === 'still-enforced-by-legacy' || entry.classification === 'deferred-to-named-wave';
}

function isRetired(entry: CensusEntry): boolean {
  return entry.classification === 'retired-with-justification' || entry.classification === 'retired-with-reason';
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function referencedScriptPath(marker: string): string {
  return marker.startsWith('scripts/') ? marker : `scripts/${marker}`;
}

function assignedPathVariable(text: string, rootVariable: 'Root' | 'PSScriptRoot', path: string): string | undefined {
  const match = new RegExp(
    `\\$([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*Join-Path\\s+\\$${rootVariable}\\s+['\"]${escapeRegExp(path)}['\"]`,
    'iu',
  ).exec(text);
  return match?.[1];
}

function invokesPowerShellVariable(text: string, variable: string): boolean {
  return new RegExp(`&\\s+(?:pwsh\\s+-NoProfile\\s+-File\\s+)?\\$${escapeRegExp(variable)}\\b`, 'iu').test(text);
}

function hasVerifyScriptCall(text: string, marker: string): boolean {
  const target = referencedScriptPath(marker);
  const variable = assignedPathVariable(text, 'Root', target);
  if (variable && invokesPowerShellVariable(text, variable)) return true;

  const tableEntry = new RegExp(
    `@\\{\\s*(?:Path|path)\\s*=\\s*['\"]${escapeRegExp(target)}['\"]`,
    'iu',
  ).test(text);
  if (!tableEntry) return false;
  const resolvesTablePath = /Join-Path\s+\$Root\s+\$check\.(?:Path|path)/iu.test(text);
  const invokesResolvedPath = /&\s+\$(?:checkPath|full)\b/iu.test(text);
  return resolvesTablePath && invokesResolvedPath;
}

function hasPowerShellDelegation(text: string, marker: string): boolean {
  const bare = marker.replace(/^scripts\//u, '');
  const direct = new RegExp(
    `&\\s*\\(Join-Path\\s+\\$PSScriptRoot\\s+['\"]${escapeRegExp(bare)}['\"]\\)`,
    'iu',
  ).test(text);
  if (direct) return true;
  const variable = assignedPathVariable(text, 'PSScriptRoot', bare) ?? assignedPathVariable(text, 'Root', referencedScriptPath(marker));
  return variable !== undefined && invokesPowerShellVariable(text, variable);
}

function hasPowerShellWrapperBinding(text: string, marker: string): boolean {
  const bare = marker.replace(/^scripts\//u, '');
  const variable = assignedPathVariable(text, 'PSScriptRoot', bare) ?? assignedPathVariable(text, 'Root', referencedScriptPath(marker));
  if (!variable) return false;
  return new RegExp(`['\"]--core['\"]\\s*,\\s*\\$${escapeRegExp(variable)}\\b`, 'iu').test(text);
}

function hasWorkflowStep(text: string, marker: string): boolean {
  const target = referencedScriptPath(marker);
  return new RegExp(`^\\s*run:\\s+[^\\r\\n]*(?:\\./)?${escapeRegExp(target)}(?:\\s|$)`, 'imu').test(text);
}

function hasOperatorCommand(text: string, marker: string): boolean {
  const target = referencedScriptPath(marker);
  return new RegExp(`pwsh(?:\\.exe)?\\s+-NoProfile\\s+-File\\s+(?:\\./)?${escapeRegExp(target)}(?:\\s|$)`, 'iu').test(text);
}

function hasTestInvocation(text: string, marker: string): boolean {
  const target = referencedScriptPath(marker);
  const childCall = /(?:spawnSync|execFileSync)\s*\(/u.test(text);
  const pathArgument = new RegExp(`path\\.join\\([^\\r\\n]*['\"]${escapeRegExp(target)}['\"]`, 'iu').test(text);
  const literalCommand = new RegExp(`pwsh[^\\r\\n]*-File\\s+${escapeRegExp(target)}`, 'iu').test(text);
  return childCall && (pathArgument || literalCommand);
}

function hasBehaviorContainerReference(entry: CensusEntry, text: string): boolean {
  switch (entry.id) {
    case 'check-reusable:allow-no-git':
      return /if\s*\(\$AllowNoGit\)\s*\{\s*exit\s+0\s*\}/iu.test(text);
    case 'check-reusable:allowed-path-patterns':
      return /\$allowedPathPatterns\s*=\s*@\(/iu.test(text);
    case 'check-reusable:allowed-root-patterns':
      return /\$allowedRootPatterns\s*=\s*@\(/iu.test(text);
    case 'check-reusable:exception-patterns':
      return /\$exceptionPatterns\s*=\s*@\(/iu.test(text);
    case 'check-reusable:forbidden-patterns':
      return /\$forbiddenPatterns\s*=\s*@\(/iu.test(text);
    case 'check-reusable:git-command-presence':
      return /if\s*\(\s*-not\s*\(Get-Command\s+git\b[^)]*\)\s*\)\s*\{/iu.test(text)
        && /Write-Host\s+['"]\[WARN\] git not found; cannot inspect tracked files\.['"]/iu.test(text);
    case 'check-reusable:tracked-file-enumeration':
      return /&\s+git\s+-C\s+\$Root\s+ls-files\b/iu.test(text);
    case 'check-reusable:violation-aggregation':
      return /if\s*\(\$Violations\.Count\s+-gt\s+0\)\s*\{/iu.test(text);
    case 'check-reusable:worktree-detection':
      return /&\s+git\s+-C\s+\$Root\s+rev-parse\s+--is-inside-work-tree\b/iu.test(text);
    default:
      return false;
  }
}

function hasDelegatedTestInvocation(entry: CensusEntry, snapshot: SourceSnapshot, text: string, marker: string): boolean {
  const source = snapshot.files.get(entry.sourcePath);
  if (source === undefined) return false;
  const bareTarget = marker.replace(/^scripts\//u, '');
  const delegated = new RegExp(
    `Join-Path\\s+\\$Root\\s+['\"]${escapeRegExp(marker)}['\"]`,
    'iu',
  ).test(source) && /&\s+node\s+\$[A-Za-z_][A-Za-z0-9_]*\b/iu.test(source);
  const testExecutesTarget = /execFileSync\s*\(\s*['"]node['"]/u.test(text)
    && new RegExp(`['\"]${escapeRegExp(marker)}['\"]`, 'u').test(text);
  return delegated && testExecutesTarget && bareTarget.length > 0;
}

function legacyReferenceIsWired(entry: CensusEntry, snapshot: SourceSnapshot): boolean {
  const reference = entry.legacyReference;
  if (!reference) return false;
  const text = snapshot.files.get(reference.path);
  if (text === undefined) return false;
  switch (reference.kind) {
    case 'verify-script-call': return hasVerifyScriptCall(text, reference.marker);
    case 'verify-inline-call': return discoverVerifyInlineIds(text).has(entry.id);
    case 'behavior-container': return hasBehaviorContainerReference(entry, text);
    case 'powershell-delegation': return hasPowerShellDelegation(text, reference.marker);
    case 'powershell-wrapper-binding': return hasPowerShellWrapperBinding(text, reference.marker);
    case 'workflow-step': return hasWorkflowStep(text, reference.marker);
    case 'operator-command': return hasOperatorCommand(text, reference.marker);
    case 'test-invocation': return hasTestInvocation(text, reference.marker);
    case 'delegated-test-invocation': return hasDelegatedTestInvocation(entry, snapshot, text, reference.marker);
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

function validateHeader(census: GateCensus, failures: string[]): void {
  if (census.issue !== 830) failures.push('census provenance must remain bound to issue 830');
  if (census.version === 1) {
    if (census.wave !== '3.a' || census.migrationIssue !== undefined) {
      failures.push('schema v1 census must bind to issue 830 / wave 3.a');
    }
    return;
  }
  if (census.version !== 2 || census.wave !== '3.b' || census.migrationIssue !== 841) {
    failures.push('schema v2 census must bind to migration issue 841 / wave 3.b while retaining issue 830 provenance');
  }
}

export function validateCensusSchema(census: GateCensus): string[] {
  const failures: string[] = [];
  validateHeader(census, failures);
  if (census.populationCount !== census.entries.length) failures.push(`populationCount=${census.populationCount} does not match entries=${census.entries.length}`);
  const ids = new Set<string>();
  const classifiedCounts = new Map<CensusClassification, number>();
  for (const entry of census.entries) {
    if (ids.has(entry.id)) failures.push(`duplicate census id: ${entry.id}`);
    ids.add(entry.id);
    if (!CENSUS_CLASSIFICATIONS.includes(entry.classification)) failures.push(`${entry.id}: invalid classification ${String(entry.classification)}`);
    classifiedCounts.set(entry.classification, (classifiedCounts.get(entry.classification) ?? 0) + 1);

    if (census.version === 1 && !LEGACY_CENSUS_CLASSIFICATIONS.includes(entry.classification as (typeof LEGACY_CENSUS_CLASSIFICATIONS)[number])) {
      failures.push(`${entry.id}: schema v1 cannot use terminal Wave 3.b classification ${entry.classification}`);
    }
    if (census.version === 2 && !TERMINAL_CENSUS_CLASSIFICATIONS.includes(entry.classification as (typeof TERMINAL_CENSUS_CLASSIFICATIONS)[number])) {
      failures.push(`${entry.id}: schema v2 cannot retain provisional classification ${entry.classification}`);
    }

    if (isDeferred(entry)) {
      if (!entry.legacyReference?.path || !entry.legacyReference.marker || !entry.legacyReference.kind) {
        failures.push(`${entry.id}: deferred row lacks a typed legacy invocation`);
      } else if (!LEGACY_REFERENCE_KINDS.includes(entry.legacyReference.kind)) {
        failures.push(`${entry.id}: invalid legacy reference kind ${String(entry.legacyReference.kind)}`);
      }
      if (entry.classification === 'deferred-to-named-wave') {
        if (!entry.deferredWave || !VALID_DEFERRED_WAVES.has(entry.deferredWave)) failures.push(`${entry.id}: deferred row lacks a valid named sibling wave`);
      } else if (entry.deferredWave !== undefined) {
        failures.push(`${entry.id}: provisional legacy row must not claim a Wave 3.b deferral owner`);
      }
    } else {
      if (entry.legacyReference) failures.push(`${entry.id}: non-deferred row must not retain a legacy invocation`);
      if (entry.deferredWave !== undefined) failures.push(`${entry.id}: non-deferred row must not claim a deferral owner`);
    }

    if (isPorted(entry)) {
      if (!entry.gateIds || entry.gateIds.length === 0) failures.push(`${entry.id}: ported row lacks gateIds`);
    } else if (entry.gateIds && entry.gateIds.length > 0) {
      failures.push(`${entry.id}: non-ported row cannot be admitted to the runner`);
    }

    if (isRetired(entry)) {
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
    } else if (entry.retirementJustification) {
      failures.push(`${entry.id}: non-retired row must not carry a retirement justification`);
    }
  }
  if (!/^[0-9a-f]{40}$/u.test(census.baseCommitSha)) failures.push('baseCommitSha must be a full lowercase Git SHA');
  if (census.baseCommitSha !== EXPECTED_BASE_COMMIT) failures.push(`census baseline must remain bound to pre-change commit ${EXPECTED_BASE_COMMIT}`);
  if (census.generation?.tool !== 'scripts/gate-runner/census-generator.ts') failures.push('census generation tool provenance is missing or invalid');
  if (census.generation?.baseCommitSha !== census.baseCommitSha) failures.push('census generation provenance is not bound to the frozen pre-change commit');
  const digest = populationDigest(census.entries);
  if (census.generation?.populationDigest !== digest) failures.push(`generated population digest drift: committed=${census.generation?.populationDigest ?? '<missing>'} actual=${digest}`);
  for (const [path, hash] of Object.entries(census.sourceHashes)) {
    if (!path || !/^[0-9a-f]{64}$/u.test(hash)) failures.push(`invalid frozen source hash for ${path || '<empty>'}`);
  }
  if (Object.keys(census.sourceHashes).sort().join('\0') !== Object.keys(EXPECTED_SOURCE_HASHES).sort().join('\0')) {
    failures.push('sourceHashes must contain exactly the frozen pre-change source set');
  }
  for (const [path, expected] of Object.entries(EXPECTED_SOURCE_HASHES)) {
    if (census.sourceHashes[path] !== expected) failures.push(`frozen source hash drift for ${path}`);
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
    const ported = isPorted(entry);
    const retired = isRetired(entry);
    const deferred = isDeferred(entry);
    if (ported) {
      for (const gateId of entry.gateIds ?? []) {
        if (!registeredGateIds.has(gateId)) failures.push(`${entry.id}: registered gate missing: ${gateId}`);
      }
    }

    if (entry.sourceKind === 'check-script') {
      const exists = currentScripts.has(entry.sourcePath);
      if ((ported || retired) && exists) failures.push(`${entry.id}: migrated/retired PowerShell gate still exists`);
      if (deferred && !exists) failures.push(`${entry.id}: deferred legacy gate was dropped`);
    }

    if (entry.sourceKind === 'verify-script-member') {
      const verify = snapshot.files.get('scripts/verify.ps1') ?? '';
      const present = verify.includes(entry.marker);
      if ((ported || retired) && present) failures.push(`${entry.id}: migrated/retired verify invocation still exists`);
      if (deferred && !present) failures.push(`${entry.id}: deferred verify invocation was dropped`);
    }

    if (deferred) {
      const reference = entry.legacyReference;
      if (!reference) continue;
      if (!legacyReferenceIsWired(entry, snapshot)) {
        failures.push(`${entry.id}: typed legacy invocation is no longer executable at ${reference.path} (${reference.kind})`);
      }
    }
  }

  const reusableRows = census.entries.filter((entry) => entry.sourceKind === 'check-reusable-behavior');
  const checkReusable = snapshot.files.get('scripts/check-reusable.ps1');
  const allReusableRowsDeferred = reusableRows.length > 0 && reusableRows.every(isDeferred);
  if (allReusableRowsDeferred) {
    if (checkReusable === undefined) failures.push('scripts/check-reusable.ps1 is missing while its behaviors remain legacy-enforced');
    else if (sha256(checkReusable) !== census.sourceHashes['scripts/check-reusable.ps1']) {
      failures.push('scripts/check-reusable.ps1 behavior surface drifted without census reclassification');
    }
  } else {
    for (const entry of reusableRows) {
      const present = checkReusable?.includes(entry.marker) === true;
      if (isDeferred(entry) && !present) failures.push(`${entry.id}: deferred check-reusable behavior was dropped`);
      if (!isDeferred(entry) && present) failures.push(`${entry.id}: migrated/retired check-reusable behavior remains reachable`);
    }
    if (reusableRows.every((entry) => !isDeferred(entry)) && checkReusable !== undefined) {
      failures.push('scripts/check-reusable.ps1 remains after every behavior was migrated or retired');
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
    if (isDeferred(entry) && !present) failures.push(`${entry.id}: deferred verify inline aggregation member was dropped`);
    if (!isDeferred(entry) && present) failures.push(`${entry.id}: migrated/retired verify inline aggregation member still exists`);
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
