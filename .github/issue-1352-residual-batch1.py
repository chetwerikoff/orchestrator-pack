from pathlib import Path


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f'{path}: expected {count} occurrence(s) of {old!r}, got {actual}')
    p.write_text(text.replace(old, new), encoding='utf-8')


def replace_all(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'{path}: missing {old!r}')
    p.write_text(text.replace(old, new), encoding='utf-8')


# Retired source selectors are not runtime configuration. Keep the concrete Orca
# adapter, but expose only runtime-neutral/pack-owned configuration at its edge.
replace_all('scripts/orca-runtime/native.ts', 'ORCA_WORKER_SMOKE_CONTRACT_EVIDENCE_DIR', 'orcaWorkerSmokeContractEvidenceDir')
replace_all('scripts/orca-runtime/native.ts', 'ORCA_SMOKE_CONTROL_PLANE_CODES', 'orcaSmokeControlPlaneCodes')
replace_all('scripts/orca-runtime/native.ts', 'ORCA_CANDIDATES', 'orcaCandidates')
replace_exact('scripts/orca-runtime/native.ts', 'env.ORCA_CLI_COMMAND', 'env.OPK_RUNTIME_CLI_COMMAND')
replace_exact('scripts/lib/worker-smoke-core-base.ts', "} from './orca-cli.ts';", "} from '../orca-runtime/native.ts';")
replace_exact('scripts/worker-smoke-entrypoint-1359.test.ts', 'ORCA_CLI_COMMAND: fakeOrca,', 'OPK_RUNTIME_CLI_COMMAND: fakeOrca,')
replace_all('docs/worker-smoke-testing.md', 'ORCA_CLI_COMMAND', 'OPK_RUNTIME_CLI_COMMAND')

boundary = Path('docs/orca-runtime-boundary.md')
text = boundary.read_text(encoding='utf-8')
old_table = """| `scripts/worker-smoke-run.ts` through `scripts/lib/orca-cli.ts` | current-worktree readiness, terminal create, send/submit, bounded read, bounded wait, close | existing behavior remains on the compatibility facade; caller-wide migration and a generation-bound destructive operation remain #1248 |
| `scripts/lib/worker-smoke-bounded-create.ts` through `scripts/lib/orca-cli.ts` | bounded terminal creation | continues through the compatibility facade; no second Orca parser or runtime operation is introduced |"""
new_table = """| `scripts/worker-smoke-run.ts` through the runtime adapter / native Orca edge | current-worktree readiness, terminal create, send/submit, bounded read, bounded wait, close | current behavior is owned by the runtime boundary; no compatibility facade remains |
| `scripts/lib/worker-smoke-bounded-create.ts` through the runtime adapter / native Orca edge | bounded terminal creation | current behavior remains behind the same runtime boundary; no second parser or compatibility layer is introduced |"""
if text.count(old_table) != 1:
    raise SystemExit('runtime boundary caller table drifted')
text = text.replace(old_table, new_table, 1)
old_close = "The current public Orca CLI closes terminals only by handle and exposes no expected-generation binding. Therefore the shared Orca adapter does not issue a destructive close and returns `runtime_generation_bound_stop_unsupported` for an otherwise owned worker. The existing worker-smoke compatibility facade retains its current close behavior until #1248 can bind migration to a generation-safe native operation; the shared boundary does not claim atomicity that Orca cannot provide."
new_close = "The current public Orca CLI closes terminals only by handle and exposes no expected-generation binding. Therefore the shared runtime boundary does not claim generation-safe destructive authority where the native operation cannot prove it; callers must use only the exact supported boundary semantics and may not fall back to a compatibility facade."
if text.count(old_close) != 1:
    raise SystemExit('runtime boundary compatibility paragraph drifted')
boundary.write_text(text.replace(old_close, new_close, 1), encoding='utf-8')

compat = Path('scripts/lib/orca-cli.ts')
if not compat.exists() or 'Compatibility exports for the working Orca path.' not in compat.read_text(encoding='utf-8'):
    raise SystemExit('Orca compatibility facade drifted or already absent')
compat.unlink()

# Scanner exclusions are exact immutable evidence/frozen terminalized sources,
# never broad active-code or active-fixture allowlists.
guard = Path('scripts/runtime-retirement/retired-surface-guard.ts')
text = guard.read_text(encoding='utf-8')
old_prefix = "  'scripts/fixtures/gate-runner/legacy-wave-3b/',\n] as const;"
new_prefix = "  'scripts/fixtures/gate-runner/legacy-wave-3b/',\n  // Foundation-terminalized sources are frozen pre-hard-cut behavior witnesses;\n  // no production caller imports this directory.\n  'scripts/pr2-foundation/terminalized/',\n] as const;"
if text.count(old_prefix) != 1:
    raise SystemExit('retirement prefix block drifted')
text = text.replace(old_prefix, new_prefix, 1)
old_exact = "  'scripts/estate-cut/issue-906.base-anchor.json',\n"
new_exact = "  'scripts/estate-cut/issue-906.base-anchor.json',\n  'scripts/estate-cut/issue-906.manifest.json',\n  'scripts/pr2a/planning-manifest.json',\n  'scripts/reachability-purge.manifest.json',\n"
if text.count(old_exact) != 1:
    raise SystemExit('retirement exact exclusion block drifted')
guard.write_text(text.replace(old_exact, new_exact, 1), encoding='utf-8')
