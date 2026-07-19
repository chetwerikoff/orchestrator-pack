import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { runProcessSync } from '../../kernel/subprocess.js';
import {
  fixture,
  installEgressTrap,
  invariant,
  jsonClone,
  repoRoot,
  runGit,
  tempRoot,
  validateMutationArray,
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
  trap: { active: boolean; unexpectedAttempts: number };
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
    trap: { active: trap.active, unexpectedAttempts: trap.attempts().length },
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
    const result = runProcessSync({
      command: 'gh',
      args: ['api', 'repos/fixture/fixture'],
      cwd: repoRoot,
      env: process.env,
      inheritParentEnv: false,
      encoding: 'utf8',
    });
    invariant(result.exitCode === 91, 'intentional GitHub egress was not rejected by process trap');
    const attempts = trap.attempts();
    invariant(attempts.length === 1 && attempts[0]?.edge === 'gh', 'intentional egress was not durably observed');
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
  const scope = {
    result: 'test-only-offline-capture-backed',
    trap: baseline.trap,
    changedPaths: baseline.changes,
    laneConfig: fixture.scope.laneConfig,
    addedHeavyTests: fixture.scope.expectedHeavyTests,
    capturePath: fixture.capture.path,
    captureSelectors: baseline.captureSelectors,
    nonClassificationConfigByteEquivalent: true,
    regularGitModesOnly: true,
  };
  return { scope, mutations: rows };
}
