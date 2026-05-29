# Review: tracked Claude wrapper and strict review gate

GitHub Issue: #79

## Prerequisite

- NO_FINDINGS pack-wrapper contract (file
  `docs/issues_drafts/06-codex-reviewer-scope-context.md`, GitHub #9) -- must remain
  intact; this issue changes **where** the Claude executor lives and **how** operators
  detect failed/empty runs, not the finding format.
- AO local review preflight and failed-run discipline (file
  `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md`, GitHub #60)
  -- canonical `scripts/run-pack-review.ps1` (Codex) pattern and failed != clean remain
  baseline.
- Review: surface failed-run causes and block empty-review misread (GitHub #75,
  closed) -- diagnose drift detection exists but is WARN-only; this issue hardens it.
- Launch-safe `orchestratorRules` (Issue #55, closed) -- **REVIEW_COMMAND** stays a
  named line in rules text; runtime `--command` is passed only on the shell, not
  embedded quoted examples inside the YAML literal.
- AO 0.9.x CLI: `ao review list <project> --json` and `ao review run <session>
  --execute --command <shell>` are the operator read/invoke surfaces (confirmed on
  installed `ao` help).
- **CI context:** `scripts/verify.ps1` runs in `.github/workflows/scope-guard.yml` on
  every PR. There is no AO daemon, no `~/.agent-orchestrator/`, and no live `gh` in
  that job unless explicitly added later. Any gate wired into `verify.ps1` MUST pass in
  CI without them.

## Goal

Stop recurring **command drift** and **empty-review misreads** when the orchestrator
runs local PR review on Windows. Observed failure (PR #78, 2026-05-29): live
`REVIEW_COMMAND` pointed at a gitignored path under `.ao/`, but review runs used
forbidden bare `review.ps1` and Codex `run-pack-review.ps1` instead; both runs ended
`failed` with `findingCount: 0` while orchestrator rules already forbade those
commands. Root cause: discipline-only guards are insufficient -- the executor must be
**tracked in the repo** (visible in `op-rev-*` worktrees and CI) and **pre-merge /
operator gates** must **fail closed** when the latest run is failed/empty or
`terminationReason` names a script other than the configured **REVIEW_COMMAND**.

Deliver in **two PR-sized phases** (one GitHub issue, sequential merges) to limit
blast radius and keep scope-guard green after each step.

## Binding surface

This issue commits the repository to:

### Phase A (P0) -- tracked executor, no gate yet

1. **Tracked Claude review entrypoint (fixed basename).** A Claude Sonnet wrapper
   lives at `scripts/run-pack-review-claude.ps1` (new) -- intentional parallel to
   `scripts/run-pack-review.ps1` (Codex) so **REVIEW_COMMAND**, drift detection, and
   runbooks share one basename per executor; renaming would break those string checks.
   Behavioral contract (planner implements; do not read gitignored `.ao/` as source):
   - Same CLI flag surface as `scripts/run-pack-review.ps1` (`--repo-root`, `--base`,
     forward args such as `--pr-number` when supplied).
   - Dependency preflight with `npm` output **not** on stdout (AO treats review-command
     stdout as findings).
   - PR-head prompt from workspace `prompts/codex_review_prompt.md` when present.
   - Claude invocation and parsing through the existing pack reviewer path defined in
     GitHub #9 (`plugins/ao-codex-pr-reviewer`, `NO_FINDINGS`, structured JSON).
   - Symmetry with tracked Codex preflight wrapper is the reference implementation;
     operator `.ao/` bridges are out of scope and not visible in worktrees.
2. **Canonical REVIEW_COMMAND for Claude in example YAML.**
   `agent-orchestrator.yaml.example` documents a **relative** worktree command invoking
   `scripts/run-pack-review-claude.ps1`. Migration notes state gitignored
   `.ao/run-pack-review-claude.ps1` is deprecated (optional one-release forwarder only).
3. **Docs (Phase A subset).** `docs/reviewer-switch-runbook.md` and
   `docs/migration_notes.md` describe Codex <-> Claude as swapping one **REVIEW_COMMAND**
   line between the two tracked `scripts/run-pack-review*.ps1` entrypoints.

### Phase B (P1) -- strict gate + diagnose alignment

4. **Strict review gate with two invocation modes (not one ambiguous default).**
   - **Default / CI / `verify.ps1` path:** reads **committed fixtures only** (tracked
     JSON or equivalent under `scripts/` or `tests/`). Evaluates empty-review trap and
     command-drift rules against fixture `terminationReason` / run status fields.
     **MUST NOT** invoke `ao`, `gh`, network, or read `~/.agent-orchestrator/**`.
   - **Live / operator path:** explicit flag (e.g. `-Live` on the gate script, and
     `orchestrator-diagnose.ps1 -Strict` when AO is running locally) may call
     `ao review list --json` and `gh` as today's diagnose does. Document that live mode
     is for operators with a running AO daemon, not for scope-guard CI.
   - On violation: exit non-zero with a clear message (empty-review trap vs drift).
5. **Shared drift helper (best-effort basename).** Basename extraction from
   **REVIEW_COMMAND** in YAML uses the same helper as
   `scripts/lib/Get-PackReviewCommand.ps1` (regex over the prose `orchestratorRules`
   line -- best-effort, not a structured AO field). Gate and diagnose MUST share this
   helper; neither reimplements parsing. Docs note fragility if the rules format changes.
6. **`orchestrator-diagnose.ps1 -Strict`.** Under the same inputs as the gate (fixture
   or live), diagnose exits non-zero iff the gate would. Without `-Strict`, diagnose
   remains informational (WARN allowed). Live diagnose continues to require a running
   AO daemon; that is unchanged.
7. **Orchestrator / operator contract.** `agent-orchestrator.yaml.example` and
   `docs/orchestrator-recovery-runbook.md` require `orchestrator-diagnose.ps1 -Strict`
   (live) or the fixture gate before "ready for human merge". Worker rules unchanged.
8. **Docs and static guards (Phase B).** `docs/orchestrator-autoloop-go-live.md`,
   arch decision subsection, `verify.ps1` wiring, static check that example YAML does not
   use `.ao/` as primary **REVIEW_COMMAND**.

## Delivery phases (planner)

| Phase | PR focus | Merge before |
|-------|----------|--------------|
| **A** | `scripts/run-pack-review-claude.ps1`, example **REVIEW_COMMAND**, reviewer-switch + migration docs | Phase B |
| **B** | Gate script + fixtures, `verify.ps1` wiring, diagnose `-Strict` + shared helper, autoloop/recovery docs, arch decision | -- |

Phase A MUST merge and pass scope-guard before Phase B starts. Phase B PR is where
CI/offline fixture contract receives careful review.

## Files in scope

**Phase A**

- `scripts/run-pack-review-claude.ps1` (new)
- `agent-orchestrator.yaml.example` -- relative Claude **REVIEW_COMMAND**
- `docs/reviewer-switch-runbook.md`, `docs/migration_notes.md`

**Phase B (adds)**

- `scripts/orchestrator-diagnose.ps1` -- `-Strict`, shared gate helper
- `scripts/verify.ps1` -- wire gate **fixture default only**
- Gate script + committed AO-state fixtures; planner names under `scripts/` or `tests/`
- `scripts/lib/` -- extend `Get-PackReviewCommand.ps1` or sibling helper if needed
- `docs/orchestrator-autoloop-go-live.md`, `docs/orchestrator-recovery-runbook.md`
- `docs/issues_drafts/00-architecture-decisions.md` -- subsection (next letter)
- `docs/issue_queue_index.md` -- row already present

## Files out of scope

- Live `agent-orchestrator.yaml` (gitignored operator file).
- `.ao/**` -- not a spec source; optional operator forwarder documented only.
- `packages/core/**`, `vendor/**`, AO upstream schema or CLI changes.
- Issue #58 state-derived reconciliation (separate follow-up).
- AO project-level default for `ao review run --command` (upstream product gap).
- Calling `ao` / `gh` from the default `verify.ps1` gate path.

## Denylist

```denylist
vendor/**
packages/core/**
code-reviews/**
```

```allowed-roots
scripts/**
tests/**
agent-orchestrator.yaml.example
docs/**
```

## Acceptance criteria

### Phase A

- **Tracked Claude wrapper.** `scripts/run-pack-review-claude.ps1` exists and is
  invocable from an AO reviewer workspace with the same CLI flags as
  `scripts/run-pack-review.ps1`.
- **Example REVIEW_COMMAND.** `agent-orchestrator.yaml.example` uses a **relative**
  `scripts/run-pack-review-claude.ps1` line (not `.ao/...` as canonical).
- **Docs aligned (A).** Migration + reviewer-switch describe tracked-script switch.

### Phase B

- **CI-safe default gate.** `.\scripts\verify.ps1` runs the gate on fixtures only;
  passes on clean fixtures; fails on fixtures for `failed`+0, `cancelled`+0, and drift;
  completes with **no** `ao`, **no** `gh`, **no** network (scope-guard job).
- **Live gate flag.** Documented `-Live` (or equivalent) evaluates real AO state when
  the operator has a daemon; not invoked from `verify.ps1`.
- **Drift is hard fail.** Fixture (or live) where `terminationReason` names
  `review.ps1` alone or `run-pack-review.ps1` while **REVIEW_COMMAND** expects
  `run-pack-review-claude.ps1` exits non-zero.
- **Diagnose -Strict.** `orchestrator-diagnose.ps1 -Strict` agrees with the gate on the
  same fixture/live inputs; without `-Strict`, WARN-only drift remains allowed.
- **Shared basename helper.** Gate and diagnose use one helper; no duplicate regex.
- **No primary .ao REVIEW_COMMAND in example.** Static verify fails if example YAML
  canonical line points at `.ao/`.
- **Docs aligned (B).** Autoloop + recovery reference `run-pack-review-claude.ps1` in
  `terminationReason` when Claude is active.

## Upgrade-safety check

- No edits to Composio AO core or vendored `packages/core/**`.
- **scope-guard invariant:** `verify.ps1` on a clean checkout with no AO install MUST
  still pass after Phase B (fixture-only gate).
- Gate live preflight (`claude`/`gh` on PATH) only behind explicit operator flags.
- `orchestratorRules` literal stays free of embedded `"` per Issue #55.
- NO_FINDINGS / finding format (#9) unchanged.

## Verification

### Phase A

- **Static -- wrapper + example.** `Test-Path scripts/run-pack-review-claude.ps1`;
  example YAML shows relative Claude **REVIEW_COMMAND**; no `.ao/...` canonical line.
- **Smoke -- Claude review (operator).** `ao review run ... --execute --command` with
  tracked wrapper → `clean` or `needs_triage` with real findings, not `failed`+0;
  `terminationReason` references `run-pack-review-claude.ps1`.

### Phase B

- **Static -- verify / CI path.** `.\scripts\verify.ps1` passes on committed fixtures;
  corrupting a drift or empty-trap fixture fails verify; job does not invoke `ao`/`gh`
  (grep or documented contract in gate script header).
- **Static -- diagnose strict.** Fixture simulating PR #78-class drift:
  `orchestrator-diagnose.ps1 -Strict` exits non-zero; without `-Strict`, exits 0 with WARN.
- **Manual -- live flag.** Operator with AO running: gate `-Live` (or diagnose `-Strict`)
  detects a real empty failed run on an open PR.
- **Manual -- switch doc.** Codex <-> Claude by editing one **REVIEW_COMMAND** line only.
