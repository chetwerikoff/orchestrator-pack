# Orchestrator must deliver review findings without waiting for an LLM turn (state-derived first `ao review send`)

GitHub Issue: #202

## Prerequisite

None blocking. Builds on already-merged siblings (context, not gates):

- `docs/issues_drafts/58-safe-review-trigger-reconciliation.md` (GitHub #163) —
  state-derived review **run** trigger, review-run only, never `ao send`.
- `docs/issues_drafts/61-review-finding-delivery-confirmation.md` (GitHub #171) —
  sender-side confirmation / bounded **re**-delivery of an **already-sent** finding.
- `docs/issues_drafts/66-orchestrator-ci-green-wake-worker.md` (GitHub #191) —
  level/state-derived worker wake outside the LLM turn; the closest pattern mirror.
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` (GitHub #189) and
  the `#54` merged-PR terminal rule — coverage / terminal predicates this must reuse.

## Goal

Make the **first** delivery of review findings to a worker converge **without**
depending on an LLM-orchestrator turn. Today the first `ao review send` for a
review run in `needs_triage` is issued only by the LLM orchestrator on a turn,
and after a review completes nothing schedules that turn promptly — the worker
is idle waiting, and AO 0.9.x emits no wake-relevant webhook notification on the
`review.needs_triage` transition. The only remaining turn source is the periodic
heartbeat backstop, so findings sit undelivered for up to the heartbeat interval
(and longer if the orchestrator is `stuck`). A state-derived reconciliation path
must close that gap while preserving the split-brain invariants that #163/#171/#191
established.

**Root cause (5 Whys, condensed).** First delivery → `ao review send` → only the
LLM orchestrator issues it → only on a turn → after `needs_triage` no turn is
scheduled (no worker report, no AO review-completion wake) → the two non-LLM
reconcilers deliberately exclude the first send (#163 is review-run only; #171
only re-delivers an already-sent finding). Net: **no non-LLM path performs the
first `ao review send`.** This draft adds exactly that path.

## Binding surface

- A low-frequency, **level/state-derived** reconciliation path performs the first
  `ao review send` for a review run that is in `needs_triage` with **no findings yet
  sent** to the worker, targeting the run's linked worker session — converging even
  when no worker report arrives, no review-completion wake fires, and the LLM
  orchestrator is unavailable or `stuck`.
- **Strict scope of the send.** The path sends **only** when, on a single fresh
  snapshot, all hold: run status is `needs_triage`; the run's own AO state shows no
  findings yet sent (`sentFindingCount: 0`, `openFindingCount > 0`); the linked
  worker session is runtime-alive **and** owns the PR's current head; and the run's
  targetSha matches the PR's current head. First-send only — re-delivery of an
  already-sent run stays owned by #171; this path must not duplicate that role.
- **Authoritative cross-path guard (not a process-local file).** The dedupe that
  prevents *two different senders* (this path, an LLM-orchestrator turn, or a future
  notification path) from both first-sending the same run is the run's **own AO state**:
  a successful `ao review send` moves the run **out of `needs_triage`** (to a sent
  state), which is the **same signal the existing LLM first-send rule already keys on**
  — so no change to the canonical LLM rule is required and the two paths stay
  independent recovery routes (no common-mode coupling). Both re-read run state on a
  fresh snapshot immediately before sending. This reconciler additionally checks
  `sentFindingCount: 0` as defense-in-depth to distinguish a never-sent run from edge
  cases; that extra check is **fail-closed** (no send) when the field is absent,
  null, or ambiguous. The process-local state file is only a secondary self/restart
  dedupe — explicitly **not** relied on for cross-path correctness.
- **Split-brain envelope (non-negotiable, inherited from #163/#171/#191/PR #97).**
  The path MUST NOT `ao spawn`, MUST NOT `--claim-pr`, MUST NOT `ao session kill`,
  MUST NOT `ao report`, and MUST NOT alter merge or approval state. Its only
  worker-affecting action is `ao review send` for a qualifying run.
- **Terminal / coverage deference.** When the linked PR is merged on GitHub
  (`#54` MERGED PR — REVIEW LOOP TERMINAL), the run is `failed`/`cancelled`/`outdated`,
  or merge/linkage state cannot be resolved to one live run+session, the path
  **fails closed** (no send) and leaves the run for the operator or the LLM turn.
- **Idempotency + dedupe across restart.** Send decisions are deduped per
  (run identity + targetSha) and persisted so a sender restart, AO adoption, or a
  concurrent observer does not re-send a finding already delivered for that head.
  Dedupe is recorded only **after** a confirmed send to a live, head-owning session;
  failed or stale sends consume no dedupe slot.
- **Dual-path tolerance.** The LLM orchestrator turn retains its own first-send rule;
  with the shared `sentFindingCount: 0` guard above, a duplicate send is possible only
  in the narrow window where two senders both observe `sentFindingCount: 0` before
  either send lands. That residual double-send is acceptable (at worst the worker
  receives the findings ping twice) — not a correctness failure. A single pre-send
  recheck on the latest snapshot bounds the window; "exactly one" is a per-tick / per-
  path property of this reconciler, never a global guarantee across senders.
- **Head-advance race.** Between the pre-send recheck and the `ao review send`
  executing, the PR head can advance (the worker pushed a new commit). The send must be
  bound to the expected run + targetSha + session so that a send for a now-stale head
  is suppressed or lands harmlessly (the run goes `outdated`; #171 does not re-deliver
  `outdated` runs, and #163 covers the new head with a fresh run). The path must not
  record dedupe or claim delivery for a head that advanced before the send.
- **Handoff to confirmation.** Once this path sends, the run moves to a sent state
  (`waiting_update`) and #171 owns confirmation / bounded re-delivery / escalation
  from there. This path never escalates and never re-delivers.

- **Operator adoption** (this issue touches operator-facing surfaces — a new
  long-running operator process, `orchestratorRules` text, and go-live/runbook docs):
  - Start the new reconciliation process alongside the existing wake processes
    (the same way the CI-green wake reconcile process is started today), and document
    its cadence override env var and state-file env var.
  - The process MUST run under a supervisor that starts it, restarts it on exit, stops
    it with the session, and reports it under `Status` (criterion 9) — an unsupervised
    hand-started daemon would recreate the very wake-reliability failure class this path
    is meant to close. Generalizing the #168 wake supervisor to own this third managed
    child is the expected mechanism and is **in scope here** (declared, not a silent
    #168 change). Broadening that supervisor to **also** own the already-shipped #163
    trigger-reconcile and #171 delivery-confirm processes is a **related follow-up**,
    captured under Open questions — not required to ship this path.
  - Re-merge the canonical `orchestratorRules` block and restart AO
    (`ao stop` / `ao start`) per the go-live runbook after adoption.

## Files in scope

- `agent-orchestrator.yaml.example` — canonical `orchestratorRules` / process
  documentation for the new reconciliation path (where #163 and #191 reconcilers
  are described today).
- `prompts/agent_rules.md` — universal worker/orchestrator rule text if the
  first-send-without-turn invariant belongs in the shared rules.
- `scripts/**` — the new reconciliation process and its tests `(new)`, plus the wake
  supervisor so it manages the new child (criterion 9); the planner owns file names,
  structure, and language conventions (mirror existing reconcilers + supervisor).
- `docs/**` runbooks/go-live (e.g. autoloop go-live, wake runbook, recovery runbook)
  — operator start/verify steps and the failure-mode table entry.
- `docs/issue_queue_index.md` — this draft's registry row (added at publish, selective).

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**`.
- #163 trigger-reconcile logic and #171 delivery-confirm/re-delivery/escalation logic
  (already shipped; reuse their predicates, do not rewrite them).
- Any upstream AO change that would make AO emit a wake-relevant `review.needs_triage`
  notification — that is the **alternative** solution axis, recorded under Open
  questions, not implemented here.
- Merge, approval, spawn, claim, and kill paths (explicitly forbidden above).

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. With a review run in `needs_triage` whose findings were never sent
   (`sentFindingCount: 0`, `openFindingCount > 0`), whose targetSha equals the PR's
   current head, whose linked worker session is runtime-alive and head-owning, and
   with **no** LLM-orchestrator turn occurring, the reconciliation path issues a single
   `ao review send` for that run within its configured cadence (at most one send per
   tick per run), and the run transitions to a sent state — demonstrated on a
   fixture/dry-run plus a real run. "Exactly one" is a per-path/per-tick property; a
   cross-path duplicate with the LLM turn is the documented residual (criterion 8), not
   a failure of this criterion.
2. The path issues **no** `ao review send` when any disqualifier holds: run not
   `needs_triage`; `sentFindingCount > 0` (already sent — #171's domain); targetSha
   ≠ current head; linked session missing, dead, or not head-owning; linked PR merged
   on GitHub (`#54`); run `failed`/`cancelled`/`outdated`; or run↔session↔PR linkage
   ambiguous (overlapping runs). Each disqualifier is covered by a fixture asserting
   no send (fail-closed).
3. The path never emits `ao spawn`, `ao review run`, `--claim-pr`, `ao session kill`,
   `ao report`, or any merge/approval mutation — asserted by test (only `ao review send`
   and read-only `gh` / `ao` queries appear in its action surface).
4. Re-running a tick after a successful send for the same (run + head) issues no second
   send (dedupe persists across process restart via the state file). A head advance does
   **not** make the prior run sendable: that run's targetSha no longer equals the head,
   so it is `outdated` / fail-closed per criterion 2 and the head-advance rule. Only a
   **fresh** `needs_triage` run whose targetSha equals the new head (typically created by
   the #163 trigger-reconcile) is a new, sendable transition.
5. A dry-run mode logs the send decision per qualifying run without calling AO, and a
   one-shot mode runs a single tick — both verifiable without a live worker.
6. Operator docs state how to start, dry-run, and verify the process, its cadence and
   state-file env overrides, and a failure-mode/diagnosis row; the canonical
   `orchestratorRules` documents the path as additive to (not a replacement for) the
   heartbeat backstop and the LLM-turn first-send rule.
7. After a successful send the run is left to the #171 confirmation/re-delivery path;
   this process performs no re-delivery and no escalation (verified by test that a
   `waiting_update` run is never re-sent by this path).
8. **Cross-path / race safety.** Two scenarios are covered by fixtures: (a) a second
   sender (LLM turn or another observer) sends between this path's recheck and its send
   — the worst observable outcome is a duplicate findings ping, never a corrupted run or
   a crash, and this path records no false delivery; (b) the PR head advances between
   the pre-send recheck and the send — the path suppresses the send or treats the
   resulting `outdated` run as benign, and records **no** dedupe / delivery for the
   stale head (so the new head is still eligible).
9. **Supervised liveness (property, not a specific supervisor).** The process is
   started, restarted on unexpected exit, stopped with the orchestrator session, and
   reported under a `Status` action by a supervisor — so the stuck-orchestrator
   convergence guarantee does not silently depend on a hand-started daemon. Generalizing
   the existing wake supervisor (GitHub #168) from its current two-child
   (listener + heartbeat) contract into a managed-child supervisor that owns this third
   process is **in scope for this issue** (the supervisor is in Files in scope) and must
   be stated explicitly, not assumed — it is not a silent expansion of #168. Verified
   via the supervisor's status output and a restart-on-exit test.
10. **AO 0.9.x sent-state contract.** A fixture/real-CLI check confirms the run's
    sent-state signal (status leaving `needs_triage`; `sentFindingCount`) is present in
    the exact `ao review list --json` snapshot both senders read and reflects a send
    before dedupe is recorded. When that signal is missing, null, or cannot be resolved
    to one run, the path **fails closed** (no send) and surfaces the run for the operator
    rather than sending on a false predicate. (The field is already consumed by
    GitHub #17 / #171 — this criterion pins its use as the cross-path guard.)

## Upgrade-safety check

- No edits to AO core, `vendor/**`, or `packages/core/**`.
- No unsupported keys added to `agent-orchestrator.yaml` (drive behavior through the
  same process/`orchestratorRules` mechanism as #163/#191; do not invent a reviewer/
  notification YAML field AO 0.9.x ignores).
- No new repo secrets; the process uses existing local AO/gh auth only.
- Additive only: heartbeat backstop, #163 trigger-reconcile, #171 delivery-confirm,
  `reactions.report-stale`, and the LLM-turn first-send rule all remain in place.

## Verification

1. **First-send happy path** — fixture/dry-run + one real `needs_triage` run with the
   LLM orchestrator stopped: observe exactly one `ao review send` and the
   `needs_triage` → sent transition (criterion 1).
2. **Fail-closed matrix** — one fixture per disqualifier in criterion 2, each asserting
   zero sends; include merged-PR (`#54`), dead/non-owning session, stale head, and
   ambiguous-overlap cases.
3. **Action-surface assertion** — test/grep proving the process's only worker-affecting
   command is `ao review send` (criterion 3).
4. **Dedupe across restart** — run a tick, persist state, restart, re-run: no second
   send for the same (run + head); advance the head and confirm a new send (criterion 4).
5. **Dry-run + one-shot** — both modes exercised in CI without a live worker (criterion 5).
6. **Docs/orchestratorRules** — go-live/runbook updated and the canonical
   `orchestratorRules` block describes the additive path; verified by the existing
   docs/rules checks the planner runs for sibling reconcilers (criterion 6).
7. **Handoff** — fixture with a `waiting_update` run asserts this path leaves it
   untouched (criterion 7).
8. **Race fixtures** — (a) a sent-by-other-sender run observed mid-tick asserts no
   false-delivery record and at most a duplicate ping; (b) a head-advance-after-recheck
   fixture asserts the stale send is suppressed/benign and the new head stays eligible
   (criterion 8).
9. **Supervisor integration** — the supervisor `Status` action lists the new process as
   a managed child, and a kill-the-child test shows it is restarted (criterion 9).
10. **AO sent-state probe** — a fixture with a missing/null sent-state field asserts the
    path fails closed (no send, operator-surfaced), and a real/fixture round shows the
    field flips after a send before dedupe is recorded (criterion 10).

## Open questions / recorded risks

- **Reconciler vs upstream notification (solution fork).** This draft commits to the
  in-repo reconciler because it has no upstream dependency. The alternative —
  asking AO to emit a wake-relevant `review.needs_triage` notification so the existing
  webhook listener forwards it (a fast event path, no new long-running process) — is
  recorded as a future option. If AO ships that notification, this reconciler becomes
  the backstop rather than the primary; both can coexist (the reconciler is level-derived
  and idempotent, so an added event path causes at most a deduped double-send).
- **Supervisor breadth (follow-up).** This new path's supervision is **required** here
  (criterion 9). The related follow-up is narrower: bringing the **already-shipped** #163
  trigger-reconcile and #171 delivery-confirm processes under the same supervisor so they
  no longer depend on manual operator start. That is not required to ship this path; track
  separately if pursued.
- **Heartbeat interval as interim band-aid.** Until this lands, shortening the heartbeat
  interval reduces worst-case latency; it does not remove the LLM-turn dependency and is
  not a substitute for this path.
