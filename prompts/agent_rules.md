# Agent Rules

These rules are intended to be injected through Composio AO `agentRulesFile`.
They must be portable across AO-supported agents and must not rely on local
`ai-orchestrator` internals.

## First action (AO pickup)

After reading the initial task prompt, your **mandatory first action** in the
AO worktree is:

```powershell
ao acknowledge
```

Run this within **60 seconds** of session start — before `ao-declare`, file
edits, research, commits, or PR work. AO's `reportWatcher` treats a missing
pickup as `no_acknowledge` and marks the session `stuck` while the process is
still alive.

Skipping acknowledge blocks the orchestrator review loop and may trigger
operator recovery or session kill per
[`docs/orchestrator-recovery-runbook.md`](../docs/orchestrator-recovery-runbook.md).

## Local Codex review (active)

Local Codex PR review **is active** in this pack. AO drives it through the
first-class `ao review` CLI (`run`, `send`, `list`, `execute`). Wiring lives in
`orchestratorRules` in `agent-orchestrator.yaml`. Discover runs via
`ao review list <project>` and the AO dashboard.

Review uses Codex CLI with `gpt-5.5`. On AO 0.9.x, a `reviewer:` YAML block is
silently ignored (parsed without error; no code path reads it) — use
`orchestratorRules` and configured AO/plugin/CI review paths, not invented YAML
fields.

