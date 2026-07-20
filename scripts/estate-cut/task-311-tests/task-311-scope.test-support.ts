import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { runProcessSync } from '../../kernel/subprocess.js';
import {
  fixture,
  invariant,
  repoRoot,
  validateMutationArray,
  type EgressAttempt,
  type EgressTrap,
  type MutationRecord,
} from './task-311-common.test-support.js';

interface ProcessWideEgressTrap extends EgressTrap {
  currentProcessNode: true;
}

interface ChangedPath {
  status: string;
  path: string;
  mode: string;
}

interface ScopeProofSnapshot {
  changes: ChangedPath[];
  baseConfig: Record<string, unknown>;
  currentConfig: Record<string, unknown>;
  baseConfigText: string;
  currentConfigText: string;
  captureSelectors: string[];
}

function resolveExecutable(name: string, explicit = ''): string {
  if (explicit && existsSync(explicit)) return explicit;
  const pathValue = process.env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? ['', '.exe', '.cmd', '.bat']
    : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`cannot resolve required executable ${name} from PATH`);
}

function linkAllowedExecutable(binDir: string, name: string, target: string): void {
  if (process.platform === 'win32') {
    writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\n"${target}" %*\r\n`, 'utf8');
    return;
  }
  symlinkSync(target, path.join(binDir, name));
}

function shellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeAllowedNodeWrapper(binDir: string, nodeOptions: string): void {
  const target = process.execPath;
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(binDir, 'node.cmd'),
      `@echo off\r\nset "NODE_OPTIONS=${nodeOptions}"\r\n"${target}" %*\r\n`,
      'utf8',
    );
    return;
  }
  const wrapper = path.join(binDir, 'node');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexport NODE_OPTIONS=${shellSingleQuoted(nodeOptions)}\nexec "${target}" "$@"\n`,
    'utf8',
  );
  chmodSync(wrapper, 0o700);
}

function buildAllowedPath(root: string, nodeOptions: string): string {
  const binDir = path.join(root, 'allowed-bin');
  mkdirSync(binDir, { recursive: true });
  writeAllowedNodeWrapper(binDir, nodeOptions);
  linkAllowedExecutable(binDir, 'git', resolveExecutable('git', process.env.GIT_REAL_BINARY || process.env.GIT_SYSTEM_BINARY || ''));
  linkAllowedExecutable(binDir, 'pwsh', resolveExecutable('pwsh', process.env.OPK_REAL_PWSH || ''));
  if (process.platform !== 'win32') {
    for (const name of ['sh', 'bash', 'cc']) {
      linkAllowedExecutable(binDir, name, resolveExecutable(name));
    }
  }
  return binDir;
}

function buildNativeNetworkTrap(root: string): string {
  if (process.platform !== 'linux') return '';
  const sourcePath = path.join(root, 'task311-nettrap.c');
  const libraryPath = path.join(root, 'task311-nettrap.so');
  writeFileSync(sourcePath, String.raw`
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static void record_attempt(const char *edge, int family) {
  const char *state = getenv("TASK311_EGRESS_STATE");
  if (!state || !*state) return;
  int fd = open(state, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd < 0) return;
  char row[256];
  int n = snprintf(row, sizeof(row), "{\"kind\":\"native\",\"edge\":\"%s\",\"detail\":\"family=%d\"}\n", edge, family);
  if (n > 0) (void)write(fd, row, (size_t)n);
  close(fd);
}

int connect(int fd, const struct sockaddr *addr, socklen_t length) {
  static int (*real_connect)(int, const struct sockaddr *, socklen_t) = NULL;
  if (addr && (addr->sa_family == AF_INET || addr->sa_family == AF_INET6)) {
    record_attempt("native-connect", addr->sa_family);
    errno = EPERM;
    return -1;
  }
  if (!real_connect) real_connect = dlsym(RTLD_NEXT, "connect");
  return real_connect(fd, addr, length);
}

`, 'utf8');
  const compiled = runProcessSync({
    command: 'cc',
    args: ['-shared', '-fPIC', '-O2', '-Wall', '-o', libraryPath, sourcePath, '-ldl'],
    cwd: root,
    env: process.env,
    inheritParentEnv: false,
    encoding: 'utf8',
  });
  invariant(compiled.exitCode === 0 && existsSync(libraryPath), `native egress trap compilation failed: ${compiled.stderr || compiled.stdout || compiled.error}`);
  return libraryPath;
}

