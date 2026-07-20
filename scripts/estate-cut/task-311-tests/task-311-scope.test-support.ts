import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
  jsonClone,
  repoRoot,
  runGit,
  tempRoot,
  validateMutationArray,
  type EgressAttempt,
  type EgressTrap,
  type MutationRecord,
} from './task-311-common.test-support.js';

interface ChangedPath {
  status: string;
  path: string;
  mode: string;
}

interface ProcessWideEgressTrap extends EgressTrap {
  currentProcessNode: true;
}

interface ScopeSnapshot {
  changes: ChangedPath[];
  baseConfig: Record<string, unknown>;
  currentConfig: Record<string, unknown>;
  captureSelectors: string[];
  trap: {
    active: boolean;
    unexpectedAttempts: number;
    nativeLibrary: boolean;
    currentProcessNode: boolean;
  };
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
  const originalLdPreload = process.env.LD_PRELOAD;
  const nodeOptions = [originalNodeOptions ?? '', `--require=${preloadPath}`].filter(Boolean).join(' ');
  const binDir = buildAllowedPath(root, nodeOptions);
  const restoreCurrentProcessNodeTrap = installCurrentProcessNodeTrap(statePath);
  process.env.PATH = binDir;
  process.env.TASK311_EGRESS_STATE = statePath;
  if (nativeLibrary) process.env.LD_PRELOAD = [nativeLibrary, originalLdPreload ?? ''].filter(Boolean).join(':');

  return {
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
      if (originalState === undefined) delete process.env.TASK311_EGRESS_STATE; else process.env.TASK311_EGRESS_STATE = originalState;
      if (originalLdPreload === undefined) delete process.env.LD_PRELOAD; else process.env.LD_PRELOAD = originalLdPreload;
    },
  };
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  const tokens = output.split('\0').filter(Boolean);
  const rows: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++]!;
    const firstPath = tokens[index++] ?? '';
    if (/^[RC]/.test(status)) {
      const secondPath = tokens[index++] ?? '';
      rows.push({ status, path: firstPath }, { status, path: secondPath });
    } else {
      rows.push({ status, path: firstPath });
    }
  }
  return rows;
}

function gitMode(file: string): string {
  const output = runGit(['ls-tree', 'HEAD', '--', file]).trim();
  if (!output) return '';
  return output.split(/\s+/, 1)[0] ?? '';
}

function currentScopeSnapshot(trap: EgressTrap): ScopeSnapshot {
  const nameStatus = runGit(['diff', '--name-status', '-z', 'origin/main...HEAD']);
  const changes = parseNameStatus(nameStatus).map((entry) => ({ ...entry, mode: gitMode(entry.path) }));
  const baseConfig = JSON.parse(runGit(['show', `origin/main:${fixture.scope.laneConfig}`])) as Record<string, unknown>;
  const currentConfig = JSON.parse(readFileSync(path.join(repoRoot, fixture.scope.laneConfig), 'utf8')) as Record<string, unknown>;
  return {
    changes,
    baseConfig,
    currentConfig,
    captureSelectors: Object.values(fixture.capture.selectors),
    trap: {
      active: trap.active,
      unexpectedAttempts: trap.attempts().length,
      nativeLibrary: Boolean(trap.nativeLibrary),
      currentProcessNode: (trap as Partial<ProcessWideEgressTrap>).currentProcessNode === true,
    },
  };
}

function stringRecord(value: unknown): Record<string, string> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'classification must be an object');
  return value as Record<string, string>;
}

function validateScopeSnapshot(candidate: ScopeSnapshot): void {
  invariant(candidate.changes.length > 0, 'scope diff is empty');
  const expectedAdded = new Set(fixture.scope.expectedAddedPaths);
  const seenAdded = new Set<string>();
  let laneConfigSeen = false;
  for (const change of candidate.changes) {
    invariant(!/^[RCD]/.test(change.status), `forbidden change status ${change.status} for ${change.path}`);
    if (change.path === fixture.scope.laneConfig) {
      invariant(change.status === 'M', 'lane config must be the single modified existing file');
      invariant(!laneConfigSeen, 'lane config appeared more than once');
      laneConfigSeen = true;
    } else {
      invariant(change.status === 'A', `non-config path must be added: ${change.path}`);
      invariant(expectedAdded.has(change.path), `unexpected added path ${change.path}`);
      invariant(change.path.startsWith(fixture.scope.root), `added path outside task root: ${change.path}`);
      invariant(fixture.scope.allowedSuffixes.some((suffix) => change.path.endsWith(suffix)), `forbidden task artifact suffix: ${change.path}`);
      seenAdded.add(change.path);
    }
    invariant(fixture.scope.regularModes.includes(change.mode), `non-regular git mode ${change.mode || '<missing>'} for ${change.path}`);
  }
  invariant(laneConfigSeen, 'lane config modification missing');
  invariant(seenAdded.size === expectedAdded.size && [...expectedAdded].every((file) => seenAdded.has(file)), 'added task artifact set drifted');
  for (const file of fixture.scope.expectedAddedPaths) {
    const absolute = path.join(repoRoot, file);
    invariant(existsSync(absolute) && lstatSync(absolute).isFile(), `task artifact is not a regular file: ${file}`);
  }

  const baseWithoutClassification = jsonClone(candidate.baseConfig);
  const currentWithoutClassification = jsonClone(candidate.currentConfig);
  delete baseWithoutClassification.classification;
  delete currentWithoutClassification.classification;
  invariant(isDeepStrictEqual(currentWithoutClassification, baseWithoutClassification), 'lane config changed outside classification');

  const baseClassification = stringRecord(candidate.baseConfig.classification);
  const currentClassification = stringRecord(candidate.currentConfig.classification);
  for (const [file, lane] of Object.entries(baseClassification)) {
    invariant(currentClassification[file] === lane, `existing classification changed for ${file}`);
  }
  const addedClassification = Object.keys(currentClassification).filter((file) => !(file in baseClassification));
  invariant(addedClassification.length === fixture.scope.expectedHeavyTests.length, 'new classification key count drifted');
  invariant(new Set(addedClassification).size === addedClassification.length, 'duplicate classification keys detected');
  invariant(fixture.scope.expectedHeavyTests.every((file) => addedClassification.includes(file)), 'new classification key set drifted');
  for (const file of addedClassification) invariant(currentClassification[file] === 'heavy', `new TASK-311 classification is not heavy: ${file}`);
  invariant(addedClassification.every((file) => file.endsWith('.test.ts') && seenAdded.has(file)), 'classification does not map exactly to new TASK-311 test paths');

  const declaredSelectors = new Set(Object.values(fixture.capture.selectors));
  invariant(candidate.captureSelectors.every((selector) => declaredSelectors.has(selector)), 'untraced AO selector used');
  invariant(candidate.trap.active === true && candidate.trap.unexpectedAttempts === 0, 'egress trap inactive or unexpected egress observed');
  invariant(candidate.trap.currentProcessNode === true, 'positive boundary lacks current Vitest-process network enforcement');
  invariant(candidate.trap.nativeLibrary || process.platform !== 'linux', 'positive boundary lacks native child-process network enforcement');
}

