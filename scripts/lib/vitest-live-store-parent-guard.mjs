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
// so same-path child bypass of this journal is accepted.
const EXTERNALLY_MUTABLE_STORE_PATHS = new Map([
  ['wake-supervisor-runtime-state', new Set(['worker-message-dispatch-journal.json'])],
]);
const EXTERNALLY_MUTABLE_JOURNAL_STORE_ID = 'wake-supervisor-runtime-state';
const EXTERNALLY_MUTABLE_JOURNAL_PATH = 'worker-message-dispatch-journal.json';
const JOURNAL_ATOMIC_TEMP_PATH = /^\.[0-9a-f]{32}\.tmp$/i;
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

function externallyMutablePath(match) {
  if (!match?.store) return false;
  const allowed = EXTERNALLY_MUTABLE_STORE_PATHS.get(match.storeId);
  if (!allowed) return false;
  return allowed.has(storeRelativePath(match.store, match.candidate));
}

function externallyMutableJournalSidecarPath(match) {
  if (match?.storeId !== EXTERNALLY_MUTABLE_JOURNAL_STORE_ID || !match.store) return false;
  const relativePath = storeRelativePath(match.store, match.candidate);
  return relativePath === `${EXTERNALLY_MUTABLE_JOURNAL_PATH}.lock`
    || JOURNAL_ATOMIC_TEMP_PATH.test(relativePath);
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

export function isExternalJournalSnapshotOnlyChange(changedPaths, observedPaths = new Set()) {
  const changed = [...changedPaths];
  const journalOnly = changed.every((path) => path === EXTERNALLY_MUTABLE_JOURNAL_PATH);
  return journalOnly && (observedPaths.has(EXTERNALLY_MUTABLE_JOURNAL_PATH) || changed.length > 0);
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
          if (externallyMutablePath(match)) addTouch(observedExternalTouches, match.storeId, path);
          else if (externallyMutableJournalSidecarPath(match)) {
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

      const changedPathsByStore = new Map(
        stores.map((store) => [
          store.id,
          changedSnapshotPaths(
            beforeSnapshots.get(store.id) ?? new Map(),
            snapshotTree(store.defaultPath),
          ).map((path) => storeRelativePath(store, path)),
        ]),
      );
      const externallySettledStores = new Set();
      for (const store of stores) {
        const observed = observedExternalTouches.get(store.id);
        const changed = changedPathsByStore.get(store.id) ?? [];
        if (store.id === EXTERNALLY_MUTABLE_JOURNAL_STORE_ID
          && isExternalJournalSnapshotOnlyChange(changed, observed ?? new Set())) {
          externallySettledStores.add(store.id);
        }
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
        const error = new Error(`OPK_VITEST_LIVE_STORE_GUARD_FAILED ${retained.join(',')}`);
        error.code = 'OPK_VITEST_LIVE_STORE_GUARD_FAILED';
        error.failures = retained;
        throw error;
      }
    },
  };
}
