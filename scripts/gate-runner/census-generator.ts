import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isDirectExecution, readGitFile } from '#opk-toolchain/baseline-io';
import { runProcess } from '#opk-kernel/subprocess';
import type { CensusClassification, CensusSourceKind, GateCensus, PortedWave } from './census.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

export interface CensusPopulationEntry {
  readonly id: string;
  readonly sourceKind: CensusSourceKind;
  readonly sourcePath: string;
  readonly marker: string;
  readonly classification?: CensusClassification;
  readonly gateIds?: readonly string[];
  readonly portedInWave?: PortedWave;
}

export interface PrechangeSourceSnapshot {
  readonly paths: readonly string[];
  readonly verify: string;
  readonly checkReusable: string;
}

export interface GeneratedPopulationBaseline {
  readonly baseCommitSha: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly populationCount: number;
  readonly counts: Readonly<Record<CensusSourceKind, number>>;
  readonly populationDigest: string;
  readonly migrationOwnershipDigest: string;
  readonly entries: readonly CensusPopulationEntry[];
}

export interface CurrentHeadCensusProjection {
  readonly version: 1;
  readonly measuredHead: string;
  readonly populationCount: number;
  readonly populationDigest: string;
  readonly entries: GateCensus['entries'];
}

export interface SerializedCurrentHeadCensus {
  readonly projection: CurrentHeadCensusProjection;
  readonly bytes: string;
  readonly outputDigest: string;
}

export const CHECK_REUSABLE_BEHAVIOR_PROBES = [
  { id: 'check-reusable:allow-no-git', marker: 'if ($AllowNoGit) { exit 0 }' },
  { id: 'check-reusable:allowed-path-patterns', marker: '$allowedPathPatterns' },
  { id: 'check-reusable:allowed-root-patterns', marker: '$allowedRootPatterns' },
  { id: 'check-reusable:exception-patterns', marker: '$exceptionPatterns' },
  { id: 'check-reusable:forbidden-patterns', marker: '$forbiddenPatterns' },
  { id: 'check-reusable:git-command-presence', marker: 'git not found; cannot inspect tracked files.' },
  { id: 'check-reusable:tracked-file-enumeration', marker: 'ls-files' },
  { id: 'check-reusable:violation-aggregation', marker: '$Violations.Count -gt 0' },
  { id: 'check-reusable:worktree-detection', marker: 'rev-parse --is-inside-work-tree' },
] as const;

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function addInlineEntries(entries: CensusPopulationEntry[], verify: string): void {
  for (const match of verify.matchAll(/Test-CommandVersion\s+-Command\s+'([^']+)'/gu)) {
    const command = match[1];
    if (!command) continue;
    entries.push({ id: `verify-inline:command-version:${command}`, sourceKind: 'verify-inline', sourcePath: 'scripts/verify.ps1', marker: command });
  }
  for (const match of verify.matchAll(/Test-ContractMarkers\s+'([^']+)'/gu)) {
    const path = match[1];
    if (!path) continue;
    entries.push({ id: `verify-inline:contract-marker:${path}`, sourceKind: 'verify-inline', sourcePath: 'scripts/verify.ps1', marker: `Test-ContractMarkers '${path}'` });
  }
  for (const match of verify.matchAll(/Write-Check\s+'([^']+)'/gu)) {
    const name = match[1];
    if (!name || /^scripts\/check-.*\.ps1(?:\s+-SelfTest)?$/u.test(name) || name === 'gate-runner/core') continue;
    entries.push({ id: `verify-inline:write-check:${name}`, sourceKind: 'verify-inline', sourcePath: 'scripts/verify.ps1', marker: name });
  }
  const requiredBlock = /\$requiredFiles\s*=\s*@\(([\s\S]*?)\)\s*foreach\s*\(\$file/gu.exec(verify)?.[1] ?? '';
  for (const match of requiredBlock.matchAll(/'([^']+)'/gu)) {
    const path = match[1];
    if (!path) continue;
    entries.push({ id: `verify-inline:required-file:${path}`, sourceKind: 'verify-inline', sourcePath: 'scripts/verify.ps1', marker: path });
  }
}

export function populationDigest(entries: readonly CensusPopulationEntry[]): string {
  const payload = entries
    .map(({ id, sourceKind, sourcePath, marker }) => ({ id, sourceKind, sourcePath, marker }))
    .sort((left, right) => compareOrdinal(left.id, right.id))
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  return sha256(`${payload}\n`);
}

