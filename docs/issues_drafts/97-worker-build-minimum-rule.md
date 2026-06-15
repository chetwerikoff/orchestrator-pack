# Worker rule: build the minimum, no unrequested abstraction

GitHub Issue: #301

**Numbering:** draft file **97** (`97-worker-build-minimum-rule.md`) is not
[GitHub #97](https://github.com/chetwerikoff/orchestrator-pack/issues/97). Resolve the real
issue number from `docs/issue_queue_index.md` after sync.

## Prerequisite

None block this. Sibling worker-rule clauses already live in the same file and set the
authoring pattern this draft follows (new prose section + grep-based acceptance + `verify.ps1`):

- `docs/issues_drafts/32-worker-acknowledge-pickup-contract.md` (GitHub #88) — **closed/landed**;
  adds a mandatory worker first-action clause to `prompts/agent_rules.md`.
- `docs/issues_drafts/52-coworker-cli-delegation-policy.md` — adds the coworker delegation
  clause to `prompts/agent_rules.md` (same file, same prose-contract acceptance shape).
- `docs/issues_drafts/37-ci-failed-ping-before-report-stale-backstop.md` (GitHub #109) — adds a
  worker CI-discipline clause; reused here only as the structural template.

**Prior art (recon verdict: genuinely new).** A survey of all 95 local drafts + the
architecture log + the queue index (coworker bulk read; verdict on the reasoning model) found
**no** existing draft expressing worker-facing minimalism / anti-over-engineering. The closest
existing concept is the architect-side **planner-freedom** principle in `CLAUDE.md` — but that
binds the *architect* (don't over-specify in the spec), never the *worker* (don't over-build in
the implementation). This draft adds the worker-facing twin. It does **not** re-implement any
shipped machinery; it adds one prose clause to a file that already hosts sibling worker clauses.

**Provenance.** Adapted from the external project `DietrichGebert/ponytail` (MIT) — a portable
YAGNI/anti-over-engineering ruleset for AI coding agents. Only the *rule content* is adopted;
ponytail's multi-host distribution layer, plugin/hooks, mode commands, and benchmark claims were
rejected as duplicative or unrepresentative of this pack's workload (see Decisions below).

## Goal

Give AO workers an explicit, standing instruction to build the **minimum** implementation that
satisfies the issue's acceptance criteria — prefer deletion and reuse over new code, and avoid
**unrequested** abstraction — so over-engineering is prevented in the worker's first pass
(shift-left) rather than only caught reactively by Codex review (costing an extra iteration).
The rule must be tightly bounded so it does **not** push workers to under-build: it carries
explicit carve-outs both for legitimate architectural abstractions this contract-heavy pack
needs, and for rigor (validation, data-loss handling, security, required tests) that must never
be skipped in the name of minimalism.

**Behavior kind.** This draft's deliverable is **prose in a rules file** — it has no
action-producing success path of its own (no run, message, wake, or transition). Success is the
clause being present and correctly bounded; whether workers *obey* it surfaces later through
ordinary Codex review, not from this draft. (Same shape as sibling worker-rule drafts #32/#37,
which carry no `behavior-kind` fence.)

## Binding surface

1. **Worker minimalism clause (`prompts/agent_rules.md`).** A new worker-facing section MUST
   instruct the worker to:
   - build the smallest implementation that satisfies the issue's stated acceptance criteria;
   - prefer reusing or deleting existing code over adding new code;
   - avoid **unrequested** abstraction — i.e. do not introduce indirection, a layer, a config
     knob, or a generalization that no acceptance criterion or carve-out below justifies.

   The clause MUST be expressed as a standing worker obligation, in the same register as the
   existing worker clauses in this file. Exact wording, section title, and placement are the
   planner's choice.

2. **Permitted-abstraction carve-outs (load-bearing — the clause is unsafe without them).** The
   clause MUST state that "minimum" is **not** a hard "no abstraction until a second concrete
   caller exists" rule. An abstraction, boundary, adapter, generator, or single-source layer is
   legitimate — not over-engineering — when justified by **any** of:
   - an issue acceptance criterion;
   - a public / host / cross-tool boundary (e.g. a contract other entrypoints consume);
   - cross-platform compatibility (e.g. Windows + Linux/WSL2);
   - generated-drift prevention (a canonical source + generated pointers, a drift guard);
   - testability of a risky seam;
   - upstream upgrade-safety (keeping AO-core/vendor edits out by adding a thin pack-side seam).

3. **Rigor carve-outs (minimalism must NOT degrade these).** The clause MUST state that the
   worker may not skimp, in the name of minimalism, on: input validation at trust boundaries,
   error handling that prevents data loss, security, or any test the issue / Codex review
   requires. "Less code" never overrides correctness or the review/CI gate.

4. **Scope is the AO worker surface only.** The only **behavioral / rule** surface this draft
   touches is `prompts/agent_rules.md` — the rules file AO injects into workers via
   `agentRulesFile`. (The `docs/issue_queue_index.md` registry row added at sync is bookkeeping,
   not a rule surface.) It does **not** claim to cover Codex-side (`AGENTS.md`),
   standalone-Cursor (`.cursor/rules/`), or Claude-side surfaces. Whether to mirror the clause to
   those surfaces is deliberately **out of scope** here (see Files out of scope); if a future
   draft mirrors it, that draft owns the cross-surface drift check. No silent claim of universal
   coverage.

5. **No marker / debt-ledger convention.** This draft does **not** introduce a code-comment
   marker (e.g. a `// simplified:` tag) for deliberate simplifications. A marker with no
   harvester or audit loop only imitates intentionality and can mask under-built validation;
   since worker over-engineering is plausible-but-undocumented pain, the prose clause ships
   first and a marker + audit path is reconsidered only if debt-blindness becomes a real signal.

## Operator adoption

After the PR lands, the new clause reaches **newly spawned** workers automatically (AO reads
`prompts/agent_rules.md` via `agentRulesFile` at spawn). To refresh **already-running** AO
sessions / any cached rules, the operator restarts AO (`ao stop` / `ao start`). No new env
vars, no `agent-orchestrator.yaml` change.

## Files in scope

- `prompts/agent_rules.md` — the new worker minimalism clause with both carve-out sets.
- `docs/issue_queue_index.md` — registry row (added at sync; selective stage).

## Files out of scope

- `AGENTS.md`, `.cursor/rules/**`, `.github/copilot-instructions.md`, any other agent surface —
  mirroring the clause beyond the AO worker surface is a separate future draft.
- `CLAUDE.md` — architect planner-freedom is already documented; not edited here.
- Any code-comment marker / harvester / `ponytail`-style plugin, hooks, or `/`-command.
- `vendor/**`, `packages/core/**`, `agent-orchestrator.yaml` (live), plugins, scripts.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
prompts/**
docs/issue_queue_index.md
```

## Acceptance criteria

These are **prose-contract** checks (grep/lint): they prove the clause exists and is correctly
bounded, not that workers obey it (obedience surfaces through ordinary Codex review later).

- **Minimalism clause present.** `prompts/agent_rules.md` contains a worker-facing clause that
  tells the worker to build the minimum satisfying the acceptance criteria, prefer
  deletion/reuse over new code, and avoid unrequested abstraction. Provable by reading the
  added section; a reviewer can point to the three obligations.
- **Permitted-abstraction carve-outs present.** The clause explicitly states it is NOT a hard
  "second concrete caller" rule and lists the legitimate-abstraction justifications
  (acceptance criterion, host/public boundary, cross-platform compatibility,
  generated-drift prevention, risky-seam testability, upgrade-safety). All six classes appear.
- **Rigor carve-outs present.** The clause explicitly forbids skimping on input validation at
  trust boundaries, data-loss error handling, security, and required tests in the name of
  minimalism.
- **Scope statement present.** The clause (or its surrounding prose) states it governs the AO
  worker surface (`prompts/agent_rules.md`) and does not silently claim other agent surfaces.
- **No marker introduced.** No code-comment marker convention or harvester is added by this PR.
- **Internal consistency.** The new clause does not contradict the existing coworker-delegation,
  acknowledge-pickup, or CI-discipline clauses in the same file.
- **Static verification.** `pwsh -NoProfile -File scripts/verify.ps1` passes **unmodified** (no
  new committed check required — `scripts/**` stays out of scope). Separately, a
  **verification-time** prose-contract check (run ad hoc against the edited file, e.g. the
  Verification snippet) confirms **each** required concept is individually present and **fails if
  any is missing** — not merely that some line matches. Required concepts: (a) build the minimum
  / smallest that satisfies acceptance criteria; (b) prefer deletion/reuse over new code; (c)
  avoid unrequested abstraction; (d) explicit "not a hard second-caller rule"; (e) each of the
  six permitted-abstraction justifications; (f) each of the four rigor carve-outs (validation,
  data-loss, security, required tests); (g) the AO-worker-surface scope statement. The check is
  an ad-hoc verification step, not a committed artifact; the bar is per-concept presence, not a
  single alternation that passes on one hit.

## Upgrade-safety check

- No AO core / vendor edits; no `agent-orchestrator.yaml` (live) change; no new secrets.
- Pure additive prose to an existing rules file — no contract removed or weakened.
- Does not narrow planner freedom: the clause states *what must be true* (build minimum within
  carve-outs), not *how* the worker structures any specific implementation. It explicitly
  preserves the abstractions the pack legitimately needs (carve-out set in binding surface §2).
- Operator adoption is restart-only: newly spawned workers pick up the clause automatically;
  already-running sessions / cached rules refresh on `ao stop` / `ao start` (see Operator
  adoption). No env or `agent-orchestrator.yaml` change.

## Verification

Prose-contract only — does not prove worker runtime behaviour. This is an **ad-hoc
verification-time** check (not a committed script; `scripts/**` is out of scope). It must confirm
**each** required concept individually and fail if **any** is absent (a single alternation that
passes on one hit is insufficient — the bug Codex flagged). The planner picks the exact
mechanism; one sufficient shape is a per-concept loop that exits non-zero on the first missing
concept, e.g.:

```powershell
$required = @(
  'minimum|smallest', 'prefer (deletion|reuse)', 'unrequested abstraction',
  'second concrete caller', 'acceptance criterion', 'host|public boundary',
  'cross-platform', 'generated.drift', 'risky seam|testab', 'upgrade.safety',
  'input validation', 'data.loss', 'security', 'required test',
  'AO worker surface|agentRulesFile'
)
$missing = $required | Where-Object { -not (Select-String -Path prompts/agent_rules.md -Pattern $_ -Quiet) }
if ($missing) { Write-Error "missing prose-contract concepts: $($missing -join '; ')"; exit 1 }
pwsh -NoProfile -File scripts/verify.ps1
```

A reviewer also confirms by reading the new section that both carve-out sets
(permitted-abstraction and rigor) are present and that the scope statement names the AO worker
surface only.
