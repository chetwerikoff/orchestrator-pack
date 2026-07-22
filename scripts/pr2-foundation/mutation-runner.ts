import '../toolchain/native-entrypoint-preflight.ts';

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../kernel/subprocess.ts';
import {
  FOUNDATION_MUTATION_CATALOG,
  type MutationBinding,
} from './mutation-catalog.ts';
import type { AcceptanceId } from './contracts.ts';
import { buildBehavioralMutation } from './mutation-behavior-recipes.ts';

export interface MutationRunnerEvidence {
  ac: AcceptanceId;
  mutationId: string;
  artifactPath: string;
  executed: true;
  artifactHashBefore: string;
  artifactHashAfter: string;
  failingTestId: string;
  negativeOutcome: 'failed';
  restoredHash: string;
  restoredOutcome: 'passed';
  affectedOccurrences: number;
}

interface ArtifactSnapshot {
  existed: boolean;
  bytes: Buffer;
  mode: number;
}

function digest(value: Buffer | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function artifactDigest(file: string): string {
  return existsSync(file) ? digest(readFileSync(file)) : 'sha256:absent';
}

function snapshotArtifact(file: string): ArtifactSnapshot {
  if (!existsSync(file)) return { existed: false, bytes: Buffer.alloc(0), mode: 0o600 };
  return {
    existed: true,
    bytes: readFileSync(file),
    mode: statSync(file).mode & 0o777,
  };
}

function atomicReplace(file: string, content: Buffer | string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, file);
  chmodSync(file, mode);
}

function applyMutation(binding: MutationBinding, file: string, snapshot: ArtifactSnapshot): number {
  const key = `${binding.ac}:${binding.mutationId}`;
  const source = snapshot.existed ? snapshot.bytes.toString('utf8') : null;
  const mutation = buildBehavioralMutation(key, source);
  if (mutation.artifactPath !== binding.artifactPath) {
    throw new Error(`mutation_artifact_mismatch:${key}:${mutation.artifactPath}:${binding.artifactPath}`);
  }
  if (binding.strategy === 'create' && mutation.kind !== 'create') {
    throw new Error(`mutation_strategy_mismatch:${key}:create:${mutation.kind}`);
  }
  if (binding.strategy === 'bounded-semantic' && mutation.kind === 'create') {
    throw new Error(`mutation_strategy_mismatch:${key}:bounded-semantic:create`);
  }
  if (mutation.kind === 'create') {
    if (snapshot.existed) throw new Error(`mutation_create_target_exists:${key}`);
    atomicReplace(file, mutation.content, 0o600);
  } else {
    if (!snapshot.existed) throw new Error(`mutation_target_missing:${key}`);
    atomicReplace(file, mutation.content, snapshot.mode);
  }
  return mutation.affectedOccurrences;
}

function restoreArtifact(file: string, snapshot: ArtifactSnapshot): void {
  if (!snapshot.existed) {
    rmSync(file, { force: true });
    return;
  }
  atomicReplace(file, snapshot.bytes, snapshot.mode);
}

async function invokeChecker(
  binding: MutationBinding,
): Promise<Awaited<ReturnType<typeof runProcess>>> {
  return runProcess({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      resolve('scripts/pr2-foundation/mutation-semantic-check.ts'),
      '--key',
      `${binding.ac}:${binding.mutationId}`,
    ],
    cwd: resolve('.'),
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 180_000,
  });
}

export async function runBoundMutation(
  binding: MutationBinding,
): Promise<MutationRunnerEvidence> {
  const artifactPath = resolve(binding.artifactPath);
  const snapshot = snapshotArtifact(artifactPath);
  const artifactHashBefore = snapshot.existed ? digest(snapshot.bytes) : 'sha256:absent';
  const clean = await invokeChecker(binding);
  if (!clean.ok || !clean.stdout.includes(binding.failingTestId)) {
    throw new Error(`mutation_precondition_failed:${binding.failingTestId}:${clean.stderr || clean.stdout}`);
  }

  const affectedOccurrences = applyMutation(binding, artifactPath, snapshot);
  const artifactHashAfter = artifactDigest(artifactPath);
  if (artifactHashAfter === artifactHashBefore) {
    restoreArtifact(artifactPath, snapshot);
    throw new Error(`artifact_hash_delta_missing:${binding.failingTestId}`);
  }

  try {
    const negative = await invokeChecker(binding);
    const negativeText = `${negative.stdout}\n${negative.stderr}`;
    if (negative.ok || !negativeText.includes(binding.failingTestId)) {
      throw new Error(`specific_failing_test_not_observed:${binding.failingTestId}`);
    }
  } finally {
    restoreArtifact(artifactPath, snapshot);
  }

  const restoredHash = artifactDigest(artifactPath);
  if (restoredHash !== artifactHashBefore) {
    throw new Error(`restore_hash_mismatch:${binding.failingTestId}`);
  }
  const restored = await invokeChecker(binding);
  if (!restored.ok || !restored.stdout.includes(binding.failingTestId)) {
    throw new Error(`restored_verification_failed:${binding.failingTestId}`);
  }

  return {
    ac: binding.ac,
    mutationId: binding.mutationId,
    artifactPath: binding.artifactPath,
    executed: true,
    artifactHashBefore,
    artifactHashAfter,
    failingTestId: binding.failingTestId,
    negativeOutcome: 'failed',
    restoredHash,
    restoredOutcome: 'passed',
    affectedOccurrences,
  };
}

function selectedBindings(argv: string[]): readonly MutationBinding[] {
  const acIndex = argv.indexOf('--ac');
  if (acIndex >= 0) {
    const ac = String(argv[acIndex + 1] ?? '') as AcceptanceId;
    const selected = FOUNDATION_MUTATION_CATALOG.filter((entry) => entry.ac === ac);
    if (selected.length === 0) throw new Error(`invalid_ac:${ac}`);
    return selected;
  }
  if (argv.includes('--all')) return FOUNDATION_MUTATION_CATALOG;
  throw new Error('usage: mutation-runner.ts --ac AC1|...|AC9 or --all');
}

async function main(): Promise<void> {
  const bindings = selectedBindings(process.argv.slice(2));
  const evidence: MutationRunnerEvidence[] = [];
  for (const binding of bindings) {
    evidence.push(await runBoundMutation(binding));
  }
  process.stdout.write(`${JSON.stringify({
    mutationEvidence: evidence,
    mutationRunner: { result: 'externally-grounded' },
  })}\n`);
}

function isDirectExecution(): boolean {
  const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return argvPath === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
