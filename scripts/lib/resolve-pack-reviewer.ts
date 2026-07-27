import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from '../kernel/subprocess.ts';

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
  /** Test hook forwarded to Resolve-PackReviewer.ps1 OverrideLayers. */
  layerOverrides?: PackReviewerLayerOverrides;
  /** Harness-only: consult User/Machine layers on non-Win32 hosts. */
  emulateWin32?: boolean;
}

export interface PackReviewerResolution {
  selectorValue: string | null;
  reviewer: PackReviewer | null;
  errorMessage: string | null;
}

const SCRIPTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_SCRIPT = join(SCRIPTS_ROOT, 'export-pack-reviewer-resolution.ps1');

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function parseResolution(stdout: string): PackReviewerResolution {
  const parsed = JSON.parse(stdout) as {
    selectorValue?: string | null;
    reviewer?: string | null;
    errorMessage?: string | null;
  };
  const reviewer = normalizePackReviewer(parsed.reviewer);
  const selectorValue = trim(parsed.selectorValue) || null;
  const errorMessage = trim(parsed.errorMessage) || null;
  return { selectorValue, reviewer, errorMessage };
}

/**
 * Delegates to scripts/lib/Resolve-PackReviewer.ps1 — the single selector authority.
 */
export function resolvePackReviewerResolution(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolvePackReviewerOptions = {},
): PackReviewerResolution {
  const args = ['-NoProfile', '-File', EXPORT_SCRIPT];
  if (options.layerOverrides && Object.keys(options.layerOverrides).length > 0) {
    args.push('-OverrideLayersJson', JSON.stringify(options.layerOverrides));
  }
  if (options.emulateWin32) {
    args.push('-HarnessEmulatePersistentLayers');
  }

  const isolatedEnv = env !== process.env;
  const result = runProcessSync({
    command: 'pwsh',
    args,
    cwd: SCRIPTS_ROOT,
    inheritParentEnv: !isolatedEnv,
    env: isolatedEnv
      ? {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        PATHEXT: process.env.PATHEXT,
        ...env,
      }
      : undefined,
  });
  if (!result.ok) {
    const detail = trim(result.stderr || result.stdout || result.error) || 'pack reviewer resolution failed';
    throw new Error(detail);
  }
  return parseResolution(result.stdout);
}

export function resolvePackReviewerSelectorValue(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolvePackReviewerOptions = {},
): string | null {
  return resolvePackReviewerResolution(env, options).selectorValue;
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
  return resolvePackReviewerResolution(env, options).reviewer;
}

export function packReviewerSelectorErrorMessage(
  selectorValue?: string,
  options: ResolvePackReviewerOptions = {},
): string {
  const resolution = resolvePackReviewerResolution(
    selectorValue === undefined
      ? process.env
      : { ...process.env, [PACK_REVIEWER_ENV]: selectorValue },
    options,
  );
  if (resolution.errorMessage) {
    return resolution.errorMessage;
  }
  const raw = selectorValue ?? process.env[PACK_REVIEWER_ENV] ?? '';
  if (!String(raw).trim()) {
    return 'PACK_REVIEWER is not set. Set PACK_REVIEWER to gpt, claude, or codex before running pack review (see docs/reviewer-switch-runbook.md).';
  }
  return `PACK_REVIEWER has unrecognized value '${String(raw).trim()}'. Set PACK_REVIEWER to gpt, claude, or codex.`;
}

export function packReviewWrapperBasename(reviewer: PackReviewer): string {
  return PACK_REVIEWER_WRAPPER_BY_ID[reviewer];
}
