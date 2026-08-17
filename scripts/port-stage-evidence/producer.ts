import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseHistoricalDispositions, HISTORICAL_DISPOSITION_SOURCE, type HistoricalDisposition } from '../runtime-retirement/retired-surface-guard.ts';
import { generateCurrentHeadProjection, serializeCurrentHeadProjection } from '../gate-runner/census-generator.ts';
import { assertUntrackedStagePath, loadMeasuredTree, type MeasuredTree, type MeasuredTreeFile } from './git-tree.ts';
import { createScriptTargetResolver } from './target-resolver.ts';
import {
  jsonStringValueRanges,
  scanPowerShellTokens,
  tsStringRanges,
  yamlScalarRanges,
  type ByteRange,
  type TokenOccurrence,
} from './tokens.ts';

export const ARTIFACT_ROLES = ['baseline', 'post-port', 'final'] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

export const ARTIFACT_PATHS: Readonly<Record<ArtifactRole, string>> = {
  baseline: 'docs/investigations/orca-pwsh-zero-estate/baseline.json',
  'post-port': 'docs/investigations/orca-pwsh-zero-estate/post-port.json',
  final: 'docs/investigations/orca-pwsh-zero-estate/final.json',
};

export const RETAINED_DISPOSITIONS_PATH = 'docs/investigations/orca-pwsh-zero-estate/retained-dispositions.json';

