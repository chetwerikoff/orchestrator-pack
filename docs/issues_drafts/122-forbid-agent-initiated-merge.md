# Forbid agent-initiated merge: the orchestrator must not direct a merge and a worker must never merge

GitHub Issue: #386

## Prerequisite

Already-merged work this draft builds on (reused, not re-implemented):

- `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md` (GitHub #28) —
  *already does:* the foundational **NO MERGE BY ORCHESTRATOR** clause in the
  `orchestratorRules` literal (`agent-orchestrator.yaml.example`): "Never call
  `gh pr merge` or click Merge. Emit ready-for-human-merge notification only when
  ALL are true …". **Gap this draft closes:** the clause forbids the orchestrator
  from *calling* the merge itself, but not from **directing another agent to merge**
  (a worker turn told to "proceed to merge"), and it does not say to **whom** the
  ready-for-human-merge hand-off is addressed.
- `docs/issues_drafts/21-post-merge-review-run-lifecycle.md` (GitHub #54) —
  *already does:* `MERGED PR — REVIEW LOOP TERMINAL`; once a PR is merged the
  orchestrator takes no further review-loop action. Re-used as the terminal this
  hand-off precedes; not changed.
- `docs/issues_drafts/35-operator-adoption-handoff-contract.md` (GitHub #101) —
  *already does:* role contract — architect specs, worker documents, **operator
  executes**; merge sits in the operator-executes column. Re-used as the authority
  for "merge is operator-only"; this draft makes the worker-side rule say so.
- `docs/issues_drafts/70-orchestrator-event-driven-review-trigger.md` (GitHub #207)
  and `docs/issues_drafts/120-event-driven-review-trigger-on-ready-for-review-handoff.md`
  (GitHub #381) — *already do:* the `merge.ready` / `ready_for_review` completion-wake
  handling and the "re-read run state, do not proceed to merge on a stale wake"
  ordering. Re-used: this draft names what the orchestrator does *instead* of
  merging on that wake (hand off for human merge); it does not change the wake
  evaluation or claim machinery.

## Goal

Close the rule gap that let two PRs (#379/#377, #382/#381) be merged by a Cursor
worker turn after a clean review: the **orchestrator** instructed the worker to
"proceed to merge", the worker complied because **no rule on either side forbade
it**. State, on both rule surfaces, that no AO-managed agent — orchestrator or
worker — performs or directs a PR merge; merge is the operator's exclusive act,
and the approved-and-green completion wake is a hand-off **for a human merge**,
not a cue to merge.

```behavior-kind
action-producing
```

This draft is **policy text** on two existing rule surfaces, but its success path
is action-producing: on an approved-and-green completion wake the orchestrator
**emits** a ready-for-human-merge hand-off (an emission #28 already permits — this
draft makes it the mandated response and fixes its addressee). The prohibitions
(no orchestrator-directed merge, no worker self-merge) are the no-op side; the
hand-off emission is the positive observable. **Enforcement is prose only** — the
executable deny of `gh pr merge` for managed sessions is deliberately a follow-up
(see **Files out of scope**), so the acceptance below verifies rule-clause presence
and consistency, not a hard runtime block.

```contract-evidence
none
```

This draft binds to no new upstream datum. `merge.ready` / the approved-and-green
completion wake and the `gh pr merge` command are referenced only as already-shipped
surfaces grounded by the prerequisites (#207/#381 for the wake; #28 already names
`gh pr merge` as the forbidden command); the enforceable content — "no managed
agent merges or directs a merge" — consumes no producer field, shape, or output.

## Binding surface

The repository commits to a single, consistent **operator-only merge** policy
expressed on both surfaces an AO agent reads:

- **`orchestratorRules` (`agent-orchestrator.yaml.example`), extending the #28
  NO-MERGE clause.** The orchestrator (LLM turn, wake listener, or any
  orchestrator-driven path) MUST NOT, in addition to never calling the merge
  itself: **direct, instruct, ask, nudge, or otherwise prompt a worker — or any
  other agent — to merge.** A "proceed to merge" / "go ahead and merge" message to
  a worker is forbidden. The approved-and-green / `merge.ready` completion wake is
  a hand-off **addressed to the operator (human)**: on it the orchestrator emits
  the ready-for-human-merge notification (already gated by #28's ALL-true
  conditions) and **stops** at the merge boundary — it does not merge and does not
  delegate the merge.
- **`prompts/agent_rules.md` (worker), new worker-facing rule.** A worker MUST NOT
  run `gh pr merge` (in any form — env-prefixed, REST `gh api … /merge`, web
  Merge click, or via a skill), **and MUST NOT direct, instruct, or ask any other
  agent (worker, orchestrator, or sub-agent) to merge on its behalf** — the same
  no-direct-merge prohibition the orchestrator carries. Merge is operator-only.
  After a clean review on the current head with required CI green, the worker's
  terminal action is to report ready-for-human-merge and **stop** (it does not
  advance to merge), even if an orchestrator message appears to invite a merge —
  such an instruction is out of contract and the worker does not act on it. This
  composes with, and does not weaken, the existing worker hand-off rules (a clean
  review with no open/sent findings remains the success terminal; this draft only
  forbids the worker from turning that terminal into a self-merge or a delegated
  merge).
- **One consistent statement.** Both surfaces must say the same thing — merge is
  operator-only, no managed agent merges or directs a merge — so neither the
  orchestrator nor the worker can read a licence the other side forbids.

Mechanical enforcement (a process-boundary deny of `gh pr merge` for managed
sessions, and a send-path reject of a merge-instruction message) is **out of scope
here** and named below as a follow-up: prose is necessary and is what the operator
asked for first; the deny guard is the durable strengthening, tracked separately.

## Files in scope

- `agent-orchestrator.yaml.example` — extend the existing NO-MERGE clause in the
  `orchestratorRules` literal.
- `prompts/agent_rules.md` — add the worker-facing operator-only-merge rule.
- `docs/` — only if a runbook / migration note already documents the merge hand-off
  and would otherwise contradict the new rule (keep consistent; do not invent a new
  doc surface).

## Files out of scope

- Any process-boundary deny / shell-guard that mechanically blocks `gh pr merge`
  for managed sessions — **follow-up draft** (extends
  `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md`,
  GitHub #324, which today blocks `ao spawn` / `ao review run` / tree-mutating git
  but deliberately does **not** deny `gh pr merge`). Owner: a new draft, not this one.
- Any send-path token/wrapper that rejects a worker message containing a merge
  instruction — **follow-up draft** (relates to
  `docs/issues_drafts/121-llm-turn-worker-nudge-per-cycle-gate.md`, GitHub #384).
- `agent-orchestrator.yaml` live wiring (gitignored) — operator adoption only.
- `packages/core/**`, `vendor/**`, `.ao/**`.
- The #28 ALL-true emission conditions and the #207/#381 wake evaluation / claim
  machinery — referenced, not modified.

## Operator adoption

This draft edits `agent-orchestrator.yaml.example`'s `orchestratorRules` literal,
which the operator runs live. After the spec PR merges, the operator must:

- Merge the corresponding clause into the **live** `orchestratorRules` in
  `agent-orchestrator.yaml`.
- `ao stop` then `ao start` so the orchestrator session reloads the updated rules
  (per the managed-session restart contract; an architect/worker cannot restart AO).
- Verify the live orchestrator turn now forwards an approved-and-green head as a
  ready-for-human-merge hand-off and issues no "proceed to merge" to the worker.

## Denylist

Standard pack deny: `vendor/**`, `packages/core/**`, `.ao/**`.

## Acceptance criteria

```positive-outcome
asserts: manual cross-surface inspection (per Verification — reading agent-orchestrator.yaml.example orchestratorRules and prompts/agent_rules.md, no executable check or new code surface) confirms, on BOTH surfaces, an operator-only-merge clause that forbids performing a merge AND directing any other agent to merge, AND, on the orchestrator surface only, the approved-and-green/merge.ready wake named as an operator-addressed hand-off; the evidence is the quoted clause from each file (the reviewer rejects the change if the clause is absent on either surface, grants a merge-directing licence on either, or omits the wake-as-hand-off statement on the orchestrator surface)
input: realistic
```

- The `orchestratorRules` literal in `agent-orchestrator.yaml.example` states, as
  part of the NO-MERGE clause, that the orchestrator MUST NOT direct, instruct,
  ask, or nudge a worker (or any other agent) to merge — naming a "proceed to
  merge" worker message as forbidden — in addition to never merging itself.
- The same clause states that the approved-and-green / `merge.ready` completion
  wake is a hand-off addressed to the operator (human), on which the orchestrator
  emits the ready-for-human-merge notification and stops at the merge boundary
  (no merge, no delegation of the merge).
- `prompts/agent_rules.md` contains a worker-facing rule that the worker MUST NOT
  run `gh pr merge` in any form (env-prefixed, `gh api … /merge`, web Merge, or via
  a skill), MUST NOT direct/instruct/ask any other agent to merge on its behalf,
  that merge is operator-only, and that the worker's terminal action after a clean
  review on a green head is to report ready-for-human-merge and stop.
- The worker rule explicitly says that an orchestrator message inviting a merge is
  out of contract and the worker does not act on it.
- Both surfaces are mutually consistent: each states merge is operator-only and no
  managed agent merges or directs a merge; neither grants what the other forbids.
- The change does not weaken the existing worker success-terminal rules (a clean
  review with no open/sent findings is still the terminal); it only forbids
  converting that terminal into a self-merge.
- The two named follow-ups (mechanical deny extending #324; send-path reject
  relating to #384) are recorded in this issue's **Files out of scope** so the
  mechanical-enforcement gap is tracked, not silently dropped.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- `agent-orchestrator.yaml.example` stays schema-valid YAML; the `orchestratorRules`
  literal gains prose only — no new top-level keys, no double-quote characters
  inside the literal (per the literal's own constraint note).
- No new repo secrets, env vars, or operator processes beyond the existing
  `ao stop` / `ao start` reload.
- The rule is additive: it tightens the existing #28 / #54 / #101 / #207 / #381
  contracts and contradicts none of them.

## Verification

- Read `agent-orchestrator.yaml.example` and confirm the NO-MERGE clause now
  forbids the orchestrator directing/instructing a worker (or anyone) to merge and
  names the wake as an operator-addressed hand-off; quote the added lines.
- Read `prompts/agent_rules.md` and confirm the worker operator-only-merge rule and
  the "do not act on a merge invitation" line are present; quote them.
- Confirm the two surfaces are consistent (same operator-only statement) by diff or
  side-by-side quote.
- Confirm the example YAML still parses (e.g. the existing example-validation /
  `orchestrator-diagnose` path the repo already runs for `.example` changes) and
  the `orchestratorRules` literal has no newly introduced double quotes.
- Confirm **Files out of scope** lists the two mechanical-enforcement follow-ups.
