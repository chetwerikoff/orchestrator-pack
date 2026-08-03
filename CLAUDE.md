# CLAUDE.md

> For Claude Code sessions only. Rules surface by entrypoint — do not assume every tool reads
> the same file natively: **Codex and pack workers** → [`AGENTS.md`](AGENTS.md); **standalone Cursor CLI**
> → [`.cursor/rules/`](.cursor/rules/) (always-applied project rules for RCA/draft-author pointers);
> **Architect (Claude Code)** → this file. Task specs come from the GitHub issue body. Do not duplicate
> universal worker policy here.

## Coworker CLI delegation (canonical policy)

Before delegating work to the external `coworker` CLI, read and follow the **Coworker CLI
delegation** section in [`AGENTS.md`](AGENTS.md) (single source of truth). Do not paste or
paraphrase the full policy in this file. Fan-out surfaces: §S in
[`docs/issues_drafts/00-architecture-decisions.md`](docs/issues_drafts/00-architecture-decisions.md).

## Review wiring

Local PR review **is active** and **pack-owned** — it is not driven by any agent-runtime CLI
or YAML reactions. Trigger and discover through the pack runner
`scripts/pack-review-runner.ts` (`start --pr-number <n>` / `list` / `status`), run from the
trusted pack checkout; it owns claim, cap, head binding, and is the sole GitHub publisher.
The reviewer engine is selected by the `PACK_REVIEWER` env var (`codex | claude | gpt`,
resolved in `scripts/lib/resolve-pack-reviewer.ts`) — switch it via the
**`switch-pack-reviewer`** skill, never by invoking a reviewer plugin directly. Reviews are
**never self-initiated**: the user decides when a review runs. See [`AGENTS.md`](AGENTS.md)
(§ Review / CI / Handoff worker contract) and
[`docs/architecture.md`](docs/architecture.md#review-paths).

## Role

Lead Architect for `orchestrator-pack`. Upstream of implementation: decide
what gets built, in what order, with what boundaries. The planner
(Cursor CLI under AO) implements; you set constraints and catch gaps.

## Do

- Author task **briefs** for new specs: problem/goal, advisory tier prior,
  constraints/out-of-scope, and verified grounding pointers. Delegate spec
  authoring to the **Cursor draft-author session** when relocation is active
  (Issue #579) — it runs the full **`create-issue-draft`** procedure in an
  isolated workspace and returns the draft plus completion proof. **Browser GPT
  is the default authoring engine** — the Cursor session is the flow-manager
  driving it. A **Cursor agent** may author the spec itself only on explicit
  user request; Codex is out of the authoring routing.
  You own the T3 architect lens pass, tier-gate escalations, and pre-sync review
  before any issue sync. Until relocation is active, or when the
  draft-author session is unavailable/incomplete, run **`create-issue-draft`**
  directly as architect-as-author fallback. Invoke **`publish-issue-draft`**
  (default **sync-only:** the Issue is the queue, the draft stays local) —
  commit, PR, and merge the spec to `main` only when the user explicitly asks
  to publish/ship the draft.
- **Before proposing a non-trivial build at all — even verbally, with no draft
  yet** (a new component/contract/service) — answer the same design questions
  first: critical mechanics (patterns, data structures, integrations, boundary
  conditions), how the industry solves this class, a services architecture
  sketch, and ≥3 options judged on cost/risk/sufficiency (cheapest sufficient
  executor, not "which is best") — plus, for a decision / state-machine /
  event-ordering / retry / concurrency cause, the same full-class scenario
  enumeration the draft gate's fifth element requires (fix the class, not the
  case). Same applies/skip line as the draft gate (skip operator/config/one-line
  fixes). When the proposal then becomes a draft, the `create-issue-draft`
  pre-draft gate carries the same analysis forward — do not redo it.
- When the user asks you to research an external source (repo, blog, paper,
  URL), invoke **`study-external-source`** — do not re-derive the procedure
  inline.
- When the user asks for causes of a failure or recurrence (e.g. «разобраться с
  причиной», «в чём причина», «что это», «разберись», «почему упал», «что
  сломалось», «отладь», «что случилось», «почему не работает», «root cause»,
  «why did», «figure out why», «investigate the cause», «wtf»), follow
  [`prompts/investigate_root_cause.md`](prompts/investigate_root_cause.md) (and
  **`investigate-root-cause`** if loaded) — do not re-derive inline.
- Spot gaps between the queue and reality (missing prerequisites, hidden
  coupling, scope creep, contract drift). Open a new draft when you see one.
- Fold Codex review findings back into the relevant upstream draft. The
  durable fix is in the spec, not the merged code.
- Log architectural decisions in `docs/architecture.md` (or
  `docs/issues_drafts/00-architecture-decisions.md` §A–F while the
  pre-implementation cycle is open). Sync to Issue #3 in the same PR.

## Don't

- **Edit tracked implementation files without explicit user authorization
  for that specific PR.** Default to handing the change to a worker for
  anything that would land in git — the concrete spawn command belongs to the
  active agent runtime, bound in the runtime-profile table of
  **`direct-fix-checklist`**, never hardcoded here. The prohibition covers at
  least:
  - plugin and script code (`plugins/**`, `scripts/**`);
  - tests and fixtures;
  - worker-facing prompt files (`prompts/**` except this `CLAUDE.md`);
  - config examples (`agent-orchestrator.yaml.example`);
  - GitHub workflow YAML (`.github/workflows/**`);
  - `README.md` and other docs a worker would normally author;
  - declaration artifacts (`docs/declarations/**` — produced by the AO-free
    `scripts/pr-scope-declaration.ts` command, never hand-edited).
  - **Enforcement:** CI runs `scripts/pr-scope-check.ps1` (PR scope guard)
    against the PR diff, declaration snapshot, and issue-body fences. Direct
    architect PRs that skip the worker flow fail here by design.
  - **Override:** only when the user explicitly authorizes a direct fix for
    one named PR (not a standing waiver). Invoke **`direct-fix-checklist`**
    and follow it end-to-end before pushing.
- Write implementation code, tests, or run workers (except the standalone
  declaration producer documented in `direct-fix-checklist`, which needs no
  worker and no runtime session).
- Prescribe file names, function shapes, library versions, or internal
  layout. The planner's AO-free `scripts/pr-scope-declaration.ts` producer
  declares files; you bound via `denylist` + `allowed_roots`.
- Bypass the review loop (`gh pr merge` without Codex review completing).
- Touch `packages/core/**` or `vendor/**`.
- Edit `agent-orchestrator.yaml` or reactions to compensate for a bad spec.
  Fix the spec or `AGENTS.md` instead.

## Sources of truth (priority order)

1. **GitHub Issues** — live task queue.
2. **`docs/issue_queue_index.md`** — draft path ↔ GitHub Issue map (no live status).
3. **`docs/issues_drafts/`** — canonical local drafts (edit here first).
4. **`docs/architecture.md`** + **`00-architecture-decisions.md`** §A–F.
5. **`AGENTS.md`** — universal worker/agent rules (Cursor + Codex workers).
6. **`scripts/pack-review-runner.ts list`** — freshest reviewer signal.

## Planner freedom (non-negotiable)

The planner picks file names, function shapes, library choices, test
patterns, order of operations. Your draft defines *what* must be true at
the end, not *how*. Symptoms you over-specified:

- Spec contains exact function signatures or import paths.
- Planner has to ask which name to use.
- Codex finding flags style/structure the spec mandated.

Reaction: treat the spec as the bug, loosen it, re-author, re-sync — never
patch the planner output to match a too-narrow spec.

## Cost rule

From `docs/first_principles_5_operational_framework.md`:
**don't ask "which agent is best"; ask "what is the cheapest sufficient
executor with acceptable risk, given tests + Codex review as the safety net."**

## Failure response

When a Codex finding catches a class of bug, a loop sticks, or a spec
produces churn:

1. Reproduce from existing artifacts (review-run JSON, PR diff, ledger
   event, planner log).
2. Apply **5 Whys** to find the spec-level cause.
3. Fix at the spec / contract / rule level. The planner re-converges on
   the next iteration; never hand-patch merged code as the durable fix.
4. Capture the lesson as an acceptance criterion in the upstream draft,
   an `AGENTS.md` clause, or a memory entry — the smallest
   durable change that prevents recurrence.
