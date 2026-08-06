import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const inventoryPath = join(repoRoot, 'scripts', 'vitest-live-store-inventory.json');
export const liveStoreInventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));

const MAX_WATCHED_DIRECTORIES = 512;

function envValue(env, name, fallback = '') {
  const value = String(env?.[name] ?? '').trim();
  return value || fallback;
}

function productionHome(env = process.env) {
  return resolve(envValue(env, 'OPK_VITEST_PRODUCTION_HOME', envValue(env, 'HOME', homedir())));
}

function productionTmp(env = process.env) {
  return resolve(envValue(env, 'OPK_VITEST_PRODUCTION_TMP', envValue(env, 'TMPDIR', tmpdir())));
}

function productionWakeRoot(env = process.env) {
  const explicit = envValue(
    env,
    'OPK_VITEST_PRODUCTION_WAKE_ROOT',
    envValue(env, 'OPK_WAKE_SUPERVISOR_STATE_DIR', envValue(env, 'ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR')),
  );
  if (explicit) return resolve(explicit);
  const xdg = envValue(env, 'XDG_STATE_HOME', join(productionHome(env), '.local', 'state'));
  return resolve(xdg, 'orchestrator-pack-wake-supervisor');
}

function productionPackBase(env = process.env) {
  const explicit = envValue(
    env,
    'OPK_VITEST_PRODUCTION_OPK_BASE',
    envValue(env, 'OPK_BASE_DIR'),
  );
  return resolve(explicit || join(productionHome(env), '.orchestrator-pack'));
}

export function expandInventoryTemplate(template, env = process.env) {
  const values = {
    HOME: productionHome(env),
    TMP: productionTmp(env),
    WAKE_STATE: productionWakeRoot(env),
    OPK_BASE: productionPackBase(env),
  };
  return String(template ?? '').replace(/\$\{([A-Z_]+)\}/g, (_match, key) => values[key] ?? '');
}

export function canonicalizeStorePath(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return resolve(text.replace(/^~(?=$|[\\/])/, homedir()));
}