See also: [`README.md`](../README.md#local-codex-review-active),
[`docs/architecture.md`](../docs/architecture.md#review-paths).

## Tracker and role policy

- GitHub Issues are the task source of truth for this pack's AO setup.
- Treat every GitHub Issue assigned to AO as the task specification.
- Link every branch and PR back to its source issue; PR bodies must include
  `Closes #N`, `Fixes #N`, or `Resolves #N` for the task issue.
- Put the closing reference in the **first few lines** of the PR description
  (immediately under `## Summary`), not only at the end of a long body. Scope
  guard reads the full body via `gh`; early placement avoids operator confusion
  when debugging CI.
- If **PR scope guard** fails with `missing_issue_link` but the PR already shows
  `Closes #N` in GitHub, re-check the closing line is present and re-run CI — do
  not broaden scope or rewrite the declaration to bypass the guard.
- Planning and coding sessions are expected to run through the Cursor CLI agent
  unless the AO config explicitly overrides the role.
- Do not use Vibe Kanban or Linear unless the config explicitly changes the tracker.

## Scope discipline

- Do not touch files outside the declared active scope.
- Every task must contain either:
  - an explicit file/path scope, or
  - a denylist that is validated before work starts.
- Treat broad directory declarations such as `src/**` or `**/*` as suspicious.
  Narrow them before editing unless the task explicitly justifies the breadth.
- Normalize paths relative to the repository root before comparing them to scope.

## Before commit

Before staging or committing, compare modified and staged paths with the active
scope:

- inspect changed files with the repository's normal git status/diff commands;
- verify every modified path is allowed and not denied;
- stop and request/record a scoped amendment if any path is outside scope;
- do not rely on PR CI as the first scope check.

## Queued task specs

- Do not delete queued task specs unless the deletion itself is explicitly in
  scope.
- Do not rewrite another task's declaration to make the current diff pass.
- If a task declaration needs to change, record one amendment for the current
  iteration and keep the previous baseline auditable.

## Shared source of truth

- If the same literal, prompt, path, policy, or command is needed in two places,
  first extract a single source of truth.
- Avoid paired script/template edits that can drift. Prefer generating one from
  the other or referencing the same data file.
- Do not duplicate safety-policy prompt text across agents when a shared prompt
  file can be referenced instead.

## Upgrade-safe AO usage

- Prefer plugin, config, prompt, wrapper, hook, or CI extensions over AO core
  patches.
- Do not edit upstream `packages/core/` to satisfy a task.
- If upstream behavior appears missing, write a contract or wrapper first and
  escalate the need for a proper plugin/API only after confirming the gap.

## Coworker CLI delegation

Operating principle: **delegate I/O, keep reasoning**. Bulk reading and summarising
go to the cheap model via the external `coworker` CLI (`coworker ask`, `coworker
write`); analysis, judgment, and conclusions stay on the reasoning model. Where this
section applies, that split is **mandatory** wherever there is no critical quality
loss — not an optional optimisation. `coworker stats` is optional for cost
observability. This policy covers `coworker` only; it does not replace in-session
subagent / Task delegation rules when those are present. For the broader cost ladder,
see
[`docs/first_principles_5_operational_framework.md`](../docs/first_principles_5_operational_framework.md).

**Pickup before shell-out.** Run `ao acknowledge` (see **First action**) before the
first `coworker` invocation in the session — same ordering as other implementation
work.

**Mandatory profiles.** Every `coworker ask` MUST pass `--profile code` (fixed; no
per-task override). Every `coworker write` MUST pass `--profile write` unless the
task issue explicitly names a different profile. Do not rely on operator or upstream
CLI defaults.

**Upstream file gate.** Default corpus for `coworker ask` and context for
`coworker write` is text/markdown only. Source-code input requires `--allow-code`
or `COWORKER_ALLOW_CODE=1` per upstream coworker — use only when the task explicitly
requires code at the cheap provider; do not bypass the gate to force delegation on
undeclared code.

**Provider-input fence (sensitivity-gated, not origin-gated).** Material sent to the
external provider — `coworker ask` corpus and `coworker write` context — MUST NOT
include either class, **regardless of file origin**:

- **Secrets/credentials** — API keys, tokens, passwords, private keys, auth
  headers/cookies, raw `.env` values, or any string that grants access.
- **Personal or third-party private data** — PII, customer/end-user data, and
  private content belonging to anyone other than this system's own operation, unless
  the task issue explicitly authorizes it.

Subject to those prohibitions, **origin is not a gate**: any non-secret, non-personal
material the task needs is sendable — tracked repo files, repo-derived `git diff` /
`git log` / working-tree output, **and** this system's own out-of-tree operational
evidence (runtime logs, process/tmux output, AO activity-DB query results, and
similar local diagnostic captures). Internal operational detail (hostnames, paths,
session IDs, our own reviewer findings) is not prohibited. Because logs and dumps
routinely carry prohibited material, you are **accountable for the scrub** before
shell-out: confirm the material is free of both prohibited classes, redact first, and
send the **minimal excerpt** the question needs — not whole files wholesale. When in
doubt, treat the material as prohibited (redacted excerpt or keep that portion on the
reasoning model). The `--question` / `--spec` prompt is worker-authored task text and
obeys the same prohibitions; it need not be a repo file. `coworker ask` performs no
edit — its corpus may span repo context and permitted out-of-tree evidence beyond the
editable declared scope under this fence. `coworker write --target` is an edit: every
`--target` MUST stay inside the active declared scope.

### Read delegation (`coworker ask`)

When **at least one** ask trigger below holds **and** the corpus can be made
fence-clean **and** the work is not an excepted reasoning step (below), you **MUST**
route the read through `coworker ask --profile code` rather than inline it on the
reasoning model. Read delegation is a **floor**, not a ceiling: triggers bound when
delegation becomes mandatory; they are not permission to decline for convenience.
This MUST is a **prompt-level obligation** with **no hard hook** — backstops are
visible delegation outcome (below), reviewer judgment, and operator observation.

**Bounded fallback.** Fall back to deterministic in-session reading — and **state the
reason** in your final status — only when: `coworker` is missing, unavailable, or
rate-limited; or the corpus cannot be made fence-clean (secrets or personal/third-party
data cannot be scrubbed without losing the needed signal). Cost/size is **not** a
fallback ground once a trigger holds.

Ask triggers (any one is sufficient; count **all** corpus you would otherwise read on
the reasoning model, including out-of-tree operational evidence, subject only to the
provider-input fence):

- Combined corpus for one question is **more than 600 lines** across all paths in that
  invocation.
- **3 or more files** under one question (same `coworker ask` call).
- Diff or log material to summarize is **more than 200 lines**.
- Bootstrap read of **2 or more** config/doc paths that together total **more than 600
  lines** (or each path is **more than 200 lines**) where bulk read is the work, not
  synthesis.

### Write delegation (`coworker write`)

Delegate `coworker write --profile write` only for **primary drafts**:

- README, install docs, configuration reference (first cut).
- Standard boilerplate: LICENSE, `.gitignore`, CI workflow yaml skeletons.

Every `--target` MUST be inside the active declared scope. Any context/input obeys the
provider-input fence above. Do not use `coworker write` for iterative refinement of
in-scope implementation code. Delegate only when the target does **not** exist yet, or
the task issue explicitly authorizes replacing that file. Upstream `coworker write`
truncate-writes by default — do not overwrite an existing README, LICENSE, `.gitignore`,
or workflow file unless replacement is in scope. Prefer `--stdout` and apply the diff
yourself when the target already exists.

### Excepted reasoning steps (not whole tasks)

The closed list below governs the **reasoning/output step**, not the task category. A
task that contains an excepted *step* may still have delegable *reading*. None of
these items is a cost or volume threshold — a fired ask trigger is not overridden here.

Keep on the reasoning model (independent of corpus size):

- The **analysis, conclusions, and judgment** of debugging, root-cause analysis,
  race reasoning, and safety-critical logic. (The *reading* that gathers evidence is
  I/O — delegable whenever an ask trigger fires and the corpus is fence-clean.)
- Architectural decisions and trade-off reasoning.
- Edits requiring **exact line numbers** or surgical diffs in existing code.
- Inferring user intent or clarifying ambiguous requirements.
- **Review reasoning** — producing or shaping PR-review findings (correctness,
  security, race, logic). The review path — canonical **REVIEW_COMMAND**,
  **PACK_REVIEWER**, and the pack review wrapper it dispatches — MUST NOT be routed
  through `coworker`. Nothing backstops reviewer judgment; “delegate I/O, keep
  reasoning” does not license cheap review.

**Worked example.** Root-cause work must read ~900 lines across `prompts/agent_rules.md`,
a config file, and a runtime log. The 600-line and 3-file triggers fire. **Correct:**
scrub the log fence-clean, then `coworker ask --profile code` extracts/summarises the
minimal needed excerpt; you reason over the cheap-model summary and write the
root-cause conclusion yourself. **Wrong:** label the whole task “root-cause” and inline
all 900 lines — the reasoning exception does not cover the reading.

### Ordering

- When **no** ask trigger is met, use deterministic repo tools (search, read, diff,
  tests) **instead of** `coworker ask` — do not delegate (CLI overhead exceeds benefit
  below the floor). In this sub-threshold zone, work estimated **under 2000 tokens** of
  real work stays in-session for the same reason; that heuristic **cannot override** a
  fired ask trigger.
- When an ask trigger **is** met and the corpus is fence-clean and the work is not an
  excepted reasoning step, delegation is **mandatory** — do not inline the read on the
  reasoning model.
- Your final status **states the delegation outcome**: either that `coworker` was used
  for the bulk repo/log read, or the closed-list reason it was not (below the floor /
  excepted reasoning step / corpus not fence-cleanable / `coworker` missing,
  unavailable, or rate-limited). Silence is non-compliant.

**Accountability.** You remain responsible for verifying coworker output, scope,
commits, and AO transitions. `coworker` must not run `ao-declare`, `ao report`, or
open PRs.

## RTK read-exploration (low-risk shapes; Issue #199)

On hosts with coworker RTK enabled, noisy read-only shell (`grep`, `find`, `cat`, `ls`,
`wc`, `head`, and similar exploration where exact bytes are not decision-bearing) is a
primary missed-savings opportunity — see
[`docs/rtk-missed-savings-inventory.md`](../docs/rtk-missed-savings-inventory.md).

**For reads, prefer this agent's dedicated file tools** (`Read`, `Grep`, `Glob`, and
equivalents on your entrypoint). **Reach for RTK shell wrappers only for raw shell that is
genuinely needed** (pipelines, flags, or binaries without a first-class tool). Do not chase
RTK adoption percentage; optimising net saved tokens on low-risk shapes is the goal.

**Never compact** output that may carry secrets/credentials, private logs, raw declaration or
scope file contents, or exact-byte decision-bearing config — regardless of command family.
`ao` control/signal commands, `git diff`, and `gh pr checks` stay verbatim per §R passthrough;
do not route them through RTK compaction.

Architecture: §R.7 in
[`docs/issues_drafts/00-architecture-decisions.md`](../docs/issues_drafts/00-architecture-decisions.md).

## Required CI (CI green)

Worker `ready_for_review`, orchestrator CI pings, and operator recovery docs use
**one** definition of which checks must pass:

- **Preferred:** GitHub **required status checks** for the PR's base branch (branch
  protection), when configured for this repository.
