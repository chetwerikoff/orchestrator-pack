#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from '../kernel/subprocess.mjs';
import { buildManifest as buildReachabilityManifest } from '../reachability-purge.mjs';
import { discoverVerifyInlineIds } from '../gate-runner/census.ts';
import { migrationOwnershipDigest } from '../gate-runner/census-generator.ts';

const SCRIPT = 'scripts/estate-cut/manifest-generator.mjs';
const MANIFEST = 'scripts/estate-cut/issue-906.manifest.json';
const CONFIG = 'scripts/estate-cut/issue-906.config.json';
const ANCHOR = 'scripts/estate-cut/issue-906.base-anchor.json';
const CENSUS = 'scripts/gate-runner/census/pre-change-baseline.json';
const CENSUS_GENERATION = 'scripts/gate-runner/census/generation.json';
const SUPERVISOR_REGISTRY = 'scripts/orchestrator-side-process-registry.json';
const SUPERVISOR_LIVENESS = 'scripts/orchestrator-side-process-liveness-contract.json';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(readFileSync(path.join(repoRoot, CONFIG), 'utf8'));
const anchor = JSON.parse(readFileSync(path.join(repoRoot, ANCHOR), 'utf8'));

const PINNED_LEGACY_SUBJECTS = new Set([
  'scripts/check-ao-cli-argv-shape.ps1',
  'scripts/check-ao-dead-argv-bypass.ps1',
  'scripts/check-ci-cheap-wins.ps1',
  'scripts/check-ci-pipeline-split.ps1',
  'scripts/check-gh-inventory-static.ps1',
  'scripts/check-harness-post-submit-pn-live-smoke.ps1',
  'scripts/check-operator-adoption-example.ps1',
  'scripts/check-read-delegation-audit-ci-gate.ps1',
  'scripts/check-read-delegation-policy-consistency.ps1',
  'scripts/check-reusable.ps1',
  'scripts/check-review-start-claim-guard.ps1',
  'scripts/check-review-delivery-no-visibility-poll.ps1',
  'scripts/check-scripted-review-confirmed-delivery-gate.ps1',
  'scripts/check-side-process-launch-contract.ps1',
  'scripts/check-verify-runtime.ps1',
  'scripts/verify.ps1',
]);
const PRODUCER_IMPORTERS = new Set([
  'docs/ao-0-10-review-api.mjs',
  'docs/autonomous-review-retry.mjs',
  'docs/orchestrator-wake-filter.mjs',
  'docs/review-bulk-send-diagnose.mjs',
  'docs/review-finding-delivery-confirm.mjs',
  'docs/review-head-ready.mjs',
  'docs/review-send-reconcile.mjs',
  'docs/review-wake-trigger.mjs',
  'docs/reviewer-failure-evidence-markers.mjs',
  'docs/worker-iteration-cycle.mjs',
  'docs/worker-message-dispatch-observe.mjs',
  'docs/worker-report-store.mjs',
]);
const PR2_OWNED = new Set([
  ...PRODUCER_IMPORTERS,
  'docs/review-producer-contract.mjs',
  'docs/review-trigger-reconcile.mjs',
  'docs/events-optional-consumer-signal-recovery.d.mts',
  'docs/events-optional-consumer-signal-recovery.mjs',
  'scripts/review-trigger-reconcile.ps1',
  'scripts/review-trigger-reeval.ps1',
  'scripts/review-ready-report-state-seed.ps1',
  'scripts/lib/Get-ReactionMessagesFromYaml.ps1',
  'scripts/reaction-config-messages.d.mts',
  'scripts/reaction-config-messages.mjs',
]);
const EXPLICIT_DELETE = new Set([
  '.github/workflows/contract-evidence-legacy-list-guard.yml',
  'scripts/run-contract-evidence-legacy-list-guard.mjs',
  'scripts/review-send-reconcile.ps1',
  'scripts/json-producers/retired-surfaces.json',
  'docs/ao-reviews-board-runbook.md',
  'tests/fixtures/reviews-board-seven-columns.json',
  'docs/github-fleet-cache-measurement.md',
]);
const ARCHIVE_MOVES = new Map([
  ['docs/github-fleet-cache-measurement.md', 'docs/archive/issue-906/github-fleet-cache-measurement.md'],
]);
const BOARD_PREFIX = 'tests/ao-reviews-board-runtime/';
const BOARD_FILES = new Set([
  'scripts/ao-reviews-board-commented.test.ts',
  'tests/ao-reviews-board-ui.test.ts',
  'tests/ao-reviews-board.test.ts',
]);
const MUTABLE_CUT_TESTS = new Set([
  'scripts/gate-runner/census.test.ts',
  'scripts/orchestrator-wake-supervisor.test.ts',
  'scripts/orchestrator-wake-supervisor-side-process-registry.test.ts',
]);
const SHARED_TEST_SURVIVORS = new Set([
  'scripts/review-head-ready.test.ts',
  'scripts/review-wake-trigger.test.ts',
  'scripts/ci-green-wake-reconcile.test.ts',
  'scripts/review-orchestrator-loop.test.ts',
  'scripts/review-ready-stuck-guard.test.ts',
  'scripts/review-send-reconcile.test.ts',
  'scripts/review-finding-delivery-submit.test.ts',
  'scripts/session-runtime-liveness.test.ts',
]);
const NEW_ARTIFACTS = new Set([
  CONFIG, ANCHOR, SCRIPT, MANIFEST,
  'docs/declarations/906.chatgpt-estate-cut.json',
  'scripts/vitest-surviving-store-isolation.ts',
  'scripts/estate-cut/capture-base-anchor.mjs',
  'scripts/estate-cut/issue-906-vertical-slice.test.ts',
  'scripts/estate-cut/vitest.config.ts',
  'docs/issue-906-operator-adoption.md',
  ...ARCHIVE_MOVES.values(),
]);
const TEMP_BOOTSTRAP = '.github/workflows/issue-906-bootstrap.yml';
const SURVIVING_SUPERVISOR_CHILD_IDS = [
  'review-trigger-reconcile',
  'review-trigger-reeval',
  'review-ready-report-state-seed',
];