export function migrationOwnershipDigest(entries: readonly CensusPopulationEntry[]): string {
  const payload = entries
    .map(({ id, classification, gateIds, portedInWave }) => ({ id, classification: classification ?? null, gateIds: [...(gateIds ?? [])].sort(compareOrdinal), portedInWave: portedInWave ?? null }))
    .sort((left, right) => compareOrdinal(left.id, right.id))
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  return sha256(`${payload}\n`);
}

export function generatePrechangePopulation(baseCommitSha: string, snapshot: PrechangeSourceSnapshot): GeneratedPopulationBaseline {
  if (!/^[0-9a-f]{40}$/u.test(baseCommitSha)) throw new Error('baseCommitSha must be a full lowercase Git SHA');
  const entries: CensusPopulationEntry[] = [];
  const checkScripts = snapshot.paths.map(normalizePath).filter((path) => /^scripts\/check-.*\.ps1$/u.test(path)).sort();
  for (const path of checkScripts) entries.push({ id: `check-script:${path}`, sourceKind: 'check-script', sourcePath: path, marker: path.slice('scripts/'.length) });
  const verifyMembers = new Set(snapshot.verify.match(/scripts\/check-[A-Za-z0-9._-]+\.ps1/gu) ?? []);
  for (const path of [...verifyMembers].sort()) entries.push({ id: `verify-script:${path}`, sourceKind: 'verify-script-member', sourcePath: 'scripts/verify.ps1', marker: path });
  addInlineEntries(entries, snapshot.verify);
  for (const probe of CHECK_REUSABLE_BEHAVIOR_PROBES) {
    if (!snapshot.checkReusable.includes(probe.marker)) throw new Error(`pre-change check-reusable behavior is absent: ${probe.id}`);
    entries.push({ id: probe.id, sourceKind: 'check-reusable-behavior', sourcePath: 'scripts/check-reusable.ps1', marker: probe.marker });
  }
  entries.sort((left, right) => compareOrdinal(left.sourceKind, right.sourceKind) || compareOrdinal(left.id, right.id));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`generated duplicate census id: ${entry.id}`);
    ids.add(entry.id);
  }
  const counts: Record<CensusSourceKind, number> = { 'check-script': 0, 'verify-script-member': 0, 'verify-inline': 0, 'check-reusable-behavior': 0 };
  for (const entry of entries) counts[entry.sourceKind] += 1;
  return {
    baseCommitSha,
    sourceHashes: { 'scripts/verify.ps1': sha256(snapshot.verify), 'scripts/check-reusable.ps1': sha256(snapshot.checkReusable) },
    populationCount: entries.length,
    counts,
    populationDigest: populationDigest(entries),
    migrationOwnershipDigest: migrationOwnershipDigest(entries),
    entries,
  };
}

async function readBaseSnapshot(repoRoot: string, baseRef: string): Promise<PrechangeSourceSnapshot> {
  const listed = await runProcess({ command: 'git', args: ['ls-tree', '-r', '--name-only', baseRef, '--', 'scripts'], cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: false });
  if (!listed.ok) throw new Error(`cannot enumerate pre-change tree ${baseRef}: ${listed.stderr || listed.error || listed.outcome}`);
  const verify = await readGitFile(repoRoot, baseRef, 'scripts/verify.ps1');
  const checkReusable = await readGitFile(repoRoot, baseRef, 'scripts/check-reusable.ps1');
  if (verify === null || checkReusable === null) throw new Error(`cannot read census sources from pre-change tree ${baseRef}`);
  return { paths: listed.stdout.split(/\r?\n/u).filter(Boolean), verify, checkReusable };
}

async function exactCommit(repoRoot: string, candidate: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/u.test(candidate)) throw new Error('--current-head must be a full lowercase 40-hex SHA');
  const result = await runProcess({ command: 'git', args: ['rev-parse', '--verify', `${candidate}^{commit}`], cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: false });
  if (!result.ok) throw new Error(`cannot resolve current-head ${candidate}: ${result.stderr || result.error || result.outcome}`);
  const resolved = result.stdout.trim();
  if (resolved !== candidate) throw new Error(`current-head did not resolve exactly: requested=${candidate} resolved=${resolved}`);
  return resolved;
}

