import {
  readPackReviewerPreference,
  writePackReviewerPreference,
} from './lib/pack-reviewer-preference.ts';
import {
  normalizePackReviewer,
  packReviewWrapperBasename,
  resolvePackReviewerResolution,
} from './lib/resolve-pack-reviewer.ts';

type Command = 'set' | 'status';

function usage(): never {
  throw new Error(
    'Usage: pack-reviewer-config.ts set --reviewer <gpt|codex|claude> | status [--expected <gpt|codex|claude>]',
  );
}

function parseArgs(argv: readonly string[]): {
  command: Command;
  reviewer?: string;
  expected?: string;
} {
  const command = argv[0];
  if (command !== 'set' && command !== 'status') {
    return usage();
  }

  let reviewer: string | undefined;
  let expected: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--reviewer' || arg === '--expected') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a reviewer`);
      }
      if (arg === '--reviewer') reviewer = value;
      else expected = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (command === 'set' && !reviewer) {
    throw new Error('set requires --reviewer <gpt|codex|claude>');
  }
  if (command === 'status' && reviewer) {
    throw new Error('status does not accept --reviewer');
  }
  return { command, reviewer, expected };
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
  if (effective.reviewer !== reviewer) {
    throw new Error(
      `Persistent reviewer saved as ${reviewer}, but effective reviewer is ${effective.reviewer ?? 'unset'}.`,
    );
  }

  process.stdout.write(`Saved reviewer: ${reviewer}\n`);
  process.stdout.write(`Preference file: ${saved.filePath}\n`);
  process.stdout.write(`Effective reviewer: ${effective.reviewer}\n`);
}

function runStatus(expectedValue: string | undefined): void {
  const preference = readPackReviewerPreference();
  const resolution = resolvePackReviewerResolution();
  const wrapper = resolution.reviewer ? packReviewWrapperBasename(resolution.reviewer) : '(none)';

  process.stdout.write(`Preference file: ${preference.filePath}\n`);
  process.stdout.write(`Saved reviewer: ${preference.reviewer ?? '(not set)'}\n`);
  process.stdout.write(`Legacy PACK_REVIEWER: ${process.env.PACK_REVIEWER ?? '(not set)'}\n`);
  process.stdout.write(`Effective reviewer: ${resolution.reviewer ?? '(fail-closed — not set)'}\n`);
  process.stdout.write(`Wrapper: ${wrapper}\n`);
  if (preference.status === 'invalid') {
    process.stderr.write(`${preference.errorMessage}\n`);
    process.exitCode = 1;
  } else if (!resolution.reviewer) {
    process.exitCode = 1;
  }

  if (expectedValue) {
    const expected = normalizePackReviewer(expectedValue);
    if (!expected) {
      throw new Error(`Invalid expected reviewer '${expectedValue}'. Use gpt, codex, or claude.`);
    }
    if (resolution.reviewer !== expected) {
      process.exitCode = 1;
    } else {
      process.stdout.write(`[PASS] Effective reviewer is ${expected}.\n`);
    }
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'set') {
    runSet(args.reviewer!);
  } else {
    runStatus(args.expected);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
