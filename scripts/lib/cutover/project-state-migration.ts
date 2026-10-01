import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { publishCommittedProjectStateBinding } from '../project-state-binding.ts';
import type { ActivationRequest, CutoverStoreKind, CutoverStoreSpec } from './types.ts';

const PROJECT_BINDING_FILE = 'project-binding.json';

function migrationSpec(
  id: string,
  sourcePath: string,
  targetPath: string,
  kind: Exclude<CutoverStoreKind, 'legacy-json'>,
): CutoverStoreSpec {
  return { id, sourcePath, targetPath, kind, coveredFields: [] };
}

function observedKind(sourcePath: string, targetPath: string): 'opaque-file' | 'opaque-directory' | null {
  const observed = existsSync(sourcePath) ? sourcePath : (existsSync(targetPath) ? targetPath : null);
  if (!observed) return null;
  const stat = lstatSync(observed);
  if (stat.isFile()) return 'opaque-file';
  if (stat.isDirectory()) return 'opaque-directory';
  throw new Error(`project_migration_store_type_unsupported:${observed}`);
}

function unionEntryNames(sourceRoot: string, targetRoot: string, include: (name: string) => boolean): string[] {
  const names = new Set<string>();
  for (const root of [sourceRoot, targetRoot]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (include(entry.name)) names.add(entry.name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function addStore(
  stores: CutoverStoreSpec[],
  candidate: CutoverStoreSpec,
): void {
  const target = path.resolve(candidate.targetPath);
  const existing = stores.find((store) => path.resolve(store.targetPath) === target);
  if (!existing) {
    stores.push(candidate);
    return;
  }
  if (
    path.resolve(existing.sourcePath) !== path.resolve(candidate.sourcePath)
    || (existing.kind ?? 'legacy-json') !== candidate.kind
  ) {
    throw new Error(`project_migration_target_conflict:${candidate.id}`);
  }
}

function addFixedWakeStores(stores: CutoverStoreSpec[], flatRoot: string, projectRoot: string): void {
  const fixed = [
    ['worker-status-store', 'worker-status-store.json', 'opaque-file'],
    ['worker-report-store', 'worker-report-store.json', 'opaque-file'],
    ['pr-session-binding-cache', 'pr-session-binding-cache.json', 'opaque-file'],
    ['worker-smoke-receipts', 'worker-smoke-receipts', 'opaque-directory'],
    ['worker-message-dispatch-journal', 'worker-message-dispatch-journal.json', 'opaque-file'],
    ['dispatch-terminal-mail-ledger', 'dispatch-terminal-mail-ledger.json', 'opaque-file'],
    ['orchestration-mail-reconcile', 'orchestration-mail-reconcile.json', 'opaque-file'],
    ['fleet-observer-snapshot', 'fleet-observer-snapshot.json', 'opaque-file'],
    ['worker-recovery', 'worker-recovery', 'opaque-directory'],
  ] as const;
  for (const [id, name, kind] of fixed) {
    addStore(stores, migrationSpec(
      `project-${id}`,
      path.join(flatRoot, name),
      path.join(projectRoot, name),
      kind,
    ));
  }
}

function addDiscussStores(stores: CutoverStoreSpec[], localStateRoot: string, projectId: string): void {
  const sourceRoot = path.join(localStateRoot, 'discuss-with-gpt');
  const targetRoot = path.join(sourceRoot, projectId);
  const names = unionEntryNames(sourceRoot, targetRoot, (name) =>
    name !== projectId
    && name !== PROJECT_BINDING_FILE
    && !name.endsWith('.cutover-import.json')
    && !name.includes('.cutover-staging-')
    && !/^cdp-\d+-owner\.json$/u.test(name)
    && !existsSync(path.join(sourceRoot, name, PROJECT_BINDING_FILE)));
  names.forEach((name, index) => {
    const sourcePath = path.join(sourceRoot, name);
    const targetPath = path.join(targetRoot, name);
    const kind = observedKind(sourcePath, targetPath);
    if (!kind) return;
    addStore(stores, migrationSpec(`project-discuss-artifact-${index + 1}`, sourcePath, targetPath, kind));
  });
}

/**
 * Adds only payload-state moves. Cordon/epoch/supervisor control-plane files are
 * intentionally excluded: the existing activation transaction recreates those
 * under the selected project root and remains their sole commit/recovery authority.
 */
export function withPackProjectStateMigration(
  request: ActivationRequest,
  projectId: string,
  options: { localStateRoot?: string } = {},
): ActivationRequest {
  if (projectId !== 'orchestrator-pack') return request;
  const projectRoot = path.resolve(request.paths.stateDir);
  const flatWakeRoot = path.dirname(projectRoot);
  const localStateRoot = path.resolve(options.localStateRoot ?? path.join(process.env.HOME || homedir(), '.local', 'state'));
  const stores = request.stores.map((store) => ({ ...store, coveredFields: [...store.coveredFields] }));

  addFixedWakeStores(stores, flatWakeRoot, projectRoot);
  addDiscussStores(stores, localStateRoot, projectId);

  return { ...request, stores };
}

/** Bind all committed project namespaces using the existing epoch-CAS authority. */
export function publishCommittedProjectNamespaceBindings(request: ActivationRequest): void {
  if (!request.projectId || !request.repository) return;
  const namespaces = new Set<string>([path.resolve(request.paths.stateDir)]);
  for (const store of request.stores) {
    if (store.id === 'project-create-issue-review'
      || store.id === 'project-browser-turn-recurrence'
      || store.id.startsWith('project-create-issue-work-')
      || store.id.startsWith('project-discuss-artifact-')) {
      namespaces.add(path.resolve(path.dirname(store.targetPath)));
    }
  }
  for (const root of namespaces) {
    publishCommittedProjectStateBinding(root, { projectId: request.projectId, repository: request.repository });
  }
}
