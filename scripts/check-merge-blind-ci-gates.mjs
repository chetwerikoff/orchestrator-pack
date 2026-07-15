#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(__dirname, '..');
const INVENTORY_REL = 'scripts/merge-blind-ci-gates.audit.json';
const SELF_REL = 'scripts/check-merge-blind-ci-gates.mjs';
const FIXTURE_PREFIX = 'scripts/fixtures/merge-blind-ci-gates/';
const VALID_CLASSIFICATIONS = new Set(['merge-blind', 'merge-stable', 'intentional-by-design']);
const VALID_DIMENSIONS = new Set([
  'event-source-presence',
  'base-ref-resolution',
  'baked-commit-identity',
  'workflow-trigger-divergence',
]);

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function trackedFiles(repoRoot) {
  return git(repoRoot, ['ls-files', '-z']).split('\0').filter(Boolean).sort();
}

function read(repoRoot, path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function extractWorkflowTriggers(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^on:\s*(?:#.*)?$/.test(line));
  if (start < 0) {
    const inline = lines.find((line) => /^on:\s*\S+/.test(line));
    return inline ? [inline.replace(/^on:\s*/, '').trim()] : [];
  }
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() && !line.trimStart().startsWith('#')) break;
    block.push(line);
  }
  const blockText = block.join('\n');
  const triggers = [];
  if (/^\s{2}pull_request:\s*/m.test(blockText)) triggers.push('pull_request');
  if (/^\s{2}pull_request_target:\s*/m.test(blockText)) triggers.push('pull_request_target');
  if (/^\s{2}workflow_call:\s*/m.test(blockText)) triggers.push('workflow_call');
  if (/^\s{2}workflow_dispatch:\s*/m.test(blockText)) triggers.push('workflow_dispatch');
  if (/^\s{2}schedule:\s*/m.test(blockText)) triggers.push('schedule');
  const pushIndex = block.findIndex((line) => /^\s{2}push:\s*/.test(line));
  if (pushIndex >= 0) {
    const pushLines = [];
    for (let index = pushIndex + 1; index < block.length; index += 1) {
      if (/^\s{2}\S/.test(block[index])) break;
      pushLines.push(block[index]);
    }
    triggers.push(pushLines.some((line) => /^\s+-\s+main\s*(?:#.*)?$/.test(line)) ? 'push:main' : 'push');
  }
  return triggers.sort();
}

function discoverDimensions(repoRoot, files) {
  const discoveries = [];
  for (const path of files) {
    if (!(path.startsWith('scripts/') || path.startsWith('.github/workflows/'))) continue;
    if (path === SELF_REL || path === INVENTORY_REL || path.startsWith(FIXTURE_PREFIX)) continue;
    if (!/\.(?:ps1|mjs|js|ts|mts|cts|json|ya?ml)$/.test(path)) continue;
    const text = read(repoRoot, path);
    if (/isPrValidationContext\s*\(|GITHUB_EVENT_PATH|GITHUB_EVENT_NAME/.test(text)) {
      discoveries.push({ path, dimension: 'event-source-presence' });
    }
    if (/(?:BASE_SHA|GITHUB_BASE_SHA|PR_BASE_SHA)/.test(text) && /origin\/main|refs\/remotes\/origin\/main/.test(text)) {
      discoveries.push({ path, dimension: 'base-ref-resolution' });
    }
    if (/captureCommitSha|PR_HEAD_SHA|HEAD\^2/.test(text)) {
      discoveries.push({ path, dimension: 'baked-commit-identity' });
    }
    if (path.startsWith('.github/workflows/')) {
      discoveries.push({ path, dimension: 'workflow-trigger-divergence' });
    }
  }
  return discoveries;
}

function validateInventoryShape(repoRoot, inventory, files) {
  if (inventory.schemaVersion !== 1 || inventory.issue !== 823) fail(`${INVENTORY_REL} must declare schemaVersion 1 and issue 823`);
  if (!Array.isArray(inventory.discoveryMethods) || inventory.discoveryMethods.length !== 4) {
    fail(`${INVENTORY_REL} must record four re-runnable discovery methods`);
  }
  const discoveryDimensions = new Set(inventory.discoveryMethods?.map((entry) => entry.dimension));
  for (const dimension of VALID_DIMENSIONS) {
    if (!discoveryDimensions.has(dimension)) fail(`inventory lacks discovery command for ${dimension}`);
  }
  for (const entry of inventory.discoveryMethods ?? []) {
    if (!entry.command?.startsWith('git ')) fail(`discovery method ${entry.dimension} must contain an exact git command`);
  }

  const rowIds = new Set();
  const coverage = new Set();
  const workflowRows = new Map();
  for (const row of inventory.rows ?? []) {
    if (!row.id || rowIds.has(row.id)) fail(`inventory row id is missing or duplicated: ${row.id ?? '<empty>'}`);
    rowIds.add(row.id);
    if (!files.includes(row.path)) fail(`inventory row ${row.id} points to untracked/missing path ${row.path}`);
    if (!VALID_CLASSIFICATIONS.has(row.classification)) fail(`inventory row ${row.id} has invalid classification ${row.classification}`);
    if (!row.reason) fail(`inventory row ${row.id} must explain its classification`);
    for (const dimension of row.dimensions ?? []) {
      if (!VALID_DIMENSIONS.has(dimension)) fail(`inventory row ${row.id} has invalid dimension ${dimension}`);
      coverage.add(`${row.path}\0${dimension}`);
    }
    if (row.classification === 'merge-blind') {
      if (!['in-allowed-roots', 'out-of-root'].includes(row.scopeFlag)) fail(`merge-blind row ${row.id} requires scopeFlag`);
      if (row.scopeFlag === 'in-allowed-roots' && (!row.remediation || !row.fixture)) {
        fail(`in-scope merge-blind row ${row.id} requires remediation and parity fixture`);
      }
    } else if ('scopeFlag' in row) {
      fail(`non-merge-blind row ${row.id} must not carry scopeFlag`);
    }
    if (row.path.startsWith('.github/workflows/')) workflowRows.set(row.path, row);
  }

  for (const discovered of discoverDimensions(repoRoot, files)) {
    if (!coverage.has(`${discovered.path}\0${discovered.dimension}`)) {
      fail(`unclassified ${discovered.dimension} candidate: ${discovered.path}`);
    }
  }

  const workflowFiles = files.filter((path) => /^\.github\/workflows\/.*\.ya?ml$/.test(path));
  for (const path of workflowFiles) {
    const row = workflowRows.get(path);
    if (!row) {
      fail(`workflow trigger survey lacks row for ${path}`);
      continue;
    }
    const actual = extractWorkflowTriggers(read(repoRoot, path));
    const expected = [...(row.triggers ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${path} trigger inventory mismatch: expected ${expected.join(', ')}, got ${actual.join(', ')}`);
    }
  }
  for (const path of workflowRows.keys()) {
    if (!workflowFiles.includes(path)) fail(`workflow inventory contains non-workflow path ${path}`);
  }
}

function validateRemediations(repoRoot) {
  const validator = read(repoRoot, 'scripts/lib/validate-supervisor-heavy-lane-rpc-artifacts.mjs');
  if (/isPrValidationContext|GITHUB_EVENT_PATH|PR_HEAD_SHA|PR_BASE_SHA/.test(validator)) {
    fail('RPC validator still contains a PR-context-shaped verdict path');
  }
  if (!validator.includes('scoped-tree-content-v1') || !validator.includes('inspectSupervisorHeavyLaneRpcBinding')) {
    fail('RPC validator must use the scoped-tree content binding evaluator');
  }

  const manifest = JSON.parse(read(repoRoot, 'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json'));
  if (manifest.bindingMode !== 'scoped-tree-content-v1') fail('RPC manifest must declare scoped-tree-content-v1');

  const sequencing = read(repoRoot, 'scripts/check-side-process-registry-709-711-sequencing.ps1');
  if (/requiredCommits|GITHUB_EVENT_PATH|git merge-base --is-ancestor/.test(sequencing)) {
    fail('sequencing guard still relies on event payload or prerequisite commit identity');
  }
  for (const marker of ['Orchestrator-WakeSupervisorLease.ps1', 'Orchestrator-FleetHygiene.ps1', 'resolve-merge-stable-ci-base.mjs']) {
    if (!sequencing.includes(marker)) fail(`sequencing guard lacks semantic marker/binding ${marker}`);
  }

  const registry = read(repoRoot, 'scripts/check-orchestrator-message-registry.ps1');
  if (!registry.includes('resolve-merge-stable-ci-base.mjs') || /'origin\/main'/.test(registry)) {
    fail('message registry guard must delegate to the non-self base resolver');
  }

  const baseline = read(repoRoot, 'scripts/toolchain/baseline-io.ts');
  if (!baseline.includes('resolveMergeStableCiBase') || !baseline.includes('?.baseSha')) {
    fail('baseline-io must delegate comparison-boundary resolution to the shared merge-stable helper');
  }
  const helper = read(repoRoot, 'scripts/lib/resolve-merge-stable-ci-base.mjs');
  if (!helper.includes('mergeBase !== head') || !helper.includes("'HEAD^1'")) {
    fail('shared base resolver must reject self merge-bases and fall back to HEAD^1');
  }

  const scope = read(repoRoot, '.github/workflows/scope-guard.yml');
  const verifyPack = scope.match(/\n  verify-pack:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n)/)?.[1] ?? '';
  if (!/uses:\s*actions\/checkout@v4[\s\S]{0,100}fetch-depth:\s*0/.test(verifyPack)) {
    fail('scope-guard verify-pack checkout must fetch full history for scoped-tree binding');
  }

  const wrapper = read(repoRoot, 'scripts/check-ci-pipeline-split.ps1');
  for (const required of ['check-merge-blind-ci-gates.mjs', 'fixtures/merge-blind-ci-gates/parity.mjs']) {
    if (!wrapper.includes(required)) fail(`CI pipeline wrapper must invoke ${required}`);
  }

  for (const path of [
    'scripts/lib/resolve-merge-stable-ci-base.mjs',
    'scripts/check-merge-blind-ci-gates.mjs',
    'scripts/fixtures/merge-blind-ci-gates/parity.mjs',
  ]) {
    const text = read(repoRoot, path);
    if (/isPrValidationContext\s*\(/.test(text)) fail(`new surface ${path} introduces a PR-context verdict branch`);
    if (/===\s*['"][0-9a-f]{40}['"]/.test(text)) fail(`new surface ${path} introduces a literal SHA equality verdict`);
  }
}

function main() {
  const repoRoot = resolve(process.argv[2] ?? defaultRoot);
  const inventoryPath = join(repoRoot, INVENTORY_REL);
  if (!existsSync(inventoryPath)) {
    fail(`missing ${INVENTORY_REL}`);
    return;
  }
  const files = trackedFiles(repoRoot);
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  validateInventoryShape(repoRoot, inventory, files);
  validateRemediations(repoRoot);
  if (!process.exitCode) {
    console.log(`[PASS] merge-blind CI gate audit: ${inventory.rows.length} classified sites, ${inventory.discoveryMethods.length} discovery dimensions`);
  }
}

main();
