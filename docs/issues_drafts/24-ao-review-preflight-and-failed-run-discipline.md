# AO local review: workspace preflight and failed-run discipline

GitHub Issue: #60

## Prerequisite

- GitHub Issue #55 is **closed** (PR #56 on `main`): launch-safe `orchestratorRules`
  (no embedded `"` / inline `--command` lines) and the **REVIEW_COMMAND** naming
  pattern in `agent-orchestrator.yaml.example`. This issue extends **REVIEW_COMMAND**
  with a dependency preflight and tightens failed-run handling — it does not
  re-litigate quote safety.
- NO_FINDINGS pack-wrapper review contract (file
  `docs/issues_drafts/06-codex-reviewer-scope-context.md`) must remain intact — this
  issue must not change how the wrapper signals "no findings".
- Auto-fix loop convergence metrics (file
  `docs/issues_drafts/09-auto-fix-loop-convergence.md`) must remain intact — a failed
  review run must not be counted as a convergence/clean signal.
- Issue #11 autonomous review-loop contract (file
  `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md`) is the baseline
  for review statuses and orchestrator/worker roles; this issue amends only the
  preflight and failed-vs-clean clauses called out below.

## Goal

Stop empty or misleading local Codex review outcomes on Windows when AO runs the
pack wrapper inside `code-reviews/workspaces/op-rev-*` checkouts. Observed failure
(PR #56, 2026-05-28): five `ao review run` attempts produced **failed** runs with
`findingCount: 0` and no findings text — root causes were layered: (a) reviewer
workspaces without `npm ci` (`tsx` missing); (b) improvised PowerShell command
chains (`&&`, broken `if ( -ne 0)`) the orchestrator invented to add a preflight;
(c) the pack wrapper's `codex exec review` invocation is **incompatible with the
installed Codex CLI** — once dependencies were present (op-rev-5), the run still
exited 2 because the wrapper passes a base-ref scope **and** a custom prompt
together, which that CLI rejects as mutually exclusive; and (d) orchestrator/worker
reports treating zero findings on a failed run as a clean review. Preflight alone
does not fix (c): without it, even a clean reviewer workspace still fails. Make the
repository commit a **single canonical review command value** (including dependency
preflight), a wrapper review invocation that the installed Codex CLI actually
accepts, explicit **failed ≠ clean** rules, operator migration guidance, and a
regression guard so agents do not improvise variants.

## Binding surface

This issue commits the repository to:

1. **Canonical AO review command value (Windows).** The `orchestratorRules:`
   block in `agent-orchestrator.yaml.example` defines **REVIEW_COMMAND** as the
   full shell string passed to AO's review `--command` option at runtime. It MUST
   include a dependency preflight step before invoking the pack wrapper (e.g.
   `npm ci --include=dev` with a non-zero exit check) followed by the existing
   `review.ps1` / pack wrapper line. The literal MUST remain launch-safe per Issue
   #55: no ASCII `"` characters inside `orchestratorRules`, and no inline
   `--command` example lines inside the rules text.
2. **Failed-run discipline (orchestrator).** The same `orchestratorRules` block
   MUST state that `failed` and `cancelled` review runs are never treated as clean
   reviews, even when `findingCount` is 0. The orchestrator MUST read
   `terminationReason` from `ao review list --json`, MUST NOT call `ao review send`
   for failed runs, and MUST NOT report or infer that Codex review passed when the
   latest run failed.
3. **Worker discipline.** `prompts/agent_rules.md` gains a short section: workers
   MUST NOT invent alternate `ao review run --command` strings; only the
   orchestrator drives review with the canonical command from project config.
   Workers MUST NOT treat failed review runs or missing findings as review
   completion.
4. **Operator migration.** `docs/migration_notes.md` gains a subsection covering:
   (a) AO reviewer-workspace preflight (why `npm ci` is required before `review.ps1`
   in `op-rev-*` trees), (b) failed vs `clean` / `needs_triage` interpretation,
   (c) worker prompt-delivery launch failure on Windows (Issue #63) — AO inlines
   worker spawn prompts into the launch argv; failures show as `printf` /
   `command line is too long`, not issue-body quote content; `orchestratorRules`
   quote safety remains Issue #55 only, (d) the Codex CLI review-invocation
   compatibility constraint (base-ref scope and a custom prompt may be mutually
   exclusive on the installed CLI), and (e) the Windows reviewer sandbox requirement
   — the `op-rev-*` read-only sandbox must be able to spawn shell commands
   (operator-side Codex sandbox config), or Codex returns an empty review without
   inspecting the diff; this is operator environment, not pack code.
5. **Regression guard.** A check script (new or extended) fails CI/local verify when
   the runtime review command in `agent-orchestrator.yaml.example` (the **REVIEW_COMMAND**
   value AO actually passes to `--command`) is a bare `review.ps1` / wrapper-only
   invocation without a documented `npm ci` (or equivalent) dependency preflight in
   that same value. Preflight must live inside the one canonical **REVIEW_COMMAND**
   string (consistent with item 1), not as a competing separately-named command.
6. **Wrapper review invocation compatible with the installed Codex CLI.** The pack
   wrapper MUST build a `codex exec review` invocation that the Codex CLI version
   the pack targets actually accepts. The observed break: that CLI treats a base-ref
   scope and a custom review prompt as **mutually exclusive**, so passing both yields
   an argument-conflict exit (no findings produced). The wrapper MUST still scope the
   review to the base ref (the diff under review) AND deliver its review instructions
   to Codex — the planner chooses how to reconcile these within the CLI's contract
   (e.g. which option carries scope vs. which carries instructions). The invocation
   MUST NOT fail with a CLI argument-parse / mutual-exclusion error on a clean
   reviewer workspace. The exact flag layout is the planner's choice; do not hardcode
   a CLI version number in the contract beyond what verification needs.
7. **Reviewer wrapper ergonomics.** When the pack wrapper is invoked without
   resolvable `tsx` / `node_modules`, it exits with a clear, actionable message
   (install deps in repo-root / run preflight) instead of only `ERR_MODULE_NOT_FOUND`.

## Files in scope

- `agent-orchestrator.yaml.example` — extend **REVIEW_COMMAND** + failed-run clauses
  in `orchestratorRules` (preserve Issue #55 launch-safe form).
- `prompts/agent_rules.md` — worker review-command and failed-run discipline.
- `docs/migration_notes.md` — new subsection (AO review preflight + failed runs +
  the Codex CLI review-invocation compatibility note + the Windows reviewer-sandbox
  operator note: the `op-rev-*` read-only sandbox must be able to spawn shell
  commands, or Codex returns an empty review without inspecting the diff).
- `docs/issues_drafts/00-architecture-decisions.md` — new subsection **I** (or next
  letter) recording REVIEW_COMMAND preflight + failed ≠ clean (sync to Issue #3 in
  the same PR).
- `scripts/check-review-command-preflight.ps1` (new) or extend an existing verify
  script — planner's choice; wire into `scripts/verify.ps1`.
- `plugins/ao-codex-pr-reviewer/bin/review.ps1` and/or
  `plugins/ao-codex-pr-reviewer/lib/` — the Codex `exec review` invocation the
  wrapper builds (binding surface item 6) and the clearer missing-deps error
  (item 7); planner's placement, minimal change.
- `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` — this spec.

## Files out of scope

- Live `agent-orchestrator.yaml` (gitignored; operator merges from example +
  `migration_notes.md`).
- AO core / `vendor/**`.
- Changing AO's reviewer-workspace checkout layout (still AO-owned).
- GitHub Actions reusable Codex review workflow (already documents pack `npm ci`
  separately; may cross-reference only).
- Retroactive fix of past failed `op-rev-*` runs in local AO state.
- Operator Codex sandbox configuration (`~/.codex/config.toml`, e.g. Windows
  `[windows] sandbox`) — documented in `migration_notes.md` as environment guidance,
  not changed by this pack.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
code-reviews/**
```

Operator Codex config (`~/.codex/config.toml`) lives outside the repo and cannot be
fenced by a repo-relative denylist — it is addressed in prose under **Files out of
scope** and `migration_notes.md` only; workers must not attempt to edit it.

## Acceptance criteria

1. `agent-orchestrator.yaml.example` `orchestratorRules` contains a **REVIEW_COMMAND**
   value that includes both (a) a dependency preflight step and (b) the pack
   wrapper invocation, with no ASCII `"` in the literal (Issue #55 guard).
2. The same block explicitly forbids treating `failed` / `cancelled` runs as clean
   when `findingCount` is 0; it requires inspecting `terminationReason` before
   retry or worker handoff.
3. `prompts/agent_rules.md` forbids workers from improvising review `--command`
   strings and from reporting review success when `ao review list` shows only
   failed runs with zero findings.
4. `docs/migration_notes.md` documents all five binding-surface-item-4 topics: AO
   reviewer-workspace preflight, failed-vs-clean interpretation, worker
   prompt-delivery launch failure on Windows (Issue #63; not issue-body quote
   restrictions), the Codex CLI review-invocation compatibility constraint, and
   the Windows reviewer-sandbox spawn requirement.
5. A regression check wired into `scripts/verify.ps1` fails if `.example` regresses
   to wrapper-only **REVIEW_COMMAND** without documented preflight.
6. The pack wrapper's `codex exec review` invocation runs against an open PR on the
   reviewer's installed Codex CLI **without an argument-parse / mutual-exclusion
   error** from passing base-ref scope and a custom prompt together. Provable from a
   **direct** wrapper run: the wrapper process does not exit on a Codex CLI usage
   error and its stderr carries no CLI usage / `error:` argument-conflict text — the
   run reaches Codex and produces a review verdict. The run must also show it stayed
   **scoped to the base-ref diff** under review (not an unscoped whole-repo review) —
   e.g. the captured run references the base ref / the diff range, so dropping scope
   to dodge the CLI conflict does not satisfy this criterion. (The `ao review run`
   fields `terminationReason` / `status` are exercised by criterion 7, not here, since
   a direct wrapper run produces no AO review-run record.)
7. Manual verification (record commands and observed JSON fields in PR notes): from a
   clean AO reviewer workspace for an open PR, one `ao review run` against the worker
   session, run with the canonical **REVIEW_COMMAND** value supplied through AO's
   review `--command` option (REVIEW_COMMAND is a multi-token shell string — reference
   it as the documented value via a variable / config, not retyped or improvised
   inline), yields either `needs_triage` with `findingCount > 0` (then `ao review
   send` is valid) or `clean` with `findingCount: 0` and status `clean` — not
   `failed` with empty findings.
8. Issue #55 quote-safety guard (`scripts/check-orchestrator-rules-quotes.ps1` or
   successor) still passes on the updated `orchestratorRules` literal.
9. `docs/issues_drafts/00-architecture-decisions.md` has a new subsection recording
   the REVIEW_COMMAND-with-preflight + Codex-CLI-invocation-shape + failed-≠-clean
   decision, and the corresponding Issue #3 body is re-synced in the same PR (PR
   notes link the updated section and the Issue #3 edit).
10. When the pack wrapper is run without resolvable `tsx` / `node_modules`, it exits
    with a clear, actionable missing-dependency message (pointing at the preflight /
    repo-root install) rather than only a raw `ERR_MODULE_NOT_FOUND`. Provable by
    invoking the wrapper in a dependency-free checkout and capturing the message.

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`.
- No new AO YAML fields (`reviewer:` block remains invalid/ignored on 0.9.x).
- No new repository secrets.
- Preserves the NO_FINDINGS pack-wrapper review contract (file
  `docs/issues_drafts/06-codex-reviewer-scope-context.md`) and the pack wrapper's
  review verdict semantics — only the dependency preflight, the Codex CLI invocation
  shape, and operational discipline change.

## Verification

1. Run the new/extended regression check on `agent-orchestrator.yaml.example` and
   show pass; show it fails on a deliberate regression (wrapper-only command).
2. Run `scripts/check-orchestrator-rules-quotes.ps1` (or `scripts/verify.ps1`) after
   editing `orchestratorRules`.
3. Copy `.example` to a scratch `agent-orchestrator.yaml`, run `ao doctor`, show no
   new schema errors.
4. On a machine with AO + Codex auth configured, run one successful local review
   against a worker session with an open PR using the documented **REVIEW_COMMAND**
   (paste redacted `ao review list --json` showing `clean` or `needs_triage`, not
   `failed`).
5. Invoke the pack wrapper directly against an open PR's checkout and show the Codex
   run reaches a verdict — capture the wrapper's process exit and stderr and show no
   Codex CLI usage / `error:` argument-conflict text (criterion 6). The `ao review
   run` JSON path (`terminationReason` / non-`failed` status) is covered by step 4.
6. PR notes include a redacted example of a **failed** run JSON snippet (e.g. the
   prior CLI-conflict `exited 2` and `tsx` `ERR_MODULE_NOT_FOUND` cases) and confirm
   orchestrator rules text would not classify it as clean.
7. Run the wrapper in a checkout without `node_modules` and show it emits the clear
   missing-dependency message (criterion 10), not only a raw `ERR_MODULE_NOT_FOUND`.
