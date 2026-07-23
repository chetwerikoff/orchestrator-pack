import { createHash } from 'node:crypto';

export const ISSUE = 948;
export const FOUNDATION_COMMIT = 'b967dfe156838039e1d6d137e7064dc9d1b10b4d';
export const D928 = Object.freeze([
  'scripts/orchestrator-wake-supervisor.ps1',
  'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
  'scripts/lib/Review-StartClaim.ps1',
  'scripts/review-start-claim-reaper.ps1',
] as const);
export const TARGET_LIBRARIES = Object.freeze([
  'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
  'scripts/lib/Review-StartClaim.ps1',
] as const);
export const LIFECYCLE_LIBRARY = 'scripts/lib/Review-StartClaimLifecycle.ps1';
export const DENYLIST = Object.freeze([
  'vendor/', 'packages/core/', '.ao/', 'plugins/', 'prompts/', 'docs/issues_drafts/',
  'docs/declarations/', 'tests/external-output-references/', 'scripts/gh',
  'scripts/lib/gh-wrapper.mjs', 'scripts/lib/gh-governor.mjs', 'scripts/lib/gh-rest-routes.mjs',
  ...D928,
  'scripts/orchestrator-side-process-registry.json',
  'scripts/worker-message-submit-reconcile.ps1',
  'scripts/lib/Get-ReactionMessagesFromYaml.ps1',
  'scripts/reaction-config-messages.mjs',
  'scripts/reaction-config-messages.d.mts',
] as const);

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function normalizeRepoPath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+/gu, '/');
}

export interface TrackedFileRow {
  path: string;
  mode: string;
  blobSha: string;
  size: number;
  denominatorClass: 'command-bearing' | 'reachable-code' | 'reviewed-non-executable';
  executionClass: 'root' | 'reachable-helper' | 'explicitly-unsupported' | 'dead';
  rootChains: string[];
  evidence: string;
}

export interface ReferenceRow {
  source: string;
  target: string;
  line: number;
  primitiveClass: string;
  selector: string;
  sourceExecutionClass: TrackedFileRow['executionClass'];
  rootChains: string[];
  duty: string;
  disposition: 'retire' | 'decouple' | 'repoint' | 'target-internal';
  operation: 'add' | 'modify' | 'delete' | 'retain';
  expectedFinalState: string;
  review: 'approved';
}

export interface LifecycleRow {
  source: string;
  unitKind: 'function' | 'script-body';
  identity: string;
  line: number;
  reads: boolean;
  interprets: boolean;
  decides: boolean;
  mutates: boolean;
  persistedFields: string[];
  callers: string[];
  disposition: 'migrate' | 'retain-read-only' | 'retire' | 'target-internal';
  replacement: string;
  semanticTest: string;
  legacyProtocolDisposition: 'protocol-equivalent' | 'overlap-unsafe';
  legacyProtocolEvidence: string;
  rolloutBoundary: string;
  review: 'approved';
}

export interface PlanningManifest {
  schemaVersion: 1;
  issue: 948;
  repository: 'chetwerikoff/orchestrator-pack';
  lineage: { foundationCommit: string; planningCommit: string; planningBaseTreeOid: string };
  tooling: Record<string, string>;
  denominator: TrackedFileRow[];
  references: ReferenceRow[];
  lifecycle: LifecycleRow[];
  unknown: unknown[];
  dynamicUnsupported: unknown[];
  plannedOperations: Array<{ path: string; operation: 'add' | 'modify' | 'delete'; reason: string }>;
  d928Sha256: Record<string, string>;
  result: 'reviewed-complete-reverse-closure-plan';
  digest?: string;
}
