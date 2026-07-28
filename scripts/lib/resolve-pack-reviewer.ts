import { runProcessSync } from '../kernel/subprocess.ts';

export const PACK_REVIEWER_ENV = 'PACK_REVIEWER';
export const PACK_REVIEW_BOUND_REVIEWER_ENV = 'PACK_REVIEW_BOUND_REVIEWER';

export const PACK_REVIEWER_VALUES = ['codex', 'claude', 'gpt'] as const;
export type PackReviewer = (typeof PACK_REVIEWER_VALUES)[number];

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

let cachedWindowsLayers: PackReviewerLayerOverrides | undefined;

function readWindowsRegistryLayers(): PackReviewerLayerOverrides {
  if (cachedWindowsLayers !== undefined) {
    return cachedWindowsLayers;
  }
  if (process.platform !== 'win32') {
    cachedWindowsLayers = {};
    return cachedWindowsLayers;
  }
  try {
    const result = runProcessSync({
      command: 'pwsh',
      args: [
        '-NoProfile',
        '-Command',
        [
          '$layers = @{',
          "  Process = [Environment]::GetEnvironmentVariable('PACK_REVIEWER','Process');",
          "  User = [Environment]::GetEnvironmentVariable('PACK_REVIEWER','User');",
          "  Machine = [Environment]::GetEnvironmentVariable('PACK_REVIEWER','Machine')",
          '}',
          '$layers | ConvertTo-Json -Compress',
        ].join(' '),
      ],
      inheritParentEnv: true,
    });
    if (!result.ok) {
      cachedWindowsLayers = {};
      return cachedWindowsLayers;
    }
    const parsed = JSON.parse(result.stdout.trim()) as PackReviewerLayerOverrides;
    cachedWindowsLayers = {
      Process: trim(parsed.Process) || null,
      User: trim(parsed.User) || null,
      Machine: trim(parsed.Machine) || null,
    };
  } catch {
    cachedWindowsLayers = {};
  }
  return cachedWindowsLayers;
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
  if (!isPersistentLayerHost(options)) {
    return null;
  }
  const layers = readWindowsRegistryLayers();
  return trim(layers[target]) || null;
}

/** Canonical selector authority for pack review (Issue #1031). */
export function resolvePackReviewerSelectorValue(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolvePackReviewerOptions = {},
): string | null {
  const bound = normalizePackReviewer(env[PACK_REVIEW_BOUND_REVIEWER_ENV]);
  if (bound) {
    return bound;
  }

  const readLayer = options.readLayer
    ?? ((target: PackReviewerLayer) => defaultReadLayer(env, target, options));

  const userValue = readLayer('User');
  const machineValue = readLayer('Machine');
  const processValue = readLayer('Process');
  const effectiveProcess = isPersistentLayerHost(options) && userValue ? null : processValue;

  if (effectiveProcess) {
    return effectiveProcess;
  }
  if (userValue) {
    return userValue;
  }
  if (machineValue) {
    return machineValue;
  }
  return null;
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
  const selectorValue = resolvePackReviewerSelectorValue(env, options);
  const reviewer = normalizePackReviewer(selectorValue);
  const errorMessage = reviewer
    ? null
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
  const raw = selectorValue ?? resolvePackReviewerSelectorValue(env, options) ?? env[PACK_REVIEWER_ENV] ?? '';
  if (!String(raw).trim()) {
    return 'PACK_REVIEWER is not set. Set PACK_REVIEWER to gpt, claude, or codex before running pack review (see docs/reviewer-switch-runbook.md).';
  }
  return `PACK_REVIEWER has unrecognized value '${String(raw).trim()}'. Set PACK_REVIEWER to gpt, claude, or codex.`;
}

export function packReviewWrapperBasename(reviewer: PackReviewer): string {
  return PACK_REVIEWER_WRAPPER_BY_ID[reviewer];
}
