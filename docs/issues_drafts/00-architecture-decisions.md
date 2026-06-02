# 00 — Architecture decisions blocking #4–#9

GitHub Issue: #3

## Status

Approved 2026-05-26. Must be implemented as written before issues #4, #5, #6,
#9 begin. Issue #11 (test harness) may proceed in parallel and should land
before #4.

## A. Source of truth for declared scope

Two-level model.

### Issue body — task constraints

Authoritative for task-level boundaries. Written by a human or planner in the
GitHub Issue body using fenced blocks:

- `denylist` (**mandatory**, fenced as ` ```denylist `): list of relative
  paths/globs that no declaration may include.
- `allowed_roots` (optional, fenced as ` ```allowed-roots `): upper bound on
  declared paths. If absent, the declaration is free to declare any
  non-denylisted path.

### Declaration snapshot — committed PR artifact

Derived runtime state, committed to the PR as an iteration-bound immutable
artifact:

- Path: `docs/declarations/{issue_number}.{iteration_id}.json`
- A new iteration produces a new file. Initial snapshot is immutable except
  for the one allowed amendment within the same iteration; after that
  amendment, the file is frozen. A second amendment within the same
  iteration is rejected. Audit chain is preserved by retaining all snapshots
  for an issue.
- Mandatory metadata fields:
  - `issue_number` (number)
  - `iteration_id` (string)
  - `iteration_id_source` (`"ao_session" | "wrapper_generated"`)
  - `supersedes` (string | null) — previous `iteration_id` in the same chain
  - `created_at` (ISO 8601)
  - `baseline` (object, see D)
  - `declared_paths` (string[]) — normalized relative paths
  - `declared_globs` (string[])
  - `amendments` (array; first-write is empty; one amendment per iteration max)

### Runtime mirror — local guard only

`.ao/declarations/` is gitignored. It mirrors the latest committed snapshot
for the local guard. It is never the source of truth.

The runtime wrapper either reads the existing mirror file or regenerates it
from the committed snapshot in `docs/declarations/`. If both are missing for
the current `iteration_id`, the wrapper must refuse to proceed and emit a
clear "no active declaration" error.

### Amendment limit

One declaration rewrite per `iteration_id`. The rewrite is applied in place
to the snapshot file and recorded in its `amendments` array with
`{ previous_active_scope_hash, new_active_scope_hash, changed: { added,
removed }, reason, actor, timestamp, applied: true }`. After this single
amendment, the snapshot is frozen for the rest of the iteration. A second
rewrite within the same iteration is rejected without modifying the
snapshot. A new iteration resets the amendment counter and produces a new
snapshot file.

### Validation formula

```
PR diff                              ⊆ declaration.declared_paths ∪ declaration.declared_globs
declaration.declared_paths           ⊆ issue.allowed_roots          (when allowed_roots present)
declaration.declared_paths ∩ issue.denylist = ∅                     (always)
declaration.declared_globs analogously enforced
```

