# Coworker CLI delegation (deep-dive)

Worker **core contract** lives in [`prompts/agent_rules.md`](../prompts/agent_rules.md) (**Coworker CLI delegation**). This page holds examples, the PR-diff recipe, and rationale — not duplicate enforcement prose.

## PR diff recipe (reviewers)

When a diff exceeds the read-delegation floor, write it to a file first, then delegate — never pipe into coworker:

```bash
git diff <base-ref>...HEAD > /tmp/review.diff
coworker ask --profile code --allow-code \
  --paths /tmp/review.diff \
  --question "Summarize this PR diff for a reviewer. List changed files and behavior changes. Do not make final review judgments."
```

## Worked example (read delegation)

Root-cause work must read ~900 lines across `prompts/agent_rules.md`, a config file, and a runtime log. The 400-line and 3-file (≥400 combined) triggers fire.

**Correct:** scrub the log fence-clean, then
`coworker ask --profile code --paths prompts/agent_rules.md <config> <scrubbed-log> --question "extract the evidence relevant to ..."`
extracts/summarises the minimal needed excerpt; you reason over the cheap-model summary and write the root-cause conclusion yourself.

**Wrong:** append the file list after `--question` without `--paths`, or label the whole task “root-cause” and inline all 900 lines — the reasoning exception does not cover the reading.

## Recommended delegation ladder (Cursor seat, advisory corpus)

Preferred order as **guidance**, not a mandated sequence:

1. `coworker ask --profile code --paths …` — cheap-model offload when fence-clean.
2. A targeted `Read` with `offset`/`limit` — when only a slice is needed.

Shell read-arounds (`head`, chunked `sed`/`grep`, python chunking) do not satisfy this ladder; the stop-time audit records them separately. Inline full-file reads on the reasoning model are permitted when advisory, but the ladder above is the cost intent.

## Ordering and accountability (rationale)

- When **no** ask trigger is met, use deterministic repo tools (search, read, diff, tests) **instead of** `coworker ask` — do not delegate (CLI overhead exceeds benefit below the floor). In this sub-threshold zone, work estimated **under 2000 tokens** of real work stays in-session for the same reason; that heuristic **cannot override** a fired ask trigger.
- When an ask trigger **is** met and the corpus is fence-clean and the work is not an excepted reasoning step: on **Claude and Codex**, delegation is **mandatory** — do not inline the read on the reasoning model; on the **Cursor seat** for advisory corpus (out-of-index / tracked non-code bulk, not index- or diff-exempt), follow the **SHOULD** ladder above — delegation is recommended, not required.
- Your final status **states the delegation outcome**: either that `coworker` was used for the bulk repo/log read, or the closed-list reason it was not (below the floor / excepted reasoning step / corpus not fence-cleanable / `coworker` missing, unavailable, or rate-limited). Silence is non-compliant.

You remain responsible for verifying coworker output, scope, commits, and AO transitions. `coworker` must not run `ao-declare`, `ao report`, or open PRs.

## Cost framework pointer

For the broader cost ladder beyond coworker, see
[`docs/first_principles_5_operational_framework.md`](first_principles_5_operational_framework.md).

Architecture: §S in
[`docs/issues_drafts/00-architecture-decisions.md`](issues_drafts/00-architecture-decisions.md).
