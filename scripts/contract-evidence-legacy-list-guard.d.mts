export const GOVERNED_MANIFEST_REL_PATH: string;
export const AUTHORIZATIONS_REL_PATH: string;
export const GUARD_MODULE_REL_PATH: string;
export const VERDICT_BINDING_ID: string;

export interface LegacyListGuardVerdict {
  verdict: 'pass' | 'fail';
  expected: 'pass' | 'fail';
  bindingId: string;
  addedPaths: string[];
  removedPaths: string[];
  changedGovernedFiles: string[];
  baseSha: string;
  headSha: string;
  authorization: { type: string; id: string } | null;
  reason: string;
  bootstrap: boolean;
  policyPass: boolean;
}

export function loadGovernedManifest(
  repoRoot: string,
  manifestRelPath?: string,
): Record<string, unknown>;

export function governedSurfacePaths(manifest: Record<string, unknown>): Set<string>;

export function unionGovernedSurfacePaths(
  ...manifests: Array<Record<string, unknown> | undefined>
): Set<string>;

export function validateManifestClosure(
  trustedRoot: string,
  manifest: Record<string, unknown>,
): { ok: boolean; errors: string[] };

export function validateBaseAndHeadManifestClosure(
  trustedRoot: string,
  headRoot: string,
  baseManifest: Record<string, unknown>,
): { ok: boolean; errors: string[]; headManifest?: Record<string, unknown> };

export function resolveRelativeImport(fromRel: string, spec: string): string;

export function extractLocalModuleSpecs(content: string): string[];

export function collectEntrypointDependencyClosure(
  trustedRoot: string,
  entrypointRel: string,
): Set<string>;

export function isGuardPresentOnBase(trustedRoot: string): boolean;

export function computeChangedGovernedFiles(
  changedFiles: string[],
  governed: Set<string>,
): string[];

export function detectLegacyListRelocation(
  nameStatus: Array<{ path: string; status: string; previousPath?: string }>,
  legacyListPath: string,
): boolean;

export function parseAuthorizationStore(store: unknown): Array<Record<string, unknown>>;

export function authorizationBaseShaMatches(
  authBaseSha: string,
  scope: { baseSha: string; baseParentSha?: string },
): boolean;

export function findMatchingAuthorization(
  authorizations: Array<Record<string, unknown>>,
  scope: {
    baseSha: string;
    baseParentSha?: string;
    headSha: string;
    addedPaths: string[];
    changedGovernedFiles: string[];
  },
): {
  authorization: { type: string; id: string };
  reason: string;
  id: string;
} | null;

export function evaluateLegacyListGuard(options: Record<string, unknown>): LegacyListGuardVerdict;

export function formatLegacyListGuardVerdict(verdict: LegacyListGuardVerdict): string;