export const SOURCE_KINDS = [
  'tracked-ps1-file',
  'script-token-reference',
  'workflow-token-reference',
  'package-config-token-reference',
  'instruction-command',
  'instruction-directive',
  'instruction-reference-only',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface EvidenceOccurrence {
  readonly sourcePath: string;
  readonly line: number;
  readonly column: number;
  readonly tokenKind: 'runtime' | 'script' | 'tracked-ps1-file';
  readonly matchedBytes: string;
}

export interface EvidenceEntry {
  readonly sourceKind: SourceKind;
  readonly occurrence: EvidenceOccurrence;
  readonly resolvedScriptPath?: string;
  readonly targetResolution?: 'exact' | 'unresolved';
  readonly currentPrescriptive: boolean;
}

export interface RetainedDisposition {
  readonly path: string;
  readonly disposition: 'retained-for-1251-zero-estate';
  readonly reason: string;
  readonly owningReference: '#1251';
}

export interface PortStageEvidence {
  readonly schemaVersion: 'port-stage-evidence/v1';
  readonly artifactRole: ArtifactRole;
  readonly producerRevision: string;
  readonly measuredHead: string;
  readonly inputFactTreeDigest: string;
  readonly gateCensus: {
    readonly populationCount: number;
    readonly populationDigest: string;
    readonly outputDigest: string;
  };
  readonly historicalExclusions: readonly HistoricalDisposition[];
  readonly entries: readonly EvidenceEntry[];
  readonly unclassifiedPowerShellSurfaces: readonly EvidenceOccurrence[];
  readonly unresolvedCurrentPrescriptiveScriptTargets: readonly EvidenceOccurrence[];
  readonly retainedDispositions: readonly RetainedDisposition[];
  readonly broaderStatusClosed: boolean;
  readonly dormantRetainedCoverageComplete: boolean;
  readonly integrityDigest: string;
}

const INSTRUCTION_ROOT_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md']);
const ACTION_VERBS = ['run', 'execute', 'invoke', 'call', 'launch', 'start', 'use', 'install', 'replace', 'remove', 'delete', 'retire', 'migrate', 'verify', 'check'] as const;
const NEGATIVE = /\b(?:not|never)\b|\bdo\s+not\b/iu;
const MODAL = /\b(?:must|should|required\s+to|may\s+only)\b/giu;
const ACTION = new RegExp(`\\b(?:${ACTION_VERBS.join('|')})\\b`, 'giu');

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isClassifiedRoot(path: string): boolean {
  if (path.startsWith('scripts/') || path.startsWith('.github/workflows/') || path.startsWith('.claude/skills/') || path.startsWith('.cursor/skills/') || path.startsWith('prompts/') || path.startsWith('docs/')) return true;
  if (path === 'package.json' || INSTRUCTION_ROOT_FILES.has(path)) return true;
  return /^[^/]+\.config\.(?:json|ts)$/u.test(path);
}

function isInstructionPath(path: string): boolean {
  return path.startsWith('.claude/skills/') || path.startsWith('.cursor/skills/') || path.startsWith('prompts/') || path.startsWith('docs/') || INSTRUCTION_ROOT_FILES.has(path);
}

function isWorkflowPath(path: string): boolean {
  return path.startsWith('.github/workflows/') && /\.ya?ml$/iu.test(path);
}

function isPackageConfigPath(path: string): boolean {
  return path === 'package.json' || /^[^/]+\.config\.(?:json|ts)$/u.test(path);
}

function isUtf8(bytes: Buffer): boolean {
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
}

function exactHistoricalMap(tree: MeasuredTree): ReadonlyMap<string, HistoricalDisposition> {
  const source = tree.byPath.get(HISTORICAL_DISPOSITION_SOURCE);
  if (!source) throw new Error(`historical disposition authority is missing at measuredHead: ${HISTORICAL_DISPOSITION_SOURCE}`);
  const records = parseHistoricalDispositions(source.bytes.toString('utf8'));
  return new Map(records.map((record) => [record.path, record]));
}

function occurrenceFromToken(token: TokenOccurrence): EvidenceOccurrence {
  return { sourcePath: token.sourcePath, line: token.line, column: token.column, tokenKind: token.tokenKind, matchedBytes: token.matchedBytes };
}

export function unclassifiedPowerShellPathOccurrence(path: string): EvidenceOccurrence | undefined {
  if (!/\.ps1$/iu.test(path)) return undefined;
  return { sourcePath: path, line: 1, column: 1, tokenKind: 'tracked-ps1-file', matchedBytes: path };
}

function sourceLine(bytes: Buffer, line: number): string {
  return bytes.toString('latin1').split('\n')[line - 1] ?? '';
}

function fenceStateByLine(bytes: Buffer): ReadonlyMap<number, boolean> {
  const result = new Map<number, boolean>();
  const lines = bytes.toString('latin1').split('\n');
  let fence: { marker: '`' | '~'; length: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
    const marker = match?.[2];
    if (marker) {
      const char = marker[0] as '`' | '~';
      const suffix = match?.[3] ?? '';
      if (!fence) fence = { marker: char, length: marker.length };
      else if (fence.marker === char && marker.length >= fence.length && /^\s*$/u.test(suffix)) fence = undefined;
    }
    result.set(index + 1, fence !== undefined);
  }
  return result;
}

function stripInstructionPrefix(line: string): string {
  let text = line.replace(/^\s*/u, '');
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text.replace(/^(?:>\s*|[-*+]\s+|\d+[.)]\s+)/u, '');
  }
  return text.replace(/^(?:\$|PS>|>)\s*/iu, '');
}

function lastClause(prefix: string): string {
  let splitAt = -1;
  for (let index = 0; index < prefix.length; index += 1) {
    const char = prefix[index]!;
    const next = prefix[index + 1];
    if (char === ';' || char === '!' || char === '?' || (char === '.' && (next === undefined || /\s/u.test(next)))) splitAt = index;
  }
  return stripInstructionPrefix(prefix.slice(splitAt + 1));
}

interface TextMatch {
  readonly index: number;
  readonly end: number;
}

