# T3 stage-completeness receipt gates issue-body sync

GitHub Issue: #620

## Prerequisite

Depends on (must be shipped before this gate is meaningful):

- `docs/issues_drafts/189-tier-gate-recompute-and-stage-selection.md` (GitHub #576, closed) —
  ships tier-gate guard + **sync coupling** (`scripts/publish-issue-body-sync` refuses
  create/edit without a passing tier-gate receipt). **Reused here:** the same inject-before-`gh`
  coupling pattern and independent guard-order semantics — this draft adds a **second**
  receipt check, it does not replace or weaken the tier gate.
- `docs/issues_drafts/188-per-tier-review-flow-finding-ownership.md` (GitHub #575, closed) —
  defines the T3 review pipeline (competitive ≤3 → architectural ≤4 → architect lens ×1 →
  final architectural ×1), capture layout
  (`docs/issues_drafts/.review/NN-<slug>/pass-NN-<stage>.capture.txt` +
  `finding-disposition-ledger.json`), and finding-ledger guard. **Reused, not rebuilt:**
  stage definitions and ledger consistency remain #188's contract.
- `docs/issues_drafts/190-relocate-draft-authoring-to-cursor-session.md` (GitHub #579, closed)
  — relocation contract; the 2026-07-06 incidents that motivate this draft are architect-side
  pipeline skips on the relocated path.
- `docs/issues_drafts/207-pack-owned-architect-edit-guard-draft-author-gate.md` (GitHub #618) —
  sibling guard for architect direct-edit bypass; orthogonal to stage receipts.

Builds on / references (already shipped — **invoked, not rebuilt**):

- `scripts/check-tier-gate-guard.ps1` + `scripts/tier-gate-guard.ts` + `scripts/lib/tier-gate-core.ts`
  — parse `complexity-tier` fence and emit tier-gate receipt. **Reused:** tier detection for
  whether stage-completeness applies (T3 only); prefer reusing fence parsing over ad-hoc
  re-parse when practical.
- `scripts/check-finding-ledger-guard.ps1` + `scripts/finding-ledger-guard.mjs` — validate
  captures ↔ ledger consistency and protected-signal coverage. **Gap this draft closes:** the
  ledger guard does **not** check that required T3 stages exist or are ordered (verified
  2026-07-06: draft #206 passed all mechanical gates with zero competitive captures and no
  lens capture at sync time).
- `scripts/check-draft-discipline.ps1` — positive-outcome, parked-root, contract-evidence
  floors (unchanged).
- `scripts/lib/publish-issue-body-sync.ts` — `validateTierGateGuardReceipt` +
  `syncPublishIssueBody` call site (lines ~270–307): inject guard, return
  `{ ok: false, message }` before any `gh` mutation. **Extended here** with the same pattern
  for stage-completeness.

**Incident evidence (this checkout — cite only, do not edit):**

- `docs/issues_drafts/.review/206-ao-010-session-status-readers-migration/` — operator
  intervention added `pass-01..03-competitive.capture.txt`, `pass-05..07-architectural-lens.capture.txt`,
  and `pass-04-architectural-final.capture.txt` **after** an initial sync that passed tier-gate,
  discipline, and finding-ledger guards without them. Pass indices are non-monotonic across
  stage kinds (e.g. `pass-02-architectural-final` predates competitive passes) — ordering
  must use the numeric `pass-NN` prefix, not file mtimes (harvest copies via `cp`).

Prior-art verdict (**recon 2026-07-06**): **genuinely new single-PR guard build.** `gh issue list`
(search: `stage completeness`, `stage-completeness`, `t3 stage receipt`, `tier gate receipt sync`)
found #576/#575/#579 on adjacent topics but **no open or closed issue** owning T3
stage-completeness sync coupling. Local `docs/issues_drafts/**` grep found no queued draft on
this axis. #576/#189 scope boundary: tier **assignment** receipt and marker screen — **not**
review-stage inventory or ordering. Decomposition: one coherent guard + sync wiring + tests;
not a child of #207.

## Goal

Close the class of **"all mechanical gates green but architect pipeline stages skipped"** on T3
drafts by coupling issue-body sync to **T3 stage-completeness receipts**. For any draft whose
`complexity-tier` fence says **T3**, `scripts/publish-issue-body-sync` create **and** edit
**refuse** unless the draft's review directory proves the architect-critical stage sequence
completed in order:

1. **Competitive stage satisfied:** at least one `pass-*-competitive.capture.txt` **or** a
   machine-readable competitive-stage waiver/substitution record in the review directory.
2. **Architect lens after competitive:** at least one `pass-*-architectural-lens.capture.txt`
   whose `pass-NN` index is **strictly greater** than the lens-ordering anchor. The anchor is
   the highest competitive `pass-NN` **whenever at least one competitive capture exists —
   captures take precedence over any waiver record**; the waiver `after-pass` anchor applies
   only when no competitive capture exists.
3. **Final architectural after lens — exactly one:** **exactly one**
   `pass-*-architectural-final.capture.txt` whose `pass-NN` index is **strictly greater** than
   the highest `architectural-lens` `pass-NN`. Zero such captures fails (missing final); more
   than one fails (ceiling exceeded — the #575 budget is one final pass over architect edits,
   not a convergence loop). `architectural-final` captures with indices at or below the lens
   maximum are tolerated as history and not counted.

Plain `architectural` captures (the draft-author's ordinary Codex loop) remain recognized
tokens but are **not** inventoried or ordered by this guard: in live practice they precede the
competitive stage (authoring converges first), and the incident class this guard closes is
missing competitive/lens/final — not missing ordinary architectural passes, whose findings the
finding-ledger guard already covers.

Each counted capture MUST be **non-empty** after trim and MUST parse a valid `pass-NN` index and
stage token from its filename — empty or malformed filenames fail closed (structural validity,
not capture-body substring matching).

Fail-closed: missing, ambiguous, or out-of-order receipts block sync with a **classified error**
naming the missing or mis-ordered stage. **T1/T2 drafts are unaffected** (their pipelines omit
these stages). **Worker PR review, `ao review`, and CI PR gates are untouched.**

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T2
```

The guard enacts observable allow/deny on sync; regression fixtures prove refusal and pass paths.

## Binding surface

- **Stage-completeness guard (new).** A pack-owned check (planner picks script name and module
  layout under allowed roots) that, given a draft path and its review directory, validates the
  three receipt rules above **only when** the draft's `complexity-tier` fence tier is T3.
  Non-T3 inputs exit zero without requiring T3 captures (no-op pass). The guard emits a
  machine-readable pass message on success (receipt naming tier=T3 and the satisfied anchors)
  and stderr errors prefixed for grep (`stage-completeness guard:` or equivalent stable prefix).
- **Capture validity (structural).** A filename counts toward stage satisfaction only when (a)
  it matches `pass-NN-<stage>.capture.txt` with parseable integer `NN` and known stage token,
  and (b) file body is non-empty after trim. Do **not** scan capture bodies for stage markers
  (prompt-echo trap); structural filename + non-empty checks only.
- **Ordering signal (harvest-stable).** Stage order is derived from the numeric `pass-NN` index
  in the existing `pass-NN-<stage>.capture.txt` naming convention and/or an explicit
  machine-readable stage record — **never from file mtimes**. When multiple captures share a
  stage token, use the **maximum** `pass-NN` for that stage class when comparing ordering.
  Stage tokens **counted** by this guard: `competitive`, `architectural-lens`,
  `architectural-final` — structural validity (parseable `pass-NN`, non-empty body) is
  enforced only for these. Plain `architectural` captures are **tolerated and ignored**:
  their presence, absence, emptiness, or ordering never passes or fails this guard.
- **Competitive waiver / substitution path.** When GPT competitive review is substituted
  (Codex-only) or waived by operator policy, the review directory MUST contain a
  machine-readable record (planner picks filename; e.g. `competitive-stage-waiver.json`) with at
  least: `reason` (`codex-substitution` | `operator-waiver`), `recorded-at` (ISO-8601), and when
  no competitive capture exists, an `after-pass` integer anchor for lens ordering (defaults to
  `0` when competitive captures are entirely waived). The guard fails closed when T3 sync is
  attempted without competitive captures **and** without a valid waiver record.
- **Prompt-echo resistance.** The guard MUST NOT classify stage satisfaction by raw substring
  scans of capture bodies (today's incident: a final capture echoing the reviewer prompt
  false-positived protected-signal scans). Bind to **structural signals** — filename
  `pass-NN-<stage>` tokens and optional machine-readable stage records — not capture prose.
- **Sync coupling (same pattern as #576).** `scripts/publish-issue-body-sync` create/edit
  invokes the stage-completeness guard **after** the tier-gate guard and **before** any `gh`
  mutation, using the same `{ ok, message }` injection style as
  `validateTierGateGuardReceipt`. Guards are **independent** — tier-gate failure, discipline
  failure, finding-ledger failure, or stage-completeness failure each blocks sync alone.
- **Grandfather policy for pre-existing review dirs.** Review directories that already existed
  on `main` before this guard ships are **grandfathered** via a **hardcoded basename allowlist
  inside the guard implementation** — initially only
  `206-ao-010-session-status-readers-migration` (GitHub #619, already synced). The guard exits
  zero for that basename without requiring T3 stage captures or renumbering. **Do not** commit
  marker files into grandfathered `.review/**` trees (they remain evidence-only / out of scope).
  Sibling drafts not yet on `main` (e.g. #207) are **not** grandfathered — they must conform
  once synced. **New** T3 drafts after merge MUST conform; no grandfather for `.review/208-*`
  onward.
- **Skill / pre-sync documentation.** Update `create-issue-draft` pre-sync guard order to list
  stage-completeness alongside tier-gate and finding-ledger (planner picks exact prose location
  in `.claude/skills/create-issue-draft/SKILL.md` or thin pointer under allowed roots).

```contract-evidence
binding-id: orchestrator-pack:stage-completeness-guard:t3-missing-competitive-blocks
binding-type: cli-behavior
binding: stage-completeness guard exits non-zero for a T3 draft whose review dir lacks competitive captures and lacks a valid waiver record
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:stage-completeness-guard:t3-missing-final-blocks
binding-type: cli-behavior
binding: stage-completeness guard exits non-zero for a T3 draft whose review dir has competitive and lens captures but no architectural-final capture at all
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:stage-completeness-guard:t3-empty-capture-blocks
binding-type: cli-behavior
binding: stage-completeness guard exits non-zero when a stage-counting capture file is empty after trim or has an unparseable pass-NN filename
producer: orchestrator-pack
evidence: NEW(produced-by AC#9)

binding-id: orchestrator-pack:stage-completeness-guard:t3-missing-lens-blocks
binding-type: cli-behavior
binding: stage-completeness guard exits non-zero for a T3 draft whose review dir has competitive (or waiver) and architectural-final captures but no architectural-lens capture at all
producer: orchestrator-pack
evidence: NEW(produced-by AC#12)

binding-id: orchestrator-pack:stage-completeness-guard:t3-lens-ordering-blocks
binding-type: cli-behavior
binding: stage-completeness guard exits non-zero when the highest architectural-lens pass index is not strictly greater than the highest competitive pass index or waiver anchor
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:stage-completeness-guard:t3-final-before-lens-blocks
binding-type: cli-behavior
binding: stage-completeness guard exits non-zero when the highest architectural-final pass index is not strictly greater than the highest architectural-lens pass index
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:stage-completeness-guard:t3-final-ceiling-blocks
binding-type: cli-behavior
binding: stage-completeness guard exits non-zero when more than one architectural-final capture has a pass index greater than the highest architectural-lens pass index
producer: orchestrator-pack
evidence: NEW(produced-by AC#13)

binding-id: orchestrator-pack:stage-completeness-guard:t1-t2-noop-pass
binding-type: cli-behavior
binding: stage-completeness guard exits zero for T1/T2 tier-fenced drafts without requiring T3 stage captures
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:publish-sync-refusal:no-stage-completeness-receipt
binding-type: cli-behavior
binding: issue-body sync refuses create/edit when stage-completeness guard fails for a T3 draft
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)

binding-id: orchestrator-pack:stage-completeness-guard:t3_guardpasspayload
binding-type: cli-behavior
binding: stage-completeness guard emits machine-readable stdout receipt naming tier=T3 and satisfied stage anchors on pass
producer: orchestrator-pack
evidence: NEW(produced-by AC#11)
```

## Files in scope

- New stage-completeness guard under `scripts/**` (CLI + core module) and regression tests.
- `scripts/lib/publish-issue-body-sync.ts` — inject stage-completeness validation in
  `syncPublishIssueBody` (mirror tier-gate deps pattern).
- `scripts/publish-issue-body-sync.test.ts` — sync refusal/proceed fixtures.
- `.claude/skills/create-issue-draft/**` — pre-sync guard order documentation only.
- `tests/**` — fixtures for ordered/missing/out-of-order review dirs.

## Files out of scope

- `docs/issues_drafts/206-*.md`, `207-*.md` and their `.review/**` trees (evidence only;
  grandfather policy references them, does not rewrite).
- `scripts/check-tier-gate-guard.ps1`, `scripts/check-finding-ledger-guard.ps1`,
  `scripts/check-draft-discipline.ps1` — invoked as floors, not rebuilt.
- Worker PR review path, `ao review`, CI PR gates, `scripts/pr-scope-check.ps1`.
- `prompts/agent_rules.md` per-tier pipeline definitions (#575 owns counts).
- `vendor/**`, `packages/core/**`, `.ao/**`, `agent-orchestrator.yaml`.

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
.claude/skills/**
docs/**
```

## Acceptance criteria

1. **Observable — missing competitive:** fixture T3 draft + review dir with architectural,
   architectural-lens, and architectural-final captures but **no** competitive captures and
   **no** waiver record → stage-completeness guard exits non-zero; error class names missing
   competitive stage.

```producer-emission
producer: orchestrator-pack
datum: stage-completeness-guard
expected: t3-missing-competitive-blocks
proof-command: npx vitest run -t "stage-completeness missing competitive"
```

2. **Observable — missing final:** fixture T3 review dir with competitive (or waiver) and
   lens captures but **no** `pass-*-architectural-final.capture.txt` at all → guard exits
   non-zero; error names the missing final architectural stage.

```producer-emission
producer: orchestrator-pack
datum: stage-completeness-guard
expected: t3-missing-final-blocks
proof-command: npx vitest run -t "stage-completeness missing final"
```

3. **Observable — lens ordering:** fixture T3 review dir where the highest
   `architectural-lens` `pass-NN` is less than or equal to the highest competitive
   `pass-NN` (or waiver `after-pass` anchor) → guard exits non-zero; error names
   out-of-order architect lens. Includes a **both-signals fixture**: a waiver record with a
   low `after-pass` anchor **and** a later competitive capture whose max `pass-NN` exceeds the
   lens index — the guard must use the competitive maximum (captures take precedence) and
   fail the lens ordering, not pass via the stale waiver anchor.

```producer-emission
producer: orchestrator-pack
datum: stage-completeness-guard
expected: t3-lens-ordering-blocks
proof-command: npx vitest run -t "stage-completeness lens ordering"
```

4. **Observable — final ordering:** fixture T3 review dir where the highest
   `architectural-final` `pass-NN` is less than or equal to the highest `architectural-lens`
   `pass-NN` → guard exits non-zero; error names out-of-order final architectural stage.

```producer-emission
producer: orchestrator-pack
datum: stage-completeness-guard
expected: t3-final-before-lens-blocks
proof-command: npx vitest run -t "stage-completeness final ordering"
```

5. **Observable — T1/T2 noop:** fixture T1 and T2 tier-fenced drafts with empty or partial
   review dirs → stage-completeness guard exits zero (no T3 captures required).

```producer-emission
producer: orchestrator-pack
datum: stage-completeness-guard
expected: t1-t2-noop-pass
proof-command: npx vitest run -t "stage-completeness t1 t2 noop"
```

6. **Observable — sync coupling:** `syncPublishIssueBody` refuses create/edit (non-zero, no `gh`
   call) when stage-completeness guard fails for a T3 fixture, and proceeds when the guard
   passes and other pre-sync checks pass — same injection pattern as tier-gate guard.

```producer-emission
producer: orchestrator-pack
datum: publish-sync-refusal
expected: no-stage-completeness-receipt
proof-command: npx vitest run -t "issue-body sync refuses when stage-completeness"
```

7. **Observable — waiver path:** fixture T3 review dir with valid `competitive-stage-waiver.json`
   (or planner-chosen equivalent), no competitive captures, and lens/final passes
   ordered after the waiver anchor → guard exits zero. **Invalid-waiver negative fixture:** a
   malformed waiver record (unparseable JSON, or missing `reason` / `recorded-at`) with no
   competitive captures → guard treats it as **no waiver** and exits non-zero naming the
   missing competitive stage — a malformed file must never satisfy the bypass.

8. **Observable — grandfather:** guard exits zero for hardcoded allowlisted review-dir basename
   `206-ao-010-session-status-readers-migration` only, without requiring renumbering; no edits
   to that `.review/**` tree. Non-shipped siblings (e.g. #207) are not allowlisted.

9. **Observable — empty/malformed capture rejection:** fixture T3 review dir with zero-byte or
   whitespace-only `pass-01-competitive.capture.txt` (or unparseable filename) → guard exits
   non-zero even if other stage filenames exist.

```producer-emission
producer: orchestrator-pack
datum: stage-completeness-guard
expected: t3-empty-capture-blocks
proof-command: npx vitest run -t "stage-completeness empty capture"
```

10. **Guard order documented:** `create-issue-draft` pre-sync section lists stage-completeness
    guard after tier-gate and alongside finding-ledger; states independence (any failure blocks).

11. **Observable — success receipt:** on a conforming T3 fixture, stage-completeness guard exits
    zero and stdout (or equivalent) includes a machine-readable pass receipt naming `tier=T3` and
    the satisfied stage anchors; sync refuses when the receipt is absent/malformed on an
    otherwise-valid fixture (mirror #576 tier-gate receipt shape).

```producer-emission
producer: orchestrator-pack
datum: stage-completeness-guard
expected: t3_guardpasspayload
proof-command: npx vitest run -t "stage-completeness success receipt"
```

12. **Observable — missing lens:** fixture T3 review dir with competitive (or valid waiver) and
    `architectural-final` captures but **no** `pass-*-architectural-lens.capture.txt` at all →
    guard exits non-zero; error names the missing architect-lens stage.

```producer-emission
producer: orchestrator-pack
datum: stage-completeness-guard
expected: t3-missing-lens-blocks
proof-command: npx vitest run -t "stage-completeness missing lens"
```

13. **Observable — final ceiling:** fixture T3 review dir with competitive (or valid waiver),
    lens captures, and **two** `architectural-final` captures whose `pass-NN` indices both
    exceed the highest lens index → guard exits non-zero; error names the exceeded final
    ceiling (#575 budget: one final pass over architect edits).

```producer-emission
producer: orchestrator-pack
datum: stage-completeness-guard
expected: t3-final-ceiling-blocks
proof-command: npx vitest run -t "stage-completeness final ceiling"
```

```positive-outcome
asserts: stage-completeness guard exits non-zero for a T3-tier fixture draft whose review directory contains architectural-final captures but no competitive captures, no waiver record, and no architectural-lens captures — sync path refuses create in the same fixture run
input: realistic
proof-command: npx vitest run -t "stage-completeness"
red-then-green: must fail before implementation when fixtures are added first
```

## Upgrade-safety check

- No AO core, `vendor/**`, or `packages/core/**` edits.
- No `agent-orchestrator.yaml` or reactions change.
- No new repository secrets.
- Tier-gate, finding-ledger, and discipline guards remain authoritative for their own concerns;
  this guard adds only stage inventory/ordering.
- Grandfather policy prevents retroactive sync breakage for #206 (already on `main`); #207 and
  later drafts must conform.

## Verification

1. Run stage-completeness guard fixtures (AC 1–5, 7–9, 12–13): missing competitive/lens/final,
   out-of-order lens/final, final ceiling exceeded, T1/T2 noop, valid waiver, grandfather,
   empty-capture paths.
2. Run `publish-issue-body-sync` tests (AC 6): sync refuses without passing stage-completeness
   receipt and proceeds with one.
3. `pwsh -NoProfile -File scripts/verify.ps1` and `pwsh -NoProfile -File scripts/check-reusable.ps1`.
4. Discipline guards on this draft:
   - `pwsh -NoProfile -File scripts/check-tier-gate-guard.ps1 -DraftPath docs/issues_drafts/208-t3-stage-completeness-sync-gate.md`
   - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/208-t3-stage-completeness-sync-gate.md`
   - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/208-t3-stage-completeness-sync-gate.md`
   - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/208-t3-stage-completeness-sync-gate.md`

## Decisions (design analysis)

**Prior art (reconnaissance).** #576 ships tier-gate + sync coupling for tier **assignment**
receipts. #188 ships per-tier pipelines and finding-ledger consistency. Neither validates that
T3 architect stages (competitive, lens, final) were **run** before sync. The 2026-07-06 #206
incident proves mechanical gates are insufficient. No queued draft owns this axis.

**Critical mechanics.** (1) *Receipt-coupled sync refusal* is the proven fix class (#576, #366).
(2) *Ordering must survive harvest* — `pass-NN` indices, not mtimes. (3) *Structural signals
only* — filename tokens and JSON waiver records, not capture-body substring scans (prompt-echo
trap). (4) *Independent guards* — stage completeness does not subsume tier-gate or
finding-ledger.

**World practice.** Required-artifact gating before publish — same shape as CI required checks
and deployment approval receipts: the publish path refuses until enumerated prerequisites exist
in deterministic order.

**Architecture sketch.**

```
draft (tier fence=T3) ─▶ [tier-gate guard] ─▶ [discipline guards] ─▶ [finding-ledger guard]
                                                              │
                                                              ▼
                                    [stage-completeness guard: competitive|waiver → lens → final]
                                                              │
                                         fail ────────────────┴──▶ sync refuses (classified error)
                                                              │
                                         pass ──────────────────▶ publish-issue-body-sync → gh
```

**Architect lens (pre-sync simplification).** The authored draft required a fourth stage rule —
a plain `architectural` capture strictly after the last competitive pass. Cut: in live practice
the draft-author's ordinary Codex loop precedes the competitive stage (authoring converges
first), post-competitive verification is carried by `architectural-final`, and the incident
class this guard closes never involved a missing ordinary architectural pass (finding-ledger
guard already owns those findings). The rule would have added per-draft ceremony and false
blocks (the grandfather machinery existed mostly because of it). Added in exchange: the
previously implicit "final capture absent entirely" cell as explicit AC#2.

**Operator-requested ceiling (post-sync amendment, 2026-07-06).** The final stage rule is
tightened from "at least one" to "exactly one" counted `architectural-final` after the lens
maximum (AC#13): the #575 budget is a single verification pass over architect edits, and the
same-day incident showed the architect looping 3–4 "final" passes to NO_FINDINGS instead.
Historical finals at or below the lens maximum are tolerated and uncounted.

**Options considered.**

1. **Prose-only architect obligation** (trust lens/final passes happen). *Rejected:* both
   2026-07-06 incidents; status quo.
2. **Extend finding-ledger guard to infer stages** from ledger entries. *Rejected:* ledger
   normalizes findings, not stage execution; would couple unrelated concerns and still vulnerable
   to prompt-echo if scanning capture text.
3. **Dedicated stage-completeness guard + sync coupling** (chosen). *Cheapest sufficient:*
   mirrors #576 pattern; owns only inventory/ordering; reuses tier fence parsing.

**Full-class enumeration (T3 sync attempt).**

| tier fence | competitive | waiver | lens vs comp/anchor | final vs lens | → guard / sync |
|---|---|---|---|---|---|
| T1/T2 | — | — | — | — | guard noop pass; sync not blocked by this guard |
| T3 | ≥1 competitive | — | lens max NN > comp max NN | final max NN > lens max NN | pass |
| T3 | 0 | valid waiver | lens max NN > waiver anchor | final max NN > lens max NN | pass |
| T3 | 0 | absent | — | — | **fail** — missing competitive |
| T3 | ≥1 | — | no lens capture | — | **fail** — missing lens |
| T3 | ≥1 | — | lens max NN ≤ comp max NN | — | **fail** — lens out of order |
| T3 | ≥1 | — | ok | no final capture | **fail** — missing final |
| T3 | ≥1 | — | ok | final max NN ≤ lens max NN | **fail** — final out of order |
| T3 | ≥1 | — | ok | two finals with NN > lens max NN | **fail** — final ceiling exceeded (×1 budget) |
| T3 | any | any | any | empty/malformed counting capture | **fail closed** |
| grandfathered basename (206 only) | any | — | — | — | pass (grandfather policy) |
