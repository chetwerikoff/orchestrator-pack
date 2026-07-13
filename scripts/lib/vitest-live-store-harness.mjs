import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  watch,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPK_VITEST_HARNESS_MARKER = 'OPK_VITEST_HARNESS';
export const OPK_VITEST_HARNESS_ROOT = 'OPK_VITEST_HARNESS_ROOT';

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(moduleDir, '..', '..');
export const inventoryPath = join(repoRoot, 'scripts', 'vitest-live-store-inventory.json');
const STALE_ROOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_ROOT_MAX_REMOVALS = 16;
const MAX_WATCHED_DIRECTORIES = 512;

function readInventory() {
  const parsed = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.stores)) {
    throw new Error('invalid vitest live-store inventory');
  }
  return parsed;
}

export const liveStoreInventory = readInventory();

function resolveProductionHome(env) {
  return env.OPK_VITEST_PRODUCTION_HOME || env.HOME || homedir();
}

function resolveProductionTmp(env) {
  return env.OPK_VITEST_PRODUCTION_TMP || env.TMPDIR || env.TEMP || env.TMP || tmpdir();
}

function resolveProductionAoBase(env) {
  return env.OPK_VITEST_PRODUCTION_AO_BASE
    || env.AO_BASE_DIR
    || join(resolveProductionHome(env), '.agent-orchestrator');
}

function resolveProductionWakeRoot(env) {
  if (env.OPK_VITEST_PRODUCTION_WAKE_ROOT) return env.OPK_VITEST_PRODUCTION_WAKE_ROOT;
  if (env.AO_WAKE_SUPERVISOR_STATE_DIR) return env.AO_WAKE_SUPERVISOR_STATE_DIR;
  if (env.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR) {
    return env.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR;
  }
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'orchestrator-pack-wake-supervisor');
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'orchestrator-pack-wake-supervisor');
  return join(resolveProductionHome(env), '.local', 'state', 'orchestrator-pack-wake-supervisor');
}

export function expandInventoryTemplate(value, env = process.env) {
  return String(value ?? '')
    .replaceAll('${HOME}', resolveProductionHome(env))
    .replaceAll('${TMP}', resolveProductionTmp(env))
    .replaceAll('${AO_BASE}', resolveProductionAoBase(env))
    .replaceAll('${WAKE_STATE}', resolveProductionWakeRoot(env));
}

