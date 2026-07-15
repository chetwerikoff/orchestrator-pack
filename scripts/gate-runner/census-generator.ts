import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isDirectExecution, readGitFile } from '#opk-toolchain/baseline-io';
import { runProcess } from '#opk-kernel/subprocess';
import type { CensusSourceKind } from './census.ts';

export interface CensusPopulationEntry {
  readonly id: string;
  readonly sourceKind: CensusSourceKind;
  readonly sourcePath: string;
  readonly marker: string;
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
  readonly entries: readonly CensusPopulationEntry[];
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
    entries.push({
      id: `verify-inline:command-version:${command}`,
      sourceKind: 'verify-inline',
      sourcePath: 'scripts/verify.ps1',
      marker: command,
    });
  }

  for (const match of verify.matchAll(/Test-ContractMarkers\s+'([^']+)'/gu)) {
    const path = match[1];
    if (!path) continue;
    entries.push({
      id: `verify-inline:contract-marker:${path}`,
      sourceKind: 'verify-inline',
      sourcePath: 'scripts/verify.ps1',
      marker: `Test-ContractMarkers '${path}'`,
    });
  }

  for (const match of verify.matchAll(/Write-Check\s+'([^']+)'/gu)) {
    const name = match[1];
    if (!name || /^scripts\/check-.*\.ps1(?:\s+-SelfTest)?$/u.test(name) || name === 'gate-runner/core') continue;
    entries.push({
      id: `verify-inline:write-check:${name}`,
      sourceKind: 'verify-inline',
      sourcePath: 'scripts/verify.ps1',
      marker: name,
    });
  }

  const requiredBlock = /\$requiredFiles\s*=\s*@\(([\s\S]*?)\)\s*foreach\s*\(\$file/gu.exec(verify)?.[1] ?? '';
  for (const match of requiredBlock.matchAll(/'([^']+)'/gu)) {
    const path = match[1];
    if (!path) continue;
    entries.push({
      id: `verify-inline:required-file:${path}`,
      sourceKind: 'verify-inline',
      sourcePath: 'scripts/verify.ps1',
      marker: path,
    });
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

export function generatePrechangePopulation(
  baseCommitSha: string,
  snapshot: PrechangeSourceSnapshot,
): GeneratedPopulationBaseline {
  if (!/^[0-9a-f]{40}$/u.test(baseCommitSha)) throw new Error('baseCommitSha must be a full lowercase Git SHA');

  const entries: CensusPopulationEntry[] = [];
  const checkScripts = snapshot.paths
    .map(normalizePath)
    .filter((path) => /^scripts\/check-.*\.ps1$/u.test(path))
    .sort();
  for (const path of checkScripts) {
    entries.push({
      id: `check-script:${path}`,
      sourceKind: 'check-script',
      sourcePath: path,
      marker: path.slice('scripts/'.length),
    });
  }

  const verifyMembers = new Set(snapshot.verify.match(/scripts\/check-[A-Za-z0-9._-]+\.ps1/gu) ?? []);
  for (const path of [...verifyMembers].sort()) {
    entries.push({
      id: `verify-script:${path}`,
      sourceKind: 'verify-script-member',
      sourcePath: 'scripts/verify.ps1',
      marker: path,
    });
  }
  addInlineEntries(entries, snapshot.verify);

  for (const probe of CHECK_REUSABLE_BEHAVIOR_PROBES) {
    if (!snapshot.checkReusable.includes(probe.marker)) {
      throw new Error(`pre-change check-reusable behavior is absent: ${probe.id}`);
    }
    entries.push({
      id: probe.id,
      sourceKind: 'check-reusable-behavior',
      sourcePath: 'scripts/check-reusable.ps1',
      marker: probe.marker,
    });
  }

  entries.sort((left, right) => compareOrdinal(left.sourceKind, right.sourceKind) || compareOrdinal(left.id, right.id));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`generated duplicate census id: ${entry.id}`);
    ids.add(entry.id);
  }

  const counts: Record<CensusSourceKind, number> = {
    'check-script': 0,
    'verify-script-member': 0,
    'verify-inline': 0,
    'check-reusable-behavior': 0,
  };
  for (const entry of entries) counts[entry.sourceKind] += 1;

  return {
    baseCommitSha,
    sourceHashes: {
      'scripts/verify.ps1': sha256(snapshot.verify),
      'scripts/check-reusable.ps1': sha256(snapshot.checkReusable),
    },
    populationCount: entries.length,
    counts,
    populationDigest: populationDigest(entries),
    entries,
  };
}

async function readBaseSnapshot(repoRoot: string, baseRef: string): Promise<PrechangeSourceSnapshot> {
  const listed = await runProcess({
    command: 'git',
    args: ['ls-tree', '-r', '--name-only', baseRef, '--', 'scripts'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
  });
  if (!listed.ok) throw new Error(`cannot enumerate pre-change tree ${baseRef}: ${listed.stderr || listed.error || listed.outcome}`);

  const verify = await readGitFile(repoRoot, baseRef, 'scripts/verify.ps1');
  const checkReusable = await readGitFile(repoRoot, baseRef, 'scripts/check-reusable.ps1');
  if (verify === null || checkReusable === null) throw new Error(`cannot read census sources from pre-change tree ${baseRef}`);
  return {
    paths: listed.stdout.split(/\r?\n/u).filter(Boolean),
    verify,
    checkReusable,
  };
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
  const repoRoot = resolve(argument(argv, '--repo-root') ?? resolve(import.meta.dirname, '../..'));
  const baseRef = argument(argv, '--base-ref');
  if (!baseRef) throw new Error('--base-ref is required and must identify the pre-change tree');
  const baseline = generatePrechangePopulation(baseRef, await readBaseSnapshot(repoRoot, baseRef));
  process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
  return 0;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
