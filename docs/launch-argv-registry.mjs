/**
 * Pack-wide launch-argv contract inventory: discovery, census validation, validator wiring (Issue #661).
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {'start-process' | 'pwsh-file' | 'pwsh-noprofile' | 'call-pwsh' | 'ps-call-op' | 'spawnSync' | 'execFileSync' | 'spawn' | 'execFile' | 'exec' | 'fork' | 'node-child'} LaunchPatternId */

/** @typedef {'pack-ps1-param-block' | 'captured-external-help' | 'gh-inventory-route' | 'allowlist-only'} CalleeContractSourceClass */

/** @typedef {'validator-backed' | 'allowlist-debt'} CoverageKind */

/**
 * @typedef {object} LaunchSiteHit
 * @property {string} file
 * @property {number} line
 * @property {LaunchPatternId} patternId
 * @property {string} lineText
 * @property {'production' | 'test-excluded'} classification
 */

/**
 * @typedef {object} InventoryRow
 * @property {string} rowId
 * @property {{ file: string, anchor?: string, line?: number }} caller
 * @property {{ kind: string, identity: string }} callee
 * @property {CalleeContractSourceClass} calleeContractSourceClass
 * @property {CoverageKind} coverageKind
 * @property {string} [validatorId]
 * @property {{ reason: string, followUpOwner: string }} [allowlistDebt]
 * @property {{ fileGlob?: string, file?: string, patternIds: LaunchPatternId[], line?: number }} [discoveryMatch]
 * @property {string} [hashPinnedSourceHash]
 */