function normalizeCase(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function nearestExistingAncestor(candidate) {
  let cursor = candidate;
  const suffix = [];
  while (true) {
    try {
      let canonical = realpathSync.native(cursor);
      for (const part of suffix) canonical = join(canonical, part);
      return canonical;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(candidate);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export function canonicalizeStorePath(candidate) {
  if (candidate === undefined || candidate === null || String(candidate).trim() === '') return '';
  const text = String(candidate).trim().replace(/^~(?=$|[\\/])/, homedir());
  const absolute = isAbsolute(text) ? resolve(text) : resolve(process.cwd(), text);
  return normalizeCase(nearestExistingAncestor(absolute));
}

function pathIsSameOrWithin(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/\\\\]*')
    .replaceAll('\u0000', '.*');
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '');
}

function storeResolved(store, env = process.env) {
  const defaultPath = canonicalizeStorePath(expandInventoryTemplate(store.canonicalDefault, env));
  return {
    ...store,
    defaultPath,
    parentPath: store.kind === 'pattern' ? defaultPath : canonicalizeStorePath(dirname(defaultPath)),
    basename: store.kind === 'pattern' ? '' : basename(defaultPath),
    basenameMatcher: store.kind === 'pattern' ? globToRegExp(String(store.basenamePattern)) : null,
    sidecarMatchers: (store.sidecars ?? []).map((pattern) =>
      globToRegExp(String(pattern).replaceAll('\\', '/'))),
  };
}

function classFenceResolved(fence, env = process.env) {
  return {
    ...fence,
    rootPath: canonicalizeStorePath(expandInventoryTemplate(fence.rootTemplate, env)),
    matchers: (fence.basenamePatterns ?? []).map((pattern) =>
      globToRegExp(String(pattern).replaceAll('\\', '/'))),
  };
}

export function resolvedLiveStores(env = process.env) {
  const rank = (kind) => (kind === 'directory' ? 1 : 0);
  return liveStoreInventory.stores
    .filter((store) => !store.excluded)
    .map((store) => storeResolved(store, env))
    .sort((left, right) =>
      rank(left.kind) - rank(right.kind)
      || right.defaultPath.length - left.defaultPath.length
      || left.id.localeCompare(right.id));
}

export function resolvedClassFences(env = process.env) {
  return (liveStoreInventory.classFences ?? []).map((fence) => classFenceResolved(fence, env));
}

function patternMatchesPath(candidate, rootPath, mainMatcher, sidecarMatchers = []) {
  if (dirname(candidate) !== rootPath) return false;
  const leaf = basename(candidate).replaceAll('\\', '/');
  return Boolean(mainMatcher?.test(leaf) || sidecarMatchers.some((matcher) => matcher.test(leaf)));
}

export function classifyLiveStorePath(candidate, env = process.env) {
  const canonical = canonicalizeStorePath(candidate);
  if (!canonical) return null;

  for (const store of resolvedLiveStores(env)) {
    if (store.kind === 'directory') {
      if (pathIsSameOrWithin(canonical, store.defaultPath)) {
        return { storeId: store.id, reason: 'live_store_directory' };
      }
      continue;
    }
    if (store.kind === 'pattern'
      && patternMatchesPath(canonical, store.defaultPath, store.basenameMatcher, store.sidecarMatchers)) {
      return { storeId: store.id, reason: 'live_store_pattern' };
    }
    if (canonical === store.defaultPath) {
      return { storeId: store.id, reason: 'live_store_default' };
    }
    if (dirname(canonical) === store.parentPath) {
      const leaf = basename(canonical).replaceAll('\\', '/');
      if (store.sidecarMatchers.some((matcher) => matcher.test(leaf))) {
        return { storeId: store.id, reason: 'live_store_sidecar' };
      }
    }
  }

  for (const fence of resolvedClassFences(env)) {
    if (patternMatchesPath(canonical, fence.rootPath, null, fence.matchers)) {
      return { storeId: fence.id, reason: 'live_store_class_fence' };
    }
  }

  for (const root of liveStoreInventory.liveRoots ?? []) {
    const rootPath = canonicalizeStorePath(expandInventoryTemplate(root.defaultTemplate, env));
    if (rootPath && pathIsSameOrWithin(canonical, rootPath)) {
      return { storeId: root.id, reason: 'live_store_root' };
    }
  }
  return null;
}

export function assertHarnessWritePathSafe(candidate, operation = 'write', env = process.env) {
  if (env[OPK_VITEST_HARNESS_MARKER] !== '1') return;
  const match = classifyLiveStorePath(candidate, env);
  if (!match) return;
  const error = new Error(
    `OPK_VITEST_LIVE_STORE_BLOCKED operation=${operation} store=${match.storeId}`,
  );
  error.code = 'OPK_VITEST_LIVE_STORE_BLOCKED';
  error.storeId = match.storeId;
  throw error;
}

function removeStaleHarnessRoots(baseRoot) {
  let removed = 0;
  const now = Date.now();
  let entries = [];
  try {
    entries = readdirSync(baseRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (removed >= STALE_ROOT_MAX_REMOVALS) break;
    if (!entry.isDirectory() || !entry.name.startsWith('opk-vitest-')) continue;
    const candidate = join(baseRoot, entry.name);
    try {
      const age = now - statSync(candidate).mtimeMs;
      if (age < STALE_ROOT_MAX_AGE_MS) continue;
      rmSync(candidate, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Bounded best-effort scavenging must not hide the test result.
    }
  }
}

export function createHarnessRoot(baseRoot = tmpdir()) {
  removeStaleHarnessRoots(baseRoot);
  const root = mkdtempSync(join(baseRoot, 'opk-vitest-'));
  chmodSync(root, 0o700);
  return root;
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function applyOpkVitestHarnessEnv(rootDir, env = process.env) {
  env.OPK_VITEST_PRODUCTION_HOME ||= env.HOME || homedir();
  env.OPK_VITEST_PRODUCTION_TMP ||= env.TMPDIR || env.TEMP || env.TMP || tmpdir();
  env.OPK_VITEST_PRODUCTION_AO_BASE ||= env.AO_BASE_DIR
    || join(env.OPK_VITEST_PRODUCTION_HOME, '.agent-orchestrator');
  env.OPK_VITEST_PRODUCTION_WAKE_ROOT ||= resolveProductionWakeRoot(env);

  const root = resolve(rootDir || createHarnessRoot());
  ensurePrivateDirectory(root);
  const wake = join(root, 'wake');
  const state = join(root, 'state');
  const isolatedTmp = join(root, 'tmp');
  const inbox = join(root, 'operator-inbox');
  const health = join(root, 'health-spool');
  const aoBase = join(root, 'ao-base');
  const transport = join(root, 'transport');
  for (const dir of [wake, state, isolatedTmp, inbox, health, aoBase, transport]) {
    ensurePrivateDirectory(dir);
  }

  const paths = {
    root,
    wake,
    state,
    tmp: isolatedTmp,
    operatorInbox: inbox,
    healthSpool: health,
    aoBase,
    transport,
  };
  Object.assign(env, {
    OPK_VITEST_HARNESS: '1',
    OPK_VITEST_HARNESS_ROOT: root,
    OPK_VITEST_HARNESS_INVENTORY: inventoryPath,
    TMPDIR: isolatedTmp,
    TEMP: isolatedTmp,
    TMP: isolatedTmp,
    AO_WAKE_SUPERVISOR_STATE_DIR: wake,
    ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: wake,
    AO_SIDE_PROCESS_STATE_DIR: wake,
    AO_BASE_DIR: aoBase,
    AO_MECHANICAL_TRANSPORT_TEMP: transport,
    AO_ORCHESTRATOR_ESCALATION_STATE: join(state, 'orchestrator-escalation-state.json'),
    AO_OPERATOR_ESCALATION_INBOX: inbox,
    AO_ESCALATION_HEALTH_SPOOL: health,
    AO_WORKER_MESSAGE_DISPATCH_JOURNAL: join(wake, 'worker-message-dispatch-journal.json'),
    AO_WORKER_MESSAGE_SUBMIT_STATE: join(state, 'orchestrator-worker-message-submit-state.json'),
    AO_WORKER_STATUS_STORE: join(wake, 'worker-status-store.json'),
    AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE: join(
      state,
      'orchestrator-review-handoff-wake-admission.json',
    ),
    AO_REPORT_STATE_SEED_STATE: join(
      state,
      'orchestrator-review-ready-report-state-seed-state.json',
    ),
    AO_REVIEW_TRIGGER_REEVAL_WATCH_STATE: join(
      state,
      'orchestrator-review-trigger-reeval-watch.json',
    ),
    AO_WORKER_REPORT_STORE: join(wake, 'worker-report-store.json'),
    AO_PR_SESSION_BINDING_CACHE: join(wake, 'pr-session-binding-cache.json'),
    AO_CI_GREEN_WAKE_RECONCILE_STATE: join(state, 'orchestrator-ci-green-wake-state.json'),
    AO_DEAD_WORKER_RECONCILE_STATE: join(
      wake,
      'orchestrator-dead-worker-reconcile-state.json',
    ),
    AO_REVIEW_TRIGGER_RECONCILE_STATE: join(state, 'orchestrator-review-reconcile-state.json'),
    AO_WAKE_DEDUP_STATE: join(state, 'orchestrator-wake-dedup.json'),
    AO_WAKE_LISTENER_SIDE_EFFECT_LOCK: join(
      state,
      'orchestrator-wake-listener-side-effect.lock',
    ),
    AO_WORKER_MESSAGE_ADOPTION_STATE: join(
      state,
      'orchestrator-worker-message-send-adoption.json',
    ),
    AO_REVIEW_CLAIM_DIR: join(
      aoBase,
      'projects',
      'orchestrator-pack',
      'review-start-claims',
    ),
    AO_WORKER_NUDGE_CLAIM_DIR: join(
      aoBase,
      'projects',
      'orchestrator-pack',
      'worker-nudge-claims',
    ),
  });
  return paths;
}

function hashFile(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  const stat = lstatSync(path);
  return {
    type: 'file',
    hash: hash.digest('hex'),
    size: stat.size,
    mtimeNs: String(stat.mtimeNs ?? BigInt(Math.round(stat.mtimeMs * 1e6))),
  };
}

function hashDirectory(path) {
  const hash = createHash('sha256');
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const rel = join(prefix, entry.name).replaceAll('\\', '/');
      hash.update(entry.isDirectory() ? `d:${rel}\n` : `f:${rel}\n`);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) hash.update(readFileSync(full));
      else hash.update(`other:${entry.name}\n`);
    }
  };
  walk(path);
  const stat = lstatSync(path);
  return {
    type: 'directory',
    hash: hash.digest('hex'),
    mtimeNs: String(stat.mtimeNs ?? BigInt(Math.round(stat.mtimeMs * 1e6))),
  };
}

function snapshotPath(path) {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path);
  if (stat.isDirectory()) return { exists: true, ...hashDirectory(path) };
  if (stat.isFile()) return { exists: true, ...hashFile(path) };
  return {
    exists: true,
    type: 'other',
    size: stat.size,
    mtimeNs: String(stat.mtimeNs ?? BigInt(Math.round(stat.mtimeMs * 1e6))),
  };
}

function listPatternPaths(rootPath, matchers) {
  const paths = [];
  if (!existsSync(rootPath)) return paths;
  try {
    for (const name of readdirSync(rootPath)) {
      const normalized = name.replaceAll('\\', '/');
      if (matchers.some((matcher) => matcher.test(normalized))) {
        paths.push(join(rootPath, name));
      }
    }
  } catch {
    // Caller still retains a root existence snapshot.
  }
  return paths.sort();
}

function listCoveredPaths(store) {
  if (store.kind === 'pattern') {
    return listPatternPaths(
      store.defaultPath,
      [store.basenameMatcher, ...store.sidecarMatchers].filter(Boolean),
    );
  }
  const paths = new Set([store.defaultPath]);
  if (!existsSync(store.parentPath)) return [...paths];
  try {
    for (const name of readdirSync(store.parentPath)) {
      const normalized = name.replaceAll('\\', '/');
      if (store.sidecarMatchers.some((matcher) => matcher.test(normalized))) {
        paths.add(join(store.parentPath, name));
      }
    }
  } catch {
    // Snapshot remains fail-safe for the primary path.
  }
  return [...paths].sort();
}

function storeSnapshot(store) {
  const items = {};
  for (const path of listCoveredPaths(store)) {
    const key = createHash('sha256').update(path).digest('hex');
    items[key] = snapshotPath(path);
  }
  return items;
}

function classFenceSnapshot(fence) {
  const items = {};
  for (const path of listPatternPaths(fence.rootPath, fence.matchers)) {
    const key = createHash('sha256').update(path).digest('hex');
    items[key] = snapshotPath(path);
  }
  return items;
}

function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function startLiveStoreGuard(env = process.env) {
  const stores = resolvedLiveStores(env);
  const classFences = resolvedClassFences(env);
  const before = new Map(stores.map((store) => [store.id, storeSnapshot(store)]));
  const fenceBefore = new Map(
    classFences.map((fence) => [fence.id, classFenceSnapshot(fence)]),
  );
  const touched = new Set();
  const watchers = [];
  const watchedDirs = new Set();

  const watchDir = (requestedDir) => {
    let dir = requestedDir;
    while (dir && !existsSync(dir)) {
      const parent = dirname(dir);
      if (parent === dir) return;
      dir = parent;
    }
    if (!dir || watchedDirs.has(dir) || watchedDirs.size >= MAX_WATCHED_DIRECTORIES) return;
    watchedDirs.add(dir);
    try {
      const watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;
        const candidate = join(dir, String(filename));
        const match = classifyLiveStorePath(candidate, env);
        if (match) touched.add(match.storeId);
      });
      watchers.push(watcher);
    } catch {
      // Post-run snapshots remain authoritative if a platform cannot watch a path.
    }
  };

  const watchTree = (requestedRoot) => {
    watchDir(requestedRoot);
    if (!existsSync(requestedRoot)) return;
    const visit = (dir) => {
      if (watchedDirs.size >= MAX_WATCHED_DIRECTORIES) return;
      watchDir(dir);
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) visit(join(dir, entry.name));
      }
    };
    visit(requestedRoot);
  };

  for (const store of stores) {
    if (store.kind === 'directory') {
      watchDir(store.parentPath);
      watchTree(store.defaultPath);
    } else if (store.kind === 'pattern') {
      watchDir(store.defaultPath);
    } else {
      watchDir(store.parentPath);
    }
  }
  for (const fence of classFences) {
    if (fence.watchTransient !== false) watchDir(fence.rootPath);
  }
  for (const root of liveStoreInventory.liveRoots ?? []) {
    if (root.watchTransient === false) continue;
    watchTree(canonicalizeStorePath(expandInventoryTemplate(root.defaultTemplate, env)));
  }

  return {
    stop() {
      for (const watcher of watchers) watcher.close();
      const failures = [];
      for (const store of stores) {
        const after = storeSnapshot(store);
        if (!snapshotsEqual(before.get(store.id), after)) {
          failures.push(`${store.id}:snapshot_changed`);
        }
        if (touched.has(store.id)) failures.push(`${store.id}:transient_write_observed`);
      }
      for (const fence of classFences) {
        const after = classFenceSnapshot(fence);
        if (!snapshotsEqual(fenceBefore.get(fence.id), after)) {
          failures.push(`${fence.id}:snapshot_changed`);
        }
        if (touched.has(fence.id)) failures.push(`${fence.id}:transient_write_observed`);
      }
      for (const root of liveStoreInventory.liveRoots ?? []) {
        if (root.watchTransient !== false && touched.has(root.id)) {
          failures.push(`${root.id}:transient_write_observed`);
        }
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

export function cleanupHarnessRoot(root) {
  if (!root) return;
  const canonical = canonicalizeStorePath(root);
  const tempCanonical = canonicalizeStorePath(tmpdir());
  if (!pathIsSameOrWithin(canonical, tempCanonical)
    || !basename(canonical).startsWith('opk-vitest-')) {
    throw new Error('refusing to cleanup non-harness root');
  }
  rmSync(canonical, { recursive: true, force: true });
}

export function makeInvocationToken() {
  return `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}