function installCurrentProcessNodeTrap(statePath: string): () => void {
  const require = createRequire(import.meta.url);
  const restorers: Array<() => void> = [];
  const record = (edge: string, detail = ''): never => {
    appendFileSync(statePath, `${JSON.stringify({ kind: 'node-current', edge, detail })}\n`, 'utf8');
    const error = new Error(`TASK311_EGRESS_BLOCKED:${edge}`) as Error & { code?: string };
    error.code = 'TASK311_EGRESS_BLOCKED';
    throw error;
  };
  const patchFunction = (target: Record<string, unknown>, name: string, edge: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    invariant(descriptor && typeof descriptor.value === 'function', `current-process egress edge is not patchable: ${edge}`);
    Object.defineProperty(target, name, {
      ...descriptor,
      value: (...args: unknown[]) => record(edge, String(args[0] ?? '')),
    });
    restorers.push(() => Object.defineProperty(target, name, descriptor));
  };

  const moduleEdges: Array<[Record<string, unknown>, string, string]> = [];
  for (const [moduleName, names] of [
    ['node:http', ['request', 'get']],
    ['node:https', ['request', 'get']],
    ['node:net', ['connect', 'createConnection']],
    ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
    ['node:dns/promises', ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ] as const) {
    const module = require(moduleName) as Record<string, unknown>;
    for (const name of names) moduleEdges.push([module, name, `${moduleName}.${name}`]);
  }
  const dns = require('node:dns') as { promises?: Record<string, unknown> };
  if (dns.promises) {
    for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
      moduleEdges.push([dns.promises, name, `node:dns.promises.${name}`]);
    }
  }
  for (const [module, name, edge] of moduleEdges) patchFunction(module, name, edge);

  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  invariant(fetchDescriptor && typeof fetchDescriptor.value === 'function', 'global fetch is unavailable for current-process trapping');
  Object.defineProperty(globalThis, 'fetch', {
    ...fetchDescriptor,
    value: (...args: unknown[]) => record('fetch', String(args[0] ?? '')),
  });
  restorers.push(() => Object.defineProperty(globalThis, 'fetch', fetchDescriptor));

  syncBuiltinESMExports();
  return () => {
    for (const restore of restorers.reverse()) restore();
    syncBuiltinESMExports();
  };
}

function runEgressProbe(trap: EgressTrap): void {
  const priorState = existsSync(trap.statePath) ? readFileSync(trap.statePath, 'utf8') : '';
  const priorAttempts = trap.attempts().length;
  try {
    let currentProcessBlocked = false;
    try {
      void globalThis.fetch('https://task311.invalid/current-process-probe');
    } catch (error) {
      currentProcessBlocked = (error as { code?: string }).code === 'TASK311_EGRESS_BLOCKED';
    }
    invariant(currentProcessBlocked, 'intentional current-process fetch was not rejected');
    const currentAttempts = trap.attempts().slice(priorAttempts);
    invariant(
      currentAttempts.some((attempt) => attempt.kind === 'node-current' && attempt.edge === 'fetch'),
      'intentional current-process fetch was not durably observed',
    );

    const directNodeChild = runProcessSync({
      command: process.execPath,
      args: [
        '-e',
        "try{fetch('https://task311.invalid/direct-child-probe')}catch(e){process.exit(e&&e.code==='TASK311_EGRESS_BLOCKED'?93:94)};setTimeout(()=>process.exit(95),50);",
      ],
      cwd: repoRoot,
      env: process.env,
      inheritParentEnv: false,
      encoding: 'utf8',
    });
    invariant(
      directNodeChild.exitCode === 93,
      `direct Node child bypassed the egress preloader (${directNodeChild.exitCode ?? directNodeChild.outcome})`,
    );
    const childAttempts = trap.attempts().slice(priorAttempts);
    invariant(
      childAttempts.some((attempt) => attempt.kind === 'node-child' && attempt.edge === 'fetch'),
      'direct Node child egress was not durably observed',
    );

    if (process.platform === 'linux') {
      invariant(Boolean(trap.nativeLibrary), 'native egress probe requires the Linux preload library');
      const childEnv = { ...process.env, NODE_OPTIONS: '' };
      const result = runProcessSync({
        command: process.execPath,
        args: ['-e', "const net=require('node:net');const s=net.connect(9,'127.0.0.1');s.on('error',()=>process.exit(91));setTimeout(()=>process.exit(92),500);"],
        cwd: repoRoot,
        env: childEnv,
        inheritParentEnv: false,
        encoding: 'utf8',
      });
      invariant(result.exitCode === 91, `intentional native egress was not rejected (${result.exitCode ?? result.outcome})`);
      const addedAttempts = trap.attempts().slice(priorAttempts);
      invariant(addedAttempts.some((attempt) => attempt.edge === 'native-connect'), 'intentional native egress was not durably observed');
    }
  } finally {
    writeFileSync(trap.statePath, priorState, 'utf8');
  }
  invariant(trap.attempts().length === priorAttempts, 'egress probe state was not restored');
}

