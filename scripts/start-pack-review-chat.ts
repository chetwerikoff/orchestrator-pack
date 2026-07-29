#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { launchPackReviewChat } from './lib/pack-review-launcher.ts';

function usage(): string {
  return [
    'Usage: start-pack-review-chat.ts <pr-number> [--head-sha <full-sha>] [--json]',
    '',
    'Canonical worker command to start or adopt a Browser-GPT pack review for an open PR.',
    'Resolves the current head before claim/send. Exit failure is not resend permission.',
  ].join('\n');
}

function parseArgs(argv: string[]): { prNumber: number; headSha?: string; json: boolean } {
  let prNumber = 0;
  let headSha: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--head-sha') {
      headSha = String(argv[++index] ?? '').trim().toLowerCase();
      continue;
    }
    if (!prNumber) {
      prNumber = Number(arg);
    }
  }
  return { prNumber, headSha, json };
}

async function main(): Promise<void> {
  const { prNumber, headSha, json } = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`missing or invalid PR number\n${usage()}`);
  }
  const result = await launchPackReviewChat({
    repoRoot: process.cwd(),
    prNumber,
    headSha,
    caller: 'worker',
    observation: 'A1',
  });
  const payload = `${JSON.stringify(result)}\n`;
  if (json) {
    process.stdout.write(payload);
  } else {
    process.stdout.write(payload);
  }
  if (result.disposition === 'pre_claim_error' || result.disposition === 'recovery_required' || result.disposition === 'ambiguous_claim') {
    process.exit(1);
  }
  process.exit(0);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
