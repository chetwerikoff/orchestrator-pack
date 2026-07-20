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
  const originalState = process.env.TASK311_EGRESS_STATE;
  const originalLdPreload = process.env.LD_PRELOAD;
  const nodeOptions = [process.env.NODE_OPTIONS ?? '', `--require=${preloadPath}`].filter(Boolean).join(' ');
  const binDir = buildAllowedPath(root, nodeOptions);
  const restoreCurrentProcessNodeTrap = installCurrentProcessNodeTrap(statePath);
  process.env.PATH = binDir;
  process.env.TASK311_EGRESS_STATE = statePath;
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
      if (originalState === undefined) delete process.env.TASK311_EGRESS_STATE; else process.env.TASK311_EGRESS_STATE = originalState;
      if (originalLdPreload === undefined) delete process.env.LD_PRELOAD; else process.env.LD_PRELOAD = originalLdPreload;
    },
  };

  // No real subject may run until the process-wide trap has proved that both
  // current-process and native-child egress are blocked and the probe state is clean.
  runEgressProbe(trap);
  invariant(trap.attempts().length === 0, 'pre-subject egress self-check left recorded attempts');
  return trap;
}

function mutationRecord(mutationId: string): MutationRecord {
  return { mutationId, executed: true, negativeOutcome: 'red', restoredOutcome: 'green' };
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

  const rows = [intentionalEgressControl(trap)];
  validateMutationArray('AC6', rows);
  invariant(trap.attempts().length === 0, 'intentional egress control did not restore clean state');

  return {
    scope: {
      result: 'test-only-offline-capture-backed',
      proofLifetime: 'persistent-hermetic-only',
      prDiffProof: 'one-time-pr-scope-guard',
      trap: {
        active: trap.active,
        unexpectedAttempts: trap.attempts().length,
        nativeLibrary: Boolean(trap.nativeLibrary),
        currentProcessNode: processWide.currentProcessNode === true,
        preSubjectSelfCheck: true,
      },
      capturePath: fixture.capture.path,
      captureSelectors: Object.values(fixture.capture.selectors),
    },
    mutations: rows,
  };
}