/** @type {Array<{ id: LaunchPatternId, languages: string[], regex: RegExp, lineFilter?: (line: string) => boolean }>} */
export const LAUNCH_IDIOM_PATTERNS = [
  {
    id: 'start-process',
    languages: ['ps1'],
    regex: /\bStart-Process\b/,
    lineFilter: (line) => !/Get-Command\s+Start-Process/.test(line) && !/\.Parameters\.ContainsKey\('Start-Process'\)/.test(line),
  },
  {
    id: 'pwsh-file',
    languages: ['ps1', 'ts', 'mjs', 'js'],
    regex: /\bpwsh\b[^\n\r]*-File\b/,
    lineFilter: (line) => !/Write-Host|throw\s+|#\s|\/\//.test(line.trimStart().slice(0, 2) === '//' ? line : line) || !/^\s*(\/\/|#)/.test(line),
  },
  {
    id: 'pwsh-noprofile',
    languages: ['ps1', 'ts', 'mjs', 'js'],
    regex: /\bpwsh\b[^\n\r]*-NoProfile\b/,
    lineFilter: (line) => !/^\s*(\/\/|#)/.test(line),
  },
  {
    id: 'call-pwsh',
    languages: ['ps1'],
    regex: /&\s+pwsh\b/,
    lineFilter: (line) => !/^\s*#/.test(line),
  },
  {
    id: 'ps-call-op',
    languages: ['ps1'],
    regex: /^\s*&\s+[^\s#]/,
    lineFilter: (line) => {
      if (/^\s*#/.test(line)) return false;
      if (/Get-Command|\.Parameters\.|Write-Host|throw\s+'/.test(line)) return false;
      if (/=&\s*\$null|=\s*&\s*\$null/.test(line)) return false;
      return true;
    },
  },
  {
    id: 'spawnSync',
    languages: ['ts', 'mjs', 'js'],
    regex: /\bspawnSync\s*\(/,
    lineFilter: (line) => !/^\s*(\/\/|\/\*|\*)/.test(line) && !/import\s+/.test(line),
  },
  {
    id: 'execFileSync',
    languages: ['ts', 'mjs', 'js'],
    regex: /\bexecFileSync\s*\(/,
    lineFilter: (line) => !/^\s*(\/\/|\/\*|\*)/.test(line) && !/import\s+/.test(line),
  },
  {
    id: 'spawn',
    languages: ['ts', 'mjs', 'js'],
    regex: /\bspawn\s*\(/,
    lineFilter: (line) => !/\bspawnSync\s*\(/.test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line) && !/import\s+/.test(line),
  },
  {
    id: 'execFile',
    languages: ['ts', 'mjs', 'js'],
    regex: /\bexecFile\s*\(/,
    lineFilter: (line) => !/\bexecFileSync\s*\(/.test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line) && !/import\s+/.test(line),
  },
  {
    id: 'exec',
    languages: ['ts', 'mjs', 'js'],
    regex: /\bexec\s*\(/,
    lineFilter: (line) => !/\bexecFile/.test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line) && !/import\s+/.test(line),
  },
  {
    id: 'fork',
    languages: ['ts', 'mjs', 'js'],
    regex: /\bfork\s*\(/,
    lineFilter: (line) => !/^\s*(\/\/|\/\*|\*)/.test(line) && !/import\s+/.test(line),
  },
  {
    id: 'node-child',
    languages: ['ts', 'mjs', 'js', 'ps1'],
    regex: /(?:spawn(?:Sync)?|execFile(?:Sync)?)\s*\(\s*['"](?:node|tsx)['"]/,
    lineFilter: (line) => !/^\s*(\/\/|\/\*|\*)/.test(line),
  },
];

const REQUIRED_SHIPPED_VALIDATORS = [
  'side-process-launch-contract',
  'ao-spawn-shape',
  'ao-cli-argv-shape',
  'ao-dead-argv-bypass',
  'gh-inventory-static',
];

const DEAD_ARGV_BYPASS_FILES = [
  'scripts/lib/Invoke-AoCliJson.ps1',
  'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
  'scripts/orchestrator-wake-supervisor.ps1',
  'scripts/wait-orchestrator-launch.ps1',
  'scripts/lib/Autonomous-ClaimPrResumeGate.ps1',
  'scripts/orchestrator-wake-listener.ps1',
  'scripts/lib/Worker-Recovery.ps1',
  'scripts/dead-worker-reconcile.ps1',
  'scripts/lib/Worker-NudgeClaim.ps1',
  'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1',
  'scripts/invoke-gated-worker-nudge.ps1',
  'scripts/lib/Invoke-ReviewWakeTrigger.ps1',
  'scripts/ci-failure-notification-reaction.ps1',
  'scripts/ci-failure-notification-reconcile.ps1',
  'scripts/ci-green-wake-reconcile.ps1',
  'scripts/check-ci-failure-notification-adoption.ps1',
  'scripts/journaled-worker-send.ps1',
  'scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1',
  'scripts/worker-message-send-adoption-preflight.ps1',
];

const GH_INVENTORY_SCAN_FILES = [
  'scripts/lib/Gh-PrChecks.ps1',
  'scripts/lib/Gh-FleetInventoryCache.ps1',
  'scripts/lib/Get-AutoReviewPrContext.ps1',
  'scripts/lib/Autonomous-SpawnWorktreeGate.ps1',
  'scripts/lib/Ci-Failure-Notification-Common.ps1',
  'scripts/pr-scope-check.ps1',
  'prompts/agent_rules.md',
  'prompts/investigate_root_cause.md',
  'agent-orchestrator.yaml.example',
];

const AUDIT_ROOT_GLOBS = ['scripts/**', 'plugins/**', 'docs/**'];

/**
 * @param {string} rel
 */
function normalizeRel(rel) {
  return String(rel).replace(/\\/g, '/');
}

/**
 * @param {string} rel
 * @param {string[]} patterns
 */
export function matchesPathPattern(rel, patterns) {
  const norm = normalizeRel(rel);
  for (const pattern of patterns) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '<<<GLOBSTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<GLOBSTAR>>>/g, '.*')
      .replace(/\?/g, '[^/]');
    const re = new RegExp(`^${escaped}$`);
    if (re.test(norm)) return true;
  }
  return false;
}

/**
 * @param {string} rel
 * @param {ReturnType<typeof loadLaunchArgvBundle>['testExclusions']} testExclusions
 */
export function isTestExcludedFile(rel, testExclusions) {
  const norm = normalizeRel(rel);
  if (matchesPathPattern(norm, testExclusions.pathPatterns ?? [])) return true;
  if ((testExclusions.dedicatedTestHelperModules ?? []).includes(norm)) return true;
  return false;
}

/**
 * @param {string} line
 * @param {LaunchPatternId} patternId
 */
export function isDiscoveryNoiseLine(line, patternId) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) return true;
  if (/^\s*regex:\s*[/(]/.test(line)) return true;
  if (/new RegExp|\/\\bspawn|FORBIDDEN_|PATTERN|Write-Host\s+['"`].*spawn|throw\s+['"`].*spawn/i.test(line)) {
    return true;
  }
  if (patternId === 'ps-call-op' && /=\s*&\s*\$|\.Invoke\(|Get-Command|Where-Object/.test(line)) {
    return true;
  }
  if ((patternId === 'pwsh-file' || patternId === 'pwsh-noprofile') && /Write-Host|Write-Verbose|Write-Debug|#\s*pwsh/.test(line)) {
    return true;
  }
  return false;
}

/**
 * @param {string} repoRoot
 */
export function listTrackedFiles(repoRoot) {
  const output = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' });
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((rel) => normalizeRel(rel));
}

/**
 * @param {string} rel
 */
function isScannableFile(rel) {
  return /\.(ps1|ts|mjs|js)$/.test(rel);
}

/**
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {string[]} [options.files]
 * @param {ReturnType<typeof loadLaunchArgvBundle>['testExclusions']} [options.testExclusions]
 */
export function discoverLaunchSites(repoRoot, options = {}) {
  const testExclusions = options.testExclusions ?? loadLaunchArgvBundle(repoRoot).testExclusions;
  const files = options.files ?? listTrackedFiles(repoRoot).filter(isScannableFile);
  /** @type {LaunchSiteHit[]} */
  const hits = [];

  for (const rel of files) {
    if (rel.startsWith('vendor/') || rel.startsWith('packages/core/')) continue;
    const full = path.join(repoRoot, rel);
    if (!existsSync(full) || !statSync(full).isFile()) continue;

    const ext = path.extname(rel).slice(1);
    const language = ext === 'ps1' ? 'ps1' : ext;
    const testExcluded = isTestExcludedFile(rel, testExclusions);
    const source = readFileSync(full, 'utf8');
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isDiscoveryNoiseLine(line, 'spawnSync')) continue;

      for (const pattern of LAUNCH_IDIOM_PATTERNS) {
        if (!pattern.languages.includes(language)) continue;
        if (!pattern.regex.test(line)) continue;
        if (pattern.lineFilter && !pattern.lineFilter(line)) continue;

        hits.push({
          file: rel,
          line: i + 1,
          patternId: pattern.id,
          lineText: line.trim(),
          classification: testExcluded ? 'test-excluded' : 'production',
        });
      }
    }
  }

  return hits;
}

/**
 * @param {string} repoRoot
 */
export function loadLaunchArgvBundle(repoRoot) {
  const scriptsDir = path.join(repoRoot, 'scripts');
  const inventory = JSON.parse(readFileSync(path.join(scriptsDir, 'launch-argv-inventory.json'), 'utf8'));
  const validators = JSON.parse(readFileSync(path.join(scriptsDir, 'launch-argv-validators.manifest.json'), 'utf8'));
  const testExclusions = JSON.parse(readFileSync(path.join(scriptsDir, 'launch-argv-test-exclusions.manifest.json'), 'utf8'));
  return { inventory, validators, testExclusions };
}

/**
 * @param {string} text
 */
export function hashNormalizedBody(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').trim();
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

/**
 * @param {string} rel
 * @param {number} line
 * @param {LaunchPatternId} patternId
 * @param {InventoryRow} row
 */
function discoveryMatchCoversHit(rel, line, patternId, row) {
  const match = row.discoveryMatch;
  if (!match) return false;
  if (!match.patternIds.includes(patternId)) return false;
  if (match.line != null && match.line !== line) return false;
  if (match.file && normalizeRel(match.file) !== normalizeRel(rel)) return false;
  if (match.fileGlob && !matchesPathPattern(rel, [match.fileGlob])) return false;
  if (!match.file && !match.fileGlob) return false;
  return true;
}

/**
 * @param {LaunchSiteHit} hit
 * @param {InventoryRow[]} rows
 * @param {Array<{ path: string, patternId: LaunchPatternId, sourceHash: string, rowId: string }>} hashPinned
 */
export function matchDiscoveryHit(hit, rows, hashPinned = [], repoRoot = process.cwd()) {
  if (hit.classification === 'test-excluded') {
    return { outcome: 'test-excluded', rowId: null };
  }

  for (const row of rows) {
    if (discoveryMatchCoversHit(hit.file, hit.line, hit.patternId, row)) {
      return { outcome: 'inventoried', rowId: row.rowId };
    }
  }

  for (const entry of hashPinned) {
    if (normalizeRel(entry.path) !== hit.file || entry.patternId !== hit.patternId) continue;
    const full = path.join(repoRoot, hit.file);
    const source = readFileSync(full, 'utf8');
    const span = source.split('\n').slice(Math.max(0, hit.line - 3), hit.line + 2).join('\n');
    if (entry.sourceHash === hashNormalizedBody(span)) {
      return { outcome: 'inventoried', rowId: entry.rowId };
    }
    return { outcome: 'allowlist-drift', rowId: entry.rowId };
  }

  return { outcome: 'fail', rowId: null };
}

/**
 * @param {ReturnType<typeof loadLaunchArgvBundle>} bundle
 * @param {string} repoRoot
 */
export function validateInventoryRows(bundle, repoRoot) {
  const violations = [];
  const validatorIds = new Set((bundle.validators.validators ?? []).map((v) => v.id));
  const rows = bundle.inventory.rows ?? [];
  const rowIds = new Set();

  for (const row of rows) {
    if (rowIds.has(row.rowId)) {
      violations.push(`duplicate rowId: ${row.rowId}`);
    }
    rowIds.add(row.rowId);

    if (!row.caller?.file || !row.callee?.identity || !row.calleeContractSourceClass || !row.coverageKind) {
      violations.push(`${row.rowId}: missing required row fields`);
    }

    if (row.coverageKind === 'validator-backed') {
      if (!row.validatorId) {
        violations.push(`${row.rowId}: validator-backed row missing validatorId`);
      } else if (!validatorIds.has(row.validatorId)) {
        violations.push(`${row.rowId}: unknown validatorId ${row.validatorId}`);
      }
    }

    if (row.coverageKind === 'allowlist-debt') {
      const debt = row.allowlistDebt;
      if (!debt?.reason?.trim() || !debt?.followUpOwner?.trim()) {
        violations.push(`${row.rowId}: allowlist-debt row missing reason or followUpOwner`);
      }
    }

    if (row.validatorId && !existsSync(path.join(repoRoot, validatorScriptForId(bundle, row.validatorId) ?? ''))) {
      violations.push(`${row.rowId}: validator script missing for ${row.validatorId}`);
    }

    if (row.discoveryMatch) {
      const callerFile = normalizeRel(row.caller.file);
      const full = path.join(repoRoot, callerFile);
      if (!existsSync(full)) {
        violations.push(`${row.rowId}: caller file missing: ${callerFile}`);
      }
    }
  }

  for (const validatorId of REQUIRED_SHIPPED_VALIDATORS) {
    const referenced = rows.some((row) => row.validatorId === validatorId);
    const absorbed = (bundle.inventory.absorbedCoverage ?? []).some((rec) => rec.validatorId === validatorId);
    if (!referenced && !absorbed) {
      violations.push(`shipped validator not referenced in inventory: ${validatorId}`);
    }
  }

  return violations;
}

/**
 * @param {ReturnType<typeof loadLaunchArgvBundle>} bundle
 * @param {string} validatorId
 */
function validatorScriptForId(bundle, validatorId) {
  const entry = (bundle.validators.validators ?? []).find((v) => v.id === validatorId);
  return entry?.script ?? null;
}

/**
 * @param {LaunchSiteHit[]} hits
 * @param {InventoryRow[]} rows
 * @param {Array<{ path: string, patternId: LaunchPatternId, sourceHash: string, rowId: string }>} hashPinned
 */
export function classifyDiscoveryHits(hits, rows, hashPinned = [], repoRoot = process.cwd()) {
  /** @type {Array<{ hit: LaunchSiteHit, match: ReturnType<typeof matchDiscoveryHit> }>} */
  const classified = [];
  const failures = [];

  for (const hit of hits) {
    const match = matchDiscoveryHit(hit, rows, hashPinned, repoRoot);
    classified.push({ hit, match });
    if (match.outcome === 'fail') {
      failures.push(`${hit.file}:${hit.line} [${hit.patternId}] unmapped production launch site`);
    }
    if (match.outcome === 'allowlist-drift') {
      failures.push(`${hit.file}:${hit.line} [${hit.patternId}] hash-pinned allowlist drift (row ${match.rowId})`);
    }
  }

  return { classified, failures };
}

/**
 * @param {InventoryRow[]} rows
 * @param {LaunchSiteHit[]} productionHits
 */
export function findOrphanInventoryRows(rows, productionHits) {
  const orphans = [];
  for (const row of rows) {
    if (!row.discoveryMatch) continue;
    const covered = productionHits.some((hit) => discoveryMatchCoversHit(hit.file, hit.line, hit.patternId, row));
    if (!covered) {
      orphans.push(`${row.rowId}: no reachable production callsite for discoveryMatch`);
    }
  }
  return orphans;
}

/**
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 */
export function auditLaunchArgvInventory(repoRoot, options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const bundle = loadLaunchArgvBundle(root);
  const violations = [];

  violations.push(...validateInventoryRows(bundle, root));

  const hits = discoverLaunchSites(root, { testExclusions: bundle.testExclusions });
  const productionHits = hits.filter((h) => h.classification === 'production');
  const hashPinned = bundle.inventory.hashPinnedAllowlist ?? [];
  const rows = bundle.inventory.rows ?? [];

  const { failures } = classifyDiscoveryHits(hits, rows, hashPinned, root);
  violations.push(...failures);
  violations.push(...findOrphanInventoryRows(rows, productionHits));

  return {
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
    violations: violations.sort(),
    stats: {
      totalHits: hits.length,
      productionHits: productionHits.length,
      testExcludedHits: hits.length - productionHits.length,
      inventoryRows: rows.length,
    },
  };
}

export function proposeCensusRows(repoRoot) {
  const bundle = loadLaunchArgvBundle(repoRoot);
  const hits = discoverLaunchSites(repoRoot, { testExclusions: bundle.testExclusions });
  const productionHits = hits.filter((h) => h.classification === 'production');
  const rows = bundle.inventory.rows ?? [];
  const hashPinned = bundle.inventory.hashPinnedAllowlist ?? [];
  const unmatched = [];
  for (const hit of productionHits) {
    const match = matchDiscoveryHit(hit, rows, hashPinned, repoRoot);
    if (match.outcome === 'fail') unmatched.push(hit);
  }
  return unmatched;
}

export function loadTestExclusions(repoRoot) {
  const manifestPath = path.join(repoRoot, 'scripts/launch-argv-test-exclusions.manifest.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function validatorBackedForHit(hit) {
  if (hit.file === 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1' && hit.patternId === 'start-process') {
    return {
      validatorId: 'side-process-launch-contract',
      calleeContractSourceClass: 'pack-ps1-param-block',
      callee: { kind: 'pack-ps1', identity: 'registry child scripts' },
    };
  }
  if (hit.file === 'scripts/lib/Worker-Recovery.ps1' && hit.patternId === 'ps-call-op') {
    return {
      validatorId: 'ao-spawn-shape',
      calleeContractSourceClass: 'captured-external-help',
      callee: { kind: 'ao', identity: 'ao spawn' },
    };
  }
  const deadArgvFiles = new Set(DEAD_ARGV_BYPASS_FILES);
  if (deadArgvFiles.has(hit.file) && ['ps-call-op', 'pwsh-file', 'pwsh-noprofile', 'call-pwsh'].includes(hit.patternId)) {
    return {
      validatorId: 'ao-dead-argv-bypass',
      calleeContractSourceClass: 'captured-external-help',
      callee: { kind: 'ao', identity: 'ao CLI session/status/send' },
    };
  }
  const ghFiles = new Set(GH_INVENTORY_SCAN_FILES);
  if (ghFiles.has(hit.file)) {
    return {
      validatorId: 'gh-inventory-static',
      calleeContractSourceClass: 'gh-inventory-route',
      callee: { kind: 'gh', identity: 'scripts/gh pack wrapper' },
    };
  }
  return null;
}

export function buildDefaultInventoryRows(repoRoot) {
  /** @type {InventoryRow[]} */
  const rows = [
    {
      rowId: 'validator-ref-side-process-launch-contract',
      caller: { file: 'scripts/orchestrator-side-process-registry.json', anchor: 'children[]' },
      callee: { kind: 'pack-ps1', identity: 'registry child scripts' },
      calleeContractSourceClass: 'pack-ps1-param-block',
      coverageKind: 'validator-backed',
      validatorId: 'side-process-launch-contract',
    },
    {
      rowId: 'validator-ref-ao-spawn-shape',
      caller: { file: 'scripts/lib/Worker-Recovery.ps1', anchor: 'Invoke-WorkerRecoverySpawn' },
      callee: { kind: 'ao', identity: 'ao spawn' },
      calleeContractSourceClass: 'captured-external-help',
      coverageKind: 'validator-backed',
      validatorId: 'ao-spawn-shape',
    },
    {
      rowId: 'validator-ref-ao-cli-argv-shape',
      caller: { file: 'scripts/lib/Invoke-AoCliJson.ps1', anchor: 'Invoke-AoCliJson' },
      callee: { kind: 'ao', identity: 'ao session/status CLI' },
      calleeContractSourceClass: 'captured-external-help',
      coverageKind: 'validator-backed',
      validatorId: 'ao-cli-argv-shape',
    },
    {
      rowId: 'validator-ref-ao-dead-argv-bypass',
      caller: { file: 'scripts/check-ao-dead-argv-bypass.ps1', anchor: 'in-scope file lists' },
      callee: { kind: 'ao', identity: 'ao session/status/send transport' },
      calleeContractSourceClass: 'captured-external-help',
      coverageKind: 'validator-backed',
      validatorId: 'ao-dead-argv-bypass',
    },
    {
      rowId: 'validator-ref-gh-inventory-static',
      caller: { file: 'scripts/gh', anchor: 'classifyArgv inventory routes' },
      callee: { kind: 'gh', identity: 'scripts/gh pack wrapper' },
      calleeContractSourceClass: 'gh-inventory-route',
      coverageKind: 'validator-backed',
      validatorId: 'gh-inventory-static',
    },
  ];

  const testExclusions = loadTestExclusions(repoRoot);
  const hits = discoverLaunchSites(repoRoot, { testExclusions });
  const productionHits = hits.filter((h) => h.classification === 'production');
  /** @type {Map<string, { hit: typeof productionHits[number], patternIds: LaunchPatternId[] }>} */
  const grouped = new Map();
  for (const hit of productionHits) {
    const key = `${hit.file}:${hit.line}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.patternIds.includes(hit.patternId)) existing.patternIds.push(hit.patternId);
      continue;
    }
    grouped.set(key, { hit, patternIds: [hit.patternId] });
  }

  for (const { hit, patternIds } of grouped.values()) {
    const backed = validatorBackedForHit(hit);
    const slug = `${hit.file.replace(/[^a-zA-Z0-9]+/g, '-')}-${hit.line}`.slice(0, 90);
    if (backed) {
      rows.push({
        rowId: `site-${slug}`,
        caller: { file: hit.file, line: hit.line },
        callee: backed.callee,
        calleeContractSourceClass: backed.calleeContractSourceClass,
        coverageKind: 'validator-backed',
        validatorId: backed.validatorId,
        discoveryMatch: { file: hit.file, line: hit.line, patternIds },
      });
      continue;
    }
    rows.push({
      rowId: `site-${slug}`,
      caller: { file: hit.file, line: hit.line },
      callee: { kind: 'other-external', identity: 'per-callsite (discovery census)' },
      calleeContractSourceClass: 'allowlist-only',
      coverageKind: 'allowlist-debt',
      allowlistDebt: {
        reason: 'Census row for fail-closed discovery; capture-backed validator deferred.',
        followUpOwner: 'future-draft-callee-validators',
      },
      discoveryMatch: { file: hit.file, line: hit.line, patternIds },
    });
  }

  return rows;
}

function cli() {
  const repoRoot = process.argv[3] ? path.resolve(process.argv[3]) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const subcommand = process.argv[2] ?? 'audit';

  if (subcommand === 'audit') {
    const result = auditLaunchArgvInventory(repoRoot);
    if (result.verdict !== 'PASS') {
      for (const v of result.violations) process.stderr.write(`${v}\n`);
      process.stderr.write(`[FAIL] launch-argv inventory audit (${result.stats.productionHits} production hits, ${result.stats.inventoryRows} rows)\n`);
      process.exit(1);
    }
    process.stdout.write(`[PASS] launch-argv inventory audit (${result.stats.productionHits} production hits, ${result.stats.inventoryRows} rows)\n`);
    return;
  }

  if (subcommand === 'propose-census') {
    const unmatched = proposeCensusRows(repoRoot);
    process.stdout.write(`${JSON.stringify(unmatched, null, 2)}\n`);
    return;
  }

  if (subcommand === 'emit-default-inventory') {
    const rows = buildDefaultInventoryRows(repoRoot);
    const payload = {
      schemaVersion: 1,
      description: 'Pack-wide production caller→callee launch inventory (Issue #661).',
      absorbedCoverage: [
        {
          validatorId: 'ao-cli-argv-shape',
          note: 'Capture-backed AO session/status argv probes cover Invoke-AoCliJson adoption surfaces referenced by dead-argv-bypass file list.',
        },
      ],
      hashPinnedAllowlist: [],
      rows,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stderr.write('Usage: launch-argv-registry.mjs <audit|propose-census|emit-default-inventory> [repoRoot]\n');
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  cli();
}
