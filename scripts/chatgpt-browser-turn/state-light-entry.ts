#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStableInput, type InputSnapshot } from './input.ts';
import { turnExitCode } from './contracts.ts';
import { configuredProfileKey } from './storage-common.ts';
import { runStateLightTurn } from './state-light-turn.ts';
import {
  assertCanonicalManagerReviewBrief,
  type ManagerReviewBriefContext,
} from '../lib/manager-review-brief.ts';
import { parseManagerReviewTerminalBundle } from '../lib/manager-review-terminal-bundle.ts';

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
  const base = {
    repositoryFullName: requiredCanonicalOption(argv, 'repository'),
    issueNumber: Number(issueNumberRaw),
    sourceRevision: requiredCanonicalOption(argv, 'source-revision'),
    stage: requiredCanonicalOption(argv, 'stage'),
    sourceSlot: requiredCanonicalOption(argv, 'source-slot'),
    invocationId: requiredCanonicalOption(argv, 'invocation-id'),
  };
  const terminalBundlePath = optionValue(argv, 'terminal-input-bundle');
  if (base.stage === 'architectural') {
    if (!terminalBundlePath) throw new Error('canonical_prompt_terminal_bundle_missing');
    const bundleSnapshot = readStableInput(terminalBundlePath);
    return {
      ...base,
      terminalBundle: parseManagerReviewTerminalBundle(bundleSnapshot.text, base),
    };
  }
  if (terminalBundlePath !== undefined) throw new Error('canonical_prompt_terminal_bundle_unexpected');
  return base;
}

function stripCanonicalContext(argv: readonly string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--stage' || token === '--source-slot' || token === '--terminal-input-bundle') {
      index++;
      continue;
    }
    stripped.push(token!);
  }
  return stripped;
}

function replaceInputPath(argv: readonly string[], inputPath: string): string[] {
  const rewritten = [...argv];
  const inputIndex = rewritten.indexOf('--input');
  if (inputIndex < 0 || inputIndex + 1 >= rewritten.length) {
    throw new Error('canonical_prompt_context_missing:input');
  }
  rewritten[inputIndex + 1] = inputPath;
  return rewritten;
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

function pinValidatedSnapshot(snapshot: InputSnapshot): { inputPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-input-'));
  const inputPath = join(root, 'prompt.txt');
  try {
    // The transport must never re-read caller-controlled bytes after canonical
    // admission. Materialize only the already-admitted snapshot into a private
    // one-shot input and keep it alive for the awaited transport invocation.
    writeFileSync(inputPath, snapshot.bytes, { flag: 'wx', mode: 0o400 });
  } catch (error) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
  return {
    inputPath,
    cleanup: () => {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

async function runCanonicalTurn(
  argv: readonly string[],
  runTurn: (argv: readonly string[]) => Promise<number>,
): Promise<number> {
  if (!directPublicationRequested(argv)) return await runTurn(argv);

  let snapshot: InputSnapshot;
  try {
    requiredCanonicalOption(argv, 'reviewer-source-output');
    requiredCanonicalOption(argv, 'reviewer-source');
    const inputPath = requiredCanonicalOption(argv, 'input');
    const context = canonicalContext(argv);
    snapshot = readStableInput(inputPath);
    assertCanonicalManagerReviewBrief(snapshot.text, context);
  } catch (error) {
    return emitCanonicalRefusal(argv, canonicalCause(error));
  }

  let pinned: ReturnType<typeof pinValidatedSnapshot>;
  try {
    pinned = pinValidatedSnapshot(snapshot);
  } catch {
    return emitCanonicalRefusal(argv, 'canonical_prompt_input_snapshot_unavailable');
  }

  try {
    return await runTurn(replaceInputPath(stripCanonicalContext(argv), pinned.inputPath));
  } finally {
    pinned.cleanup();
  }
}

export async function runStateLightEntry(
  argv: readonly string[],
  dependencies: StateLightEntryDependencies = {},
): Promise<number> {
  const [command, ...turnArgs] = argv;
  const runTurn = dependencies.runTurn ?? ((turnArgv: readonly string[]) =>
    runStateLightTurn(turnArgv, { entryLivenessHeartbeat: true }));

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
