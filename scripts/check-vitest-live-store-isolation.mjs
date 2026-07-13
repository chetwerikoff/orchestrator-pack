#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  assertHarnessWritePathSafe,
  classifyLiveStorePath,
  inventoryPath,
  liveStoreInventory,
  repoRoot,
  startLiveStoreGuard,
} from './lib/vitest-live-store-harness.mjs';

const failures = [];
const fail = (message) => failures.push(message);
const requiredFields = [
  'id',
  'kind',
  'resolver',
  'writeBoundary',
  'envOverrides',
  'canonicalDefault',
  'liveRoot',
  'sidecars',
  'harnessPath',
  'sourceFiles',
  'excluded',
  'exclusionReason',
];

const ids = new Set();
for (const store of liveStoreInventory.stores ?? []) {
  for (const field of requiredFields) {
    if (!(field in store)) fail(`inventory store ${store.id ?? '<missing-id>'} lacks ${field}`);
  }
  if (ids.has(store.id)) fail(`duplicate inventory store id ${store.id}`);
  ids.add(store.id);
  if (!Array.isArray(store.envOverrides)) fail(`${store.id} envOverrides must be an array`);
  if (!Array.isArray(store.sidecars)) fail(`${store.id} sidecars must be an array`);
  if (!Array.isArray(store.sourceFiles) || store.sourceFiles.length === 0) fail(`${store.id} sourceFiles must be non-empty`);
  if (store.excluded && !String(store.exclusionReason ?? '').trim()) fail(`${store.id} exclusion requires a reason`);
  if (!store.excluded && store.exclusionReason !== null) fail(`${store.id} non-excluded entry must use null exclusionReason`);

  let resolverFound = false;
  for (const sourceFile of store.sourceFiles ?? []) {
    const full = join(repoRoot, sourceFile);
    if (!existsSync(full)) {
      fail(`${store.id} source missing: ${sourceFile}`);
      continue;
    }
    const source = readFileSync(full, 'utf8');
    if (source.includes(store.resolver)) resolverFound = true;
  }
  if (!resolverFound) fail(`${store.id} resolver not found in declared source files: ${store.resolver}`);
}

const runtimeExtensions = new Set(['.ps1', '.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.sh', '.cmd']);
const ignoredSegments = [
  '/issues_drafts/',
  '/declarations/',
  '/investigations/',
  '/fixtures/',
  '/tests/',
  '.test.',
  '_test-',
  '_test_',
];
const sourceOwners = new Set(liveStoreInventory.stores.flatMap((store) => store.sourceFiles ?? []));
const enforcementFiles = new Set([
  'scripts/check-vitest-live-store-isolation.mjs',
  'scripts/run-vitest-with-harness.mjs',
  'scripts/test-harness-escalation-env.ts',
  'scripts/vitest-global-setup.ts',
  'scripts/vitest-live-store-preload.mjs',
  'scripts/lib/OpkVitestStoreIsolation.ps1',
  'scripts/lib/Set-OpkVitestHarnessEnv.ps1',
  'scripts/lib/vitest-live-store-harness.mjs',
  'scripts/vitest-live-store-inventory.json',
]);
const defaultSignals = [
  /GetTempPath\s*\(\s*\)[\s\S]{0,220}orchestrator-[A-Za-z0-9._-]+(?:\.json|\.jsonl|\.lock)/g,
  /tmpdir\s*\(\s*\)[\s\S]{0,220}orchestrator-[A-Za-z0-9._-]+(?:\.json|\.jsonl|\.lock)/g,
  /(?:\.local[\\/]state[\\/]orchestrator-pack-wake-supervisor|orchestrator-pack-wake-supervisor)[\s\S]{0,400}[A-Za-z0-9._-]+(?:\.json|\.jsonl|\.lock)/g,
  /(?:\.agent-orchestrator|AO_BASE_DIR)[\s\S]{0,400}[A-Za-z0-9._-]+(?:claims|store|state|cache|audit|ledger)/g,
  /(?:\/tmp|[A-Za-z]:[\\/]Temp)[\\/]orchestrator-[A-Za-z0-9._-]+/g,
];

function walkRuntime(root) {
  if (!existsSync(root)) return [];
  const results = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && runtimeExtensions.has(extname(entry.name))) results.push(full);
    }
  };
  visit(root);
  return results;
}

