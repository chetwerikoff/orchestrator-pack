# RCA final recommendation carries a design-analysis block when the fix is a non-trivial build

GitHub Issue: #237

## Prerequisite

- None blocking. Builds on `docs/issues_drafts/18-investigate-root-cause-skill.md`
  (the RCA skill) and is a sibling refinement to
  `docs/issues_drafts/75-rca-spec-discipline-against-misdirected-fixes.md`
  (GitHub #221) — that draft hardened *how the root cause is found*; this one
  enriches *what the final recommendation must say* when the cause calls for a
  build. They touch the same surfaces (`prompts/investigate_root_cause.md`, the
  RCA skill) but are independent and may land in either order.

## Goal

When a root-cause investigation concludes that the durable fix is a **non-trivial
design or build** — a new component, contract, or service that would become its
own task draft and worker build — the final recommendation must not stop at "open
a draft to build X." It must give the architect enough design altitude to author
that draft well: the critical structures and edge conditions of the problem, how
the industry solves this class of problem, a sketch of how the services/components
fit together, and **three implementation options with their trade-offs** so the
choice is made against the repo cost rule (cheapest sufficient executor with
acceptable risk) rather than by default.

Equally — when the cause is a bug in a **decision / state-machine / event-ordering /
concurrency / idempotency** path (including re-execution after an ambiguous failure) —
the recommendation must frame the fix as the **whole
class**: enumerate the decision's input space (its dimensions × values) and name the
sibling cases that share the root cause, so the build targets and verifies the class,
not the single reproduced cell. This is the durable cure for the failure mode where one
bug becomes five investigate-then-fix rounds because each adjacent cell was filed as a
"new" bug.

This is deliberately **conditional**. The vast majority of RCAs end in an operator
step, a config change, or a one-line spec fix; forcing a three-option architecture
analysis onto those would be noise. The draft must make the block apply only when
the recommendation is genuinely a build, and skip it otherwise.

```behavior-kind
record-only
```

This issue changes architect-side **report authoring guidance** only. Its success
path is a richer memo and has no runtime side effect of any kind.

## Binding surface

This issue commits the RCA report template (canonical text in
`prompts/investigate_root_cause.md`, surfaced via the RCA skill) to a conditional
**design-analysis block** in the final recommendation, governed by these
invariants:

- **When-it-applies / when-it-skips is explicit and bounded.** The guidance states
  the block is required when the durable recommendation (the prevention / "so it does
  not recur" content) is to **build or redesign** a non-trivial component, contract,
  or service — i.e. work that would become a `create-issue-draft` + worker build — and
  is **skipped** for operator/runtime steps, config or YAML changes, one-line spec
  or rule edits, and other small fixes. The reader can decide applies-vs-skips from
  the stated condition without guessing.
- **Five content elements when the block applies.** The block must require all of:
  1. the **patterns, data structures, integrations, and boundary/edge conditions**
     that are critical for *this* problem;
  2. the **industry/world best practices** used to solve this class of
     task/problem;
  3. a **services/components architecture sketch** of the proposed solution;
  4. **at least three implementation options, each with an explicit trade-off
     assessment** (not three restatements of one approach);
  5. for a **decision / state-machine / event-ordering / concurrency / idempotency** cause,
     a **full-class scenario enumeration** — the decision's input dimensions × their
     values, the **sibling cells that share the root cause** or are at risk, and the
     expected outcome per equivalence class — so the recommendation fixes the **class,
     not the one reproduced case**. (Element 5 is itself conditional on the cause being
     a multi-input decision/ordering path; a single-axis build still needs 1–4.)
- **Class-not-case is mandatory on recurrence — only when the block already applies.**
  When the investigation is a recurrence (`recurrence-diagnostic`, #221 — "уже фиксили" /
  the prior fix should have covered it) **and** the durable fix is a build-class,
  multi-input decision/ordering cause (i.e. the design block already applies and the cause
  is element-5-eligible), the full-class scenario enumeration (element 5) is **required**,
  not optional: such a recurrence is evidence the prior fix closed one cell, so the
  recommendation must name the whole class. A recurring **config / one-line / operator**
  fix still **skips** the block — element 5 is **not** forced there; the
  `recurrence-diagnostic` (#221) governs those without a scenario matrix. (This resolves the
  apparent conflict between the skip boundary and the recurrence rule.)
- **The class is handed off to the build-draft as a recommendation (enforced downstream).**
  When the recommendation is a build, the RCA block **recommends** that the resulting
  `create-issue-draft` carry the enumerated scenario matrix as exhaustive acceptance (each
  cell a fixture; closed sibling issues cross-checked for no-regression). This draft does
  **not** itself bind or verify the downstream workflow — the RCA block names the class;
  **enforcement** that the build-draft preserves the matrix lives in the
  `create-issue-draft` scenario-completeness gate and `check-draft-discipline.ps1`, tracked
  as an explicit **companion** (out of this draft's scope — see Files out of scope). So the
  RCA rule does not ship a binding obligation on a workflow it cannot check here.
- **Options are judged on cost/risk, not taste.** The three-option requirement ties
  to the repo **cost rule** from `CLAUDE.md` / the operational framework — each
  option's trade-off names cost, risk, and sufficiency (with tests + review as the
  safety net), so the recommendation can land on the cheapest sufficient executor
  rather than the most elaborate one.
- **Reconciled with the existing template contract.** The current template says
  "always include sections 1–6" and caps the memo at ≤ 900 words. The change keeps
  §1–§6 mandatory, adds the design block as a clearly **conditional** part (not a
  seventh always-on section), and writes its long comparison tables / option
  matrices to the existing temp-file convention (write to OS temp, link the path)
  so the chat memo does not bloat. The word cap is explicitly relaxed for the design
  block's analysis when it is present.
- **Single source, no wrapper drift.** Canonical text lives in
  `prompts/investigate_root_cause.md`; the `.claude/skills/investigate-root-cause/`
  wrapper (and the generated `.cursor/skills/` pointer, regenerated — not
  hand-edited) continues to resolve to it. Any loader bullet added to the wrapper
  must match the canonical content.

This is an architect-side investigation surface only — no worker-facing rule
(`prompts/agent_rules.md`), no live `agent-orchestrator.yaml`, and therefore no
operator adoption step.

## Files in scope

- `prompts/investigate_root_cause.md` — the canonical RCA workflow + report
  template (the design-analysis guidance lands here).
- `.claude/skills/investigate-root-cause/SKILL.md` — wrapper / loader bullets if a
  pointer is warranted; and the generated `.cursor/skills/investigate-root-cause/`
  pointer (regenerated by the mirror mechanism, not hand-edited).

## Files out of scope

- `prompts/agent_rules.md` and its mirrors (`AGENTS.md`, `.cursor/rules/**`) — RCA
  is architect-side; this is not a universal worker rule.
- `agent-orchestrator.yaml` / `.example`, listeners, env, process restart — no runtime or
  operator surface changes.
- `packages/core/**`, `vendor/**`, AO CLI behavior.
- The mechanical draft-discipline guards (owned by #75 / #76) — this draft adds
  read-through report guidance, not a new executable check.
- **Enforcing the scenario-matrix handoff inside `create-issue-draft` /
  `check-draft-discipline.ps1`** (that a build-draft actually carries the enumerated matrix
  as acceptance) — a **companion** concern on the authoring side, tracked separately; this
  draft only requires the RCA to *recommend* it.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. **Conditional design-analysis block exists with a stated applies/skip condition.**
   The RCA report template defines a design-analysis block in the final recommendation,
   required when the durable fix is a non-trivial build (new component / contract /
   service that would become a worker draft) and explicitly skipped for
   operator/config/one-line fixes. Both the applies condition and the skip condition
   are written down. Provable by reading the template.
2. **All required content elements are present when the block applies.** When the block
   applies, the guidance requires: (a) critical patterns, data structures,
   integrations, and boundary/edge conditions for the problem; (b) industry/world
   best practices for the problem class; (c) a services/components architecture
   sketch; (d) at least three implementation options, each with an explicit
   trade-off; and (e) — for a decision / state-machine / event-ordering / concurrency /
   idempotency cause (including re-execution after ambiguous failure) — a full-class
   scenario enumeration (input dimensions × values,
   sibling cells sharing the root cause, expected outcome per equivalence class).
   Provable by reading the template.
3. **Options are evaluated against the cost rule.** The three-option requirement
   states that each option's trade-off names cost, risk, and sufficiency (tests +
   review as safety net), referencing the repo cost rule rather than asking "which
   is best." Provable by reading the template.
4. **Template contract reconciled.** §1–§6 remain mandatory; the design block is
   clearly conditional (not a new always-on section); and the ≤ 900-word cap is
   reconciled — the block's analysis may exceed it, with long option matrices /
   comparison tables routed to the existing temp-file-and-link convention. Provable
   by reading the template (no contradiction between the new block and the existing
   "always include §1–§6" / word-budget text).
5. **Wrapper resolves with no drift.** The RCA skill wrapper (`.claude` and the
   generated `.cursor` pointer) still resolves to the canonical text; any added
   loader bullet matches the canonical content. Provable by comparing wrapper text
   to the canonical section.
6. **Class-not-case: recurrence + handoff.** The template states that element 5 (full-class
   scenario enumeration) is **mandatory** on a recurrence **only when the design block
   already applies** (a build-class, element-5-eligible cause) — and that a recurring
   config/one-line/operator fix still skips the block (no forced matrix). It also states
   the build handoff is a **recommendation** (the RCA names the class; enforcement that the
   build-draft preserves the matrix is the `create-issue-draft` companion, not bound here).
   Provable by reading the template: no contradiction between the skip boundary and the
   recurrence rule, and no binding obligation on an out-of-scope workflow.
7. **Planner freedom preserved.** The added guidance prescribes no implementation
   file names, function signatures, or library choices, and constrains only what the
   recommendation must contain. The block placement (new conditional section vs.
   extension of the prevention section) is the implementer's choice consistent with
   the existing template. Consistent with `CLAUDE.md` (planner freedom, cost rule).
   Provable by reading the diff.

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`; no AO CLI flag assumptions; no new
  repo secrets.
- No new unsupported `agent-orchestrator.yaml` fields; no worker-rule or operator
  surface change.
- Additive guidance only — the existing §1–§6 contract and applies/skip rules of
  the RCA skill are unchanged except for the explicit reconciliation in criterion 4.

## Verification

- Read-through (criteria 1–4): the design-analysis block, its applies/skip
  condition, the **five** required elements (incl. element 5 — full-class scenario
  enumeration), the cost-rule tie-in, and the reconciliation with §1–§6 / the word cap
  are present and internally consistent in `prompts/investigate_root_cause.md`.
- Class-not-case read-through (criterion 6): element 5's mandatory-on-recurrence scope
  (only when the block applies; config/one-line/operator fixes still skip) and the
  build-draft handoff as a **recommendation** (enforcement is the create-issue-draft
  companion, not bound here) are present, with no contradiction against the applies/skip
  boundary.
- Wrapper check (criterion 5): the `.claude` SKILL and the generated `.cursor`
  pointer resolve to the canonical text; any loader bullet matches it.
- Planner-freedom check (criterion 7): the diff names no function signatures, import
  paths, or library versions.
