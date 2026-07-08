# Publish draft issue-body sync must fail closed on transport/parity mismatch

GitHub Issue: [#542](https://github.com/chetwerikoff/orchestrator-pack/issues/542)

## Prerequisite

None blocking.

**Prior art (reference only — surveyed, no full overlap):**

- `docs/issues_drafts/99-publish-delegation-worktree-isolation.md` (GitHub #304) — isolates delegated publish from the architect's live working tree. **Already does:** worktree/process isolation for delegated publish. **Does not do:** constrain the issue-body mutation transport or verify live REST body parity after sync.
- `docs/issues_drafts/170-orchestrator-command-runtime-bootstrap-contract.md` (GitHub #532, closed) — uncovered GitHub read forms become explicit pack contracts instead of ad hoc workarounds. **Relevant principle:** do not normalize a broken transport path by adding more one-off GitHub mutations.

**Incident note (verified 2026-06-30):** live GitHub Issue #538 was observed via REST with body literal `@/tmp/tmp.IoxWVuqfWY`, while the corresponding local draft body was ordinary markdown and the issue was later repaired in place. Current skill text already instructs `gh issue create/edit --body-file`, but no mechanical gate proves that the live REST body matches the local draft body after sync.

**Prior-art verdict:** genuinely new draft. Existing publish/worktree isolation (#304) and current skill instructions are adjacent, but no open issue or local draft owns the specific class "draft issue-body mutation transport drift or post-sync live-body mismatch".

## Goal

Make draft issue-body sync fail closed when the body reaches GitHub through the wrong transport or lands with content different from the local expected draft body, so a publish/sync run cannot report success while the live Issue carries a literal temp path, truncated body, or other mismatched content.

```behavior-kind
action-producing
```

## Binding surface

- For draft issue-body mutations, the sanctioned publish/sync path uses only the high-level `gh issue create` / `gh issue edit` subcommands with `--body-file` for the body payload. Draft issue-body sync must not use low-level `gh api ... /issues ... body=...` mutations unless a future explicit exception is designed, documented, and separately tested.
- After every draft issue-body create/edit, the publish/sync path performs a live REST read of the issue body through pack transport (`scripts/gh api repos/<owner>/<repo>/issues/<N> --jq .body`) and compares it to the local expected body (draft minus H1) before reporting success.
- The parity check is content-based, not exit-code-only: a mutation command exiting `0` is insufficient when the live REST body differs from the local expected draft body.
- The parity check may normalize only round-trip-irrelevant text presentation differences required to avoid false negatives from REST/CLI presentation (for example, line-ending normalization and at most one trailing final newline). It must still detect a literal temp-path body, truncation, wrong draft body, or other substantive mismatch.
- When the live body mismatches, publish/sync exits non-zero with an operator-visible message naming the issue number and mismatch class, and it must not report the draft as successfully synced.
- The publish path emits an audit record of the actual issue-mutation subcommand/argv class sufficient to debug the next incident without depending on vanished temp files. The audit must identify whether the run used `gh issue create` or `gh issue edit`, the target issue/repo, and enough body-source metadata to distinguish file-backed high-level sync from an unsanctioned literal/string path, without logging the full issue body.
- Existing publish delegation/worktree isolation behavior (#304) remains intact; this draft adds transport/parity enforcement, not a new live-tree mutation path.

**Operator adoption:** none. This is an agent-side publish/sync contract.

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:publish-issue-body:high-level-body-file-only
binding-type: cli-behavior
binding: draft issue-body sync uses only gh issue create/edit with --body-file, never low-level gh api issue-body mutation
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:publish-issue-body:rest-parity-gate
binding-type: cli-behavior
binding: after create/edit, publish/sync reads live issue body through scripts/gh api and fails closed on substantive mismatch
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:publish-issue-body:literal-temp-path-regression
binding-type: cli-behavior
binding: a live issue body equal to a literal temp path or other non-draft mismatch is detected and reported as sync failure
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:publish-issue-body:mutation-audit
binding-type: cli-behavior
binding: publish/sync audit records the actual issue-mutation subcommand/argv class used for body sync
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Files in scope

- `.claude/skills/**` — canonical publish/create issue-draft mechanics and sync-only/full-publish invariants.
- `.cursor/skills/**` — mirrored entrypoints if the skill pointers or mirrored publish flow require alignment.
- `.claude/hooks/**` — publish-path guards if transport enforcement is implemented there.
- `scripts/**` — helper/runtime checks, publish harnesses, and focused regression tests.
- `tests/external-output-references/**` — only if a capture-backed publish/REST fixture is added.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`
- GitHub Issue #538 content itself, except as historical regression evidence
- Upstream GitHub CLI behavior changes
- AO worker/runtime implementation unrelated to draft publish/sync
- Worktree isolation itself (#304); this draft composes with it

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
.claude/skills/**
.cursor/skills/**
.claude/hooks/**
scripts/**
tests/external-output-references/**
```

## Acceptance criteria

1. **Sanctioned mutation path only.** The draft publish/sync flow for issue bodies uses only `gh issue create` / `gh issue edit` with `--body-file`; a focused regression proves no draft issue-body sync path reaches GitHub through low-level `gh api ... /issues ... body=...`.

```producer-emission
producer: orchestrator-pack
datum: publish-issue-body
expected: high-level-body-file-only
proof-command: planner-chosen focused publish/sync regression test
```

2. **REST parity gate.** After a body create/edit, the flow reads the live issue body through `scripts/gh api ... --jq .body` and compares it to the expected draft body before reporting success; a substantive mismatch forces non-zero failure even when the mutation command itself succeeded.

```producer-emission
producer: orchestrator-pack
datum: publish-issue-body
expected: rest-parity-gate
proof-command: planner-chosen focused publish/sync regression test
```

```positive-outcome
asserts: when a reviewed local draft is synced to GitHub, the publish path reads the live REST issue body and reports success only when the live body matches the local expected draft body after documented round-trip normalization
input: realistic
```

3. **Literal-temp-path regression caught.** A harness or fixture that simulates the June 2026 failure class — live issue body equals a literal temp path such as `@/tmp/...` instead of markdown draft content — is detected as a failed sync, with an operator-visible mismatch report naming the issue.

```producer-emission
producer: orchestrator-pack
datum: publish-issue-body
expected: literal-temp-path-regression
proof-command: planner-chosen focused publish/sync regression test
```

4. **Mutation audit trail.** The publish path records the actual issue-body mutation subcommand/argv class used by the run, sufficient to distinguish `gh issue create/edit --body-file` from any unsanctioned string/literal-path body mutation, without logging the full issue body.

```producer-emission
producer: orchestrator-pack
datum: publish-issue-body
expected: mutation-audit
proof-command: planner-chosen focused publish/sync regression test
```

5. **Sync-only and delegated publish both covered.** The same enforcement applies to the sync-only path and the delegated/full publish path; one path cannot pass while the other still reports false success on mismatch.

6. **Worktree-isolation composition preserved.** Existing delegated publish isolation guarantees from #304 remain green; this draft must not reintroduce live-tree body staging or a direct-`gh api` fallback that bypasses the isolated publish path.

7. **No newline-only false failure.** A round-trip difference limited to the permitted normalization boundary (for example, one trailing final newline) does not fail sync, while any substantive content drift still fails.

## Upgrade-safety check

- Pack-owned publish/sync surfaces only; no AO core or vendor edits.
- No new GitHub transport workaround that weakens #532 or normalizes low-level ad hoc issue-body mutation.
- No operator-facing runtime or YAML changes.
- The build adds enforcement and verification around publish success; it does not redefine the draft body format itself.

## Verification

- Reproduce the June 2026 class in a focused harness: expected body is markdown draft text, observed live body is literal `@/tmp/...`; assert non-zero sync failure and operator-visible mismatch report.
- Prove a successful sync path only after live REST body parity holds for the expected draft body.
- Exercise both sync-only and delegated/full publish flows against the same parity gate.
- Exercise the permitted normalization boundary so a single trailing newline or equivalent round-trip-insignificant presentation difference does not fail the gate.
- Confirm the audit output captures the body-mutation subcommand/argv class without logging the full issue body.
- Re-run existing delegated publish/worktree isolation regression coverage to confirm no bypass/regression relative to #304.
- Draft discipline before sync:
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/176-publish-issue-body-transport-and-parity.md`
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/176-publish-issue-body-transport-and-parity.md`
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/176-publish-issue-body-transport-and-parity.md`
- Before implementation closure:
  - `pwsh -NoProfile -File scripts/verify.ps1`
  - `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Design analysis (summary)

| Option | Cost | Risk | Sufficient? |
|---|---:|---:|---|
| A. Keep current instructions, rely on human verification after sync | Low | High false-success risk; repeats June incident class | No |
| B. Enforce high-level `gh issue create/edit --body-file` plus live REST parity gate and audit trail | Medium | Medium; must normalize round-trip noise without masking real drift | **Yes** |
| C. Permit low-level `gh api` issue-body mutations if they happen to work, without parity gate | Low | High transport drift and debugging ambiguity | No |
| D. Solve only by worktree isolation / delegate isolation (#304) | Already shipped | Does not constrain body transport or verify live body | No |

**Chosen:** B. Cheapest sufficient executor with acceptable risk: keep the high-level sanctioned transport, add a mechanical post-sync truth check against live REST state, and record enough audit to debug the next mismatch.

## Decisions

- The proven symptom is the live-body mismatch, not the exact June 30 mutation argv. The draft therefore fixes the whole class "wrong issue-body transport or post-sync body drift" instead of blaming one unretained command string.
- `#304` remains adjacent prior art, not the owner of this scope: isolation prevents live-tree clobber, but it does not prove that the body arriving at GitHub is the intended draft body.
- Parity enforcement is defined against live REST state because the GitHub Issue body is the worker-visible source of truth; local draft quality alone is insufficient.
