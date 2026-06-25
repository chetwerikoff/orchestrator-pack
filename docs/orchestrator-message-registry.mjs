#!/usr/bin/env node
/**
 * Orchestrator message registry: catalog validation, overlap inference, registration audit,
 * and deterministic map generation (Issue #298).
 *
 * Static-parse / manifest only — never execute-import runtime scripts.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW_SEND_PATTERNS = [
  { id: 'ao-send', regex: /(?<![\w-])&\s*ao\s+@?send\b/i },
  { id: 'ao-send-direct', regex: /(?:^|[;|({\[])\s*ao\s+@?send\b/im, relPathSuffixes: ['.ps1', '/ao'] },
  { id: 'ao-send-splat', regex: /&\s*ao\s+@sendArgs\b/i },
  { id: 'ao-review-send', regex: /(?<![\w-])&\s*ao\s+review\s+send\b|&\s*ao\s+@.*review.*send|&\s*ao\s+@\(.*'review'.*'send'/i },
  { id: 'ao-review-send-direct', regex: /(?:^|[;|({\[])\s*ao\s+review\s+send\b/im, relPathSuffixes: ['.ps1', '/ao'] },
  { id: 'ao-review-send-args', regex: /@\(\s*'review'\s*,\s*'send'/i },
  { id: 'draft-submit', regex: /Invoke-WorkerInputDraftSubmit\b/ },
  { id: 'tmux-submit', regex: /tmux\s+send-keys\b.*Enter/i },
  { id: 'ao-path-send', regex: /\$aoArgs\s*=\s*@\(\s*'send'/i },
];

const UNANALYZABLE_PATTERNS = [
  { id: 'invoke-expression', regex: /\bInvoke-Expression\b/i },
  { id: 'bash-c', regex: /\bbash\s+-c\b/i },
  { id: 'iex', regex: /\biex\b/i },
];

const BASELINE_CLASS_IDS = [
  'orchestrator-wake-webhook',
  'orchestrator-wake-heartbeat',
  'ci-green-worker-nudge',
  'ci-failure-reaction-routed',
  'ci-failure-orchestrator-turn',
  'review-findings-first-send',
  'review-findings-redelivery',
  'worker-input-draft-submit',
];

export function assertSupportedHost(platform = process.platform, env = process.env) {
  const isWsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  const isLinux = platform === 'linux';
  if (isLinux || isWsl) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `unsupported host: ${platform} (Issue #298 requires Linux/WSL with Node + pwsh 7+)`,
  };
}

export function hashNormalizedBody(text) {
  const normalized = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/#[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function readJsonFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`missing manifest: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function loadRegistryBundle(repoRoot) {
  const scriptsDir = path.join(repoRoot, 'scripts');
  const catalog = readJsonFile(path.join(scriptsDir, 'orchestrator-message-catalog.json'));
  const taxonomy = readJsonFile(path.join(scriptsDir, 'orchestrator-message-taxonomy.json'));
  const owners = readJsonFile(path.join(scriptsDir, 'orchestrator-message-owner-mechanisms.manifest.json'));
  const helpers = readJsonFile(path.join(scriptsDir, 'orchestrator-message-send-helpers.manifest.json'));
  const auditRoots = readJsonFile(path.join(scriptsDir, 'orchestrator-message-audit-roots.manifest.json'));
  const protectedRuntime = readJsonFile(path.join(scriptsDir, 'orchestrator-message-protected-runtime.manifest.json'));
  const allowlist = readJsonFile(path.join(scriptsDir, 'orchestrator-message-allowlist.json'));
  const supervisorRegistry = readJsonFile(path.join(scriptsDir, 'orchestrator-side-process-registry.json'));
  return { catalog, taxonomy, owners, helpers, auditRoots, protectedRuntime, allowlist, supervisorRegistry };
}

export function extractFunctionBody(source, functionName) {
  const pattern = new RegExp(`function\\s+${functionName}\\b[^{]*\\{`, 'i');
  const match = pattern.exec(source);
  if (!match) return null;
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return source.slice(start, i - 1);
}

export function extractAnchorSnippet(source, needle, radius = 300) {
  const idx = source.indexOf(needle);
  if (idx < 0) return null;
  return source.slice(Math.max(0, idx - radius), Math.min(source.length, idx + needle.length + radius));
}

export function extractYamlRulesSection(source, marker) {
  const idx = source.indexOf(marker);
  if (idx < 0) return null;
  const slice = source.slice(idx, idx + 4000);
  return slice;
}

export function resolveOverlapKeys(keys, aliases, key) {
  const expanded = new Set([key]);
  for (const edge of aliases ?? []) {
    if (edge.parent === key) expanded.add(edge.child);
    if (edge.child === key) expanded.add(edge.parent);
  }
  return expanded;
}

export function recipientKeysOverlap(a, b, taxonomy) {
  const setA = resolveOverlapKeys(taxonomy.recipientKeys, taxonomy.recipientAliases, a);
  const setB = resolveOverlapKeys(taxonomy.recipientKeys, taxonomy.recipientAliases, b);
  for (const x of setA) {
    if (setB.has(x)) return true;
  }
  return false;
}

export function intentKeysOverlap(a, b, taxonomy) {
  const setA = resolveOverlapKeys(taxonomy.intentKeys, taxonomy.intentAliases, a);
  const setB = resolveOverlapKeys(taxonomy.intentKeys, taxonomy.intentAliases, b);
  for (const x of setA) {
    if (setB.has(x)) return true;
  }
  return false;
}

function ownerRef(kind, owners, ref) {
  const table = kind === 'delivery' ? owners.deliveryIdempotencyOwners : owners.semanticDedupOwners;
  return table?.[ref] ?? null;
}

export function validateOwnerReference(kind, owners, ref, entry, repoRoot = '') {
  const violations = [];
  const resolved = ownerRef(kind, owners, ref);
  if (!resolved) {
    violations.push(`unknown ${kind} owner reference: ${ref}`);
    return violations;
  }
  if (ref === 'none') return violations;
  if (!resolved.issue) {
    violations.push(`owner ${ref} missing issue linkage`);
  }
  const impl = resolved.implementation;
  if (!impl?.file || !impl?.claimKeyFields?.length) {
    violations.push(`owner ${ref} missing static implementation binding`);
    return violations;
  }
  const appliesToEntry = (kind === 'semantic' && entry?.semantic_dedup_owner === ref)
    || (kind === 'delivery' && entry?.delivery_idempotency_owner === ref);
  if (kind === 'semantic' && entry?.semantic_dedup_owner === ref) {
    const scope = entry.semanticDedupCoverage ?? resolved.defaultCoverage;
    if (!scope?.recipientKeys?.length || !scope?.intentKeys?.length) {
      violations.push(`semantic owner ${ref} missing coverage scope for ${entry.message_class_id}`);
    } else if (!scope.messageClassIds?.includes(entry.message_class_id)) {
      violations.push(`semantic owner ${ref} scope does not cover ${entry.message_class_id}`);
    }
  }
  if (appliesToEntry) {
    const fieldText = readFileIfExists(impl.file, repoRoot);
    if (!fieldText) {
      violations.push(`owner ${ref} implementation file missing: ${impl.file}`);
    }
    else {
      for (const fieldName of impl.claimKeyFields) {
        if (!fieldText.includes(fieldName)) {
          violations.push(`owner ${ref} claims field ${fieldName} not present in ${impl.file}`);
        }
      }
    }
  }
  return violations;
}

function readFileIfExists(relPath, repoRoot = '') {
  const full = path.isAbsolute(relPath) ? relPath : path.join(repoRoot, relPath);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8');
}

export function validateCatalogEntry(entry, bundle, repoRoot) {
  const violations = [];
  const required = [
    'message_class_id',
    'trigger',
    'owning_process',
    'recipient_key',
    'intent_key',
    'mechanism',
    'delivery_idempotency_owner',
    'semantic_dedup_owner',
    'callsite',
  ];
  for (const field of required) {
    if (!entry[field]) violations.push(`${entry.message_class_id ?? '?'}: missing ${field}`);
  }
  if (!bundle.taxonomy.recipientKeys.includes(entry.recipient_key)) {
    violations.push(`${entry.message_class_id}: invalid recipient_key ${entry.recipient_key}`);
  }
  if (!bundle.taxonomy.intentKeys.includes(entry.intent_key)) {
    violations.push(`${entry.message_class_id}: invalid intent_key ${entry.intent_key}`);
  }
  const allowedOwners = new Set(['orchestrator-rules', 'journaled-worker-send']);
  const childIds = bundle.supervisorRegistry.children?.map((c) => c.id) ?? [];
  if (!childIds.includes(entry.owning_process) && !allowedOwners.has(entry.owning_process)) {
    violations.push(`${entry.message_class_id}: owning_process ${entry.owning_process} not in supervisor inventory`);
  }
  violations.push(...validateOwnerReference('delivery', bundle.owners, entry.delivery_idempotency_owner, entry, repoRoot));
  violations.push(...validateOwnerReference('semantic', bundle.owners, entry.semantic_dedup_owner, entry, repoRoot));

  const cs = entry.callsite;
  if (cs?.file && cs?.function) {
    const source = readFileIfExists(cs.file, repoRoot);
    if (!source) {
      violations.push(`${entry.message_class_id}: callsite file missing ${cs.file}`);
    } else {
      const body = cs.anchor === 'orchestrator-rules'
        ? extractYamlRulesSection(source, cs.function)
        : cs.anchor === 'callsite-snippet'
          ? extractAnchorSnippet(source, cs.function)
          : extractFunctionBody(source, cs.function);
      if (!body) {
        violations.push(`${entry.message_class_id}: callsite function/anchor not found ${cs.file}::${cs.function}`);
      } else if (!cs.predicateBodyHash) {
        violations.push(`${entry.message_class_id}: missing callsite.predicateBodyHash`);
      } else {
        const live = hashNormalizedBody(body);
        if (live !== cs.predicateBodyHash) {
          violations.push(`${entry.message_class_id}: predicate body hash drift (expected ${cs.predicateBodyHash}, got ${live})`);
        }
      }
    }
  }
  return violations;
}

export function validateCatalog(bundle, repoRoot) {
  const violations = [];
  const entries = bundle.catalog.entries ?? [];
  const ids = entries.map((e) => e.message_class_id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) violations.push(`duplicate message_class_id: ${[...new Set(dupes)].join(', ')}`);

  const signatures = new Map();
  for (const entry of entries) {
    violations.push(...validateCatalogEntry(entry, bundle, repoRoot));
    const sig = `${entry.callsite?.file}::${entry.callsite?.function}::${entry.callsite?.anchor ?? ''}`;
    if (signatures.has(sig) && signatures.get(sig) !== entry.message_class_id) {
      violations.push(`divergent message_class_id reuse at ${sig}: ${signatures.get(sig)} vs ${entry.message_class_id}`);
    } else {
      signatures.set(sig, entry.message_class_id);
    }
  }
  return { ok: violations.length === 0, violations };
}

function coverageOwnsCollision(owner, entryA, entryB, taxonomy, owners) {
  if (!owner || owner === 'none') return false;
  const resolved = ownerRef('semantic', owners, owner);
  if (!resolved) return false;
  const scopeA = entryA.semanticDedupCoverage ?? resolved.defaultCoverage;
  const scopeB = entryB.semanticDedupCoverage ?? resolved.defaultCoverage;
  const scope = scopeA ?? scopeB;
  if (!scope) return false;
  const recipientOverlap = recipientKeysOverlap(entryA.recipient_key, entryB.recipient_key, taxonomy)
    && intentKeysOverlap(entryA.intent_key, entryB.intent_key, taxonomy);
  if (!recipientOverlap) return false;
  return scope.messageClassIds?.includes(entryA.message_class_id)
    && scope.messageClassIds?.includes(entryB.message_class_id);
}

export function checkSemanticOverlaps(catalog, taxonomy, owners) {
  const entries = catalog.entries ?? [];
  const flagged = [];
  const owned = [];
  const overrides = [];

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      const recipientOverlap = recipientKeysOverlap(a.recipient_key, b.recipient_key, taxonomy);
      const intentOverlap = intentKeysOverlap(a.intent_key, b.intent_key, taxonomy);
      if (!recipientOverlap || !intentOverlap) continue;

      const pair = [a.message_class_id, b.message_class_id].sort().join(' <> ');
      const override = (catalog.overlapOverrides ?? []).find((o) => {
        if (!o.messageClassIds?.includes(a.message_class_id) || !o.messageClassIds?.includes(b.message_class_id)) {
          return false;
        }
        if (Array.isArray(o.pairs) && o.pairs.length > 0) {
          return o.pairs.some((pair) => {
            const sorted = [...pair].sort();
            const current = [a.message_class_id, b.message_class_id].sort();
            return sorted[0] === current[0] && sorted[1] === current[1];
          });
        }
        return o.messageClassIds.length === 2;
      });

      if (override) {
        const overrideViolations = validateOverlapOverride(override);
        if (overrideViolations.length) {
          flagged.push({ pair, reason: 'invalid_override', details: overrideViolations });
        } else {
          overrides.push({ pair, override: override.id ?? 'override' });
        }
        continue;
      }

      const aOwned = a.semantic_dedup_owner !== 'none'
        && coverageOwnsCollision(a.semantic_dedup_owner, a, b, taxonomy, owners);
      const bOwned = b.semantic_dedup_owner !== 'none'
        && coverageOwnsCollision(b.semantic_dedup_owner, a, b, taxonomy, owners);
      if (aOwned || bOwned) {
        owned.push({ pair, owner: aOwned ? a.semantic_dedup_owner : b.semantic_dedup_owner });
        continue;
      }

      flagged.push({
        pair,
        reason: 'unowned_semantic_overlap',
        recipient: `${a.recipient_key}/${b.recipient_key}`,
        intent: `${a.intent_key}/${b.intent_key}`,
        deliveryOnly: Boolean(
          (a.delivery_idempotency_owner !== 'none' || b.delivery_idempotency_owner !== 'none')
          && a.semantic_dedup_owner === 'none' && b.semantic_dedup_owner === 'none',
        ),
      });
    }
  }

  return {
    ok: flagged.length === 0,
    flagged,
    owned,
    overrides,
    summary: {
      unownedCount: flagged.length,
      ownedCount: owned.length,
      overrideCount: overrides.length,
    },
  };
}

export function validateOverlapOverride(override) {
  const violations = [];
  const required = ['id', 'rationale', 'reviewer', 'linkedIssue', 'messageClassIds', 'evidenceKind', 'evidence'];
  for (const field of required) {
    if (!override[field]) violations.push(`override missing ${field}`);
  }
  const allowedEvidence = ['trigger-mutual-exclusion', 'recipient-non-equivalence', 'reachability-proof'];
  if (override.evidenceKind && !allowedEvidence.includes(override.evidenceKind)) {
    violations.push(`override evidenceKind must be one of ${allowedEvidence.join(', ')}`);
  }
  return violations;
}

function patternMechanismIds(patternId) {
  switch (patternId) {
    case 'ao-send-direct':
    case 'ao-send-splat':
    case 'ao-path-send':
      return ['ao-send', 'ao-review-send'];
    case 'ao-review-send-direct':
    case 'ao-review-send-args':
      return ['ao-review-send'];
    case 'tmux-submit':
      return ['draft-submit'];
    default:
      return [patternId];
  }
}

function helperOwnsMechanism(helper, mechanismId) {
  return (helper.mechanisms ?? []).includes(mechanismId);
}

function helperOwnsAnyMechanism(helper, mechanismIds) {
  return mechanismIds.some((mechanismId) => helperOwnsMechanism(helper, mechanismId));
}

function catalogAllowsDraftSubmitInvocation(relPath, catalogEntries, helpers, supervisorRegistry) {
  const normPath = relPath.replace(/\\/g, '/');
  const helperFile = helpers.helpers
    ?.find((helper) => helper.name === 'Invoke-WorkerInputDraftSubmit')
    ?.file
    ?.replace(/\\/g, '/');
  if (helperFile === normPath) return true;
  const childScriptById = new Map(
    (supervisorRegistry?.children ?? []).map((child) => [child.id, `scripts/${child.script}`.replace(/\\/g, '/')]),
  );
  for (const entry of catalogEntries ?? []) {
    if (entry.mechanism !== 'draft-submit') continue;
    const ownerScript = childScriptById.get(entry.owning_process);
    if (ownerScript === normPath) return true;
  }
  return false;
}

function isHelperFunctionDefinition(source, index, helperName) {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const lineEnd = source.indexOf('\n', index);
  const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  return new RegExp(`^\\s*function\\s+${helperName}\\b`, 'i').test(line);
}

function helperFunctionNames(helper) {
  return [helper.name, ...(helper.relatedFunctions ?? [])].filter(Boolean);
}

function findEnclosingHelper(relFile, helpers, source, index) {
  const matches = [];
  for (const helper of helpers.helpers ?? []) {
    if (helper.file !== relFile) continue;
    for (const functionName of helperFunctionNames(helper)) {
      const body = extractFunctionBody(source, functionName);
      if (!body) continue;
      const fnPattern = new RegExp(`function\\s+${functionName}\\b`, 'i');
      const fnMatch = fnPattern.exec(source);
      if (!fnMatch) continue;
      const start = fnMatch.index;
      const end = start + body.length + fnMatch[0].length;
      if (index >= start && index <= end) {
        matches.push(helper);
        break;
      }
    }
  }
  return matches;
}

export function detectRawSendsInSource(relPath, source, helpers, allowlistEntries = [], catalogEntries = [], supervisorRegistry = { children: [] }) {
  const findings = [];
  const allowByPath = new Map((allowlistEntries ?? []).map((e) => [e.path, e]));

  for (const pattern of UNANALYZABLE_PATTERNS) {
    if (pattern.regex.test(source)) {
      const allow = allowByPath.get(relPath);
      if (allow) {
        const spanHash = hashNormalizedBody(source.slice(0, 500));
        if (allow.sourceHash !== spanHash) {
          findings.push({ relPath, kind: 'allowlist_drift', pattern: pattern.id, site: relPath });
        }
        continue;
      }
      findings.push({ relPath, kind: 'unanalyzable', pattern: pattern.id, site: relPath });
    }
  }

  for (const pattern of RAW_SEND_PATTERNS) {
    const normPath = relPath.replace(/\\/g, '/');
    if (pattern.relPathSuffixes && !pattern.relPathSuffixes.some((suffix) => normPath.endsWith(suffix))) {
      continue;
    }
    let match;
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`);
    while ((match = regex.exec(source)) !== null) {
      const matchText = match[0];
      if (pattern.id === 'draft-submit') {
        if (isHelperFunctionDefinition(source, match.index, 'Invoke-WorkerInputDraftSubmit')) {
          continue;
        }
        if (catalogAllowsDraftSubmitInvocation(relPath, catalogEntries, helpers, supervisorRegistry)) {
          continue;
        }
      }
      const enclosing = findEnclosingHelper(relPath, helpers, source, match.index);
      const mechanismIds = patternMechanismIds(pattern.id);
      const owned = enclosing.some((helper) => helperOwnsAnyMechanism(helper, mechanismIds));
      if (!owned) {
        const line = source.slice(0, match.index).split('\n').length;
        findings.push({
          relPath,
          kind: 'raw_send_outside_helper',
          mechanism: pattern.id,
          line,
          site: `${relPath}:${line}`,
        });
      }
    }
  }
  return findings;
}

export function listHelperAuditFiles(helpers) {
  const files = new Set();
  for (const helper of helpers?.helpers ?? []) {
    if (helper?.file) files.add(String(helper.file).replace(/\\/g, '/'));
  }
  return [...files].sort();
}

export function listDeclaredAuditRootFiles(auditRoots) {
  const declared = new Set();
  const add = (rel) => {
    if (rel) declared.add(String(rel).replace(/\\/g, '/'));
  };
  for (const group of [
    auditRoots.supervisedProcessScripts,
    auditRoots.supervisorEntrypoints,
    auditRoots.ciInvokedScripts,
    auditRoots.commandEntrypoints,
  ]) {
    for (const rel of group ?? []) add(rel);
  }
  for (const rel of auditRoots.orchestratorRulesBindings ?? []) add(rel);
  return [...declared].sort();
}

export function collectAuditRootFiles(repoRoot, auditRoots, helpers = { helpers: [] }) {
  const files = new Set([
    ...listDeclaredAuditRootFiles(auditRoots),
    ...listHelperAuditFiles(helpers),
  ]);
  return [...files].filter((rel) => {
    const full = path.join(repoRoot, rel);
    return existsSync(full) && statSync(full).isFile();
  }).sort();
}

export function validateAuditRootCompleteness(bundle, repoRoot) {
  const violations = [];
  const registryScripts = (bundle.supervisorRegistry.children ?? []).map((c) => `scripts/${c.script}`);
  const declaredSupervised = new Set([
    ...(bundle.auditRoots.supervisedProcessScripts ?? []),
    ...(bundle.auditRoots.supervisorEntrypoints ?? []),
  ]);
  for (const script of registryScripts) {
    if (!declaredSupervised.has(script)) {
      violations.push(`audit root set missing supervised process: ${script}`);
    }
  }
  for (const rel of listDeclaredAuditRootFiles(bundle.auditRoots)) {
    const full = path.join(repoRoot, rel);
    if (!existsSync(full) || !statSync(full).isFile()) {
      violations.push(`audit root file missing: ${rel}`);
    }
  }
  for (const rel of listHelperAuditFiles(bundle.helpers)) {
    const full = path.join(repoRoot, rel);
    if (!existsSync(full) || !statSync(full).isFile()) {
      violations.push(`helper audit file missing: ${rel}`);
    }
  }
  return violations;
}

export function mapSendSitesToCatalog(entries, sendFindings, helpers) {
  const mapped = [];
  const unmapped = [];
  for (const finding of sendFindings) {
    if (finding.kind !== 'raw_send_outside_helper') continue;
    const match = entries.find((e) => e.callsite?.file === finding.relPath);
    if (match) mapped.push({ finding, messageClassId: match.message_class_id });
    else unmapped.push(finding);
  }
  return { mapped, unmapped };
}

export function enumerateBaselineClassIds() {
  return [...BASELINE_CLASS_IDS];
}

export function auditRegistration(repoRoot, options = {}) {
  const host = assertSupportedHost();
  if (!host.ok && !options.ignoreHost) {
    return { verdict: 'FAIL', host, violations: [host.error] };
  }

  const bundle = loadRegistryBundle(repoRoot);
  const violations = [];
  const catalogValidation = validateCatalog(bundle, repoRoot);
  violations.push(...catalogValidation.violations);

  const overlap = checkSemanticOverlaps(bundle.catalog, bundle.taxonomy, bundle.owners);
  if (!overlap.ok) {
    for (const f of overlap.flagged) {
      violations.push(`overlap: ${f.pair} (${f.reason})`);
    }
  }

  violations.push(...validateAuditRootCompleteness(bundle, repoRoot));

  const rootFiles = options.rootFiles ?? collectAuditRootFiles(repoRoot, bundle.auditRoots, bundle.helpers);
  const sendFindings = [];
  for (const rel of rootFiles) {
    const source = readFileSync(path.join(repoRoot, rel), 'utf8');
    sendFindings.push(...detectRawSendsInSource(
      rel,
      source,
      bundle.helpers,
      bundle.allowlist.entries,
      bundle.catalog.entries,
      bundle.supervisorRegistry,
    ));
  }

  const rawOutside = sendFindings.filter((f) => f.kind === 'raw_send_outside_helper');
  const unanalyzable = sendFindings.filter((f) => f.kind === 'unanalyzable' || f.kind === 'allowlist_drift');
  for (const f of rawOutside) violations.push(`raw send outside helper: ${f.site} (${f.mechanism})`);
  for (const f of unanalyzable) violations.push(`unanalyzable send construct: ${f.site} (${f.pattern ?? f.kind})`);

  const baseline = enumerateBaselineClassIds();
  const catalogIds = new Set((bundle.catalog.entries ?? []).map((e) => e.message_class_id));
  for (const id of baseline) {
    if (!catalogIds.has(id)) violations.push(`baseline class missing from catalog: ${id}`);
  }

  const reachableIds = new Set();
  for (const entry of bundle.catalog.entries ?? []) {
    const cs = entry.callsite;
    if (!cs?.file) continue;
    const full = path.join(repoRoot, cs.file);
    if (existsSync(full)) reachableIds.add(entry.message_class_id);
  }
  for (const entry of bundle.catalog.entries ?? []) {
    if (!reachableIds.has(entry.message_class_id)) {
      violations.push(`stale catalog entry (no reachable send path): ${entry.message_class_id}`);
    }
  }

  const ownerAsClass = (bundle.catalog.entries ?? []).filter((e) =>
    e.message_class_id?.startsWith('issue-') && !reachableIds.has(e.message_class_id));
  for (const e of ownerAsClass) {
    violations.push(`owner mechanism listed as message class without send path: ${e.message_class_id}`);
  }

  return {
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
    violations: violations.sort(),
    overlap,
    sendFindings,
    host,
  };
}

export function generateMessageMap(catalog, overlapResult) {
  const lines = [];
  lines.push('# Orchestrator message map');
  lines.push('');
  lines.push('> Generated from `scripts/orchestrator-message-catalog.json`. Do not edit by hand.');
  lines.push('');
  lines.push('## Per-class summary');
  lines.push('');
  lines.push('| message_class_id | trigger | owning_process | recipient | intent | mechanism | semantic_dedup |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  const entries = [...(catalog.entries ?? [])].sort((a, b) => a.message_class_id.localeCompare(b.message_class_id));
  for (const e of entries) {
    lines.push(`| ${e.message_class_id} | ${e.trigger?.summary ?? ''} | ${e.owning_process} | ${e.recipient_key} | ${e.intent_key} | ${e.mechanism} | ${e.semantic_dedup_owner} |`);
  }
  lines.push('');
  lines.push('## Overlap summary');
  lines.push('');
  lines.push(`- Unowned collisions: ${overlapResult.summary?.unownedCount ?? 0}`);
  lines.push(`- Owner-covered pairs: ${overlapResult.summary?.ownedCount ?? 0}`);
  lines.push(`- Evidenced overrides: ${overlapResult.summary?.overrideCount ?? 0}`);
  if (overlapResult.flagged?.length) {
    lines.push('');
    lines.push('### Flagged pairs (detail on failing check only)');
    for (const f of overlapResult.flagged) {
      lines.push(`- ${f.pair}: ${f.reason}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function readGithubActionsPullRequestShas() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return null;
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    const baseSha = event.pull_request?.base?.sha;
    const headSha = event.pull_request?.head?.sha;
    if (!baseSha || !headSha) return null;
    return { baseSha, headSha };
  }
  catch {
    return null;
  }
}

/**
 * @param {string} [repoRoot]
 */