export function installEgressTrap(root: string): ProcessWideEgressTrap {
  const statePath = path.join(root, 'egress.jsonl');
  const preloadPath = path.join(root, 'egress-preload.cjs');
  writeFileSync(statePath, '', 'utf8');
  const nativeLibrary = buildNativeNetworkTrap(root);
  writeFileSync(preloadPath, `
const fs = require('node:fs');
const state = process.env.TASK311_EGRESS_STATE;
const record = (edge, detail='') => {
  if (state) fs.appendFileSync(state, JSON.stringify({ kind: 'node-child', edge, detail }) + '\\n');
  const error = new Error('TASK311_EGRESS_BLOCKED:' + edge);
  error.code = 'TASK311_EGRESS_BLOCKED';
  throw error;
};
for (const [moduleName, names] of [
  ['node:http', ['request', 'get']],
  ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']],
  ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ['node:dns/promises', ['lookup', 'resolve', 'resolve4', 'resolve6']]
]) {
  const mod = require(moduleName);
  for (const name of names) {
    try { Object.defineProperty(mod, name, { configurable: true, writable: true, value: (...args) => record(moduleName + '.' + name, String(args[0] ?? '')) }); } catch {}
  }
}
globalThis.fetch = (...args) => record('fetch', String(args[0] ?? ''));
`, 'utf8');
  const originalPath = process.env.PATH;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const originalState = process.env.TASK311_EGRESS_STATE;
  const originalPreload = process.env.TASK311_EGRESS_PRELOAD;
  const originalLdPreload = process.env.LD_PRELOAD;
  const nodeOptions = [originalNodeOptions ?? '', `--require=${preloadPath}`].filter(Boolean).join(' ');
  const binDir = buildAllowedPath(root, nodeOptions);
  const restoreCurrentProcessNodeTrap = installCurrentProcessNodeTrap(statePath);
  process.env.PATH = binDir;
  process.env.NODE_OPTIONS = nodeOptions;
  process.env.TASK311_EGRESS_STATE = statePath;
  process.env.TASK311_EGRESS_PRELOAD = preloadPath;
  if (nativeLibrary) process.env.LD_PRELOAD = [nativeLibrary, originalLdPreload ?? ''].filter(Boolean).join(':');

  const trap: ProcessWideEgressTrap = {
    active: true,
    currentProcessNode: true,
    root,
    binDir,
    statePath,
    nodeOptions,
    nativeLibrary,
    attempts() {
      if (!existsSync(statePath)) return [];
      return readFileSync(statePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .map((line) => JSON.parse(line) as EgressAttempt);
    },
    restore() {
      restoreCurrentProcessNodeTrap();
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalNodeOptions;
      if (originalState === undefined) delete process.env.TASK311_EGRESS_STATE; else process.env.TASK311_EGRESS_STATE = originalState;
      if (originalPreload === undefined) delete process.env.TASK311_EGRESS_PRELOAD; else process.env.TASK311_EGRESS_PRELOAD = originalPreload;
      if (originalLdPreload === undefined) delete process.env.LD_PRELOAD; else process.env.LD_PRELOAD = originalLdPreload;
    },
  };

  runEgressProbe(trap);
  invariant(trap.attempts().length === 0, 'pre-subject egress self-check left recorded attempts');
  return trap;
}

function mutationRecord(mutationId: string): MutationRecord {
  return { mutationId, executed: true, negativeOutcome: 'red', restoredOutcome: 'green' };
}

function cloneSnapshot(snapshot: ScopeProofSnapshot): ScopeProofSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ScopeProofSnapshot;
}

function stringRecord(value: unknown): Record<string, string> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'classification must be an object');
  return value as Record<string, string>;
}

function expectedLaneConfigText(baseConfigText: string): string {
  invariant(fixture.scope.expectedHeavyTests.length === 1, 'immutable scope proof requires exactly one TASK-311 classification');
  const file = fixture.scope.expectedHeavyTests[0]!;
  const base = JSON.parse(baseConfigText) as Record<string, unknown>;
  const classification = stringRecord(base.classification);
  invariant(!(file in classification), `TASK-311 classification already exists in immutable base snapshot: ${file}`);
  const nextKey = Object.keys(classification).find((candidate) => candidate.localeCompare(file) > 0);
  invariant(nextKey, `cannot locate immutable insertion anchor for ${file}`);
  const anchor = `    ${JSON.stringify(nextKey)}: ${JSON.stringify(classification[nextKey])}`;
  const offset = baseConfigText.indexOf(anchor);
  invariant(offset >= 0, `immutable lane-config anchor missing for ${nextKey}`);
  const inserted = `    ${JSON.stringify(file)}: "heavy",\n`;
  return `${baseConfigText.slice(0, offset)}${inserted}${baseConfigText.slice(offset)}`;
}

