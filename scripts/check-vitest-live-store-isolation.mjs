#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runProcess } from './kernel/subprocess.mjs';
import {
  applyOpkVitestHarnessEnv,
  classifyLiveStorePath,
  cleanupHarnessRoot,
  createHarnessRoot,
  expandInventoryTemplate,
  liveStoreInventory,
  redirectHarnessWritePath,
  repoRoot,
  resolvedLiveStores,
  startLiveStoreGuard,
} from './lib/vitest-live-store-harness.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isWithin(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

function unique(values) {
  return new Set(values).size === values.length;
}

function productionEnvironment(root) {
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const wake = join(root, 'wake-production');
  const packBase = join(root, 'pack-production');
  for (const path of [home, temp, wake, packBase]) mkdirSync(path, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    XDG_STATE_HOME: join(home, '.local', 'state'),
    OPK_WAKE_SUPERVISOR_STATE_DIR: wake,
    ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: wake,
    OPK_BASE_DIR: packBase,
  };
}

function validateInventory() {
  assert(liveStoreInventory.schemaVersion === 2, 'inventory schemaVersion must be 2');
  const stores = liveStoreInventory.stores ?? [];
  assert(stores.length > 0, 'inventory must contain active stores');
  assert(unique(stores.map((store) => store.id)), 'store ids must be unique');
  for (const store of stores) {
    assert(store.id && store.kind && store.canonicalDefault && store.harnessPath,
      `store ${store.id ?? '<missing>'} is incomplete`);
    assert(['file', 'directory'].includes(store.kind), `unsupported store kind: ${store.kind}`);
    assert(!String(store.canonicalDefault).includes('..'), `unsafe store template: ${store.id}`);
  }

  const requiredRoots = [
    'scripts/check-vitest-live-store-isolation.mjs',
    'scripts/vitest-live-store-inventory.json',
    'scripts/vitest-live-store-preload.mjs',
    'scripts/lib/vitest-live-store-harness.mjs',
    'scripts/run-vitest-with-harness.mjs',
  ];
  for (const path of requiredRoots) {
    assert((liveStoreInventory.allowedRoots ?? []).includes(path), `allowedRoots missing ${path}`);
  }
}

async function validateRedirectAndPreload() {
  const sandbox = mkdtempSync(join(tmpdir(), 'opk-vitest-check-'));
  const productionEnv = productionEnvironment(sandbox);
  const harnessRoot = createHarnessRoot();
  try {
    const productionStores = resolvedLiveStores(productionEnv);
    assert(productionStores.length === (liveStoreInventory.stores ?? []).length,
      'resolved store count does not match inventory');
    for (const store of productionStores) {
      const match = classifyLiveStorePath(store.defaultPath, productionEnv);
      assert(match?.storeId === store.id, `classification failed for ${store.id}`);
    }

    const harnessEnv = { ...productionEnv };
    applyOpkVitestHarnessEnv(harnessRoot, harnessEnv);
    for (const store of liveStoreInventory.stores ?? []) {
      for (const envName of store.envOverrides ?? []) {
        const value = resolve(String(harnessEnv[envName] ?? ''));
        assert(value && isWithin(value, harnessRoot), `${envName} escaped harness root`);
      }
    }

    const productionWorkerStore = productionStores.find((store) => store.id === 'worker-status-store');
    assert(productionWorkerStore, 'worker-status-store inventory entry missing');
    const redirected = redirectHarnessWritePath(
      productionWorkerStore.defaultPath,
      'self-check',
      harnessEnv,
    );
    assert(isWithin(resolve(redirected), harnessRoot), 'redirected store escaped harness root');

    const probe = join(harnessRoot, 'write-probe.mjs');
    writeFileSync(probe, `
import fs from 'node:fs';
const target = process.env.OPK_VITEST_PRODUCTION_WORKER_STORE;
fs.writeFileSync(target, 'sync');
await new Promise((resolve, reject) => fs.writeFile(target, 'callback', (error) => error ? reject(error) : resolve()));
await fs.promises.writeFile(target, 'promise');
`, 'utf8');

    const preload = pathToFileURL(join(repoRoot, 'scripts', 'vitest-live-store-preload.mjs')).href;
    const child = await runProcess({
      command: process.execPath,
      args: [`--import=${preload}`, probe],
      cwd: repoRoot,
      env: {
        ...harnessEnv,
        OPK_VITEST_PRODUCTION_WORKER_STORE: productionWorkerStore.defaultPath,
      },
      inheritParentEnv: false,
      stdio: 'pipe',
    });
    assert(child.exitCode === 0, `preload probe failed: ${child.stderr || child.stdout}`);
    assert(!existsSync(productionWorkerStore.defaultPath), 'preload wrote production store');
    assert(existsSync(redirected), 'preload did not create redirected store');
    assert(readFileSync(redirected, 'utf8') === 'promise', 'preload write sequence was incomplete');
  } finally {
    cleanupHarnessRoot(harnessRoot);
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function validateGuard() {
  const sandbox = mkdtempSync(join(tmpdir(), 'opk-vitest-guard-check-'));
  const env = productionEnvironment(sandbox);
  const guard = startLiveStoreGuard(env);
  const target = expandInventoryTemplate('${WAKE_STATE}/worker-status-store.json', env);
  let observed = false;
  try {
    writeFileSync(target, 'unexpected', 'utf8');
    try {
      guard.stop();
    } catch (error) {
      observed = error?.code === 'OPK_VITEST_LIVE_STORE_GUARD_FAILED';
    }
    assert(observed, 'parent guard did not detect a production-store write');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

try {
  validateInventory();
  await validateRedirectAndPreload();
  validateGuard();
  console.log(JSON.stringify({ verdict: 'pass', storeCount: (liveStoreInventory.stores ?? []).length }));
} catch (error) {
  console.error(JSON.stringify({
    verdict: 'fail',
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
