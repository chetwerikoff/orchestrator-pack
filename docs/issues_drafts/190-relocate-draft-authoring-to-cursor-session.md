# Relocate draft authoring to a Cursor draft-author session

GitHub Issue: #579

## Prerequisite

Depends on (must merge first):

- `docs/issues_drafts/187-task-complexity-tier-rubric.md` (GitHub #574) — defines the
  T1/T2/T3 rubric, marker set, and calibration sample the draft-author session applies.
- `docs/issues_drafts/188-per-tier-review-flow-finding-ownership.md` (GitHub #575) —
  defines the target operating model: the architect authors the brief and runs the
  top-tier lens; the Cursor draft-author session authors the spec, runs the review loop,
  and owns finding dispositions.

Paired / downstream reference:

- `docs/issues_drafts/189-tier-gate-recompute-and-stage-selection.md` (GitHub #576) —
  defines the tier gate that assumes this relocation. This draft is the missing prerequisite
  named in #189 and must land before #189's relocated-role behavior activates: #189 states
  that the B/C series assumes drafts are authored by a Cursor draft-author session working
  from the architect's brief, while the shipped `create-issue-draft` skill still names the
  architect as the authoring party.

Builds on / references (already shipped — reused or re-scoped, not rebuilt):

- `docs/issues_drafts/12-architect-role-tighten.md` (GitHub #37) — ships the current
  architect-side `create-issue-draft` authoring and Codex-review flow. **Re-scoped here:**
  authoring moves to the Cursor draft-author session; the review and sync gates remain
  `create-issue-draft` contracts.
- `docs/issues_drafts/87-land-discuss-with-gpt.md` (GitHub #302) — ships the GPT
  adversarial wrapper. **Re-scoped here:** after relocation, the Cursor draft-author
  session runs the wrapper loop when invoked.
- `docs/issues_drafts/75-rca-spec-discipline-against-misdirected-fixes.md` (GitHub #221)
  and `docs/issues_drafts/117-spec-contract-evidence-grounding-gate.md` (GitHub #366) —
  ship the discipline gates that still run before sync/publish regardless of which
  session authors the draft.

## Goal

Move task-spec authoring out of the architect's live session and into an isolated
draft-author session that works from the architect's brief, executes the full
`create-issue-draft` procedure, and returns an authored draft plus proof that the required
checks and review loop completed. The **default authoring engine is Cursor** (the role
#188/#189 name); **Codex or Sonnet 5 may author instead, but only on explicit user
request** — Cursor is the standing default and no engine is auto-selected. The isolation,
completion-proof, fallback, and pre-sync-review contract below binds the draft-author
**role** and holds identically whichever engine authors; the engine is a selectable
parameter, not a separate contract. The architect keeps the brief, advisory tier prior,
T3 lens pass, escalation decisions, and final review before any sync. The current
architect-as-author flow remains the recorded fallback until this relocation is active, or
whenever the selected draft-author session is unavailable or incomplete.

```behavior-kind
action-producing
```

The relocated flow enacts an observable action: a Cursor draft-author session produces or
revises the draft from a brief and records completion evidence before sync.

## Binding surface

Commits the repository to a draft-author relocation contract with all of:

- **Brief handoff contract.** The architect's brief is the input artifact and the role
  boundary. It must carry the problem/goal, an advisory tier prior, constraints and
  out-of-scope, and the grounding pointers the architect has already verified. The
  contract binds required content, not a file naming scheme, directory, or UI workflow.
- **Draft-author session contract.** A draft-author session, working from the
  brief, executes the full `create-issue-draft` procedure: prior-art reconnaissance,
  decomposition gate, tier gate per #189, design analysis when the tier requires it,
  per-tier review loop per #188, disposition ledger and carve-out handling, discipline
  checks, and Codex draft review. The session produces the draft file and a completion
  record that identifies the brief, draft path, **authoring engine used and its selection
  basis** (`default` | `explicit-request`), selected/recomputed tier, review passes,
  disposition outcome, discipline-check results, and final status.
- **Engine selection (default + explicit-request override).** The authoring engine
  defaults to **Cursor** and is never auto-switched. **Codex or Sonnet 5** may author only
  when the user explicitly requests that engine for the run. The completion record names
  both **which engine authored** and the **selection basis** — `default` or
  `explicit-request` — so the rule is observable: a non-Cursor engine recorded with basis
  `default` (or with no recorded explicit request) is an invalid run. The contract binds
  the recorded selection-basis fact, **not** the concrete request channel, flag, or field
  that carries the user's choice — that shape is the implementing planner's call. Engine
  choice does not relax any obligation in this contract:
  isolation, completion proof, fallback, disposition ownership, and the pre-sync architect
  review bind the draft-author role and apply identically to Cursor, Codex, and Sonnet 5.
  When the adversarial-wrapper reviewer engine (Codex for `adversarial-draft-review`) would
  coincide with the selected authoring engine, the adversarial pass must still run as an
  independent instance/thread so the author is never its own adversary.
- **Isolation from the architect's live tree by construction.** The draft-author session
  — Cursor, Codex, or Sonnet 5 alike — must not run git operations in the architect's live
  working tree. It works in an
  isolated checkout, scratch tree, or equivalently isolated workspace, and receives only
  the brief and intentionally included context needed for authoring. The contract forbids
  shared-index authoring, dirty-tree delegation, force checkout/reset recovery, and
  force-push semantics as part of draft authoring. After the session returns, the caller
  verifies the authored artifact and local worktree state instead of trusting an exit
  code.
- **Completion proof, not exit-code trust.** Exit status alone is insufficient. A run is
  complete only when the authored draft exists at the expected path, required discipline
  checks pass, the required review-loop outcome is recorded (`NO_FINDINGS` or the capped
  outcome with open questions), and the completion record links those facts to the brief
  and draft path. A missing draft, missing checks, missing ledger/review state, or
  half-written output is a failed/incomplete authoring run even if the delegate exits 0.
- **Architect responsibilities stay fixed.** The architect authors the brief and its
  advisory tier prior, runs the T3 lens pass required by #188, is the escalation target
  for tier-gate failures and contested protected findings, and reviews the authored draft
  before any sync. This draft does not re-decide #188/#189's role split.
- **Wrapper re-scoping.** `adversarial-draft-review` and `discuss-with-gpt` remain wrappers
  around `create-issue-draft`. After relocation, their "Author the draft" step means the
  draft-author session owns the authoring and wrapper loop, including GPT/Codex
  adversarial passes, evaluation of findings, decision logging, and handoff back into
  normal `create-issue-draft` review. An explicit wrapper invocation still floors the
  effective tier at least to T2 per #189; the architect does not run a parallel wrapper
  loop over the same draft.
- **Fallback and activation boundary.** Until the relocation contract is implemented and
  selected by the authoring surface, #189's interim rule remains active: the
  architect-as-author exercises the gate. If the selected draft-author session is unavailable,
  refuses the handoff, or returns a failed/incomplete run, the authoring surface records
  the fallback and uses today's shipped architect-as-author `create-issue-draft` path
  rather than creating an authoring outage.
- **Sync/publish boundary unchanged.** This draft does not authorize syncing or publishing
  from the draft-author session unless the existing `create-issue-draft` / publish gates
  allow it. The architect still reviews the local authored draft before any issue sync.

Deliberately not committed here: the exact process runner, CLI flags, temp-directory
layout, prompt wording, checkout implementation, or session supervisor internals. The
implementing planner may choose the cheapest sufficient isolated executor that satisfies
the contract.

## Files in scope

- `.claude/skills/create-issue-draft/**` — authoring-party prose, handoff contract,
  completion proof, fallback, and isolation obligations.
- `.claude/skills/adversarial-draft-review/**` — wrapper "Author the draft" ownership after
  relocation.
- `.claude/skills/discuss-with-gpt/**` — wrapper "Author the draft" ownership after
  relocation.
- `CLAUDE.md` — the current architect "Do" clause that says to author task drafts, revised
  to describe brief ownership and relocated draft authoring.
- `.cursor/rules/**` — the Cursor-entrypoint surface. A standalone Cursor session does not
  read `.claude/skills/**` or `prompts/agent_rules.md` natively (CLAUDE.md header), so the
  handoff, isolation, completion-proof, and disposition contract the draft-author session
  must obey has to be surfaced here for the default (Cursor) engine to actually see it.
- Supporting docs/tests/scripts needed to verify the relocated contract and completion
  proof, at the implementing planner's discretion.

## Files out of scope

- `docs/issues_drafts/187-*`, `docs/issues_drafts/188-*`, `docs/issues_drafts/189-*` —
  reference only; do not edit their content in this build.
- `prompts/agent_rules.md` unless implementation recon proves a worker-facing rule names
  the authoring party.
- Worker PR-code review behavior.
- GitHub issue sync/publish mechanics except where wording must preserve the pre-sync
  architect review boundary.
- `agent-orchestrator.yaml` / reactions.
- `packages/core/**`, `vendor/**`, `.ao/**`.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
.claude/skills/**
.cursor/rules/**
CLAUDE.md
docs/issues_drafts/190-relocate-draft-authoring-to-cursor-session.md
scripts/**
tests/**
```

## Contract evidence

```contract-evidence
none
```

This draft binds local authoring contracts and repo-owned skill/rule prose. It does not bind
to an upstream runtime producer field, event, CLI output shape, or external API datum. If
the implementation chooses to bind a concrete external Cursor CLI flag or output field, that
implementation must add capture-backed evidence in the implementing PR before sync.

## Acceptance criteria

1. `create-issue-draft` describes the brief handoff contract: architect-authored brief as
   input, minimum required brief contents, advisory tier prior, constraints/out-of-scope,
   and grounding pointers; it does not prescribe a brief file path or storage layout.
2. `create-issue-draft` states that the Cursor draft-author session runs the full
   authoring procedure from the brief: prior-art recon, decomposition, tier gate per #189,
   design analysis when required, #188 review loop, disposition ledger, discipline checks,
   and Codex draft review.
3. The authoring contract requires isolation from the architect's live working tree and
   forbids shared-index authoring, dirty-tree delegation, force checkout/reset recovery, and
   force-push semantics in the draft-author session. A fixture or check fails when the
   contract text permits authoring in the live tree or trusts a dirty shared checkout.
4. The authoring contract defines completion proof beyond exit code: authored draft path,
   brief identity, authoring engine used, tier result, review-loop outcome, disposition
   status where applicable, and discipline-check results. A run with exit 0 but missing the
   draft or check/review proof is treated as incomplete.

```positive-outcome
asserts: a draft-author handoff over a realistic brief produces a draft file plus a completion record that names the brief, draft path, authoring engine, tier result, review outcome, and passing discipline checks; the verifier rejects a delegate result that exits 0 but lacks the draft or completion proof
input: realistic
```

5. `CLAUDE.md` no longer makes the architect surface the unconditional draft author for
   normal task specs; it describes the architect as owning the brief, advisory tier prior,
   T3 lens/escalation, and pre-sync review, with authoring delegated to the Cursor
   draft-author session when the relocation path is active.
6. `adversarial-draft-review` and `discuss-with-gpt` state that after relocation their
   "Author the draft" step and adversarial loop are run by the Cursor draft-author session,
   and that explicit wrapper invocation still floors the effective tier at least to T2 per
   #189.
7. Fallback is documented: until relocation is active, or when the Cursor draft-author
   session is unavailable/incomplete, the existing architect-as-author `create-issue-draft`
   path remains the recorded fallback and the failed/incomplete delegate run is reported.
8. The sync/publish boundary is preserved: no issue sync or publish occurs before the
   architect reviews the authored local draft and the existing discipline/review gates pass.
9. Engine selection is documented and observable: the draft-author engine defaults to Cursor
   and is never auto-switched; Codex or Sonnet 5 author only on explicit user request; the
   completion record captures the authoring engine **and** its selection basis
   (`default` | `explicit-request`), so a non-Cursor engine recorded as `default` (or with no
   recorded explicit request) is an invalid run — without prescribing the concrete request
   channel/flag. The isolation, completion-proof, disposition-ownership, fallback, and
   pre-sync-review obligations apply identically regardless of engine; and where the
   adversarial-wrapper reviewer engine would coincide with the chosen authoring engine, the
   adversarial pass runs as an independent instance so the author is not its own adversary.

## Upgrade-safety check

- No edits to AO core, `packages/core/**`, or `vendor/**`.
- No `agent-orchestrator.yaml` schema or reactions change.
- No new repository secrets or local credential files.
- #188/#189 role decisions are consumed, not rewritten: architect = brief, advisory tier,
  T3 lens, escalation, pre-sync review; Cursor draft author = spec, review loop,
  dispositions; Codex/GPT = reviewers/adversaries; worker = implementation.
- Existing #221/#366 discipline gates and #37 Codex review gate are strengthened by
  relocation, not skipped.

## Verification

1. Grep-level checks show `create-issue-draft` contains the brief handoff contract,
   Cursor draft-author session contract, isolation/no-force/no-dirty-tree clauses,
   completion-proof requirement, fallback, and pre-sync architect review boundary.
2. Grep-level checks show both wrapper skills re-scope "Author the draft" to the Cursor
   draft-author session after relocation and preserve the explicit-wrapper tier floor.
3. Grep-level checks show `CLAUDE.md` describes architect brief/lens/escalation/review
   ownership rather than unconditional architect draft authoring, and that the draft-author
   engine defaults to Cursor with Codex/Sonnet 5 selectable only on explicit user request.
4. The implementation includes a self-check, lint, or fixture that rejects a simulated
   delegate result with exit 0 but no draft/completion proof, and rejects contract wording
   or configuration that would run the draft-author session in the architect's live dirty
   tree.
5. Run the repository verification commands after implementation: `pwsh -NoProfile -File
   scripts/verify.ps1` and `pwsh -NoProfile -File scripts/check-reusable.ps1`.

## Decisions (design analysis)

**Prior art (reconnaissance).** Shipped work already provides the authoring/review
machinery: #37 `create-issue-draft`, #302 `discuss-with-gpt`, #221 behavior-kind /
positive-outcome / parked-root, #366 contract-evidence, and #57 issue queue sync/index
mechanics. Local unsynced drafts #188 and #189 are the only overlapping queued specs:
#188 defines the target role split and #189 explicitly names this relocation as its
missing prerequisite. Live GitHub open searches for "draft author", "Cursor author",
"create-issue-draft", and "authoring relocation Cursor draft author" returned no open
overlap; nearby #512 and #377 are closed and unrelated by title. Scope verdict:
**extends/re-scopes existing authoring skills; does not duplicate shipped review or sync
machinery.**

**Knowledge-base note.** Local KB search found no pack-specific note for this relocation.
General `Security` / `Authorization` notes support treating the relocation as an access
and isolation policy with explicit mechanisms, and `Automated testing` supports
self-checking completion evidence instead of trusting a human read or exit code.

**Critical mechanics.** (1) The brief is the interface: without it, the architect and
draft author can both claim authorship over the same decisions. (2) Isolation is the core
safety property because prior delegate failures damaged the architect's live tree through
shared checkout, dirty-tree, force-checkout, and wrong-commit behavior. (3) Completion must
be artifact-proven because delegates can exit 0 after partial work. (4) Wrapper ownership
must have one owner: after relocation, the draft author runs the adversarial loop, while
the architect remains escalation/review, not a parallel author. (5) The isolation harness,
not the engine, is the safety boundary: the engine is a parameter that defaults to Cursor
and moves to Codex or Sonnet 5 only on explicit user request, so the same isolation +
completion-proof contract must hold for any engine — and when the chosen author engine
equals the wrapper's adversary engine (Codex), the adversarial pass runs as an independent
instance so the author never grades itself.

**World practice.** This follows common change-control separation: one role writes the
brief and escalation policy, a separate isolated worker produces the artifact, and a
verifier accepts only artifact-backed completion. The safety pattern is least shared state
+ explicit handoff + auditable completion receipt, not "same checkout, different prompt."

**Architecture sketch.**

```text
architect (Opus)
  brief + advisory tier + constraints + grounding
        |
        v
isolated draft-author session (Cursor default; Codex or Sonnet 5 on explicit request)
  create-issue-draft full flow:
  recon -> decomposition -> tier gate -> design as required -> wrapper/review loop -> ledger -> checks
        |
        v
completion proof + local draft
        |
        v
architect
  verify artifact/state -> T3 lens/escalation/pre-sync review -> existing sync/publish gates
```

**Options considered (cost/risk/sufficiency).**

1. **Keep architect-as-author; only document the desired role split.** Rejected: lowest
   implementation cost, but contradicts #188/#189's settled role split and leaves the
   over-accept/scope-inflation and live-tree delegation risks unresolved. Insufficient.
2. **Relocate authoring to an isolated draft-author session (Cursor by default; Codex or
   Sonnet 5 only on explicit user request) with brief handoff, completion proof, and
   fallback to architect-as-author** (chosen). Cheapest sufficient: changes the role
   contract and safety boundary while reusing `create-issue-draft`, wrapper skills, and
   existing discipline/review gates. Binding the isolation + proof contract to the role
   rather than the engine keeps the engine a swappable parameter at no extra safety cost.
   Risk is bounded by isolation and artifact verification.
3. **Move authoring into `ao spawn` workers.** Rejected: `ao spawn` revives workers against
   existing GitHub issues in fresh checkouts and cannot see an uncommitted local brief or
   create a brand-new unsynced draft. Low conceptual reuse, wrong lifecycle.
4. **Let `cursor-agent` operate directly in the architect's checkout.** Rejected:
   apparently cheap, but repeats the known dirty-tree/wrong-commit/force-push failure
   class. High safety risk and explicitly violates the isolation constraint.

**Full-class enumeration (authoring handoff outcome).**

| draft-author session available | isolated workspace | completion proof | result |
|---|---|---|---|
| yes | yes | complete | accept authored draft for architect review |
| yes | yes | missing draft/check/review proof | incomplete; report and use fallback or rerun |
| yes | no / shared dirty tree | n/a | invalid; do not run or accept |
| no | n/a | n/a | use recorded architect-as-author fallback |
| yes | force checkout/reset/push required for recovery | n/a | invalid; stop and report |

These rows target the failure class rather than one reproduced incident: every successful
path has both isolation and artifact proof; every missing or dangerous precondition fails
closed into fallback or escalation. **The authoring engine (Cursor default; Codex or
Sonnet 5 on explicit request) is orthogonal to every row** — each outcome holds identically
whichever engine authored; the engine identity is recorded, not a branch in the decision.
