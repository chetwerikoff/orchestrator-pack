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
  checkProtectedRuntimeForRepo,
  checkSemanticOverlaps,
  collectAuditRootFiles,
  detectRawSendsInSource,
  enumerateBaselineClassIds,
  generateMessageMap,
  gitRefExists,
  hashNormalizedBody,
  listChangedFiles,
  loadRegistryBundle,
  normalizeAuditOutput,
  parseGitDiffNameOnlyOutput,
  recipientKeysOverlap,
  readGithubActionsPullRequestShas,
  resolveDiffBaseRef,
  resolveLinkedIssueNumbers,
  resolveLinkedIssuesFromDeclarationSnapshots,
  resolveLinkedIssuesFromCommittedDeclarationSnapshots,
  resolveLinkedIssueNumbersForProtectedRuntime,
  validateCatalog,
  validateOverlapOverride,
  validateOwnerReference,
} from '../docs/orchestrator-message-registry.mjs';
import { seedMinimalRegistryTree } from './_test-registry-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'scripts/fixtures/orchestrator-message-registry');
const checkScript = path.join(repoRoot, 'scripts/check-orchestrator-message-registry.ps1');

function removeTempDir(dir: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
      if (code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') {
        continue;
      }
      throw err;
    }
  }
  execFileSync('rm', ['-rf', dir], { stdio: 'ignore' });
}

function writeJson(root: string, rel: string, value: unknown) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
}

const gitFixtureEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function initRegistryGitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-git-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  seedMinimalRegistryTree(root);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: root, env: gitFixtureEnv });
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(root, 'registry-fixture-change.txt'), 'head\n');
  execFileSync('git', ['add', 'registry-fixture-change.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'head'], { cwd: root, env: gitFixtureEnv });
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, baseSha, headSha };
}