function runGit(args) {
  const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git ${args.join(' ')} failed`);
  return result.stdout;
}
function git(args) {
  return runGit(args).trimEnd();
}
function trackedAt(ref) {
  return git(['ls-tree', '-r', '--name-only', ref]).split(/\r?\n/u).filter(Boolean).sort();
}
function currentTracked() {
  const tracked = git(['ls-files']).split(/\r?\n/u).filter((rel) => rel && fileExists(rel));
  for (const rel of NEW_ARTIFACTS) if (fileExists(rel)) tracked.push(rel);
  return [...new Set(tracked)].sort();
}
function readAt(ref, rel) {
  try { return Buffer.from(runGit(['show', `${ref}:${rel}`]), 'utf8'); } catch { return null; }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function normalize(rel) { return rel.replaceAll('\\', '/').replace(/^\.\//u, ''); }
function isTest(rel) { return /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.(?:ts|mts|cts|js|mjs|cjs|ps1)$/iu.test(rel); }
function subjectPath(entry) {
  if (entry.sourceKind === 'verify-script-member') return normalize(entry.marker);
  return normalize(entry.sourcePath);
}
function stable(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function fileExists(rel) { return existsSync(path.join(repoRoot, rel)); }
function readCurrent(rel) { return readFileSync(path.join(repoRoot, rel)); }
function pathCategory(rel, rootClosure, dynamicHeld) {
  if (anchor.keepCoreTests.includes(rel) || rel.startsWith('scripts/gate-runner/') || rel.startsWith('scripts/kernel/')) return 'G';
  if (rel.startsWith('plugins/ao-scope-guard/') || rel.startsWith('plugins/ao-codex-pr-reviewer/') || rel.startsWith('.github/workflows/')) return 'D';
  if (dynamicHeld.has(rel)) return 'D';
  if (rootClosure.has(rel)) return 'C';
  return 'G';
}
function closure(roots, edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(edge.target);
  }
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const target of adjacency.get(current) ?? []) if (!seen.has(target)) queue.push(target);
  }
  return seen;
}
function rootRecords(baseSet) {
  const rows = [];
  for (const [category, members] of Object.entries(anchor.rootMembership)) {
    for (const member of members) {
      if (member.endsWith('/') || !baseSet.has(member)) continue;
      rows.push({ category, path: member, evidence: `${ANCHOR} @ ${config.baseCommitSha}` });
    }
  }
  return rows.sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
}
function desiredDeletionSet(baseFiles, census) {
  const baseSet = new Set(baseFiles);
  const deleted = new Set();
  for (const entry of census.entries) {
    if (entry.classification !== 'deferred-to-named-wave') continue;
    const subject = subjectPath(entry);
    if (subject.endsWith('.ps1') && !PINNED_LEGACY_SUBJECTS.has(subject) && baseSet.has(subject)) deleted.add(subject);
  }
  for (const rel of baseFiles) {
    if (rel.startsWith(BOARD_PREFIX) || BOARD_FILES.has(rel)) deleted.add(rel);
    if ((rel.startsWith('scripts/') || rel.startsWith('tests/')) && isTest(rel) && !anchor.keepCoreTests.includes(rel) && !MUTABLE_CUT_TESTS.has(rel) && !SHARED_TEST_SURVIVORS.has(rel)) deleted.add(rel);
  }
  for (const rel of EXPLICIT_DELETE) if (baseSet.has(rel)) deleted.add(rel);
  for (const rel of PRODUCER_IMPORTERS) deleted.delete(rel);
  for (const rel of anchor.protectedPaths.map((row) => row.path)) deleted.delete(rel);
  return deleted;
}
function findDeletedExecutableReferences(reachability, survivingSet, deletedSet) {
  const executableKinds = new Set([
    'module-import',
    'top-level-dot-source',
    'pwsh-file',
    'node-script',
    'node-child-process-literal-argument',
    'node-child-process-argument',
    'shell-direct-invocation',
  ]);
  const excludedSource = (source) => source.startsWith('scripts/fixtures/')
    || source.startsWith('docs/declarations/')
    || source.startsWith('docs/issues_drafts/')
    || source.startsWith('docs/archive/')
    || source === MANIFEST;
  return [...reachability.trustedEdges, ...reachability.suspectEdges]
    .filter((edge) => executableKinds.has(edge.kind)
      && survivingSet.has(edge.source)
      && deletedSet.has(edge.target)
      && !excludedSource(edge.source))
    .map((edge) => ({ source: edge.source, target: edge.target, kind: edge.kind, line: edge.line ?? 0 }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.target.localeCompare(b.target));
}

function buildDynamicInspections(reachability, survivingSet, deletedSet) {
  const rows = [];
  const sourceRows = [...reachability.suspectEdges, ...reachability.unresolvedDynamicForms];
  const seen = new Set();
  for (const item of sourceRows) {
    if (!survivingSet.has(item.source)) continue;
    if (item.source.startsWith('docs/declarations/') || item.source.startsWith('docs/issues_drafts/')) continue;
    const key = `${item.source}:${item.line ?? 0}:${item.kind}:${item.expression ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const possibleTargets = [...new Set(item.possibleTargets ?? [])].sort();
    rows.push({
      source: item.source,
      line: item.line ?? 0,
      kind: item.kind,
      expression: item.expression ?? item.target ?? '<parser-record>',
      possibleTargets,
      targetDispositions: possibleTargets.map((target) => ({
        path: target,
        disposition: deletedSet.has(target) ? 'deleted-now' : survivingSet.has(target) ? 'kept' : 'not-base-tracked',
      })),
      inspection: possibleTargets.length > 0
        ? 'Targets and resulting dispositions are bound above; no placeholder or implicit wildcard is used.'
        : 'Manual inspection found no tracked repository target for this expression; it is an environment, executable, or fixture-local form.',
    });
  }
  return rows.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.kind.localeCompare(b.kind));
}
function transformCensus(census, deletedSet, retainedVerifyInlineIds) {
  let retired = 0;
  let pinned = 0;
  const entries = census.entries.map((entry) => {
    if (entry.classification !== 'deferred-to-named-wave') return entry;
    const subject = subjectPath(entry);
    const isDeleted = entry.sourceKind === 'verify-inline'
      ? !retainedVerifyInlineIds.has(entry.id)
      : deletedSet.has(subject);
    const next = { ...entry };
    delete next.deferredWave;
    delete next.legacyReference;
    if (isDeleted) {
      next.classification = 'retired-in-bulk';
      next.retirementJustification = {
        reasonCode: 'superseded-compatibility-surface',
        behavior: `Issue #906 removes the legacy PowerShell enforcement subject ${subject} as part of the base-pinned bulk estate cut after explicit target-cycle, CI, operator-recovery, and safety-plugin root analysis.`,
        replacement: 'The surviving TypeScript gate runner, protected review-cycle runtime, and vertical-slice acceptance test provide the replacement acceptance boundary; the removed legacy check is not independently executed.',
      };
      retired += 1;
    } else {
      next.classification = 'kept-in-pr1';
      next.keepCategory = PINNED_LEGACY_SUBJECTS.has(subject) ? 'D' : 'C';
      pinned += 1;
    }
    return next;
  });
  return { census: { ...census, entries }, counts: { retired, pinned, total: retired + pinned } };
}
function pruneJsonPathReferences(value, deletedSet) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => {
        if (typeof entry === 'string') return !deletedSet.has(normalize(entry));
        if (entry && typeof entry === 'object' && typeof entry.path === 'string') return !deletedSet.has(normalize(entry.path));
        return true;
      })
      .map((entry) => pruneJsonPathReferences(entry, deletedSet));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !deletedSet.has(normalize(key)))
      .map(([key, entry]) => [key, pruneJsonPathReferences(entry, deletedSet)]));
  }
  return value;
}
function removeDeletedVerifyMembers(text, deletedSet) {
  const lines = text.split(/\r?\n/u);
  const output = [];
  const deletedChecks = [...deletedSet].filter((rel) => rel.startsWith('scripts/check-'));
  const retiredInlineMarkers = new Set([
    'verify-runtime/autonomous-spawn-budget-vitest',
    'verify-runtime/autonomous-spawn-policy-vitest',
  ]);
  const containsDeletedCheck = (line) => deletedChecks.some((rel) => line.includes(rel));
  const braceDelta = (line) => (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length;
  const skipBalancedBlock = (start) => {
    let index = start;
    let depth = 0;
    let opened = false;
    while (index < lines.length) {
      const line = lines[index];
      depth += braceDelta(line);
      if (line.includes('{')) opened = true;
      index += 1;
      if (opened && depth <= 0) break;
    }
    return index;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if ([...retiredInlineMarkers].some((marker) => line.includes(`Write-Check '${marker}'`))) {
      index += 1;
      continue;
    }
    if (!containsDeletedCheck(line)) {
      output.push(line);
      index += 1;
      continue;
    }

    const isAssignment = /^\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*Join-Path\b/u.test(line);
    if (!isAssignment) {
      index += 1;
      continue;
    }

    index += 1;
    while (index < lines.length && /^\s*$/u.test(lines[index])) index += 1;
    if (index < lines.length && /^\s*if\b/u.test(lines[index])) {
      index = skipBalancedBlock(index);
      while (index < lines.length && /^\s*$/u.test(lines[index])) index += 1;
      if (index < lines.length && /^\s*else\b/u.test(lines[index])) index = skipBalancedBlock(index);
    }
  }
  return `${output.join('\n').replace(/\n{4,}/gu, '\n\n\n').trimEnd()}\n`;
}
function verifyAnchor() {
  const failures = [];
  for (const row of anchor.protectedPaths) {
    const base = readAt(config.baseCommitSha, row.path);
    if (!base || sha256(base) !== row.sha256) failures.push(`${row.path}: base anchor drift`);
    if (!fileExists(row.path)) failures.push(`${row.path}: protected keep-core path is missing`);
    else if (sha256(readCurrent(row.path)) !== row.sha256) failures.push(`${row.path}: protected keep-core path changed against the independent base anchor`);
  }
  return failures;
}

export async function buildIssue906Manifest() {
  const baseFiles = trackedAt(config.baseCommitSha);
  const baseSet = new Set(baseFiles);
  const currentFiles = currentTracked().filter((rel) => rel !== TEMP_BOOTSTRAP);
  const currentSet = new Set(currentFiles);
  const baseCensusBytes = readAt(config.baseCommitSha, CENSUS);
  if (!baseCensusBytes) throw new Error(`base census missing at ${config.baseCommitSha}:${CENSUS}`);
  const baseCensus = JSON.parse(baseCensusBytes.toString('utf8'));
  const deletedSet = desiredDeletionSet(baseFiles, baseCensus);
  const survivingSet = new Set(baseFiles.filter((rel) => !deletedSet.has(rel)));
  for (const rel of currentFiles) if (!baseSet.has(rel)) survivingSet.add(rel);

  const reachability = await buildReachabilityManifest(repoRoot);
  const allowedKinds = new Set(['module-import', 'top-level-dot-source', 'direct-call-operator', 'node-child-process-literal-argument', 'node-script', 'node-child-process-argument', 'pwsh-file', 'shell-direct-invocation']);
  const roots = rootRecords(baseSet);
  const rootClosure = closure(roots.map((row) => row.path), reachability.trustedEdges.filter((edge) => allowedKinds.has(edge.kind) && edge.source !== 'scripts/verify.ps1' && edge.source !== 'scripts/check-reusable.ps1'));
  const inspections = buildDynamicInspections(reachability, survivingSet, deletedSet);
  const deletedReferenceViolations = findDeletedExecutableReferences(reachability, survivingSet, deletedSet);
  const dynamicHeld = new Set(inspections.flatMap((row) => row.targetDispositions.filter((target) => target.disposition === 'kept').map((target) => target.path)));
  const baseVerify = readAt(config.baseCommitSha, 'scripts/verify.ps1');
  if (!baseVerify) throw new Error('base verify.ps1 is missing');
  const projectedVerify = removeDeletedVerifyMembers(baseVerify.toString('utf8'), deletedSet);
  const retainedVerifyInlineIds = discoverVerifyInlineIds(projectedVerify);
  const transformed = transformCensus(baseCensus, deletedSet, retainedVerifyInlineIds);

  const diffNames = [...new Set([
    ...git(['diff', '--name-only', config.baseCommitSha, '--']).split(/\r?\n/u).filter(Boolean),
    ...currentFiles.filter((rel) => !baseSet.has(rel)),
  ])].filter((rel) => rel !== TEMP_BOOTSTRAP).sort();
  const rows = [];
  for (const rel of baseFiles) {
    if (deletedSet.has(rel)) {
      rows.push({
        path: rel,
        baseTracked: true,
        terminalState: 'deleted-now',
        reason: rel.startsWith(BOARD_PREFIX) || BOARD_FILES.has(rel) ? 'Reviews Board runtime/test surface removed'
          : isTest(rel) ? 'test removed with non-keep-core subject'
            : 'legacy surface outside the four explicit roots',
        ...(ARCHIVE_MOVES.has(rel) ? { archivedTo: ARCHIVE_MOVES.get(rel), attributes: ['modified-in-pr1'] } : {}),
      });
    } else if (PR2_OWNED.has(rel)) {
      rows.push({ path: rel, baseTracked: true, terminalState: 'owned-by-PR-2', replacementOwner: config.pr2Owner, baseSha256: sha256(readAt(config.baseCommitSha, rel)), reason: 'load-bearing PR 1 compatibility closure is frozen for PR 2 ownership' });
    } else {
      const category = pathCategory(rel, rootClosure, dynamicHeld);
      const changed = diffNames.includes(rel);
      rows.push({ path: rel, baseTracked: true, terminalState: 'kept', keepCategory: category, reason: config.keepCategories[category], ...(changed ? { attributes: ['modified-in-pr1'] } : {}) });
    }
  }
  for (const rel of currentFiles.filter((item) => !baseSet.has(item)).sort()) {
    rows.push({ path: rel, baseTracked: false, terminalState: 'pr1-artifact', reason: NEW_ARTIFACTS.has(rel) ? 'Issue #906 generated implementation artifact' : 'new PR 1 path' });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));

  const importerRows = [...PRODUCER_IMPORTERS].sort().map((rel) => ({
    path: rel,
    disposition: deletedSet.has(rel) ? 'deleted-now' : 'owned-by-PR-2',
    baseSha256: sha256(readAt(config.baseCommitSha, rel)),
  }));
  const manifest = {
    schemaVersion: 1,
    issue: 906,
    generatedBy: SCRIPT,
    baseCommitSha: config.baseCommitSha,
    objectiveStateDomain: ['deleted-now', 'kept', 'owned-by-PR-2', 'pr1-artifact'],
    rootSet: {
      categories: ['target-review-cycle', 'CI', 'operator-recovery', 'safety-plugins'],
      members: roots,
      rejectedRules: ['docs/*.mjs'],
    },
    censusFlip: transformed.counts,
    producerContract: {
      module: 'docs/review-producer-contract.mjs',
      importerCount: importerRows.length,
      importers: importerRows,
      requiredChain: ['scripts/review-trigger-reconcile.ps1', 'docs/review-trigger-reconcile.mjs', 'docs/review-head-ready.mjs', 'docs/review-producer-contract.mjs'],
    },
    keepCore: { anchor: ANCHOR, protectedPathCount: anchor.protectedPaths.length, testCount: anchor.keepCoreTests.length },
    dynamicLoaderInspections: inspections,
    deletedPathReferenceSweep: { violations: deletedReferenceViolations },
    diffCompleteness: { changedPaths: diffNames.sort(), rowCount: rows.length },
    rows,
  };
  return { manifest, transformedCensus: transformed.census, deletedSet };
}


