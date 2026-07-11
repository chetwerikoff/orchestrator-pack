import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { collectLocalModuleSpecifiers } from './module-specifiers.mjs';

const MANIFEST_VERSION = 1;
const DEFAULT_EXPORT_MAX_BYTES = 60_000;

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

const IGNORED_ROOTS = new Set([
  '.git',
  '.github',
  'docs',
  'node_modules',
  'packages',
  'vendor',
]);

const WORKFLOW_CONFIG_PATHS = new Set([
  'package-lock.json',
  'package.json',
  'scripts/vitest-ci-lanes.config.json',
]);
const VITEST_CONFIG_RE = /(^|\/)(?:[^/]+\.)?vitest\.config\.(?:[cm]?[jt]s|[jt]sx)$/i;

const SELF_REFERENTIAL_PATHS = new Set([
  '.github/workflows/scope-guard.yml',
  'scripts/emit-pr-changed-paths-manifest.mjs',
  'scripts/emit-vitest-heavy-topology.mjs',
  'scripts/invoke-vitest-ci-lane-plan.mjs',
  'scripts/lib/vitest-ci-lanes.mjs',
  'scripts/lib/vitest-heavy-topology.mjs',
  'scripts/lib/vitest-pr-scoped-selection.mjs',
  'scripts/resolve-vitest-heavy-file-run-plan.mjs',
  'scripts/run-vitest-heavy-shard.ps1',
  'scripts/vitest-ci-lanes.config.json',
]);

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/$/, '');
}

function pathExt(path) {
  const match = /\.[^./]+$/.exec(path);
  return match ? match[0].toLowerCase() : '';
}

function isTestFile(path) {
  return normalizePath(path).endsWith('.test.ts');
}

function isMarkdownPath(path) {
  const normalized = normalizePath(path).toLowerCase();
  return normalized.endsWith('.md') || normalized.endsWith('.mdc');
}

function isWorkflowConfigPath(path) {
  const normalized = normalizePath(path);
  if (normalized.startsWith('.github/workflows/')) {
    return true;
  }
  if (WORKFLOW_CONFIG_PATHS.has(normalized)) {
    return true;
  }
  if (VITEST_CONFIG_RE.test(normalized)) {
    return true;
  }
  return /^tsconfig(?:\..+)?\.json$/i.test(normalized);
}

function isGeneratedOrVendoredPath(path) {
  const normalized = normalizePath(path).toLowerCase();
  return normalized.includes('/fixtures/')
    || normalized.includes('/generated/')
    || normalized.startsWith('vendor/')
    || normalized.includes('/vendor/');
}

function isSourceLikePath(path) {
  const normalized = normalizePath(path);
  if (isTestFile(normalized)) {
    return true;
  }
  return SOURCE_EXTENSIONS.has(pathExt(normalized));
}

function normalizeMode(value) {
  const trimmed = String(value ?? '').trim().toLowerCase();
  if (trimmed === 'enforce') {
    return 'enforce';
  }
  if (trimmed === 'full' || trimmed === 'disabled' || trimmed === 'off') {
    return 'full';
  }
  return 'shadow';
}

function buildFailureManifest(baseSha, headSha, failureReason, details = {}) {
  return {
    version: MANIFEST_VERSION,
    baseSha: String(baseSha ?? '').trim(),
    headSha: String(headSha ?? '').trim(),
    diffOk: false,
    failureReason,
    entryCount: 0,
    entries: [],
    ...details,
  };
}

function parseRawDiffEntries(stdoutBuffer) {
  const parts = stdoutBuffer.toString('utf8').split('\0');
  if (parts.at(-1) === '') {
    parts.pop();
  }

  const entries = [];
  for (let index = 0; index < parts.length;) {
    const header = parts[index++];
    if (!header) {
      continue;
    }
    if (!header.startsWith(':')) {
      throw new Error(`unexpected raw diff header: ${header}`);
    }

    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|0{40}) ([0-9a-f]{40}|0{40}) ([A-Z])(\d+)?$/i.exec(
      header,
    );
    if (!match) {
      throw new Error(`unparseable raw diff header: ${header}`);
    }

    const [, oldMode, newMode, oldSha, newSha, statusLetter] = match;
    const status = statusLetter.toUpperCase();
    if (status === 'R' || status === 'C') {
      const previousPath = parts[index++];
      const path = parts[index++];
      if (!previousPath || !path) {
        throw new Error(`rename/copy entry missing paths: ${header}`);
      }
      entries.push({
        status,
        path: normalizePath(path),
        previousPath: normalizePath(previousPath),
        oldMode,
        newMode,
        oldSha,
        newSha,
      });
      continue;
    }

    const path = parts[index++];
    if (!path) {
      throw new Error(`diff entry missing path: ${header}`);
    }
    entries.push({
      status,
      path: normalizePath(path),
      oldMode,
      newMode,
      oldSha,
      newSha,
    });
  }

  return entries;
}

