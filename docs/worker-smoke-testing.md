# Worker smoke testing (Issue #1061)

Workers prove operator-visible behavior with a **head-bound Orca smoke run** before `ready_for_review`. CI remains mandatory and separate.

## When smoke is required

| Issue body signal | Worker gate |
|---|---|
| No `smoke-test-plan` fence + `smoke-plan-floor` grandfather marker | Smoke not required (legacy queue only) |
| No `smoke-test-plan` fence on action-producing Issue without grandfather marker | Smoke required; missing plan blocks handoff |
| `smoke-test-plan` with `not-applicable: true` + reason | Smoke skipped |
| `smoke-test-plan` with scenarios | Smoke required for current PR head |

New action-producing tasks must declare a plan during authoring:

```bash
node scripts/draft-discipline.mjs smoke-test-plan --draft path/to/issue-body.md
```

## Supported worker path

```bash
export PATH="$PWD/scripts:$PATH"
worker-smoke-run run \
  --issue <N> \
  --pr <PR> \
  --head-sha <40-hex> \
  --issue-body-file /tmp/issue-body.md \
  --repo-root "$PWD" \
  --cwd "$PWD"
```

Lifecycle:

1. `orca worktree current --json` must resolve the worker cwd to the existing Orca-managed worktree.
2. `orca terminal create --worktree active --command "cursor-agent"` captures one owned handle.
3. Worker sends the smoke prompt, waits/reads through Orca terminal surfaces, parses the `worker-smoke-report` block.
4. Worker closes only `orca terminal close --terminal <owned-handle>` **before** publishing the PR comment; cleanup result is recorded in the report.
5. Pack publishes a top-level PR comment via `gh pr comment` (through pack `scripts/gh`). Smoke-owned `gh` children receive only the supported parent auth/config carriers (`GH_TOKEN` / `GITHUB_TOKEN`, enterprise token variants, `GH_HOST`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `HOME`, `USERPROFILE`) — not the full parent environment. `GH_REPO` is intentionally not forwarded because it can redirect smoke-owned GitHub operations away from the bound worktree.

## Pack-generated non-PASS causes

Structured `worker-smoke-run` JSON distinguishes at least:

| `nonPassCause` | Meaning |
|---|---|
| `zero_parsed_scenarios` | Required plan parsed to zero executable scenarios; no Orca terminal was created |
| `missing_agent_report` | Agent activity was observed but no parseable `worker-smoke-report` block was found |
| `executed_scenario_failure` | A valid report shows one or more declared scenarios ran and failed |

Top-level `PASS | FAIL | BLOCKED` semantics are unchanged.

## Orca contract evidence

`scripts/lib/orca-cli.ts` consumes concrete Orca JSON fields (`result.worktree.*`, `result.terminal.handle`, `result.lines`). Capture-backed producer evidence lives under `tests/external-output-references/captures/orca-worker-smoke/` (grounding commit `89968a10614d0e5f5a6b7805c81dccc3a1b5110b` per Issue #1061).

## Orca executable selection

Use `ORCA_CLI_COMMAND` when exported. Otherwise prefer `orca-dev`, then `orca-ide`, then `orca`. Do not assume `/usr/bin/orca` is the CLI on Linux.

## Readiness gate

`pack-worker-report --state ready_for_review` invokes `worker-smoke-run gate-check` and fails closed when smoke is required and the current head lacks a bound `PASS` with `terminal-cleanup: closed_owned_handle`. The latest same-head FAIL/BLOCKED report revokes an earlier PASS. Issue binding resolves from `Closes #N` on the PR when `AO_ISSUE_NUMBER` is unset.

Production adoption aligns with Issue #1038: pre-cutover AO workers that are not Orca-managed remain `BLOCKED` rather than faking compliance via another checkout.