function pruneSupervisorRegistry() {
  const keep = new Set(SURVIVING_SUPERVISOR_CHILD_IDS);
  const full = path.join(repoRoot, SUPERVISOR_REGISTRY);
  const registry = JSON.parse(readFileSync(full, 'utf8'));
  registry.requiredChildIds = SURVIVING_SUPERVISOR_CHILD_IDS;
  registry.children = registry.children.filter((child) => keep.has(child.id));
  writeFileSync(full, stable(registry));

  const livenessPath = path.join(repoRoot, SUPERVISOR_LIVENESS);
  const liveness = JSON.parse(readFileSync(livenessPath, 'utf8'));
  liveness.regressionAnchors = liveness.regressionAnchors.filter((childId) => keep.has(childId));
  liveness.children = liveness.children.filter((child) => keep.has(child.id));
  writeFileSync(livenessPath, stable(liveness));
}

function applyTree({ transformedCensus, deletedSet }) {
  for (const [source, destination] of ARCHIVE_MOVES) {
    const src = path.join(repoRoot, source);
    if (!existsSync(src)) continue;
    const dest = path.join(repoRoot, destination);
    mkdirSync(path.dirname(dest), { recursive: true });
    const header = `<!-- Archived by Issue #906. Historical measurement only; the deleted owner is not migrated. -->\n\n`;
    writeFileSync(dest, header + readFileSync(src, 'utf8'));
  }
  for (const rel of deletedSet) rmSync(path.join(repoRoot, rel), { force: true, recursive: true });
  rmSync(path.join(repoRoot, TEMP_BOOTSTRAP), { force: true });
  writeFileSync(path.join(repoRoot, CENSUS), stable(transformedCensus));
  const generationPath = path.join(repoRoot, CENSUS_GENERATION);
  const generation = JSON.parse(readFileSync(generationPath, 'utf8'));
  generation.migrationOwnershipDigest = migrationOwnershipDigest(transformedCensus.entries);
  writeFileSync(generationPath, stable(generation));
  const censusSourcePath = path.join(repoRoot, 'scripts/gate-runner/census.ts');
  const censusSource = readFileSync(censusSourcePath, 'utf8');
  const digestPattern = /const EXPECTED_MIGRATION_OWNERSHIP_DIGEST = '[a-f0-9]{64}';/u;
  if (!digestPattern.test(censusSource)) throw new Error('census ownership digest constant missing');
  writeFileSync(censusSourcePath, censusSource.replace(digestPattern, `const EXPECTED_MIGRATION_OWNERSHIP_DIGEST = '${generation.migrationOwnershipDigest}';`));
  pruneSupervisorRegistry();

  const verifyPath = path.join(repoRoot, 'scripts/verify.ps1');
  const baseVerify = readAt(config.baseCommitSha, 'scripts/verify.ps1');
  if (!baseVerify) throw new Error('base verify.ps1 is missing during apply');
  writeFileSync(verifyPath, removeDeletedVerifyMembers(baseVerify.toString('utf8'), deletedSet));

  for (const rel of ['scripts/vitest-ci-lanes.config.json', 'scripts/vitest-heavy-topology.plan.json', 'scripts/vitest-runtime-history.json', 'scripts/vitest-wallclock-e2e-split.pre-move-manifest.json', 'scripts/toolchain/powershell-child-tests.json', 'scripts/toolchain/raw-child-process-baseline.json']) {
    const full = path.join(repoRoot, rel);
    if (!existsSync(full)) continue;
    const pruneSet = rel.startsWith('scripts/toolchain/')
      ? new Set([...deletedSet, ...MUTABLE_CUT_TESTS])
      : deletedSet;
    try { writeFileSync(full, stable(pruneJsonPathReferences(JSON.parse(readFileSync(full, 'utf8')), pruneSet))); } catch { /* non-JSON or unrelated */ }
  }
}

