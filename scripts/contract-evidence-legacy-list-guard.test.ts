import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalLegacyDraftPath,
  diffLegacyPathSets,
  loadLegacyPathSet,
} from './contract-evidence-path.mjs';
import { checkContractEvidence } from './contract-evidence.mjs';
import {
  runLegacyListGuardWorkflowOrderingCheck,
  validateLegacyListGuardWorkflowOrdering,
} from './check-legacy-list-guard-workflow-ordering.mjs';
import {
  AUTHORIZATIONS_REL_PATH,
  GOVERNED_MANIFEST_REL_PATH,
  VERDICT_BINDING_ID,
  computeChangedGovernedFiles,
  evaluateLegacyListGuard,
  authorizationBaseShaMatches,
  authorizationHeadShaMatches,
  findMatchingAuthorization,
  governedSurfacePaths,
  isGuardPresentOnBase,
  loadGovernedManifest,
  validateBaseAndHeadManifestClosure,
  validateManifestClosure,
  collectEntrypointDependencyClosure,
  extractLocalModuleSpecs,
} from './contract-evidence-legacy-list-guard.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'tests/fixtures/legacy-list-guard');
const baseLegacyFixture = readFileSync(path.join(fixtureDir, 'base-legacy-list.json'), 'utf8');
const productionManifest = loadGovernedManifest(repoRoot);
const governedManifestFiles = productionManifest.files as string[];


type GuardCaseOverrides = {
  manifest?: Record<string, unknown>;
  headManifest?: Record<string, unknown>;
  baseParentSha?: string;
  changedFiles?: string[];
  nameStatus?: Array<{ path: string; status: string; previousPath?: string }>;
  baseLegacyListContent?: string | null;
  headLegacyListContent?: string | null;
  baseAuthorizations?: { authorizations: Array<Record<string, unknown>> };
  authFileChanged?: boolean;
  bootstrap?: boolean;
  baseResolvable?: boolean;
};

function legacyListWithPaths(paths: string[]) {
  return JSON.stringify({
    description: 'fixture legacy list',
    paths,
  }, null, 2);
}

function runGuardCase(overrides: GuardCaseOverrides) {
  const manifest = overrides.manifest ?? productionManifest;
  const legacyListPath = manifest.legacyListPath ?? 'scripts/contract-evidence-legacy-drafts.json';
  return evaluateLegacyListGuard({
    baseSha: 'base1111111111111111111111111111111111111111',
    headSha: 'head2222222222222222222222222222222222222222',
    changedFiles: overrides.changedFiles ?? [legacyListPath],
    nameStatus: overrides.nameStatus,
    baseLegacyListContent: overrides.baseLegacyListContent ?? baseLegacyFixture,
    headLegacyListContent: overrides.headLegacyListContent ?? baseLegacyFixture,
    baseAuthorizations: overrides.baseAuthorizations ?? { authorizations: [] },
    authFileChanged: overrides.authFileChanged,
    bootstrap: overrides.bootstrap,
    baseResolvable: overrides.baseResolvable,
    manifest,
    headManifest: overrides.headManifest,
    baseParentSha: overrides.baseParentSha,
  });
}

function initGitRepo() {
  const dir = mkdtempSync(path.join(repoRoot, '.tmp-legacy-list-guard-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'guard@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'legacy-list-guard'], { cwd: dir });
  return dir;
}

function seedGuardSurface(repoDir: string) {
  const rels = [
    'scripts/contract-evidence-path.mjs',
    'scripts/contract-evidence-legacy-list-guard.mjs',
    'scripts/contract-evidence-legacy-governed-manifest.json',
    'scripts/contract-evidence-legacy-authorizations.json',
    'scripts/run-contract-evidence-legacy-list-guard.mjs',
    'scripts/check-legacy-list-guard-workflow-ordering.mjs',
    'scripts/contract-evidence-legacy-drafts.json',
    '.github/workflows/scope-guard.yml',
  ];
  for (const rel of rels) {
    const target = path.join(repoDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(repoRoot, rel), target);
  }
  mkdirSync(path.join(repoDir, 'tests/fixtures/legacy-list-guard'), { recursive: true });
  cpSync(fixtureDir, path.join(repoDir, 'tests/fixtures/legacy-list-guard'), { recursive: true });
}