export function buildChangedPathManifest(repoRoot, baseSha, headSha, options = {}) {
  const normalizedBase = String(baseSha ?? '').trim();
  const normalizedHead = String(headSha ?? '').trim();
  const maxBytes = Number.isFinite(Number(options.maxBytes))
    ? Number(options.maxBytes)
    : DEFAULT_EXPORT_MAX_BYTES;

  if (!normalizedBase || !normalizedHead) {
    return buildFailureManifest(normalizedBase, normalizedHead, 'missing-base-or-head-sha');
  }

  const result = spawnSync(
    'git',
    ['diff', '--raw', '-z', '--no-abbrev', '--find-renames=100%', `${normalizedBase}...${normalizedHead}`, '--'],
    {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    return buildFailureManifest(normalizedBase, normalizedHead, 'git-diff-failed', {
      stderr: (result.stderr ?? Buffer.from('')).toString('utf8').trim(),
      exitCode: result.status,
    });
  }

  let entries;
  try {
    entries = parseRawDiffEntries(result.stdout ?? Buffer.from(''));
  } catch (error) {
    return buildFailureManifest(normalizedBase, normalizedHead, 'malformed-raw-diff', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const manifest = {
    version: MANIFEST_VERSION,
    baseSha: normalizedBase,
    headSha: normalizedHead,
    diffOk: true,
    entryCount: entries.length,
    entries,
  };

  const serialized = JSON.stringify(manifest);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    return buildFailureManifest(normalizedBase, normalizedHead, 'changed-path-export-oversized', {
      entryCount: entries.length,
      oversized: true,
    });
  }

  return manifest;
}

export function parseChangedPathManifest(raw) {
  if (!raw) {
    return { ok: false, reason: 'manifest-missing' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'manifest-json-invalid' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'manifest-not-object' };
  }
  if (parsed.version !== MANIFEST_VERSION) {
    return { ok: false, reason: 'manifest-version-invalid' };
  }
  if (typeof parsed.baseSha !== 'string' || typeof parsed.headSha !== 'string') {
    return { ok: false, reason: 'manifest-sha-invalid' };
  }
  if (typeof parsed.diffOk !== 'boolean') {
    return { ok: false, reason: 'manifest-diff-flag-invalid' };
  }
  if (!Number.isInteger(parsed.entryCount) || parsed.entryCount < 0) {
    return { ok: false, reason: 'manifest-entry-count-invalid' };
  }
  if (!Array.isArray(parsed.entries)) {
    return { ok: false, reason: 'manifest-entries-invalid' };
  }
  if (parsed.diffOk && parsed.entryCount !== parsed.entries.length) {
    return { ok: false, reason: 'manifest-entry-count-mismatch' };
  }

  const entries = [];
  for (const item of parsed.entries) {
    if (!item || typeof item !== 'object') {
      return { ok: false, reason: 'manifest-entry-invalid' };
    }
    const status = String(item.status ?? '').trim().toUpperCase();
    const path = normalizePath(item.path ?? '');
    const previousPath = item.previousPath ? normalizePath(item.previousPath) : undefined;
    if (!status || !path) {
      return { ok: false, reason: 'manifest-entry-fields-invalid' };
    }
    if ((status === 'R' || status === 'C') && !previousPath) {
      return { ok: false, reason: 'manifest-rename-missing-previous-path' };
    }
    entries.push({
      status,
      path,
      previousPath,
      oldMode: typeof item.oldMode === 'string' ? item.oldMode : null,
      newMode: typeof item.newMode === 'string' ? item.newMode : null,
      oldSha: typeof item.oldSha === 'string' ? item.oldSha : null,
      newSha: typeof item.newSha === 'string' ? item.newSha : null,
    });
  }

  return {
    ok: true,
    manifest: {
      version: MANIFEST_VERSION,
      baseSha: parsed.baseSha.trim(),
      headSha: parsed.headSha.trim(),
      diffOk: parsed.diffOk,
      failureReason: typeof parsed.failureReason === 'string' ? parsed.failureReason : null,
      entryCount: parsed.entryCount,
      entries,
      oversized: parsed.oversized === true,
    },
  };
}

function isRegularGitFileMode(mode) {
  return mode === '100644' || mode === '100755';
}

function isAnalyzableSourceEntry(entry) {
  if (!isSourceLikePath(entry.path)) {
    return false;
  }
  if (entry.status === 'A') {
    return isRegularGitFileMode(entry.newMode);
  }
  return isRegularGitFileMode(entry.oldMode) && isRegularGitFileMode(entry.newMode);
}

function decodeAnalyzableSourceContent(absolute) {
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    return null;
  }
  if (!stats.isFile()) {
    return null;
  }

  let bytes;
  try {
    bytes = readFileSync(absolute);
  } catch {
    return null;
  }
  if (bytes.includes(0)) {
    return null;
  }
  const content = bytes.toString('utf8');
  if (content.includes('\uFFFD')) {
    return null;
  }
  return content;
}

function resolveLocalModulePath(fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = resolve(join(fromFile, '..'), specifier);
  const candidates = [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.cjs`,
    `${base}.cts`,
    `${base}.mts`,
    join(base, 'index.mjs'),
    join(base, 'index.js'),
    join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveModuleCandidates(base) {
  const extMatch = base.match(/(\.[^/.]+)$/);
  const stem = extMatch ? base.slice(0, -extMatch[1].length) : base;
  const candidates = [
    base,
    `${stem}.mjs`,
    `${stem}.js`,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.cjs`,
    `${stem}.cts`,
    `${stem}.mts`,
    join(base, 'index.mjs'),
    join(base, 'index.js'),
    join(base, 'index.ts'),
  ];
  return [...new Set(candidates)];
}

function listFirstPartyPackageRoots(repoRoot) {
  const packageRoots = new Map();

  function walk(currentDir) {
    for (const entry of readdirSync(currentDir)) {
      if (entry === '.git' || entry === 'node_modules') {
        continue;
      }
      const absolute = join(currentDir, entry);
      const stats = statSync(absolute);
      const rel = normalizePath(relative(repoRoot, absolute));
      if (stats.isDirectory()) {
        const rootSegment = rel.split('/')[0];
        if (IGNORED_ROOTS.has(rootSegment)) {
          continue;
        }
        walk(absolute);
        continue;
      }
      if (entry !== 'package.json') {
        continue;
      }
      try {
        const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
        const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
        if (name.startsWith('@orchestrator-pack/')) {
          packageRoots.set(name, normalizePath(relative(repoRoot, currentDir)));
        }
      } catch {
        continue;
      }
    }
  }

  walk(repoRoot);
  return packageRoots;
}

function resolveBareFirstPartyModulePaths(repoRoot, specifier, packageRoots) {
  let matchedPackage = null;
  for (const packageName of packageRoots.keys()) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      if (!matchedPackage || packageName.length > matchedPackage.length) {
        matchedPackage = packageName;
      }
    }
  }
  if (!matchedPackage) {
    return [];
  }

  const packageRoot = packageRoots.get(matchedPackage);
  const suffix = specifier === matchedPackage ? '' : specifier.slice(matchedPackage.length + 1);
  const base = suffix
    ? join(repoRoot, packageRoot, suffix)
    : join(repoRoot, packageRoot, 'index');
  const resolved = [];
  for (const candidate of resolveModuleCandidates(base)) {
    if (!existsSync(candidate)) {
      continue;
    }
    const relPath = normalizePath(relative(repoRoot, candidate));
    if (!relPath || relPath.startsWith('..') || !isSourceLikePath(relPath)) {
      continue;
    }
    resolved.push(relPath);
  }
  return [...new Set(resolved)];
}

