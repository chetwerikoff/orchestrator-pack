import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertSupportedHost,
  auditRegistration,
  checkProtectedRuntimeDiff,
  checkSemanticOverlaps,
  detectRawSendsInSource,
  enumerateBaselineClassIds,
  generateMessageMap,
  hashNormalizedBody,
  loadRegistryBundle,
  normalizeAuditOutput,
  recipientKeysOverlap,
  validateCatalog,
  validateOverlapOverride,
} from '../docs/orchestrator-message-registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'scripts/fixtures/orchestrator-message-registry');
const checkScript = path.join(repoRoot, 'scripts/check-orchestrator-message-registry.ps1');

function writeJson(root: string, rel: string, value: unknown) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
}

function copyTree(srcRel: string, destRoot: string) {
  const src = path.join(repoRoot, srcRel);
  const dest = path.join(destRoot, srcRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function seedMinimalRegistryTree(root: string) {
  for (const rel of [
    'scripts/orchestrator-message-taxonomy.json',
    'scripts/orchestrator-message-owner-mechanisms.manifest.json',
    'scripts/orchestrator-message-send-helpers.manifest.json',
    'scripts/orchestrator-message-audit-roots.manifest.json',
    'scripts/orchestrator-message-protected-runtime.manifest.json',
    'scripts/orchestrator-message-allowlist.json',
    'scripts/orchestrator-side-process-registry.json',
    'scripts/orchestrator-message-catalog.json',
    'docs/orchestrator-message-registry.mjs',
  ]) {
    copyTree(rel, root);
  }
}

describe('orchestrator message registry (Issue #298)', () => {
  it('passes registration audit on the real pack tree', () => {
    const result = auditRegistration(repoRoot);
    expect(result.verdict).toBe('PASS');
    expect(result.violations).toEqual([]);
  });

  it('enumerates baseline classes independently of catalog authorship', () => {
    const baseline = enumerateBaselineClassIds();
    const bundle = loadRegistryBundle(repoRoot) as {
      catalog: { entries: Array<{ message_class_id: string }> };
    };
    for (const id of baseline) {
      expect(bundle.catalog.entries.some((e) => e.message_class_id === id)).toBe(true);
    }
  });

  it('fails audit when a declared audit root file is missing on disk', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-'));
    try {
      seedMinimalRegistryTree(tmp);
      const auditRoots = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-audit-roots.manifest.json'), 'utf8'),
      );
      auditRoots.ciInvokedScripts = ['scripts/this-ci-script-does-not-exist.ps1'];
      writeJson(tmp, 'scripts/orchestrator-message-audit-roots.manifest.json', auditRoots);
      const result = auditRegistration(tmp);
      expect(result.verdict).toBe('FAIL');
      expect(result.violations.some((v: string) => v.includes('audit root file missing: scripts/this-ci-script-does-not-exist.ps1'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails audit when a seeded raw ao send is outside helpers', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-'));
    try {
      seedMinimalRegistryTree(tmp);
      const badScript = `function Invoke-BadSender { & ao send worker-1 "hello" }`;
      writeJson(tmp, 'scripts/orchestrator-message-audit-roots.manifest.json', {
        schemaVersion: 1,
        supervisedProcessScripts: ['scripts/bad-sender.ps1'],
        supervisorEntrypoints: [],
        ciInvokedScripts: [],
        commandEntrypoints: [],
        orchestratorRulesBindings: [],
      });
      fs.writeFileSync(path.join(tmp, 'scripts/bad-sender.ps1'), badScript);
      const result = auditRegistration(tmp);
      expect(result.verdict).toBe('FAIL');
      expect(result.violations.some((v: string) => v.includes('raw send outside helper'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('flags cross-abstraction recipient overlap without semantic owner', () => {
    const catalog = {
      entries: [
        {
          message_class_id: 'head-worker',
          recipient_key: 'head-owning-worker',
          intent_key: 'ci-failure-fix',
          semantic_dedup_owner: 'none',
          delivery_idempotency_owner: 'none',
        },
        {
          message_class_id: 'specific-session',
          recipient_key: 'specific-session',
          intent_key: 'ci-failure-fix',
          semantic_dedup_owner: 'none',
          delivery_idempotency_owner: 'issue-281',
        },
      ],
    };
    const taxonomy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-taxonomy.json'), 'utf8'));
    const owners = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-owner-mechanisms.manifest.json'), 'utf8'));
    const overlap = checkSemanticOverlaps(catalog, taxonomy, owners);
    expect(overlap.ok).toBe(false);
    expect(overlap.flagged.length).toBeGreaterThan(0);
  });

  it('does not clear overlap with delivery idempotency alone', () => {
    const catalog = {
      entries: [
        {
          message_class_id: 'a',
          recipient_key: 'specific-session',
          intent_key: 'ci-failure-fix',
          semantic_dedup_owner: 'none',
          delivery_idempotency_owner: 'issue-281',
        },
        {
          message_class_id: 'b',
          recipient_key: 'specific-session',
          intent_key: 'red-status',
          semantic_dedup_owner: 'none',
          delivery_idempotency_owner: 'none',
        },
      ],
    };
    const taxonomy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-taxonomy.json'), 'utf8'));
    const owners = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-owner-mechanisms.manifest.json'), 'utf8'));
    const overlap = checkSemanticOverlaps(catalog, taxonomy, owners);
    expect(overlap.ok).toBe(false);
  });

  it('rejects overlap overrides missing evidence fields', () => {
    expect(validateOverlapOverride({ id: 'x' })).not.toEqual([]);
  });

  it('fails closed on Invoke-Expression send wrappers', () => {
    const helpers = { helpers: [] };
    const source = 'Invoke-Expression "& ao send worker hi"';
    const findings = detectRawSendsInSource('scripts/evil.ps1', source, helpers, []);
    expect(findings.some((f: { kind: string }) => f.kind === 'unanalyzable')).toBe(true);
  });

  it('detects uncatalogued tmux draft-submit outside helper', () => {
    const helpers = { helpers: [{ name: 'Invoke-WorkerInputDraftSubmit', file: 'scripts/lib/Submit-WorkerInputDraft.ps1', mechanisms: ['draft-submit'] }] };
    const source = 'tmux send-keys -t worker Enter';
    const findings = detectRawSendsInSource('scripts/bad-submit.ps1', source, helpers, []);
    expect(findings.some((f: { kind: string; mechanism?: string }) => f.kind === 'raw_send_outside_helper' && f.mechanism === 'tmux-submit')).toBe(true);
  });

  it('generates deterministic bounded map output', () => {
    const bundle = loadRegistryBundle(repoRoot) as {
      catalog: Record<string, unknown>;
      taxonomy: Record<string, unknown>;
      owners: Record<string, unknown>;
    };
    const overlap = checkSemanticOverlaps(bundle.catalog, bundle.taxonomy, bundle.owners);
    const first = generateMessageMap(bundle.catalog, overlap);
    const second = generateMessageMap(bundle.catalog, overlap);
    expect(first).toBe(second);
    expect(first).toContain('## Per-class summary');
    expect(first).not.toMatch(/<>.*<>.*<>/);
  });

  it('fails protected-runtime diff when a runtime file is edited', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-protected-runtime.manifest.json'), 'utf8'));
    const result = checkProtectedRuntimeDiff(['scripts/ci-green-wake-reconcile.ps1'], manifest);
    expect(result.ok).toBe(false);
    const toolOk = checkProtectedRuntimeDiff(['docs/orchestrator-message-map.md'], manifest);
    expect(toolOk.ok).toBe(true);
  });

  it('rejects shrinking the protected matrix manifest in a gated diff', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-protected-runtime.manifest.json'), 'utf8'));
    const result = checkProtectedRuntimeDiff(['scripts/orchestrator-message-protected-runtime.manifest.json'], manifest);
    expect(result.ok).toBe(false);
  });

  it('catches predicate body hash drift', () => {
    const bundle = loadRegistryBundle(repoRoot) as { catalog: { entries: Array<Record<string, unknown>> } };
    const broken = structuredClone(bundle.catalog) as { entries: Array<Record<string, unknown>> };
    (broken.entries[0] as { callsite: { predicateBodyHash: string } }).callsite.predicateBodyHash = 'deadbeefdeadbeef';
    const violations = validateCatalog({ ...bundle, catalog: broken }, repoRoot);
    expect(violations.ok).toBe(false);
    expect(violations.violations.some((v: string) => v.includes('predicate body hash drift'))).toBe(true);
  });

  it('catches divergent message_class_id reuse at the same callsite', () => {
    const bundle = loadRegistryBundle(repoRoot) as { catalog: { entries: Array<Record<string, unknown>> } };
    const broken = structuredClone(bundle.catalog) as { entries: Array<Record<string, unknown>> };
    const dup = structuredClone(broken.entries[0]) as Record<string, unknown>;
    dup.message_class_id = 'duplicate-id';
    broken.entries.push(dup);
    const violations = validateCatalog({ ...bundle, catalog: broken }, repoRoot);
    expect(violations.ok).toBe(false);
    expect(violations.violations.some((v: string) => v.includes('divergent message_class_id reuse'))).toBe(true);
  });

  it('normalizes audit output identically across Node and pwsh surfaces', () => {
    const nodeResult = normalizeAuditOutput(auditRegistration(repoRoot));
    const pwshOut = execFileSync(
      'pwsh',
      ['-NoProfile', '-Command', `& node '${path.join(repoRoot, 'docs/orchestrator-message-registry.mjs')}' audit '${repoRoot}'`],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const pwshParsed = JSON.parse(pwshOut);
    const pwshNorm = normalizeAuditOutput(pwshParsed);
    expect(pwshNorm).toBe(nodeResult);
  });

  it('runs check-orchestrator-message-registry.ps1 clean on the real tree', () => {
    execFileSync('pwsh', ['-NoProfile', '-File', checkScript, repoRoot], { stdio: 'pipe' });
  });

  it('preserves newlines when regenerating the map via pwsh helper', () => {
    const tmpMap = path.join(os.tmpdir(), `orch-map-${Date.now()}.md`);
    try {
      execFileSync('pwsh', ['-NoProfile', '-File', path.join(repoRoot, 'scripts/generate-orchestrator-message-map.ps1'), repoRoot, tmpMap], { stdio: 'pipe' });
      const content = fs.readFileSync(tmpMap, 'utf8');
      expect(content.split('\n').length).toBeGreaterThan(5);
      expect(content).toContain('## Per-class summary');
    } finally {
      if (fs.existsSync(tmpMap)) fs.unlinkSync(tmpMap);
    }
  });

  it('fails protected-runtime guard when a protected runtime file is in the diff', () => {
    const result = checkProtectedRuntimeDiff(
      ['scripts/ci-green-wake-reconcile.ps1'],
      JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-protected-runtime.manifest.json'), 'utf8')),
    );
    expect(result.ok).toBe(false);
  });

  it('documents recipient alias overlap conservatively', () => {
    const taxonomy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-taxonomy.json'), 'utf8'));
    expect(recipientKeysOverlap('head-owning-worker', 'specific-session', taxonomy)).toBe(true);
  });

  it('refuses unsupported native Windows host at guard level', () => {
    const host = assertSupportedHost('win32', {});
    expect(host.ok).toBe(false);
    expect(host.error).toMatch(/unsupported host/i);
  });

  it('hashes predicate bodies deterministically', () => {
    expect(hashNormalizedBody('a   b')).toBe(hashNormalizedBody("a\nb"));
  });
});
