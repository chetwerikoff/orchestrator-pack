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
   **Re-specified, scoped — 2026-06-04 (Issue #163, file
   `58-safe-review-trigger-reconciliation.md`)** after the PR #162 incident: a
   worker reported `ready_for_review` with CI green, but `opk-orchestrator` was
   `stuck`, so no second review run was triggered for the new head. Root cause:
   the mechanical, idempotent review trigger was coupled to the fragile actors
   it should not depend on (a worker report arriving, and the LLM-orchestrator
   taking a healthy turn). The re-spec restores the state-derived trigger but
   strips the unsafe behaviour that caused the rollback: it produces **only**
   `ao review run` for an uncovered head and is **forbidden any
   worker-lifecycle action** (no `ao spawn`, `--claim-pr`, `ao session kill`,
   or worker ping). Severing all worker-lifecycle effects is what makes
   re-introduction safe — the PR #97 split-brain came specifically from
   claiming/spawning a worker, not from triggering a review. It composes with
   the Issue #98 idempotency/stale-workspace preflight and stays low-frequency
   per Decision 2.

4. **Review triggering requires worker hand-off per head (Issue #195).** Decision
   taken 2026-06-05 after outdated review runs piled up when SHA-advance and #163
   reconciliation keyed only on coverage, not on `ready_for_review` for the exact
   head. **One canonical predicate — head ready for review** — gates all three
   trigger paths (report-driven, `ROUND PROGRESSION`, #163 reconciler): latest
   accepted `ready_for_review` for the current head, required CI green or genuinely
   pending (red defers; missing visibility → orchestrator degraded-CI branch), #189
   coverage, and failed/cancelled evaluated first. Uncovered-but-not-ready heads
   defer without reconciler lifecycle action; existing `report-stale` / ping /
   respawn backstops and #191 CI-green wake remain. Mechanical source:
   `docs/review-head-ready.mjs` (file `67-orchestrator-review-gate-on-handoff.md`).

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
reconciliation the delivered turn had no state-derived trigger to act on.~~ While
decision 1 was rolled back, heartbeat turns relied on report-driven review triggers
and other orchestratorRules discipline. With decision 1 re-specified (Issue #163),
the review trigger no longer depends on the LLM-orchestrator taking a turn at all:
the heartbeat remains the backstop for the orchestrator's *judgement* work, but
review triggering converges from state on its own low-frequency cadence. A
third, separate failure mode (the orchestrator alive but its Cursor PTY blocked
on a command-approval prompt) is handled operationally in the recovery runbook,
file `15-orchestrator-recovery-runbook.md`, not here.

3. **Finding delivery is confirmed sender-side, not assumed from `sent_to_agent`.**
   Decision taken 2026-06-04 after the PR #166 / opk-8 incident: a review run
   produced a finding, AO marked it `sent_to_agent` at 08:25:36, but the worker
   never transitioned to `addressing_reviews` — its terminal input channel was
   flooded (a dashboard terminal-mux re-init storm), so the injected message never
   started a turn, and the PR stalled "review sent, 0 open findings" with no fix.
   Root cause: `sent_to_agent` records only that a best-effort message injection
   was *attempted*, not that the worker received it. Decision: a pack-layer
   mechanism confirms delivery from observable worker progress (an
   `addressing_reviews`/equivalent report tied to the run, after the send), keyed
   at **run / PR-head granularity** (`ao review list <project> --json`; AO 0.9.2
   has no supported per-finding identity — consistent with the #140 Gate-0
   finding). On no confirmation within a bounded window it attempts bounded
   **best-effort** re-delivery to the linked session **only if that session is
   still live and owns the head** (else straight to escalation — never re-send into
   an orphan, the #98 class), performing **no** worker-lifecycle action (no
   `ao spawn`/`--claim-pr`/kill — the PR #97 split-brain invariant). **Escalation,
   not re-delivery, is the guarantee:** under the named corrupted-channel class,
   re-delivery through the same channel can deterministically fail, so the contract
   guarantees only that an unconfirmed delivery is detected and escalated, never
   silently dropped. This is a **separate** mechanism from Decision 1's
   review-run-only reconciler (whose zero-worker-contact invariant forbids the
   re-delivery this performs) and from Decision 2's wake supervision (a delivered
   turn is not a delivered finding). Restoring the channel itself (the DA-flood) is
   an upstream AO/dashboard concern, now filed as
   **ComposioHQ/agent-orchestrator#2094** and tracked pack-side by **Issue #173**
   (`62-terminal-flood-resilience.md`, detection + operator recovery,
   active-blocked-upstream); **Issue #174** (`63-review-ready-worker-stuck-guard.md`)
   keeps the flood-induced false `stuck` from costing a review-ready worker a
   respawn/kill. The 2026-06-04 recurrence on opk-10/PR #169 (finding from run
   `c134e976` injected as an unsubmitted paste, never picked up) confirmed both the
   flood and the delivery-loss class. (Issue #171, file
   `61-review-finding-delivery-confirmation.md`.)

4. **Narrowed no-pane-mutation exception: submit-only of AO-pasted draft (Issue #216).**
   Decision taken 2026-06-06 after opk-17/PR #214: AO-core `tmux.sendKeys` clears +
   pastes multi-line findings but a single trailing `Enter` does not reliably submit an
   idle worker's bracketed `[Pasted text]` draft; `sendWithConfirmation` mis-counts the
   visible draft as delivered. The flood/delivery family (#173/#174) otherwise holds
   **never mutate the worker pane.** This issue narrows that to one **submit-only**
   action: tmux `Enter` to the linked live head-owning session when #171's causal
   predicate is unmet, re-deliveries are exhausted, input freshness is established from
   state/events (no pane scraping), flood is quiet, and submit budget remains — then
   fail-closed to #171 escalation. **Permits:** one bounded Enter per `(runId, head SHA)`.
   **Forbids:** composing/editing finding text, `ao send`, spawn/`--claim-pr`/kill, pane
   scraping for content verification, or submit while #173 flood is active.

5. **Busy-worker Enter is queue-safe only behind auditable smoke evidence (Issue #293).**
   Decision taken 2026-06-13 after opk-61 / PR #289 showed a busy Codex worker accepted a
   programmatic-equivalent Enter as a queued submit instead of an interrupt. Therefore the
   arbiter no longer treats `isSessionStreaming` as a universal submit block: on a backend with a
   matching smoke marker, the first Enter is dispatched even while busy, retry is driven by
   settled consumption observation rather than by a pre-dispatch wall-clock budget, and at most
   one dispatch remains outstanding per delivery. Backends without a valid marker stay on the
   idle-only path plus the delivery-anchored backstop. Failed terminals are durable tombstones
   with machine-readable failed-delivery status, and late observed consumption reconciles that
   failure to `consumed` without a second Enter. **Upstream retirement:**
   **ComposioHQ/agent-orchestrator#2105** (sibling of #2094) should eventually retry/verify
   submit for multi-line pastes (as `send.js → sendViaTmux` already does) and must not treat a
   visible draft as delivery; the pack bridge retires when that lands. (Issue #293.)

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

## Q. Finding-routing eval queue sequencing (post Gate 0, AO 0.9.2)

**Context:** Gate 0 spike (2026-06-02, `ao` 0.9.2) confirmed production enactment of
`forward` / `backlog` / `drop` is **upstream-blocked** — capabilities A (selective send)
and A′ (terminal non-forward status via CLI, not UI-only `dismissed`) are both missing;
B (`prior_sent` at routing point) is also missing. Same class as §J / draft 38 (GitHub
#122): pack does not hand-edit `code-reviews/` or ship noops.

**Cost-rule sequencing (orchestrator-pack queue):**

| Draft | Role | Queue status |
|-------|------|----------------|
| `47-finding-routing-scorer-corpus.md` | Gold corpus + offline scorer on recorded routes | **Active** — build now; dataset supports upstream ask + same-day wiring when API lands |
| `50-finding-routing-selective-send-enactment.md` | Upstream issue + tracking (#122 discipline) | **Active (blocked upstream)** — Gate 0 done; deliverable is Composio issue link, not pack wiring |
| `48-finding-routing-bounded-edit-preflight.md` | Classifier edit hygiene | **Deferred** — valid offline, but promote path blocked |
| `49-finding-routing-live-behavior-gate.md` | Live judge accept vs gold | **Deferred** — tuning stand without deploy target is over-investment |

**Upstream — two tracks (2026-06-02 catalog):**

- **Preferred:** pipeline [#1631](https://github.com/ComposioHQ/agent-orchestrator/issues/1631)
  (`builtin/router`) + [#1346](https://github.com/ComposioHQ/agent-orchestrator/issues/1346)
  (`ao artifact dismiss|send`). Classifier = `command` stage with findings JSON stdout.
- **Legacy fallback:** [#2088](https://github.com/ComposioHQ/agent-orchestrator/issues/2088)
  for `ao review` 0.9.x only — do not design classifier architecture solely on this path.
- **Delivery prerequisites:** [#1943](https://github.com/ComposioHQ/agent-orchestrator/issues/1943),
  [#614](https://github.com/ComposioHQ/agent-orchestrator/issues/614) — `forward` requires
  observable skip reasons before prod accept.
- **Backlog sink candidate:** [#1494](https://github.com/ComposioHQ/agent-orchestrator/issues/1494).

Record Gate 0 + two-track table in [`docs/architecture.md`](../architecture.md#finding-routing-enactment--gate-0-ao-092-2026-06-02).

## S. Delegation policy fan-out (single source, thin pointers)

Decision taken 2026-06-04: the Coworker CLI delegation policy (#148) lives only in
`prompts/agent_rules.md`. Without fan-out, Codex, standalone Cursor CLI, and Claude Code
(architect) never see rules that AO injects only via `agentRulesFile`.

1. **Single canonical body.** Triggers, profiles, anti-delegation, reviewer carve-out, and
   provider-input fence are authored and maintained only in `prompts/agent_rules.md` (#148).
   No second authoritative copy in pointer surfaces.

2. **One thin pointer per entrypoint** (names the canonical path; does not paste ≥10 consecutive
   policy lines):
   - AO workers — `agentRulesFile` → `prompts/agent_rules.md` (injection, not a separate file).
   - Codex — [`AGENTS.md`](../../AGENTS.md) coworker delegation section.
   - Standalone Cursor CLI — always-applied [`.cursor/rules/`](../../.cursor/rules/) rule.
   - Architect (Claude Code) — [`CLAUDE.md`](../../CLAUDE.md) coworker delegation section.

3. **Advisory enforcement of a mandatory obligation.** Amended 2026-06-04 (#148 rewrite): read
   delegation is a **mandatory floor** — when an ask trigger fires, the corpus is fence-clean, and the
   work is not an excepted reasoning step, the worker **MUST** delegate the read rather than inline it
   on the reasoning model ("delegate I/O, keep reasoning" is the law, not an option). The MUST is a
   **prompt-level obligation**: enforcement stays advisory — the backstops are the worker's
   visible-delegation-outcome status, reviewer judgment, and operator observation. No
   `beforeShellExecution` or Claude Code hook mandates coworker use. "Mandatory" raises the default
   from *may* to *must*; it does not claim machine enforcement.

4. **Fence gates on sensitivity, not file origin.** Amended 2026-06-04 (#148 rewrite): the
   provider-input fence no longer restricts to *repo-originating* material. The two hard prohibitions,
   **regardless of origin**, are (a) secrets/credentials and (b) personal or third-party private data
   (unless the issue authorizes). Subject to those, this system's own out-of-tree operational evidence
   (runtime logs, process/tmux output, AO activity-DB query results) **is** sendable after the worker
   scrubs both classes and sends the minimal excerpt. **Rationale:** the prior origin fence blocked the
   highest-value cheap reads (bulk runtime logs during investigation), pushing heavy corpora onto the
   reasoning model — the exact waste the policy exists to prevent. **Residual risk:** widening the
   sendable surface to local operational data increases what can reach the third-party provider; it is
   mitigated by the two-class prohibition, the minimal-excerpt rule, "when in doubt treat as
   prohibited", and the visible-outcome backstop — not by a hard gate. Accepted as the cheaper-sufficient
   trade-off; revisit if a leak of non-secret-but-sensitive data is observed.

5. **Cursor index-coverage carve-out (Issue #309).** Amended 2026-06-16: Cursor workers reading
   tracked first-party source-code through the semantic code index owe no coworker read-delegation;
   out-of-index bulk (logs, diffs, external fetches, vendored/generated dumps, tracked non-code bulk)
   keeps the #255 triggers unchanged. Classification is by corpus source at stop-time audit, not by a
   runtime retrieval signal. Parity at the rule level is preserved: Claude/Codex have no index, so their
   source reads remain delegable; Cursor differs only where the index genuinely covers in-tree source.
   The #255 residual-non-compliance metric excludes `index-served` units like other non-delegable
   classes; mixed sessions stay measurable (depends on #264 reviewer-path denominator repair).

6. **Cursor-seat advisory floor (Issue #359).** Amended 2026-06-21: on the Cursor seat only,
   read-delegation for out-of-index corpus not already exempt by #309 (tracked non-code bulk,
   logs, external fetches, vendored/generated dumps) is **advisory (SHOULD), not a mandatory
   floor (MUST)**. Diffs keep the #337 direct-read carve-out and are not folded into advisory.
   Claude and Codex retain the mandatory floor unchanged. **Rationale:** empirical evidence
   (2026-06-19) on the weak Cursor seat (composer-2.5) shows the mandatory obligation yields
   evasion (`head`, chunked shell reads, coworker-as-`cat`) rather than cheap-model offload;
   mandating on this seat buys latency and workarounds, not compliance. The stop-time audit
   (#255/#309) records advisory Cursor reads under a distinct observable classification
   (not silently discarded like `index-served`), suppresses only the non-compliance finding,
   excludes them from the mandatory-delegable residual denominator, and tallies them under a
   separate advisory count. A **SHOULD** delegation ladder (`coworker ask`, then targeted
   `Read` with `offset`/`limit`) steers cost without re-mandating; shell read-arounds are
   recorded separately and do not register as ladder-satisfied.

See `docs/issues_drafts/53-delegation-policy-global-fanout.md` (GitHub #149) and
`docs/issues_drafts/52-coworker-cli-delegation-policy.md` (GitHub #148).

## R. Coworker RTK: passthrough-first adoption on worker hosts (Issue #145)

Decision taken 2026-06-04: optional [coworker RTK](https://github.com/Arcanada-one/coworker/blob/main/docs/rtk-plugin.md)
on AO **Cursor worker** hosts is **opt-in**, **passthrough-first**, and **host-global**.

1. **Worker-host scope.** Initial adoption targets machines running `defaults.worker.agent: cursor`.
   Orchestrator-only RTK enablement is deferred unless worker observation shows net benefit and the
   operator opts in separately.

2. **Host-global hook.** `coworker rtk enable` manages `~/.cursor/hooks.json` for **all**
   cursor-agent sessions on that host (orchestrator, workers, ad-hoc CLI). Per-session RTK
   toggling is not supported upstream; document the limitation, do not invent per-worker slicing.

3. **Additive passthrough.** Pack ships a tracked helper and manifest that apply **five pattern
   families** on top of coworker's 13 upstream defaults (`git diff`, `git log`, `gh pr checks`,
   `ao ` subcommands, `ao-declare` + `npx ao-declare`). The helper MUST NOT add or restore
   upstream entries; operator coworker version owns upstream defaults.

4. **Passthrough-first enable.** Operator sequence: `coworker rtk install` → apply pack helper →
   verify `coworker rtk passthrough list` (pack families) → `coworker rtk enable` → hook smoke.
   CI covers static manifest + merge preview only; effective hook smoke is operator acceptance.

5. **Adoption observation (not harness).** After enable, a **7-day** qualitative comparison on
   Codex findings, CI failures, and iteration churn (`continue` | `extend` | `disable`). Not
   shell-output proxy measurement; does not block worker PR merge.

6. **Disable rollback.** Primary rollback: `coworker rtk disable` — no routine manual
   `hooks.json` surgery.

7. **Measured net-savings follow-up (Issue #199).** Token-savings opportunity is sized with
   `rtk discover` and a repeatable inventory
   ([`docs/rtk-missed-savings-inventory.md`](../rtk-missed-savings-inventory.md)); optimise
   **net saved tokens on low-risk command shapes**, not adoption %. Source/caller attribution
   is **best-effort** — when `rtk discover` lacks a caller dimension, decisions use
   command-shape × risk-tier only. Medium-tier and existing §R.3 passthrough families are
   inventory/guidance-only unless a **kill-gate go** authorizes work. Touching the broad
   `ao ` passthrough requires a pinned **field-preservation test** (CI via existing verify
   entry points) plus fixture-refresh / schema-snapshot before narrowing; never blanket
   `ao` removal. Current kill-gate record: **no-go** — low-risk guidance + inventory method
   only; broad `ao ` remains in the tracked pack manifest until a future go.

See [`docs/coworker-rtk-runbook.md`](../coworker-rtk-runbook.md).

## T. RCA and spec discipline against misdirected fixes (Issue #221)

Decision taken 2026-06-06 from the #212→#218 post-mortem (review auto-trigger took
four fix cycles because each cycle diagnosed defer logs / decision records instead
of the observed symptom and validated against fixtures that invented fields AO never
emits).

1. **Positive-outcome acceptance.** Action-producing specs MUST declare
   `behavior-kind` and include at least one `positive-outcome` criterion on
   realistic input. External-tool inputs require `capture-backed` or
   `sample-backed` provenance. Enforced by `scripts/check-draft-discipline.ps1`
   plus a taxonomy backstop (`scripts/draft-discipline-action-taxonomy.json`).
   Authoring surfaces: `create-issue-draft`, `publish-issue-draft`,
   `prompts/agent_rules.md`.

2. **Recurrence diagnostic.** When a bug is reported as already fixed, the root-cause
   procedure's first step is re-running the prior fix's acceptance check. `pass +
   reproduce` is strong evidence of spec/fixture defect, not an exclusive verdict.
   Investigation surfaces: `prompts/investigate_root_cause.md`,
   `investigate-root-cause` skill.

3. **5-Whys stop condition.** "Returned/logged X" and imprecise defer/decision
   records are not terminal root causes; continue to field/contract facts.

4. **No parked roots.** Deferring a suspected root cause requires a
   `parked-root-cause` structured block and an on-topic tracking issue whose body
   carries the declared cause. Enforced mechanically on publish.

5. **Surface map + consistency check.** `scripts/rca-spec-discipline-surfaces.json`
   lists each rule's loader files; `draft-discipline surfaces` verifies markers
   and generated `.cursor/skills/` pointers.

Planner freedom preserved: rules constrain *what must be true*, not file names or
library choices. Companion mechanical guard for golden-sample field shapes: draft
#76 (independent merge order).

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

## U. CI-failure notification dedup on observable reaction send (Issue #283)

Decision taken 2026-06-13: the pack's turn-driven CI FAILURE DISCIPLINE no longer dedups on
an imagined successful `ao send` event. It invokes a deterministic repo-side predicate
(`scripts/ci-failure-notification.ps1` -> `docs/ci-failure-notification.mjs`) whose terminal
action is exactly `SEND` or `SUPPRESS`.

1. **Observable suppression basis.** A built-in `ci-failed` reaction suppresses the
   orchestrator ping only when a `reaction.action_succeeded` event with
   `reactionKey=ci-failed` binds to the full episode identity `{repo, PR, head SHA,
   aggregate red-period, active target}`. No-match and unbindable reaction states are audit
   diagnostics, not live actions.
2. **Exact-key episode identity.** The active target and aggregate red-period discriminator
   are first-class key components. Same-SHA red→green→red is a new episode; per-check attempt
   churn while aggregate CI stays red is not. Sibling PRs and superseded sessions cannot
   cross-suppress.
3. **Write-ahead at-most-once token.** When the orchestrator is the sole notifier, it must
   atomically claim an exact episode-keyed intent token before sending. Existing token means
   suppress, including ambiguous post-crash state. Observable send failure is not ambiguous:
   release for bounded retry or mark failed-owned and escalate.
4. **Live wrapper contract and adoption.** The supported runtime is pwsh 7+ / WSL2. The live
   daemon must invoke the tracked wrapper from the repo root with a timeout and then obey the
   binary verdict. Operator adoption is two-phase: tracked surfaces merge first; live
   gitignored config is then updated/restarted and proven with a redacted active-daemon
   artifact that pins rule fingerprint, repo identity, git SHA, wrapper identity, helper hash,
   and a dry-run verdict.
5. **Residuals.** Reverse-order duplicate (orchestrator first, then unconditional daemon
   reaction) remains out of scope. The rare at-most-once lost-ping case is acceptable only if
   `report-stale` or a named backstop is verified to surface the idle/uninformed worker;
   otherwise the residual is recorded as not fully bounded.

## V. Reviewer coworker contract-mapping pass (Issue #362)

Decision taken 2026-06-20: extend the restored reviewer bulk-diff coworker recipe
with a **conditional second contract-mapping ask** when an authoritative task spec
with testable acceptance criteria is available. This **does not** revive
#337 (diff-read-directly-not-delegated); summarization stays delegated on large
diffs and final review judgment stays on the main reviewer.

1. **Two-pass reviewer reads.** Keep the existing >200-line diff summary ask.
   Add a separate mapping ask only when preflight proves complete scrubbed diff +
   contract-bearing spec sections fit the provider/input boundary.
2. **Executable preflight owner.** `scripts/invoke-reviewer-contract-mapping.ps1`
   (TS library under `scripts/lib/`) owns artifact finalization, finalized-file
   hashing, structured status assembly, and coworker suppression on preparation
   failure — not prompt prose alone.
3. **Candidate evidence only.** Coworker mapping output is an exhaustive per-criterion
   ledger of **candidate** gaps; severity, approval/rejection, and final verdict
   remain non-delegable. Artifacts are untrusted data; embedded instructions cannot
   expand paths or authorize commands.
4. **Bounded fallback vocabulary.** One status enum per attempt (`mapped`,
   `skipped_*`, `stale_*`, `ambiguous_spec`, `artifact_prep_failed`, etc.) with
   deterministic precedence; mapping never blocks review availability.
5. **Binding.** Task references resolve only from explicit review context, unique
   closing keyword, or unique declaration/scope issue; ambiguous/conflicting refs
   yield `ambiguous_spec`. Summary, mapping, direct inspection, and verdict bind
   to one PR head SHA and spec snapshot hash.

