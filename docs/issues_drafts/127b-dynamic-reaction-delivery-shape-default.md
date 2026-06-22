# Dynamic send-to-agent reactions need a default-safe delivery shape when text is unknown

GitHub Issue: TBD

## Prerequisite

- `docs/issues_drafts/127-reaction-delivery-shape-stub-drift.md` (GitHub TBD) — **must ship
  first.** Fixes static-text reactions (`report-stale` and any future reaction with
  `reactions.<key>.message` in YAML). This follow-up owns the complementary class.
- `docs/issues_drafts/77-worker-message-submit-source-agnostic.md` (GitHub #232) — submit
  arbiter, pending-draft vs self-submitted branches.
- `docs/issues_drafts/89-worker-message-delivery-confirmed-consumption.md` (GitHub #373) —
  confirmed consumption / delivery reliability for journaled deliveries.
- `docs/issues_drafts/92-arbiter-budget-eligibility-resume.md` (GitHub #293) — Enter-on-busy
  is enqueue-safe; informs default-safe shape policy **after** overlap is resolved.
- `docs/issues_drafts/117-spec-contract-evidence-grounding-gate.md` (GitHub #366) — no
  producer binding without capture.

## Pre-sync grounding

**Pane capture landed (representative).** `capture@ao-reaction-delivery/findings_delivery_worker_pane`
reproduces AO paste-class delivery of dynamic review-finding text via `ao review send opk-rev-757`
(14-line finding → `[Pasted text #1 +14 lines]`, unsubmitted draft). **Not** a
`changes-requested` reaction event — provenance documents `review-send` reproduction.

**Reaction path dormant.** Zero `changes-requested` `reaction.action_succeeded` events in AO
event log (30d+ search empty). Live findings transport on this operator is **`review-send`**, not
the reaction key. Event capture for the reaction path is a **live-repro obligation only if** the
overlap gate shows a separate reaction-owned delivery.

**Overlap is the first gate (scope verdict, not journal trivia).** Before any default-safe shape
policy (D1 vs D4), AC1 must determine: (a) whether dynamic finding delivery is already owned by
`review-send` journal (`DISPATCH_SOURCE_REVIEW_SEND`); (b) whether **reliability of that live
path** (Enter dispatch, confirmed consumption) already belongs to **#293** / **#373** rather than
this issue. Legitimate AC1 outcomes include **fold** or **narrow scope** — this draft is **not**
a guaranteed full build until AC1 completes.

## Goal

Operator YAML declares `changes-requested` (`auto: true`, `action: send-to-agent`, **no** static
`message:`), but on this deployment the **reaction path does not fire** (0 events in 30d+).
**Live** review-findings delivery to workers runs through **`review-send`** — see representative
capture above.

If / when the reaction path fires, the submit arbiter would **silently drop** it today
(`reactionMessages` lacks the key → `continue` in `extractReactionDeliveries`); after #127,
YAML-read still returns no text. That is a **latent** guard defect on a dormant path — not an
active production incident. Planners must **start at review-send overlap and queued-owner
classification (#293/#373)**; only scope left after AC1 warrants reaction-path implementation here.

This issue **may** define arbiter handling for `send-to-agent` reactions whose text cannot be
resolved from static YAML — without pane scraping (#232), without silent drop on observed
reaction events, and without falsely assuming `self-submitted` when paste is likely. **AC1 may
collapse scope to a minimal sleeping-path guard or fold entirely** — see overlap gate.

```behavior-kind
action-producing
```

```contract-evidence
binding-id: ao:reaction:config.changes-requested.action:send-to-agent
binding-type: unstructured
binding: Live operator config declares changes-requested as send-to-agent without static message field
producer: ao-reaction-config
evidence: capture@ao-reaction-config/changes_requested_config
token: action: send-to-agent
selector: action
expected: send-to-agent

binding-id: ao:reaction:delivery.pane:paste-class-unsubmitted-draft
binding-type: unstructured
binding: AO delivery of dynamic review-finding text shows paste-class unsubmitted draft requiring second Enter
producer: ao-reaction-delivery
evidence: capture@ao-reaction-delivery/findings_delivery_worker_pane
token: [Pasted text
selector: paneContainsUnsubmittedDraft
expected: true
```

## Design analysis (pre-draft gate)

### Critical mechanics

- AO **can** generate `changes-requested` body at runtime (findings prose) — but path is
  **dormant** here (0 events / 30d+).
- `reaction.action_succeeded` event carries `reactionKey` + `action` only — no message body.
- #127 YAML-read cannot supply charLength for this key.
- #232 forbids pane-text shape inference.
- **Live transport:** `review-send` journals findings delivery; **#293** / **#373** may already
  own Enter reliability and confirmed consumption for that path.
- Overlap gate must yield a **scope verdict** (build / narrow / **fold**) — not only “is it
  journaled?”

### Architecture sketch

```
changes-requested (dormant — 0 events/30d+)
    │
    ├─► review-send journal ──► LIVE path (capture: findings_delivery_worker_pane)
    │         │
    │         └──► AC1: owned by #293/#373? ──► fold or narrow #127b
    │
    └─► reaction event (if ever fires) ──► extractReactionDeliveries
              │
              ├─ stub map miss → silent drop (today, latent)
              └─ post-#127 YAML empty → shape unknown
                        │
                        ▼
              scope after AC1 → minimal guard and/or default-safe policy
```

### Options (illustrative — planner picks mechanism **after overlap gate**)

| Option | Cost | Risk | Sufficient? |
|--------|------|------|-------------|
| **D1. Default `pending-draft` when text unknown** + bounded Enter (#293 enqueue-safe) | Low | Low false-negative (extra Enter enqueues); **high if review-send already owns submit** | Yes **only if** overlap proves no duplicate owner |
| **D2. Fail-closed escalate only** (visible, no Enter) | Low | High — worker stays stuck on paste | No as sole policy |
| **D3. AO/journal records actual delivered text at send time** | Medium | Low | Yes, if AO exposes or pack hooks send path |
| **D4. Dedupe to review-send journal only** — ignore reaction events when journal covers | Medium | Medium — ordering/race gaps | **Preferred if overlap proves equivalent delivery** |

**Invariant:** unknown text MUST NOT classify as `self-submitted` solely because a stub map
entry is missing or YAML `message:` is empty. Policy must be explicit, audited, and
capture-backed. **Any observed `send-to-agent` reaction event MUST leave a named audit outcome
— never bare `continue`.**

### Class matrix

| Class | Expected outcome |
|-------|------------------|
| Overlap gate (AC1) | Scope verdict: journaled? single owner? **#293/#373 already own live review-send reliability?** Outcomes: full build / narrow / **fold** |
| `changes-requested` reaction event observed (rare) | Named audit outcome — never silent `continue` |
| Text unknown, no journal overlap | Default-safe shape (planner picks D1/D2/D3 after gate) → bounded Enter attempts |
| Text unknown, review-send journal already tracks same delivery | No double-submit; single owner (#232 exclusivity) — likely D4 |
| Text known via journal/AO record | Use authoritative text — same as #127 |
| Wrong `self-submitted` on likely paste | **Fails** post-fix |

## Binding surface

- **Review-send overlap + scope verdict first (AC1).** Prove whether dynamic finding delivery
  is represented in dispatch journal (`review-send`), whether **#293** / **#373** already own
  live-path Enter/consumption reliability, and record conclusion: proceed full build, **narrow to
  sleeping-path guard only**, or **fold** into queued owners. Policy ACs blocked until AC1 closes.
- **No silent drop** for any observed `send-to-agent` reaction, including dynamic-text keys
  (`extractReactionDeliveries` must not bare `continue` without audit record).
- **Default-safe shape policy** when static YAML text and authoritative delivery record are both
  absent — documented, tested, capture-backed. Must not assume `self-submitted` by default.
  Policy choice follows overlap proof (D1 vs D4, not assumed upfront).
- **#293 enqueue safety** applies if default policy dispatches Enter while worker is busy.
- **Capture-backed grounding (#366).** Delivery pane capture in manifest; reaction-event capture
  added when live `changes-requested` reaction fires or overlap proof shows reaction-owned path.

## Files in scope

- Reaction observation / submit policy for dynamic-text `send-to-agent` reactions.
- Overlap analysis wiring with dispatch journal / review-send path.
- Captures, fixtures, CI guards for `changes-requested` class.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`.
- Static-text reactions (#127).
- Changing `changes-requested` reaction semantics in AO.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

```positive-outcome
asserts: on capture-backed dynamic send-to-agent delivery class, submit arbiter records a named outcome for every observed reaction event and dispatches bounded Enter when overlap proof shows no journal owner — never silent continue and never tracking_auto_submitted solely because YAML message is empty
input: external-tool-output
provenance: capture-backed
```

1. **Review-send overlap + scope gate (first).** Fixture or live proof documents:
   - whether dynamic finding delivery is journaled under `review-send` with real text and
     `pending-draft` shape;
   - ordering / single-owner vs reaction path (if reaction ever fires);
   - **whether live review-send Enter/consumption reliability already belongs to #293 and/or
     #373** (queued shipped work — classify, do not rebuild).
   **Recorded verdict** (one of): **(a)** full #127b build warranted; **(b)** narrow to minimal
   sleeping-reaction guard (audit-only `continue` fix); **(c)** **fold** — defer/close in favor
   of #293/#373 (+ #232 journal path). Policy ACs below are **blocked** until verdict recorded.
2. **Capture landed.** `capture@ao-reaction-delivery/findings_delivery_worker_pane` in manifest;
   integrity passes. Add `capture@ao-reaction-event/*` for `changes-requested` when live
   reaction event is reproduced (none in 30d+ history today).
3. **No silent drop (if scope retained).** When AC1 verdict is (a) or (b): `changes-requested`
   `reaction.action_succeeded` fixture → named audit outcome (not bare `continue` in
   `extractReactionDeliveries`). **Skip when AC1 verdict is (c) fold** — document skip reason.
4. **Default-safe shape (post-gate, if scope retained).** When AC1 is (a): unknown-text fixture
   → not classified `self-submitted` by default; bounded Enter on idle worker **or** documented
   defer to journal owner when overlap proves D4. **N/A when (c) fold.**
5. **No double-submit.** When overlap gate proves journal ownership, reaction path does not
   duplicate Enter (#232 exclusivity). **N/A when (c) fold.**
6. **Negative control.** Pre-fix silent drop + wrong self-submitted path fails after fix when
   scope (a)/(b) applies.

## Upgrade-safety check

- Pack-only; ships after #127.
- No new supervisor process.

## Verification

- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/127b-dynamic-reaction-delivery-shape-default.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/127b-dynamic-reaction-delivery-shape-default.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/127b-dynamic-reaction-delivery-shape-default.md`
- `pwsh -NoProfile -File scripts/verify.ps1`

## Decision log

- Split from #127 per architect review 2026-06-22: YAML-read cannot fix dynamic-text class.
- No-silent-drop invariant moved from #127 per architect review round 2 — same code path as
  dynamic reactions (`extractReactionDeliveries` `continue`).
- NEW producer-emission row removed; delivery shape grounded via
  `capture@ao-reaction-delivery/findings_delivery_worker_pane` (#366); capture id is
  transport-neutral (review-send reproduction, not reaction event).
- Overlap gate precedes D1/D4 policy choice per architect review round 2.
- AC1 scope verdict (build / narrow / fold into #293/#373) per architect review round 3 —
  reaction path dormant (0 events/30d+); live transport is review-send.
