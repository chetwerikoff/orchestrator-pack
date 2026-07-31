#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runGhJsonCommand } from './lib/gh-signal-classifier.ts';

export interface IssueBodyRecord {
  number: number;
  body?: string | null;
  pull_request?: unknown;
}

export interface AuthoredIssue {
  number: number;
  behaviorKind: 'record-only' | 'action-producing';
  claimedTier: 'T1' | 'T2' | 'T3' | null;
}

export interface DistributionResult {
  selected: AuthoredIssue[];
  claimedT3: number;
  claimedT3Share: number;
  recordOnlyAtT3: number;
  alarms: string[];
}

const BEHAVIOR_RE = /```behavior-kind\s*\n\s*(record-only|action-producing)\s*\n```/i;
const TIER_FENCE_RE = /```complexity-tier\s*\n([\s\S]*?)```/i;

export function classifyAuthoredIssue(issue: IssueBodyRecord): AuthoredIssue | null {
  if (issue.pull_request !== undefined || !Number.isInteger(issue.number) || typeof issue.body !== 'string') return null;
  const behavior = issue.body.match(BEHAVIOR_RE)?.[1]?.toLowerCase();
  const fence = issue.body.match(TIER_FENCE_RE)?.[1];
  if ((behavior !== 'record-only' && behavior !== 'action-producing') || !fence) return null;
  if (/^\s*skip-line\s*:\s*(?:true|yes|1)\s*$/im.test(fence)) {
    return { number: issue.number, behaviorKind: behavior, claimedTier: null };
  }
  const tier = fence.match(/^\s*tier\s*:\s*(T1|T2|T3)\s*$/im)?.[1]?.toUpperCase();
  if (tier !== 'T1' && tier !== 'T2' && tier !== 'T3') return null;
  return { number: issue.number, behaviorKind: behavior, claimedTier: tier };
}

export function analyzeDistribution(issues: readonly IssueBodyRecord[], sampleSize = 30): DistributionResult {
  const authored = issues
    .map(classifyAuthoredIssue)
    .filter((issue): issue is AuthoredIssue => issue !== null)
    .sort((left, right) => right.number - left.number);
  const unique: AuthoredIssue[] = [];
  const seen = new Set<number>();
  let duplicate = false;
  for (const issue of authored) {
    if (seen.has(issue.number)) {
      duplicate = true;
      continue;
    }
    seen.add(issue.number);
    if (unique.length < sampleSize) unique.push(issue);
  }
  const selected = unique.sort((left, right) => left.number - right.number);
  const claimedT3 = selected.filter((issue) => issue.claimedTier === 'T3').length;
  const recordOnlyAtT3 = selected.filter((issue) => issue.claimedTier === 'T3' && issue.behaviorKind === 'record-only').length;
  const share = selected.length === 0 ? 0 : claimedT3 / selected.length;
  const alarms: string[] = [];
  if (duplicate || selected.length < sampleSize) alarms.push('incomplete-or-ambiguous-window');
  if (share > 0.70) alarms.push('claimed-T3-above-70-percent');
  if (recordOnlyAtT3 > 0) alarms.push('record-only-at-T3');
  return { selected, claimedT3, claimedT3Share: share, recordOnlyAtT3, alarms };
}

export function formatDistribution(result: DistributionResult): string {
  const first = result.selected[0]?.number ?? 'none';
  const last = result.selected.at(-1)?.number ?? 'none';
  const percent = (result.claimedT3Share * 100).toFixed(0);
  return [
    `tiering distribution: sample=${result.selected.length} range=${first}-${last}`,
    `tiering distribution: claimed-T3=${result.claimedT3}/${result.selected.length} (${percent}%)`,
    `tiering distribution: record-only-at-T3=${result.recordOnlyAtT3}`,
    `tiering distribution: body-observed tier deltas=unverified-diagnostic (not evaluated)`,
    `tiering distribution: alarms=${result.alarms.length ? result.alarms.join(',') : 'none'}`,
  ].join('\n');
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function loadIssues(argv: readonly string[]): IssueBodyRecord[] {
  const fixture = option(argv, '--fixture');
  if (fixture) return JSON.parse(readFileSync(resolve(fixture), 'utf8')) as IssueBodyRecord[];
  const repo = option(argv, '--repo');
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('--repo owner/name is required without --fixture');
  const result = runGhJsonCommand({
    command: resolve('scripts/gh'),
    args: ['api', `repos/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`, '--paginate'],
    expectedRoot: 'array',
  });
  if (!result.ok || !Array.isArray(result.value)) throw new Error(`GitHub Issue read failed: ${result.reason}`);
  return result.value as IssueBodyRecord[];
}

export function runDistributionCli(argv: readonly string[]): number {
  const result = analyzeDistribution(loadIssues(argv));
  process.stdout.write(`${formatDistribution(result)}\n`);
  return result.alarms.length === 0 ? 0 : 1;
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  try { process.exit(runDistributionCli(process.argv.slice(2))); }
  catch (error) {
    process.stderr.write(`tiering distribution: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