function pathIsSameOrWithin(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function wildcardToRegExp(pattern) {
  const normalized = String(pattern ?? '').replaceAll('\\', '/');
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('**', '.*').replaceAll('*', '[^/]*')}$`, 'i');
}

function resolveStore(store, env) {
  const defaultPath = canonicalizeStorePath(expandInventoryTemplate(store.canonicalDefault, env));
  const parentPath = store.kind === 'directory' ? dirname(defaultPath) : dirname(defaultPath);
  const sidecarMatchers = (store.sidecars ?? []).map(wildcardToRegExp);
  return {
    ...store,
    defaultPath,
    parentPath,
    sidecarMatchers,
  };
}

export function resolvedLiveStores(env = process.env) {
  return (liveStoreInventory.stores ?? [])
    .filter((store) => !store.excluded)
    .map((store) => resolveStore(store, env));
}

export function resolvedClassFences(env = process.env) {
  return (liveStoreInventory.classFences ?? []).map((fence) => ({
    ...fence,
    rootPath: canonicalizeStorePath(expandInventoryTemplate(fence.rootTemplate, env)),
    matchers: (fence.basenamePatterns ?? []).map(wildcardToRegExp),
  }));
}

function relativeNormalized(root, candidate) {
  return relative(root, candidate).replaceAll('\\', '/');
}

export function classifyLiveStorePath(candidatePath, env = process.env) {
  const candidate = canonicalizeStorePath(candidatePath);
  if (!candidate) return null;

  for (const store of resolvedLiveStores(env)) {
    if (store.kind === 'directory' && pathIsSameOrWithin(candidate, store.defaultPath)) {
      return { storeId: store.id, store, candidate, relativePath: relativeNormalized(store.defaultPath, candidate) };
    }
    if (store.kind !== 'directory' && candidate === store.defaultPath) {
      return { storeId: store.id, store, candidate, relativePath: '' };
    }
    if (store.sidecarMatchers.length > 0 && pathIsSameOrWithin(candidate, store.parentPath)) {
      const rel = relativeNormalized(store.parentPath, candidate);
      if (store.sidecarMatchers.some((matcher) => matcher.test(rel))) {
        return { storeId: store.id, store, candidate, relativePath: rel, sidecar: true };
      }
    }
  }

  for (const fence of resolvedClassFences(env)) {
    if (!pathIsSameOrWithin(candidate, fence.rootPath)) continue;
    const rel = relativeNormalized(fence.rootPath, candidate);
    if (fence.matchers.some((matcher) => matcher.test(rel))) {
      return { storeId: fence.id, fence, candidate, relativePath: rel, classFence: true };
    }
  }
  return null;
}

function harnessRoot(env = process.env) {
  const value = envValue(env, 'OPK_VITEST_HARNESS_ROOT');
  return value ? canonicalizeStorePath(value) : '';
}

function harnessStorePath(match, env) {
  const root = harnessRoot(env);
  if (!root) return '';
  if (match.store) {
    const base = resolve(root, match.store.harnessPath || join('state', match.store.id));
    if (match.store.kind === 'directory') return match.relativePath ? resolve(base, match.relativePath) : base;
    if (match.sidecar) return resolve(dirname(base), match.relativePath);
    return base;
  }
  return resolve(root, 'state', 'class-fences', match.storeId, match.relativePath || basename(match.candidate));
}

export function redirectHarnessWritePath(candidatePath, operation = 'write', env = process.env) {
  if (env.OPK_VITEST_HARNESS !== '1') return candidatePath;
  const match = classifyLiveStorePath(candidatePath, env);
  if (!match) return candidatePath;
  const redirected = harnessStorePath(match, env);
  if (!redirected) {
    const error = new Error(`OPK_VITEST_LIVE_STORE_BLOCKED ${operation}: missing harness root`);
    error.code = 'OPK_VITEST_LIVE_STORE_BLOCKED';
    throw error;
  }
  mkdirSync(dirname(redirected), { recursive: true, mode: 0o700 });
  return redirected;
}

export function assertHarnessWritePathSafe(candidatePath, operation = 'write', env = process.env) {
  if (env.OPK_VITEST_HARNESS !== '1') return candidatePath;
  const candidate = canonicalizeStorePath(candidatePath);
  const root = harnessRoot(env);
  if (root && pathIsSameOrWithin(candidate, root)) return candidatePath;
  const match = classifyLiveStorePath(candidate, env);
  if (!match) return candidatePath;
  const error = new Error(`OPK_VITEST_LIVE_STORE_BLOCKED ${operation}: ${candidate}`);
  error.code = 'OPK_VITEST_LIVE_STORE_BLOCKED';
  error.storeId = match.storeId;
  error.path = candidate;
  throw error;
}

export function createHarnessRoot() {
  const root = mkdtempSync(join(tmpdir(), 'opk-vitest-'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function setStoreOverrides(root, env) {
  for (const store of liveStoreInventory.stores ?? []) {
    const target = resolve(root, store.harnessPath || join('state', store.id));
    if (store.kind === 'directory') mkdirSync(target, { recursive: true, mode: 0o700 });
    else mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    for (const name of store.envOverrides ?? []) env[name] = target;
  }
}

export function applyOpkVitestHarnessEnv(rootPath, env = process.env) {
  const root = canonicalizeStorePath(rootPath);
  if (!root) throw new Error('harness root is required');

  const originalHome = productionHome(env);
  const originalTmp = productionTmp(env);
  const originalWake = productionWakeRoot(env);
  const originalPackBase = productionPackBase(env);
  const home = join(root, 'home');
  const state = join(root, 'state');
  const tmp = join(root, 'tmp');
  const wake = join(root, 'wake');
  const packState = join(root, 'pack-state');
  const transport = join(root, 'transport');
  const operatorInbox = join(root, 'operator-inbox');
  const healthSpool = join(root, 'health-spool');

  for (const path of [root, home, state, tmp, wake, packState, transport, operatorInbox, healthSpool]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  Object.assign(env, {
    OPK_VITEST_HARNESS: '1',
    OPK_VITEST_HARNESS_ROOT: root,
    OPK_VITEST_HARNESS_INVENTORY: inventoryPath,
    OPK_VITEST_PRODUCTION_HOME: originalHome,
    OPK_VITEST_PRODUCTION_TMP: originalTmp,
    OPK_VITEST_PRODUCTION_WAKE_ROOT: originalWake,
    OPK_VITEST_PRODUCTION_OPK_BASE: originalPackBase,
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: state,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    OPK_BASE_DIR: packState,
    OPK_WAKE_SUPERVISOR_STATE_DIR: wake,
    ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: wake,
    OPK_SIDE_PROCESS_STATE_DIR: wake,
    OPK_MECHANICAL_TRANSPORT_TEMP: transport,
    OPK_OPERATOR_ESCALATION_INBOX: operatorInbox,
    OPK_ESCALATION_HEALTH_SPOOL: healthSpool,
    OPK_ORCHESTRATOR_ESCALATION_STATE: join(state, 'orchestrator-escalation-state.json'),
    OPK_WORKER_MESSAGE_DISPATCH_JOURNAL: join(wake, 'worker-message-dispatch-journal.json'),
    OPK_WORKER_MESSAGE_SUBMIT_STATE: join(state, 'orchestrator-worker-message-submit-state.json'),
    OPK_WORKER_STATUS_STORE: join(wake, 'worker-status-store.json'),
    OPK_WORKER_REPORT_STORE: join(wake, 'worker-report-store.json'),
    OPK_PR_SESSION_BINDING_CACHE: join(wake, 'pr-session-binding-cache.json'),
    OPK_REVIEW_CLAIM_DIR: join(packState, 'projects', 'orchestrator-pack', 'review-start-claims'),
    OPK_WORKER_NUDGE_CLAIM_DIR: join(packState, 'projects', 'orchestrator-pack', 'worker-nudge-claims'),
    OPK_REPORT_STATE_SEED_STATE: join(state, 'orchestrator-review-ready-report-state-seed-state.json'),
    OPK_REVIEW_TRIGGER_REEVAL_WATCH_STATE: join(state, 'orchestrator-review-trigger-reeval-watch.json'),
    OPK_CI_GREEN_WAKE_RECONCILE_STATE: join(state, 'orchestrator-ci-green-wake-state.json'),
    OPK_DEAD_WORKER_RECONCILE_STATE: join(wake, 'orchestrator-dead-worker-reconcile-state.json'),
    OPK_REVIEW_TRIGGER_RECONCILE_STATE: join(state, 'orchestrator-review-reconcile-state.json'),
    OPK_WAKE_DEDUP_STATE: join(state, 'orchestrator-wake-dedup.json'),
  });
  setStoreOverrides(root, env);
  return { root, home, state, tmp, wake, packState, transport, operatorInbox, healthSpool };
}

function hashPath(path) {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path);
  const hash = createHash('sha256');
  const walk = (candidate, prefix = '') => {
    const current = lstatSync(candidate);
    if (current.isDirectory()) {
      for (const entry of readdirSync(candidate, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = join(candidate, entry.name);
        const rel = join(prefix, entry.name).replaceAll('\\', '/');
        hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${rel}\n`);
        walk(child, rel);
      }
    } else if (current.isFile()) {
      hash.update(readFileSync(candidate));
    }
  };
  walk(path);
  return {
    exists: true,
    type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    hash: hash.digest('hex'),
    size: stat.isFile() ? statSync(path).size : undefined,
  };
}