function listFirstPartySourceFiles(repoRoot) {
  const files = [];

  function walk(currentDir) {
    for (const entry of readdirSync(currentDir)) {
      if (entry === '.git' || entry === 'node_modules') {
        continue;
      }
      const absolute = join(currentDir, entry);
      const stats = statSync(absolute);
      const rel = normalizePath(relative(repoRoot, absolute));
      if (stats.isDirectory()) {
        const rootSegment = rel.split('/')[0];
        if (IGNORED_ROOTS.has(rootSegment)) {
          continue;
        }
        walk(absolute);
        continue;
      }
      if (!isSourceLikePath(rel)) {
        continue;
      }
      files.push(rel);
    }
  }

  walk(repoRoot);
  return files.sort();
}

function buildDependencyGraph(repoRoot) {
  const nodes = new Map();
  const reverse = new Map();
  const bareImportTargets = new Map();
  const packageRoots = listFirstPartyPackageRoots(repoRoot);

  for (const relPath of listFirstPartySourceFiles(repoRoot)) {
    const absolute = join(repoRoot, relPath);
    const content = decodeAnalyzableSourceContent(absolute);
    if (content === null) {
      nodes.set(relPath, { imports: new Set(), establishable: false });
      continue;
    }

    const collected = collectLocalModuleSpecifiers(content);
    const imports = new Set();
    let establishable = collected.establishable;
    for (const specifier of collected.specifiers) {
      if (!specifier.startsWith('.')) {
        const resolvedBareImports = resolveBareFirstPartyModulePaths(repoRoot, specifier, packageRoots);
        if (resolvedBareImports.length > 0 || specifier.startsWith('@orchestrator-pack/')) {
          establishable = false;
        }
        for (const relImport of resolvedBareImports) {
          if (!bareImportTargets.has(relImport)) {
            bareImportTargets.set(relImport, new Set());
          }
          bareImportTargets.get(relImport).add(relPath);
        }
        continue;
      }
      const resolved = resolveLocalModulePath(absolute, specifier);
      if (!resolved) {
        establishable = false;
        continue;
      }
      const relImport = normalizePath(relative(repoRoot, resolved));
      if (!relImport || relImport.startsWith('..')) {
        establishable = false;
        continue;
      }
      imports.add(relImport);
    }

    nodes.set(relPath, { imports, establishable });
  }

  for (const [relPath, node] of nodes.entries()) {
    for (const imported of node.imports) {
      if (!reverse.has(imported)) {
        reverse.set(imported, new Set());
      }
      reverse.get(imported).add(relPath);
    }
  }

  return { nodes, reverse, bareImportTargets };
}

