import {
  writePackReviewerPreference,
} from './lib/pack-reviewer-preference.ts';
import {
  normalizePackReviewer,
  resolvePackReviewerResolution,
} from './lib/resolve-pack-reviewer.ts';

type Command = 'set' | 'status';

function usage(): never {
  throw new Error(
    'Usage: pack-reviewer-config.ts set <gpt|codex|claude> | status [--json] [--expect <gpt|codex|claude>]',
  );
}

function parseArgs(argv: readonly string[]): {
  command: Command;
  reviewer?: string;
  expect?: string;
  json: boolean;
} {
  const command = argv[0];
  if (command !== 'set' && command !== 'status') {
    return usage();
  }

  let reviewer: string | undefined;
  let expect: string | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (command === 'set' && index === 1 && !arg?.startsWith('-')) {
      reviewer = arg;
      continue;
    }
    if (arg === '--expect') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a reviewer`);
      }
      expect = value;
      index += 1;
      continue;
    }
    if (arg === '--json' && command === 'status') {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (command === 'set' && (!reviewer || argv.length !== 2)) {
    throw new Error('set requires exactly one reviewer: gpt, codex, or claude');
  }
  if (command === 'set' && expect) {
    throw new Error('set does not accept --expect');
  }
  return { command, reviewer, expect, json };
}

function runSet(reviewerValue: string): void {
  const reviewer = normalizePackReviewer(reviewerValue);
  if (!reviewer) {
    throw new Error(`Invalid reviewer '${reviewerValue}'. Use gpt, codex, or claude.`);
  }

  const saved = writePackReviewerPreference(reviewer);
  if (saved.status !== 'valid') {
    throw new Error(saved.errorMessage ?? 'Persistent reviewer preference could not be verified.');
  }
  const effective = resolvePackReviewerResolution();
  if (effective.source === 'persistent-preference' && effective.reviewer !== reviewer) {
    throw new Error(
      `Persistent reviewer saved as ${reviewer}, but effective reviewer is ${effective.reviewer ?? 'unset'}.`,
    );
  }

  process.stdout.write(`Saved reviewer: ${reviewer}\n`);
  process.stdout.write(`Preference file: ${saved.filePath}\n`);
  process.stdout.write(`Effective reviewer: ${effective.reviewer ?? '(fail-closed — not set)'}\n`);
  process.stdout.write(`Source: ${effective.source}\n`);
}

function runStatus(expectedValue: string | undefined, json: boolean): void {
  const resolution = resolvePackReviewerResolution();
  const preference = resolution.preference;
  const status = {
    schema: 'pack-reviewer-status/v1',
    preferencePath: resolution.preferencePath,
    savedReviewer: preference?.reviewer ?? null,
    preferenceStatus: preference?.status ?? 'not-consulted',
    legacyReviewer: process.env.PACK_REVIEWER?.trim() || null,
    effectiveReviewer: resolution.reviewer,
    source: resolution.source,
    errorMessage: resolution.errorMessage,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
  } else {
    process.stdout.write(`Preference file: ${status.preferencePath ?? '(unavailable)'}\n`);
    process.stdout.write(`Saved reviewer: ${status.savedReviewer ?? '(not set)'}\n`);
    process.stdout.write(`Legacy PACK_REVIEWER: ${status.legacyReviewer ?? '(not set)'}\n`);
    process.stdout.write(`Effective reviewer: ${status.effectiveReviewer ?? '(fail-closed — not set)'}\n`);
    process.stdout.write(`Source: ${status.source}\n`);
    if (status.errorMessage) process.stderr.write(`${status.errorMessage}\n`);
  }

  if (expectedValue) {
    const expected = normalizePackReviewer(expectedValue);
    if (!expected) {
      throw new Error(`Invalid expected reviewer '${expectedValue}'. Use gpt, codex, or claude.`);
    }
    if (resolution.reviewer === expected) {
      if (!json) process.stdout.write(`[PASS] Effective reviewer is ${expected}.\n`);
    } else {
      process.exitCode = 1;
    }
  }
  if (!resolution.reviewer) {
    process.exitCode = 1;
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'set') {
    runSet(args.reviewer!);
  } else {
    runStatus(args.expect, args.json);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