function allMatches(pattern: RegExp, text: string): readonly TextMatch[] {
  pattern.lastIndex = 0;
  const result: TextMatch[] = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    result.push({ index: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  pattern.lastIndex = 0;
  return result;
}

function positiveDirectivePrefix(prefix: string): boolean {
  const clause = lastClause(prefix);
  const clauseActions = allMatches(ACTION, clause);
  const firstClauseAction = clauseActions[0];
  if (firstClauseAction?.index === 0 && !NEGATIVE.test(clause.slice(firstClauseAction.index))) return true;

  const modals = allMatches(MODAL, prefix);
  const actions = allMatches(ACTION, prefix);
  for (let modalIndex = modals.length - 1; modalIndex >= 0; modalIndex -= 1) {
    const modal = modals[modalIndex]!;
    const action = actions.find((candidate) => candidate.index >= modal.end);
    if (!action) continue;
    if (!NEGATIVE.test(prefix.slice(modal.index, action.end))) return true;
  }
  return false;
}

export function classifyInstructionOccurrence(rawLine: string, occurrenceColumn: number, inFence = false): SourceKind {
  const occurrenceAt = Math.max(0, Math.min(rawLine.length, occurrenceColumn - 1));
  const stripped = stripInstructionPrefix(rawLine);
  const prefix = rawLine.slice(0, occurrenceAt);
  const commandPattern = /^(?:pwsh(?:\.exe)?|powershell(?:\.exe)?|[^\s]+\.ps1|&\s+[^\s]+\.ps1)(?:\s|$)/iu;
  if (commandPattern.test(stripped)) return 'instruction-command';
  if (inFence) return 'instruction-reference-only';
  return positiveDirectivePrefix(prefix) ? 'instruction-directive' : 'instruction-reference-only';
}

function instructionKind(file: MeasuredTreeFile, occurrence: EvidenceOccurrence, inFence: boolean): SourceKind {
  return classifyInstructionOccurrence(sourceLine(file.bytes, occurrence.line), occurrence.column, inFence);
}

function sourceRanges(file: MeasuredTreeFile): readonly ByteRange[] | undefined {
  if (isWorkflowPath(file.path)) return yamlScalarRanges(file.bytes);
  if (isPackageConfigPath(file.path) && file.path.toLowerCase().endsWith('.json')) return jsonStringValueRanges(file.bytes);
  if (isPackageConfigPath(file.path) && file.path.toLowerCase().endsWith('.ts')) return tsStringRanges(file.bytes);
  return undefined;
}

function sourceKind(file: MeasuredTreeFile, occurrence: EvidenceOccurrence, fence: ReadonlyMap<number, boolean>): SourceKind {
  if (file.path.startsWith('scripts/')) return 'script-token-reference';
  if (isWorkflowPath(file.path)) return 'workflow-token-reference';
  if (isPackageConfigPath(file.path)) return 'package-config-token-reference';
  if (isInstructionPath(file.path)) return instructionKind(file, occurrence, fence.get(occurrence.line) ?? false);
  throw new Error(`cannot classify occurrence under classified root: ${file.path}`);
}

interface RetainedFile {
  readonly version?: unknown;
  readonly owningIssue?: unknown;
  readonly dispositions?: unknown;
}

function parseRetained(tree: MeasuredTree): readonly RetainedDisposition[] {
  const file = tree.byPath.get(RETAINED_DISPOSITIONS_PATH);
  if (!file) throw new Error(`tracked retained disposition authority is missing: ${RETAINED_DISPOSITIONS_PATH}`);
  const parsed = JSON.parse(file.bytes.toString('utf8')) as RetainedFile;
  if (parsed.version !== 1 || parsed.owningIssue !== 1415 || !Array.isArray(parsed.dispositions)) throw new Error('retained-dispositions.json must be version 1, owningIssue 1415, with dispositions array');
  const seen = new Set<string>();
  return parsed.dispositions.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`retained disposition ${index} must be an object`);
    const value = candidate as Record<string, unknown>;
    const path = typeof value.path === 'string' ? normalizePath(value.path) : '';
    if (!path || path.startsWith('/') || path.endsWith('/') || path.includes('*') || path.split('/').includes('..') || !/\.ps1$/iu.test(path)) throw new Error(`invalid retained disposition path: ${path}`);
    if (seen.has(path)) throw new Error(`duplicate retained disposition: ${path}`);
    seen.add(path);
    if (value.disposition !== 'retained-for-1251-zero-estate' || value.owningReference !== '#1251' || typeof value.reason !== 'string' || value.reason.trim() === '') throw new Error(`invalid retained disposition metadata for ${path}`);
    return { path, disposition: 'retained-for-1251-zero-estate', reason: value.reason, owningReference: '#1251' };
  });
}