describe('legacy-list guard path canonicalizer', () => {
  it('agrees with contract-evidence consumer on byte-exact case-sensitive identity', () => {
    const listContent = legacyListWithPaths([
      'docs/issues_drafts/Foo.md',
      'tests/fixtures/draft-discipline/contract-evidence/legacy-grandfather.md',
    ]);
    const loaded = loadLegacyPathSet(listContent);
    expect(loaded.ok).toBe(true);
    expect(loaded.paths?.has('docs/issues_drafts/Foo.md')).toBe(true);
    expect(loaded.paths?.has('docs/issues_drafts/foo.md')).toBe(false);

    const markdown = readFileSync(
      path.join(repoRoot, 'tests/fixtures/draft-discipline/contract-evidence/legacy-grandfather.md'),
      'utf8',
    );
    const result = checkContractEvidence(markdown, {
      repoRoot,
      manifestPath: 'tests/fixtures/contract-evidence/capture-manifest.json',
      legacyListPath: path.join(fixtureDir, 'consumer-legacy-list.json'),
      draftPath: 'tests/fixtures/draft-discipline/contract-evidence/legacy-grandfather.md',
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(canonicalLegacyDraftPath('tests/fixtures/draft-discipline/contract-evidence/legacy-grandfather.md'))
      .toBe('tests/fixtures/draft-discipline/contract-evidence/legacy-grandfather.md');
  });

  it('rejects malformed and duplicate-equivalent entries', () => {
    const malformed = loadLegacyPathSet(legacyListWithPaths(['./docs/issues_drafts/x.md']));
    expect(malformed.ok).toBe(false);
    const duplicate = loadLegacyPathSet(legacyListWithPaths([
      'docs/issues_drafts/x.md',
      'docs/issues_drafts/x.md',
    ]));
    expect(duplicate.ok).toBe(false);
  });

  it('rejects absolute and escaping paths outside repo-relative form', () => {
    expect(canonicalLegacyDraftPath('/docs/issues_drafts/x.md')).toBeNull();
    expect(canonicalLegacyDraftPath('../docs/issues_drafts/x.md')).toBeNull();
    expect(canonicalLegacyDraftPath('docs/a/../x.md')).toBeNull();
    const escaping = loadLegacyPathSet(legacyListWithPaths(['docs/a/../x.md']));
    expect(escaping.ok).toBe(false);
    const absolute = loadLegacyPathSet(legacyListWithPaths(['/docs/issues_drafts/x.md']));
    expect(absolute.ok).toBe(false);
  });
});


describe('legacy-list guard evaluateLegacyListGuard', () => {
  it('AC1 fails unauthorized path addition with actionable message', () => {
    const verdict = runGuardCase({
      headLegacyListContent: legacyListWithPaths([
        'docs/issues_drafts/00-architecture-decisions.md',
        'docs/issues_drafts/01-ao-task-declaration-impl.md',
        'docs/issues_drafts/99-new-draft.md',
      ]),
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.expected).toBe('fail');
    expect(verdict.bindingId).toBe(VERDICT_BINDING_ID);
    expect(verdict.addedPaths).toEqual(['docs/issues_drafts/99-new-draft.md']);
    expect(verdict.reason).toMatch(/unauthorized legacy path addition/);
  });

  it('AC2 passes authorized path addition bound to base/head SHA and path set', () => {
    const added = ['docs/issues_drafts/99-new-draft.md'];
    const changedFiles = ['scripts/contract-evidence-legacy-drafts.json'];
    const verdict = runGuardCase({
      headLegacyListContent: legacyListWithPaths([
        'docs/issues_drafts/00-architecture-decisions.md',
        'docs/issues_drafts/01-ao-task-declaration-impl.md',
        ...added,
      ]),
      baseAuthorizations: {
        authorizations: [{
          id: 'auth-1',
          baseSha: 'base1111111111111111111111111111111111111111',
          headSha: 'head2222222222222222222222222222222222222222',
          addedPaths: added,
          changedGovernedFiles: changedFiles,
          source: { type: 'maintainer', id: 'admin-bootstrap' },
          reason: 'admin-authorized addition',
        }],
      },
    });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.authorization).toEqual({ type: 'maintainer', id: 'admin-bootstrap' });
    expect(verdict.reason).toMatch(/admin-authorized/);
  });


  it('authorizationHeadShaMatches enforces exact head on direct base binding', () => {
    const scope = {
      baseSha: 'base1111111111111111111111111111111111111111',
      baseParentSha: 'parent000000000000000000000000000000000000',
      headSha: 'head2222222222222222222222222222222222222222',
    };
    expect(authorizationHeadShaMatches(
      'head1111111111111111111111111111111111111111',
      'base1111111111111111111111111111111111111111',
      scope,
    )).toBe(false);
    expect(authorizationHeadShaMatches(
      'head2222222222222222222222222222222222222222',
      'base1111111111111111111111111111111111111111',
      scope,
    )).toBe(true);
  });

  it('AC2b accepts pre-merged authorization bound to merge-base parent SHA', () => {
    const added = ['docs/issues_drafts/99-new-draft.md'];
    const changedFiles = ['scripts/contract-evidence-legacy-drafts.json'];
    const match = findMatchingAuthorization([{
      id: 'auth-parent',
      baseSha: 'parent000000000000000000000000000000000000',
      headSha: 'head2222222222222222222222222222222222222222',
      addedPaths: added,
      changedGovernedFiles: changedFiles,
      source: { type: 'maintainer', id: 'admin-parent' },
    }], {
      baseSha: 'base1111111111111111111111111111111111111111',
      baseParentSha: 'parent000000000000000000000000000000000000',
      headSha: 'head2222222222222222222222222222222222222222',
      addedPaths: added,
      changedGovernedFiles: changedFiles,
    });
    expect(match).not.toBeNull();
    expect(match?.authorization).toEqual({ type: 'maintainer', id: 'admin-parent' });
  });

  it('AC2c accepts authorization after strict branch update with new head SHA', () => {
    const added = ['docs/issues_drafts/99-new-draft.md'];
    const changedFiles = ['scripts/contract-evidence-legacy-drafts.json'];
    const match = findMatchingAuthorization([{
      id: 'auth-strict-update',
      baseSha: 'parent000000000000000000000000000000000000',
      headSha: 'head1111111111111111111111111111111111111111',
      addedPaths: added,
      changedGovernedFiles: changedFiles,
      source: { type: 'maintainer', id: 'admin-strict' },
    }], {
      baseSha: 'base2222222222222222222222222222222222222222',
      baseParentSha: 'parent000000000000000000000000000000000000',
      headSha: 'head3333333333333333333333333333333333333333',
      addedPaths: added,
      changedGovernedFiles: changedFiles,
    });
    expect(match).not.toBeNull();
    expect(match?.authorization).toEqual({ type: 'maintainer', id: 'admin-strict' });
  });

  it('AC12d rejects stale headSha when merge base matches authorization baseSha', () => {
    const added = ['docs/issues_drafts/99-new-draft.md'];
    const changedFiles = ['scripts/contract-evidence-legacy-drafts.json'];
    const match = findMatchingAuthorization([{
      id: 'auth-stale-head',
      baseSha: 'base1111111111111111111111111111111111111111',
      headSha: 'head1111111111111111111111111111111111111111',
      addedPaths: added,
      changedGovernedFiles: changedFiles,
      source: { type: 'maintainer', id: 'admin-stale' },
    }], {
      baseSha: 'base1111111111111111111111111111111111111111',
      baseParentSha: 'parent000000000000000000000000000000000000',
      headSha: 'head2222222222222222222222222222222222222222',
      addedPaths: added,
      changedGovernedFiles: changedFiles,
    });
    expect(match).toBeNull();
  });

  it('detects consumer resolution module edits as governed-surface changes', () => {
    const verdict = runGuardCase({
      changedFiles: ['scripts/contract-evidence.mjs'],
      manifest: productionManifest,
      headManifest: productionManifest,
    });
    expect(verdict.changedGovernedFiles).toContain('scripts/contract-evidence.mjs');
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/unauthorized governed-surface modification/);
  });

  it('AC3 rejects self-authorization in the same diff', () => {
    const verdict = runGuardCase({
      changedFiles: [
        'scripts/contract-evidence-legacy-drafts.json',
        AUTHORIZATIONS_REL_PATH,
      ],
      authFileChanged: true,
      headLegacyListContent: legacyListWithPaths([
        'docs/issues_drafts/00-architecture-decisions.md',
        'docs/issues_drafts/01-ao-task-declaration-impl.md',
        'docs/issues_drafts/99-new-draft.md',
      ]),
      baseAuthorizations: {
        authorizations: [{
          id: 'self',
          baseSha: 'base1111111111111111111111111111111111111111',
          headSha: 'head2222222222222222222222222222222222222222',
          addedPaths: ['docs/issues_drafts/99-new-draft.md'],
          changedGovernedFiles: ['scripts/contract-evidence-legacy-drafts.json'],
          source: { type: 'pr', id: 'self' },
          reason: 'forged',
        }],
      },
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/self-authorization rejected/);
  });

  it('AC4 passes path removal', () => {
    const verdict = runGuardCase({
      headLegacyListContent: legacyListWithPaths([
        'docs/issues_drafts/00-architecture-decisions.md',
      ]),
    });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.removedPaths).toEqual(['docs/issues_drafts/01-ao-task-declaration-impl.md']);
  });

  it('AC5 passes reorder/reformat with identical normalized set', () => {
    const paths = [
      'docs/issues_drafts/01-ao-task-declaration-impl.md',
      'docs/issues_drafts/00-architecture-decisions.md',
    ];
    const verdict = runGuardCase({
      headLegacyListContent: legacyListWithPaths(paths),
    });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.addedPaths).toEqual([]);
    expect(verdict.removedPaths).toEqual([]);
  });

  it('AC6 fails malformed duplicate-equivalent entries', () => {
    const verdict = runGuardCase({
      headLegacyListContent: legacyListWithPaths([
        'docs/issues_drafts/00-architecture-decisions.md',
        './docs/issues_drafts/01-ao-task-declaration-impl.md',
      ]),
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/malformed/);
  });

  it('AC7 fails legacy list relocation without authorization', () => {
    const verdict = runGuardCase({
      changedFiles: ['scripts/contract-evidence-legacy-drafts.json', 'scripts/evasion-legacy-drafts.json'],
      nameStatus: [
        { status: 'R', previousPath: 'scripts/contract-evidence-legacy-drafts.json', path: 'scripts/evasion-legacy-drafts.json' },
      ],
      headLegacyListContent: null,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/relocation/);
  });

  it('AC8 fails closed on stale or unresolvable base', () => {
    const verdict = runGuardCase({
      baseResolvable: false,
      changedFiles: governedManifestFiles,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/stale or unresolvable/);
  });

  it('AC9 fails governed-surface modification without authorization', () => {
    const verdict = runGuardCase({
      changedFiles: ['scripts/contract-evidence-legacy-list-guard.mjs'],
      baseLegacyListContent: baseLegacyFixture,
      headLegacyListContent: baseLegacyFixture,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/unauthorized governed-surface modification/);
  });

  it('AC10 evaluates full governed-surface diff, not only list JSON', () => {
    const governed = governedSurfacePaths(productionManifest);
    const changed = computeChangedGovernedFiles(['scripts/contract-evidence-legacy-list-guard.mjs'], governed);
    expect(changed).toContain('scripts/contract-evidence-legacy-list-guard.mjs');
  });

  it('AC11 workflow ordering check passes for trusted workflow wiring', () => {
    const result = runLegacyListGuardWorkflowOrderingCheck(repoRoot);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('AC11 rejects executable PR-head steps before trusted guard completes', () => {
    const malicious = `name: contract-evidence-legacy-list-guard
on:
  pull_request_target:
    types: [opened]
jobs:
  contract-evidence-legacy-list-guard:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout PR head
        uses: actions/checkout@v4
      - name: Checkout trusted legacy list guard (base ref)
        uses: actions/checkout@v4
        with:
          path: trusted-legacy-list-guard
      - name: Run attacker script from PR head
        run: node scripts/evil.mjs
      - name: Run legacy list guard from trusted entrypoint
        run: node trusted-legacy-list-guard/scripts/run-contract-evidence-legacy-list-guard.mjs
`;
    const result = validateLegacyListGuardWorkflowOrdering(malicious);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/must not run before trusted guard/);
  });

  it('AC12 rejects stale authorization binding on base SHA', () => {
    const match = findMatchingAuthorization([{
      baseSha: 'other-base',
      addedPaths: ['docs/issues_drafts/99-new-draft.md'],
      changedGovernedFiles: ['scripts/contract-evidence-legacy-drafts.json'],
      source: { type: 'maintainer', id: 'stale' },
    }], {
      baseSha: 'base1111111111111111111111111111111111111111',
      headSha: 'head2222222222222222222222222222222222222222',
      addedPaths: ['docs/issues_drafts/99-new-draft.md'],
      changedGovernedFiles: ['scripts/contract-evidence-legacy-drafts.json'],
    });
    expect(match).toBeNull();
  });

  it('AC12b rejects authorization records without baseSha', () => {
    const match = findMatchingAuthorization([{
      addedPaths: ['docs/issues_drafts/99-new-draft.md'],
      changedGovernedFiles: ['scripts/contract-evidence-legacy-drafts.json'],
      source: { type: 'maintainer', id: 'missing-base' },
    }], {
      baseSha: 'base1111111111111111111111111111111111111111',
      headSha: 'head2222222222222222222222222222222222222222',
      addedPaths: ['docs/issues_drafts/99-new-draft.md'],
      changedGovernedFiles: ['scripts/contract-evidence-legacy-drafts.json'],
    });
    expect(match).toBeNull();
  });

  it('AC12c rejects authorization records without headSha', () => {
    const match = findMatchingAuthorization([{
      baseSha: 'base1111111111111111111111111111111111111111',
      addedPaths: ['docs/issues_drafts/99-new-draft.md'],
      changedGovernedFiles: ['scripts/contract-evidence-legacy-drafts.json'],
      source: { type: 'maintainer', id: 'missing-head' },
    }], {
      baseSha: 'base1111111111111111111111111111111111111111',
      headSha: 'head2222222222222222222222222222222222222222',
      addedPaths: ['docs/issues_drafts/99-new-draft.md'],
      changedGovernedFiles: ['scripts/contract-evidence-legacy-drafts.json'],
    });
    expect(match).toBeNull();
  });

  it('treats manifest shrink as governed change via base/head union', () => {
    const baseManifest = productionManifest;
    const shrunkFiles = (Array.isArray(baseManifest.files) ? baseManifest.files : [])
      .map((entry) => String(entry))
      .filter((entry) => entry !== GOVERNED_MANIFEST_REL_PATH);
    const headManifest = {
      ...baseManifest,
      files: shrunkFiles,
    };
    const verdict = evaluateLegacyListGuard({
      baseSha: 'base1111111111111111111111111111111111111111',
      headSha: 'head2222222222222222222222222222222222222222',
      changedFiles: [GOVERNED_MANIFEST_REL_PATH],
      manifest: baseManifest,
      headManifest,
      baseLegacyListContent: baseLegacyFixture,
      headLegacyListContent: baseLegacyFixture,
      baseAuthorizations: { authorizations: [] },
      bootstrap: false,
      baseResolvable: true,
    });
    expect(verdict.changedGovernedFiles).toContain(GOVERNED_MANIFEST_REL_PATH);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/unauthorized governed-surface modification/);
  });

  it('fails head manifest closure when head adds an ungoverned entrypoint import', () => {
    const manifest = loadGovernedManifest(repoRoot);
    const deps = Array.isArray(manifest.pinnedEntrypointDependencies)
      ? manifest.pinnedEntrypointDependencies.map((rel) => String(rel))
      : [];
    const brokenHead = {
      ...manifest,
      pinnedEntrypointDependencies: deps.filter(
        (rel) => rel !== 'scripts/contract-evidence-legacy-list-guard.mjs',
      ),
    };
    const manifestPath = path.join(repoRoot, 'scripts/contract-evidence-legacy-governed-manifest.json');
    const original = readFileSync(manifestPath, 'utf8');
    writeFileSync(manifestPath, `${JSON.stringify(brokenHead, null, 2)}
`);
    try {
      const closure = validateBaseAndHeadManifestClosure(repoRoot, repoRoot, productionManifest);
      expect(closure.ok).toBe(false);
      expect(closure.errors.join('\n')).toMatch(/head:.*entrypoint dependency/);
    } finally {
      writeFileSync(manifestPath, original);
    }
  });

  it('AC13 unrelated PR gets policy-pass', () => {
    const verdict = runGuardCase({
      changedFiles: ['README.md'],
    });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.policyPass).toBe(true);
  });

  it('AC14 shares canonicalizer module with consumer', () => {
    expect(canonicalLegacyDraftPath).toBeTypeOf('function');
    const base = loadLegacyPathSet(baseLegacyFixture);
    const head = loadLegacyPathSet(baseLegacyFixture);
    expect(base.paths && head.paths).toBeTruthy();
    expect(diffLegacyPathSets(base.paths!, head.paths!).added).toEqual([]);
  });

  it('AC15 bootstrap is landable and post-bootstrap additions still fail', () => {
    const bootstrapVerdict = runGuardCase({
      bootstrap: true,
      changedFiles: governedManifestFiles,
      headLegacyListContent: legacyListWithPaths([
        'docs/issues_drafts/00-architecture-decisions.md',
        'docs/issues_drafts/01-ao-task-declaration-impl.md',
        'docs/issues_drafts/bootstrap-add.md',
      ]),
    });
    expect(bootstrapVerdict.verdict).toBe('pass');
    expect(bootstrapVerdict.bootstrap).toBe(true);

    const liveVerdict = runGuardCase({
      bootstrap: false,
      headLegacyListContent: legacyListWithPaths([
        'docs/issues_drafts/00-architecture-decisions.md',
        'docs/issues_drafts/01-ao-task-declaration-impl.md',
        'docs/issues_drafts/bootstrap-add.md',
      ]),
    });
    expect(liveVerdict.verdict).toBe('fail');
  });

  it('AC16 producer-emission: unauthorized addition emits fail verdict', () => {
    const verdict = runGuardCase({
      headLegacyListContent: legacyListWithPaths([
        'docs/issues_drafts/00-architecture-decisions.md',
        'docs/issues_drafts/01-ao-task-declaration-impl.md',
        'docs/issues_drafts/producer-emission-fail.md',
      ]),
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.expected).toBe('fail');
    expect(verdict.bindingId).toBe('orchestrator-pack:legacy-list-guard-verdict');
  });

  it('fails manifest closure when entrypoint imports an ungoverned helper', () => {
    const manifest = loadGovernedManifest(repoRoot);
    const deps = Array.isArray(manifest.pinnedEntrypointDependencies)
      ? manifest.pinnedEntrypointDependencies.map((rel) => String(rel))
      : [];
    const broken = {
      ...manifest,
      pinnedEntrypointDependencies: deps.filter(
        (rel) => rel !== 'scripts/contract-evidence-legacy-list-guard.mjs',
      ),
    };
    const closure = validateManifestClosure(repoRoot, broken);
    expect(closure.ok).toBe(false);
    expect(closure.errors.join('\n')).toMatch(/entrypoint dependency/);
  });

  it('collects dynamic import and require dependencies in entrypoint closure', () => {
    const dir = mkdtempSync(path.join(repoRoot, '.tmp-legacy-list-closure-'));
    try {
      mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      writeFileSync(path.join(dir, 'scripts/helper.mjs'), 'export const helper = 1;\n');
      writeFileSync(path.join(dir, 'scripts/other.cjs'), 'module.exports = {};\n');
      writeFileSync(
        path.join(dir, 'scripts/entry.mjs'),
        "import('./helper.mjs');\nconst dynamic = import('./helper.mjs');\nrequire('./other.cjs');\n",
      );
      expect(extractLocalModuleSpecs(readFileSync(path.join(dir, 'scripts/entry.mjs'), 'utf8'))).toEqual(
        expect.arrayContaining(['./helper.mjs', './other.cjs']),
      );
      const closure = collectEntrypointDependencyClosure(dir, 'scripts/entry.mjs');
      expect(closure.has('scripts/helper.mjs')).toBe(true);
      expect(closure.has('scripts/other.cjs')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates governed manifest closure on trusted root', () => {
    expect(isGuardPresentOnBase(repoRoot)).toBe(true);
    const closure = validateManifestClosure(repoRoot, productionManifest);
    expect(closure.ok).toBe(true);
  });

  it('captured git diff: unauthorized addition fails from real diff', () => {
    const repoDir = initGitRepo();
    try {
      seedGuardSurface(repoDir);
      writeFileSync(path.join(repoDir, 'scripts/contract-evidence-legacy-drafts.json'), baseLegacyFixture);
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir });
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

      const headList = legacyListWithPaths([
        'docs/issues_drafts/00-architecture-decisions.md',
        'docs/issues_drafts/01-ao-task-declaration-impl.md',
        'docs/issues_drafts/git-diff-add.md',
      ]);
      writeFileSync(path.join(repoDir, 'scripts/contract-evidence-legacy-drafts.json'), headList);
      execFileSync('git', ['add', 'scripts/contract-evidence-legacy-drafts.json'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'add path'], { cwd: repoDir });
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

      const changed = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim().split('\n');
      const verdict = evaluateLegacyListGuard({
        baseSha,
        headSha,
        changedFiles: changed,
        baseLegacyListContent: baseLegacyFixture,
        headLegacyListContent: headList,
        baseAuthorizations: { authorizations: [] },
        manifest: loadGovernedManifest(repoDir),
      });
      expect(verdict.verdict).toBe('fail');
      expect(verdict.addedPaths).toEqual(['docs/issues_drafts/git-diff-add.md']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('runner-level: missing verdict is fail-closed for governed changes', () => {
    const verdict = evaluateLegacyListGuard({
      baseSha: '',
      headSha: '',
      changedFiles: governedManifestFiles,
      bootstrap: false,
      baseResolvable: false,
    });
    expect(verdict.verdict).toBe('fail');
  });
});
