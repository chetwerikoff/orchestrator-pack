#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ParkedMigrationManifest } from './create-issue-parked-migration.ts';
import { sha256 } from './lib/create-issue-stage-topology.ts';

export const PARKED_1173_REVIEW_ROOT = join(
  homedir(),
  '.local',
  'state',
  'create-issue-draft',
  '.review',
  '1173',
);
export const PARKED_1173_MANIFEST_PATH = join(
  process.cwd(),
  'scripts',
  'fixtures',
  'create-issue-parked-migration-1173.json',
);

export interface CompilerInput {
  reviewRoot?: string;
  outputPath?: string;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function compile1173(input: CompilerInput = {}): ParkedMigrationManifest {
  const root = input.reviewRoot ?? PARKED_1173_REVIEW_ROOT;
  const outputPath = input.outputPath ?? PARKED_1173_MANIFEST_PATH;
  if (root !== PARKED_1173_REVIEW_ROOT) throw new Error('compiler root is fixed to the operator review root');
  if (!existsSync(root)) throw new Error(`fixed Issue-1173 review root is unavailable: ${root}`);
  const sourceComments = [5152880935, 5152950548].map((id) => {
    const path = join(root, `comment-${id}.json`);
    if (!existsSync(path)) throw new Error(`missing fixed Issue-1173 comment input: ${path}`);
    const parsed = readJson(path) as { body?: unknown };
    if (typeof parsed.body !== 'string') throw new Error(`invalid fixed Issue-1173 comment input: ${path}`);
    const bytes = Buffer.from(parsed.body, 'utf8');
    return { id, body: parsed.body, byteLength: bytes.byteLength, sha256: sha256(bytes) };
  });
  const manifest: ParkedMigrationManifest = {
    schema: 'create-issue-parked-review-import/v1',
    issueNumber: 1173,
    sourceRevision: 'r01',
    migrationKind: 'legacy-cycle-settled',
    pinnedComments: sourceComments,
    dependency: '#1186',
    closure: 'completed-cycle-status;final-acceptance-outstanding',
    compiledAt: new Date().toISOString(),
  };
  mkdirSync(join(process.cwd(), 'scripts', 'fixtures'), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, outputPath);
  return manifest;
}

function main(): void {
  try {
    compile1173();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

