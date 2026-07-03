# Per-tier draft-review flow, finding ownership, and drift-escalation

GitHub Issue: #575

## Prerequisite

Depends on:

- `docs/issues_drafts/187-task-complexity-tier-rubric.md` (GitHub #574) — defines the
  T1/T2/T3 taxonomy and classification this keys its review flow off. Must merge first.

Builds on / references (already shipped — **reused/extended/modified, not rebuilt**):

- `docs/issues_drafts/12-architect-role-tighten.md` (GitHub #37) — the current draft-review
  gate: the author revises valid findings / rebuts wrong ones, converging to `NO_FINDINGS`
  or a fixed iteration cap before sync. **Modified here:** the flow gains per-tier stages, a
  draft-author-owned accept/reject with a reject-log, a non-rejectable carve-out, an architect
  final lens on T3, and drift-escalation. The convergence-or-cap exit and the shipped
  iteration caps are preserved — this draft composes with them, it does not override them.
- `docs/issues_drafts/19-codex-review-finding-bar.md` (GitHub #51) — the finding bar:
  suppress cosmetic/speculative noise, and **never** drop `type: scope-violation` or
  `type: security` findings. **Reused verbatim:** that never-drop invariant is this draft's
  non-rejectable carve-out. **Extended:** the simplification lens is an additional
  finding-generating mandate layered on the same reviewer.
- `docs/issues_drafts/105-graduated-review-intensity-by-change-magnitude.md` (GitHub #329,
  **CLOSED/archived**) — graduated *PR-code* review effort by diff magnitude, decoupled.
  *Distinguished:* this draft graduates *draft/spec* review by intake tier, a different axis
  and lifecycle stage; it does not reopen #329.
- `docs/issues_drafts/75-rca-spec-discipline-against-misdirected-fixes.md` (GitHub #221) —
  behavior-kind. *Orthogonal*, unchanged.

Downstream: **Draft C** (`create-issue-draft` tier gate — recompute + stage-skip
enforcement) consumes this per-tier flow. Out of scope here.

## Goal

Make the **draft/spec review** effort scale with a task's intake tier and fix who owns the
accept/reject of review findings, so that heavy adversarial ceremony runs only where the
tier warrants it and finding decisions do not silently inflate scope. The operating model
this binds to: the **architect** authors the task **brief** and runs the top-tier lens; the
**draft author** — the Cursor drafting session working from that brief — authors the spec
and runs the review loop. For each tier this draft states which review stages run; it
places accept/reject of findings with the **draft author**, recorded in a **disposition
ledger** with a **non-rejectable carve-out** for security and scope-violation findings; it
anchors the guard in a **normalization contract** — the raw reviewer output of every pass
is captured verbatim, and the draft author normalizes it into the structured ledger — so
the carve-out guard is mechanical over a machine-readable artifact rather than
prose-matching; it adds a single **architect lens
pass** on the top tier that audits the reject partition without re-litigating accepts; and
it escalates any tier that drifts **upward** during review back to the architect before
publish. This governs the create-issue-draft **spec review** only — the worker **PR-code**
review safety net is unchanged and out of scope.

```behavior-kind
action-producing
```

The review flow enacts observable actions — accept/reject with a logged reject entry,
carve-out enforcement, upward escalation. The mechanically enforced core is the reject-log
carve-out guard (see positive-outcome).

## Binding surface

Commits the repository to a per-tier draft-review contract with **all** of:

- **Per-tier review pipeline** (draft/spec review, the create-issue-draft Codex stage):
  - **T1** — one light architectural review pass.
  - **T2** — architectural review, up to **3** passes; the first `NO_FINDINGS` pass ends it
    and publishes. No competitive stage. The architect does **not** routinely re-enter —
    only on drift.
  - **T3** — competitive adversarial (**GPT by default; Codex stands in as the adversary
    when GPT is unavailable, the substitution recorded; +Codex joins GPT only when the
    task is T3-critical**, per the within-T3 graduation gate below — the single source of
    the +Codex trigger) up to **3** → regular architectural (Codex) up to **4** →
    **architect lens** pass **1** → final architectural (Codex) over the architect's
    edits **1**.
  - **Cap composition (no override of shipped caps).** The counts are ceilings, not
    quotas — a clean pass ends a stage early. They compose with shipped contracts rather
    than replace them: competitive ≤3 is the shipped adversarial/GPT skill cap;
    architectural ≤4 plus the final verification pass together are the
    #37/create-issue-draft 5-iteration Codex cap.
- **Finding ownership.** On the competitive and architectural stages the **draft author**
  — the Cursor drafting session that authors the spec from the architect's brief and runs
  the review loop — owns accept/reject of findings. The architect does **not** re-decide
  accepted findings — a deliberate guard against the architect's observed tendency to
  over-accept adversarial suggestions and inflate scope. ("Draft author" is a distinct
  role from the downstream implementation planner; that shipped role is unchanged.)
- **Finding-disposition ledger + normalization contract.** Reviewers cannot be relied on
  to emit structured output (a known failure mode in this repo), so the mechanical anchor
  is built in two steps the draft author owns: (a) the **raw reviewer output of every pass
  is captured verbatim** — the audit anchor; (b) the draft author **normalizes** every
  finding from it into a draft-bound disposition ledger, assigning each a **stable finding
  id** (adopting the reviewer's own structure/ids when present, reformatting prose when
  not; a re-worded finding on a later pass maps to its carried-forward id, not a new row),
  with at least: id, summary, `type`, and a **disposition** — `addressed` (accepted/fixed)
  or `rejected` (with a one-line reason). **Completeness is required** on every tier and
  stage that emits findings: a finding present in the captured output but **absent** from
  the ledger is a silent drop, not a valid state; a clean `NO_FINDINGS` pass owes no rows.
  Known residual: the disposition owner is also the normalizer — mitigated by the verbatim
  capture (the spot-check surface), the T3 architect audit, and the final verification
  pass. (The rejected entries are the ledger's "reject" partition — the audit surface the
  architect reads on T3.)
- **Non-rejectable, non-omittable carve-out.** Findings of `type: security` or
  `type: scope-violation` (the #51 shipped vocabulary) have exactly one valid disposition:
  `addressed`. A guard fails when a protected finding is disposed `rejected` **or is absent
  from the ledger while present in the captured reviewer output**. Catching *omission*, not
  only explicit rejection, is what actually preserves #51's never-drop invariant across the
  ownership move — a reject-only check would let the draft author drop a protected finding
  by simply never logging it.
- **Omission-detection contract (what the guard can mechanically decide).** Prose cannot be
  classified perfectly, so detection is layered and **fails closed**: (a) the reviewer
  prompt surface (in scope) **mandates typed/tagged findings** (the #51 vocabulary), making
  the compliant case trivially checkable; (b) the guard runs a **conservative
  protected-signal screen** over the verbatim capture (the protected-type tags plus a small
  lexical marker set — exact heuristics at the implementing planner's discretion): any
  protected-signal hit in the capture with **no matching ledger row** fails the guard —
  a false positive costs an architect confirmation, never a silent pass; (c) prose that
  defeats the screen is the recorded residual, mitigated by the prompt mandate and the T3
  architect spot-check of ledger vs capture. The guard never *passes* by failing to parse.
- **Guard operation.** The carve-out/completeness guard runs in the draft author's session
  **pre-sync**, alongside the shipped draft-discipline checks; a non-zero exit **blocks
  issue sync/publish**. Remediation: re-enter the review loop and address or properly
  disposition the finding; a contested protected finding **escalates to the architect** —
  it is never self-waivable by the draft author.
- **Simplification lens mandate.** The lens — *what can be simplified / what must not be
  simplified / what is excess / what is missing* — is a review mandate on **both** the
  competitive and architectural stages (its outputs enter the normal finding flow, subject to
  the carve-out), and again on the architect's T3 lens pass.
- **Architect T3 lens pass.** On T3 only, after architectural review converges, the architect
  runs one lens pass: audits the **reject-log** (re-judges rejects, does not re-open accepts),
  may edit the draft; then one final architectural review verifies the architect's edits.
- **Drift-escalation.** After review the tier is recomputed (per #187 / draft C); if it drifted
  **upward** — including scope grown by accepted findings — the flow escalates to the architect
  before publish. Downward drift is impossible by the #187 monotonic rule.
- **Within-T3 graduation (T3-critical).** T3 carries an intensified subset gated **by
  reference to the L4-condition list recorded in #187's Decisions** — cited, not restated,
  so the two lists cannot drift. For a **T3-critical** task the competitive stage's
  **+Codex is mandatory** (GPT and Codex together), and a rollback/migration note plus a
  crash/race/stale-state test are required. Non-critical T3 uses the default pipeline
  above.

Deliberately **not** committed here: the tier taxonomy itself (#187), and the mechanism that
recomputes the tier or skips stages by tier (draft C).

## Files in scope

- `prompts/agent_rules.md` — per-tier review-flow, finding-ownership, reject-log, carve-out,
  drift-escalation, and T3-critical clauses.
- The Codex draft-reviewer prompt/finding-bar surface — the simplification-lens mandate
  (extends #51).
- `.claude/skills/create-issue-draft/**` — the **review section only**: per-tier stages,
  reject-log, carve-out, and architect T3 lens pass. (The tier recompute / stage-skip
  wiring is draft C.)
- A finding-disposition ledger format, the per-pass verbatim reviewer-output capture it
  normalizes from, and the guard (new; locations and shapes at the implementing planner's
  discretion), plus a test/lint that fails on a carve-out violation (protected finding
  rejected or omitted) or an incomplete ledger.

## Files out of scope

- The tier taxonomy / classification rubric — `docs/issues_drafts/187-*` (draft A).
- Tier recompute + conditional stage-skip enforcement — draft C.
- The worker **PR-code** review path (unchanged safety net).
- `agent-orchestrator.yaml` / reactions.
- `packages/core/**`, `vendor/**`, `.ao/**`.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
prompts/**
docs/**
scripts/**
tests/**
.claude/skills/**
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:finding-ledger-guard-exit:nonzero-on-protected-drop
binding-type: cli-behavior
binding: finding-ledger guard fails (non-zero exit) when a security/scope-violation finding is rejected or omitted while present in reviewer output
producer: orchestrator-pack-scripts
evidence: NEW(produced-by AC#4)
selector: finding-ledger-guard-exit
expected: nonzero-on-protected-drop
```

The protected-type vocabulary (`security`, `scope-violation`) is not a new binding — it is
the shipped, already-grounded #51 finding-bar contract, cited in **Prerequisite**. This
draft binds only to its own repo-owned finding-ledger artifact, whose guard behavior is the
`NEW` obligation above.

## Acceptance criteria

1. `prompts/agent_rules.md` documents the per-tier draft-review pipeline for T1, T2, T3 with
   the stage sequence and caps in Binding surface, and states it governs spec review, not the
   worker PR-code path.
2. Finding ownership is stated: the draft author (the Cursor drafting session working from
   the architect's brief) owns accept/reject on competitive + architectural stages; the
   architect does not re-decide accepts.
3. A finding-disposition ledger format and its normalization contract are defined: raw
   reviewer output captured verbatim per pass; the draft author normalizes every emitted
   finding into the ledger with a stable id, summary, `type`, and disposition
   (`addressed` | `rejected`+reason); a finding present in the captured output but missing
   from the ledger is an invalid (silent-drop) state; ids are stable across review
   iterations (a re-worded finding maps to its carried-forward id, not a new row).
4. A guard exists that **fails** when a `type: security` or `type: scope-violation` finding
   is disposed `rejected` **or is absent from the ledger while present in the captured
   reviewer output**, and **passes** when every emitted finding is recorded and all
   protected ones are `addressed`; it runs pre-sync alongside the shipped draft-discipline
   checks, and a non-zero exit blocks issue sync/publish. Omission detection follows the
   layered fail-closed contract in Binding surface: typed/tagged findings are checked
   directly; an untagged protected-signal hit in the capture with no matching ledger row
   also fails (false positives escalate to the architect; unparseable prose never passes
   silently).

```producer-emission
producer: orchestrator-pack-scripts
datum: finding-ledger-guard-exit
expected: nonzero-on-protected-drop
proof-command: npx vitest run -t "finding-ledger guard fails when a protected finding is rejected or omitted and passes on a complete ledger"
```

5. The simplification-lens mandate is present on both review stages (in the reviewer/finding-bar
   surface) and on the architect T3 lens pass; lens findings flow normally and remain subject to
   the carve-out.
6. The architect T3 lens pass is documented: reject-log audit, no re-opening of accepts, edits
   allowed, followed by one final architectural verification pass over those edits.
7. Drift-escalation is stated: upward tier drift after review (incl. accepted-finding scope
   growth) escalates to the architect before publish; downward drift is impossible.
8. Within-T3 graduation is stated: the T3-critical gate cites #187's recorded L4-condition
   list by reference (not restated), with mandatory +Codex competitive and required
   rollback/migration note + crash/race/stale test for T3-critical; default pipeline
   otherwise.

```positive-outcome
asserts: the finding-ledger guard exits non-zero on a fixture whose inputs are a verbatim captured reviewer transcript plus a normalized ledger in which a type:security finding is either disposed rejected OR omitted from the ledger while present in the capture, and exits zero when every captured finding is recorded and protected ones are addressed — fixture input is the raw captured transcript, not a pre-structured findings list
input: realistic
```

## Upgrade-safety check

- No edits to AO core, `packages/core/**`, or `vendor/**`.
- No `agent-orchestrator.yaml` schema or reactions change.
- No new repository secrets.
- #51's never-drop invariant is **strengthened, not weakened** — the carve-out makes it
  mechanically enforced on the new reject path; no finding-type is newly droppable.
- The #37 convergence-or-cap exit is preserved; the per-tier stages replace the single fixed
  cap, they do not remove the terminal condition.

## Verification

1. `grep`-level: agent_rules carries the per-tier pipeline, finding-ownership, reject-log,
   carve-out, lens mandate, architect T3 lens pass, drift-escalation, and T3-critical clauses
   (AC 1–3, 5–8).
2. Run the carve-out guard on fixtures built from a verbatim captured reviewer transcript
   plus a normalized ledger: security-typed reject → non-zero; security-typed omission
   (present in capture, absent from ledger) → non-zero; quality-only reject with reason →
   zero (AC 4 + positive-outcome + producer-emission).
3. The reviewer/finding-bar surface contains the four-question lens mandate and still carries
   #51's scope-violation/security never-drop wording (AC 5; cross-check #51 not weakened).

## Decisions (design analysis)

**Prior art (reconnaissance).** No draft builds draft-author-owned finding accept/reject, a
reject-log, or per-tier draft-review staging (coworker corpus survey + grep confirmed only
#187 and the unrelated #28 touch the terms). Adjacent shipped: #37 (draft-review gate —
modified), #51 (finding bar — reused/extended), #329 (PR-review graduation — closed,
distinguished), #221 (behavior-kind — orthogonal). Reuse-vs-add is explicit above; no
shipped machinery is re-implemented.

**Critical mechanics.** (1) *Ownership placement is the anti-inflation lever.* The architect
evaluating raw adversarial findings measurably over-accepts (each "you should also handle X"
reads as safe to add), so accept/reject moves to the draft author and the architect is
repositioned as a **reducer** — the lens (simplify/excess) is a net-cut, applied once, late.
(2) *The carve-out is non-negotiable* because the ownership move would otherwise let the
draft author drop a security/scope finding #51 guarantees; it is enforced mechanically on
the disposition ledger — catching both rejection and omission against the verbatim
capture — not by prose. (3) *Drift is the second anti-inflation net*: if findings grew the scope, the tier
recompute catches it as upward drift and escalates — inflation cannot ride through silently.
(4) *The architect's own edits are themselves reviewed* (the final architectural pass), so the
reducer is not an unchecked last mutator.

**World practice.** This mirrors editorial/security review separation of duties: the party
that can *add* scope is not the party that signs off on *cutting* it, and a protected class of
findings (here security/scope) is never waivable by the line reviewer — the standard
"four-eyes with a non-waivable severity floor" pattern.

**Architecture sketch.**

```
T3 draft ─▶ competitive (GPT | Codex-fallback; +Codex if T3-critical) x≤3 ─▶ architectural (Codex) x≤4
              raw output captured verbatim ─▶ draft author normalizes ─▶ [ledger: addressed|rejected]
                                                                           ──guard──▶ (protected rejected OR omitted vs capture ⇒ FAIL, blocks sync)
                                                                │
              ┌─────────────────────────────────────────────────┘
              ▼
        architect lens x1 (audit reject partition, cut excess, no re-open accepts, may edit)
              ▼
        final architectural (Codex) x1 over architect edits ─▶ tier recompute ─▶ drift up? ─▶ architect
```

**Options considered.**
1. **Keep architect deciding accept/reject, add only the lens** (status-quo ownership).
   *Rejected:* leaves the measured over-accept bias in the loop — the lens alone cannot undo
   accretion the architect authored. Low cost, does not fix the actual failure.
2. **Planner owns accept/reject + reject-log + carve-out + architect T3 lens + drift-escalation**
   (chosen). *Cheapest sufficient:* moves the pen off the biased party, keeps a mechanical
   floor (carve-out) and two anti-inflation nets (lens, drift), and only adds one architect
   pass on the top tier. Extends/modifies shipped contracts rather than rebuilding.
3. **Fully automate finding accept/reject with a scoring rule.** *Rejected:* review findings
   are not scoreable without re-implementing reviewer judgment; high cost, brittle, and removes
   the human/agent judgment the carve-out and lens depend on.

**Full-class enumeration (finding-disposition decision → target the class).**

| finding `type` | may be rejected? | valid disposition | guard fails when |
|---|---|---|---|
| security | **no** | `addressed` only | disposed `rejected`, **or omitted** while present in reviewer output |
| scope-violation | **no** | `addressed` only | disposed `rejected`, **or omitted** while present in reviewer output |
| cosmetic / quality / speculative | yes (draft author) | `addressed`, or `rejected`+reason | the finding is absent from the ledger (silent drop) |
| lens: excess / simplify | yes (draft author) | `addressed`=cut, or `rejected`+reason if declined | finding absent from the ledger |
| lens: missing / do-not-simplify | yes (draft author) | `addressed`=add/guard, or `rejected`+reason | absent from ledger; scope growth also caught by drift |

These rows are the guard's equivalence classes: the first two are the mechanically enforced
carve-out (non-rejectable **and** non-omittable); the rest are draft-author-owned, with the
ledger's completeness enforced for every emitted finding and its reject partition the
audit surface the architect reads on T3.

**Within-T3 graduation decision (seeded from #187).** The L3/L4 distinction #187 deferred
lands here as T3-critical vs default-T3, not a fourth public tier — a public T4 would
duplicate the intake ladder while the real difference is *review intensity within the danger
tier*. T3-critical is gated by #187's recorded L4-condition list (by reference) and buys:
mandatory +Codex competitive, and a rollback/migration + crash/race/stale-state test
requirement. Flag back to #187: this fixes what T3 "buys," so #187's calibration sample
expected-tiers may be recalibrated against these definitions in the same PR series.

**Revision 2026-07-03 (two independent peer analyses + operator decisions).** Deep-reasoner
and Codex reviewed this draft independently (answers not cross-shown); the operator then
settled the open design points against the process reference (`docs/tier-reference.html`,
local). Adopted: (1) the accept/reject owner is named — the **draft author**, a Cursor
drafting session working from the architect's (Opus) brief — resolving the phantom-party
defect: at spec-review time the "planner" did not exist as a distinct actor (the architect
authored drafts), and "planner" is a taken term (downstream implementer). Role split per
the reference: architect = brief + tier + lens + escalation target; Cursor = draft + review
loop + dispositions. (2) The guard is anchored in a **normalization contract** instead of
demanding structured reviewer output — reviewers demonstrably fail to hold output formats;
raw output is captured verbatim, the draft author normalizes into the ledger with stable
ids. This closes both peer-flagged gaps at once: the #342 green-but-unreachable risk on the
omission-catch (the fixture must consume a raw captured transcript, not a pre-structured
list) and finding-id instability across passes. Known residual (disposition owner =
normalizer) is recorded in Binding surface with its mitigations. (3) The stage counts are
**deliberate and stay** (operator decision, fixed in the process reference): competitive
≤3 = the shipped GPT/adversarial skill cap, with Codex substituting when GPT is
unavailable; architectural ≤4 + final 1 compose to the shipped 5-iteration Codex cap — no
override of #37. (4) T3-critical cites #187's L4 list by reference, not a restated copy.
(5) Guard operation specified: pre-sync, blocking, contested protected findings escalate
to the architect. Rejected from the peer reviews: narrowing the ledger to protected+reject
rows only (the operator's reference keeps completeness + carve-out — completeness is what
makes omission detection meaningful, and normalization makes it cheap); loosening the
stage counts to prose-only convergence (the operator fixed the numbers).