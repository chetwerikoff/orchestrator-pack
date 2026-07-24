import { lstatSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export type RuntimeSurfaceClass = 'dormant' | 'live-unchanged' | 'live-replaced';

export interface RuntimeSurface {
  id: string;
  category: 'scheduler' | 'notification' | 'config' | 'migration' | 'claim' | 'registry' | 'supervisor' | 'starter';
  path: string;
  classification: RuntimeSurfaceClass;
}

export const RUNTIME_CATALOG_VERSION = 1 as const;

export const FOUNDATION_RUNTIME_CATALOG: readonly RuntimeSurface[] = Object.freeze([
  { id: 'scheduler-foundation', category: 'scheduler', path: 'scripts/pr2-foundation/scheduler.ts', classification: 'dormant' },
  { id: 'worker-notification', category: 'notification', path: 'scripts/lib/pack-review-worker-notification.ts', classification: 'live-replaced' },
  { id: 'typed-config', category: 'config', path: 'scripts/pr2-foundation/config.ts', classification: 'live-replaced' },
  { id: 'migration-journal', category: 'migration', path: 'scripts/pr2-foundation/migration-journal.ts', classification: 'dormant' },
  { id: 'claim-acquisition', category: 'claim', path: 'scripts/lib/review-start-claim-store.ts', classification: 'live-replaced' },
  { id: 'side-process-registry', category: 'registry', path: 'scripts/orchestrator-side-process-registry.json', classification: 'live-unchanged' },
  { id: 'wake-supervisor', category: 'supervisor', path: 'scripts/lib/Orchestrator-WakeSupervisor.ps1', classification: 'live-replaced' },
  { id: 'legacy-starters', category: 'starter', path: 'scripts/review-trigger-reconcile.ps1', classification: 'live-unchanged' },
]);

const CLASS_RANK: Record<RuntimeSurfaceClass, number> = {
  dormant: 0,
  'live-unchanged': 1,
  'live-replaced': 2,
};

export function validateRuntimeCatalog(
  trustedBase: readonly RuntimeSurface[],
  candidate: readonly RuntimeSurface[],
): { ok: true } | { ok: false; reason: string; surface?: string } {
  const baseById = new Map(trustedBase.map((row) => [row.id, row]));
  const candidateById = new Map(candidate.map((row) => [row.id, row]));
  if (candidateById.size !== candidate.length) return { ok: false, reason: 'catalog_duplicate_surface' };
  for (const required of FOUNDATION_RUNTIME_CATALOG) {
    if (!candidateById.has(required.id)) return { ok: false, reason: 'catalog_surface_omitted', surface: required.id };
  }
  for (const [id, base] of baseById) {
    const next = candidateById.get(id);
    if (!next) return { ok: false, reason: 'catalog_surface_omitted', surface: id };
    if (next.path !== base.path || next.category !== base.category) {
      return { ok: false, reason: 'candidate_catalog_identity_changed', surface: id };
    }
    if (CLASS_RANK[next.classification] < CLASS_RANK[base.classification]) {
      return { ok: false, reason: 'candidate_catalog_downgrade', surface: id };
    }
  }
  return { ok: true };
}

export function platformSupportsDestructiveCleanup(input: {
  platform?: NodeJS.Platform;
  wslInterop?: string;
} = {}): boolean {
  const platform = input.platform ?? process.platform;
  if (platform !== 'linux') return false;
  if (input.wslInterop !== undefined) return Boolean(input.wslInterop.trim());
  return Boolean(process.env.WSL_INTEROP?.trim()) || platform === 'linux';
}

export function cleanupOwnedFixtureRoot(input: {
  target: string;
  ownedRoot: string;
  enabled: boolean;
  platform?: NodeJS.Platform;
  wslInterop?: string;
  beforeIdentity?: { dev: number; ino: number };
}): { ok: boolean; reason: string } {
  if (!input.enabled) return { ok: false, reason: 'cleanup_disabled' };
  if (!platformSupportsDestructiveCleanup({ platform: input.platform, wslInterop: input.wslInterop })) {
    return { ok: false, reason: 'unsupported_platform_cleanup_disabled' };
  }
  const target = path.resolve(input.target);
  const root = path.resolve(input.ownedRoot);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, reason: 'owned_root_required' };
  }
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink()) return { ok: false, reason: 'symlink_cleanup_refused' };
  const realTarget = realpathSync(target);
  const realRoot = realpathSync(root);
  const realRelative = path.relative(realRoot, realTarget);
  if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`)) {
    return { ok: false, reason: 'owned_root_swap_refused' };
  }
  const current = statSync(target);
  if (input.beforeIdentity
    && (current.dev !== input.beforeIdentity.dev || current.ino !== input.beforeIdentity.ino)) {
    return { ok: false, reason: 'swap_after_check_delete_refused' };
  }
  rmSync(target, { recursive: true, force: true });
  return { ok: true, reason: 'owned_fixture_deleted' };
}