export function resolveLinkedIssueNumbers(repoRoot = process.cwd()) {
  const linked = new Set();
  const fromEnv = String(process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES ?? '')
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of fromEnv) {
    const match = /^(?:#|issue-)?(\d+)$/i.exec(part);
    if (match) linked.add(Number(match[1]));
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf8'));
      const text = [
        event.pull_request?.title,
        event.pull_request?.body,
        event.pull_request?.head?.ref,
      ]
        .filter(Boolean)
        .join('\n');
      for (const match of text.matchAll(/(?:^|\s|#)(\d{1,6})(?=\s|$|[):,])/g)) {
        linked.add(Number(match[1]));
      }
      for (const match of text.matchAll(/(?:refs?|see|closes?|fixes?|resolves?)\s+#(\d+)/gi)) {
        linked.add(Number(match[1]));
      }
    }
    catch {
      // ignore malformed event payload
    }
  }

  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const branchMatch = /(?:^|\/)(\d{1,6})(?:-|$)/.exec(branch) ?? /#(\d{1,6})\b/.exec(branch);
    if (branchMatch) linked.add(Number(branchMatch[1]));
  }
  catch {
    // ignore detached HEAD / missing git
  }

  return [...linked];
}

/** Linked issues evidenced by committed declaration snapshots present in the gated diff. */
function issueLinksFromValidatedDeclarationSnapshot(relPath, snapshot, changed) {
  const norm = String(relPath).replace(/\\/g, '/');
  const nameMatch = /^docs\/declarations\/(\d{1,6})\.[^/]+\.json$/.exec(norm);
  if (!nameMatch) return null;
  const issueFromName = Number(nameMatch[1]);
  const coordinated = BUILTIN_COORDINATED_ISSUE_DECLARED_PATH_EDITS[issueFromName];
  if (!coordinated) return null;
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (Number(snapshot.issue_number) !== issueFromName) return null;
  if (!Array.isArray(snapshot.declared_paths) || snapshot.declared_paths.length === 0) return null;

  const declared = new Set(
    snapshot.declared_paths.map((declaredPath) => String(declaredPath).replace(/\\/g, '/')),
  );
  const overlaps = coordinated.some(
    (coordPath) => changed.has(coordPath) && declared.has(coordPath),
  );
  return overlaps ? issueFromName : null;
}

export function resolveLinkedIssuesFromDeclarationSnapshots(
  repoRoot,
  changedFiles = [],
  options = {},
) {
  const changed = new Set((changedFiles ?? []).map((file) => String(file).replace(/\\/g, '/')));
  const gitRef = options.gitRef ?? resolveRepoHeadRef(repoRoot);
  const linked = new Set();
  for (const file of changedFiles ?? []) {
    const norm = String(file).replace(/\\/g, '/');
    if (!/^docs\/declarations\/(\d{1,6})\.[^/]+\.json$/.test(norm)) continue;
    const snapshot = readDeclarationSnapshotAtRef(repoRoot, norm, gitRef);
    const issue = issueLinksFromValidatedDeclarationSnapshot(norm, snapshot, changed);
    if (issue !== null) linked.add(issue);
  }
  return [...linked];
}

/** Issue-linked declared-path edits allowed when an issue is explicitly linked (branch/PR/env). */
const BUILTIN_COORDINATED_ISSUE_DECLARED_PATH_EDITS = {
  324: [
    'agent-orchestrator.yaml.example',
    'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
  ],
  332: [
    'scripts/ci-green-wake-reconcile.ps1',
    'scripts/review-trigger-reconcile.ps1',
  ],
  339: [
    'docs/worker-message-submit-reconcile.mjs',
    'scripts/lib/Record-WorkerMessageDispatch.ps1',
    'scripts/worker-message-submit-reconcile.ps1',
  ],
  342: [
    'docs/ci-failure-notification.mjs',
    'scripts/ci-failure-notification.ps1',
    'scripts/ci-failure-notification-reconcile.ps1',
    'scripts/orchestrator-side-process-registry.json',
    'scripts/orchestrator-wake-supervisor.test.ts',
    'agent-orchestrator.yaml.example',
  ],
  347: [
    'agent-orchestrator.yaml.example',
    'docs/worker-message-submit-reconcile.mjs',
    'scripts/fixtures/mechanical-json-state/state-coverage-manifest.json',
    'scripts/worker-message-submit-reconcile.ps1',
    'scripts/worker-message-submit-reconcile.test.ts',
  ],
  373: [
    'docs/worker-message-submit-reconcile.mjs',
    'scripts/journaled-worker-send.ps1',
    'scripts/lib/MechanicalReconcileNode.ps1',
    'scripts/worker-message-submit-reconcile.ps1',
    'scripts/worker-message-submit-reconcile.test.ts',
  ],
  381: [
    'scripts/orchestrator-wake-listener.ps1',
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1',
    'scripts/lib/Record-ReviewHandoffWakeAdmission.ps1',
    'docs/orchestrator-wake-filter.mjs',
    'docs/review-wake-trigger.mjs',
    'docs/review-handoff-wake-admission.mjs',
  ],
  417: [
    'scripts/lib/Review-StartClaim.ps1',
    'scripts/review-run-recovery.ps1',
  ],
  384: [
    'scripts/ci-green-wake-reconcile.ps1',
    'scripts/ci-failure-notification-reconcile.ps1',
    'scripts/review-send-reconcile.ps1',
    'scripts/review-finding-delivery-confirm.ps1',
    'scripts/journaled-worker-send.ps1',
    'scripts/lib/Worker-NudgeClaim.ps1',
    'scripts/lib/Worker-AutonomousNudgeGate.ps1',
    'scripts/lib/Worker-NudgeAudit.ps1',
  ],
  450: [
    'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
    'scripts/orchestrator-wake-supervisor-test-child.ps1',
    'scripts/orchestrator-wake-supervisor.test.ts',
    'scripts/orchestrator-wake-listener.ps1',
    'scripts/review-trigger-reconcile.ps1',
    'scripts/review-trigger-reeval.ps1',
    'scripts/ci-green-wake-reconcile.ps1',
    'scripts/review-send-reconcile.ps1',
    'scripts/review-finding-delivery-confirm.ps1',
  ],
};

/**
 * Linked issues evidenced by committed declaration snapshots on disk when the gated
 * diff edits coordinated protected-runtime paths those snapshots declare.
 */
function listGitTreeDeclarationSnapshots(repoRoot, gitRef = 'HEAD') {
  const paths = new Set();
  for (const args of [
    ['ls-tree', '-r', '--name-only', gitRef, '--', 'docs/declarations'],
    ['ls-tree', '-r', '--name-only', gitRef, 'docs/declarations'],
  ]) {
    try {
      const out = execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      for (const relPath of parseGitDiffNameOnlyOutput(out)) {
        paths.add(relPath);
      }
    }
    catch {
      // try next form
    }
  }
  if (paths.size === 0) {
    try {
      const out = execFileSync('git', ['ls-tree', '-r', '--name-only', gitRef], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      for (const relPath of parseGitDiffNameOnlyOutput(out)) {
        if (/^docs\/declarations\/(\d{1,6})\.[^/]+\.json$/.test(relPath)) {
          paths.add(relPath);
        }
      }
    }
    catch {
      // ignore missing git ref
    }
  }
  return [...paths];
}

function declarationSnapshotExistsAtRef(repoRoot, relPath, gitRef = 'HEAD') {
  try {
    execFileSync('git', ['cat-file', '-e', `${gitRef}:${relPath}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  }
  catch {
    return false;
  }
}

function readDeclarationSnapshotAtRef(repoRoot, relPath, gitRef = 'HEAD', options = {}) {
  const normalized = String(relPath).replace(/\\/g, '/');
  const preferCommittedOverDisk = options.preferCommittedOverDisk === true;
  try {
    const out = execFileSync('git', ['show', `${gitRef}:${normalized}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return JSON.parse(out);
  }
  catch {
    if (preferCommittedOverDisk) {
      return null;
    }
    // fall through to working tree for uncommitted local declaration edits
  }
  const diskPath = path.join(repoRoot, relPath);
  if (existsSync(diskPath)) {
    try {
      return JSON.parse(readFileSync(diskPath, 'utf8'));
    }
    catch {
      return null;
    }
  }
  return null;
}

export function resolveRepoHeadRef(repoRoot) {
  const pr = readGithubActionsPullRequestShas();
  if (pr?.headSha && gitRefExists(repoRoot, pr.headSha)) return pr.headSha;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  catch {
    return 'HEAD';
  }
}

export function resolveLinkedIssuesFromCommittedDeclarationSnapshots(
  repoRoot,
  changedFiles = [],
  options = {},
) {
  const changed = new Set((changedFiles ?? []).map((file) => String(file).replace(/\\/g, '/')));
  if (changed.size === 0) return [];

  const gitRef = options.gitRef ?? resolveRepoHeadRef(repoRoot);
  const snapshotPaths = new Set([
    ...listGitTreeDeclarationSnapshots(repoRoot, gitRef),
  ]);
  for (const file of changed) {
    if (!/^docs\/declarations\/(\d{1,6})\.[^/]+\.json$/.test(file)) {
      continue;
    }
    if (declarationSnapshotExistsAtRef(repoRoot, file, gitRef)) {
      snapshotPaths.add(file);
    }
  }

  const linked = new Set();
  for (const relPath of snapshotPaths) {
    if (!declarationSnapshotExistsAtRef(repoRoot, relPath, gitRef)) {
      continue;
    }
    const snapshot = readDeclarationSnapshotAtRef(repoRoot, relPath, gitRef, {
      preferCommittedOverDisk: true,
    });
    const issue = issueLinksFromValidatedDeclarationSnapshot(relPath, snapshot, changed);
    if (issue !== null) linked.add(issue);
  }
  return [...linked];
}

export function resolveLinkedIssueNumbersForProtectedRuntime(repoRoot, changedFiles = [], options = {}) {
  const gitRef = options.gitRef ?? resolveRepoHeadRef(repoRoot);
  // Branch/PR/env linkage plus committed declaration snapshots — not resolveLinkedIssueNumbers alone.
  return [
    ...new Set([
      ...resolveLinkedIssueNumbers(repoRoot),
      ...resolveLinkedIssuesFromDeclarationSnapshots(repoRoot, changedFiles, { gitRef }),
      ...resolveLinkedIssuesFromCommittedDeclarationSnapshots(repoRoot, changedFiles, { gitRef }),
    ]),
  ];
}

function buildCoordinatedDeclaredPathAllowSet(protectedManifest, linkedIssueNumbers) {
  const allowed = new Set();
  const linked = new Set((linkedIssueNumbers ?? []).map((issue) => Number(issue)));
  const coordinated = {
    ...BUILTIN_COORDINATED_ISSUE_DECLARED_PATH_EDITS,
    ...(protectedManifest.coordinatedIssueDeclaredPathEdits ?? {}),
  };
  for (const [issue, paths] of Object.entries(coordinated)) {
    if (!linked.has(Number(issue))) continue;
    for (const path of paths ?? []) {
      allowed.add(String(path).replace(/\\/g, '/'));
    }
  }
  return allowed;
}

function hydrateGithubPullRequestRefs(repoRoot) {
  const pr = readGithubActionsPullRequestShas();
  if (!pr) return null;
  if (!hasOriginRemote(repoRoot)) return null;
  for (const sha of [pr.baseSha, pr.headSha]) {
    if (gitRefExists(repoRoot, sha)) continue;
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', sha], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    if (!gitRefExists(repoRoot, sha)) {
      throw new Error(`failed to fetch pull_request ref ${sha}`);
    }
  }
  return pr;
}

function hasOriginRemote(repoRoot) {
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  }
  catch {
    return false;
  }
}

export function gitRefExists(repoRoot, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${String(ref).trim()}^{commit}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  }
  catch {
    return false;
  }
}

export function resolveDiffBaseRef(repoRoot, baseRef = 'origin/main') {
  const pr = readGithubActionsPullRequestShas();
  if (pr?.baseSha && gitRefExists(repoRoot, pr.baseSha)) return pr.baseSha;
  const candidates = [
    process.env.ORCHESTRATOR_MESSAGE_REGISTRY_BASE_REF,
    process.env.GITHUB_BASE_SHA,
    process.env.PR_BASE_SHA,
    pr?.baseSha,
    baseRef,
    'origin/main',
    'main',
  ]
    .filter((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
    .map((candidate) => candidate.trim());
  const tried = [];
  for (const candidate of candidates) {
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (gitRefExists(repoRoot, candidate)) return candidate;
  }
  throw new Error(`failed to resolve diff base ref (tried: ${tried.join(', ')})`);
}

export function parseGitDiffNameOnlyOutput(output) {
  return String(output ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter((line) => isRepoRelativePathLine(line));
}

function isRepoRelativePathLine(line) {
  if (!line) return false;
  if (line.startsWith('---')) return false;
  if (/\s/.test(line)) return false;
  return /^[\w./@+-]+$/.test(line);
}

export function listChangedFiles(repoRoot, baseRef = 'origin/main') {
  const pr = hydrateGithubPullRequestRefs(repoRoot);
  if (pr) {
    try {
      const out = execFileSync('git', ['diff', '--name-only', pr.baseSha, pr.headSha], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      return parseGitDiffNameOnlyOutput(out);
    }
    catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to list changed files for pull_request ${pr.baseSha}..${pr.headSha}: ${reason}`);
    }
  }
  const resolvedBase = resolveDiffBaseRef(repoRoot, baseRef);
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${resolvedBase}...HEAD`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return parseGitDiffNameOnlyOutput(out);
  }
  catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to list changed files for ${resolvedBase}...HEAD: ${reason}`);
  }
}

export function fileExistsOnGitRef(repoRoot, gitRef, relPath) {
  try {
    execFileSync('git', ['cat-file', '-e', `${gitRef}:${String(relPath).replace(/\\/g, '/')}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  }
  catch {
    return false;
  }
}

export function checkProtectedRuntimeForRepo(repoRoot, baseRef = 'origin/main') {
  const bundle = loadRegistryBundle(repoRoot);
  let resolvedBase;
  let changedFiles;
  try {
    const pr = hydrateGithubPullRequestRefs(repoRoot);
    if (pr) {
      resolvedBase = pr.baseSha;
      changedFiles = listChangedFiles(repoRoot, baseRef);
    }
    else {
      resolvedBase = resolveDiffBaseRef(repoRoot, baseRef);
      changedFiles = listChangedFiles(repoRoot, baseRef);
    }
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, violations: [message] };
  }
  const manifestRel = 'scripts/orchestrator-message-protected-runtime.manifest.json';
  const baseManifestExists = fileExistsOnGitRef(repoRoot, resolvedBase, manifestRel);
  const headRef = resolveRepoHeadRef(repoRoot);
  const linkedIssueNumbers = resolveLinkedIssueNumbersForProtectedRuntime(repoRoot, changedFiles, {
    gitRef: headRef,
  });
  return checkProtectedRuntimeDiff(changedFiles, bundle.protectedRuntime, {
    baseManifestExists,
    linkedIssueNumbers,
  });
}

export function checkProtectedRuntimeDiff(changedFiles, protectedManifest, options = {}) {
  const toolPaths = options.toolPaths ?? protectedManifest.toolPaths;
  const baseManifestExists = options.baseManifestExists ?? true;
  const coordinatedAllow = buildCoordinatedDeclaredPathAllowSet(
    protectedManifest,
    options.linkedIssueNumbers ?? [],
  );
  const violations = [];
  const protectedSet = new Set([
    ...(protectedManifest.runtimeSendHelpers ?? []),
    ...(protectedManifest.supervisedEntrypoints ?? []),
    ...(protectedManifest.ownerImplementationBindings ?? []),
    ...(protectedManifest.prerequisiteDeclaredPaths ?? []),
  ]);
  const toolSet = new Set(toolPaths ?? []);
  for (const file of changedFiles ?? []) {
    const norm = file.replace(/\\/g, '/');
    if (norm.includes('orchestrator-message-protected-runtime.manifest.json')) {
      if (baseManifestExists) {
        violations.push(`protected matrix manifest cannot be redefined in gated diff: ${norm}`);
      }
      continue;
    }
    if (protectedSet.has(norm) && !toolSet.has(norm)) {
      if (coordinatedAllow.has(norm)) {
        continue;
      }
      violations.push(`protected runtime edit: ${norm}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

export function normalizeAuditOutput(result) {
  return JSON.stringify({
    verdict: result.verdict,
    violations: result.violations,
    overlapSummary: result.overlap?.summary ?? null,
  });
}

export function computeCallsiteHashes(repoRoot, catalogPath) {
  const catalog = readJsonFile(catalogPath);
  const updates = [];
  for (const entry of catalog.entries ?? []) {
    const cs = entry.callsite;
    if (!cs?.file || !cs?.function) continue;
    const source = readFileIfExists(cs.file, repoRoot);
    if (!source) continue;
    const body = cs.anchor === 'orchestrator-rules'
      ? extractYamlRulesSection(source, cs.function)
      : cs.anchor === 'callsite-snippet'
        ? extractAnchorSnippet(source, cs.function)
        : extractFunctionBody(source, cs.function);
    if (!body) continue;
    const hash = hashNormalizedBody(body);
    updates.push({ message_class_id: entry.message_class_id, predicateBodyHash: hash });
  }
  return updates;
}

function cli() {
  const [subcommand, repoRootArg, baseRefArg] = process.argv.slice(2);
  const repoRoot = repoRootArg ? path.resolve(repoRootArg) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baseRef = baseRefArg ?? 'origin/main';
  if (subcommand === 'audit') {
    const result = auditRegistration(repoRoot);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.verdict === 'PASS' ? 0 : 1);
  }
  if (subcommand === 'generate-map') {
    const bundle = loadRegistryBundle(repoRoot);
    const overlap = checkSemanticOverlaps(bundle.catalog, bundle.taxonomy, bundle.owners);
    process.stdout.write(generateMessageMap(bundle.catalog, overlap));
    process.exit(0);
  }
  if (subcommand === 'hash-callsites') {
    const updates = computeCallsiteHashes(repoRoot, path.join(repoRoot, 'scripts/orchestrator-message-catalog.json'));
    console.log(JSON.stringify(updates, null, 2));
    process.exit(0);
  }
  if (subcommand === 'check-protected-runtime') {
    const result = checkProtectedRuntimeForRepo(repoRoot, baseRef);
    if (!result.ok) {
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
    let changedFileCount = 0;
    try {
      changedFileCount = listChangedFiles(repoRoot, baseRef).length;
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ ok: false, violations: [message] }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ verdict: 'PASS', changedFileCount }));
    process.exit(0);
  }
  console.error('Usage: orchestrator-message-registry.mjs <audit|generate-map|hash-callsites|check-protected-runtime> [repoRoot] [baseRef]');
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  cli();
}
