# Finding-routing eval trilogy — shared pack boundaries

Canonical shared **Files out of scope**, **invariants**, and **Denylist** fences for
drafts **47–49 + 50** (offline trilogy + selective-send enactment). Invariants 1–11
apply to 47–49; 12–13 additionally constrain draft 50.

Structural twin of [`skill-eval-shared-pack-boundaries.md`](./skill-eval-shared-pack-boundaries.md)
(drafts 28–30), but for **orchestrator routing** of review findings — not review-prompt
output format.

> **Numbering:** `47`–`50` here are **draft file prefixes** (`docs/issues_drafts/NN-…`),
> not GitHub issue numbers until synced via `docs/issue_queue_index.md`.

## Shared invariants (drafts 47–49 + 50)

1. **Classifier ≠ reviewer delivery; `forward` ≠ delivered.** Routing optimizes what AO
   does with **hydrated** findings that already reached the wrapper. It does **not** fix
   split-channel loss or JSONL hydration (pack #127, #135, #136). **Stronger:** even when
   the router predicts `forward`, upstream may **silently skip** dispatch — Composio
   [#1943](https://github.com/ComposioHQ/agent-orchestrator/issues/1943) (review-backlog:
   throttled, `fingerprint_unchanged`, `terminal_status`, `no_reaction_config`, no trace)
   and [#614](https://github.com/ComposioHQ/agent-orchestrator/issues/614) (send-to-agent
   no-op without message, human fallback suppressed). Routing eval and prod wiring require
   **observable skipped-reason** (or equivalent) before «forward» is treated as delivery.
   Undelivered / undiagnosed skips are out of scope for routing **acceptance** until
   delivery is trusted.

2. **`drop` is runtime-stateful.** Whether a finding is a duplicate depends on
   **loop state** (what was already forwarded in this review cycle), not on the finding
   record alone. Gold fixtures and scorer inputs MUST carry that state when `drop` is
   exercised; a stateless finding in isolation cannot be labeled `drop`.

3. **Degenerate baseline.** The implicit pre-classifier behavior is **forward everything**
   (recall on critical class = 100%, churn maximal). Any classifier acceptance MUST
   show **churn reduction** vs that baseline under a fixed critical-recall constraint —
   recall alone is not sufficient (#49).

4. **`backlog` is not silent drop.** `backlog` means a durable, inspectable process/spec
   artifact (planner chooses: linked GitHub Issue body section, tracked backlog file under
   `docs/`, or equivalent). Until runtime wiring exists, gold may label `backlog`, but
   docs MUST define the persistence target so acceptance tests can verify the signal
   survives (fixture or stub sink). `backlog` without an addressable sink is treated as
   a spec smell — same class as silent drop.

5. **Gold independence.** Seed labels from model triage are **draft only** until an
   architect ratifies them. The gold author / rater MUST NOT be the same automated judge
   instance evaluated in draft 49 (see #47 ratification; #49 independence).

6. **Non-pinned forward is safety-bearing.** Churn reduction MUST NOT trade away gold
   `forward` on non-`pinned_critical` cases (substantive bugs). Misroute `forward` →
   `backlog` is a hard scorer failure, not a churn win (#47 gate A′).

7. **Two value baselines.** `baseline_forward_all` is the churn floor; `baseline_layer_a_only`
   is the improvement floor for accepting Layer B (#47 / #49). Beating forward-all alone is
   insufficient.

8. **Open-world class handling.** `class_tag` not in the corpus registry → Layer A
   `forward`, skip Layer B — never let an unvalidated judge handle unseen classes (#47).

9. **Fingerprint contract.** Drop dedup uses the pack's existing stable finding
   signature (same field AO already stores); drop requires matching fingerprint **and**
   `class_tag` with a prior send in the loop. Pinned + duplicate-drop interaction is an
   explicit documented exception (#47).

10. **Held-out retry hygiene (#49).** Selection failures consume the attempt cap; held-out
    failure forces corpus expansion / fresh held-out — not silent retune-on-held-out.

11. **Judge config parity (#49).** Production and gate share a tracked judge-config
    artifact; parity check before promotion.

12. **Feasibility gate — per-finding routing enactment (AO 0.9.2, spike 2026-06-02).**
    Production enactment requires **both** **A** (selective send, not bulk all-open) **and**
    **A′** (programmatic terminal transition for non-forward — `dismiss`/`backlogged` so
    `openFindingCount` clears). Bulk send alone is insufficient; leaving backlog/drop as
    `open` re-triggers orchestrator rules forever. **B** (`prior_sent`) is additional for
    `drop`. Gate 0: all three blocked on 0.9.2 CLI — **upstream-or-nothing** (draft 50 /
    [pack #140](https://github.com/chetwerikoff/orchestrator-pack/issues/140), #122 class).
    **Active now:** draft 47 offline corpus/scorer only. **Deferred:** drafts 48–49 until
    upstream unblock (§Q). No pack read-hook or ledger-only workaround. Optional read-only
    diagnostic: `scripts/review-bulk-send-diagnose.ps1` (operator notes in
    [`docs/architecture.md`](../architecture.md#finding-routing-enactment--gate-0-ao-092-2026-06-02);
    drafts 47 / 50 cite the same entrypoint).
13. **Three substrate capabilities (not one ladder).** (a) **Selective enactment** —
    send a subset, not bulk all-open. (a′) **Terminal non-forward status** — `backlog` /
    `drop` must leave the finding non-`open` so `openFindingCount > 0` can clear and
    orchestrator rules stop re-firing; without AO support, backlog/drop are upstream-blocked
    (#122 class). (b) **`prior_sent` visibility** — for `drop` dedup; does not imply (a) or (a′).

## Files out of scope (shared)

- `prompts/codex_review_prompt.md` and the SkillOpt prompt trilogy (#80 / #81 / #30) —
  those optimize reviewer *output*; this trilogy optimizes *what the orchestrator does*
  with delivered findings.
- Reviewer wrapper delivery / JSONL hydration — see invariant (1); routing does not
  substitute for #135/#136.
- AO core, `packages/core/**`, `vendor/**`, live `agent-orchestrator.yaml` / `.ao/**`.
- Autonomous prompt or rule changes without operator acceptance.
- `code-reviews/**` runtime state (gitignored); corpus entries are **committed fixtures**
  derived from real cases, not live workspace paths.

## Denylist

```denylist
vendor/**
packages/core/**
code-reviews/**
.ao/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
.github/workflows/**
```

```allowed-roots
scripts/**
tests/**
docs/**
plugins/**
```

Classifier judge rubric / few-shot artifacts live under `plugins/**` or `scripts/**`
for this trilogy — not `prompts/codex_review_prompt.md` (reviewer prompt is #80–#30).
Issue-specific drafts may narrow `allowed_roots` further in their denylist block.
