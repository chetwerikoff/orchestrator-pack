# Single-flight review-start claim must be a true atomic single-winner across concurrent automated starters

GitHub Issue: #308

## Prerequisite

- `docs/issues_drafts/88-review-start-atomic-claim.md` (GitHub **#267**, merged) —
  shipped the per-`(PR, head)` claim: every automated starter (periodic reconcile,
  wake-listener, deferred-head reeval) must acquire the claim *before* invoking
  `ao review run`, with the claim held from acquisition until a covering run record
  is visible or a terminal failure. **This draft does not re-introduce the claim; it
  hardens the part of #267's guarantee that did not hold in production.**
- `docs/issues_drafts/91-review-run-crash-safe-terminal-status.md` (GitHub **#287**,
  merged) — crash-safe terminal status + liveness reaper that moves a dead review
  **run** to `failed`. This draft extends that lifecycle to the **claim** the dead
  run held (today the run terminalizes but its claim can stay `active`).

## Goal

When two or more automated review-start surfaces decide concurrently to review the
same `(PR, head)`, exactly one run is launched and every other starter aborts
without launching — no matter how the claim store path is resolved by each
process and no matter how close in time the decisions land. A run that ends in any
terminal state (including a reaper-detected dead run) leaves no `active` claim
behind that could block a later legitimate start on the same key.

```behavior-kind
action-producing
```

## Binding surface

This issue commits the repository to a single-flight guarantee that holds under
**concurrent automated acquisition**, closing the gap proven by the PR #307
incident (see *Decisions → Incident*).

**Re-used from #267 (do not re-implement):** the claim concept, the
`(PR number, normalized head SHA)` key derivation, the "acquire before invoking the
run verb" ordering, the ownership-recheck-before-launch fence, and the set of
automated starter surfaces. **Re-used from #287:** the dead-run detection and
terminal-status machinery.

**Added / corrected by this issue:**

- **Acquisition is a true single-winner operation.** When N automated starters
  attempt to acquire the same key concurrently, at most one acquisition succeeds;
  the others observe the held claim (or lose the race deterministically) and abort
  the start. A second `active` claim record for a key that already has a live
  holder must not be creatable. (The incident produced two live holders for one
  key — this must become impossible.)
- **One canonical claim store per project, resolved identically by every starter
  and by the `ao review run` invocation**, independent of the invoking process's
  runtime, working directory, environment, or a supervisor restart. Two starters
  must never acquire "successfully" in two different stores for the same key.
- **Claim lifecycle covers terminal run failure.** When a run reaches any terminal
  outcome — including a reaper-detected dead/crashed run (#287) — the claim it held
  is released or terminalized so it cannot linger `active`.

This is a record-and-act change to existing automated review-start paths; it
introduces no operator-facing surface, so no operator-adoption steps are required
beyond the existing `ao stop` / `ao start` already documented for #267 wiring.

## Files in scope

- The shared review-start claim helper / module already introduced by #267
  (acquisition, release, recovery, namespace resolution).
- The automated review-start surfaces that call it (periodic reconcile,
  wake-listener trigger, deferred-head reeval) — only as needed to honor an
  aborted/lost acquisition.
- The dead-run reaper path from #287 — only to release/terminalize the claim of a
  run it moves to a terminal state.
- Tests/fixtures covering concurrent acquisition and the claim-on-terminal-failure
  lifecycle.

## Files out of scope

- `agent-orchestrator.yaml` wiring and `orchestratorRules` (the surfaces are
  already wired by #267 — no new reactions).
- Manual operator `ao review run` (#267 leaves manual runs unclaimed by design;
  that residual is unchanged here).
- The review-run execution / reviewer subprocess itself.
- Finding routing, delivery, and submit paths.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

- Under concurrent acquisition of one `(PR, head)` key by two or more automated
  starters, exactly one acquisition succeeds and exactly one `ao review run` is
  launched; every losing starter aborts the start and launches nothing.
- It is not possible for two `active` claim records to exist for the same key at
  the same time; an acquisition attempt against a key with a live holder does not
  produce a second live claim.
- Every automated starter and the run invocation resolve the **same** claim store
  for a given project; a fixture that drives two starters whose process
  environment / working directory differ still yields a single winner (they
  contend over one store, not two).
- When a run reaches a terminal state via the #287 reaper (dead/crashed reviewer),
  the claim that run held is no longer `active` afterward, so a subsequent
  legitimate start on the same key is not blocked by a stale claim.
- The PR #307 incident is reproducible as a regression fixture and passes: two
  `review-trigger`-attributed acquirers on `(PR 307, b4ed8d8)` landing ~2–3s apart
  resolve to one run, not two.

```positive-outcome
asserts: two concurrent automated starters contending for the same (PR, head) key result in exactly one launched review run and one or more deterministic aborts
input: realistic
```

```positive-outcome
asserts: a run moved to a terminal failure state by the dead-run reaper leaves its claim non-active, and a fresh start on the same key then succeeds
input: external-tool-output
provenance: capture-backed
```

## Upgrade-safety check

- No edits to AO core, `vendor/**`, or `packages/core/**`.
- No new repository secrets.
- No new unsupported YAML schema keys; no new `reviewer:` block (ignored on AO
  0.9.x — see `CLAUDE.md`).
- Claim store format stays backward-compatible with #267 records, or migrates them
  without losing an in-flight claim.

## Verification

- A concurrency fixture spawns ≥2 automated acquirers against one key with
  near-simultaneous timing and asserts exactly one launch + the rest aborted;
  asserts no second `active` record is ever written for the key.
- A cross-environment fixture runs two acquirers with differing cwd/env and asserts
  they contend over one resolved store (single winner), guarding the
  namespace-resolution path.
- A reaper fixture drives a run to terminal-failure via the #287 path and asserts
  the held claim is non-active afterward, then a new acquire on the same key
  succeeds.
- Replaying the PR #307 timeline (two `review-trigger-reconcile` acquirers,
  `acquiredAtUtc` ~2.5s apart, same key) yields one run.

## Decisions (design analysis)

### Prior art

- **#267 (shipped)** settled that single-flight is enforced by a per-`(PR, head)`
  claim acquired before the run verb, shared by all automated starters, held until
  a covering run record is visible. Its own draft records three *accepted* residuals
  — manual-vs-automated, the stalled-claimant window, and a once-per-adoption
  old-generation window — none of which is the incident here. The incident is
  **automated-vs-automated**, which #267 intended to prevent.
- **#287 (shipped)** settled crash-safe terminal status for a dead review run. It
  terminalizes the **run**; it does not address the **claim** that run held.
- No open issue or un-synced draft covers concurrent-acquire atomicity or claim
  namespace canonicalization. Closest open work is #298 (message egress registry),
  which only *references* #267 and is unrelated.

Verdict: **extends #267 + #287** — a hardening follow-up, not a re-implementation
and not a parallel of any queued work.

### Incident (5 Whys, evidence-backed)

PR #307, head `b4ed8d8`: two automated runs launched on the same head 4s apart —
`opk-rev-313` (`02:33:51`, pid 5478) and `opk-rev-314` (`02:33:55`, pid 220992).
314's process died mid-flight and #287 correctly failed it. On disk both claim
records for the key coexist: a `terminal/…run_started` record (313) **and** a live
`active` file (314), acquired `02:33:43.192` and `02:33:45.750` respectively, both
`surface: review-trigger-reconcile`.

1. Why two runs on one head? → Two automated starters each acquired the claim for
   the same key.
2. Why did both acquire? → The second acquirer (`:45.750`) created a live claim
   while the first holder's claim (`:43.192`) was still live — acquisition admitted
   a second winner instead of failing the loser.
3. Why was a second winner admitted? → Acquisition is not a true atomic
   single-winner operation against a concurrent acquirer (read-or-overwrite, not
   exclusive create-or-fail), **and/or** the two acquirers resolved different claim
   stores so neither saw the other (the reconcile child reports
   `claimNamespace=…/orchestrator-pack-wake-supervisor/review-start-claims`, but the
   live `pr-307` claim sits under `…/.bun-tmp/orchestrator-review-start-claims`).
4. Why does the store path differ across processes? → Claim-store root is resolved
   per-process (runtime/cwd/restart-dependent) rather than from one canonical
   project-scoped location.
5. Why did 314's claim stay `active` after it failed? → #287 terminalizes the run,
   but the claim lifecycle has no release on reaper-detected terminal failure.

The durable fix is at the **claim contract** (atomic single-winner + canonical
store + claim-release-on-terminal-failure), not in any merged run code.

### Full-class enumeration (concurrency cause — fix the class, not the case)

Input dimensions of an automated review-start decision:

- **Starter surface**: reconcile · wake-listener · reeval · (future starter).
- **Timing**: serial (one finishes acquiring before the next attempts) ·
  overlapping (two attempt within the acquire window) · simultaneous.
- **Store resolution**: both resolve the same store · they resolve different stores.
- **Prior claim state on the key**: none · live-active · terminal · stale (dead
  holder) · dangling-active-after-failed-run.

Equivalence classes and required outcome:

| Class | Required outcome |
|---|---|
| Any two surfaces, overlapping/simultaneous, same store, key free | exactly one acquires → one run; others abort |
| Any two surfaces, different resolved stores, key free | must be made impossible at the source: one canonical store → collapses to the row above |
| Acquire against key with live-active claim | fail/lose deterministically → no launch |
| Acquire against key with stale (dead-holder) claim | recover-then-single-winner (existing #267 stale recovery) |
| Acquire against key whose holder run terminal-failed | claim already released → acquire succeeds → one run |
| Serial, same store | unchanged from #267 (already correct) |

The fix targets the whole first three rows (the proven failure and its siblings),
not only the reconciled `(307, b4ed8d8)` case.

### Options considered (cost / risk / sufficiency)

1. **Reference / extend #267 only via runbook note ("operator watches for dups").**
   Cheapest, zero code. *Rejected:* the incident is automated-vs-automated; #267
   already promised to prevent it. A runbook turns a contract violation into manual
   toil and the safety net here was luck (the surviving twin), not the design.
2. **Make acquisition a true atomic single-winner over one canonical store, and
   release the claim on terminal run failure (chosen).** Moderate cost, contained
   to the existing claim helper + reaper hook + fixtures; risk bounded by Codex
   review and the concurrency fixtures. Directly closes the proven class. **Cheapest
   sufficient executor with acceptable risk.**
3. **Re-architect review-start onto a central queue/leader that serializes all
   starts.** Highest cost and risk (new service, new failure modes), and strictly
   more than needed — #267's claim model is sound; only its atomicity and store
   resolution failed. *Rejected as over-build.*

Chosen: **option 2.** It fixes the class at the contract level, reuses #267/#287
machinery, and stays single-PR-sized. The store-resolution dimension is folded in
because option 2 is insufficient without it (option 1's namespace split would
otherwise re-open the same hole).
