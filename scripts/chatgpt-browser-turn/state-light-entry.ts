#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStateLightTurn } from './state-light-turn.ts';

export type StateLightEntryDependencies = {
  readonly runTurn?: (argv: readonly string[]) => Promise<number>;
};

export async function runStateLightEntry(
  argv: readonly string[],
  dependencies: StateLightEntryDependencies = {},
): Promise<number> {
  const [command, ...turnArgs] = argv;
  const runTurn = dependencies.runTurn ?? runStateLightTurn;

  if (command === 'turn') {
    return await runTurn(turnArgs);
  } else if (command === 'session') {
    const { runStateLightSession } = await import('./state-light-session.ts');
    return await runStateLightSession(turnArgs);
  } else if (command?.startsWith('--')) {
    // Accept the simplified direct turn shape for new callers as well.
    return await runTurn(argv);
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
