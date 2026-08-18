#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { turnExitCode } from './chatgpt-browser-turn/contracts.ts';
import { runCli as runLegacyCli } from './chatgpt-browser-turn-legacy-core.ts';

const DIRECT_PUBLICATION_KEYS = [
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
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function directPublicationRequested(argv: readonly string[]): boolean {
  return DIRECT_PUBLICATION_KEYS.some((key) => argv.includes(`--${key}`));
}

function refuseLegacyDirectPublication(argv: readonly string[]): number {
  const invocationId = optionValue(argv, 'invocation-id') ?? randomUUID();
  process.stdout.write(`${JSON.stringify({
    schema: 'turn-result/v1',
    state: 'input_invalid',
    scope: 'invocation',
    cause: 'input_invalid:legacy_direct_publication_turn_refused',
    invocation_id: invocationId,
    configured_profile_key: 'profile-unresolved',
    send_count: 0,
  })}\n`);
  return turnExitCode('input_invalid');
}

/**
 * Compatibility CLI for legacy non-direct diagnostics and control operations.
 * Governed direct publication is owned exclusively by state-light-entry.ts.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  if ((argv[0] ?? '') === 'turn' && directPublicationRequested(argv)) {
    return refuseLegacyDirectPublication(argv);
  }
  return await runLegacyCli(argv);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
