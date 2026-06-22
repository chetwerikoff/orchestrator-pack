#!/usr/bin/env node
/**
 * Fixture producer: emits structured JSON for live re-verification tests.
 * Set REVERIFY_VALUE env or pass --value <literal>.
 */
import { writeFileSync } from 'node:fs';

const valueArgIndex = process.argv.indexOf('--value');
const fromArg = valueArgIndex >= 0 ? process.argv[valueArgIndex + 1] : '';
const raw = process.env.REVERIFY_VALUE ?? fromArg ?? 'match';

function formatJsonOutput(value) {
  const trimmed = String(value).trim();
  if (
    trimmed.startsWith('{')
    || trimmed.startsWith('[')
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed;
  }
  return JSON.stringify(trimmed);
}

if (process.env.REVERIFY_ATTEMPT_MUTATION === '1') {
  try {
    writeFileSync('.reverify-mutation-marker', 'mutated', 'utf8');
  } catch {
    // sandbox may block; live check should still observe attempted mutation separately
  }
}

const forceExitCode = process.env.REVERIFY_FORCE_EXIT_CODE;
process.stdout.write(`${formatJsonOutput(raw)}\n`);
if (forceExitCode !== undefined) {
  const code = Number(forceExitCode);
  process.exit(Number.isFinite(code) ? code : 1);
}
