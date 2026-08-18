#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStableInput } from './input.ts';
import { turnExitCode } from './contracts.ts';
import { configuredProfileKey } from './storage-common.ts';
import { runStateLightTurn } from './state-light-turn.ts';
import {
  assertCanonicalManagerReviewBrief,
  type ManagerReviewBriefContext,
} from '../lib/manager-review-brief.ts';

export type StateLightEntryDependencies = {
  readonly runTurn?: (argv: readonly string[]) => Promise<number>;
};

const DIRECT_KEYS = [
  'reviewer-source-output',
  'reviewer-source',
  'repository',
  'issue-number',
  'source-revision',
  'stage',
  'source-slot',
] as const;

function optionValue(argv: readonly string[], key: string): string | undefined {
  const flag = `--${key}`;
  let found: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || found !== undefined) return undefined;
    found = value;
  }
  return found;
}

function directPublicationRequested(argv: readonly string[]): boolean {
  return DIRECT_KEYS.some((key) => argv.includes(`--${key}`));
}

function requiredCanonicalOption(argv: readonly string[], key: string): string {
  const value = optionValue(argv, key);
  if (!value) throw new Error(`canonical_prompt_context_missing:${key.replaceAll('-', '_')}`);
  return value;
}

function canonicalContext(argv: readonly string[]): ManagerReviewBriefContext {
  const issueNumberRaw = requiredCanonicalOption(argv, 'issue-number');
  if (!/^[1-9][0-9]*$/.test(issueNumberRaw)) {
    throw new Error('canonical_prompt_context_invalid:issue_number');
  }
  return {
    repositoryFullName: requiredCanonicalOption(argv, 'repository'),
    issueNumber: Number(issueNumberRaw),
    sourceRevision: requiredCanonicalOption(argv, 'source-revision'),
    stage: requiredCanonicalOption(argv, 'stage'),
    sourceSlot: requiredCanonicalOption(argv, 'source-slot'),
    invocationId: requiredCanonicalOption(argv, 'invocation-id'),
  };
}

function stripCanonicalContext(argv: readonly string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--stage' || token === '--source-slot') {
      index++;
      continue;
    }
    stripped.push(token!);
  }
  return stripped;
}

function rejectionProfileKey(argv: readonly string[]): string {
  const profile = optionValue(argv, 'profile');
  const cdp = optionValue(argv, 'cdp');
  if (!profile || !cdp) return 'profile-unresolved';
  try {
    return configuredProfileKey(profile, cdp);
  } catch {
    return 'profile-unresolved';
  }
}

function canonicalCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('canonical_prompt_')) return message;
  if (message.startsWith('input_invalid:')) {
    return `canonical_prompt_input_${message.slice('input_invalid:'.length)}`;
  }
  return 'canonical_prompt_source_unavailable';
}

function emitCanonicalRefusal(argv: readonly string[], cause: string): number {
  process.stdout.write(`${JSON.stringify({
    schema: 'turn-result/v1',
    state: 'input_invalid',
    scope: 'invocation',
    cause,
    invocation_id: optionValue(argv, 'invocation-id') ?? '',
    configured_profile_key: rejectionProfileKey(argv),
    send_count: 0,
    poll_count: 0,
    goto_count: 0,
    new_chat_click_count: 0,
    navigation_count: 0,
    cleanup: 'skipped',
    incidents: [],
  })}\n`);
  return turnExitCode('input_invalid');
}

async function runCanonicalTurn(
  argv: readonly string[],
  runTurn: (argv: readonly string[]) => Promise<number>,
): Promise<number> {
  if (!directPublicationRequested(argv)) return await runTurn(argv);

  try {
    requiredCanonicalOption(argv, 'reviewer-source-output');
    requiredCanonicalOption(argv, 'reviewer-source');
    const inputPath = requiredCanonicalOption(argv, 'input');
    const context = canonicalContext(argv);
    const snapshot = readStableInput(inputPath);
    assertCanonicalManagerReviewBrief(snapshot.text, context);
  } catch (error) {
    return emitCanonicalRefusal(argv, canonicalCause(error));
  }

  return await runTurn(stripCanonicalContext(argv));
}

export async function runStateLightEntry(
  argv: readonly string[],
  dependencies: StateLightEntryDependencies = {},
): Promise<number> {
  const [command, ...turnArgs] = argv;
  const runTurn = dependencies.runTurn ?? runStateLightTurn;

  if (command === 'turn') {
    return await runCanonicalTurn(turnArgs, runTurn);
  } else if (command === 'session') {
    const { runStateLightSession } = await import('./state-light-session.ts');
    return await runStateLightSession(turnArgs);
  } else if (command?.startsWith('--')) {
    // Accept the simplified direct turn shape for new callers as well.
    return await runCanonicalTurn(argv, runTurn);
  } else {
    // Legacy control verbs remain available for diagnostics/rollback compatibility,
    // but create/review progression must not use them as admission/completion gates.
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    return await runCli(argv);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runStateLightEntry(process.argv.slice(2));
}