function mutationRecord(mutationId: string): MutationRecord {
  return { mutationId, executed: true, negativeOutcome: 'red', restoredOutcome: 'green' };
}

function expectCandidateRed(baseline: ScopeSnapshot, mutate: (candidate: ScopeSnapshot) => void, mutationId: string): MutationRecord {
  const candidate = jsonClone(baseline);
  mutate(candidate);
  let red = false;
  try {
    validateScopeSnapshot(candidate);
  } catch {
    red = true;
  }
  invariant(red, `AC6/${mutationId} unexpectedly stayed green`);
  validateScopeSnapshot(jsonClone(baseline));
  return mutationRecord(mutationId);
}

function intentionalEgressControl(trap: EgressTrap): MutationRecord {
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
    return mutationRecord('intentional-external-egress');
  } finally {
    writeFileSync(trap.statePath, priorState, 'utf8');
  }
}

function nonRegularArtifactControl(baseline: ScopeSnapshot): MutationRecord {
  const root = tempRoot('task-311-symlink-control-');
  try {
    runGit(['init', '-q'], root);
    runGit(['config', 'user.email', 'task311@example.invalid'], root);
    runGit(['config', 'user.name', 'task311'], root);
    const relative = fixture.scope.expectedAddedPaths[0]!;
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(path.join(path.dirname(absolute), 'target.txt'), 'target\n', 'utf8');
    symlinkSync('target.txt', absolute);
    runGit(['add', '--', relative], root);
    const mode = runGit(['ls-files', '--stage', '--', relative], root).trim().split(/\s+/, 1)[0] ?? '';
    invariant(mode === '120000', `symlink control did not produce git mode 120000 (got ${mode})`);
    return expectCandidateRed(baseline, (candidate) => {
      const row = candidate.changes.find((change) => change.path === relative);
      invariant(row, 'symlink control target missing from candidate');
      row.mode = mode;
    }, 'non-regular-artifact');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function runScopeGate(trap: EgressTrap): { scope: Record<string, unknown>; mutations: MutationRecord[] } {
  const baseline = currentScopeSnapshot(trap);
  validateScopeSnapshot(baseline);
  const rows: MutationRecord[] = [];
  rows.push(expectCandidateRed(baseline, (candidate) => {
    candidate.changes.push({ status: 'M', path: 'README.md', mode: '100644' });
  }, 'unrelated-existing-path'));
  rows.push(expectCandidateRed(baseline, (candidate) => {
    candidate.currentConfig.lightMaxWorkers = Number(candidate.currentConfig.lightMaxWorkers) + 1;
  }, 'lane-config-overreach'));
  rows.push(expectCandidateRed(baseline, (candidate) => {
    const classification = stringRecord(candidate.currentConfig.classification);
    classification[fixture.scope.expectedHeavyTests[0]!] = 'light';
    classification['scripts/estate-cut/task-311-tests/extra.test.ts'] = 'heavy';
  }, 'classification-missing-extra-or-nonheavy'));
  rows.push(expectCandidateRed(baseline, (candidate) => {
    candidate.changes.push({ status: 'M', path: 'packages/core/src/index.ts', mode: '100644' });
  }, 'production-or-core-edit'));
  rows.push(nonRegularArtifactControl(baseline));
  rows.push(intentionalEgressControl(trap));
  rows.push(expectCandidateRed(baseline, (candidate) => {
    candidate.captureSelectors.push('$.data[0].prNumber');
  }, 'untraced-ao-field'));
  rows.push(expectCandidateRed(baseline, (candidate) => {
    candidate.changes.push({ status: 'M', path: fixture.capture.path, mode: '100644' });
  }, 'capture-corpus-change'));
  validateMutationArray('AC6', rows);
  return {
    scope: {
      result: 'test-only-offline-capture-backed',
      trap: baseline.trap,
      changedPaths: baseline.changes,
      laneConfig: fixture.scope.laneConfig,
      addedHeavyTests: fixture.scope.expectedHeavyTests,
      capturePath: fixture.capture.path,
      captureSelectors: baseline.captureSelectors,
      nonClassificationConfigByteEquivalent: true,
      regularGitModesOnly: true,
    },
    mutations: rows,
  };
}
