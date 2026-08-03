import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PACK_REVIEWER_PREFERENCE_SCHEMA = 'pack-reviewer-preference/v1';
export const PACK_REVIEWER_VALUES = ['codex', 'claude', 'gpt'] as const;
export type PackReviewerPreferenceValue = (typeof PACK_REVIEWER_VALUES)[number];

export interface PackReviewerPreferenceDocument {
  readonly schema: typeof PACK_REVIEWER_PREFERENCE_SCHEMA;
  readonly reviewer: PackReviewerPreferenceValue;
}

export type PackReviewerPreferenceRead =
  | {
      readonly status: 'absent';
      readonly filePath: string;
      readonly reviewer: null;
      readonly errorMessage: null;
    }
  | {
      readonly status: 'valid';
      readonly filePath: string;
      readonly reviewer: PackReviewerPreferenceValue;
      readonly errorMessage: null;
    }
  | {
      readonly status: 'invalid';
      readonly filePath: string;
      readonly reviewer: null;
      readonly errorMessage: string;
    };

export interface PackReviewerPreferencePathEnv {
  readonly XDG_CONFIG_HOME?: string;
  readonly APPDATA?: string;
  readonly HOME?: string;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getPackReviewerPreferencePath(
  env: PackReviewerPreferencePathEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const effectiveHome = nonEmpty(env.HOME) ?? homeDirectory;
  const configHome = nonEmpty(env.XDG_CONFIG_HOME)
    ?? nonEmpty(env.APPDATA)
    ?? join(effectiveHome, '.config');
  return join(resolve(configHome), 'orchestrator-pack', 'reviewer.json');
}

function invalidPreference(filePath: string, reason: string): PackReviewerPreferenceRead {
  return {
    status: 'invalid',
    filePath,
    reviewer: null,
    errorMessage: `Invalid persistent reviewer preference at ${filePath}: ${reason}. Run the switch-pack-reviewer skill to repair it.`,
  };
}

export function readPackReviewerPreference(
  filePath: string = getPackReviewerPreferencePath(),
): PackReviewerPreferenceRead {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'absent',
        filePath,
        reviewer: null,
        errorMessage: null,
      };
    }
    return invalidPreference(filePath, `cannot read file (${String(error)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidPreference(filePath, 'file is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidPreference(filePath, 'document must be an object');
  }

  const document = parsed as Record<string, unknown>;
  if (document.schema !== PACK_REVIEWER_PREFERENCE_SCHEMA) {
    return invalidPreference(filePath, `schema must be ${PACK_REVIEWER_PREFERENCE_SCHEMA}`);
  }

  const reviewer = document.reviewer;
  if (typeof reviewer !== 'string' || !(PACK_REVIEWER_VALUES as readonly string[]).includes(reviewer)) {
    return invalidPreference(filePath, 'reviewer must be gpt, codex, or claude');
  }

  return {
    status: 'valid',
    filePath,
    reviewer: reviewer as PackReviewerPreferenceValue,
    errorMessage: null,
  };
}

export function writePackReviewerPreference(
  reviewer: string,
  filePath: string = getPackReviewerPreferencePath(),
): PackReviewerPreferenceRead {
  if (!(PACK_REVIEWER_VALUES as readonly string[]).includes(reviewer)) {
    throw new Error(`invalid_reviewer:${reviewer}`);
  }

  const normalizedReviewer = reviewer as PackReviewerPreferenceValue;
  const document: PackReviewerPreferenceDocument = {
    schema: PACK_REVIEWER_PREFERENCE_SCHEMA,
    reviewer: normalizedReviewer,
  };
  const directory = dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows does not expose POSIX directory permissions.
  }

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(document)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      chmodSync(temporaryPath, 0o600);
    } catch {
      // Windows does not expose POSIX file permissions.
    }
    try {
      renameSync(temporaryPath, filePath);
    } catch (error) {
      // Windows refuses to replace an existing file with rename. Preserve the
      // same behavior on POSIX while supporting that platform's replacement rule.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        && (error as NodeJS.ErrnoException).code !== 'EPERM') {
        throw error;
      }
      rmSync(filePath, { force: true });
      renameSync(temporaryPath, filePath);
    }
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Windows does not expose POSIX file permissions.
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  return readPackReviewerPreference(filePath);
}