function immutableScopeProofSnapshot(): ScopeProofSnapshot {
  const baseConfig = {
    schemaVersion: 1,
    classification: {
      'scripts/estate-cut/issue-906-vertical-slice.test.ts': 'heavy',
      'scripts/lib/example-contract.test.ts': 'light',
    },
    batching: { maxShardWeight: 100 },
  };
  const baseConfigText = `${JSON.stringify(baseConfig, null, 2)}\n`;
  const currentConfigText = expectedLaneConfigText(baseConfigText);
  const currentConfig = JSON.parse(currentConfigText) as Record<string, unknown>;
  const regularMode = fixture.scope.regularModes[0] ?? '100644';
  return {
    changes: [
      { status: 'M', path: fixture.scope.laneConfig, mode: regularMode },
      ...fixture.scope.expectedAddedPaths.map((file) => ({ status: 'A', path: file, mode: regularMode })),
    ],
    baseConfig,
    currentConfig,
    baseConfigText,
    currentConfigText,
    captureSelectors: Object.values(fixture.capture.selectors),
  };
}

function validateScopeProofSnapshot(candidate: ScopeProofSnapshot): void {
  const expectedAdded = new Set(fixture.scope.expectedAddedPaths);
  const seenAdded = new Set<string>();
  let laneConfigSeen = false;
  for (const change of candidate.changes) {
    invariant(!/^[RCD]/.test(change.status), `forbidden immutable-snapshot change status ${change.status} for ${change.path}`);
    if (change.path === fixture.scope.laneConfig) {
      invariant(change.status === 'M', 'lane config must be the single modified existing file in the immutable scope proof');
      invariant(!laneConfigSeen, 'lane config appeared more than once in the immutable scope proof');
      laneConfigSeen = true;
    } else {
      invariant(change.status === 'A', `non-config immutable-snapshot path must be added: ${change.path}`);
      invariant(expectedAdded.has(change.path), `unexpected immutable-snapshot path ${change.path}`);
      invariant(change.path.startsWith(fixture.scope.root), `immutable-snapshot path escaped task root: ${change.path}`);
      invariant(fixture.scope.allowedSuffixes.some((suffix) => change.path.endsWith(suffix)), `forbidden immutable-snapshot suffix: ${change.path}`);
      seenAdded.add(change.path);
    }
    invariant(fixture.scope.regularModes.includes(change.mode), `non-regular immutable-snapshot mode ${change.mode || '<missing>'} for ${change.path}`);
  }
  invariant(laneConfigSeen, 'immutable scope proof lacks the lane-config modification');
  invariant(seenAdded.size === expectedAdded.size && [...expectedAdded].every((file) => seenAdded.has(file)), 'immutable task artifact set drifted');

  const expectedConfigText = expectedLaneConfigText(candidate.baseConfigText);
  invariant(candidate.currentConfigText === expectedConfigText, 'immutable lane-config bytes changed outside the exact TASK-311 insertion');

  const baseWithoutClassification = JSON.parse(JSON.stringify(candidate.baseConfig)) as Record<string, unknown>;
  const currentWithoutClassification = JSON.parse(JSON.stringify(candidate.currentConfig)) as Record<string, unknown>;
  delete baseWithoutClassification.classification;
  delete currentWithoutClassification.classification;
  invariant(isDeepStrictEqual(currentWithoutClassification, baseWithoutClassification), 'immutable lane config changed outside classification');

  const baseClassification = stringRecord(candidate.baseConfig.classification);
  const currentClassification = stringRecord(candidate.currentConfig.classification);
  for (const [file, lane] of Object.entries(baseClassification)) {
    invariant(currentClassification[file] === lane, `immutable existing classification changed for ${file}`);
  }
  const addedClassification = Object.keys(currentClassification).filter((file) => !(file in baseClassification));
  invariant(addedClassification.length === fixture.scope.expectedHeavyTests.length, 'immutable classification key count drifted');
  invariant(new Set(addedClassification).size === addedClassification.length, 'immutable classification contains duplicate keys');
  invariant(fixture.scope.expectedHeavyTests.every((file) => addedClassification.includes(file)), 'immutable classification key set drifted');
  for (const file of addedClassification) invariant(currentClassification[file] === 'heavy', `immutable TASK-311 classification is not heavy: ${file}`);
  invariant(addedClassification.every((file) => file.endsWith('.test.ts') && seenAdded.has(file)), 'immutable classification does not map to the TASK-311 test');

  const declaredSelectors = new Set(Object.values(fixture.capture.selectors));
  invariant(candidate.captureSelectors.every((selector) => declaredSelectors.has(selector)), 'untraced AO selector used in immutable scope proof');
}

