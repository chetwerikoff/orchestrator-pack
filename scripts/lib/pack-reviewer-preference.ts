import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PACK_REVIEWER_PREFERENCE_SCHEMA = 'orchestrator-pack/pack-reviewer-preference/v1';
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
  readonly HOME?: string;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getPackReviewerPreferencePath(
  env: PackReviewerPreferencePathEnv = process.env,
): string {
  const configHome = nonEmpty(env.XDG_CONFIG_HOME);
  const home = nonEmpty(env.HOME);
  if (!configHome && !home) {
    throw new Error(
      'OPK_REVIEWER_CONFIG_ROOT_MISSING: set XDG_CONFIG_HOME or HOME before accessing the persistent reviewer preference.',
    );
  }
  return join(resolve(configHome ?? join(home!, '.config')), 'orchestrator-pack', 'pack-reviewer.json');
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

  const keys = Object.keys(document).sort();
  if (keys.length !== 2 || keys[0] !== 'reviewer' || keys[1] !== 'schema') {
    return invalidPreference(filePath, 'document must contain exactly schema and reviewer');
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
  enforceMode(directory, 0o700, 'directory');

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(document)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    enforceMode(temporaryPath, 0o600, 'file');
    replacePreferenceFile(temporaryPath, filePath);
    enforceMode(filePath, 0o600, 'file');
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  return readPackReviewerPreference(filePath);
}

function enforceMode(filePath: string, mode: number, kind: 'directory' | 'file'): void {
  try {
    chmodSync(filePath, mode);
  } catch (error) {
    if (process.platform === 'win32') return;
    throw new Error(
      `OPK_REVIEWER_PERMISSION_FAILED: could not enforce ${kind} mode ${mode.toString(8)} on ${filePath}: ${String(error)}`,
    );
  }
}

function replacePreferenceFile(temporaryPath: string, filePath: string): void {
  try {
    renameSync(temporaryPath, filePath);
    return;
  } catch (error) {
    if (process.platform !== 'win32'
      || ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        && (error as NodeJS.ErrnoException).code !== 'EPERM')) {
      throw error;
    }
  }

  // Node's Windows rename cannot replace an existing file. Move the old
  // bytes aside first and roll them back if the replacement cannot complete.
  // POSIX callers take the atomic same-directory rename path above.
  const backupPath = `${filePath}.${process.pid}.${randomUUID()}.bak`;
  let backupCreated = false;
  try {
    renameSync(filePath, backupPath);
    backupCreated = true;
    renameSync(temporaryPath, filePath);
    rmSync(backupPath, { force: true });
  } catch (error) {
    if (backupCreated) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // The replacement target may not exist after a failed rename.
      }
      try {
        renameSync(backupPath, filePath);
      } catch {
        // Preserve the original failure; the caller still fails closed.
      }
    }
    throw error;
  } finally {
    rmSync(backupPath, { force: true });
  }
}