function subprocessEnvWithoutGithubActions() {
  const env = { ...process.env };
  delete env.GITHUB_EVENT_PATH;
  delete env.GITHUB_BASE_SHA;
  delete env.PR_BASE_SHA;
  delete env.ORCHESTRATOR_MESSAGE_REGISTRY_BASE_REF;
  return env;
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
      removeTempDir(tmp);
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
      removeTempDir(tmp);
    }
  });

  it('fails audit when ao review send is invoked directly without splat args', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-'));
    try {
      seedMinimalRegistryTree(tmp);
      const badScript = "function Invoke-BadReviewSender {\n  & ao review send run-abc\n}";
      writeJson(tmp, 'scripts/orchestrator-message-audit-roots.manifest.json', {
        schemaVersion: 1,
        supervisedProcessScripts: ['scripts/bad-review-sender.ps1'],
        supervisorEntrypoints: [],
        ciInvokedScripts: [],
        commandEntrypoints: [],
        orchestratorRulesBindings: [],
      });
      fs.writeFileSync(path.join(tmp, 'scripts/bad-review-sender.ps1'), badScript);
      const result = auditRegistration(tmp);
      expect(result.verdict).toBe('FAIL');
      expect(result.violations.some((v: string) => v.includes('raw send outside helper'))).toBe(true);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('fails audit when ao review send is invoked directly without the call operator', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-'));
    try {
      seedMinimalRegistryTree(tmp);
      const badScript = "function Invoke-BadReviewSender {\n  ao review send run-abc\n}";
      writeJson(tmp, 'scripts/orchestrator-message-audit-roots.manifest.json', {
        schemaVersion: 1,
        supervisedProcessScripts: ['scripts/bad-review-sender.ps1'],
        supervisorEntrypoints: [],
        ciInvokedScripts: [],
        commandEntrypoints: [],
        orchestratorRulesBindings: [],
      });
      fs.writeFileSync(path.join(tmp, 'scripts/bad-review-sender.ps1'), badScript);
      const result = auditRegistration(tmp);
      expect(result.verdict).toBe('FAIL');
      expect(result.violations.some((v: string) => v.includes('raw send outside helper'))).toBe(true);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('fails audit when ao send is invoked directly without the call operator', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-'));
    try {
      seedMinimalRegistryTree(tmp);
      const badScript = "function Invoke-BadSender {\n  ao send worker-1 'hello'\n}";
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
      removeTempDir(tmp);
    }
  });

  it('does not flag ao send mentions inside strings or comments', () => {
    const helpers = { helpers: [] };
    const source = 'throw "ao send failed"\n# never ao send directly\nWrite-Log "dry-run: ao send user"';
    const findings = detectRawSendsInSource('scripts/ok.ps1', source, helpers, []);
    expect(findings.filter((f: { kind: string }) => f.kind === 'raw_send_outside_helper')).toHaveLength(0);
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

  it('validates semantic owner coverage using semantic_dedup_owner field name', () => {
    const owners = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-owner-mechanisms.manifest.json'), 'utf8'));
    const entry = {
      message_class_id: 'orphan-class-not-in-default-coverage',
      semantic_dedup_owner: 'issue-283',
    };
    const violations = validateOwnerReference('semantic', owners, entry.semantic_dedup_owner, entry, repoRoot);
    expect(violations.some((v: string) => v.includes('scope does not cover orphan-class-not-in-default-coverage'))).toBe(true);
  });

  it('resolves semantic owner claim fields against repoRoot', () => {
    const bundle = loadRegistryBundle(repoRoot) as {
      catalog: { entries: Array<Record<string, unknown>> };
      owners: Record<string, unknown>;
    };
    const entry = bundle.catalog.entries.find((e) => e.semantic_dedup_owner === 'issue-283');
    expect(entry).toBeTruthy();
    expect(validateOwnerReference('semantic', bundle.owners, 'issue-283', entry!, repoRoot)).toEqual([]);
    const missing = validateOwnerReference('semantic', bundle.owners, 'issue-283', entry!, '/tmp/missing-repo-root');
    expect(missing.some((v: string) => v.includes('implementation file missing'))).toBe(true);
  });

  it('includes registered helper files in raw-send audit scan roots', () => {
    const bundle = loadRegistryBundle(repoRoot) as {
      auditRoots: Record<string, unknown>;
      helpers: Record<string, unknown>;
    };
    const roots = collectAuditRootFiles(repoRoot, bundle.auditRoots, bundle.helpers);
    expect(roots).toContain('scripts/orchestrator-wake-common.ps1');
    expect(roots).toContain('scripts/lib/Submit-WorkerInputDraft.ps1');
  });

  it('audits registered helper files for raw sends outside helper bodies', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-'));
    try {
      seedMinimalRegistryTree(tmp);
      writeJson(tmp, 'scripts/orchestrator-message-audit-roots.manifest.json', {
        schemaVersion: 1,
        supervisedProcessScripts: [],
        supervisorEntrypoints: [],
        ciInvokedScripts: [],
        commandEntrypoints: [],
        orchestratorRulesBindings: [],
      });
      const wakeCommon = fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-wake-common.ps1'), 'utf8');
      fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'scripts/orchestrator-wake-common.ps1'), `${wakeCommon}\n& ao send worker-1 "rogue"\n`);
      const result = auditRegistration(tmp);
      expect(result.verdict).toBe('FAIL');
      expect(result.violations.some((v: string) => v.includes('scripts/orchestrator-wake-common.ps1'))).toBe(true);
    } finally {
      removeTempDir(tmp);
    }
  });

  it('fails closed on Invoke-Expression send wrappers', () => {
    const helpers = { helpers: [] };
    const source = 'Invoke-Expression "& ao send worker hi"';
    const findings = detectRawSendsInSource('scripts/evil.ps1', source, helpers, []);
    expect(findings.some((f: { kind: string }) => f.kind === 'unanalyzable')).toBe(true);
  });

  it('detects uncatalogued tmux draft-submit outside helper', () => {
    const helpers = { helpers: [{ name: 'Invoke-WorkerInputDraftSubmit', file: 'scripts/lib/Submit-WorkerInputDraft.ps1', mechanisms: ['draft-submit'], relatedFunctions: ['Invoke-TmuxSubmitEnter'] }] };
    const source = 'tmux send-keys -t worker Enter';
    const findings = detectRawSendsInSource('scripts/bad-submit.ps1', source, helpers, []);
    expect(findings.some((f: { kind: string; mechanism?: string }) => f.kind === 'raw_send_outside_helper' && f.mechanism === 'tmux-submit')).toBe(true);
  });

  it('flags Invoke-WorkerInputDraftSubmit outside registered helper bodies', () => {
    const helpers = { helpers: [{ name: 'Invoke-WorkerInputDraftSubmit', file: 'scripts/lib/Submit-WorkerInputDraft.ps1', mechanisms: ['draft-submit'], relatedFunctions: ['Invoke-TmuxSubmitEnter'] }] };
    const source = 'Invoke-WorkerInputDraftSubmit -SessionId worker-1 -ExpectedSessionId worker-1';
    const findings = detectRawSendsInSource('scripts/bad-caller.ps1', source, helpers, []);
    expect(findings.some((f: { kind: string; mechanism?: string }) => f.kind === 'raw_send_outside_helper' && f.mechanism === 'draft-submit')).toBe(true);
  });

  it('rejects raw sends inside helpers that do not own the matched mechanism', () => {
    const helpers = { helpers: [{ name: 'Invoke-WorkerInputDraftSubmit', file: 'scripts/lib/Submit-WorkerInputDraft.ps1', mechanisms: ['draft-submit'], relatedFunctions: ['Invoke-TmuxSubmitEnter'] }] };
    const source = 'function Invoke-WorkerInputDraftSubmit {\n  & ao send worker-1 "hello"\n}';
    const findings = detectRawSendsInSource('scripts/lib/Submit-WorkerInputDraft.ps1', source, helpers, []);
    expect(findings.some((f: { kind: string; mechanism?: string }) => f.kind === 'raw_send_outside_helper' && f.mechanism === 'ao-send')).toBe(true);
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

  it('allows introducing the protected matrix manifest when it is absent on the base ref', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-protected-runtime.manifest.json'), 'utf8'));
    const result = checkProtectedRuntimeDiff(
      ['scripts/orchestrator-message-protected-runtime.manifest.json'],
      manifest,
      { baseManifestExists: false },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects catalog entries that omit predicateBodyHash', () => {
    const bundle = loadRegistryBundle(repoRoot) as { catalog: { entries: Array<Record<string, unknown>> } };
    const broken = structuredClone(bundle.catalog) as { entries: Array<Record<string, unknown>> };
    delete (broken.entries[0] as { callsite: { predicateBodyHash?: string } }).callsite.predicateBodyHash;
    const violations = validateCatalog({ ...bundle, catalog: broken }, repoRoot);
    expect(violations.ok).toBe(false);
    expect(violations.violations.some((v: string) => v.includes('missing callsite.predicateBodyHash'))).toBe(true);
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

  it('keeps protected-runtime check green on the real tree without branch/env issue context', () => {
    // Warm-fetch PR refs while the real GitHub event (if any) is still available.
    listChangedFiles(repoRoot, 'origin/main');
    const pr = readGithubActionsPullRequestShas();
    const prevEvent = process.env.GITHUB_EVENT_PATH;
    const prevLinked = process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
    let scrubbedEventPath: string | undefined;
    if (pr) {
      scrubbedEventPath = path.join(os.tmpdir(), `registry-no-issue-${Date.now()}.json`);
      fs.writeFileSync(
        scrubbedEventPath,
        JSON.stringify({
          pull_request: {
            base: { sha: pr.baseSha },
            head: { sha: pr.headSha, ref: 'session/registry-no-issue' },
            title: 'registry protected-runtime regression',
            body: '',
          },
        }),
      );
      process.env.GITHUB_EVENT_PATH = scrubbedEventPath;
    }
    else {
      delete process.env.GITHUB_EVENT_PATH;
    }
    delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
    const cleanEnv = {
      ...process.env,
      ORCHESTRATOR_MESSAGE_LINKED_ISSUES: undefined,
      ...(scrubbedEventPath ? { GITHUB_EVENT_PATH: scrubbedEventPath } : { GITHUB_EVENT_PATH: undefined }),
    };
    try {
      if (scrubbedEventPath) {
        expect(resolveLinkedIssueNumbers(repoRoot)).toEqual([]);
      }
      const changed = listChangedFiles(repoRoot, 'origin/main');
      const linkedFromDeclarations = resolveLinkedIssuesFromCommittedDeclarationSnapshots(
        repoRoot,
        changed,
      );
      const protectedRuntimeEdits = changed.filter((file) => {
        const norm = file.replace(/\\/g, '/');
        return (
          norm === 'scripts/ci-green-wake-reconcile.ps1'
          || norm === 'scripts/review-trigger-reconcile.ps1'
          || norm === 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1'
          || norm === 'agent-orchestrator.yaml.example'
        );
      });
      if (protectedRuntimeEdits.length > 0) {
        expect(linkedFromDeclarations.length).toBeGreaterThan(0);
        expect(resolveLinkedIssueNumbersForProtectedRuntime(repoRoot, changed)).toEqual(
          expect.arrayContaining(linkedFromDeclarations),
        );
      }
      expect(checkProtectedRuntimeForRepo(repoRoot, 'origin/main').ok).toBe(true);
      execFileSync('pwsh', ['-NoProfile', '-File', checkScript, repoRoot], {
        stdio: 'pipe',
        env: cleanEnv,
      });
    } finally {
      if (prevEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = prevEvent;
      if (prevLinked === undefined) delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
      else process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES = prevLinked;
      if (scrubbedEventPath && fs.existsSync(scrubbedEventPath)) fs.unlinkSync(scrubbedEventPath);
    }
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

  it('does not infer issue 324 from SideProcessSupervisor-only protected runtime edits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-324-supervisor-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
      seedMinimalRegistryTree(root, ['scripts/lib/Orchestrator-SideProcessSupervisor.ps1']);
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: root, env: gitFixtureEnv });
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const supervisorPath = path.join(root, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
      fs.writeFileSync(supervisorPath, `${fs.readFileSync(supervisorPath, 'utf8')}\n# coordinated edit fixture\n`);
      execFileSync('git', ['add', 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'supervisor-only'], { cwd: root, env: gitFixtureEnv });
      const prevBase = process.env.GITHUB_BASE_SHA;
      const prevEvent = process.env.GITHUB_EVENT_PATH;
      delete process.env.GITHUB_EVENT_PATH;
      process.env.GITHUB_BASE_SHA = baseSha;
      try {
        const result = checkProtectedRuntimeForRepo(root, baseSha);
        expect(result.ok).toBe(false);
        expect(result.violations.some((v: string) => v.includes('Orchestrator-SideProcessSupervisor.ps1'))).toBe(true);
      } finally {
        if (prevBase === undefined) delete process.env.GITHUB_BASE_SHA;
        else process.env.GITHUB_BASE_SHA = prevBase;
        if (prevEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
        else process.env.GITHUB_EVENT_PATH = prevEvent;
      }
    } finally {
      removeTempDir(root);
    }
  });

  it('does not infer issue 324 from yaml.example-only protected runtime edits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-324-yaml-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
      seedMinimalRegistryTree(root, ['agent-orchestrator.yaml.example']);
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: root, env: gitFixtureEnv });
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const yamlPath = path.join(root, 'agent-orchestrator.yaml.example');
      fs.writeFileSync(yamlPath, `${fs.readFileSync(yamlPath, 'utf8')}\n# coordinated edit fixture\n`);
      execFileSync('git', ['add', 'agent-orchestrator.yaml.example'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'yaml-only'], { cwd: root, env: gitFixtureEnv });
      const prevBase = process.env.GITHUB_BASE_SHA;
      const prevEvent = process.env.GITHUB_EVENT_PATH;
      const prevLinked = process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
      delete process.env.GITHUB_EVENT_PATH;
      delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
      process.env.GITHUB_BASE_SHA = baseSha;
      try {
        const result = checkProtectedRuntimeForRepo(root, baseSha);
        expect(result.ok).toBe(false);
        expect(result.violations.some((v: string) => v.includes('agent-orchestrator.yaml.example'))).toBe(true);
      } finally {
        if (prevBase === undefined) delete process.env.GITHUB_BASE_SHA;
        else process.env.GITHUB_BASE_SHA = prevBase;
        if (prevEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
        else process.env.GITHUB_EVENT_PATH = prevEvent;
        if (prevLinked === undefined) delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
        else process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES = prevLinked;
      }
    } finally {
      removeTempDir(root);
    }
  });

  it('allows SideProcessSupervisor edits when issue 324 is explicitly linked', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-message-protected-runtime.manifest.json'), 'utf8'),
    );
    const denied = checkProtectedRuntimeDiff(['scripts/lib/Orchestrator-SideProcessSupervisor.ps1'], manifest);
    expect(denied.ok).toBe(false);
    const allowed = checkProtectedRuntimeDiff(['scripts/lib/Orchestrator-SideProcessSupervisor.ps1'], manifest, {
      linkedIssueNumbers: [324],
    });
    expect(allowed.ok).toBe(true);
  });

  it('links issue numbers from validated declaration snapshots in the gated diff', () => {
    expect(
      resolveLinkedIssuesFromDeclarationSnapshots(repoRoot, [
        'docs/declarations/324.opk-2.json',
        'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
      ]),
    ).toEqual([324]);
    expect(
      resolveLinkedIssuesFromDeclarationSnapshots(repoRoot, ['agent-orchestrator.yaml.example']),
    ).toEqual([]);
  });

  it('does not link issue numbers from malformed declaration snapshots in the gated diff', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-324-decl-fake-'));
    try {
      seedMinimalRegistryTree(root, ['scripts/lib/Orchestrator-SideProcessSupervisor.ps1']);
      fs.mkdirSync(path.join(root, 'docs/declarations'), { recursive: true });
      fs.writeFileSync(path.join(root, 'docs/declarations/324.fake.json'), '{}\n');
      expect(
        resolveLinkedIssuesFromDeclarationSnapshots(root, [
          'docs/declarations/324.fake.json',
          'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
        ]),
      ).toEqual([]);
      fs.writeFileSync(path.join(root, 'docs/declarations/324.fake.json'), 'not-json\n');
      expect(
        resolveLinkedIssuesFromDeclarationSnapshots(root, [
          'docs/declarations/324.fake.json',
          'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
        ]),
      ).toEqual([]);
      writeJson(root, 'docs/declarations/324.fake.json', {
        issue_number: 324,
        iteration_id: 'fake',
        declared_paths: [],
      });
      expect(
        resolveLinkedIssuesFromDeclarationSnapshots(root, [
          'docs/declarations/324.fake.json',
          'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
        ]),
      ).toEqual([]);
      writeJson(root, 'docs/declarations/324.fake.json', {
        issue_number: 324,
        iteration_id: 'fake',
        declared_paths: ['scripts/ci-green-wake-reconcile.ps1'],
      });
      expect(
        resolveLinkedIssuesFromDeclarationSnapshots(root, [
          'docs/declarations/324.fake.json',
          'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
        ]),
      ).toEqual([]);
    } finally {
      removeTempDir(root);
    }
  });

  it('does not link worktree-only declaration snapshots via committed resolver', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-324-decl-disk-'));
    try {
      writeJson(root, 'docs/declarations/324.opk-2.json', {
        issue_number: 324,
        iteration_id: 'opk-2',
        declared_paths: [
          'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
          'agent-orchestrator.yaml.example',
        ],
      });
      expect(
        resolveLinkedIssuesFromCommittedDeclarationSnapshots(root, [
          'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
        ]),
      ).toEqual([]);
      expect(
        resolveLinkedIssuesFromCommittedDeclarationSnapshots(root, ['agent-orchestrator.yaml.example']),
      ).toEqual([]);
      expect(
        resolveLinkedIssuesFromCommittedDeclarationSnapshots(root, ['scripts/ci-green-wake-reconcile.ps1']),
      ).toEqual([]);
      expect(
        resolveLinkedIssuesFromDeclarationSnapshots(root, [
          'docs/declarations/324.opk-2.json',
          'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
        ]),
      ).toEqual([324]);
    } finally {
      removeTempDir(root);
    }
  });

  it('prefers committed declaration snapshots from git HEAD over stale on-disk copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-324-stale-disk-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
      seedMinimalRegistryTree(root, ['scripts/lib/Orchestrator-SideProcessSupervisor.ps1']);
      writeJson(root, 'docs/declarations/324.opk-2.json', {
        issue_number: 324,
        iteration_id: 'opk-2',
        declared_paths: ['scripts/lib/Orchestrator-SideProcessSupervisor.ps1'],
      });
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'committed declaration'], { cwd: root, env: gitFixtureEnv });
      writeJson(root, 'docs/declarations/324.opk-2.json', {
        issue_number: 324,
        iteration_id: 'opk-2',
        declared_paths: ['scripts/ci-green-wake-reconcile.ps1'],
      });
      expect(
        resolveLinkedIssuesFromCommittedDeclarationSnapshots(root, [
          'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
        ]),
      ).toEqual([324]);
    } finally {
      removeTempDir(root);
    }
  });

  it('ignores worktree-only declaration snapshots in committed resolver', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-324-decl-worktree-only-'));
    const prevEvent = process.env.GITHUB_EVENT_PATH;
    const prevLinked = process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
    delete process.env.GITHUB_EVENT_PATH;
    delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
      seedMinimalRegistryTree(root, ['scripts/lib/Orchestrator-SideProcessSupervisor.ps1']);
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: root, env: gitFixtureEnv });
      writeJson(root, 'docs/declarations/324.opk-2.json', {
        issue_number: 324,
        iteration_id: 'opk-2',
        declared_paths: ['scripts/lib/Orchestrator-SideProcessSupervisor.ps1'],
      });
      const supervisorPath = path.join(root, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
      fs.writeFileSync(supervisorPath, `${fs.readFileSync(supervisorPath, 'utf8')}\n# coordinated edit fixture\n`);
      execFileSync('git', ['add', 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'supervisor-only'], { cwd: root, env: gitFixtureEnv });
      expect(
        resolveLinkedIssuesFromCommittedDeclarationSnapshots(root, [
          'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
        ]),
      ).toEqual([]);
      const result = checkProtectedRuntimeForRepo(root, execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: root, encoding: 'utf8' }).trim());
      expect(result.ok).toBe(false);
      expect(result.violations.some((v: string) => v.includes('Orchestrator-SideProcessSupervisor.ps1'))).toBe(true);
    } finally {
      if (prevEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = prevEvent;
      if (prevLinked === undefined) delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
      else process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES = prevLinked;
      removeTempDir(root);
    }
  });

  it('links issue numbers from declaration snapshots present only in git HEAD', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-324-decl-git-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
      seedMinimalRegistryTree(root, ['agent-orchestrator.yaml.example']);
      writeJson(root, 'docs/declarations/324.opk-2.json', {
        issue_number: 324,
        iteration_id: 'opk-2',
        declared_paths: ['agent-orchestrator.yaml.example'],
      });
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: root, env: gitFixtureEnv });
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const yamlPath = path.join(root, 'agent-orchestrator.yaml.example');
      fs.writeFileSync(yamlPath, `${fs.readFileSync(yamlPath, 'utf8')}\n# coordinated edit fixture\n`);
      execFileSync('git', ['add', 'agent-orchestrator.yaml.example'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'yaml-only'], { cwd: root, env: gitFixtureEnv });
      fs.unlinkSync(path.join(root, 'docs/declarations/324.opk-2.json'));
      const prevBase = process.env.GITHUB_BASE_SHA;
      const prevEvent = process.env.GITHUB_EVENT_PATH;
      const prevLinked = process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
      delete process.env.GITHUB_EVENT_PATH;
      delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
      process.env.GITHUB_BASE_SHA = baseSha;
      try {
        const changed = listChangedFiles(root, baseSha);
        expect(changed).toEqual(['agent-orchestrator.yaml.example']);
        expect(
          resolveLinkedIssuesFromCommittedDeclarationSnapshots(root, changed, {
            gitRef: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
          }),
        ).toEqual([324]);
        const result = checkProtectedRuntimeForRepo(root, baseSha);
        expect(result.ok).toBe(true);
      } finally {
        if (prevBase === undefined) delete process.env.GITHUB_BASE_SHA;
        else process.env.GITHUB_BASE_SHA = prevBase;
        if (prevEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
        else process.env.GITHUB_EVENT_PATH = prevEvent;
        if (prevLinked === undefined) delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
        else process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES = prevLinked;
      }
    } finally {
      removeTempDir(root);
    }
  });

  it('allows coordinated protected-runtime edits when declaration snapshot is committed but not in diff', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-324-decl-split-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
      seedMinimalRegistryTree(root, ['scripts/lib/Orchestrator-SideProcessSupervisor.ps1']);
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: root, env: gitFixtureEnv });
      writeJson(root, 'docs/declarations/324.opk-2.json', {
        issue_number: 324,
        iteration_id: 'opk-2',
        declared_paths: ['scripts/lib/Orchestrator-SideProcessSupervisor.ps1'],
      });
      execFileSync('git', ['add', 'docs/declarations/324.opk-2.json'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'add declaration'], { cwd: root, env: gitFixtureEnv });
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const supervisorPath = path.join(root, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
      fs.writeFileSync(supervisorPath, `${fs.readFileSync(supervisorPath, 'utf8')}\n# coordinated edit fixture\n`);
      execFileSync('git', ['add', 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'supervisor-only follow-up'], { cwd: root, env: gitFixtureEnv });
      const prevBase = process.env.GITHUB_BASE_SHA;
      const prevEvent = process.env.GITHUB_EVENT_PATH;
      const prevLinked = process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
      delete process.env.GITHUB_EVENT_PATH;
      delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
      process.env.GITHUB_BASE_SHA = baseSha;
      try {
        const changed = listChangedFiles(root, baseSha);
        expect(changed).toEqual(['scripts/lib/Orchestrator-SideProcessSupervisor.ps1']);
        const result = checkProtectedRuntimeForRepo(root, baseSha);
        expect(result.ok).toBe(true);
      } finally {
        if (prevBase === undefined) delete process.env.GITHUB_BASE_SHA;
        else process.env.GITHUB_BASE_SHA = prevBase;
        if (prevEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
        else process.env.GITHUB_EVENT_PATH = prevEvent;
        if (prevLinked === undefined) delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
        else process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES = prevLinked;
      }
    } finally {
      removeTempDir(root);
    }
  });

  it('allows coordinated protected-runtime edits when declaration snapshot is in diff', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-324-decl-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
      seedMinimalRegistryTree(root, ['scripts/lib/Orchestrator-SideProcessSupervisor.ps1']);
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: root, env: gitFixtureEnv });
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      writeJson(root, 'docs/declarations/324.opk-2.json', {
        issue_number: 324,
        iteration_id: 'opk-2',
        declared_paths: ['scripts/lib/Orchestrator-SideProcessSupervisor.ps1'],
      });
      const supervisorPath = path.join(root, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
      fs.writeFileSync(supervisorPath, `${fs.readFileSync(supervisorPath, 'utf8')}\n# coordinated edit fixture\n`);
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'declared coordinated edit'], { cwd: root, env: gitFixtureEnv });
      const prevBase = process.env.GITHUB_BASE_SHA;
      const prevEvent = process.env.GITHUB_EVENT_PATH;
      const prevLinked = process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
      delete process.env.GITHUB_EVENT_PATH;
      delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
      process.env.GITHUB_BASE_SHA = baseSha;
      try {
        const result = checkProtectedRuntimeForRepo(root, baseSha);
        expect(result.ok).toBe(true);
      } finally {
        if (prevBase === undefined) delete process.env.GITHUB_BASE_SHA;
        else process.env.GITHUB_BASE_SHA = prevBase;
        if (prevEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
        else process.env.GITHUB_EVENT_PATH = prevEvent;
        if (prevLinked === undefined) delete process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES;
        else process.env.ORCHESTRATOR_MESSAGE_LINKED_ISSUES = prevLinked;
      }
    } finally {
      removeTempDir(root);
    }
  });

  it('cli check-protected-runtime honors baseRef as the fourth argument', () => {
    const { root, baseSha } = initRegistryGitFixture();
    try {
      const registryCli = path.join(repoRoot, 'docs/orchestrator-message-registry.mjs');
      const explicit = JSON.parse(
        execFileSync('node', [registryCli, 'check-protected-runtime', root, baseSha], {
          encoding: 'utf8',
          env: subprocessEnvWithoutGithubActions(),
        }),
      );
      expect(explicit.verdict).toBe('PASS');
      expect(gitRefExists(root, baseSha)).toBe(true);
      expect(explicit.changedFileCount).toBeGreaterThan(0);
    } finally {
      removeTempDir(root);
    }
  });

  it('prefers GITHUB_BASE_SHA when resolving diff base ref', () => {
    const { root, baseSha } = initRegistryGitFixture();
    const prev = process.env.GITHUB_BASE_SHA;
    const prevEvent = process.env.GITHUB_EVENT_PATH;
    delete process.env.GITHUB_EVENT_PATH;
    process.env.GITHUB_BASE_SHA = baseSha;
    try {
      expect(resolveDiffBaseRef(root, 'origin/main')).toBe(baseSha);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_BASE_SHA;
      else process.env.GITHUB_BASE_SHA = prev;
      if (prevEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = prevEvent;
      removeTempDir(root);
    }
  });

  it('filters RTK git shim trailers from diff name-only output', () => {
    expect(parseGitDiffNameOnlyOutput('registry-fixture-change.txt\n--- Changes ---\n')).toEqual([
      'registry-fixture-change.txt',
    ]);
    expect(parseGitDiffNameOnlyOutput('docs/foo.mjs\nscripts/bar.ps1\n')).toEqual([
      'docs/foo.mjs',
      'scripts/bar.ps1',
    ]);
  });

  it('lists changed files from pull_request base and head shas in Actions', () => {
    const { root, baseSha, headSha } = initRegistryGitFixture();
    const eventPath = path.join(os.tmpdir(), `github-event-${Date.now()}.json`);
    fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: baseSha }, head: { sha: headSha } } }));
    const prev = process.env.GITHUB_EVENT_PATH;
    process.env.GITHUB_EVENT_PATH = eventPath;
    try {
      const files = listChangedFiles(root, 'origin/main');
      expect(files).toEqual(['registry-fixture-change.txt']);
      expect(checkProtectedRuntimeForRepo(root, 'origin/main').ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = prev;
      fs.rmSync(eventPath, { force: true });
      removeTempDir(root);
    }
  });

  it('fails protected-runtime check when git diff base ref cannot be resolved', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-registry-git-'));
    try {
      execFileSync('git', ['init'], { cwd: tmp });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], {
        cwd: tmp,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      });
      expect(() => resolveDiffBaseRef(tmp, 'origin/main')).toThrow(/failed to resolve diff base ref/);
    } finally {
      removeTempDir(tmp);
    }
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
