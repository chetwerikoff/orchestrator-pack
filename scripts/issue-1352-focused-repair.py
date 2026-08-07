from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def replace_exact(path: str, old: str, new: str, *, count: int = 1) -> None:
    file = ROOT / path
    text = file.read_text(encoding="utf-8")
    found = text.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} exact match(es), found {found}: {old[:120]!r}")
    file.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


def replace_regex(path: str, pattern: str, replacement: str, *, minimum: int = 1) -> int:
    file = ROOT / path
    text = file.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, flags=re.MULTILINE)
    if count < minimum:
        raise SystemExit(f"{path}: expected at least {minimum} regex match(es), found {count}: {pattern!r}")
    file.write_text(updated, encoding="utf-8", newline="\n")
    return count


# Production writes the freshly fetched Issue bytes without BOM or a Set-Content newline.
# Keep the legacy-newline fixture, but assert the current production writer rather than retired text.
replace_exact(
    "scripts/worker-smoke.test.ts",
    "  it('accepts the existing caller Set-Content newline but evaluates the freshly fetched Issue body', async () => {",
    "  it('accepts a legacy fixture newline but verifies the caller writes the freshly fetched Issue body without BOM', async () => {",
)
replace_exact(
    "scripts/worker-smoke.test.ts",
    "    expect(callerSource).toContain(\n      'Set-Content -LiteralPath $issueBodyFile.FullName -Value $issueBody -Encoding utf8NoBOM',\n    );",
    "    expect(callerSource).toContain(\n      '[System.IO.File]::WriteAllText($issueBodyFile.FullName, $issueBody, [System.Text.UTF8Encoding]::new($false))',\n    );",
)

# Use a committed declaration fixture that validates against the current declaration schema.
replace_exact(
    "plugins/codex-pr-reviewer/tests/review.test.ts",
    "const SCOPED_ISSUE_NUMBER = 6;",
    "const SCOPED_ISSUE_NUMBER = 1117;",
)
replace_exact(
    "plugins/codex-pr-reviewer/tests/review.test.ts",
    "    expect(readme).toContain('exit 0 + parseable clean verdict = terminal success');\n    expect(readme).toContain('do not re-invoke review');",
    "    expect(readme).toContain('exit 0 always writes one non-empty parseable verdict JSON to stdout');\n    expect(readme).toContain('one clean result for the same PR head is terminal and is not re-invoked');",
)

# Add explicit harness-only Issue identity. Production still resolves only operator/session authority.
replace_exact(
    "scripts/pack-review-runner.ts",
    "  fixtureIssueBody?: string;\n  fixtureChangedPaths?: string[];",
    "  fixtureIssueBody?: string;\n  fixtureIssueNumber?: number;\n  fixtureChangedPaths?: string[];",
)
replace_exact(
    "scripts/pack-review-runner.ts",
    "  const harness = process.env.OPK_VITEST_HARNESS === '1';\n  const harnessExplicit = harness && Boolean(input.prNumber && (input.headSha || fixtureCurrentHead));",
    "  const harness = process.env.OPK_VITEST_HARNESS === '1';\n  const fixtureIssueNumber = harness ? positiveInteger(input.fixtureIssueNumber, 'fixtureIssueNumber') : undefined;\n  const harnessExplicit = harness && Boolean(input.prNumber && (input.headSha || fixtureCurrentHead));",
)
replace_exact(
    "scripts/pack-review-runner.ts",
    "    issueNumber: operatorStart?.issueNumber ?? (binding?.issueNumber ? Number(binding.issueNumber) : undefined),",
    "    issueNumber: operatorStart?.issueNumber ?? fixtureIssueNumber ?? (binding?.issueNumber ? Number(binding.issueNumber) : undefined),",
)

# Every GPT test gets its own runtime-neutral claim store. OPK_BASE_DIR alone is not enough
# because the global Vitest harness also publishes the more-specific OPK_REVIEW_CLAIM_DIR.
replace_exact(
    "scripts/pack-review-runner-gpt.test.ts",
    "  process.env.OPK_BASE_DIR = path.join(storeRoot, 'ao-base');\n}",
    "  process.env.OPK_BASE_DIR = path.join(storeRoot, 'ao-base');\n  process.env.OPK_REVIEW_CLAIM_DIR = path.join(\n    storeRoot,\n    'ao-base',\n    'projects',\n    'orchestrator-pack',\n    'review-start-claims',\n  );\n}",
)

# Bind plural GPT fixtures explicitly and remove retired AO_* test authority.
replace_exact(
    "scripts/pack-review-runner-gpt.test.ts",
    "      fixtureIssueBody: '```complexity-tier\\ntier: T1\\n```',\n      claimMode: 'preacquired',",
    "      fixtureIssueBody: '```complexity-tier\\ntier: T1\\n```',\n      fixtureIssueNumber: 1276,\n      claimMode: 'preacquired',",
    count=3,
)
removed = replace_regex(
    "scripts/pack-review-runner-gpt.test.ts",
    r"^\s*process\.env\.AO_(?:\\u0049|I)SSUE_NUMBER\s*=\s*'1276';\n",
    "",
    minimum=5,
)
print(f"removed retired Issue env fixtures: {removed}")