const auditInputs = [
  ...['scripts', 'plugins', 'docs', '.github/workflows'].flatMap((root) => walkRuntime(join(repoRoot, root))),
  ...['vitest.config.ts', 'package.json'].map((file) => join(repoRoot, file)).filter(existsSync),
];
for (const full of auditInputs) {
    const rel = relative(repoRoot, full).replaceAll('\\', '/');
    if (ignoredSegments.some((segment) => `/${rel}`.includes(segment)) || enforcementFiles.has(rel)) continue;
    const source = readFileSync(full, 'utf8');
    const hasDefault = defaultSignals.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(source);
    });
  if (hasDefault && !sourceOwners.has(rel)) fail(`un-inventoried live-default candidate: ${rel}`);
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'opk-vitest-isolation-check-'));
try {
  const fakeHome = join(fixtureRoot, 'home');
  const fakeTmp = join(fixtureRoot, 'tmp');
  const wake = join(fakeHome, '.local', 'state', 'orchestrator-pack-wake-supervisor');
  mkdirSync(wake, { recursive: true });
  mkdirSync(fakeTmp, { recursive: true });
  const env = {
    ...process.env,
    HOME: fakeHome,
    TMPDIR: fakeTmp,
    TEMP: fakeTmp,
    TMP: fakeTmp,
    OPK_VITEST_PRODUCTION_HOME: fakeHome,
    OPK_VITEST_PRODUCTION_TMP: fakeTmp,
    OPK_VITEST_HARNESS: '1',
  };
  delete env.AO_WORKER_STATUS_STORE;
  delete env.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR;

  const liveWorkerStatus = join(wake, 'worker-status-store.json');
  const match = classifyLiveStorePath(liveWorkerStatus, env);
  if (match?.storeId !== 'worker-status-store') fail('computed worker-status default is not classified');
  try {
    assertHarnessWritePathSafe(liveWorkerStatus, 'self-check', env);
    fail('computed worker-status default was not blocked');
  } catch (error) {
    if (error?.code !== 'OPK_VITEST_LIVE_STORE_BLOCKED') fail(`unexpected block error: ${error}`);
    if (String(error?.message ?? '').includes(liveWorkerStatus)) fail('blocked-path diagnostic leaked a live path');
  }

  const mutatedEnv = {
    ...env,
    OPK_VITEST_PRODUCTION_HOME: fakeHome,
    OPK_VITEST_PRODUCTION_TMP: fakeTmp,
    HOME: join(fixtureRoot, 'mutated-home'),
    TMPDIR: join(fixtureRoot, 'mutated-tmp'),
  };
  try {
    assertHarnessWritePathSafe(liveWorkerStatus, 'mutated-env-self-check', mutatedEnv);
    fail('mutating HOME/TMP after harness bootstrap bypassed the frozen production default');
  } catch (error) {
    if (error?.code !== 'OPK_VITEST_LIVE_STORE_BLOCKED') fail(`unexpected frozen-root error: ${error}`);
  }

  const safePath = join(fixtureRoot, 'safe', 'worker-status-store.json');
  try {
    assertHarnessWritePathSafe(safePath, 'self-check', env);
  } catch (error) {
    fail(`isolated path was incorrectly blocked: ${error}`);
  }

  const aliasRoot = join(fixtureRoot, 'wake-alias');
  try {
    symlinkSync(wake, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasMatch = classifyLiveStorePath(join(aliasRoot, 'worker-status-store.json'), env);
    if (aliasMatch?.storeId !== 'worker-status-store') fail('symlink alias of live default was not classified');
  } catch (error) {
    if (process.platform !== 'win32') fail(`symlink canonicalization fixture failed: ${error}`);
  }

  const guard = startLiveStoreGuard(env);
  const transient = join(fakeTmp, 'orchestrator-worker-message-submit-state.json');
  writeFileSync(transient, '{"transient":true}\n', 'utf8');
  rmSync(transient, { force: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  try {
    guard.stop();
    fail('write-then-delete transient mutation escaped the parent guard');
  } catch (error) {
    if (error?.code !== 'OPK_VITEST_LIVE_STORE_GUARD_FAILED') fail(`unexpected parent guard error: ${error}`);
  }

  const rootGuard = startLiveStoreGuard(env);
  const unlistedLiveRootFile = join(wake, 'new-uninventoried-store.json');
  writeFileSync(unlistedLiveRootFile, '{"transient":true}\n', 'utf8');
  rmSync(unlistedLiveRootFile, { force: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  try {
    rootGuard.stop();
    fail('transient write under a protected live root escaped the parent guard');
  } catch (error) {
    if (error?.code !== 'OPK_VITEST_LIVE_STORE_GUARD_FAILED') fail(`unexpected live-root guard error: ${error}`);
  }

  const preload = join(repoRoot, 'scripts', 'vitest-live-store-preload.mjs');
  const childScript = `import { writeFileSync } from 'node:fs'; import { homedir } from 'node:os'; import { join } from 'node:path'; writeFileSync(join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', 'worker-status-store.json'), 'red');`;
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '--eval', childScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
  if (child.status === 0) fail('Node write boundary did not fail closed');
  if (existsSync(liveWorkerStatus)) fail('Node write boundary opened the live-default store before blocking');

  const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
  const psScript = `. ${JSON.stringify(join(repoRoot, 'scripts', 'lib', 'OpkVitestStoreIsolation.ps1'))}; Enable-OpkVitestStoreIsolation; function Get-WorkerStatusStorePath { if ($env:AO_WORKER_STATUS_STORE) { return $env:AO_WORKER_STATUS_STORE }; $root=Join-Path $HOME '.local/state/orchestrator-pack-wake-supervisor'; return Join-Path $root 'worker-status-store.json' }; Get-WorkerStatusStorePath | Out-Null`;
  const ps = spawnSync(pwsh, ['-NoProfile', '-Command', psScript], { cwd: repoRoot, encoding: 'utf8', env });
  if (!ps.error && ps.status === 0) fail('PowerShell resolver breakpoint did not fail closed');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`vitest live-store isolation check failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`vitest live-store isolation check passed (${liveStoreInventory.stores.length} stores; inventory=${relative(repoRoot, inventoryPath)})`);
