import dns from 'node:dns';
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
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path, { delimiter } from 'node:path';
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

interface ScopeSnapshot {
  changes: ChangedPath[];
  baseConfig: Record<string, unknown>;
  currentConfig: Record<string, unknown>;
  captureSelectors: string[];
  trap: { active: boolean; unexpectedAttempts: number; nativeLibrary: boolean };
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, 'utf8');
  if (process.platform !== 'win32') chmodSync(file, 0o700);
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
    args: ['-shared', '-fPIC', '-O2', '-Wall', '-Werror', '-o', libraryPath, sourcePath, '-ldl'],
    cwd: root,
    env: process.env,
    inheritParentEnv: false,
    encoding: 'utf8',
  });
  invariant(compiled.exitCode === 0 && existsSync(libraryPath), `native egress trap compilation failed: ${compiled.stderr || compiled.stdout || compiled.error}`);
  return libraryPath;
}

export function installEgressTrap(root: string): EgressTrap {
  const binDir = path.join(root, 'egress-bin');
  const statePath = path.join(root, 'egress.jsonl');
  const preloadPath = path.join(root, 'egress-preload.cjs');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(statePath, '', 'utf8');
  const nativeLibrary = buildNativeNetworkTrap(root);
  writeFileSync(preloadPath, `
const fs = require('node:fs');
const state = process.env.TASK311_EGRESS_STATE;
const record = (edge, detail='') => {
  if (state) fs.appendFileSync(state, JSON.stringify({ kind: 'node', edge, detail }) + '\\n');
  const error = new Error('TASK311_EGRESS_BLOCKED:' + edge);
  error.code = 'TASK311_EGRESS_BLOCKED';
  throw error;
};
for (const [moduleName, names] of [
  ['node:http', ['request', 'get']],
  ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']],
  ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']]
]) {
  const mod = require(moduleName);
  for (const name of names) {
    try { Object.defineProperty(mod, name, { configurable: true, writable: true, value: (...args) => record(moduleName + '.' + name, String(args[0] ?? '')) }); } catch {}
  }
}
globalThis.fetch = (...args) => record('fetch', String(args[0] ?? ''));
`, 'utf8');
  for (const edge of ['gh', 'ao', 'curl', 'wget', 'ssh', 'nc']) {
    if (process.platform === 'win32') {
      writeExecutable(path.join(binDir, `${edge}.cmd`), `@echo {"kind":"process","edge":"${edge}"}>>"%TASK311_EGRESS_STATE%"\r\necho TASK311_EGRESS_BLOCKED:${edge} 1>&2\r\nexit /b 91\r\n`);
    } else {
      writeExecutable(path.join(binDir, edge), `#!/usr/bin/env sh\nprintf '%s\\n' '{"kind":"process","edge":"${edge}"}' >> "$TASK311_EGRESS_STATE"\necho 'TASK311_EGRESS_BLOCKED:${edge}' >&2\nexit 91\n`);
    }
  }

  const originalPath = process.env.PATH;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const originalState = process.env.TASK311_EGRESS_STATE;
  const originalLdPreload = process.env.LD_PRELOAD;
  const originalFetch = globalThis.fetch;
  const patched: Array<{ target: Record<string, unknown>; key: string; value: unknown }> = [];
  const block = (edge: string) => (...args: unknown[]): never => {
    appendFileSync(statePath, `${JSON.stringify({ kind: 'node', edge, detail: String(args[0] ?? '') })}\n`, 'utf8');
    throw Object.assign(new Error(`TASK311_EGRESS_BLOCKED:${edge}`), { code: 'TASK311_EGRESS_BLOCKED' });
  };
  const patch = (target: Record<string, unknown>, key: string, edge: string): void => {
    patched.push({ target, key, value: target[key] });
    Object.defineProperty(target, key, { configurable: true, writable: true, value: block(edge) });
  };

  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
  process.env.TASK311_EGRESS_STATE = statePath;
  process.env.NODE_OPTIONS = [originalNodeOptions ?? '', `--require=${preloadPath}`].filter(Boolean).join(' ');
  if (nativeLibrary) process.env.LD_PRELOAD = [nativeLibrary, originalLdPreload ?? ''].filter(Boolean).join(':');
  globalThis.fetch = block('fetch') as typeof fetch;
  patch(http as unknown as Record<string, unknown>, 'request', 'node:http.request');
  patch(http as unknown as Record<string, unknown>, 'get', 'node:http.get');
  patch(https as unknown as Record<string, unknown>, 'request', 'node:https.request');
  patch(https as unknown as Record<string, unknown>, 'get', 'node:https.get');
  patch(net as unknown as Record<string, unknown>, 'connect', 'node:net.connect');
  patch(net as unknown as Record<string, unknown>, 'createConnection', 'node:net.createConnection');
  patch(dns as unknown as Record<string, unknown>, 'lookup', 'node:dns.lookup');
  patch(dns as unknown as Record<string, unknown>, 'resolve', 'node:dns.resolve');

  return {
    active: true,
    root,
    binDir,
    statePath,
    nodeOptions: process.env.NODE_OPTIONS,
    nativeLibrary,
    attempts() {
      if (!existsSync(statePath)) return [];
      return readFileSync(statePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .map((line) => JSON.parse(line) as EgressAttempt);
    },
    restore() {
      globalThis.fetch = originalFetch;
      for (const entry of patched.reverse()) {
        Object.defineProperty(entry.target, entry.key, { configurable: true, writable: true, value: entry.value });
      }
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalNodeOptions;
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
    trap: { active: trap.active, unexpectedAttempts: trap.attempts().length, nativeLibrary: Boolean(trap.nativeLibrary) },
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

function intentionalEgressControl(): MutationRecord {
  const root = tempRoot('task-311-egress-control-');
  const trap = installEgressTrap(root);
  try {
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
    const attempts = trap.attempts();
    invariant(attempts.some((attempt) => attempt.edge === 'native-connect'), 'intentional native egress was not durably observed');
    return mutationRecord('intentional-external-egress');
  } finally {
    trap.restore();
    rmSync(root, { recursive: true, force: true });
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
  rows.push(intentionalEgressControl());
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
