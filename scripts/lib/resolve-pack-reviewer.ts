import {
  PACK_REVIEWER_VALUES,
  getPackReviewerPreferencePath,
  readPackReviewerPreference,
  type PackReviewerPreferenceRead,
  type PackReviewerPreferenceValue,
} from './pack-reviewer-preference.ts';

export const PACK_REVIEWER_ENV = 'PACK_REVIEWER';
export const PACK_REVIEW_BOUND_REVIEWER_ENV = 'PACK_REVIEW_BOUND_REVIEWER';

export { PACK_REVIEWER_VALUES };
export type PackReviewer = PackReviewerPreferenceValue;

export const PACK_REVIEWER_ENTRYPOINT_BY_ID: Readonly<Record<PackReviewer, string>> = {
  codex: 'plugins/codex-pr-reviewer/bin/review.ts',
  claude: 'scripts/runtime/pack-review-claude.ts',
  gpt: 'scripts/run-pack-review-gpt.ts',
};

export type PackReviewerResolutionSource =
  | 'invocation-bound'
  | 'persistent-preference'
  | 'legacy-env'
  | 'none';

export type PackReviewerLayer = 'Process' | 'User' | 'Machine';

export interface PackReviewerLayerOverrides {
  Process?: string | null;
  User?: string | null;
  Machine?: string | null;
}

export interface ResolvePackReviewerOptions {
  /** Harness-only legacy-layer fixture; production callers must omit it. */
  layerOverrides?: PackReviewerLayerOverrides;
  /** Harness-only ordering fixture; never probes host persistence. */
  emulateWin32?: boolean;
  /** Test hook for a controlled persistent preference file. */
  preferenceFilePath?: string;
  /** Test hook for controlled persistent preference reads. */
  readPreference?: (filePath: string) => PackReviewerPreferenceRead;
}

export interface PackReviewerResolution {
  selectorValue: string | null;
  reviewer: PackReviewer | null;
  source: PackReviewerResolutionSource;
  preferencePath: string | null;
  preference: PackReviewerPreferenceRead | null;
  errorMessage: string | null;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function readPreference(
  env: NodeJS.ProcessEnv,
  options: ResolvePackReviewerOptions,
): PackReviewerPreferenceRead {
  const filePath = options.preferenceFilePath ?? getPackReviewerPreferencePath(env);
  if (options.readPreference) {
    return options.readPreference(filePath);
  }
  return readPackReviewerPreference(filePath);
}

function preferencePath(
  env: NodeJS.ProcessEnv,
  options: ResolvePackReviewerOptions,
): string | null {
  if (options.preferenceFilePath) return options.preferenceFilePath;
  try {
    return getPackReviewerPreferencePath(env);
  } catch {
    return null;
  }
}

function legacyReviewerValue(
  env: NodeJS.ProcessEnv,
  options: ResolvePackReviewerOptions,
): string {
  if (!options.layerOverrides) return trim(env[PACK_REVIEWER_ENV]);
  const layers = options.layerOverrides;
  const ordered = options.emulateWin32
    ? [layers.User, layers.Machine, layers.Process]
    : [layers.Process, layers.User, layers.Machine];
  return ordered.map(trim).find(Boolean) ?? trim(env[PACK_REVIEWER_ENV]);
}

function noAuthority(
  selectorValue: string | null,
  errorMessage: string,
  path: string | null,
  preference: PackReviewerPreferenceRead | null,
): PackReviewerResolution {
  return {
    selectorValue,
    reviewer: null,
    source: 'none',
    preferencePath: path,
    preference,
    errorMessage,
  };
}

function resolvePackReviewer(
  env: NodeJS.ProcessEnv,
  options: ResolvePackReviewerOptions,
): PackReviewerResolution {
  const path = preferencePath(env, options);
  const boundRaw = trim(env[PACK_REVIEW_BOUND_REVIEWER_ENV]);
  if (boundRaw) {
    const bound = normalizePackReviewer(boundRaw);
    if (!bound) {
      return noAuthority(
        boundRaw,
        `PACK_REVIEW_BOUND_REVIEWER has unrecognized value '${boundRaw}'. Set it to gpt, claude, or codex.`,
        path,
        null,
      );
    }
    return {
      selectorValue: bound,
      reviewer: bound,
      source: 'invocation-bound',
      preferencePath: path,
      preference: null,
      errorMessage: null,
    };
  }

  if (!path) {
    return noAuthority(
      null,
      'OPK_REVIEWER_CONFIG_ROOT_MISSING: set XDG_CONFIG_HOME or HOME before accessing the persistent reviewer preference.',
      null,
      null,
    );
  }

  const preference = readPreference(env, options);
  if (preference.status === 'valid') {
    return {
      selectorValue: preference.reviewer,
      reviewer: preference.reviewer,
      source: 'persistent-preference',
      preferencePath: path,
      preference,
      errorMessage: null,
    };
  }
  if (preference.status === 'invalid') {
    return noAuthority(null, preference.errorMessage, path, preference);
  }

  const legacyRaw = legacyReviewerValue(env, options);
  if (legacyRaw) {
    const legacy = normalizePackReviewer(legacyRaw);
    if (legacy) {
      return {
        selectorValue: legacy,
        reviewer: legacy,
        source: 'legacy-env',
        preferencePath: path,
        preference,
        errorMessage: null,
      };
    }
    return noAuthority(
      legacyRaw,
      `PACK_REVIEWER has unrecognized value '${legacyRaw}'. Set PACK_REVIEWER to gpt, claude, or codex.`,
      path,
      preference,
    );
  }
  return noAuthority(
    null,
    'No reviewer authority is configured. Set a persistent reviewer or PACK_REVIEWER to gpt, claude, or codex.',
    path,
    preference,
  );
}

/** Canonical selector authority for pack review (Issue #1031). */
export function resolvePackReviewerSelectorValue(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolvePackReviewerOptions = {},
): string | null {
  return resolvePackReviewer(env, options).selectorValue;
}

export function normalizePackReviewer(value: unknown): PackReviewer | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if ((PACK_REVIEWER_VALUES as readonly string[]).includes(normalized)) {
    return normalized as PackReviewer;
  }
  return null;
}

export function resolvePackReviewerResolution(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolvePackReviewerOptions = {},
): PackReviewerResolution {
  return resolvePackReviewer(env, options);
}

export function resolvePackReviewerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolvePackReviewerOptions = {},
): PackReviewer | null {
  return resolvePackReviewerResolution(env, options).reviewer;
}

export function packReviewerSelectorErrorMessage(
  selectorValue?: string,
  options: ResolvePackReviewerOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (selectorValue !== undefined) {
    const raw = String(selectorValue).trim();
    if (!raw) {
      return 'No reviewer authority is configured. Set a persistent reviewer or PACK_REVIEWER to gpt, claude, or codex.';
    }
    return `PACK_REVIEWER has unrecognized value '${raw}'. Set PACK_REVIEWER to gpt, claude, or codex.`;
  }
  return resolvePackReviewer(env, options).errorMessage
    ?? 'No reviewer authority is configured.';
}

export function packReviewEntrypointRelativePath(reviewer: PackReviewer): string {
  return PACK_REVIEWER_ENTRYPOINT_BY_ID[reviewer];
}
