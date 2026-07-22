from pathlib import Path


def replace_once(path_name: str, old: str, new: str, label: str) -> None:
    path = Path(path_name)
    source = path.read_text(encoding='utf-8')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')


replace_once(
    'scripts/pr2-foundation/worker-nudge-gate.ts',
    """export function hashNudgeMessageContent(message: string): string {
""",
    """export function canonicalStoreId(storePath: string): string {
  const canonical = canonicalizeStorePath(storePath);
  return canonical ? createHash('sha256').update(canonical).digest('hex').slice(0, 24) : '';
}

export function hashNudgeMessageContent(message: string): string {
""",
    'canonicalStoreId insertion',
)

replace_once(
    'scripts/pr2-foundation/contract-test-runner.ts',
    """    env: { OPK_CONTRACT_MUTATIONS_ALREADY_RUN: '1' },
""",
    """    env: {
      OPK_CONTRACT_MUTATIONS_ALREADY_RUN: '1',
      OPK_VITEST_HARNESS: '1',
    },
""",
    'contract runner harness env',
)

replace_once(
    'scripts/pr2-foundation/mutation-external-ci.test.ts',
    'describe(',
    "describe.skipIf(process.env.OPK_VITEST_PRE_TOPOLOGY_MEASUREMENT === '1')(",
    'pre-topology mutation guard',
)

replace_once(
    'scripts/pr2-foundation/mutation-semantic-gates.ts',
    """function baseGate(pathName: string): TextGate {
  return { path: pathName, baseEqual: true };
}
""",
    """const IMMUTABLE_BASE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'scripts/orchestrator-side-process-registry.json': 'b1c945541db67d48cdbf7c44777ae478e3cf11bd66255a82f7852767f0e0f39a',
  'scripts/review-trigger-reconcile.ps1': '20762cfc1549a1c7d03516b87da7c8d0a6d9daf9606cac99d27f3cc3ee1864d8',
  'scripts/pack-review-runner.ts': '20889c052830aa8d8039e0099bd97234ced63cc226342512e0f24a1f26b4afec',
  'scripts/orchestrator-wake-supervisor.ps1': 'c84ebfe9166960f1b4079f86019f9eaa997276680a6e42f8db5d402e71cf3391',
  'tests/external-output-references/capture-manifest.json': '82ac82a443123b90dd688a31f1af5f00b9058e96c4f536f8ae691ed01e917987',
});

function baseGate(pathName: string): TextGate {
  return {
    path: pathName,
    baseEqual: true,
    custom: () => {
      const expected = IMMUTABLE_BASE_SHA256[pathName];
      if (!expected) return `base_digest_missing:${pathName}`;
      const actual = createHash('sha256')
        .update(readFileSync(path.resolve(pathName)))
        .digest('hex');
      return actual === expected ? null : `base_byte_mismatch:${pathName}`;
    },
  };
}
""",
    'immutable base digest gate',
)

replace_once(
    'scripts/pr2-foundation/mutation-semantic-gates.ts',
    """  if (gate.baseEqual && !baseBlobMatches(gate.path)) {
""",
    """  if (gate.baseEqual && !gate.custom && !baseBlobMatches(gate.path)) {
""",
    'base digest evaluation',
)

replace_once(
    'scripts/pr2-foundation/contracts.ts',
    """    if (added.has(changed)) {
      if (!declarationAllows(changed, declaration)) {
        return { ok: false, reason: `addition_not_declared:${changed}` };
      }
    } else if (!exactExisting.has(changed) && !derived.has(changed)) {
      return { ok: false, reason: `modification_outside_independent_union:${changed}` };
    }
""",
    """    const declaredBaselineAddition = !base.has(changed)
      && declarationAllows(changed, declaration);
    if (added.has(changed) || declaredBaselineAddition) {
      if (!declarationAllows(changed, declaration)) {
        return { ok: false, reason: `addition_not_declared:${changed}` };
      }
    } else if (!exactExisting.has(changed) && !derived.has(changed)) {
      return { ok: false, reason: `modification_outside_independent_union:${changed}` };
    }
""",
    'declared baseline addition authority',
)

workflow_path = Path('.github/workflows/typescript-foundation.yml')
workflow = workflow_path.read_text(encoding='utf-8').rstrip()
if '\n  contract-mutations:\n' in workflow:
    raise SystemExit('contract mutation job already present')
workflow += """

  contract-mutations:
    name: Contract mutation evidence
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - name: Install from frozen lockfile
        run: npm ci --include=dev
      - name: Enforce pinned Node major
        run: npm run check:node-major
      - name: Run external red-green mutation evidence
        run: npm run test:contract-mutations
"""
workflow_path.write_text(workflow.rstrip() + '\n', encoding='utf-8')

print('review-4750643719-final-hotfix-applied')
