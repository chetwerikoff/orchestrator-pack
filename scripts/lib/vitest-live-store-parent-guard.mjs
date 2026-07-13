import { existsSync, readdirSync, watch } from 'node:fs';
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
  const exactTouches = new Set();
  const watchers = [];
  const watched = new Set();

  const armTree = (root) => {
    const anchor = nearestExistingDirectory(root);
    if (!anchor || watched.has(anchor) || watched.size >= MAX_PARENT_WATCHERS) return;
    watched.add(anchor);
    try {
      const handle = watch(anchor, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;
        const candidate = canonicalizeStorePath(join(anchor, String(filename)));
        const match = classifyLiveStorePath(candidate, env);
        if (match) exactTouches.add(match.storeId);

        if (existsSync(candidate)) {
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

      const retained = baselineFailures.filter((failure) => {
        const id = transientFailureId(String(failure));
        return !id || exactTouches.has(id);
      });
      for (const id of exactTouches) {
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
