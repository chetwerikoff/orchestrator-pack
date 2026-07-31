#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProcessSync } from './kernel/subprocess.ts';

export interface CalibrationRow {
  issue: string;
  claimed: string;
  opus: string;
  codex: string;
  consensus: string;
}

export const FROZEN_BASELINE_SIZE = 30;
export const FROZEN_BASELINE_DIGEST = '89d3804e53772e27a54bcaffa366558f7fdc2721cddfbd4f39ca0f46edf04e5d';
export const MAX_DEFINITE_HONEST_T3 = 16;

const ROW_RE = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm;

export function parseCalibrationRows(markdown: string): CalibrationRow[] {
  const rows: CalibrationRow[] = [];
  for (const match of markdown.matchAll(ROW_RE)) {
    const issue = match[1];
    const claimed = match[2]?.trim();
    const opus = match[3]?.trim();
    const codex = match[4]?.trim();
    const consensus = match[5]?.trim();
    if (!issue || !claimed || !opus || !codex || !consensus) continue;
    rows.push({ issue, claimed, opus, codex, consensus });
  }
  return rows;
}

export function serializeCalibrationRows(rows: readonly CalibrationRow[]): string {
  return rows.map((row) => JSON.stringify([row.issue, row.claimed, row.opus, row.codex, row.consensus])).join('\n') + '\n';
}

export function validateCalibration(candidateText: string, baseText?: string): string[] {
  const errors: string[] = [];
  const candidate = parseCalibrationRows(candidateText);
  if (candidate.length < FROZEN_BASELINE_SIZE) {
    errors.push(`tiering calibration: expected at least ${FROZEN_BASELINE_SIZE} rows, found ${candidate.length}`);
    return errors;
  }
  const issues = candidate.map((row) => row.issue);
  if (new Set(issues).size !== issues.length) errors.push('tiering calibration: duplicate Issue row');

  const frozen = candidate.slice(0, FROZEN_BASELINE_SIZE);
  const digest = createHash('sha256').update(serializeCalibrationRows(frozen), 'utf8').digest('hex');
  if (digest !== FROZEN_BASELINE_DIGEST) {
    errors.push(`tiering calibration: frozen baseline digest mismatch (${digest})`);
  }
  const honestT3 = frozen.filter((row) => row.consensus === 'T3').length;
  if (honestT3 > MAX_DEFINITE_HONEST_T3) {
    errors.push(`tiering calibration: definite honest-T3 count ${honestT3} exceeds ${MAX_DEFINITE_HONEST_T3}`);
  }

  for (const row of frozen) {
    if (row.consensus.startsWith('DISPUTED') && (!row.opus || !row.codex)) {
      errors.push(`tiering calibration: disputed row ${row.issue} lost an engine verdict`);
    }
  }

  if (baseText !== undefined) {
    const base = parseCalibrationRows(baseText);
    if (base.length > candidate.length) errors.push('tiering calibration: candidate removed base rows');
    for (let index = 0; index < base.length && index < candidate.length; index += 1) {
      if (JSON.stringify(base[index]) !== JSON.stringify(candidate[index])) {
        errors.push(`tiering calibration: base row sequence is not an exact prefix at index ${index}`);
        break;
      }
    }
  }
  return errors;
}

function describeGitFailure(stderr: string, error?: string): string {
  return stderr.trim() || error || 'unknown git failure';
}

function readBaseDocument(ref: string, path: string): string | undefined {
  const verify = runProcessSync({
    command: 'git',
    args: ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    inheritParentEnv: true,
  });
  if (!verify.ok) {
    throw new Error(`unable to resolve supplied base ref ${ref}: ${describeGitFailure(verify.stderr, verify.error)}`);
  }

  const listing = runProcessSync({
    command: 'git',
    args: ['ls-tree', '--name-only', ref, '--', path],
    inheritParentEnv: true,
  });
  if (!listing.ok) {
    throw new Error(`unable to inspect ${path} at base ref ${ref}: ${describeGitFailure(listing.stderr, listing.error)}`);
  }
  if (listing.stdout.trim() === '') return undefined;

  const content = runProcessSync({
    command: 'git',
    args: ['show', `${ref}:${path}`],
    inheritParentEnv: true,
  });
  if (!content.ok) {
    throw new Error(`unable to read ${path} at base ref ${ref}: ${describeGitFailure(content.stderr, content.error)}`);
  }
  return content.stdout;
}

export function runCalibrationCli(argv: readonly string[]): number {
  const pathIndex = argv.indexOf('--file');
  const file = resolve(pathIndex >= 0 ? argv[pathIndex + 1] ?? '' : 'docs/tiering-calibration.md');
  const candidate = readFileSync(file, 'utf8');
  const baseIndex = argv.indexOf('--base-ref');
  const baseRef = baseIndex >= 0 ? argv[baseIndex + 1] : process.env.PR_BASE_SHA;
  let base: string | undefined;
  try {
    base = baseRef ? readBaseDocument(baseRef, 'docs/tiering-calibration.md') : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tiering calibration: ${message}\n`);
    return 1;
  }
  const errors = validateCalibration(candidate, base);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    return 1;
  }
  process.stdout.write(`tiering calibration: PASS rows=${parseCalibrationRows(candidate).length} digest=${FROZEN_BASELINE_DIGEST}\n`);
  return 0;
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  process.exit(runCalibrationCli(process.argv.slice(2)));
}