function stableEntries(entries: readonly EvidenceEntry[]): readonly EvidenceEntry[] {
  return [...entries].sort((left, right) => compareText(left.occurrence.sourcePath, right.occurrence.sourcePath)
    || left.occurrence.line - right.occurrence.line
    || left.occurrence.column - right.occurrence.column
    || compareText(left.occurrence.tokenKind, right.occurrence.tokenKind)
    || compareText(left.occurrence.matchedBytes, right.occurrence.matchedBytes));
}

function stableOccurrences(occurrences: readonly EvidenceOccurrence[]): readonly EvidenceOccurrence[] {
  return [...occurrences].sort((left, right) => compareText(left.sourcePath, right.sourcePath)
    || left.line - right.line
    || left.column - right.column
    || compareText(left.tokenKind, right.tokenKind)
    || compareText(left.matchedBytes, right.matchedBytes));
}

function digestable(evidence: Omit<PortStageEvidence, 'integrityDigest'>): string {
  return `${JSON.stringify(evidence)}\n`;
}

export function verifyEvidenceIntegrity(evidence: PortStageEvidence): void {
  const { integrityDigest, ...body } = evidence;
  const actual = sha256(digestable(body));
  if (actual !== integrityDigest) throw new Error(`port-stage evidence integrity mismatch: ${actual} != ${integrityDigest}`);
  if (ARTIFACT_PATHS[evidence.artifactRole] === undefined) throw new Error(`unknown artifact role: ${evidence.artifactRole}`);
  if (evidence.producerRevision !== evidence.measuredHead) throw new Error('producerRevision must equal measuredHead');
}

