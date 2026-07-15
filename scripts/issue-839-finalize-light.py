from pathlib import Path
import re


def replace_one(path, before, after):
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(before)
    if count != 1:
        raise SystemExit(
            f"{path}: expected exactly one match for {before[:70]!r}, found {count}"
        )
    p.write_text(text.replace(before, after, 1), encoding="utf-8")


replace_one(
    "AGENTS.md",
    "On delivered findings, use `addressing_reviews` → optional `fixing_ci` → `ready_for_review` after CI is green; never report `completed` with open findings. Inspect pack-store `Get-AoReviewRuns` and the authoritative current-head GitHub review.",
    "On delivered findings, **must not** idle: use `addressing_reviews` → optional `fixing_ci` → `ready_for_review` after CI is green; never report `completed` with open findings. Inspect current-head pack-store/GitHub review.",
)
replace_one(
    "AGENTS.md",
    "Trust reviewer terminal JSON, the authoritative current-head GitHub review, and the dispatch journal. The pack store is operational only; daemon review HTTP and `ao review submit` are retired. Never synthesize findings from store rows.",
    "Trust reviewer terminal JSON, the current-head GitHub review, and dispatch journal. The pack store is operational only; daemon review HTTP and `ao review submit` are REMOVED. On telemetry failure, skip silently—never post substitute notifications or synthesize findings from store rows.",
)

p = Path("tests/harness-pretrigger-config-read.test.ts")
text = p.read_text(encoding="utf-8")
text, n = re.subn(
    r"^import \{ execFileSync \} from 'node:child_process';\n", "", text, count=1
)
if n != 1:
    raise SystemExit("execFileSync import replacement failed")
text, n = re.subn(
    r"    const fnEnd = text\.indexOf\('function Set-AoProjectReviewerHarness'\);",
    "    const fnEnd = text.indexOf('function Test-ReviewBeforeCleanupGate');",
    text,
    count=1,
)
if n != 1:
    raise SystemExit("Get-AoProjectConfigJson boundary replacement failed")
new_trigger = """  it('Invoke-AoReviewTriggerForWorker delegates to the pack runner without reviewer-harness gating', () => {
    const text = readFileSync(reviewApiLib, 'utf8');
    const fnStart = text.indexOf('function Invoke-AoReviewTriggerForWorker');
    const fnEnd = text.indexOf('function Get-ReviewTriggerInvocationLine');
    const body = text.slice(fnStart, fnEnd);
    expect(body).toMatch(/Invoke-AoSessionReviewTrigger/);
    expect(body).toMatch(/pack_review_runner_failed/);
    expect(body).not.toMatch(/harness-guard|reviewers_harness_misconfig|Get-AoProjectConfigJson/);
  });

"""
text, n = re.subn(
    r"  it\('Invoke-AoReviewTriggerForWorker allows live-shape fixture and refuses empty reviewers', \(\) => \{\n.*?\n  \}\);\n\n(?=  it\('GET /config 405 capture)",
    new_trigger,
    text,
    count=1,
    flags=re.S,
)
if n != 1:
    raise SystemExit("harness trigger test replacement failed")
new_write = """  it('retires reviewer-harness config writes from the review adapter', () => {
    const text = readFileSync(reviewApiLib, 'utf8');
    expect(text).not.toMatch(/function Set-AoProjectReviewerHarness/);
    expect(text).not.toMatch(/\\/config"/);
  });
"""
text, n = re.subn(
    r"  it\('Set-AoProjectReviewerHarness reviewer-write path remains PUT /config', \(\) => \{\n.*?\n  \}\);\n",
    new_write,
    text,
    count=1,
    flags=re.S,
)
if n != 1:
    raise SystemExit("harness config-write test replacement failed")
p.write_text(text, encoding="utf-8")

p = Path("scripts/reachability-purge.mjs")
text = p.read_text(encoding="utf-8")
replacements = [
    (
        "const ISSUE_821_KEEP_LIVE_HELPERS = [",
        "const ISSUE_839_ACCEPTED_RETIRED_PATHS = [\n  'scripts/ao-review.ps1',\n];\n\nconst ISSUE_821_KEEP_LIVE_HELPERS = [",
    ),
    (
        "    ...ISSUE_821_ACCEPTED_RETIRED_PATHS,\n  ])",
        "    ...ISSUE_821_ACCEPTED_RETIRED_PATHS,\n    ...ISSUE_839_ACCEPTED_RETIRED_PATHS,\n  ])",
    ),
    (
        "  const issue821RetiredSet = new Set(ISSUE_821_ACCEPTED_RETIRED_PATHS);",
        "  const issue821RetiredSet = new Set(ISSUE_821_ACCEPTED_RETIRED_PATHS);\n  const issue839RetiredSet = new Set(ISSUE_839_ACCEPTED_RETIRED_PATHS);",
    ),
    (
        "          : issue821RetiredSet.has(item) ? 'issue-821-retired'\n            : 'unqualified';",
        "          : issue821RetiredSet.has(item) ? 'issue-821-retired'\n            : issue839RetiredSet.has(item) ? 'issue-839-retired'\n              : 'unqualified';",
    ),
    (
        "      .filter((row) => !issue821RetiredSet.has(row.path))",
        "      .filter((row) => !issue821RetiredSet.has(row.path) && !issue839RetiredSet.has(row.path))",
    ),
]
for before, after in replacements:
    count = text.count(before)
    if count != 1:
        raise SystemExit(
            f"reachability replacement failed ({count}): {before[:70]!r}"
        )
    text = text.replace(before, after, 1)

fallback_pattern = re.compile(
    r"(?m)^(?P<indent>\s*): 'Deleted path does not satisfy the binding deadness formula\.',$"
)


def replace_fallback(match):
    indent = match.group("indent")
    return (
        f"{indent}: reason === 'issue-839-retired'\n"
        f"{indent}  ? 'Issue #839 explicitly retires the daemon-era ao-review shim after pack-runner cutover.'\n"
        f"{indent}  : 'Deleted path does not satisfy the binding deadness formula.',"
    )


text, n = fallback_pattern.subn(replace_fallback, text, count=1)
if n != 1:
    raise SystemExit(f"reachability fallback evidence replacement failed ({n})")
p.write_text(text, encoding="utf-8")

replace_one(
    "scripts/reachability-purge.test.ts",
    "['zero-reachability', 'superseded', 'backup', 'issue-821-retired']",
    "['zero-reachability', 'superseded', 'backup', 'issue-821-retired', 'issue-839-retired']",
)
