# CI-failure intent claim: tolerate the create→fill / release window on the EEXIST loser path


GitHub Issue: #296
> **Urgency: not urgent** (but not zero-impact). The defect never sends a
> duplicate ping and never crashes the orchestrator — both the intended
> `intent_token_present` and the actual `helper_error` paths resolve to
> `SUPPRESS`. The residual cost: a benign contention race is classified
> `helper_error`, and under repeated contention that **inflates #90's
> consecutive-`helper_error` budget**, which is an operator-visible escalation —
> i.e. a false alarm, not a silent no-op. Sustained contention is unlikely while
> the orchestrator runs operator-gated/serialized, so this stays a
> robustness/determinism follow-up, not a hotfix. No revert of #289 is warranted.

**GitHub Issue:** #296

## Prerequisite

`docs/issues_drafts/90-ci-failure-notify-cross-path-dedup.md` (GitHub #283) —
this draft extends #90's atomically-claimed write-ahead intent-token contract.
The feature is already merged (PR #289); this folds a Codex review finding back
into the upstream claim contract rather than hand-patching the merged code.

## Goal

Make the intent-claim loser path deterministic when it observes a contended
token that is *not yet fully written* or *already released*. Today the loser
catches `EEXIST` and immediately parses the token file; in the create→fill or
release window it instead sees an empty, partially-written, or absent file, the
parse/read throws, and the helper exits as `helper_error` instead of the
intended deterministic dedup verdict. The end state: every EEXIST-loser
observation resolves to a deterministic, dedup-safe verdict (never an uncaught
throw, never a spurious `helper_error`), across the full set of token-content
states reachable in the contention window.

```behavior-kind
action-producing
```

(The claim helper emits the `SEND` / `SUPPRESS` terminal action that enacts or
suppresses the CI-failure notification, so its decision is action-producing.)

## Root cause (5 Whys)

1. **Why** did a contended loser surface `helper_error` instead of the dedup
   verdict? — The EEXIST branch reads-and-parses the token file unconditionally;
   the read/parse threw.
2. **Why** did it throw? — In the contention window the file can be present but
   empty or partially written (the writer creates the file, *then* fills it),
   or absent (a rapid release removed it after the loser's create attempt
   failed with EEXIST).
3. **Why** did the reader assume committed content? — The claim contract treated
   "create-if-absent failed with EEXIST" as proof of a *readable* record,
   conflating *file exists* with *record committed*.
4. **Why** didn't acceptance catch it? — #90's "concurrent intent-token claim"
   row asserted "exactly one sends, the other suppresses" but its fixture only
   exercised the fully-written token state, never the in-flight or released
   sub-states.
5. **Root** — the spec under-enumerated the EEXIST-branch read states. The
   create→fill gap and the release-before-read window are distinct equivalence
   classes that were never fixtured. **Fix the class:** require the loser path to
   tolerate empty / partial / absent token content and resolve deterministically
   to the dedup-safe terminal, and fixture every sub-state
   ([[fix-the-class-not-the-case]]).

## Full-class enumeration (hand to acceptance criteria as fixtures)

**Dimension A — token-file state observed by the loser after EEXIST:**

| Class | State at read | Required resolution |
|-------|---------------|---------------------|
| A1 | Fully-written valid record (current happy path) | Deterministic dedup verdict from the record (already correct) |
| A2 | File present, **zero bytes** (writer created, not yet filled) | Deterministic dedup-safe verdict — never an uncaught throw, never `helper_error` |
| A3 | File present, **partial / truncated** content | Same as A2 |
| A4 | File **absent** at read (removed between the failed create and the read) | Dedup-safe **SUPPRESS** — a contended loser cannot prove the winner didn't already send, so at-most-once is preserved. Never an uncaught throw, never `helper_error` |

**Dimension B — what produced the contention:**

- B1 *Concurrent claim* — a second turn races the winner's create→fill. The loser
  must converge on the dedup-safe SUPPRESS once a committed record is (or
  becomes) observable; the transient empty/partial state must not leak as a
  store error.
- B2 *Removed-before-read* — the token is gone by the time the loser reads
  (e.g. the holder released it). From the contended loser's vantage this is
  **ambiguous**: it cannot tell whether the winner already sent and then
  released, or never sent. Preserving #90's at-most-once invariant, the loser
  must resolve to **SUPPRESS** — it does *not* re-claim and SEND on bare
  absence. Reclaim-and-resend remains #90's **owner-side** path, gated on an
  *observable* `ao send` failure (a positive release signal), and is explicitly
  out of scope for this contended-loser fix; do not introduce a new resend on
  the loser path.

**Terminal-safety rule across all ambiguous cells:** after a bounded number of
in-window observations that yield no committed record, the helper falls back to
the **dedup-safe terminal** (suppress the duplicate; never emit a second ping on
a contended episode) and **does not** classify the benign race as
`helper_error` — so it must not inflate the consecutive-`helper_error`
escalation counter for what is normal contention.

**Sibling-cell note (state the principle, do not prescribe code).** The
audit-record writer already tolerates `EEXIST` correctly (retry with a fresh
unique name; no read-after-EEXIST). The read-after-EEXIST anti-pattern is
localized to the claim path, but the durable principle — *a reader of a
create-then-fill sentinel must tolerate the create→fill gap and the
release window* — should hold anywhere the feature reads a token it did not
itself just write (including any failed-owned write path), so the class does not
reappear elsewhere.

## Binding surface

- The intent-claim loser path (EEXIST branch) MUST resolve every Dimension-A
  state to a deterministic terminal action without an uncaught exception escaping
  the helper.
- A benign contention race (A2/A3/A4) MUST NOT be reported as `helper_error` and
  MUST NOT count toward the `helper_error` escalation budget defined by #90.
- The at-most-once / no-duplicate-ping invariant from #90 is preserved: the
  dedup-safe resolution for every ambiguous loser observation (empty / partial /
  absent) is SUPPRESS, never a second SEND. The contended-loser path introduces
  **no new SEND** — reclaim-and-resend stays #90's owner-side path gated on an
  observable `ao send` failure (out of scope here).
- *Implementation of the wait/retry/backoff mechanism and the token storage
  primitive remains the planner's choice* — the contract is the deterministic
  per-class resolution and the no-duplicate invariant, not a specific retry loop.

## Files in scope

- `docs/ci-failure-notification.mjs` — the intent-claim helper (and its paired
  `.d.ts` / `.d.mts` declarations if the export shape is touched).
- `scripts/ci-failure-notification.test.ts` and
  `scripts/fixtures/ci-failure-notification/**` — the helper's existing test and
  fixture surface (planner extends these; layout inside is the planner's).

## Files out of scope

- The rest of the #90 contract (episode-key derivation, predicate, reaction
  wiring, operator adoption) — unchanged.
- `agent-orchestrator.yaml`, `orchestratorRules`, `reactions`.
- Any AO core / vendor surface.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
docs/ci-failure-notification.mjs
docs/ci-failure-notification.d.ts
docs/ci-failure-notification.d.mts
scripts/ci-failure-notification.test.ts
scripts/fixtures/ci-failure-notification/**
```

## Acceptance criteria

- A fixture exercises **A1** (fully-written record): loser returns the
  deterministic dedup SUPPRESS verdict from the existing record (regression
  guard, unchanged behavior).
- A fixture exercises **A2** (present, zero-byte token that stays uncommitted):
  loser returns terminal **SUPPRESS** (dedup-safe fallback), the helper does
  **not** throw, and the result is **not** classified `helper_error`.
- A fixture exercises **A3** (present, partial/truncated content that stays
  uncommitted): same observable as A2 — terminal **SUPPRESS**, no throw, not
  `helper_error`.
- A fixture exercises the **create→fill transition** (the core race): the
  contended token is empty/partial on the loser's first read and a **valid
  committed record** is present on a subsequent read within the bounded budget →
  the loser returns terminal **SUPPRESS** with reason **`intent_token_present`**
  (the precise dedup verdict from the committed record), proving it tolerates and
  re-reads the window rather than collapsing to the fallback on the first parse
  failure. The empty/partial→committed read sequence is staged
  **deterministically** by the test (a controlled readback sequence against the
  store), not via scheduler timing.
- A fixture exercises **A4** (token absent at read, removed after the failed
  create): the loser returns terminal **SUPPRESS** (at-most-once preserved — no
  re-SEND on bare absence), does **not** throw, and is **not** classified
  `helper_error`.
- A fixture asserts that a benign contention race (A2/A3/A4) does **not** yield
  a `helper_error`-classified result — so it never feeds #90's
  consecutive-`helper_error` escalation budget. (Observable on the helper's own
  return value, within scope; the counter's enforcement path is unchanged.)
- A **two-claimant** fixture asserts the no-duplicate invariant: the winner
  (create succeeds → `SEND`) and the loser (EEXIST → `SUPPRESS`) run
  **sequentially against one shared store**, and exactly one `SEND` is observed
  across the pair. (Sequential two-call scenario — deterministic, no scheduler
  race.)

```positive-outcome
asserts: on a realistic simulated race where the contended intent token is present but not yet fully written, the claim helper returns a deterministic dedup-safe SUPPRESS verdict without throwing and without classifying the race as helper_error
input: realistic
```

## Upgrade-safety check

- No AO core (`packages/core/**`) or `vendor/**` edits.
- No new repo secrets, no operator-facing config changes (purely internal
  robustness of an existing helper) — no operator adoption section required.
- No change to the #90 terminal-action vocabulary (still `SEND` / `SUPPRESS`,
  `helper_error` only for genuine store errors, never a third action value).

## Verification

- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/94-ci-failure-claim-read-race-tolerant.md` passes.
- `npx vitest run scripts/ci-failure-notification.test.ts` is green with the new
  A1, A2, A3, A4 + create→fill-transition + helper-error-classification +
  two-claimant no-duplicate fixtures added to the existing helper suite. Each
  acceptance bullet maps 1:1 to a fixture.
- The single-state Dimension-A cases are reproduced **deterministically as a
  fixed store state** in the suite's real temp-dir token store
  (present-but-empty, present-but-partial-JSON, or absent); the create→fill case
  uses a **deterministic readback sequence** (empty/partial → committed); the
  no-duplicate case is a **sequential two-call** winner→loser scenario over one
  shared store. None requires a scheduler race or live filesystem timing — the
  contract is the resolution per observable state/sequence, not a timing window.
