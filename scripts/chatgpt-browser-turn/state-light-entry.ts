#!/usr/bin/env node
import { runStateLightTurn } from './state-light-turn.ts';

const argv = process.argv.slice(2);
const [command, ...turnArgs] = argv;

if (command === 'turn') {
  process.exitCode = await runStateLightTurn(turnArgs);
} else if (command === 'session') {
  const { runStateLightSession } = await import('./state-light-session.ts');
  process.exitCode = await runStateLightSession(turnArgs);
} else if (command?.startsWith('--')) {
  // Accept the simplified direct turn shape for new callers as well.
  process.exitCode = await runStateLightTurn(argv);
} else {
  // Legacy control verbs remain available for diagnostics/rollback compatibility,
  // but create/review progression must not use them as admission/completion gates.
  const { runCli } = await import('../chatgpt-browser-turn.ts');
  process.exitCode = await runCli(argv);
}
