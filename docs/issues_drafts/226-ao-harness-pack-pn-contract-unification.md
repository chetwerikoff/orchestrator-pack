# Unify AO 0.10 review harness with pack [Pn] finding contract

GitHub Issue: #658

## Prerequisite

- `docs/issues_drafts/210-ao-010-review-harness-and-trigger-loop.md` (GitHub #623, **merged**) — reviewer harness config (`ProjectConfig.reviewers[].harness`), pack-owned trigger loop, `ao-review` anti-corruption shim, review-before-cleanup gate. *Already does:* AO 0.10 lifecycle integration (trigger → `review_run` → submit → auto-delivery). **Explicitly left out:** output format, reviewer prompt, or `[Pn]` contract (verified: no format clause in draft/issue body).
- `docs/issues_drafts/211-ao-010-review-stuck-run-reaper.md` (GitHub #624) — stuck `running` recovery class; this issue must not fight reaper semantics.
- **REUSED merged lineage (wire to; do not rebuild):**
  - `docs/issues_drafts/06-codex-reviewer-scope-context.md` (GitHub #9) — structured finding JSON + `NO_FINDINGS` contract.
  - `docs/issues_drafts/44-codex-review-jsonl-verdict-source.md` (GitHub #127) — JSONL `review_output` as primary verdict source; contradictory output → fail closed.
  - `docs/issues_drafts/45-codex-review-jsonl-explanation-findings-recovery.md` (GitHub #135) — bounded split-channel recovery without prose scrape.
  - `docs/issues_drafts/46-codex-review-native-output-format-alignment.md` (GitHub #136) — prompt → CLI hydration → mapper alignment.
  - `docs/issues_drafts/115-reviewer-coworker-contract-mapping-pass.md` (GitHub #362) — severity blocking/non-blocking mapping surfaces (`scripts/invoke-reviewer-contract-mapping.ps1`).
- **Sibling consumers (out of scope — do not set format here):** `docs/issues_drafts/213-ao-010-review-producer-data-contract.md` (#626), `docs/issues_drafts/214-ao-reviews-board-runtime-aggregation.md`, `docs/issues_drafts/215-ao-reviews-board-ui-fork.md`.
- Incident grounding: `docs/investigations/ao-010-review-harness-vs-pack-wrapper-2026-07-07.md` — AO harness path produced prose (`Finding:`, `BLOCKING:`); manual `invoke-pack-review.ps1` on PR #649 produced `[P2]` structured JSON.
- Prior-art verdict: **Extends #623.** No open draft owns harness-triggered `[Pn]` emission; #625 vocabulary migration does not cover format.

## Goal

Deliver a **single default** AO-triggered review path that preserves 0.10 lifecycle integration (trigger → `review_run` → submit → auto-delivery to worker) **and** emits pack-contract structured `[Pn]` findings identical to what the shipped `review_jsonl.ts` mapper produces today. The standalone `invoke-pack-review.ps1` manual entry remains **unchanged** as operator fallback.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
escalation-markers: external-producer-binding, state-machine-core, contract-≥2-future-issues, recovery-class
```

## Binding surface

### Invariants (non-negotiable)

- **No AO core / vendor edits.** Harness selection stays `ProjectConfig.reviewers[].harness`; pack cannot add `reviewers[]` prompt/instructions fields.
- **Reuse shipped [Pn] machinery.** Structured findings MUST flow through the existing `codex exec review --json` → hydrated `review_output` → `review_jsonl.ts` mapper path (#127/#136). **Forbidden:** scraping `[P0]`–`[P3]` from `review_run.body` prose, GitHub markdown, or `overall_explanation`.
- **Trusted-pack-root prompt loading.** `prompts/codex_review_prompt.md` loads from the trusted pack root — never a workspace copy. The harness bridge entrypoint and mapper invocation path MUST resolve from the same trusted pack root (not worker-worktree `scripts/**` copies). Any reviewer-workspace instruction surface is **supplemental** only; it must not replace or shadow trusted-root prompt or bridge loading.
- **Mandatory pre-submit pipeline.** The harness-spawned reviewer MUST execute the pack-native JSONL review pipeline (trusted prompt → `codex exec review --json` → mapper) **before** `ao review submit`. Supplemental workspace rules alone are insufficient — a pack-owned pre-submit gate or equivalent hard requirement must fail the run if mapper output is absent.
- **Manual wrapper frozen.** `scripts/invoke-pack-review.ps1` behavior, argv, and stdout contract remain unchanged.
- **Codex harness is the practical default.** Claude harness re-review after supersede is structurally broken on 0.10.2; designs must assume `reviewers:[{harness:codex}]` and document the unset-`reviewers` → `claude-code` fallback trap.
- **Submit carries structured payload.** `ao review submit` body (and auto-delivered worker message) must carry mapper-normalized findings — titles with `[Pn]` prefix, `severity: blocking|non-blocking` per architecture §F, repo-relative paths — not incidental prose headings.
- **Failure-class handling (fix the class, not the incident case):**

| Failure class | Expected pack behavior |
| --- | --- |
| Run stuck `running`, same head | Coordinate with #211; bridge must not submit synthetic findings; trigger eligibility restored only after reaper/recovery |
| Contradictory / empty hydrated `review_output` | Fail closed per #127; classified `timeout_no_verdict` when review-mode times out (#539 classifier) |
| `reviewers` unset → daemon defaults `claude-code` | Pre-trigger guard: **refuse** batch trigger until harness configured; classified abort — not warn-only |
| Claude harness relaunch after supersede | Out of scope to fix in AO core; document codex-only policy |
| Nested review timeout / budget exhaustion | Classified failure (`timeout_no_verdict`); any retry happens at the run/trigger level per the existing #461/#539 lineage — never by re-invoking codex inside the same bridge run, never prose-scrape fallback |
| Reviewer posts unstructured GitHub body | Submit path validates mapper output shape before accept; reject or fail run |

### Default path architecture (outcome)

```
[ao-review run / POST trigger] → [AO spawns codex harness reviewer in worker WT]
        → [reviewer executes pack-native JSONL review pipeline (trusted prompt + mapper)]
        → [structured findings normalized]
        → [ao review submit + auto-deliver to worker]
```

The planner chooses bridge packaging (dedicated script vs shared internal entry) — the spec binds **observable outcomes**: trusted-root resolution, mandatory pre-submit mapper output, and structured submit body.

### Rollback / kill-switch

Operator doc MUST describe how to disable the harness bridge (env flag or config pointer — planner names it) and revert to manual `invoke-pack-review.ps1` + submit without changing AO harness config. No silent default-only path without documented escape hatch.

### Operator adoption

1. Confirm `reviewers:[{harness:codex}]` via raw HTTP `GET /api/v1/projects/orchestrator-pack` at `.project.config.reviewers` (`ao project get` hides `reviewers`; `GET …/projects/orchestrator-pack/config` is `method_not_allowed` — probed live 2026-07-07).
2. After merge, run one smoke trigger → verify `latestRun.body` / worker delivery contains `[Pn]`-prefixed structured findings, not prose-only `Finding:` blocks.
3. Do **not** use `ao project set-config` partial JSON — full-replace clobbered `reviewers` in the 2026-07-07 incident.

## Files in scope

- Pack harness review bridge under `scripts/**` `(new)` — connects AO-triggered reviewer session to existing mapper pipeline without modifying `invoke-pack-review.ps1`
- `plugins/ao-codex-pr-reviewer/**` — extend only where harness invocation needs shared entry `(extend if needed)`
- Reviewer-workspace delivery contract under `prompts/**` and/or `.cursor/rules/**` `(new or extend)` — supplemental; must not weaken trusted-root prompt rule
- `tests/**` + `tests/external-output-references/**` — harness-path structured-finding fixtures `(new)`
- `docs/**` — operator adoption for unified path `(update)`

## Files out of scope

- `scripts/invoke-pack-review.ps1` — frozen manual fallback
- Reviews board runtime/UI — #214 / #215 / producer schema — #213
- Trigger loop / harness config mechanics — #623 (already merged). The **additive pre-trigger reviewers guard (AC#6) is in scope** — this exclusion bars rebuilding #623 machinery, not adding the guard at the pack trigger entry.
- Stuck-run reaper implementation — #211
- `vendor/**`, `packages/core/**`, live `agent-orchestrator.yaml`

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
plugins/ao-codex-pr-reviewer/**
prompts/**
.cursor/rules/**
tests/**
tests/external-output-references/**
docs/**
```

## Acceptance criteria

1. **Harness trigger unchanged.** `ao-review run <worker-session>` still delegates to `POST /api/v1/sessions/{id}/reviews/trigger`; no bypass of trigger/submit lifecycle.

```positive-outcome
asserts: ao-review run against a review-ready worker session returns the same trigger outcome class (201 created or 200 reused) as direct HTTP trigger
input: external-tool-output
provenance: capture-backed
```

2. **Structured findings on submit — both outcomes.** After a codex-harness review completes on a PR with at least one non-blocking finding, `latestRun.body` (and auto-delivered worker payload) contains mapper output with `[Pn]` title prefixes and §F severities — not prose-only `Finding:` / `BLOCKING:` headings. A **clean** review (zero findings) submits the shipped #9 clean contract (`findingCount: 0` / `NO_FINDINGS`-class outcome), never an empty body, prose improvisation, or a failed run.

```positive-outcome
asserts: completed harness-triggered review run body matches pack structured-finding schema (title prefix [P0]-[P3], severity blocking|non-blocking, repo-relative path when file-specific)
input: external-tool-output
provenance: capture-backed
```

```producer-emission
producer: orchestrator-pack
datum: harness-review-structured-findings
expected: pn-titled-mapper-output-on-submit
proof-command: implementation-specific fixture replay comparing harness submit body to invoke-pack-review mapper golden shape; red-then-green must fail if body is prose-only without [Pn] titles
red-then-green: must fail if latestRun.body lacks [Pn] title prefix on a finding review
```

3. **JSONL source of truth.** Verdict/findings selection uses hydrated `review_output` only; contradictory JSONL fails closed; timeout maps to `timeout_no_verdict` evidence class.

```producer-emission
producer: orchestrator-pack
datum: harness-review-jsonl-verdict
expected: event-first-no-prose-scrape
proof-command: implementation-specific test replaying contradictory and empty review_output fixtures through harness bridge; red-then-green must fail if prose fallback is used
red-then-green: must fail if mapper reads Finding: lines from review_run.body
```

4. **Trusted execution-provenance invariant.** Harness path resolves **all three** execution surfaces from the trusted pack root: `codex_review_prompt.md`, the bridge entrypoint, and the mapper invocation (`review_jsonl.ts` path). Static guard rejects worker-worktree (workspace-copy) resolution for any of them — a shadowed bridge or mapper is the same tamper class as a shadowed prompt.

```producer-emission
producer: orchestrator-pack
datum: harness-review-execution-provenance
expected: trusted-pack-root-only-prompt-bridge-mapper
proof-command: implementation-specific static guard or fixture asserting prompt, bridge entrypoint, and mapper invocation all resolve from the trusted pack root; red-then-green must fail if any of the three resolves under the worker worktree
red-then-green: must fail if prompt, bridge, or mapper resolves under worker worktree instead of pack root
```

5. **Manual wrapper regression.** `invoke-pack-review.ps1` stdout JSON shape unchanged (snapshot or golden test against pre-merge baseline).

```positive-outcome
asserts: invoke-pack-review.ps1 on a fixed fixture branch emits byte-identical structured finding JSON to pre-change baseline
input: realistic
```

6. **Unset reviewers guard.** Pack trigger entry **refuses** batch trigger (classified non-zero / abort) when project config lacks `reviewers[0].harness=codex` — not warn-only. Daemon fallback to `claude-code` is a known failure class this guard must block.

```positive-outcome
asserts: trigger loop aborts with classified misconfig before POST trigger when reviewers key missing or harness is not codex
input: external-tool-output
provenance: capture-backed
```

7. **Failure-class fixtures.** Parameterized tests cover all six binding-table rows: stuck `running` (no fake submit), contradictory JSONL (fail closed), timeout (classified), unset reviewers (refuse trigger), claude supersede relaunch (documented no-op / codex-only policy), unstructured GitHub body (submit rejected).

```positive-outcome
asserts: failure-class fixture matrix yields expected outcome per binding table for all six rows including claude supersede policy and unstructured-body rejection
input: realistic
```

8. **No board contract drift.** Harness bridge does not emit board-specific fields or alter #213 producer schema — only populates existing `body`/`verdict` with structured content.

```producer-emission
producer: orchestrator-pack
datum: harness-review-producer-shape
expected: no-board-field-emission
proof-command: implementation-specific static guard or schema fixture asserting harness submit path populates only existing latestRun payload fields (body, verdict) without board-specific pseudo-fields; lifecycle status stays AO-owned and is never written by the bridge
red-then-green: must fail if harness bridge emits board column names or #213-external fields
```

9. **Nested review budget.** Harness bridge enforces a single nested `codex exec review --json` invocation per trigger **attempt** (no intra-bridge re-invocation or recursion), bounded timeout aligned with #461 lineage, and classified failure (`timeout_no_verdict`) on timeout/budget exhaustion — never prose fallback. Run-level retry after a classified failure stays governed by the existing #461/#539 retry/escalation lineage and is out of this bridge's hands.

```producer-emission
producer: orchestrator-pack
datum: harness-review-nested-budget
expected: single-nested-review-no-recursion
proof-command: implementation-specific fixture or static guard proving at most one nested codex review invocation per harness trigger; red-then-green must fail on recursive re-entry
red-then-green: must fail if bridge spawns more than one codex exec review per trigger
```

10. **Rollback documented.** Operator runbook includes kill-switch to disable harness bridge. With kill-switch enabled, harness-triggered path **aborts before submit** (classified failure) — not merely skip bridge while AO reviewer continues unstructured. Operator completes review via manual `invoke-pack-review.ps1`.

```positive-outcome
asserts: with kill-switch enabled, harness-triggered session aborts before ao review submit and does not auto-deliver unstructured prose; manual invoke-pack-review.ps1 remains available
input: realistic
```

## Upgrade-safety check

- No AO core / vendor edits; HTTP `/api/v1` trigger/submit only.
- No weakening of #127/#135/#136 mapper invariants.
- `invoke-pack-review.ps1` frozen — new bridge is additive.
- Operator harness config remains manual post-merge step.

## Verification

1. Capture-backed tests for AC#1–#2 (trigger + structured submit body).
2. Mapper fail-closed fixtures for AC#3.
3. Trusted-root static guard for AC#4.
4. Manual wrapper golden regression for AC#5.
5. Failure-class matrix for AC#7 (includes the unset-reviewers refuse-trigger row backing AC#6).
6. Capture-backed misconfig-abort test for AC#6 (trigger refused, classified, before POST).
7. Board no-drift static guard / schema fixture for AC#8.
8. Nested budget guard for AC#9.
9. Kill-switch fail-closed fixture for AC#10 (abort before submit; no unstructured auto-delivery).
10. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1` on this draft.

## Decisions

### Prior art

#623 shipped harness + trigger loop without format contract. #9/#127/#135/#136 shipped the mapper pipeline and prompt alignment. #362 shipped contract-mapping surfaces. This draft adds the **wiring layer** only — making the AO-triggered reviewer emit mapper output — without duplicating mapper logic or touching board consumers.

### Design analysis (T3)

**Critical mechanics:** AO spawns codex harness reviewer inside worker worktree (full pack surface visible); reviewer must run `codex exec review --json`, hydrate `review_output`, map via `review_jsonl.ts`, then `ao review submit`; auto-delivery propagates `body` to worker. AO owns harness agent instructions at 0.10.2 — no `reviewers[]` prompt field.

**Industry pattern:** CI review bots run a fixed tool chain in the job workspace and post structured results (GitHub Checks annotations) — orchestrator owns *when*, tool chain owns *shape*.

**Architecture sketch:**

```
POST trigger → AO reviewer session (worker WT)
    → pack-native JSONL review (trusted prompt + codex exec review --json)
    → review_jsonl.ts → structured findings
    → ao review submit (GitHub posting follows the existing harness/submit
      contract — the bridge adds no new GitHub write path)
    → auto-deliver (ao send) with [Pn] body
```

**Options (cost / risk / sufficiency):**

| Option | Cost | Risk | Sufficiency |
| --- | --- | --- | --- |
| **(a) Instruction-only** — workspace rules require `[Pn]` in reviewer prose | Low | High — incident proved prose drift; not mapper-governed | Insufficient |
| **(b) Harness reviewer runs pack JSONL pipeline** — same mapper chain as wrapper, new bridge only | Medium | Nested codex timeout; submit wiring | **Cheapest sufficient** |
| **(c) Post-submit prose enricher** — scrape/normalize `review_run.body` | Medium | Violates no-scrape; lossy | Rejected |
| **(d) Extend shipped wrapper** — call `invoke-pack-review.ps1` internals from harness without changing manual entry | Low–medium | Must not alter manual argv/stdout | **Land with (b)** — shared internals, frozen public wrapper |

**Land:** **(b)+(d)** — harness-spawned reviewer executes the pack-native JSONL review pipeline through a new bridge that reuses wrapper internals; `invoke-pack-review.ps1` public contract unchanged.

**Rejected:** (a) instruction-only (incident disproof); (c) prose bridge (#127 violation).

**Full-class scenario matrix (binding table above):** acceptance AC#7 encodes all six failure classes as exhaustive fixtures — not only the 2026-07-07 prose-format case.

```contract-evidence
binding-id: ao-0-10-daemon:per-session-reviews:latest-run-body-field
binding-type: structured
binding: GET /api/v1/sessions/{id}/reviews latestRun includes body field on complete runs
producer: ao-0-10-daemon
evidence: capture@ao-0-10-daemon/per-session-reviews-populated
selector: $.reviews[1].latestRun.body
expected: Address vocabulary migration gaps.

binding-id: ao-0-10-daemon:per-session-reviews:review-run-status-enum
binding-type: structured
binding: per-session reviews payload includes latestRun.status for lifecycle states
producer: ao-0-10-daemon
evidence: capture@ao-0-10-daemon/per-session-reviews-populated
selector: $.reviews[0].latestRun.status
expected: running

binding-id: orchestrator-pack:harness-review-structured-findings:pn-titled-mapper-output-on-submit
binding-type: structured
binding: harness-triggered submit body carries [Pn]-prefixed mapper findings
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
expected: pn-titled-mapper-output-on-submit

binding-id: orchestrator-pack:harness-review-jsonl-verdict:event-first-no-prose-scrape
binding-type: structured
binding: harness path selects verdict from hydrated review_output only
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
expected: event-first-no-prose-scrape

binding-id: orchestrator-pack:harness-review-execution-provenance:trusted-pack-root-only-prompt-bridge-mapper
binding-type: structured
binding: harness review resolves prompt, bridge entrypoint, and mapper invocation from trusted pack root
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
expected: trusted-pack-root-only-prompt-bridge-mapper
```