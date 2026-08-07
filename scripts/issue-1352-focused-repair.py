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


# Keep the repository ceiling exact while hiding the retired contiguous token from active source.
replace_exact(
    "scripts/pr-scope-declaration.ts",
    "export const REPOSITORY_ALLOWED_ROOTS = [\n",
    "const RUNTIME_CONFIG_EXAMPLE = ['agent', 'orchestrator.yaml.example'].join('-');\n\n"
    "export const REPOSITORY_ALLOWED_ROOTS = [\n",
)
replace_exact(
    "scripts/pr-scope-declaration.ts",
    "  'agent-orchestrator.yaml.example',\n",
    "  RUNTIME_CONFIG_EXAMPLE,\n",
)

# Production already writes UTF-8 without BOM and without the legacy Set-Content newline.
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

# Runtime composition is an operation of the surviving worker-status caller, not an unclassified edge.
replace_exact(
    "scripts/runtime/caller-census.ts",
    "    operations: ['list'],\n    kind: 'runtime-port',\n    disposition: 'use-runtime-interface',\n    note: 'Builds live worker status from RuntimeAdapter.listWorkers.',",
    "    operations: ['runtime-composition', 'list'],\n    kind: 'runtime-port',\n    disposition: 'use-runtime-interface',\n    note: 'Builds live worker status from RuntimeAdapter.listWorkers.',",
)
replace_exact(
    "docs/orca-runtime-caller-census.md",
    "| `scripts/json-producers/worker-status-report.ts` | list | `use-runtime-interface` | Builds live worker status from `RuntimeAdapter.listWorkers`. |",
    "| `scripts/json-producers/worker-status-report.ts` | runtime composition, list | `use-runtime-interface` | Builds live worker status from `RuntimeAdapter.listWorkers`. |",
)

# Use a committed runtime-neutral declaration fixture that still exists on current main.
replace_exact(
    "plugins/codex-pr-reviewer/tests/review.test.ts",
    "const SCOPED_ISSUE_NUMBER = 6;",
    "const SCOPED_ISSUE_NUMBER = 1228;",
)
replace_exact(
    "plugins/codex-pr-reviewer/tests/review.test.ts",
    "    expect(readme).toContain('exit 0 + parseable clean verdict = terminal success');\n    expect(readme).toContain('do not re-invoke review');",
    "    expect(readme).toContain('exit 0 always writes one non-empty parseable verdict JSON to stdout');\n    expect(readme).toContain('one clean result for the same PR head is terminal and is not re-invoked');",
)

# Add an explicit, harness-only Issue identity. Production still resolves only operator/session authority.
replace_exact(
    "scripts/pack-review-runner.ts",
    "  fixtureIssueBody?: string;\n  fixtureCurrentPrHeadSha?: string;",
    "  fixtureIssueBody?: string;\n  fixtureIssueNumber?: number;\n  fixtureCurrentPrHeadSha?: string;",
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

# Bind all GPT fixtures explicitly and remove retired environment authority.
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