CI (#6) reads the committed snapshot from the PR head and the linked Issue
body, then enforces all three constraints.

## B. AO iteration identity

Primary: one AO session = one iteration. `iteration_id = ao_session_id`,
`iteration_id_source = "ao_session"`.

A new `send-to-agent` reaction (after CI fail / changes-requested) starts a
new iteration and produces a new snapshot file.

Fallback: if the wrapper cannot obtain an AO session id (API gap, version
mismatch, direct CLI invocation), it generates
`iteration_id = "wrap-{utc_timestamp}-{short_uuid}"` and records
`iteration_id_source = "wrapper_generated"`. Implementations must not block on
a missing AO session id.

The amendment counter resets at each iteration boundary.

## C. Guard layers

Three layers, in execution order:

1. **Agent wrapper — primary (first defense).** Wraps the AO agent invocation
   (cursor / codex CLI). After each agent turn, diffs the working tree against
   the active declared scope and refuses to proceed on violations. Lives in
   `plugins/ao-scope-guard/` (#5).
2. **Pre-commit hook — secondary local backstop.** Blocks commits when staged
   paths violate scope. Catches anything the wrapper missed (manual edits,
   agents that bypass the wrapper). Pre-commit alone is **not** sufficient: it
   runs after `git add` and only catches staged paths, not working-tree
   mutations. Lives in `plugins/ao-scope-guard/hooks/` (#5).
3. **CI PR diff check — third backstop, server-side.** Blocks merge when the
   PR diff exceeds the committed snapshot or violates issue constraints. Lives
   in `.github/workflows/scope-guard.yml` (#6).

No single layer is sufficient. The wrapper covers working-tree state, the hook
covers index state, and CI covers PR-merge state.

## D. Baseline state

The declaration's `baseline` field:

```json
{
  "commit_sha": "abc123...",
  "worktree_dirty": false,
  "active_scope_hash": "sha256:..."
}
```

- `commit_sha` — `git rev-parse HEAD` at declaration time.
- `worktree_dirty` — true if `git status --porcelain` reports any **tracked or
  untracked source path** that is not in gitignored runtime locations
  (`.ao/**`, `node_modules/**`, `dist/**`, build/cache dirs). The check is
  gitignore-aware. Mere presence of `.ao/declarations/` does not make the
  worktree dirty.
- `active_scope_hash` — SHA-256 of the canonicalized JSON of
  `{ declared_paths, declared_globs, issue_denylist, issue_allowed_roots }`.

If `worktree_dirty` is true at declaration time, the declaration is rejected
with an explicit error. The implementer must commit or stash pending changes
first.

## E. Shared code location

`plugins/_shared/` — pack-level shared code. Not a separately publishable
monorepo package at this stage.

Contents:

- path normalization (consumed by #4, #5, #6)
- declaration schema and validators (consumed by #4, #5, #6, #9)
- issue body parser (consumed by #4, #6, #9)
- common types

The pack uses a single root `package.json` with npm workspaces for
TypeScript plugin code. The initial tooling stack is fixed by #11. Plugins
reference `_shared` through that workspace. No npm publication of `_shared`
until cross-repo reuse is needed.

## F. Review paths, finding format, and auto-fix loop

Primary Codex review path is AO's local built-in review flow. The local path
runs `codex exec review` from AO, records findings in the AO dashboard, and
feeds blocking feedback back to the worker through AO reactions such as
`changes-requested -> send-to-agent` and `ci-failed -> send-to-agent`.

GitHub Actions Codex review is an optional alternative for external PR
visibility and reusable workflow consumers. It is not a separate source of
truth for the auto-fix loop. Both review paths must use the same scope context
and finding format.

Shared review artifacts:

- `prompts/codex_review_prompt.md` — one prompt contract for local and GitHub
  Actions Codex review paths. Created under issue #9.
- `_shared/issue_parser` — reads `denylist` and optional `allowed_roots`.
- `_shared/declaration_schema` — validates committed declaration snapshots.
- Snapshot reader — selects the active `docs/declarations/{issue}.{iteration}.json`.

Structured finding format:

```json
{
  "type": "scope-violation | spec | quality | test | ci | security",
  "code": "short-stable-machine-code",
  "severity": "blocking | non-blocking",
  "path": "relative/path/or/null",
  "summary": "one-line human-readable stable summary",
  "details": "optional longer explanation",
  "suggested_fix": "optional",
  "source": "codex-local | codex-github-action | ci | human"
}
```

`code` is mandatory and provides machine identity for recurring findings, for
example `scope-violation:path-outside-declaration`, `quality:unused-var`, or
`ci:failed-lint`. `summary` is for humans and must not be used as the primary
identity.

Finding signature:

```text
signature = sha256(type + "\n" + code + "\n" + normalized_path_or_empty)
```

Path normalization for signatures uses the same `_shared/normalize` contract as
scope validation. No fuzzy text matching, embeddings, or NLP similarity is part
of the convergence contract.

Auto-fix thresholds and escalation timing live in AO reaction configuration and
ledger/report configuration. Prompt rules may describe operational behavior but
must not duplicate numeric thresholds.

## G. AO local review preflight and failed-run discipline

AO local review runs in per-PR reviewer workspaces (`code-reviews/workspaces/op-rev-*`).
Those checkouts do not include `node_modules` until dependencies are installed.
The pack wrapper (`review.ps1` / `review.ts`) requires `tsx` from the reviewed
repo; **REVIEW_COMMAND** in `agent-orchestrator.yaml.example` MUST include a
documented preflight step (typically `npm ci --include=dev` with exit-code check)
before the wrapper line. Agents MUST NOT improvise alternate `--command` chains.

A review run with `status: failed` or `cancelled` and `findingCount: 0` is **not**
a clean review. Orchestrator and worker rules MUST inspect `terminationReason`
and MUST NOT treat zero findings alone as Codex approval. Only `clean` status or
successful triage/send paths count as review progress.

The pack reviewer wrapper MUST copy reviewer-process failure text (Codex stderr,
quota messages, missing-deps errors) into log lines AO records as
`terminationReason`, not only `codex exec review exited N`. Operators use
`scripts/orchestrator-diagnose.ps1` to list empty failed reviews and detect
`REVIEW_COMMAND` drift (GitHub Issue #75).

On Windows, the `orchestratorRules:` literal in `agent-orchestrator.yaml.example`
MUST stay launch-safe (no embedded `"` or inline `--command "` literals); see
Issue #55. Worker spawn uses a separate Cursor launch path; issue-body quote
content does not cause worker launch failure — see §I and Issue #63.

## H. Review trigger reconciliation and orchestrator turn delivery

Two coupled decisions, taken 2026-05-28 after the PR #56 incident: a worker was
mergeable but never reported `ready_for_review`; `ao review list` showed zero
runs and the orchestrator went `stuck` — review never started.

1. **Review triggering is state-derived, not worker-report-gated.** ~~The
   orchestrator MUST start a review run from the observable existence of an
   unreviewed open PR, not solely from a worker `pr_created` /
   `ready_for_review` report. The open-PR set and each PR's current head SHA
   are read from GitHub (the `gh` CLI); review-run coverage per head SHA is
   read from `ao review list --json`. A missing or delayed worker report MUST
   NOT be able to block review. This is a reconciliation (observe-and-converge)
   trigger, not an event/push trigger: it runs as part of the orchestrator's
   turn-opening inspection and adds no background process. (Issue #28 / #58,
   file `11-orchestrator-autonomous-review-loop.md`.)~~ **Superseded / rolled
   back 2026-05-30** after PR #97 split-brain: `ao spawn --claim-pr` from
   reconciliation while a live Cursor worker still held the branch caused
   duplicate workers. `agent-orchestrator.yaml.example` again uses **report-driven**
   review trigger only until a safer reconciliation design ships (see Issue #98
   for post-respawn review hygiene, not auto-spawn).

2. **The wake mechanism's strict no-polling invariant is relaxed for a
   low-frequency heartbeat.** Issue #39 (file
   `14-orchestrator-wake-mechanism.md`) originally committed the wake listener
   to being strictly event-driven (no scheduler, no polling). That invariant is
   **superseded**: a purely event-driven listener cannot give the orchestrator
   a turn during event silence — exactly the #56 failure mode — so a coarse,
   low-frequency heartbeat (order of tens of minutes) is now permitted. The
   heartbeat only delivers turns; it does not run the decision procedure
   itself, and it MUST stay independent of the webhook-receipt path so a single
   stoppage cannot silence both wakes. High-frequency / busy polling of `ao`
   state remains out of scope. (Issue #39 / #59.)

These compose: decision 2 guarantees the orchestrator gets turns even in event
silence. ~~Decision 1 defined what it does on each such turn (reconcile open PRs
against review-run coverage and trigger review). Neither was sufficient alone —
without the heartbeat the reconciliation never ran in silence; without
reconciliation the delivered turn had no state-derived trigger to act on.~~ With
decision 1 rolled back, heartbeat turns rely on report-driven review triggers and
other orchestratorRules discipline until reconciliation is re-specified. A
third, separate failure mode (the orchestrator alive but its Cursor PTY blocked
on a command-approval prompt) is handled operationally in the recovery runbook,
file `15-orchestrator-recovery-runbook.md`, not here.

## I. Worker prompt-delivery launch failure on Windows

Decision taken 2026-05-28 after repeated worker sessions (e.g. issue #60) exited
within ~1 minute of spawn with no PR while the orchestrator remained healthy.

1. **Root cause is upstream prompt delivery, not issue-body quotes.** AO
   `@aoagents/ao-plugin-agent-cursor` inlines worker prompts into the Windows launch
   command (`$(cat <file>; printf …)` under PowerShell). Signature A: `printf` not
   recognized and `unknown option '-ne'`. Signature B: `command line is too long`
   for large prompts (~24 KB observed). This is independent of `"` in GitHub Issue
   bodies; Issue #55 covers `orchestratorRules` only.

2. **Pack response is detection + documentation + escalation, not a core patch.**
   Named condition, `scripts/check-worker-launch-failure.ps1`, migration notes, and
   recovery-runbook routing. `AO_SHELL=bash` is documented as **not** a sufficient
   workaround (agent.cmd resolution and argv limit remain).

3. **Durable fix** belongs in ComposioHQ/agent-orchestrator / cursor agent plugin:
   pass worker prompt via file or agent flag; no POSIX `printf` on Windows.

See `docs/issues_drafts/25-worker-spawn-launch-safety.md` (Issue #63) and
`docs/migration_notes.md`.

## J. Tracked Claude review wrapper and strict review gate

Decision taken 2026-05-29 after PR #78 command drift: live **REVIEW_COMMAND**
pointed at gitignored `.ao/` while runs used forbidden bare `review.ps1` or Codex
`run-pack-review.ps1`, yielding `failed` runs with `findingCount: 0`.

1. **Claude executor is tracked beside Codex.** `scripts/run-pack-review-claude.ps1`
   mirrors `scripts/run-pack-review.ps1` CLI flags, npm preflight (stdout-safe), PR-head
   prompt via `AO_CODEX_REVIEW_PROMPT_FILE`, Claude `--print`, and pack parsing through
   `plugins/ao-codex-pr-reviewer` (NO_FINDINGS contract unchanged). Switching reviewers
   is a single **REVIEW_COMMAND** line swap between the two tracked basenames.

2. **Strict gate is fixture-default for CI.** `scripts/invoke-pack-review-strict-gate.ps1`
   evaluates committed AO-state fixtures in `verify.ps1` without `ao`, `gh`, or network.
   `-Live` and `scripts/orchestrator-diagnose.ps1 -Strict` share
   `Get-PackReviewGateViolations` in `scripts/lib/Get-PackReviewCommand.ps1` (basename
   parsing from YAML prose remains best-effort).

3. **Empty failed review and drift fail closed under `-Strict`.** `failed`/`cancelled`
   with zero findings is never clean; `terminationReason` must name the configured wrapper
   script, not bare `review.ps1` or the wrong `run-pack-review*.ps1`.

See `docs/issues_drafts/27-tracked-claude-review-and-strict-gate.md` (Issue #79).

## K. Orchestrator launch death and worktree hygiene

Decision taken 2026-05-30 after orchestrator `op-orchestrator` repeatedly reached
`detecting` / `stuck` on Windows while workers followed the Issue #63 runbook.

1. **Orchestrator launch failure is not worker-only routing.** Signatures A/B
   apply to the orchestrator PTY as well as workers. The recovery runbook decision
   table and `docs/migration_notes.md` (Issue #91) route operators to the correct
   session PTY; worker #63 docs remain authoritative for **worker** spawn death.

2. **Stale `orchestrator/*` worktree/branch is pack-side hygiene.** Repeated
   `workspace.branch_collision` after kill+respawn is cleaned with
   `scripts/orchestrator-worktree-preflight.ps1` before `ao start`, not attributed
   to vendor launch templates alone.

3. **Pack response:** detection fixtures, diagnose/preflight scripts, runbook
   amendment, sustained `wait-orchestrator-launch.ps1` poll — not AO core changes.
   Upstream durable fix remains agent-orchestrator#2072.

See `docs/issues_drafts/33-orchestrator-session-launch-death-and-worktree-hygiene.md`
(Issue #91).

## L. Deterministic reviewer selection (reviewer-agnostic entrypoint)

Decision taken 2026-05-30 after PR #84 executor drift: the orchestrator assembled
`--command` from rules prose and AO defaulted to built-in Codex when omitted.

1. **Single REVIEW_COMMAND.** `scripts/invoke-pack-review.ps1` is the only
   script basename in **REVIEW_COMMAND**; it does not encode `claude` or `codex`.

2. **Canonical selector.** `PACK_REVIEWER` (`codex` | `claude`) is the single
   operator-controlled source of truth. The entrypoint, strict gate (`-Live` /
   fixtures), and diagnose `-Strict` derive expected reviewer from this value
   (fixture field `expectedReviewer` in CI). Unset/unknown selector fails closed.

3. **AO layer unchanged.** Reviews still run via `ao review run --execute
   --command <entrypoint>`; per-reviewer wrappers remain dispatch targets only.

See `docs/issues_drafts/31-deterministic-reviewer-selection.md` (Issue #86).

## M. Operator adoption handoff (post-PR settings)

Decision taken 2026-05-30: merged PRs often ship operator-facing wiring in
`agent-orchestrator.yaml.example` and docs while live config, listeners, and
restarts stay stale — adoption was documented but not assigned to a role or
enforced at handoff time.

1. **Three roles.** Architect specs operator adoption in the issue draft when
   operator-facing surfaces change. Worker documents the same checklist in the
   PR (`## Operator adoption`, near the top) and in `docs/migration_notes.md`
   before `completed`. Operator executes the checklist after merge (live yaml,
   env, long-running scripts, `ao stop`/`ao start`).

2. **Workers document, not operate.** Listeners, secrets, and machine-local CLI
   config are operator-owned. Workers MUST NOT treat adoption as done silently.
   Optional live-yaml merge only in the primary checkout when the issue explicitly
   asks — never assumed from an AO worktree.

3. **Enforcement.** PRs that change `agent-orchestrator.yaml.example` MUST also
   change `docs/migration_notes.md` or carry the exact PR-body waiver
   `No operator adoption required`. `orchestratorRules` reminds the operator on
   merge-ready PRs to run the checklist from the PR.

See `docs/issues_drafts/35-operator-adoption-handoff-contract.md`.

## N. PACK_REVIEWER persistent-env fallback (review spawn)

Decision taken 2026-05-31 after op-rev-5 / op-rev-1 failures on PR #105 and #104: User-level
`PACK_REVIEWER=claude` was set, but AO review children saw an empty process-scoped variable and
`invoke-pack-review.ps1` failed closed in under one second.

1. **Same selector.** `PACK_REVIEWER` remains the only name and the only source of truth; values
   are still `claude` | `codex` only.

2. **Persistent-env read fallback.** When process-scoped `PACK_REVIEWER` is unset, the pack
   resolver consults operator-persistent environment layers (Windows User/Machine registry for
   the same variable) before fail-closed. Precedence: Process → User → Machine (User overrides
   Machine when process is unset). Non-Windows hosts keep process-only / fail-closed. This is
   not a second config file or YAML key.

3. **AO unchanged.** Reviews still use `ao review run --execute --command` with
   `invoke-pack-review.ps1`; upstream AO env injection is out of scope.

See `docs/issues_drafts/36-pack-reviewer-env-at-review-spawn.md`.

## J. AO-local review runs vs PR merge (post-merge terminal)

Decision taken 2026-05-31 (Issue #54, incident PR #53 / op-17): after human PR
merge, the worker session correctly reached `merged` and was torn down, but
`code-reviews/` entries for the same PR remained in `needs_triage` /
`waiting_update` and the orchestrator still attempted review-loop actions on wake.

1. **AO 0.9.x does not lifecycle-couple review runs to merge.** Worker merge
   cleanup removes the worker worktree/session; existing AO-local review runs
   persist until superseded by a new run on a different SHA or until upstream adds
   cancel/outdate-on-merge. Dashboard cards for merged PRs may look active; that
   is storage/UI persistence, not proof the loop is stuck.

2. **Pack policy is orchestrator inaction + operator docs, not core patch.** Live
   `orchestratorRules` (**MERGED PR — REVIEW LOOP TERMINAL**) require GitHub merge
   verification (`gh pr view` class), forbid `ao review send`, new `ao review run`,
   and review-loop ping/respawn on merged PRs, and treat linked PR merged as an
   EXIT from `waiting_worker_review_response`. Wake listener/filter unchanged:
   stateless filter cannot see merge state; suppression happens on the orchestrator
   turn. No `ao review cancel` in this pack — document upstream gap only.

See `docs/issues_drafts/21-post-merge-review-run-lifecycle.md` (GitHub #54).

## O. Review-layer resilience after worker respawn

Decision taken 2026-05-31 (Issue #98, incident PR #97): after worker respawn,
duplicate review runs, orphan triage on dead sessions, detached-HEAD `gh` failures,
and stale `code-reviews/workspaces` blocked merge.

1. **Run identity.** AO-local review runs are keyed to `(linkedSessionId, target sha)`.
   A respawned worker gets a new session id and inherits the PR claim but not prior
   run records on the dead session.

2. **Orphans are operator-owned.** AO does not auto-reap review runs when
   `linkedSessionId` terminates. Operators use `ao session claim-pr`, fresh
   `ao review run` on the live session, or manual UI dismiss for orphan triage.

3. **Idempotency is pack policy.** Before `ao review run`, `orchestratorRules`
   require checking `ao review list --json` for `running` / `reviewing` on the
   current PR head sha — not an AO core scheduler change.

4. **Detached-HEAD PR context.** The pack reviewer path resolves PR number via
   explicit env (`AO_PR_NUMBER`), `gh pr view <n>`, or open PR list filtered by
   `headRefOid` — never bare `gh pr view` or branch-only lookup in reviewer
   workspaces.

5. **Stale workspace preflight.** `scripts/reviewer-workspace-preflight.ps1`
   removes orphan `code-reviews/workspaces/op-rev-*` paths before retry when
   `worktree add … already exists` would otherwise fail the run.

See `docs/issues_drafts/34-review-layer-resilience-after-worker-respawn.md` (GitHub #98).

## P. Ubuntu / Linux-only port target

Decision taken 2026-06-01 after a live WSL2 Ubuntu polygon validated the pack
(pwsh runs all scripts; `verify` + `test-all` green; `ao doctor` healthy;
`ao start --no-orchestrator` boots the dashboard on the tmux runtime; `ao stop`
tears down cleanly). The pack moves off native Windows.

1. **Linux is the only supported target; WSL is the only Windows path.** Native
   Windows is no longer a runtime target — operators on Windows run inside WSL2
   Ubuntu. Windows-only code paths and `$IsWindows` branches are deleted rather
   than wrapped, to minimize bug surface. Windows PowerShell 5.1-specific
   hazards (e.g. the `orchestratorRules` launch-safety prose, §G/§I) no longer
   constrain the Linux-first config; pwsh 7 on Linux is unaffected.

2. **Same repository, one branch chain.** The port lands on `feat/ubuntu-port`
   merging into `main`, NOT a separate `orchestrator-pack-ubuntu` repo: a fork
   would duplicate scripts/rules/docs the `lint-self-architect` duplicate-literal
   rule guards against and split the live GitHub Issues queue (source of truth).
   One **Linux-first** `agent-orchestrator.yaml.example`; no parallel
   `windows.yaml.example`.

3. **Environment invariant: ext4, never `/mnt/c`.** Target repos and AO
   worktrees MUST live on the Linux filesystem (`/home/...`, ext4). `/mnt/c`
   reintroduces Windows file-locks, slow git/npm over 9P, and broken inotify
   watchers. After `$env:USERPROFILE` → `$HOME`, AO state lands on ext4
   automatically; only the clone path and `projects.*.path` need operator care.
   This invariant is operator-owned (lives in the gitignored live yaml + setup),
   not enforced by a tracked guard.

4. **Scripting language stays PowerShell; no bash rewrite.** Pack scripts remain
   `.ps1` run via `pwsh` on Linux. Bash glue is allowed only where a non-pwsh
   entrypoint is unavoidable (e.g. git hooks). A `.sh`-per-`.ps1` rewrite is
   rejected — it would duplicate logic and double the maintenance/test surface.
   See [[pwsh-keep]] (memory) for the validated rationale.

5. **Boundary: workers code, operators set up the environment.** Code changes
   (tracked files) go through AO workers in the normal PR flow, drivable from
   the still-Windows orchestrator during the transition. Environment
   provisioning, the live gitignored `agent-orchestrator.yaml`, and Ubuntu
   end-to-end validation are operator-manual and outside the worker/PR scope.

See `docs/issues_drafts/39-ubuntu-linux-only-port.md` (GitHub #115).

## Acceptance for this issue

- This document exists at `docs/issues_drafts/00-architecture-decisions.md`.
- Drafts #4–#11 reference these decisions where relevant (see updates in this
  same change).
- No production code is written under this issue.

## Out of scope for this issue

- Implementation of any plugin.
- Edits to AO core, `vendor/agent-orchestrator/`, or
  `agent-orchestrator.yaml`.
- Test framework selection (decided in #11).
