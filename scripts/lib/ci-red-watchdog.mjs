#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateCiRedWatchdogCandidate,
  frameCiDiagnosticMessage,
  sanitizeCiDiagnostic,
} from './ci-red-watchdog-core.mjs';
import {
  claimCiRedWatchdogEpisode,
  inspectCiRedWatchdogAttempt,
  markCiRedWatchdogTransportIssued,
  readCiRedWatchdogLedger,
  recordCiRedWatchdogLookupFailure,
  resolveCiRedWatchdogLookupFailure,
  reconcileCiRedWatchdogSubmitted,
  releaseCiRedWatchdogAttempt,
} from './ci-red-watchdog-ledger.mjs';
import { pruneCiRedWatchdogLookupFailures } from './ci-red-watchdog-lookup-retention.mjs';

export * from './ci-red-watchdog-core.mjs';
export * from './ci-red-watchdog-ledger.mjs';
export * from './ci-red-watchdog-lookup-retention.mjs';

function parseCliInput(argv) {
  const inputIndex = argv.indexOf('--input-file');
  if (inputIndex >= 0 && argv[inputIndex + 1]) return JSON.parse(readFileSync(argv[inputIndex + 1], 'utf8'));
  const raw = readFileSync(0, 'utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function writeCliOutput(argv, payload) {
  const outputIndex = argv.indexOf('--output-file');
  const text = JSON.stringify(payload);
  if (outputIndex >= 0 && argv[outputIndex + 1]) {
    writeFileSync(argv[outputIndex + 1], text, { encoding: 'utf8', mode: 0o600 });
  } else {
    process.stdout.write(`${text}\n`);
  }
}

export function runCiRedWatchdogCli(command, input) {
  switch (command) {
    case 'sanitize': return sanitizeCiDiagnostic(input?.diagnostic, input?.config);
    case 'frame-message': return frameCiDiagnosticMessage(input);
    case 'evaluate': return evaluateCiRedWatchdogCandidate(input);
    case 'claim': return claimCiRedWatchdogEpisode(input);
    case 'transport-issued': return markCiRedWatchdogTransportIssued(input);
    case 'release': return releaseCiRedWatchdogAttempt(input);
    case 'reconcile-submit': return reconcileCiRedWatchdogSubmitted(input);
    case 'inspect-attempt': return inspectCiRedWatchdogAttempt(input);
    case 'inspect-ledger': return readCiRedWatchdogLedger(input?.storeDir);
    case 'record-lookup-failure': return recordCiRedWatchdogLookupFailure(input);
    case 'resolve-lookup-failure': return resolveCiRedWatchdogLookupFailure(input);
    case 'prune-lookup-failures': return pruneCiRedWatchdogLookupFailures(input);
    default: throw new Error(`unknown ci-red watchdog command: ${command}`);
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    const argv = process.argv.slice(2);
    const command = argv[0];
    const input = parseCliInput(argv);
    writeCliOutput(argv, runCiRedWatchdogCli(command, input));
  } catch (error) {
    process.stderr.write(`ci-red-watchdog: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