- **Fallback:** when branch protection does not list required checks, **all checks**
  reported for the PR head that belong to this pack's merge contract — workflow
  `scope-guard` jobs such as **Verify orchestrator-pack structure**, **PR scope
  guard**, **Run pack contract tests**, and **Self-architect lint** (see
  `.github/workflows/scope-guard.yml`) — not every optional or third-party check on
  the PR unless the repo already treats them as merge-blocking.

Inspect with `gh pr checks <pr>` (or equivalent) against the **current PR head**.
Do not treat the PR as CI-green while any required check is `fail`, `pending`, or
missing for that head.

## Worker CI gate (`ready_for_review` and self-fix)

**Self-fix is primary;** orchestrator `ao send` on red CI is recovery when the worker
has gone idle — not a substitute for fixing CI yourself.

- Do **not** run `ao report ready_for_review` (or treat the task as done) while
  required CI for the PR head is not green per the definition above.
- **Before** every `ao report ready_for_review`, check required CI for the **current**
  head; if any check is red or still running, stay in or move to
  `ao report fixing_ci` — then act per the check state below. A `ready_for_review`
  that validated an earlier head which has since moved is **stale** and does not
  satisfy the obligation; re-check the current head and re-report.
- **Red CI:** fix — push, re-run local verification, keep reporting `fixing_ci` as
  needed; do not go idle on a red-CI PR expecting the orchestrator to drive the fix
  unless you are blocked.
