#!/usr/bin/env -S node --experimental-strip-types

import '../toolchain/native-entrypoint-preflight.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGptPackReview } from './pack-gpt-reviewer.ts';
import { readClaimRecord, updateReviewStartClaimRecordFields } from './review-start-claim-store.ts';
import { updatePackReviewStageClaimFields } from './pack-review-stage-claim.ts';

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function parseArgs(argv: string[]): {
  repoRoot: string;
  repoSlug: string;
  prNumber: number;
  headSha: string;
  claimPath: string;
  workDir: string;
  surface: string;
} {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith('--')) continue;
    values[flag.slice(2)] = argv[++index] ?? '';
  }
  return {
    repoRoot: values['repo-root'] || process.cwd(),
    repoSlug: values['repo-slug'] || '',
    prNumber: Number(values['pr-number']),
    headSha: trim(values['head-sha']).toLowerCase(),
    claimPath: values['claim-path'] || '',
    workDir: values['work-dir'] || '',
    surface: values.surface || 'pack-review-launcher-worker',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const claimRead = readClaimRecord(args.claimPath);
  if (!claimRead.ok || !claimRead.record) {
    process.exit(2);
  }
  const claim = {
    acquired: true,
    claim: claimRead.record,
    path: args.claimPath,
    namespace: claimRead.record.projectNamespace,
    key: claimRead.record.key,
  };
  updatePackReviewStageClaimFields(claim, {
    turnState: 'live',
    childPid: process.pid,
    workDir: args.workDir,
  });

  const replyPath = join(args.workDir, 'reply.txt');
  const result = await runGptPackReview({
    repoRoot: args.repoRoot,
    repoSlug: args.repoSlug,
    prNumber: args.prNumber,
    headSha: args.headSha,
  });

  const statusPath = join(args.workDir, 'worker-result.json');
  writeFileSync(statusPath, JSON.stringify({
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdoutLength: result.stdout.length,
    completedAtUtc: new Date().toISOString(),
  }), 'utf8');

  if (result.exitCode === 0 && result.stdout) {
    writeFileSync(replyPath, result.stdout, 'utf8');
    updatePackReviewStageClaimFields(claim, {
      turnState: 'completed',
      replyPath,
      childPid: process.pid,
      workDir: args.workDir,
    });
    process.exit(0);
  }

  if (result.exitCode === 10) {
    updatePackReviewStageClaimFields(claim, {
      turnState: 'possible_delivery',
      workDir: args.workDir,
      childPid: process.pid,
    });
    process.exit(result.exitCode);
  }

  updateReviewStartClaimRecordFields(claim, {
    turnState: 'possible_delivery',
    lastFailure: trim(result.stderr || result.stdout),
  });
  process.exit(result.exitCode || 1);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
