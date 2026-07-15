#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
const WALK_EXCLUDES = new Set(['.git', '.worktrees', 'node_modules', 'artifacts', 'coverage']);

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

function read(repoRoot, path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function walkTrackedFallback(repoRoot) {
  const files = [];
  const visit = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && WALK_EXCLUDES.has(entry.name)) continue;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(relative(repoRoot, child).replaceAll('\\', '/'));
    }
  };
  visit(repoRoot);
  return files.sort();
}

function parseArgs(argv) {
  const result = { repoRoot: defaultRoot, trackedFilesPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo-root') result.repoRoot = resolve(argv[++index]);
    else if (arg === '--tracked-files') result.trackedFilesPath = resolve(argv[++index]);
    else if (!arg.startsWith('-') && result.repoRoot === defaultRoot) result.repoRoot = resolve(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

function trackedFiles(repoRoot, trackedFilesPath) {
  if (!trackedFilesPath) return walkTrackedFallback(repoRoot);
  const parsed = JSON.parse(readFileSync(trackedFilesPath, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error('--tracked-files must point to a JSON string array');
  }
  return [...new Set(parsed.map((entry) => entry.replaceAll('\\', '/')))].sort();
}

function extractWorkflowTriggers(text) {
  const lines = text.split(/\r?\n/);
  const inline = lines.find((line) => /^on:\s*\S+/.test(line));
  if (inline) {
    const raw = inline.replace(/^on:\s*/, '').trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      return raw.slice(1, -1).split(',').map((entry) => entry.trim()).filter(Boolean).sort();
    }
    return [raw];
  }

  const start = lines.findIndex((line) => /^on:\s*(?:#.*)?$/.test(line));
  if (start < 0) return [];
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
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

function classifyWorkflow(path, triggers, exception) {
  const hasPr = triggers.includes('pull_request');
  const hasPush = triggers.includes('push') || triggers.includes('push:main');
  if (hasPr && hasPush) {
    return { classification: 'merge-stable', reason: 'same workflow is admitted on pull_request and push' };
  }
  if (hasPr) {
    if (!exception) return { classification: 'merge-blind', reason: 'pull_request workflow has no push sibling or explicit exception' };
    return exception;
  }
  if (triggers.includes('pull_request_target')) {
    return { classification: 'intentional-by-design', reason: 'trusted-base privileged PR admission/reaction surface' };
  }
  if (triggers.includes('workflow_call')) {
    return { classification: 'intentional-by-design', reason: 'reusable workflow; trigger parity is owned by callers' };
  }
  if (triggers.some((trigger) => ['push', 'push:main', 'schedule', 'workflow_dispatch'].includes(trigger))) {
    return { classification: 'intentional-by-design', reason: 'post-merge, scheduled, or operator-only workflow' };
  }
  return { classification: 'merge-blind', reason: `unrecognized or empty trigger set for ${path}` };
}

function discoverDimensions(repoRoot, files) {
  const discoveries = [];
  for (const path of files) {
    if (!path.startsWith('scripts/')) continue;
    if (path === SELF_REL || path === INVENTORY_REL || path.startsWith(FIXTURE_PREFIX)) continue;
    if (!/\.(?:ps1|mjs|js|ts|mts|cts|json)$/.test(path)) continue;
    const text = read(repoRoot, path);
    if (/isPrValidationContext\s*\(|GITHUB_EVENT_PATH|GITHUB_EVENT_NAME/.test(text)) {
      discoveries.push({ path, dimension: 'event-source-presence', text });
    }
    if (/(?:BASE_SHA|GITHUB_BASE_SHA|PR_BASE_SHA)/.test(text) && /origin\/main|refs\/remotes\/origin\/main/.test(text)) {
      discoveries.push({ path, dimension: 'base-ref-resolution', text });
    }
    if (/captureCommitSha|PR_HEAD_SHA|HEAD\^2/.test(text)) {
      discoveries.push({ path, dimension: 'baked-commit-identity', text });
    }
  }
  return discoveries;
}

function automaticCandidateClassification(candidate) {
  if (candidate.dimension === 'event-source-presence') {
    if (/isPrValidationContext\s*\(/.test(candidate.text)) {
      return { classification: 'merge-blind', reason: 'PR-context predicate can alter a verdict' };
    }
    return { classification: 'intentional-by-design', reason: 'event value is consumed without a PR-only leniency predicate' };
  }
  if (candidate.dimension === 'base-ref-resolution') {
    if (/mergeBase\s*!==\s*head|\$mergeBase\s+-ne\s+\$head/.test(candidate.text) && /HEAD\^1/.test(candidate.text)) {
      return { classification: 'merge-stable', reason: 'self merge-base is rejected and first-parent fallback is explicit' };
    }
    return { classification: 'merge-blind', reason: 'direct base fallback lacks a non-self invariant' };
  }
  if (candidate.dimension === 'baked-commit-identity') {
    if (/isPrValidationContext\s*\(/.test(candidate.text)) {
      return { classification: 'merge-blind', reason: 'commit identity participates in a PR-only branch' };
    }
    return { classification: 'intentional-by-design', reason: 'commit identity is provenance/diagnostic data, not a lenient verdict' };
  }
  return { classification: 'merge-blind', reason: 'unknown candidate dimension' };
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
  if (inventory.workflowSurvey?.mode !== 'dynamic-fail-closed') {
    fail('workflowSurvey.mode must be dynamic-fail-closed');
  }

  const rowIds = new Set();
  const explicit = new Map();
  for (const row of inventory.rows ?? []) {
    if (!row.id || rowIds.has(row.id)) fail(`inventory row id is missing or duplicated: ${row.id ?? '<empty>'}`);
    rowIds.add(row.id);
    if (!files.includes(row.path)) fail(`inventory row ${row.id} points to untracked/missing path ${row.path}`);
    if (!VALID_CLASSIFICATIONS.has(row.classification)) fail(`inventory row ${row.id} has invalid classification ${row.classification}`);
    if (!row.reason) fail(`inventory row ${row.id} must explain its classification`);
    for (const dimension of row.dimensions ?? []) {
      if (!VALID_DIMENSIONS.has(dimension)) fail(`inventory row ${row.id} has invalid dimension ${dimension}`);
      explicit.set(`${row.path}\0${dimension}`, row);
    }
    if (row.classification === 'merge-blind') {
      if (!['in-allowed-roots', 'out-of-root'].includes(row.scopeFlag)) fail(`merge-blind row ${row.id} requires scopeFlag`);
      if (row.scopeFlag === 'in-allowed-roots' && (!row.remediation || !row.fixture)) {
        fail(`in-scope merge-blind row ${row.id} requires remediation and parity fixture`);
      }
    } else if ('scopeFlag' in row) {
      fail(`non-merge-blind row ${row.id} must not carry scopeFlag`);
    }
  }

  for (const candidate of discoverDimensions(repoRoot, files)) {
    const row = explicit.get(`${candidate.path}\0${candidate.dimension}`);
    const classification = row ?? automaticCandidateClassification(candidate);
    console.log(`[AUDIT] ${candidate.dimension} ${candidate.path} => ${classification.classification}: ${classification.reason}`);
    if (!row && classification.classification === 'merge-blind') {
      fail(`unclassified merge-blind ${candidate.dimension} candidate: ${candidate.path}`);
    }
  }

  const exceptions = inventory.workflowSurvey?.exceptions ?? {};
  const workflowFiles = files.filter((path) => /^\.github\/workflows\/.*\.ya?ml$/.test(path));
  for (const path of workflowFiles) {
    const triggers = extractWorkflowTriggers(read(repoRoot, path));
    const classification = classifyWorkflow(path, triggers, exceptions[path]);
    console.log(`[AUDIT] workflow ${path} [${triggers.join(', ')}] => ${classification.classification}: ${classification.reason}`);
    if (!VALID_CLASSIFICATIONS.has(classification.classification)) {
      fail(`workflow exception for ${path} has invalid classification`);
    }
    if (classification.classification === 'merge-blind') {
      fail(`workflow trigger parity is unresolved: ${path} (${classification.reason})`);
    }
  }
}

function validateRemediations(repoRoot) {
  const validator = read(repoRoot, 'scripts/lib/validate-supervisor-heavy-lane-rpc-artifacts.mjs');
  if (/isPrValidationContext|GITHUB_EVENT_PATH/.test(validator)) {
    fail('RPC validator still contains a PR-context-shaped verdict path');
  }
  if (!validator.includes('scoped-tree-content-v1') || !validator.includes('inspectSupervisorHeavyLaneRpcBinding')) {
    fail('RPC validator must use one fail-closed scoped-tree content evaluator');
  }
  if (!validator.includes('const head = resolveCurrentHeadSha(repoRootOverride)')) {
    fail('RPC binding verdict must compare capture content to the checked-out HEAD, not a PR-only head resolver');
  }

  const manifest = JSON.parse(read(repoRoot, 'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json'));
  if (manifest.bindingMode !== 'scoped-tree-content-v1') fail('RPC manifest must declare scoped-tree-content-v1');

  const sequencing = read(repoRoot, 'scripts/check-side-process-registry-709-711-sequencing.ps1');
  if (/requiredCommits|GITHUB_EVENT_PATH|git merge-base --is-ancestor/.test(sequencing)) {
    fail('sequencing guard still relies on event payload or prerequisite commit identity');
  }
  for (const marker of ['Orchestrator-WakeSupervisorLease.ps1', 'Orchestrator-FleetHygiene.ps1', 'Resolve-MergeStableCiBase.ps1']) {
    if (!sequencing.includes(marker)) fail(`sequencing guard lacks semantic marker/binding ${marker}`);
  }

  const registry = read(repoRoot, 'scripts/check-orchestrator-message-registry.ps1');
  if (!registry.includes('Resolve-MergeStableCiBase.ps1') || /\$baseRef\s*=\s*'origin\/main'/.test(registry)) {
    fail('message registry guard must delegate to the non-self base resolver');
  }

  const baseline = read(repoRoot, 'scripts/toolchain/baseline-io.ts');
  if (!baseline.includes('mergeBase !== head') || !baseline.includes("'HEAD^1'")) {
    fail('baseline-io must reject self merge-bases and fall back to HEAD^1');
  }
  const helper = read(repoRoot, 'scripts/lib/Resolve-MergeStableCiBase.ps1');
  if (!helper.includes('$mergeBase -ne $head') || !helper.includes("'HEAD^1'")) {
    fail('PowerShell base resolver must reject self merge-bases and fall back to HEAD^1');
  }

  const scope = read(repoRoot, '.github/workflows/scope-guard.yml');
  const verifyPack = scope.match(/\n  verify-pack:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n)/)?.[1] ?? '';
  if (!/uses:\s*actions\/checkout@v4[\s\S]{0,100}fetch-depth:\s*0/.test(verifyPack)) {
    fail('scope-guard verify-pack checkout must fetch full history for fail-closed content binding');
  }

  const wrapper = read(repoRoot, 'scripts/check-ci-pipeline-split.ps1');
  for (const required of ['check-merge-blind-ci-gates.mjs', 'fixtures/merge-blind-ci-gates/parity.ps1']) {
    if (!wrapper.includes(required)) fail(`CI pipeline wrapper must invoke ${required}`);
  }

  if (read(repoRoot, SELF_REL).includes("node:child_process")) fail(`${SELF_REL} must not add a raw child-process dependency`);
  for (const removed of [
    'scripts/lib/resolve-merge-stable-ci-base.mjs',
    'scripts/lib/resolve-merge-stable-ci-base.d.mts',
    'scripts/fixtures/merge-blind-ci-gates/parity.mjs',
  ]) {
    if (existsSync(join(repoRoot, removed))) fail(`superseded raw-subprocess surface must be removed: ${removed}`);
  }
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const inventoryPath = join(args.repoRoot, INVENTORY_REL);
    if (!existsSync(inventoryPath)) {
      fail(`missing ${INVENTORY_REL}`);
      return;
    }
    const files = trackedFiles(args.repoRoot, args.trackedFilesPath);
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    validateInventoryShape(args.repoRoot, inventory, files);
    validateRemediations(args.repoRoot);
    if (!process.exitCode) {
      console.log(`[PASS] merge-blind CI gate audit: ${inventory.rows.length} explicit sites, ${inventory.discoveryMethods.length} discovery dimensions, dynamic workflow survey`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main();
