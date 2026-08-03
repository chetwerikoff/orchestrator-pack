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

export const PACK_REVIEWER_WRAPPER_BY_ID: Readonly<Record<PackReviewer, string>> = {
  codex: 'run-pack-review.ps1',
  claude: 'run-pack-review-claude.ps1',
  gpt: 'run-pack-review-gpt.ts',
};

export type PackReviewerLayer = 'Process' | 'User' | 'Machine';

export interface PackReviewerLayerOverrides {
  Process?: string | null;
  User?: string | null;
  Machine?: string | null;
}

export interface ResolvePackReviewerOptions {
  /** Test hook for layer overrides. */
  layerOverrides?: PackReviewerLayerOverrides;
  /** Harness-only: consult User/Machine layers on non-Win32 hosts. */
  emulateWin32?: boolean;
  readLayer?: (target: PackReviewerLayer) => string | null;
  /** Test hook for a controlled persistent preference file. */
  preferenceFilePath?: string;
  /** Test hook for controlled persistent preference reads. */
  readPreference?: (filePath: string) => PackReviewerPreferenceRead;
}

export interface PackReviewerResolution {
  selectorValue: string | null;
  reviewer: PackReviewer | null;
  errorMessage: string | null;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function isPersistentLayerHost(options: ResolvePackReviewerOptions = {}): boolean {
  return options.emulateWin32 === true || process.platform === 'win32';
}

function defaultReadLayer(
  env: NodeJS.ProcessEnv,
  target: PackReviewerLayer,
  options: ResolvePackReviewerOptions,
): string | null {
  if (options.layerOverrides && Object.prototype.hasOwnProperty.call(options.layerOverrides, target)) {
    const override = options.layerOverrides[target];
    return trim(override) || null;
  }
  if (target === 'Process') {
    return trim(env[PACK_REVIEWER_ENV]) || null;
  }
  // Persistent user selection is portable JSON. There is no host-specific
  // registry or shell probe in the reviewer selector.
  return null;
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

function resolvePackReviewerSelector(
  env: NodeJS.ProcessEnv,
  options: ResolvePackReviewerOptions,
): { selectorValue: string | null; preference: PackReviewerPreferenceRead } {
  const bound = normalizePackReviewer(env[PACK_REVIEW_BOUND_REVIEWER_ENV]);
  const preference = readPreference(env, options);
  if (bound) {
    return { selectorValue: bound, preference };
  }
  if (preference.status === 'valid') {
    return { selectorValue: preference.reviewer, preference };
  }
  if (preference.status === 'invalid') {
    return { selectorValue: null, preference };
  }

  const readLayer = options.readLayer
    ?? ((target: PackReviewerLayer) => defaultReadLayer(env, target, options));

  const userValue = readLayer('User');
  const machineValue = readLayer('Machine');
  const processValue = readLayer('Process');
  const effectiveProcess = isPersistentLayerHost(options) && userValue ? null : processValue;

  if (effectiveProcess) {
    return { selectorValue: effectiveProcess, preference };
  }
  if (userValue) {
    return { selectorValue: userValue, preference };
  }
  return { selectorValue: machineValue, preference };
}

/** Canonical selector authority for pack review (Issue #1031). */
export function resolvePackReviewerSelectorValue(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolvePackReviewerOptions = {},
): string | null {
  return resolvePackReviewerSelector(env, options).selectorValue;
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
  const resolution = resolvePackReviewerSelector(env, options);
  const selectorValue = resolution.selectorValue;
  const reviewer = normalizePackReviewer(selectorValue);
  const errorMessage = reviewer
    ? null
    : resolution.preference.status === 'invalid'
      ? resolution.preference.errorMessage
      : packReviewerSelectorErrorMessage(selectorValue ?? undefined, options, env);
  return { selectorValue, reviewer, errorMessage };
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
  const preference = readPreference(env, options);
  if (preference.status === 'invalid') {
    return preference.errorMessage;
  }
  const raw = selectorValue ?? resolvePackReviewerSelectorValue(env, options) ?? env[PACK_REVIEWER_ENV] ?? '';
  if (!String(raw).trim()) {
    return 'PACK_REVIEWER is not set. Set PACK_REVIEWER to gpt, claude, or codex before running pack review (see docs/reviewer-switch-runbook.md).';
  }
  return `PACK_REVIEWER has unrecognized value '${String(raw).trim()}'. Set PACK_REVIEWER to gpt, claude, or codex.`;
}

export function packReviewWrapperBasename(reviewer: PackReviewer): string {
  return PACK_REVIEWER_WRAPPER_BY_ID[reviewer];
}
