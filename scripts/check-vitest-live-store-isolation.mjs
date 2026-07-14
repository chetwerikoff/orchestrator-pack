#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  applyOpkVitestHarnessEnv,
  assertHarnessWritePathSafe,
  classifyLiveStorePath,
  cleanupHarnessRoot,
  createHarnessRoot,
  inventoryPath,
  liveStoreInventory,
  redirectHarnessWritePath,
  repoRoot,
  startLiveStoreGuard,
} from './lib/vitest-live-store-harness.mjs';

const failures = [];
const fail = (message) => failures.push(message);
const requiredFields = [
  'id', 'kind', 'resolver', 'writeBoundary', 'envOverrides', 'canonicalDefault',
  'liveRoot', 'sidecars', 'harnessPath', 'sourceFiles', 'excluded', 'exclusionReason',
];

const ids = new Set();
for (const store of liveStoreInventory.stores ?? []) {
  for (const field of requiredFields) {
    if (!(field in store)) fail(`inventory store ${store.id ?? '<missing-id>'} lacks ${field}`);
  }
  if (ids.has(store.id)) fail(`duplicate inventory store id ${store.id}`);
  ids.add(store.id);
  if (!['file', 'directory', 'pattern'].includes(String(store.kind))) {
    fail(`${store.id} has unsupported kind ${store.kind}`);
  }
  if (store.kind === 'pattern' && !String(store.basenamePattern ?? '').trim()) {
    fail(`${store.id} pattern entry requires basenamePattern`);
  }
  if (!Array.isArray(store.envOverrides)) fail(`${store.id} envOverrides must be an array`);
  if (!Array.isArray(store.sidecars)) fail(`${store.id} sidecars must be an array`);
  if (!Array.isArray(store.sourceFiles) || store.sourceFiles.length === 0) {
    fail(`${store.id} sourceFiles must be non-empty`);
  }
  if (store.excluded && !String(store.exclusionReason ?? '').trim()) {
    fail(`${store.id} exclusion requires a reason`);
  }
  if (!store.excluded && store.exclusionReason !== null) {
    fail(`${store.id} non-excluded entry must use null exclusionReason`);
  }
  let resolverFound = false;
  for (const sourceFile of store.sourceFiles ?? []) {
    const full = join(repoRoot, sourceFile);
    if (!existsSync(full)) {
      fail(`${store.id} source missing: ${sourceFile}`);
      continue;
    }
    if (readFileSync(full, 'utf8').includes(store.resolver)) resolverFound = true;
  }
  if (!resolverFound) fail(`${store.id} resolver not found in declared source files: ${store.resolver}`);
}

const fenceIds = new Set();
for (const fence of liveStoreInventory.classFences ?? []) {
  if (!String(fence.id ?? '').trim()) fail('class fence missing id');
  if (ids.has(fence.id) || fenceIds.has(fence.id)) fail(`duplicate class fence id ${fence.id}`);
  fenceIds.add(fence.id);
  if (!String(fence.rootTemplate ?? '').trim()) fail(`${fence.id} missing rootTemplate`);
  if (!Array.isArray(fence.basenamePatterns) || fence.basenamePatterns.length === 0) {
    fail(`${fence.id} must declare basenamePatterns`);
  }
}

