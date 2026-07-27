import { execFileSync } from 'node:child_process';

export const PACK_REVIEWER_ENV = 'PACK_REVIEWER';

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
  /** Test hook mirroring Resolve-PackReviewer.ps1 OverrideLayers. */
  layerOverrides?: PackReviewerLayerOverrides;
  /** Force Win32NT selector semantics (User/Machine layers, stale-process clearing). */
  emulateWin32?: boolean;
  readLayer?: (target: PackReviewerLayer) => string | null;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function isWin32SelectorHost(options: ResolvePackReviewerOptions = {}): boolean {
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
    const stdout = execFileSync('pwsh', [
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
    ], { encoding: 'utf8' }).trim();
    const parsed = JSON.parse(stdout) as PackReviewerLayerOverrides;
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
  if (!isWin32SelectorHost(options)) {
    return null;
  }
  const layers = readWindowsRegistryLayers();
  return trim(layers[target]) || null;
}

/**
 * Mirrors Get-PackReviewerSelectorValue + Clear-StalePackReviewerProcessScope from
 * scripts/lib/Resolve-PackReviewer.ps1 so runner policy matches invoke-pack-review.ps1.
 */
export function resolvePackReviewerSelectorValue(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolvePackReviewerOptions = {},
): string | null {
  const readLayer = options.readLayer
    ?? ((target: PackReviewerLayer) => defaultReadLayer(env, target, options));

  const userValue = readLayer('User');
  const machineValue = readLayer('Machine');
  const processValue = readLayer('Process');

  // Clear-StalePackReviewerProcessScope: when User is configured on Win32NT, drop Process.
  const effectiveProcess = isWin32SelectorHost(options) && userValue ? null : processValue;

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

export function resolvePackReviewerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolvePackReviewerOptions = {},
): PackReviewer | null {
  return normalizePackReviewer(resolvePackReviewerSelectorValue(env, options));
}

export function packReviewerSelectorErrorMessage(selectorValue?: string): string {
  const raw = selectorValue ?? process.env[PACK_REVIEWER_ENV] ?? '';
  if (!String(raw).trim()) {
    return 'PACK_REVIEWER is not set. Set PACK_REVIEWER to gpt, claude, or codex before running pack review (see docs/reviewer-switch-runbook.md).';
  }
  return `PACK_REVIEWER has unrecognized value '${String(raw).trim()}'. Set PACK_REVIEWER to gpt, claude, or codex.`;
}

export function packReviewWrapperBasename(reviewer: PackReviewer): string {
  return PACK_REVIEWER_WRAPPER_BY_ID[reviewer];
}
