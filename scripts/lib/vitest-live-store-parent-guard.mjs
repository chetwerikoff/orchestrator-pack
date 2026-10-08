import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, watch } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  canonicalizeStorePath,
  classifyLiveStorePath,
  expandInventoryTemplate,
  liveStoreInventory,
  resolvedClassFences,
  resolvedLiveStores,
  startLiveStoreGuard,
} from './vitest-live-store-harness.mjs';

const MAX_PARENT_WATCHERS = 512;
// Residual: pathname-only exemption; fs.watch cannot prove writer provenance,
// so same-path child bypass of these files is accepted. The list covers live
// supervisor cadence writes and exact report/reconcile/observer state paths.
const EXTERNALLY_MUTABLE_STORE_PATHS = new Map([
  ['wake-supervisor-runtime-state', new Set([
    'worker-message-dispatch-journal.json',
    'typescript-supervisor-status.json',
    'supervisor/typescript-supervisor-status.json',
    'supervisor/projected-registry.json',
    'orchestration-mail-reconcile.json',
    'orchestration-mail-reconcile.lock',
  ])],
]);
const EXTERNALLY_MUTABLE_JOURNAL_STORE_ID = 'wake-supervisor-runtime-state';
const EXTERNALLY_MUTABLE_JOURNAL_PATH = 'worker-message-dispatch-journal.json';
const JOURNAL_ATOMIC_TEMP_PATH = /^\.[0-9a-f]{32}\.tmp$/i;
// writeDurableFile temp name: `.<basename>.<pid>.<uuid>.tmp` beside the target.
const SUPERVISOR_STATUS_ATOMIC_TEMP_PATH = /^\.(?:typescript-supervisor-status|projected-registry)\.json\.\d+\.[0-9a-f-]{36}\.tmp$/i;
const FLEET_OBSERVER_ATOMIC_TEMP_PATH = /^\.(?:tmp|restore)-\d+-\d+-[0-9a-f]{8}$/i;
function projectScopedPath(relativePath) {
  const separator = relativePath.indexOf('/');
  if (separator <= 0) return '';
  const projectId = relativePath.slice(0, separator);
  if (projectId === '.' || projectId === '..' || projectId.includes(String.fromCharCode(92))) return '';
  return relativePath.slice(separator + 1);
}
function isExternallyMutableWakePath(relativePath) {
  const allowed = EXTERNALLY_MUTABLE_STORE_PATHS.get(EXTERNALLY_MUTABLE_JOURNAL_STORE_ID) ?? new Set();
  const projectPath = projectScopedPath(relativePath);
  return allowed.has(relativePath)
    || projectPath === 'worker-report-store.json'
    || projectPath === 'orchestration-mail-reconcile.json'
    || projectPath === 'orchestration-mail-reconcile.lock'
    || projectPath === 'supervisor/typescript-supervisor-status.json'
    || projectPath === 'supervisor/projected-registry.json'
    || projectPath === 'fleet-observer-snapshot.json'
    || projectPath === 'scheduler-tick-phases.jsonl';
}
function isExternallyMutableWakeSidecarPath(relativePath) {
  const projectPath = projectScopedPath(relativePath);
  return relativePath === `${EXTERNALLY_MUTABLE_JOURNAL_PATH}.lock`
    || JOURNAL_ATOMIC_TEMP_PATH.test(relativePath)
    || SUPERVISOR_STATUS_ATOMIC_TEMP_PATH.test(relativePath)
    || projectPath === 'worker-report-store.lock'
    || projectPath === 'worker-report-store.json.tmp'
    || (projectPath !== '' && FLEET_OBSERVER_ATOMIC_TEMP_PATH.test(projectPath))
    || (projectPath.startsWith('supervisor/')
      && SUPERVISOR_STATUS_ATOMIC_TEMP_PATH.test(projectPath.slice('supervisor/'.length)));
}
function isParentOfAllowedWakePath(path, candidates) {
  return candidates.some((candidate) => candidate.startsWith(`${path}/`)
    && (isExternallyMutableWakePath(candidate) || isExternallyMutableWakeSidecarPath(candidate)));
}
function isNewAllowedWakeDirectory(path, candidates, beforeSnapshot, afterSnapshot) {
  return beforeSnapshot?.get(path) === undefined
    && afterSnapshot?.get(path) === 'directory'
    && isParentOfAllowedWakePath(path, candidates);
}
function pathIsSameOrWithin(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function nearestExistingDirectory(candidate) {
  let cursor = candidate;
  while (cursor && !existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return '';
    cursor = parent;
  }
  return cursor;
}

function transientFailureId(failure) {
  const suffix = ':transient_write_observed';
  return failure.endsWith(suffix) ? failure.slice(0, -suffix.length) : '';
}

function storeRelativePath(store, candidate) {
  return relative(store.defaultPath, candidate).replaceAll('\\', '/');
}

function externallyMutablePath(match, env) {
  if (match?.storeId !== EXTERNALLY_MUTABLE_JOURNAL_STORE_ID || !match.store) return false;
  const relativePath = storeRelativePath(match.store, match.candidate);
  return isExternallyMutableWakePath(relativePath, env.OPK_PROJECT_ID);
}

function externallyMutableSidecarPath(match, env) {
  if (match?.storeId !== EXTERNALLY_MUTABLE_JOURNAL_STORE_ID || !match.store) return false;
  const relativePath = storeRelativePath(match.store, match.candidate);
  return isExternallyMutableWakeSidecarPath(relativePath, env.OPK_PROJECT_ID);
}

function snapshotTree(root) {
  const snapshot = new Map();
  const visit = (candidate) => {
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      snapshot.set(candidate, 'missing');
      return;
    }
    if (stat.isDirectory()) {
      snapshot.set(candidate, 'directory');
      let entries;
      try {
        entries = readdirSync(candidate);
      } catch {
        snapshot.set(candidate, 'directory:unreadable');
        return;
      }
      for (const entry of entries) visit(join(candidate, entry));
      return;
    }
    if (stat.isFile()) {
      try {
        const digest = createHash('sha256').update(readFileSync(candidate)).digest('hex');
        snapshot.set(candidate, `file:${digest}`);
      } catch {
        snapshot.set(candidate, 'file:unreadable');
      }
      return;
    }
    snapshot.set(candidate, `other:${stat.mode}:${stat.size}`);
  };
  visit(root);
  return snapshot;
}

function changedSnapshotPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path));
}
function relativeSnapshot(store, snapshot) {
  return new Map([...snapshot].map(([path, value]) => [storeRelativePath(store, path), value]));
}

export function isExternalJournalSnapshotOnlyChange(changedPaths, observedPaths = new Set()) {
  const changed = [...changedPaths];
  const journalOnly = changed.every((path) => path === EXTERNALLY_MUTABLE_JOURNAL_PATH);
  return journalOnly && (observedPaths.has(EXTERNALLY_MUTABLE_JOURNAL_PATH) || changed.length > 0);
}

export function isExternalWakeSupervisorSnapshotOnlyChange(
  changedPaths,
  _projectId = '',
  beforeSnapshot = new Map(),
  afterSnapshot = new Map(),
) {
  const changed = [...changedPaths].filter((path) => path !== '');
  return changed.length > 0 && changed.every((path) =>
    isExternallyMutableWakePath(path)
      || isExternallyMutableWakeSidecarPath(path)
      || isNewAllowedWakeDirectory(path, changed, beforeSnapshot, afterSnapshot),
  );
}

export function startParentLiveStoreGuard(env = process.env) {
  const baselineGuard = startLiveStoreGuard(env);
  const stores = resolvedLiveStores(env);
  const fences = resolvedClassFences(env);
  const roots = (liveStoreInventory.liveRoots ?? [])
    .filter((root) => root.watchTransient !== false)
    .map((root) => canonicalizeStorePath(expandInventoryTemplate(root.defaultTemplate, env)))
    .filter(Boolean);
  const targets = new Set([
    ...stores.map((store) => (store.kind === 'pattern' ? store.defaultPath : store.parentPath)),
    ...fences.filter((fence) => fence.watchTransient !== false).map((fence) => fence.rootPath),
    ...roots,
  ]);
  const beforeSnapshots = new Map(
    stores.map((store) => [store.id, snapshotTree(store.defaultPath)]),
  );
  const exactTouches = new Map();
  const observedExternalTouches = new Map();
  const observedJournalSidecars = new Map();
  const watchers = [];
  const watched = new Set();

  const addTouch = (touches, storeId, path) => {
    let paths = touches.get(storeId);
    if (!paths) {
      paths = new Set();
      touches.set(storeId, paths);
    }
    paths.add(path);
  };

  const armTree = (root) => {
    const anchor = nearestExistingDirectory(root);
    if (!anchor || watched.has(anchor) || watched.size >= MAX_PARENT_WATCHERS) return;
    watched.add(anchor);
    try {
      const handle = watch(anchor, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;
        const candidate = canonicalizeStorePath(join(anchor, String(filename)));
        const match = classifyLiveStorePath(candidate, env);
        if (match) {
          const path = storeRelativePath(match.store, match.candidate);
          if (externallyMutablePath(match, env)) addTouch(observedExternalTouches, match.storeId, path);
          else if (externallyMutableSidecarPath(match, env)) {
            addTouch(observedJournalSidecars, match.storeId, path);
          } else addTouch(exactTouches, match.storeId, path);
        }

        let candidateIsDirectory = false;
        try {
          candidateIsDirectory = lstatSync(candidate).isDirectory();
        } catch {
          // A concurrent delete is still covered by the event already observed.
        }
        if (candidateIsDirectory) {
          armTree(candidate);
          try {
            for (const entry of readdirSync(candidate, { withFileTypes: true })) {
              if (entry.isDirectory()) armTree(join(candidate, entry.name));
            }
          } catch {
            // A concurrent delete is still covered by the event already observed.
          }
        }
        for (const target of targets) {
          if (candidate && pathIsSameOrWithin(target, candidate)) armTree(target);
        }
      });
      watchers.push(handle);
    } catch {
      // The baseline hash guard remains authoritative when watch is unavailable.
    }
  };

  for (const target of targets) armTree(target);

  return {
    stop() {
      for (const handle of watchers) handle.close();
      let baselineFailures = [];
      try {
        baselineGuard.stop();
      } catch (error) {
        if (error?.code !== 'OPK_VITEST_LIVE_STORE_GUARD_FAILED') throw error;
        baselineFailures = Array.isArray(error.failures) ? [...error.failures] : [];
      }

      const afterSnapshots = new Map(
        stores.map((store) => [store.id, snapshotTree(store.defaultPath)]),
      );
      const relativeBeforeSnapshots = new Map(
        stores.map((store) => [
          store.id,
          relativeSnapshot(store, beforeSnapshots.get(store.id) ?? new Map()),
        ]),
      );
      const relativeAfterSnapshots = new Map(
        stores.map((store) => [store.id, relativeSnapshot(store, afterSnapshots.get(store.id) ?? new Map())]),
      );
      const changedPathsByStore = new Map(
        stores.map((store) => [
          store.id,
          changedSnapshotPaths(
            relativeBeforeSnapshots.get(store.id) ?? new Map(),
            relativeAfterSnapshots.get(store.id) ?? new Map(),
          ),
        ]),
      );
      const externallySettledStores = new Set();
      for (const store of stores) {
        const observed = observedExternalTouches.get(store.id);
        const changed = changedPathsByStore.get(store.id) ?? [];
        if (store.id === EXTERNALLY_MUTABLE_JOURNAL_STORE_ID
          && (isExternalJournalSnapshotOnlyChange(changed, observed ?? new Set())
            || isExternalWakeSupervisorSnapshotOnlyChange(
              changed,
              env.OPK_PROJECT_ID,
              relativeBeforeSnapshots.get(store.id),
              relativeAfterSnapshots.get(store.id),
            ))) {
          externallySettledStores.add(store.id);
        }
      }
      for (const store of stores) {
        if (!externallySettledStores.has(store.id)) continue;
        const touches = exactTouches.get(store.id);
        if (!touches) continue;
        const changed = changedPathsByStore.get(store.id) ?? [];
        const before = relativeBeforeSnapshots.get(store.id);
        const after = relativeAfterSnapshots.get(store.id);
        for (const path of touches) {
          if (isNewAllowedWakeDirectory(path, changed, before, after)) touches.delete(path);
        }
        if (touches.size === 0) exactTouches.delete(store.id);
      }
      for (const [storeId, sidecars] of observedJournalSidecars) {
        if (!externallySettledStores.has(storeId)) {
          for (const path of sidecars) addTouch(exactTouches, storeId, path);
        }
      }

      const retained = baselineFailures.filter((failure) => {
        const text = String(failure);
        const snapshotId = text.endsWith(':snapshot_changed')
          ? text.slice(0, -':snapshot_changed'.length)
          : '';
        if (snapshotId && externallySettledStores.has(snapshotId)) return false;
        const id = transientFailureId(String(failure));
        if (id && externallySettledStores.has(id)) return false;
        return !id || exactTouches.has(id);
      });
      for (const id of exactTouches.keys()) {
        const failure = `${id}:transient_write_observed`;
        if (!retained.includes(failure)) retained.push(failure);
      }
      if (retained.length > 0) {
        const changedPathDetails = [...changedPathsByStore.entries()]
          .filter(([storeId, paths]) => paths.length > 0 && retained.includes(`${storeId}:snapshot_changed`))
          .map(([storeId, paths]) => `${storeId}=${JSON.stringify(paths)}`)
          .join(' ');
        const detail = changedPathDetails ? ` changed_paths=${changedPathDetails}` : '';
        const error = new Error(`OPK_VITEST_LIVE_STORE_GUARD_FAILED ${retained.join(',')}${detail}`);
        error.code = 'OPK_VITEST_LIVE_STORE_GUARD_FAILED';
        error.failures = retained;
        throw error;
      }
    },
  };
}