const runtimeExtensions = new Set(['.ps1', '.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.sh', '.cmd']);
const ignoredSegments = [
  '/issues_drafts/', '/declarations/', '/investigations/', '/fixtures/', '/tests/',
  '.test.', '_test-', '_test_',
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
const generatedArtifacts = new Set([
  'scripts/vitest-heavy-topology.plan.json',
]);
const exclusionByPath = new Map(
  (liveStoreInventory.discoveryExclusions ?? []).map((entry) => [entry.path, entry]),
);
const writeApiPattern = /(?:\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bMove-Item\b|\bCopy-Item\b|\bRemove-Item\b|\bNew-Item\b|\[System\.IO\.(?:File|FileStream)\]|\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync)\s*\()/;
for (const [path, entry] of exclusionByPath) {
  const full = join(repoRoot, path);
  if (!existsSync(full)) {
    fail(`discovery exclusion source missing: ${path}`);
    continue;
  }
  if (entry.proof !== 'no-write-api') fail(`${path} exclusion lacks mechanical no-write-api proof`);
  if (writeApiPattern.test(readFileSync(full, 'utf8'))) {
    fail(`${path} exclusion is not read-only: a filesystem write API is present`);
  }
}

const defaultSignals = [
  /GetTempPath\s*\(\s*\)[\s\S]{0,260}orchestrator-[A-Za-z0-9._-]+(?:\.json|\.jsonl|\.lock)/g,
  /tmpdir\s*\(\s*\)[\s\S]{0,260}orchestrator-[A-Za-z0-9._-]+(?:\.json|\.jsonl|\.lock)/g,
  /(?:\.local[\\/]state[\\/]orchestrator-pack-wake-supervisor|orchestrator-pack-wake-supervisor)[\s\S]{0,500}[A-Za-z0-9._-]+(?:\.json|\.jsonl|\.lock)/g,
  /(?:\.agent-orchestrator|AO_BASE_DIR)[\s\S]{0,500}[A-Za-z0-9._-]+(?:claims|store|state|cache|audit|ledger|code-reviews)/g,
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
  if (ignoredSegments.some((segment) => `/${rel}`.includes(segment))
    || enforcementFiles.has(rel)
    || generatedArtifacts.has(rel)) continue;
  const source = readFileSync(full, 'utf8');
  const hasDefault = defaultSignals.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(source);
  });
  if (hasDefault && !sourceOwners.has(rel) && !exclusionByPath.has(rel)) {
    fail(`un-inventoried live-default candidate: ${rel}`);
  }
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'opk-vitest-isolation-check-'));
const cleanupRoots = [];
try {
  const fakeHome = join(fixtureRoot, 'home');
  const fakeTmp = join(fixtureRoot, 'tmp');
  const fakeAoBase = join(fakeHome, '.agent-orchestrator');
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
    OPK_VITEST_PRODUCTION_AO_BASE: fakeAoBase,
    OPK_VITEST_PRODUCTION_WAKE_ROOT: wake,
    OPK_VITEST_HARNESS: '1',
  };
  for (const name of [
    'AO_WORKER_STATUS_STORE', 'AO_WAKE_SUPERVISOR_STATE_DIR',
    'ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR', 'AO_SIDE_PROCESS_STATE_DIR', 'AO_BASE_DIR',
  ]) delete env[name];

  const liveWorkerStatus = join(wake, 'worker-status-store.json');
  if (classifyLiveStorePath(liveWorkerStatus, env)?.storeId !== 'worker-status-store') {
    fail('computed worker-status default is not classified');
  }
  try {
    assertHarnessWritePathSafe(liveWorkerStatus, 'self-check', env);
    fail('computed worker-status default was not blocked');
  } catch (error) {
    if (error?.code !== 'OPK_VITEST_LIVE_STORE_BLOCKED') fail(`unexpected block error: ${error}`);
    if (String(error?.message ?? '').includes(liveWorkerStatus)) fail('blocked-path diagnostic leaked a live path');
  }
  try {
    assertHarnessWritePathSafe(liveWorkerStatus, 'mutated-env-self-check', {
      ...env,
      HOME: join(fixtureRoot, 'mutated-home'),
      TMPDIR: join(fixtureRoot, 'mutated-tmp'),
      TEMP: join(fixtureRoot, 'mutated-tmp'),
      TMP: join(fixtureRoot, 'mutated-tmp'),
    });
    fail('mutating HOME/TMP after bootstrap bypassed the frozen production default');
  } catch (error) {
    if (error?.code !== 'OPK_VITEST_LIVE_STORE_BLOCKED') fail(`unexpected frozen-root error: ${error}`);
  }
  try {
    assertHarnessWritePathSafe(join(fixtureRoot, 'safe', 'worker-status-store.json'), 'self-check', env);
  } catch (error) {
    fail(`isolated path was incorrectly blocked: ${error}`);
  }
  try {
    const aliasRoot = join(fixtureRoot, 'wake-alias');
    symlinkSync(wake, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
    if (classifyLiveStorePath(join(aliasRoot, 'worker-status-store.json'), env)?.storeId !== 'worker-status-store') {
      fail('symlink alias of live default was not classified');
    }
  } catch (error) {
    if (process.platform !== 'win32') fail(`symlink canonicalization fixture failed: ${error}`);
  }

  async function expectTransientGuardFailure(target, label) {
    const guard = startLiveStoreGuard(env);
    writeFileSync(target, '{"transient":true}\n', 'utf8');
    rmSync(target, { force: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    try {
      guard.stop();
      fail(`${label} escaped the parent guard`);
    } catch (error) {
      if (error?.code !== 'OPK_VITEST_LIVE_STORE_GUARD_FAILED') {
        fail(`unexpected ${label} guard error: ${error}`);
      }
    }
  }
  await expectTransientGuardFailure(
    join(fakeTmp, 'orchestrator-worker-message-submit-state.json'),
    'write-then-delete transient mutation',
  );
  await expectTransientGuardFailure(join(wake, 'new-uninventoried-store.json'), 'live-root transient write');
  await expectTransientGuardFailure(join(fakeTmp, 'orchestrator-new-live-store.json'), 'class-fence transient write');

  const harnessRootA = createHarnessRoot(fakeTmp);
  const harnessRootB = createHarnessRoot(fakeTmp);
  cleanupRoots.push(harnessRootA, harnessRootB);
  if (harnessRootA === harnessRootB) fail('concurrent harness roots collided');
  const harnessEnv = { ...env, HOME: fakeHome, TMPDIR: fakeTmp, TEMP: fakeTmp, TMP: fakeTmp };
  applyOpkVitestHarnessEnv(harnessRootA, harnessEnv);
  if (harnessEnv.OPK_VITEST_HARNESS !== '1') fail('harness marker was not established');
  for (const [name, value] of [
    ['TMPDIR', harnessEnv.TMPDIR],
    ['AO_BASE_DIR', harnessEnv.AO_BASE_DIR],
    ['AO_WAKE_SUPERVISOR_STATE_DIR', harnessEnv.AO_WAKE_SUPERVISOR_STATE_DIR],
  ]) {
    if (!String(value ?? '').startsWith(harnessRootA)) fail(`${name} was not redirected into the harness root`);
  }
  const requiredOverrides = new Set(liveStoreInventory.stores.flatMap((store) => store.envOverrides ?? []));
  for (const name of requiredOverrides) {
    if (!String(harnessEnv[name] ?? '').trim()) fail(`harness did not establish ${name}`);
  }

  const preload = join(repoRoot, 'scripts', 'vitest-live-store-preload.mjs');
  const nodeCases = [
    ['sync', liveWorkerStatus, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(liveWorkerStatus)}, 'red');`],
    ['callback', join(wake, 'callback-state.json'), `import { writeFile } from 'node:fs'; await new Promise((resolveWrite, rejectWrite) => writeFile(${JSON.stringify(join(wake, 'callback-state.json'))}, 'red', (error) => error ? rejectWrite(error) : resolveWrite()));`],
    ['promise', join(wake, 'promise-state.json'), `import { promises as fs } from 'node:fs'; await fs.writeFile(${JSON.stringify(join(wake, 'promise-state.json'))}, 'red');`],
  ];
  for (const [label, target, script] of nodeCases) {
    const redirected = redirectHarnessWritePath(target, harnessEnv);
    if (!redirected) {
      fail(`Node ${label} write path did not resolve to a harness target`);
      continue;
    }
    const child = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, '--input-type=module', '--eval', script],
      { cwd: repoRoot, encoding: 'utf8', env: harnessEnv },
    );
    if (child.status !== 0) fail(`Node ${label} write boundary did not stay inside the harness root`);
    if (existsSync(target)) fail(`Node ${label} write opened a live-default path before blocking`);
    if (!existsSync(redirected)) fail(`Node ${label} write did not land in the harness root`);
    else if (readFileSync(redirected, 'utf8') !== 'red') fail(`Node ${label} redirected content was incorrect`);
  }

  const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
  const helper = join(repoRoot, 'scripts', 'lib', 'OpkVitestStoreIsolation.ps1');
  const psEnv = { ...env, AO_WORKER_STATUS_STORE: liveWorkerStatus };
  const psAssert = `. ${JSON.stringify(helper)}; try { Assert-OpkVitestStorePathSafe -Path ${JSON.stringify(liveWorkerStatus)} -Operation 'self-check'; exit 0 } catch { if ($_.Exception.Message -match 'OPK_VITEST_LIVE_STORE_BLOCKED.*worker-status-store') { exit 42 }; Write-Error $_; exit 1 }`;
  const assertResult = spawnSync(pwsh, ['-NoProfile', '-Command', psAssert], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: psEnv,
  });
  if (!assertResult.error && assertResult.status !== 42) {
    fail('PowerShell canonical live-store assertion did not fail closed');
  }

  const psWriteTarget = join(wake, 'pwsh-direct-state.json');
  const psWrite = `. ${JSON.stringify(helper)}; Enable-OpkVitestStoreIsolation; Set-Content -LiteralPath ${JSON.stringify(psWriteTarget)} -Value 'red'`;
  const writeResult = spawnSync(pwsh, ['-NoProfile', '-Command', psWrite], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
  if (!writeResult.error && writeResult.status === 0) fail('PowerShell direct write boundary did not fail closed');
  if (existsSync(psWriteTarget)) fail('PowerShell write opened a live-default path before blocking');

  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (!String(packageJson.scripts?.test ?? '').includes('run-vitest-with-harness.mjs')) {
    fail('npm test does not use the pack harness wrapper');
  }
  if (!readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8').includes('OPK_VITEST_HARNESS is required')) {
    fail('raw Vitest invocation is not fail-closed');
  }
} finally {
  for (const root of cleanupRoots) {
    try { cleanupHarnessRoot(root); } catch { /* fixture cleanup remains best effort */ }
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`vitest live-store isolation check failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `vitest live-store isolation check passed (${liveStoreInventory.stores.length} stores; inventory=${relative(repoRoot, inventoryPath)})`,
);