function topLevelArea(path) {
  const normalized = normalizePath(path);
  return normalized.split('/')[0] ?? normalized;
}

function classifyBroadDiff(manifest, mode) {
  if (!manifest.diffOk) {
    return {
      className: 'diff-computation-failure',
      wouldRunMode: 'full',
      reason: manifest.failureReason ?? 'diff-computation-failure',
    };
  }

  const entries = manifest.entries;
  if (entries.length === 0) {
    return {
      className: 'source-only',
      wouldRunMode: 'scoped',
      reason: 'empty-changed-path-set',
    };
  }

  if (entries.some((entry) => isWorkflowConfigPath(entry.path))) {
    return {
      className: 'workflow/config',
      wouldRunMode: 'full',
      reason: 'workflow-or-config-change',
    };
  }

  if (entries.some((entry) => SELF_REFERENTIAL_PATHS.has(entry.path))) {
    return {
      className: 'mixed/cross-cutting',
      wouldRunMode: 'full',
      reason: 'self-referential-change',
    };
  }

  if (entries.some((entry) => entry.status === 'R' || entry.status === 'D' || entry.status === 'T' || entry.status === 'C')) {
    const renameDeleteOnly = entries.every(
      (entry) => entry.status === 'R' || entry.status === 'D' || entry.status === 'T' || entry.status === 'C',
    );
    return {
      className: renameDeleteOnly ? 'rename/delete-only' : 'mixed/cross-cutting',
      wouldRunMode: 'full',
      reason: renameDeleteOnly ? 'rename-delete-only-change' : 'rename-delete-with-content-change',
    };
  }

  if (entries.some((entry) => isGeneratedOrVendoredPath(entry.path))) {
    return {
      className: 'mixed/cross-cutting',
      wouldRunMode: 'full',
      reason: 'generated-or-vendored-surface',
    };
  }

  const sourceAreas = new Set(
    entries
      .map((entry) => entry.path)
      .filter((path) => !isTestFile(path) && !isMarkdownPath(path))
      .map((path) => topLevelArea(path)),
  );
  if (sourceAreas.size > 1) {
    return {
      className: 'mixed/cross-cutting',
      wouldRunMode: 'full',
      reason: 'multiple-source-areas',
    };
  }

  const changedTests = entries.filter((entry) => isTestFile(entry.path));
  const changedSources = entries.filter((entry) => !isTestFile(entry.path) && !isMarkdownPath(entry.path));

  if (changedTests.length > 0 && changedSources.length === 0) {
    return { className: 'test-only', wouldRunMode: 'scoped', reason: 'test-only-diff' };
  }
  if (changedTests.length > 0 && changedSources.length > 0) {
    return { className: 'source+test', wouldRunMode: 'scoped', reason: 'source-and-test-diff' };
  }
  return { className: 'source-only', wouldRunMode: 'scoped', reason: mode === 'shadow' ? 'source-only-diff' : 'source-only-diff' };
}

