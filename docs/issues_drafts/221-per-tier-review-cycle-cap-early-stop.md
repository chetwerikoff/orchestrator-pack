# Per-tier PR review-cycle cap and early stop (first clean head = merge-eligible)

GitHub Issue: #646

## Prerequisite

**Prior-art verdict (draft-author recon 2026-07-07):** **Genuinely new** for per-tier
distinct-head budgets and early-stop merge eligibility on the **PR-code** review loop.
Extends shipped cycle/idempotency machinery; does **not** duplicate spec-review per-tier
caps (#575 / local draft 188), merge triage (brief B), or same-(PR,sha) dedup (brief C).

Builds on / references (already shipped — **reused, not rebuilt**):

- `docs/issues_drafts/106-review-and-cinudge-per-cycle-settle-gate.md` (GitHub #332,
  closed) — per worker-iteration **cycle** arming, intra-cycle head advance, and
  review-start suppression within a settled cycle. *This draft adds a **PR-level**
  distinct-head **budget** and early-stop/at-cap terminals on top; it does not replace
  #332's cycle machine.*
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` (GitHub #189, closed)
  — covered-head idempotency for `{prNumber, targetSha}`. *Reused:* clean coverage and
  in-flight dedupe; this draft adds budget and merge-eligibility semantics before
  triggering the next distinct head.
- `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` (GitHub #60,
  closed) — failed/cancelled zero-finding runs are never clean. *Reused:* zero-finding
  failed/cancelled runs do not satisfy early stop and do not consume budget; failed/
  cancelled runs **with findings** are verdict-bearing and consume one budget unit for
  that head (same as `needs_triage`).
- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub #318, closed) —
  autonomous starts through claimed entrypoint only. *Reused:* cap gate binds before
  claimed review start, not ad hoc `ao review` argv.
- GitHub #461 (closed) — bounded same-head infra retry. *Composes:* same-sha retries
  stay inside #461/#174 discipline and must not increment distinct-head budget.
- GitHub #516 (closed) — pre-launch envelope counter. *Out of band:* pre-launch stalls
  are not distinct-head budget consumption.
- `docs/issues_drafts/12-architect-role-tighten.md` (GitHub #37) — ships the
  **draft/spec** review 5-iteration Codex cap. *Distinguished:* that cap governs
  create-issue-draft spec review, not the autonomous PR-code loop this issue owns.
- `agent-orchestrator.yaml.example` — ships a prompt-level **ROUND LIMIT** (20
  finding-bearing runs per PR). *Superseded here:* replaced by tier-keyed distinct-head
  budgets (T1=2, T2=4, T3=8) plus early stop; the flat 20-run stop is retired.

In-flight / sibling (consume interfaces, do not re-implement):

- `docs/issues_drafts/210-ao-010-review-harness-and-trigger-loop.md` (GitHub #623) —
  AO 0.10 trigger loop; cap binds on the same trigger eligibility path.
- `docs/issues_drafts/211-ao-010-review-stuck-run-reaper.md` (GitHub #624) — stuck-run
  reaper; reaper-killed runs must not corrupt budget accounting.
- `docs/issues_drafts/204-review-status-consumers-report-full-json-reader.md`
  (GitHub #611, open) — pack read model for review runs/findings on AO 0.10.2; cap
  logic must consume the #611 reader, not dead `ao review list` argv.
- `docs/issues_drafts/187-task-complexity-tier-rubric.md` (GitHub #574, open) — tier
  taxonomy source when available. *Default before #187/#189 ship:* **T2 (cap 4)** when no
  tier is resolvable.

Downstream consumer:

- **Brief B (at-cap merge triage gate + deferred-findings catalog)** — consumes this
  draft's `at_cap_open_findings` terminal state only; triage logic is explicitly out of
  scope here.

Evidence base (do not re-derive): `docs/investigations/review-criticality-cycle-cap-audit-2026-07-02.md`
(1253 runs, 1260 findings, 150 PRs; ~49% run waste at cap-4; structural non-convergence
of run-until-NO_FINDINGS).

## Goal

Stop the autonomous PR-code review loop from running until `NO_FINDINGS` by enforcing
**operator-mandated per-tier distinct-head budgets** and **first-clean early stop**, while
emitting a persistent, machine-readable terminal state when budget is exhausted with open
findings. A PR becomes **merge-eligible** on the first **clean** distinct-head review run;
at tier cap with findings still open, the pack **stops launching new review runs** and
records `at_cap_open_findings` for the separate merge-triage gate (brief B).

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

## Binding surface

### Operator decisions (2026-07-07 — binding; do not relitigate)

1. **Per-tier cap on review cycles, counted by distinct head (`targetSha`): T1 = 2,
   T2 = 4, T3 = 8.** No opt-in or extension step — T3 receives 8 immediately.
2. **Early stop:** the **first** clean (`NO_FINDINGS` / pack-clean equivalent) run on a
   **distinct head** ends the review cycle for that PR → **merge-eligible**. The prior
   "two consecutive clean" suggestion is **rejected**.
3. **At cap with findings still open:** stop launching new review runs and emit
   `at_cap_open_findings` — a first-class terminal state consumable by brief B's merge
   triage gate. This draft does **not** implement triage, deferred catalog, or merge
   execution.

### Tier resolution

| Priority | Source | Default when missing |
| --- | --- | --- |
| 1 | Task `complexity-tier` fence on the bound GitHub Issue / worker task spec | — |
| 2 | Pack tier rubric in `prompts/agent_rules.md` after #187 ships | — |
| 3 | **Default** | **T2 (cap 4)** when no tier is available |

**Mid-cycle relabel:** tier and cap are fixed at **cycle open** (first review run on the
PR after worker bind or after a prior terminal resets the cycle — see below). A tier
change on the issue body mid-cycle does **not** retroactively shrink or expand the active
budget.

### Distinct-head budget semantics

**Budget unit:** one **distinct reviewed head** = one normalized `targetSha` for the PR
for which the pack has observed a **terminal, verdict-bearing** review run that is **not**
excluded below.

**Counts toward budget (one unit per distinct `targetSha`):**

- Terminal `clean` (zero open findings per #60/#189 cleanliness rules).
- Terminal `needs_triage` (findings present — worker-fix cycle continues until early stop
  or cap).
- Terminal `failed` / `cancelled` **with findings** (fix-and-re-review path).
- Terminal `waiting_update` when it represents a completed reviewer pass on that head.

**Does NOT count (must not silently consume budget):**

- Same-`targetSha` **re-runs** after a verdict-bearing terminal on that head (infra
  retry per #461/#174, reconcile re-trigger on an already-reviewed head).
- `failed` / `cancelled` **zero-finding** runs only (#60 empty-review trap).

**Clarification (load-bearing):** `failed` / `cancelled` **with findings** are
verdict-bearing — they consume exactly one budget unit for that `targetSha` (listed
above under "Counts toward budget") and remain eligible for same-sha fix cycles without
a second budget increment.
- Runs **superseded** by head advance before terminal (engine or pack supersession).
- Terminals on a **stale head** (normalized `targetSha` ≠ current PR head at terminalization):
  **never** consume budget and **never** satisfy early stop — even if the run completes
  after the worker advanced. Only terminals on the **current head at completion** count.
- Runs **reaper-killed** mid-flight without a verdict-bearing terminal on that head
  (#624/#633) — may be retried on the same head without budget increment.
- In-flight / queued / preparing / running / reviewing rows — budget increments only at
  **terminal**.

**Distinct-head set derivation:** from pack-owned run records via the #611 read model on
AO 0.10.2 (`prNumber`, `targetSha`, `status`, `createdAt`, finding counts, plus
**terminalization snapshot**: normalized PR head at run completion and `completedAt` when
available). Stale-head detection compares `targetSha` to the head snapshot at
terminalization — not `createdAt` alone. No `headSeq` field is assumed; order is derived.

### Cycle terminals and merge eligibility

| Terminal | Meaning | New review auto-start | Merge eligibility |
| --- | --- | --- | --- |
| `clean_early_stop` | First clean distinct-head run observed | **Forbidden** for same PR until reset event | **Eligible** (subject to CI/green gates outside this draft) |
| `at_cap_open_findings` | Distinct-head budget exhausted; ≥1 open finding on current head | **Forbidden** | **Not eligible** until brief B triage (out of scope) |
| `merged` | GitHub PR merged | **Forbidden** (existing merged-PR terminal) | N/A |
| *(in progress)* | Budget remaining; findings open | Allowed per existing trigger gates | Not yet |

**Reset events** (start a **new** cycle with fresh budget and cleared terminals):

- Worker pushes a **new head** after `clean_early_stop` (merge was not taken yet).
- Operator or architect explicitly clears the terminal (audited manual reset — planner
  designs surface).
- PR head advances for any reason after `at_cap_open_findings` **only** when brief B or
  operator action clears the at-cap terminal (this draft records the dependency; it does
  not define clearance).

**Post-`clean_early_stop` new head:** if the worker commits again after merge-eligibility
was reached but before merge, treat as a **new cycle** (fresh budget, no carry-over of
prior terminal). Orchestrator must not auto-start review on the old eligible head.

### Integration points (where cap / early-stop bind)

All automated review-start surfaces must consult the shared cap decision **after**
merged-PR check and **before** minting a new distinct-head review:

- `scripts/review-trigger-reconcile.ps1`
- `scripts/review-trigger-reeval.ps1`
- `scripts/orchestrator-wake-listener.ps1` / event-driven review trigger
- `scripts/invoke-orchestrator-claimed-review-run.ps1` (orchestrator turn)
- Any AO 0.10 trigger shim from #210

**Composes with #332:** intra-cycle head advance and per-cycle arming remain authoritative
for *within-cycle* duplicate suppression; this draft's budget is **PR-scoped across
distinct heads**, not a second per-cycle counter.

**Composes with #189 / #318:** covered-head and claim idempotency still block duplicate
starts; cap adds an upper bound on **new** distinct heads.

**Prompt / rules:** `agent-orchestrator.yaml.example` ROUND LIMIT prose is replaced by
tier-cap + early-stop semantics (example yaml only — live yaml is operator-owned).

### At-cap state contract (producer for brief B)

When `at_cap_open_findings` is reached, emit a persistent, pack-owned record (planner picks
storage) with at least:

| Field | Required | Semantics |
| --- | --- | --- |
| `schema_version` | yes | Starts at `1` |
| `terminal` | yes | `at_cap_open_findings` |
| `pr_number` | yes | GitHub PR number |
| `head_sha` | yes | Normalized head at terminal |
| `tier` | yes | `T1` \| `T2` \| `T3` |
| `cap` | yes | 2 \| 4 \| 8 per tier |
| `distinct_heads_reviewed` | yes | Ordered list of normalized SHAs that consumed budget |
| `open_finding_count` | yes | Count on current head at terminal |
| `cycle_opened_at_utc` | yes | First budget-consuming run timestamp |
| `terminated_at_utc` | yes | Terminal timestamp |
| `producer` | yes | Surface that wrote terminal (reconcile, turn, etc.) |

Brief B consumes this record; this draft does not define triage behavior.

**Pack-owned state location (runtime, not PR artifacts):** cycle-state and terminal
records live under operator-side pack state (e.g. `~/.local/state/orchestrator-pack-review-cycle-cap/**`)
— same class as other reconcile sidecars. Runtime state is **not** committed; allowed-roots
authorizes code that **reads/writes** that path at runtime only.

### Design analysis (carried forward — audit + operator decisions; not re-derived)

**Critical mechanics.** Historical loop runs until reviewer noise floor (~1 finding/run
flat across iterations). True merge-blocker yield ≈ 0 by iteration 4–5; late findings are
mostly fix-induced churn. Cap must count **distinct heads**, not raw run count, so
same-sha infra retries (#461) and failed zero-finding traps (#60) do not burn budget.
Early stop on **first** clean head rejects the audit's "two consecutive clean" alternative.

**Industry pattern.** Review-round limits and "LGTM with tracked debt" (technical-debt /
payment-plan principle from audit KB consult) — cap is the round limit; brief B owns debt
capture at cap.

**Architecture sketch.**

```text
review run records (#611 read model)
        |
        v
distinct-head cycle-state (per PR: tier, cap, reviewed heads, terminal)
        |
        +-- clean on new head --------------------> clean_early_stop (merge-eligible)
        |
        +-- budget exhausted, findings open -----> at_cap_open_findings (hand off to brief B)
        |
        +-- budget remaining, findings open -----> allow claimed review start (existing gates)
        |
        +-- same-sha retry / failed zero-finding -> no budget increment
```

**Options judged (cost / risk / sufficiency).**

| Option | Summary | Verdict |
| --- | --- | --- |
| A. Keep run-until-NO_FINDINGS + flat 20-run yaml cap | Status quo | **Rejected** — structurally non-terminating; wrong counter (runs not heads) |
| B. Distinct-head per-tier cap + first-clean early stop + at-cap terminal (this draft) | Matches operator decisions and audit | **Land** — cheapest sufficient |
| C. Per-finding-severity dynamic cap | Retriage each finding class | **Rejected** — scope of brief B; over-engineered for this PR |

**Full-class scenario enumeration** (acceptance criteria below implement each row):

| Dimension | Values | Expected |
| --- | --- | --- |
| Head churn mid-run | Run started on SHA-A; head advances to SHA-B before terminal | SHA-A does not consume budget unless terminal on A; review on B is new distinct head |
| Reaper-killed mid-flight | #624 kills `running` without verdict | No budget increment; same-head retry allowed |
| Superseded run | Head moved; run marked superseded | Excluded from distinct-head set |
| Session restart | AO session respawn; reconcile resumes | Cycle-state persists across restart; no budget reset |
| Multiple PRs per session | One worker session, two PR refs | Budget keyed by **PR number**, not session |
| Tier missing | Issue has no `complexity-tier` fence | Default T2, cap 4 |
| Tier relabeled mid-cycle | Issue updated T2→T3 while PR in flight | Cap frozen at cycle-open tier |
| Same-sha infra retry | #461 same-head infra retry on same head | Single budget unit for that SHA |
| Failed zero-finding | #60 empty-review trap | No budget increment; not clean |
| Failed with findings | Reviewer crash after emitting findings | One budget unit; same-sha fix allowed without second increment |
| First clean head | `clean`, zero findings | `clean_early_stop`; block further auto review |
| At cap, open findings | 4th distinct head on T2 with `needs_triage` | `at_cap_open_findings`; no 5th auto start |
| New head after `clean_early_stop` | Worker pushes after eligibility | New cycle, fresh budget |

```contract-evidence
binding-id: orchestrator-pack:review-cycle-cap:tier-default-t2
binding-type: cli-behavior
binding: when no complexity-tier is resolvable for a bound PR task, distinct-head cap defaults to 4 (T2)
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
selector: cap gate with missing tier input
expected: cap=4 tier=T2

binding-id: orchestrator-pack:review-cycle-cap:distinct-head-cycle-state
binding-type: cli-behavior
binding: distinct-head budget increments only on terminal verdict-bearing runs per normalized targetSha; same-sha retries do not increment
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
selector: cycle-state with same-sha retry fixture
expected: single budget unit

binding-id: orchestrator-pack:review-cycle-cap:clean-early-stop
binding-type: cli-behavior
binding: first terminal clean run on a distinct head sets clean_early_stop and blocks further automated review starts for the PR until cycle reset
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
selector: PR with clean terminal on head
expected: merge-eligible terminal recorded

binding-id: orchestrator-pack:review-cycle-cap:at-cap-terminal
binding-type: cli-behavior
binding: when distinct-head count reaches tier cap with open findings, emit at_cap_open_findings record with schema_version pr_number head_sha tier cap distinct_heads_reviewed open_finding_count timestamps
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
selector: T2 PR with 4 distinct reviewed heads and open findings
expected: terminal record consumable by brief B

binding-id: orchestrator-pack:review-cycle-cap:ao-010-read-model
binding-type: unstructured
binding: cap gate consumes pack review run records via #611 read model, not ao review list argv
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
selector: static guard or fixture proving no dead argv on cap path
expected: #611 reader entry point referenced
```

## Files in scope

- Shared cap / cycle-state module under `scripts/**` `(new)` — tier resolution, distinct-head
  set, terminal emission, shared decision API for all start surfaces
- `scripts/review-trigger-reconcile.ps1`, `scripts/review-trigger-reeval.ps1`,
  `scripts/orchestrator-wake-listener.ps1`, `scripts/invoke-orchestrator-claimed-review-run.ps1`
  — consult shared cap decision before claimed start `(update)`
- `docs/worker-iteration-cycle.mjs` — only if needed for PR-scoped cycle-state hook; must not
  fork #332 cycle machine `(extend cautiously)`
- `agent-orchestrator.yaml.example` — replace ROUND LIMIT with tier-cap / early-stop prose
  `(update)`
- `prompts/agent_rules.md` — pointer to cap semantics for orchestrator/worker surfaces
  `(update if needed)`
- `tests/**` + `tests/external-output-references/**` — scenario matrix fixtures `(new)`
- Static guard forbidding reintroduction of flat 20-run-only cap without tier keyed budgets
  `(new, planner names)`

## Files out of scope

- Merge triage gate, BLOCK vs MERGE+DEFER markers, deferred-findings catalog — **brief B**
- Same-(PR,sha) dedup — **brief C**
- Failed-run root-cause remediation — TASK-457 / #312 lineage
- AO 0.10 migration mechanics — #611 session/report reader implementation, #619, #626/#632
  (this draft **consumes** #611, does not author it)
- Spec/draft review per-tier flow — local draft 188 / #575
- Tier rubric authoring — local draft 187 / #574
- Stuck-run reaper implementation — #624 / draft 211 (compose only)
- `vendor/**`, live `agent-orchestrator.yaml`, AO core

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
tests/**
tests/external-output-references/**
docs/**
agent-orchestrator.yaml.example
prompts/agent_rules.md
~/.local/state/**
```

## Acceptance criteria

1. **#611 read-model binding.** Cap logic reads run rows through the pack's AO 0.10 review
   status reader (#611); static guard or fixture proves the cap module does not shell out
   to removed `ao review list` / `ao review run` argv on the decision path.

```positive-outcome
asserts: cap gate module imports or calls the #611 review-status reader; guard fails if cap decision path references dead ao review list argv
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: review-cycle-cap
expected: ao-010-read-model
proof-command: npx vitest run -t "cap gate uses review status reader"
```

2. **Tier default, precedence, and freeze.** Unresolvable tier → T2 cap 4. At cycle
   open, when both the bound issue `complexity-tier` fence and rubric/default disagree,
   the issue fence wins (table priority 1). Fixture proves T3 fence + default T2 → cap 8.
   Tier at cycle open is frozen — relabel on the issue body mid-cycle does not change cap
   for the active cycle.
```producer-emission
producer: orchestrator-pack
datum: review-cycle-cap
expected: tier-default-t2
proof-command: npx vitest run -t "tier default T2 cap 4"
```


3. **Distinct-head counting (verdict status matrix).** Fixture matrix: (a) two
   terminal runs same `targetSha` → one budget unit; (b) failed/cancelled zero-finding →
   zero units; (c) failed/cancelled **with findings** → one unit; (d) terminal
   `waiting_update` recognized from #611 row shape → one unit when it represents a
   completed reviewer pass; (e) reaper-killed mid-flight without terminal → zero units;
   (f) four distinct terminal heads on T2 → budget exhausted; (g) two distinct
   terminal heads on T1 → budget exhausted (cap 2); (h) eight on T3 → budget exhausted.
```producer-emission
producer: orchestrator-pack
datum: review-cycle-cap
expected: distinct-head-cycle-state
proof-command: npx vitest run -t "distinct head counting matrix"
```


4. **Clean early stop.** On first terminal `clean` distinct head, record
   `clean_early_stop`, mark PR merge-eligible, and suppress further automated review
   starts until a cycle-reset event. Fixture matrix: **each** automated start surface
   listed in Binding surface (reconcile, reeval, wake-listener, claimed-run, AO 0.10
   trigger shim) consults the shared cap module and does not mint a new review after
   `clean_early_stop` on the same head — not reconcile-only.
```producer-emission
producer: orchestrator-pack
datum: review-cycle-cap
expected: clean-early-stop
proof-command: npx vitest run -t "clean early stop terminal"
```


5. **At-cap terminal.** On budget exhaustion with `open_finding_count > 0`, write
   `at_cap_open_findings` record matching the schema in Binding surface; suppress review
   start on **every** automated start surface (same list as AC#4); fixture proves
   brief-B-required fields are present. No triage or merge action in this PR.
```producer-emission
producer: orchestrator-pack
datum: review-cycle-cap
expected: at-cap-terminal
proof-command: npx vitest run -t "at cap open findings terminal"
```


6. **Scenario matrix — head churn.** Run started on SHA-A; head advances to SHA-B before
   A terminals → A does not consume budget even if A later terminals stale; B is reviewable
   as next distinct head. Fixture includes late stale-A terminal after B is current.

7. **Scenario matrix — session restart and multi-PR.** Cycle-state persists across reconcile/session
   restart without budget reset. Two PRs on one worker session maintain **independent**
   budgets keyed by `pr_number`.

8. **Scenario matrix — superseded and infra retry.** Superseded run excluded. Same-sha
   #461-class retry after terminal `needs_triage` does not add a second budget unit.

9. **Scenario matrix — post-eligibility new head.** After `clean_early_stop`, a new commit
   opens a new cycle (fresh budget, prior terminal cleared for orchestration purposes).

10. **Scenario matrix — at-cap head advance without clearance.** After
    `at_cap_open_findings`, a new head push **does not** clear the terminal or open a fresh
    budget until brief B triage or operator clearance. Fixture matrix on new SHA: **every**
    automated start surface (reconcile, reeval, wake-listener, claimed-run, AO 0.10 shim)
    is suppressed while `at_cap_open_findings` remains recorded.

11. **Prompt alignment.** `agent-orchestrator.yaml.example` no longer instructs the flat
    20-run ROUND LIMIT as the sole cap; tier-cap and early-stop prose present. Guard fails
    if ROUND LIMIT is reintroduced without tier-keyed replacement.

12. **Composition guards.** Existing #332 cycle gate, #189 covered-head check, and #318
    claimed-start requirement still pass their fixtures — cap is an additional gate, not a
    bypass.

## Upgrade-safety check

- Cap cycle-state and terminal records are pack-owned JSON/state under pack paths — survive AO
  upgrades without `ao.db` schema coupling.
- Default T2 when tier missing ensures behavior before #187/#189 ship.
- No new dependency on removed AO 0.9 review CLI verbs.

## Verification

1. `npx vitest run` for cap cycle-state unit tests and scenario matrix fixtures (AC#2–9).
2. `pwsh -NoProfile -File scripts/verify.ps1` and `pwsh -NoProfile -File scripts/check-reusable.ps1`.
3. Static guard: cap path uses #611 reader; no dead `ao review list` on cap path (AC#1).
4. Static guard: `agent-orchestrator.yaml.example` tier-cap prose present; flat 20-only
   cap absent (AC#10).
5. Replay fixture: `at_cap_open_findings` record validates against brief-B consumer
   schema checklist (AC#5).