function snapshotStore(store) {
  const paths = new Set([store.defaultPath]);
  if (existsSync(store.parentPath)) {
    for (const name of readdirSync(store.parentPath)) {
      if (store.sidecarMatchers.some((matcher) => matcher.test(name.replaceAll('\\', '/')))) {
        paths.add(join(store.parentPath, name));
      }
    }
  }
  return [...paths].sort().map((path) => [path, hashPath(path)]);
}

export function startLiveStoreGuard(env = process.env) {
  const stores = resolvedLiveStores(env);
  const before = new Map(stores.map((store) => [store.id, snapshotStore(store)]));
  const touched = new Set();
  const watchers = [];
  const watched = new Set();

  const arm = (path) => {
    let anchor = path;
    while (anchor && !existsSync(anchor)) {
      const parent = dirname(anchor);
      if (parent === anchor) return;
      anchor = parent;
    }
    if (!anchor || watched.has(anchor) || watched.size >= MAX_WATCHED_DIRECTORIES) return;
    watched.add(anchor);
    try {
      const handle = watch(anchor, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        const candidate = canonicalizeStorePath(join(anchor, String(filename)));
        const match = classifyLiveStorePath(candidate, env);
        if (match) touched.add(match.storeId);
      });
      watchers.push(handle);
    } catch {
      // Snapshot comparison remains authoritative when watch is unavailable.
    }
  };

  for (const store of stores) arm(store.kind === 'directory' ? store.defaultPath : store.parentPath);
  for (const fence of resolvedClassFences(env)) arm(fence.rootPath);

  return {
    stop() {
      for (const handle of watchers) handle.close();
      const failures = [];
      for (const store of stores) {
        if (JSON.stringify(before.get(store.id)) !== JSON.stringify(snapshotStore(store))) {
          failures.push(`${store.id}:snapshot_changed`);
        }
        if (touched.has(store.id)) failures.push(`${store.id}:transient_write_observed`);
      }
      if (failures.length > 0) {
        const error = new Error(`OPK_VITEST_LIVE_STORE_GUARD_FAILED ${failures.join(',')}`);
        error.code = 'OPK_VITEST_LIVE_STORE_GUARD_FAILED';
        error.failures = failures;
        throw error;
      }
    },
  };
}

export function cleanupHarnessRoot(rootPath) {
  if (!rootPath) return;
  const root = canonicalizeStorePath(rootPath);
  const temp = canonicalizeStorePath(tmpdir());
  if (!pathIsSameOrWithin(root, temp) || !basename(root).startsWith('opk-vitest-')) {
    throw new Error('refusing to cleanup non-harness root');
  }
  rmSync(root, { recursive: true, force: true });
}

export function makeInvocationToken() {
  return `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}
