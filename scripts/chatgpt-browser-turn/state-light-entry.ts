#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStateLightTurn } from './state-light-turn.ts';
import { settleCliMain } from './cli-main.ts';

export type StateLightEntryDependencies = {
  readonly runTurn?: typeof runStateLightTurn;
};

export async function runStateLightEntry(
  argv: readonly string[],
  deps: StateLightEntryDependencies = {},
): Promise<number> {
  const [command, ...turnArgs] = argv;
  const runTurn = deps.runTurn ?? runStateLightTurn;
  const turnOptions = { entryLivenessHeartbeat: true, recordChatBinding: true } as const;
  if (command === 'turn') return runTurn(turnArgs, turnOptions);
  if (command === 'session') {
    const { runStateLightSession } = await import('./state-light-session.ts');
    return runStateLightSession(turnArgs);
  }
  if (command?.startsWith('--')) return runTurn(argv, turnOptions);
  const { runCli } = await import('../chatgpt-browser-turn.ts');
  return runCli(argv);
}

async function main(): Promise<void> {
  process.exitCode = await runStateLightEntry(process.argv.slice(2));
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entryPath) {
  settleCliMain(main);
}