- **Pending CI (still running):** stay in or move to `ao report fixing_ci` **and
  remain actively engaged** — monitor required CI for the current head until it
  reaches green (`ready_for_review`), red (fix path above), or degraded-CI escalation
  (see **PR created hand-off**). Filing `fixing_ci` on a merely-pending head is the
  required non-silent action; it is **not** a stopping point. Do **not** treat "CI is
  still running", "I filed `fixing_ci`", or "done editing while CI runs" as
  permission to go idle or treat the task as done.
- If CI was green when you reported but fails on a later push, or you discover red CI
  after reporting `ready_for_review`, immediately `ao report fixing_ci` and fix
  **without waiting** for `ci-failed`, `report-stale`, or operator ping.

## Event-driven review trigger (Issue #207)

**Orchestrator LLM turns remain a valid first-review path;** the wake listener's
`merge.ready` completion-wake handler is the low-latency trigger when a worker hands off
a review-ready head (AO 0.9.x emits no dedicated `ready_for_review` webhook).

On `merge.ready` (approved-and-green), `scripts/orchestrator-wake-listener.ps1` evaluates
HEAD READY FOR REVIEW (#195) and covered-head dedupe (#189), then may `ao review run`
**before** forwarding the merge-intent wake. The periodic `review-trigger-reconcile.ps1`
(#163) and heartbeat remain backstops. Merge handling on that wake must **re-read** review
run state afterward — a wake annotated `mergeable=false` is not permission to merge on a
stale approved-and-green snapshot while review is in-flight / `needs_triage`.

- This path issues **review run only** — never `ao spawn`, `--claim-pr`, `ao session kill`,
  `ao send`, or merge.
- Seconds-level convergence applies only when a completion wake actually reaches the
  listener; pending CI with no wake still converges via CI-settle wake or the backstop.
- The listener is a **side-effecting** supervised child (draft #71 registry); restart
  waits for in-flight `ao review run` to finish or fail closed.

## Deferred-head review re-evaluation (Issue #235)

**Orchestrator LLM turns and the periodic reconcile remain valid paths;**
`scripts/review-trigger-reeval.ps1` closes the wake-before-readiness ordering race.

When a completion wake defers a head as `uncovered_not_ready` / `no_ready_for_review`
(#212), a **scoped** supervised child watches that small deferred-head set and may
`ao review run` seconds-scale when #195 readiness lands on the **current** head SHA —
without a full open-PR sweep. Poll classification:
`scoped_deferred_head_watch` (5-minute bounded window per head; incident delay ~77 s).

- Persisted watch entries live under `{stateRoot}/review-trigger-reeval-watch.json`.
- The wake listener records a watch on defer when `-SideEffectStateDir` / state root is set.
- AO 0.9.x may emit `ready_for_review` at **info** priority (filtered by the listener);
  re-evaluation is correct from observed report state either way.
- This path issues **review run only** — never spawn, claim, kill, merge, or send.
- Genuinely zero-signal heads (no wake **and** no in-progress report) remain
  **backstop-only** via `review-trigger-reconcile.ps1`.

## First-send review delivery reconcile (Issue #202)

**Orchestrator LLM turns remain a valid first-send path;** the
`scripts/review-send-reconcile.ps1` loop is recovery when review completes into
`needs_triage` but no orchestrator turn issues `ao review send` promptly (AO 0.9.x emits
no wake on `review.needs_triage`; heartbeat backstop is slower).

When a review run for your PR head is in `needs_triage` with findings not yet sent
(`sentFindingCount: 0`, `openFindingCount > 0`), a background reconciler (~2-minute
cadence) may `ao review send` to your live session without waiting for the orchestrator
turn. After delivery, report `ao report addressing_reviews` — do not stay idle.

- This path performs **first send only**; bounded re-delivery is owned by
  `review-finding-delivery-confirm.ps1` (#171).
- It does **not** recover dead sessions (#98) — use `--claim-pr` / respawn discipline.

## CI-green orchestrator nudge (fast path; Issue #191)

**Self-drive is primary;** the orchestrator CI-green nudge is recovery when you have gone
idle after required CI turned green — not a substitute for reporting `ready_for_review`
yourself.

When required CI for the **current PR head** is green and you are still pre-hand-off
(`fixing_ci`, `working`, or `pr_created` without `ready_for_review` accepted on that
head), a background reconciler (`scripts/ci-green-wake-reconcile.ps1`, ~1-minute cadence)
may `ao send` you to continue the hand-off. AO 0.9.x has no CI-green reaction; this path
is independent of orchestrator LLM turns and is far faster than `report-stale` (~30 min).

- On CI-green nudge: re-check `gh pr checks` for the current head, then
  `ao report ready_for_review` when criteria are met — do not stay idle.
- The nudge does **not** apply once `ready_for_review` or `addressing_reviews` is
  accepted for that head (review loop owns the next transitions).
- It does **not** recover a dead session (#98) — if you exited, operator respawn /
  `--claim-pr` still applies.

## PR created hand-off (initial path)

**Worker self-drive is primary;** orchestrator `report-stale` / CI-failure ping /
CI-green nudge are recovery when the worker has gone idle — not a substitute for driving
the PR yourself.

**`pr_created` is a transient state, not completion.** Opening a PR for the task does
not discharge your obligation. You must drive that PR to an explicit **hand-off**
before you may go idle, stop, or treat the task as done.

**Two stop categories — only these permit disengaging.** Distinguish states where
you may **stop** from those where you must **stay actively engaged**:

1. **Terminal hand-off (category A):** `ao report ready_for_review` once required CI
   for the **current PR head** is green (see **Required CI** and **Worker CI gate** —
   check the current head **before every** report; a `ready_for_review` that validated
   an earlier head which has since moved is **stale** and does not satisfy the
   obligation), **or** terminal failure with a reason via the existing convention
   (`ao report completed --note "<reason>"` or `ao send`) when you genuinely cannot
   reach a ready state.
2. **Evidence-backed escalation (category B):** when required CI does **not** resolve
   to green or red — checks missing or never triggered, a run `cancelled`, auth /
   rate-limit / infrastructure failure, or CI pending past a reasonable bound —
   escalate with evidence (e.g. `ao send` to the orchestrator describing the blocked
   condition). This is a permitted non-silent hand-off: after escalating you may stop
   active polling while remaining reachable for the orchestrator's response. Do **not**
   poll indefinitely and do **not** report terminal failure for a transient CI delay.

**Continued-engagement (not a stop category).** While required CI is still resolving on
the current head, you stay in **Worker CI gate** reported handling (`fixing_ci` while
red or pending) **and remain actively engaged**. Green CI alone is **not** an exit —
you must still emit `ready_for_review`. Forbidden recurrence of the stranded-green-PR
failure: filing `fixing_ci` on pending CI, then stopping while CI later goes green
without ever reporting `ready_for_review`.

**Forbidden silent disengagement.** You MUST NOT stop or treat the task as done while
a PR you opened has **not** reached one of the two stop categories above for its
**current head** — including when CI was still running when editing finished. This
complements (does not replace) the **Worker CI gate** ban on premature
`ready_for_review` while CI is red and the **AO review response** ban on idling on the
review-feedback path; it closes the initial `pr_created` → first-review path those
rules leave open.

## Review feedback handling

When AO sends review feedback through `changes-requested` or `ci-failed`:

- Treat the feedback as a scoped correction for the same issue and chain.
- Classify each finding as scope, spec, quality, test, CI, or security.
- Make the smallest change that resolves the finding.
- Do not broaden the declaration only to silence review feedback.
- If feedback appears repetitive or contradictory, stop guessing and escalate
  with evidence.
- Report verification commands and unresolved findings before handing back.

## AO review response contract (workers)

When AO-local review findings land (via `changes-requested`, `ao review send`,
or the `report-stale` backstop), the worker MUST NOT go idle silently.

**Required `ao report` transitions on the review path:**

1. `ao report addressing_reviews` — as soon as you begin working on findings
   (mandatory after findings are delivered; do not wait for a human ping).
2. `ao report fixing_ci` — optional, while fixing CI triggered by review fixes.
3. `ao report ready_for_review` — after pushing fixes and local verification,
   when required CI for the PR head is green (see **Required CI**) and the PR is ready
   for the next orchestrator-driven review round.

Use underscore state names (`addressing_reviews`, `fixing_ci`, `ready_for_review`)
so `ao status --reports full` matches what orchestratorRules watches; hyphenated
CLI aliases exist but can stall the autonomous review loop if status never shows
the underscore form.

**Terminal failure.** If you cannot address findings, report terminal failure
with a reason: `ao report completed --note "<reason>"` or `ao send` to the
orchestrator session explaining the blocker. Do not disappear without a signal.

**Forbidden `completed` while review is open.** Do NOT run `ao report completed`
(success termination) while, for the current PR head:

- the latest review run has `openFindingCount > 0` or `sentFindingCount > 0`, or
- any review run for that head is in `needs_triage` (findings not yet sent).

After `ao review send`, findings are `sent_to_agent` (`sentFindingCount > 0`,
`openFindingCount: 0`); report `ao report addressing_reviews` until resolved.
Terminal failure with a reason (`ao report completed --note "<reason>"` or
`ao send`) remains permitted when you cannot address findings.

Completion means nothing further to do; open or sent findings or an unsent
triage queue contradict that. Instead, run `ao report addressing_reviews` (after
briefly allowing the orchestrator to `ao review send` if status is
`needs_triage`), or report terminal failure with a reason.

**Inspect before reporting.** Use `ao review list --json` to confirm run status
and counts; do not infer cleanliness from finding prose.

## Orchestrator review-run coverage (Issue #189)

Orchestrator sessions (not workers) follow `orchestratorRules` in
`agent-orchestrator.yaml` / `agent-orchestrator.yaml.example`. Before any
`ao review run`, a head SHA is **covered** — start nothing — when `ao review list --json`
shows any run with the **same PR linkage** (`prNumber`) **and** the **exact normalized
head SHA** (`targetSha`) that is in-flight (`queued` / `preparing` / `running` /
`reviewing`) or covered terminal (`clean` / `needs_triage` / `waiting_update`). Same SHA
on a different PR, or same PR on a different SHA, does **not** count as coverage.

`failed` / `cancelled` on the current head are **not** covered and are **not** plain
uncovered either: read `terminationReason`, retry at most once after diagnosis, then
escalate (EMPTY REVIEW TRAP). **PRE-RUN COVERAGE RE-CHECK:** immediately before emitting
`ao review run`, re-read `ao review list --json` and re-apply the covered-head predicate.
The mechanical reconciler (`review-trigger-reconcile.ps1`) uses the same predicate; see
`docs/review-orchestrator-loop.mjs`.

## Head ready for review (Issue #195)

Orchestrator sessions (not workers) must apply **one** shared predicate before any
`ao review run` — report-driven triggers, `ROUND PROGRESSION`, and the #163 reconciler
all consume `docs/review-head-ready.mjs` (no independent trigger conditions).

Evaluate **failed/cancelled on the current head first** (EMPTY REVIEW TRAP — never the
plain uncovered-ready path). Then a PR head SHA is **ready for review** only when ALL hold
on one consistent snapshot:

- the latest accepted worker report for that **exact current head SHA** is
  `ready_for_review` (reuse #186 current-head-at-report-time semantics — stale reports for
  an earlier head do not authorize a later head);
- required CI on that head (see **Required CI** above) is **green** or **genuinely
  pending/queued** against a known required-check set — explicitly **not** red/failing and
  **not** missing/unknown/unresolvable (red **defers**; missing routes to the orchestrator/
  reconciler degraded-CI branch below);
- the head is **not** already covered per **Orchestrator review-run coverage** (#189); and
- the current head has **no** `failed`/`cancelled` run awaiting EMPTY REVIEW TRAP handling.

**Uncovered-but-not-ready** heads are left alone: no review run and no worker-lifecycle
action from the reconciler. The gate defers only — `report-stale`, ping/respawn, and #191
CI-green wake still converge idle or dead workers; the gate removes none of those backstops.

**Worker degraded-CI hand-off** (#186 evidence-backed escalation, not `ready_for_review`)
routes to the orchestrator/reconciler degraded-CI branch: bounded re-attempts to resolve
required-check visibility for the head, then observable operator escalation — not generic
uncovered-not-ready worker-liveness handling.

**PRE-RUN HEAD-READY RE-CHECK** (widens #189): immediately before `ao review run`, re-read
current head SHA, latest accepted report, required-CI state, and coverage; abort if the
predicate no longer holds.

**Merged PR — prNumber-less runs.** A run with no `prNumber` is terminal when its
linked worker session's PR is merged on GitHub (resolve via `linkedSessionId` in
`ao status`, not the run record alone). When merge state cannot be resolved (linked
session missing, restored under an unmatched id, ambiguous PR metadata), fail closed to
inaction — no `ao review send`, no new review round, no worker-lifecycle action; surface
the run for the operator.

## AO review command and failed runs (workers)

- Workers MUST NOT invent alternate `ao review run --command` strings. Only the
  orchestrator drives review with the canonical **REVIEW_COMMAND** from project
  config (`agent-orchestrator.yaml` / `agent-orchestrator.yaml.example`).
- Workers MUST NOT treat a failed or cancelled review run as review completion,
  even when `findingCount` is 0 or findings text is empty.
- Workers MUST NOT report that Codex review passed when `ao review list --json`
  shows only `failed` or `cancelled` runs for the current PR head.
- A run with `findingCount: 0` and `status: failed` or `cancelled` is an **empty
  failed review** (reviewer infra/command failure), not a clean review. Read
  `terminationReason`; do not infer success from zero findings alone.

## RCA spec discipline (Issue #221)

Workers and architects share these invariants when authoring specs or
investigating recurrence. Full procedure: `prompts/investigate_root_cause.md`
(**recurrence-diagnostic**, **5-Whys stop condition**). Authoring/publish:
`.claude/skills/create-issue-draft/SKILL.md` and `publish-issue-draft` (**behavior-kind**,
**positive-outcome**, **parked-root-cause** fences).

- **Positive-outcome acceptance:** action-producing specs MUST declare
  `behavior-kind` and include a `positive-outcome` block with `input: realistic`
  (or `external-tool-output` plus `capture-backed` / `sample-backed` provenance).
  Negative-only defer/failure ACs are insufficient.
- **No parked roots:** deferring a suspected root cause requires a
  `parked-root-cause` structured block with cause, evidence, reason-deferred,
  follow-up-issue, and resolution-policy; the tracking issue body MUST carry the
  cause statement. Euphemistic deferral without the block is non-compliant.
- **Operator adoption:** when this file changes, restart AO (`ao stop` /
  `ao start`) so workers load the updated rules.

Mechanical guards: `scripts/check-draft-discipline.ps1` (positive-outcome,
parked-root, surfaces). Architecture: §T in
`docs/issues_drafts/00-architecture-decisions.md`.

## Operator adoption handoff

When a task changes **operator-facing surfaces** — `agent-orchestrator.yaml.example`
(any block operators must mirror into live yaml), runbooks or go-live docs that
introduce new operator processes (listeners, watchers, schedulers), documented
operator env vars, machine-local config called out in the issue, or
`orchestratorRules` / `reactions` that require `ao stop` / `ao start` — before
reporting successful completion:

- Add **`## Operator adoption`** to the PR body (near the top, under `## Summary`)
  with the post-merge checklist the operator must run.
- Add or update a matching subsection in **`docs/migration_notes.md`**.
- Do **not** run `ao report completed` (or treat the task as done) while the PR
  lacks `## Operator adoption` when `.example` or operator-process docs changed
  in scope.

Workers **document** adoption; they do **not** execute it by default. Do not start
listeners, edit secrets, or merge live `agent-orchestrator.yaml` from an AO
worktree — worktree copies are not the operator checkout. Do not assume adoption
is done unless the operator confirms.

**Optional helper only:** if the worker session runs in the **primary pack
checkout** (not an `op-*` worktree) and the issue explicitly asks, the worker
**may** merge `.example` deltas into live yaml and note that in the PR — still
not a substitute for the operator checklist.

Cosmetic-only `.example` edits with zero operator follow-up may use the exact PR-body
waiver line on its own: `No operator adoption required` (CI enforces pairing;
misuse should fail review). See **`docs/migration_notes.md`** (Operator adoption
contract) and **`docs/orchestrator-autoloop-go-live.md`** for the umbrella
operator checklist.