async function treeSnapshot(repoRoot: string, measuredHead: string): Promise<SourceSnapshot> {
  const listed = await runProcess({ command: 'git', args: ['ls-tree', '-r', '--name-only', measuredHead], cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: false });
  if (!listed.ok) throw new Error(`cannot enumerate measured tree ${measuredHead}: ${listed.stderr || listed.error || listed.outcome}`);
  const paths = listed.stdout.split(/\r?\n/u).filter(Boolean).map(normalizePath).sort(compareOrdinal);
  const files = new Map<string, string>();
  const unreadable = new Map<string, string>();
  for (const path of paths) {
    const text = await readGitFile(repoRoot, measuredHead, path);
    if (text === null) unreadable.set(path, 'not a readable regular blob at measuredHead');
    else files.set(path, text);
  }
  return { root: `<git:${measuredHead}>`, paths, files, unreadable };
}

async function readCensusAtHead(repoRoot: string, measuredHead: string): Promise<GateCensus> {
  const censusText = await readGitFile(repoRoot, measuredHead, 'scripts/gate-runner/census/pre-change-baseline.json');
  const generationText = await readGitFile(repoRoot, measuredHead, 'scripts/gate-runner/census/generation.json');
  if (censusText === null || generationText === null) throw new Error('frozen gate census inputs are missing at measuredHead');
  const census = JSON.parse(censusText) as Omit<GateCensus, 'generation'>;
  const generation = JSON.parse(generationText) as GateCensus['generation'];
  return { ...census, generation };
}

export async function generateCurrentHeadProjection(repoRoot: string, currentHead: string): Promise<CurrentHeadCensusProjection> {
  const measuredHead = await exactCommit(repoRoot, currentHead);
  const census = await readCensusAtHead(repoRoot, measuredHead);
  const { TERMINAL_CENSUS_CLASSIFICATIONS, validateCensusSchema } = await import('./census.ts');
  const { evaluateCurrentCensus } = await import('./current-census.ts');
  const schemaFailures = validateCensusSchema(census);
  if (schemaFailures.length > 0) throw new Error(`frozen gate census is invalid: ${schemaFailures.join('; ')}`);
  const frozenDigest = populationDigest(census.entries);
  if (frozenDigest !== census.generation.populationDigest) throw new Error(`frozen population digest mismatch: ${frozenDigest} != ${census.generation.populationDigest}`);
  const ids = new Set<string>();
  const terminal = new Set<string>(TERMINAL_CENSUS_CLASSIFICATIONS);
  for (const [index, entry] of census.entries.entries()) {
    if (ids.has(entry.id)) throw new Error(`duplicate frozen census id at index ${index}: ${entry.id}`);
    ids.add(entry.id);
    if (!terminal.has(entry.classification)) throw new Error(`non-terminal census classification for ${entry.id}: ${entry.classification}`);
  }
  const registeredGateIds = new Set<string>(['gate-census']);
  for (const entry of census.entries) for (const gateId of entry.gateIds ?? []) registeredGateIds.add(gateId);
  const result = evaluateCurrentCensus(census, await treeSnapshot(repoRoot, measuredHead), registeredGateIds);
  if (result.status !== 'PASS') throw new Error(`current-head gate census rejected: ${result.summary}; ${(result.details ?? []).join('; ')}`);
  return {
    version: 1,
    measuredHead,
    populationCount: census.entries.length,
    populationDigest: frozenDigest,
    entries: census.entries,
  };
}

export function serializeCurrentHeadProjection(projection: CurrentHeadCensusProjection): SerializedCurrentHeadCensus {
  const bytes = `${JSON.stringify(projection)}\n`;
  return { projection, bytes, outputDigest: sha256(bytes) };
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
  const repoRoot = resolve(argument(argv, '--repo-root') ?? resolve(import.meta.dirname, '../..'));
  const baseRef = argument(argv, '--base-ref');
  const currentHead = argument(argv, '--current-head');
  if (baseRef && currentHead) throw new Error('--base-ref and --current-head are mutually exclusive');
  if (currentHead) {
    const serialized = serializeCurrentHeadProjection(await generateCurrentHeadProjection(repoRoot, currentHead));
    process.stdout.write(serialized.bytes);
    return 0;
  }
  if (!baseRef) throw new Error('exactly one of --base-ref or --current-head is required');
  const baseline = generatePrechangePopulation(baseRef, await readBaseSnapshot(repoRoot, baseRef));
  process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
  return 0;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`[FAIL] gate-census-generate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
