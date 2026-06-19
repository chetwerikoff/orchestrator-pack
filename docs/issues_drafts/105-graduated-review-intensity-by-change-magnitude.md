# Graduated Codex-review intensity keyed to PR change magnitude

GitHub Issue: #329 (CLOSED — archived, not planned; reopen if the cost case changes)

## Prerequisite

Builds on / references (already shipped — reused, not rebuilt):

- `docs/issues_drafts/57-skill-only-pr-no-ceremony.md` (GitHub #161) — detects a
  no-ceremony PR shape **purely from the diff content** (every changed path in the
  skill-markdown union); author adds no marker. *Reused:* the diff-content
  classification surface and its conjunctive-allowlist discipline.
- `docs/issues_drafts/59-spec-docs-only-pr-no-ceremony.md` (GitHub #165) — extends
  #161 to the union of skill + spec-docs markdown; any path outside the union forces
  the full path. *Reused:* the same content-boundary classifier this draft adds a
  magnitude dimension to.
- `docs/issues_drafts/54-ci-path-filter-markdown-only.md` (GitHub #155) — CI skips
  heavy jobs on markdown-only PRs via path/extension classification. *Reused:* the
  precedent that a classified-light PR shape may skip work the safety invariants do
  not need.
- `docs/issues_drafts/43-spec-only-scope-guard-docs-prs.md` (GitHub #121) — the
  spec-only PR shape and the "lighter path must not become a code escape hatch"
  invariant. *Referenced:* the same anti-escape-hatch discipline applies here.

## Goal

Make the **Codex review effort** spent on a pull request scale with the magnitude
of its change, instead of every PR receiving the same full review. A genuinely
small, well-bounded code change should be eligible for a lighter review path, while
multi-file or contract-touching changes keep full Codex review. Classification must
be conservative: any ambiguity, any contract-adjacent surface, or any doubt routes
to the **full** path. This narrows wasted reviewer cost on trivial PRs without
weakening the gate where it carries weight.

```behavior-kind
action-producing
```

## Binding surface

What this issue commits the repository to:

- A **change-magnitude signal** computed for a PR from its diff, emitted by the
  existing scope-guard classification surface (reuse its diff walking — do **not**
  stand up a parallel classifier). The signal distinguishes at least a *trivial*
  tier from a *substantial* tier, and the magnitude metric **accounts for file count**
  so a multi-file code change is never *trivial* (the planner picks the exact measure;
  multi-file → substantial → full, consistent with the Goal).
- A **review-routing rule** in the orchestrator review path that consumes the
  signal: trivial + clearly-bounded + non-contract-touching + unambiguous → the
  **light** review tier; everything else → the **full** Codex review that runs
  today.
- **Fail-up is invariant:** ambiguous magnitude, low classification confidence,
  any path touching a contract/denylist-adjacent or out-of-allowlist surface, or a
  mixed PR whose code portion is non-trivial → full review. The light tier is only
  ever reached on an affirmative, conservative match.
- **Composition, not bypass:** the magnitude tier sits *on top of* the existing
  scope-guard, declaration-snapshot, and Codex gates. It changes only how much
  review effort the **light** tier spends — it does not remove the structural
  scope-guard ceremony, which stays magnitude-independent (the #57/#59 decision
  that safety invariants are load-bearing regardless of change volume is
  unchanged; this draft tiers a *different* gate — review depth — not that one).
- The light tier still produces a **real, recorded review outcome** for the PR (it
  is not "no review" and not an auto-approval): "lighter" means *reduced reviewer
  effort/scope*, the concrete reduction being the planner's to choose, subject to
  the acceptance criteria below. No code PR becomes merge-eligible without a
  recorded reviewer verdict.

- **Operator adoption** (if the review-routing rule lands in `orchestratorRules` /
  reactions): after merge the operator merges the new block into the live
  `agent-orchestrator.yaml`, then `ao stop` / `ao start`, and confirms the routing
  loaded (the new rule appears in the running orchestrator config).

## Files in scope

- `scripts/**` — the scope-guard classification surface that already walks the diff
  (emit the magnitude signal here; reuse, do not duplicate).
- `agent-orchestrator.yaml.example` — the review-trigger / routing wiring that
  consumes the signal (orchestratorRules).
- `.github/workflows/**` — only if the magnitude signal is surfaced/verified in CI.
- `tests/**`, `tests/fixtures/**` — fixtures covering the routing equivalence
  classes below (new).

## Files out of scope

- `scripts/pr-scope-check` content-type / no-ceremony classification semantics
  (#57/#59/#121/#155) — reused unchanged; this draft adds a dimension, it does not
  redefine the existing shapes.
- The structural scope-guard ceremony (snapshot, issue fences) — unchanged.
- The Codex reviewer's finding format / submission contract.
- AO core, vendor.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

- A change-magnitude signal is computed from the PR diff by the existing
  scope-guard surface (single source — no second diff walker introduced).
- A configurable magnitude threshold separates *trivial* from *substantial*; the
  threshold value is set in config, not hard-coded into the routing decision logic.
  The metric accounts for file count, so a multi-file code change is not trivial.
- The light tier honours a **minimum review obligation** so it cannot degrade into a
  rubber-stamp: the full diff is inspected, correctness/safety regressions are
  considered, and an explicit verdict is recorded. "Lighter" reduces effort/scope
  above this floor; it does not skip looking at the changed code.
- The route is **computed against the PR head/diff that actually receives the
  review**; if the head/diff moved since classification (later push), the trivial
  classification is stale → fail up to **full** (no light review on a moved head).
- Routing matches this equivalence table (exhaustive fixtures, one per row):

  | content | magnitude | contract/denylist-adjacent surface | classification | → route |
  |---|---|---|---|---|
  | docs/skill-md only | any | n/a | clear | existing no-ceremony (unchanged) |
  | code | trivial (single-file, bounded) | no | unambiguous | **light** |
  | code | substantial | no | unambiguous | **full** |
  | code | multi-file | no | unambiguous | **full** (multi-file ⇒ not trivial) |
  | code | trivial | **yes** | unambiguous | **full** (size irrelevant) |
  | code | trivial/substantial | any | **ambiguous / low-confidence** | **full** (fail-up) |
  | code | trivial then **head/diff moved** | any | stale classification | **full** (stale fail-up) |
  | mixed code+docs | code portion trivial | no | unambiguous | **light** |
  | mixed code+docs | code portion substantial | any | any | **full** |

- The light tier still records a review outcome on the PR; a PR that took the light
  tier is observably distinguishable from one that took the full tier (so the
  routing is auditable).
- No code PR can reach the light tier by an **author-supplied marker or label**, and
  no code PR is auto-approved by the tier; the tier is reached only by the
  diff-derived signal and still yields a recorded reviewer verdict (the #57/#59 "no
  author-declared escape hatch" discipline).

```positive-outcome
asserts: a realistic small well-bounded non-contract-touching code diff is routed to the light review tier, AND a realistic multi-file / contract-touching diff is routed to the full Codex review
input: external-tool-output
provenance: capture-backed
```

## Upgrade-safety check

- No AO core / `packages/core/**` / `vendor/**` edits.
- No `reviewer:` YAML role (silently ignored on AO 0.9.x); routing rides
  `orchestratorRules` + the `ao review` path.
- No new repo secrets.
- The structural scope-guard / declaration-snapshot ceremony is unchanged for all
  shapes; only the Codex-review effort of the new light tier differs.

## Verification

- Run the scope-guard / classification test suite: each equivalence-table row has a
  capture-backed fixture (real `git diff` / `gh` PR shape) and asserts the routed
  tier. The fail-up rows (ambiguous, contract-adjacent-but-trivial, multi-file,
  head/diff-moved) assert **full**.
- A light-tier fixture asserts the minimum review obligation held (full diff seen,
  explicit verdict recorded) — not an empty/auto verdict.
- Demonstrate the positive outcome on a captured trivial PR (→ light) and a captured
  substantial/contract-touching PR (→ full).
- Confirm a captured author-declared "trivial" marker on a substantial diff does
  **not** reach the light tier.
- If routing landed in `orchestratorRules`: show the rule loaded in the running
  orchestrator after `ao stop` / `ao start`.

## Decisions (design analysis)

**Prior art.** The shipped no-ceremony machinery (#121/#155/#161/#165) tiers PRs by
**content type** (docs/skill-markdown vs code), never by size; its rationale is that
structural safety invariants (snapshot, issue fences) are *redundant* for non-code
content. The recon found **no** shipped or queued work routing review by change
**size** — the gap is open. This draft deliberately does **not** touch that
content-type decision: it tiers the **Codex review depth**, a different gate, and
leaves the structural ceremony size-independent as #57/#59 settled.

**Options judged (cost / risk / sufficiency):**
1. **Extend the existing scope-guard classifier to emit a magnitude signal the
   review trigger consumes (chosen).** Cheapest sufficient: the diff walk already
   exists; one new signal + one routing rule; tests + Codex review as the net.
   Single source of diff truth, lowest drift.
2. **Standalone magnitude classifier service (rejected).** Duplicates the diff walk
   → two sources of truth that can disagree; higher surface and drift risk for no
   added capability.
3. **Author-declared tier via PR label/marker (rejected).** Cheapest to build but
   **unsafe**: relies on author honesty; a worker could mislabel a large change as
   trivial and bypass review — violates fail-up and the #57/#59 no-escape-hatch
   discipline.

**Chosen = option 1** — extend shipped work; conservative diff-derived signal;
fail-up to full review on any doubt.

**Scope held to the cheapest-sufficient build (GPT adversarial loop, 7 passes).** A
`discuss-with-gpt` adversarial loop on an earlier expanded version of this draft
surfaced a large *graduated-enforcement safety* surface — head/diff-identity binding,
a shadow/observe rollout with promotion reports, idempotent outcome identity +
supersession keys, reviewer-runtime drift, content-addressed evidence bundles, and a
merge-gate/publication schema. Each pass produced fresh accepted findings (counts
7/6/6/5/6/6/6) **without converging**, and every pass recommended a split — the signal
that those mechanics are a *second, larger build*, disproportionate to the modest
reviewer-cost saving this issue targets. Per the cost rule (cheapest sufficient
executor with acceptable risk), that machinery is **out of scope here**: 105 stays the
compact original — conservative diff-derived signal, fail-up on any doubt, a real
recorded review (never auto-approval), tests + the normal Codex review as the net. If
the cost case later justifies actually *reducing* review depth with the full safety
apparatus, that becomes a separate Prerequisite-chained draft; this one ships the
signal + conservative routing. The single durable guard kept from the loop: the light
tier may not auto-approve a code PR (it still records a reviewer verdict).

GPT loop: 7 passes; stopped because operator chose to simplify + ship at the
original cheapest-sufficient scope (not a zero-accepted convergence); last-pass
accepted=6; final STATE=completed_valid VALIDATION=ok pass=1d0ed117 sha=568d62b0
(the enforcement-safety machinery those findings hardened is deferred out of scope,
not merged into this draft).

**Normal Codex review (post-simplification).** A standard Codex draft review of the
compact version returned four concrete findings, all folded as cheap single-line
guards (no machinery): Goal↔table contradiction on multi-file (file count now part of
magnitude; multi-file → full row added); a minimum light-review obligation (full diff
inspected + explicit verdict, no rubber-stamp); route bound to the reviewed head/diff
with stale → fail-up; and a malformed equivalence-table cell fixed. These are the
cheap-sufficient subset of the deferred enforcement surface — kept because each is one
acceptance criterion, not a subsystem.