export async function producePortStageEvidence(input: {
  readonly repoRoot: string;
  readonly artifactRole: ArtifactRole;
  readonly measuredHead: string;
  readonly producerRevision?: string;
}): Promise<PortStageEvidence> {
  if (!ARTIFACT_ROLES.includes(input.artifactRole)) throw new Error(`unsupported artifact role: ${input.artifactRole}`);
  const tree = await loadMeasuredTree(input.repoRoot, input.measuredHead);
  const producerRevision = input.producerRevision ?? tree.measuredHead;
  if (producerRevision !== tree.measuredHead) throw new Error('producerRevision and measuredHead must be the same exact candidate SHA');
  const outputPath = ARTIFACT_PATHS[input.artifactRole];
  assertUntrackedStagePath(tree, outputPath);
  const historical = exactHistoricalMap(tree);
  const trackedPs1 = tree.files.filter((file) => isClassifiedRoot(file.path) && /\.ps1$/iu.test(file.path) && !historical.has(file.path)).map((file) => file.path);
  const resolver = createScriptTargetResolver(trackedPs1);
  const entries: EvidenceEntry[] = [];
  const unclassified: EvidenceOccurrence[] = [];
  const unresolved: EvidenceOccurrence[] = [];
  for (const file of tree.files) {
    if (historical.has(file.path)) continue;
    const classified = isClassifiedRoot(file.path);
    const resolvesWholePath = (candidate: string): boolean => resolver.resolvesWholePath(file.path, candidate);
    if (!classified) {
      const pathOccurrence = unclassifiedPowerShellPathOccurrence(file.path);
      if (pathOccurrence) unclassified.push(pathOccurrence);
    }
    if (!isUtf8(file.bytes)) {
      if (classified) continue;
      const tokenBytes = scanPowerShellTokens({ sourcePath: file.path, bytes: file.bytes, resolvesWholePath });
      unclassified.push(...tokenBytes.map(occurrenceFromToken));
      continue;
    }
    if (classified && /\.ps1$/iu.test(file.path)) continue;
    const ranges = classified ? sourceRanges(file) : undefined;
    const tokens = scanPowerShellTokens({ sourcePath: file.path, bytes: file.bytes, ranges, resolvesWholePath });
    if (!classified) {
      unclassified.push(...tokens.map(occurrenceFromToken));
      continue;
    }
    const fence = isInstructionPath(file.path) ? fenceStateByLine(file.bytes) : new Map<number, boolean>();
    for (const token of tokens) {
      const occurrence = occurrenceFromToken(token);
      const kind = sourceKind(file, occurrence, fence);
      const currentPrescriptive = kind !== 'instruction-reference-only';
      let resolvedScriptPath: string | undefined;
      let targetResolution: 'exact' | 'unresolved' | undefined;
      if (token.tokenKind === 'script') {
        resolvedScriptPath = resolver.resolve(file.path, token.matchedBytes);
        targetResolution = resolvedScriptPath ? 'exact' : 'unresolved';
        if (currentPrescriptive && !resolvedScriptPath) unresolved.push(occurrence);
      }
      entries.push({ sourceKind: kind, occurrence, resolvedScriptPath, targetResolution, currentPrescriptive });
    }
  }

  const prescriptiveTargets = new Set(entries.filter((entry) => entry.currentPrescriptive && entry.occurrence.tokenKind === 'script' && entry.resolvedScriptPath).map((entry) => entry.resolvedScriptPath!));
  for (const path of trackedPs1) {
    entries.push({
      sourceKind: 'tracked-ps1-file',
      occurrence: { sourcePath: path, line: 1, column: 1, tokenKind: 'tracked-ps1-file', matchedBytes: path },
      resolvedScriptPath: path,
      targetResolution: 'exact',
      currentPrescriptive: prescriptiveTargets.has(path),
    });
  }

  const retained = parseRetained(tree);
  const byTrackedPs1 = new Map(entries.filter((entry) => entry.sourceKind === 'tracked-ps1-file').map((entry) => [entry.occurrence.sourcePath, entry]));
  if (unresolved.length > 0 && retained.length > 0) throw new Error('retained dispositions are invalid while a current-prescriptive script target is unresolved');
  for (const row of retained) {
    const target = byTrackedPs1.get(row.path);
    if (!target) throw new Error(`retained disposition target is not a measured tracked PowerShell file: ${row.path}`);
    if (target.currentPrescriptive) throw new Error(`retained disposition target is current-prescriptive: ${row.path}`);
    if (historical.has(row.path)) throw new Error(`retained disposition conflicts with legal historical exclusion: ${row.path}`);
    if (prescriptiveTargets.has(row.path)) throw new Error(`retained disposition target has an incoming current-prescriptive reference: ${row.path}`);
  }
  const retainedPaths = new Set(retained.map((row) => row.path));
  const dormantPaths = [...byTrackedPs1.values()].filter((entry) => !entry.currentPrescriptive).map((entry) => entry.occurrence.sourcePath);
  const dormantRetainedCoverageComplete = dormantPaths.every((path) => retainedPaths.has(path)) && retained.every((row) => dormantPaths.includes(row.path));
  const stable = stableEntries(entries);
  const broaderStatusClosed = unclassified.length === 0 && unresolved.length === 0;
  const censusProjection = await generateCurrentHeadProjection(input.repoRoot, tree.measuredHead);
  const censusSerialized = serializeCurrentHeadProjection(censusProjection);
  const body: Omit<PortStageEvidence, 'integrityDigest'> = {
    schemaVersion: 'port-stage-evidence/v1',
    artifactRole: input.artifactRole,
    producerRevision,
    measuredHead: tree.measuredHead,
    inputFactTreeDigest: tree.inputFactTreeDigest,
    gateCensus: { populationCount: censusProjection.populationCount, populationDigest: censusProjection.populationDigest, outputDigest: censusSerialized.outputDigest },
    historicalExclusions: [...historical.values()].sort((left, right) => compareText(left.path, right.path)),
    entries: stable,
    unclassifiedPowerShellSurfaces: stableOccurrences(unclassified),
    unresolvedCurrentPrescriptiveScriptTargets: stableOccurrences(unresolved),
    retainedDispositions: retained,
    broaderStatusClosed,
    dormantRetainedCoverageComplete,
  };
  const evidence: PortStageEvidence = { ...body, integrityDigest: sha256(digestable(body)) };
  verifyEvidenceIntegrity(evidence);
  return evidence;
}

export function serializePortStageEvidence(evidence: PortStageEvidence): string {
  verifyEvidenceIntegrity(evidence);
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

export async function writePortStageEvidence(repoRoot: string, evidence: PortStageEvidence): Promise<string> {
  const path = ARTIFACT_PATHS[evidence.artifactRole];
  const absolute = resolve(repoRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, serializePortStageEvidence(evidence), { encoding: 'utf8', flag: 'w' });
  return path;
}