function expectScopeControlRed(
  baseline: ScopeProofSnapshot,
  mutationId: string,
  mutate: (candidate: ScopeProofSnapshot) => void,
): MutationRecord {
  const candidate = cloneSnapshot(baseline);
  mutate(candidate);
  let red = false;
  try {
    validateScopeProofSnapshot(candidate);
  } catch {
    red = true;
  }
  invariant(red, `AC6/${mutationId} immutable-snapshot mutation unexpectedly stayed green`);
  validateScopeProofSnapshot(cloneSnapshot(baseline));
  return mutationRecord(mutationId);
}

function intentionalEgressControl(trap: EgressTrap): MutationRecord {
  runEgressProbe(trap);
  return mutationRecord('intentional-external-egress');
}

export function runScopeGate(trap: EgressTrap): { scope: Record<string, unknown>; mutations: MutationRecord[] } {
  const processWide = trap as Partial<ProcessWideEgressTrap>;
  invariant(trap.active === true, 'egress trap is inactive');
  invariant(trap.attempts().length === 0, 'unexpected egress was observed before the hermetic gate');
  invariant(processWide.currentProcessNode === true, 'current Vitest-process network enforcement is missing');
  invariant(Boolean(trap.nativeLibrary) || process.platform !== 'linux', 'native child-process network enforcement is missing');

  const baseline = immutableScopeProofSnapshot();
  validateScopeProofSnapshot(baseline);
  const rows: MutationRecord[] = [
    expectScopeControlRed(baseline, 'unrelated-existing-path', (candidate) => {
      candidate.changes.push({ status: 'M', path: 'README.md', mode: '100644' });
    }),
    expectScopeControlRed(baseline, 'lane-config-overreach', (candidate) => {
      candidate.currentConfigText += '\n';
    }),
    expectScopeControlRed(baseline, 'classification-missing-extra-or-nonheavy', (candidate) => {
      const classification = stringRecord(candidate.currentConfig.classification);
      classification[fixture.scope.expectedHeavyTests[0]!] = 'light';
      classification['scripts/estate-cut/task-311-tests/extra.test.ts'] = 'heavy';
    }),
    expectScopeControlRed(baseline, 'production-or-core-edit', (candidate) => {
      candidate.changes.push({ status: 'M', path: 'packages/core/src/index.ts', mode: '100644' });
    }),
    expectScopeControlRed(baseline, 'non-regular-artifact', (candidate) => {
      const row = candidate.changes.find((change) => change.path === fixture.scope.expectedAddedPaths[0]);
      invariant(row, 'immutable non-regular control target missing');
      row.mode = '120000';
    }),
    intentionalEgressControl(trap),
    expectScopeControlRed(baseline, 'untraced-ao-field', (candidate) => {
      candidate.captureSelectors.push('$.data[0].prNumber');
    }),
    expectScopeControlRed(baseline, 'capture-corpus-change', (candidate) => {
      candidate.changes.push({ status: 'M', path: fixture.capture.path, mode: '100644' });
    }),
  ];
  validateMutationArray('AC6', rows);
  invariant(trap.attempts().length === 0, 'intentional egress control did not restore clean state');

  return {
    scope: {
      result: 'test-only-offline-capture-backed',
      proofLifetime: 'persistent-hermetic-and-immutable-scope-contract',
      livePrDiffRead: false,
      prDiffProof: 'one-time-pr-scope-guard',
      immutableScopeSnapshot: {
        changedPathCount: baseline.changes.length,
        laneConfig: fixture.scope.laneConfig,
        addedPaths: fixture.scope.expectedAddedPaths,
        heavyTests: fixture.scope.expectedHeavyTests,
      },
      trap: {
        active: trap.active,
        unexpectedAttempts: trap.attempts().length,
        nativeLibrary: Boolean(trap.nativeLibrary),
        currentProcessNode: processWide.currentProcessNode === true,
        directNodeChildPreloader: true,
        preSubjectSelfCheck: true,
      },
      capturePath: fixture.capture.path,
      captureSelectors: Object.values(fixture.capture.selectors),
    },
    mutations: rows,
  };
}