function validateManifest(manifest) {
  const failures = [...verifyAnchor()];
  const byPath = new Map(manifest.rows.map((row) => [row.path, row]));
  const baseFiles = trackedAt(config.baseCommitSha);
  const currentSet = new Set(currentTracked());
  for (const rel of baseFiles) {
    const row = byPath.get(rel);
    if (!row) { failures.push(`${rel}: missing manifest row`); continue; }
    if (row.terminalState === 'pr1-artifact') failures.push(`${rel}: base-tracked path cannot be pr1-artifact`);
    if (row.terminalState === 'deleted-now' && currentSet.has(rel)) failures.push(`${rel}: declared deleted-now but still tracked`);
    if (row.terminalState !== 'deleted-now' && !currentSet.has(rel)) failures.push(`${rel}: declared ${row.terminalState} but absent`);
    if (row.terminalState === 'kept' && !row.keepCategory) failures.push(`${rel}: kept row lacks anchored category`);
    if (row.terminalState === 'owned-by-PR-2' && !row.replacementOwner) failures.push(`${rel}: PR 2 row lacks replacement owner`);
  }
  for (const rel of currentSet) if (!byPath.has(rel) && rel !== TEMP_BOOTSTRAP) failures.push(`${rel}: current path missing manifest row`);
  const changed = new Set(manifest.diffCompleteness.changedPaths);
  for (const row of manifest.rows) {
    const modified = row.attributes?.includes('modified-in-pr1') ?? false;
    if (modified && !(row.terminalState === 'kept' || (row.terminalState === 'deleted-now' && row.archivedTo))) failures.push(`${row.path}: modified-in-pr1 is illegal for ${row.terminalState}`);
    if (row.terminalState === 'kept' && changed.has(row.path) !== modified) failures.push(`${row.path}: kept-row modified-in-pr1 does not match the base diff`);
    if (row.terminalState === 'owned-by-PR-2' && changed.has(row.path)) failures.push(`${row.path}: PR 2-owned path appears in the PR 1 diff`);
  }
  for (const rel of changed) if (!byPath.has(rel)) failures.push(`${rel}: changed path lacks a manifest row`);
  if (manifest.censusFlip.total !== 232 || manifest.censusFlip.retired + manifest.censusFlip.pinned !== 232) failures.push(`census partition invalid: ${JSON.stringify(manifest.censusFlip)}`);
  const census = JSON.parse(readFileSync(path.join(repoRoot, CENSUS), 'utf8'));
  if (census.entries.some((entry) => entry.classification === 'deferred-to-named-wave')) failures.push('census retains deferred-to-named-wave rows');
  const retired = census.entries.filter((entry) => entry.classification === 'retired-in-bulk').length;
  const pinned = census.entries.filter((entry) => entry.classification === 'kept-in-pr1').length;
  if (retired !== manifest.censusFlip.retired || pinned !== manifest.censusFlip.pinned) failures.push(`census terminal counts drift: retired=${retired}, pinned=${pinned}`);
  for (const importer of manifest.producerContract.importers) {
    if (importer.disposition !== 'owned-by-PR-2') continue;
    if (!fileExists(importer.path)) failures.push(`${importer.path}: owned importer missing`);
    else if (sha256(readCurrent(importer.path)) !== importer.baseSha256) failures.push(`${importer.path}: owned importer changed before PR 2`);
  }
  for (const row of manifest.rows.filter((entry) => entry.terminalState === 'owned-by-PR-2')) {
    if (!fileExists(row.path)) failures.push(`${row.path}: PR 2-owned path missing`);
    else if (!row.baseSha256 || sha256(readCurrent(row.path)) !== row.baseSha256) failures.push(`${row.path}: PR 2-owned path changed before PR 2`);
  }
  for (const rel of manifest.producerContract.requiredChain) if (!currentSet.has(rel)) failures.push(`${rel}: producer-contract chain broken`);
  if (manifest.rootSet.categories.join('|') !== 'target-review-cycle|CI|operator-recovery|safety-plugins') failures.push('root categories are not the exact four allowed categories');
  if (!manifest.rootSet.rejectedRules.includes('docs/*.mjs')) failures.push('docs/*.mjs wildcard rejection missing');
  for (const [category, members] of Object.entries(anchor.rootMembership)) {
    const actual = manifest.rootSet.members.filter((row) => row.category === category).map((row) => row.path).sort();
    const expected = members.filter((member) => !member.endsWith('/') && trackedAt(config.baseCommitSha).includes(member)).sort();
    if (actual.join('|') !== expected.join('|')) failures.push(`${category}: explicit root membership drifted from independent anchor`);
  }
  for (const violation of manifest.deletedPathReferenceSweep.violations) failures.push(`${violation.source}:${violation.line}: surviving executable reference to deleted path ${violation.target}`);
  if (manifest.producerContract.importerCount !== 12 || manifest.producerContract.importers.length !== 12) failures.push('producer-contract importer classification is not exactly 12 rows');
  if (!currentSet.has('agent-orchestrator.yaml.example')) failures.push('agent-orchestrator.yaml.example is missing');
  if ([...currentSet].some((rel) => rel.startsWith(BOARD_PREFIX) || BOARD_FILES.has(rel))) failures.push('Reviews Board runtime/tests survived the cut');
  for (const [source, destination] of ARCHIVE_MOVES) {
    if (currentSet.has(source)) failures.push(`${source}: archived source still present`);
    if (!currentSet.has(destination)) failures.push(`${destination}: archive destination missing`);
    else if (!readFileSync(path.join(repoRoot, destination), 'utf8').includes('Archived by Issue #906')) failures.push(`${destination}: archive reason marker missing`);
  }
  const registry = JSON.parse(readFileSync(path.join(repoRoot, SUPERVISOR_REGISTRY), 'utf8'));
  if (registry.requiredChildIds.join('|') !== SURVIVING_SUPERVISOR_CHILD_IDS.join('|')) failures.push('supervisor requiredChildIds are not the exact three PR 1 starters');
  if (registry.children.map((child) => child.id).join('|') !== SURVIVING_SUPERVISOR_CHILD_IDS.join('|')) failures.push('supervisor children are not the exact three PR 1 starters');
  const liveness = JSON.parse(readFileSync(path.join(repoRoot, SUPERVISOR_LIVENESS), 'utf8'));
  if (liveness.children.map((child) => child.id).join('|') !== SURVIVING_SUPERVISOR_CHILD_IDS.join('|')) failures.push('supervisor liveness contract is not pruned to the exact three PR 1 starters');
  if (liveness.regressionAnchors.some((childId) => !SURVIVING_SUPERVISOR_CHILD_IDS.includes(childId))) failures.push('supervisor liveness contract retains a deleted child regression anchor');
  for (const inspection of manifest.dynamicLoaderInspections) {
    if (!inspection.inspection || !Array.isArray(inspection.targetDispositions)) failures.push(`${inspection.source}:${inspection.line}: unresolved loader inspection placeholder`);
  }
  return failures;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  let built = await buildIssue906Manifest();
  if (args.has('--apply')) {
    applyTree(built);
    if (!fileExists(MANIFEST)) writeFileSync(path.join(repoRoot, MANIFEST), '');
    built = await buildIssue906Manifest();
  }
  if (args.has('--write') || args.has('--apply')) writeFileSync(path.join(repoRoot, MANIFEST), stable(built.manifest));
  if (args.has('--stdout')) process.stdout.write(stable(built.manifest));
  if (args.has('--check')) {
    const expected = stable(built.manifest);
    const actual = fileExists(MANIFEST) ? readFileSync(path.join(repoRoot, MANIFEST), 'utf8') : '';
    const failures = validateManifest(built.manifest);
    if (actual !== expected) failures.push(`${MANIFEST}: generated content drift`);
    if (failures.length) {
      for (const failure of failures) console.error(`issue-906: ${failure}`);
      process.exitCode = 1;
    } else console.log(`issue-906 manifest verified: ${built.manifest.rows.length} rows`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