function collectImpactedTests(startPath, reverseGraph, graphNodes) {
  const queue = [startPath];
  const visited = new Set();
  const impactedTests = new Set();
  let lowConfidence = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const node = graphNodes.get(current);
    if (!node) {
      lowConfidence = true;
      continue;
    }
    if (!node.establishable) {
      lowConfidence = true;
    }
    if (isTestFile(current)) {
      impactedTests.add(current);
    }
    for (const dependent of reverseGraph.get(current) ?? []) {
      queue.push(dependent);
    }
  }

  return { impactedTests, lowConfidence };
}

export function resolveVitestPrScopeSelection(input) {
  const {
    repoRoot,
    changedPathManifest,
    discoveredTests,
    heavyFiles,
    prScopeMode = 'shadow',
  } = input;

  const mode = normalizeMode(prScopeMode);
  if (!changedPathManifest) {
    return {
      applicable: false,
      mode,
      killSwitchState: mode,
      effectiveRunMode: 'full',
      wouldRunMode: 'full',
      className: 'not-applicable',
      reason: 'non-pr-run',
      baseSha: null,
      headSha: null,
      selectedHeavyFiles: [...heavyFiles],
      wouldSelectHeavyFiles: [...heavyFiles],
      changedEntries: [],
    };
  }

  const broad = classifyBroadDiff(changedPathManifest, mode);
  const heavySet = new Set(heavyFiles);
  const provenance = {
    applicable: true,
    mode,
    killSwitchState: mode,
    effectiveRunMode: broad.wouldRunMode,
    wouldRunMode: broad.wouldRunMode,
    className: broad.className,
    reason: broad.reason,
    baseSha: changedPathManifest.baseSha,
    headSha: changedPathManifest.headSha,
    changedEntries: changedPathManifest.entries,
    changedEntryCount: changedPathManifest.entryCount,
    selectedHeavyFiles: [...heavyFiles],
    wouldSelectHeavyFiles: [...heavyFiles],
  };

  if (broad.wouldRunMode === 'full') {
    return provenance;
  }

  const graph = buildDependencyGraph(repoRoot);
  const impacted = new Set();
  let lowConfidence = false;

  for (const entry of changedPathManifest.entries) {
    if (isMarkdownPath(entry.path)) {
      continue;
    }
    if (!isAnalyzableSourceEntry(entry)) {
      lowConfidence = true;
      continue;
    }
    const node = graph.nodes.get(entry.path);
    if (!node || !node.establishable) {
      lowConfidence = true;
    }
    if (graph.bareImportTargets.has(entry.path)) {
      lowConfidence = true;
    }
    const closure = collectImpactedTests(entry.path, graph.reverse, graph.nodes);
    lowConfidence = lowConfidence || closure.lowConfidence;
    for (const testPath of closure.impactedTests) {
      if (heavySet.has(testPath)) {
        impacted.add(testPath);
      }
    }
    if (isTestFile(entry.path) && heavySet.has(entry.path)) {
      impacted.add(entry.path);
    }
  }

  if (lowConfidence) {
    return {
      ...provenance,
      wouldRunMode: 'full',
      effectiveRunMode: 'full',
      reason: 'low-confidence-or-unmapped-change',
    };
  }

  const scopedHeavyFiles = [...impacted].sort();
  const effectiveRunMode = mode === 'enforce' ? 'scoped' : 'full';
  return {
    ...provenance,
    wouldRunMode: 'scoped',
    effectiveRunMode,
    reason: effectiveRunMode === 'scoped' ? 'confident-pr-scope-selection' : 'shadow-mode-full-run',
    selectedHeavyFiles: effectiveRunMode === 'scoped' ? scopedHeavyFiles : [...heavyFiles],
    wouldSelectHeavyFiles: scopedHeavyFiles,
  };
}

export function parseChangedPathManifestFromEnv(raw = process.env.OPK_CHANGED_VITEST_FILES) {
  if (raw == null) {
    return null;
  }
  if (raw === '') {
    return buildFailureManifest('', '', 'manifest-missing');
  }
  const parsed = parseChangedPathManifest(raw);
  if (!parsed.ok) {
    return buildFailureManifest('', '', parsed.reason);
  }
  return parsed.manifest;
}

export function normalizePrScopeMode(raw = process.env.OPK_VITEST_PR_SCOPE_MODE) {
  return normalizeMode(raw);
}
