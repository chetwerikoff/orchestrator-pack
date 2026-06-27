# Codex reviewer time budget and timeout escalation

GitHub Issue: #461

## Prerequisite

- `docs/issues_drafts/06-codex-reviewer-scope-context.md` / GitHub #9 is closed.
  Already does: defines the Codex reviewer output contract and rejects empty output as a
  failed review instead of fake-clean.
- `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` / GitHub #60
  is closed. Already does: establishes that failed/cancelled zero-finding review runs do
  not count as clean review coverage.
- `docs/issues_drafts/91-review-run-crash-safe-terminal-status.md` / GitHub #287 is
  closed. Already does: handles reviewer processes that are provably dead or ambiguous
  outside the normal in-process timeout path.
- `docs/issues_drafts/101-reviewer-failure-evidence-log.md` / GitHub #312 is closed.
  Already does: persists bounded reviewer failure evidence.
- `docs/issues_drafts/102-reviewer-failure-evidence-redaction-and-summary-limit.md` /
  GitHub #315 is **open**. It must land first if this issue depends on #315-only
  cookie-redaction or summary-limit guarantees; otherwise this issue may rely only on
  the shipped #312 evidence behavior and keep #315's stronger evidence hardening out of
  scope.
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` / GitHub #189 is
  closed. Already does: prevents failed/cancelled review runs from covering a head.
- `docs/issues_drafts/88-review-start-atomic-claim.md` / GitHub #267 and
  `docs/issues_drafts/100-review-start-claim-atomic-single-winner.md` / GitHub #308 are
  closed. Already do: provide the shared atomic per `(PR, head)` review-start claim used
  by automated starters.
- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` / GitHub #318 is
  closed. Already does: puts autonomous LLM-orchestrator review starts behind the same
  claim and coverage gate as script starters.
- `docs/issues_drafts/106-review-and-cinudge-per-cycle-settle-gate.md` / GitHub #332 is
  closed. Already does: adds the per worker-iteration cycle gate that review-trigger
  re-arming must respect.

## Goal

When a Codex PR review approaches or reaches its reviewer-side time budget, the system must
finish in a non-clean, explainable, bounded state instead of producing repeated empty-output
failures. A slow-test PR must yield either a reviewer verdict produced before the hard kill,
or a structured timeout/escalation outcome that records what happened, stops unbounded
automatic retries, and leaves the next executor choice explicit.

```behavior-kind
action-producing
```

## Binding surface

This issue commits the pack-owned reviewer path to these outcomes:

1. **One effective reviewer budget.** The reviewer path exposes a single effective
   wall-clock budget for the review attempt. Any soft deadline, test budget, and hard kill
   must be derived from that effective budget or recorded as explicitly unavailable. The
   planner chooses the exact values and implementation mechanics.
2. **Budget-aware test execution is mechanically enforced.** The reviewer contract must
   not spend an unbounded share of its review budget on project tests. A prose or prompt-only
   instruction to the autonomous LLM reviewer is not sufficient: reviewer-spawned test/full
   suite commands need an exec-level budget/timebox or an equivalent wrapper-side guard that
   is enforced outside the model turn. The model-facing prompt may explain the policy, but it
   cannot be the only enforcement mechanism. A skipped slow test is not a clean-review signal.
3. **Verdict-before-kill is soft-deadline only; structured timeout is primary.**
   `codex exec review --output-last-message` emits the review payload only when the turn
   completes, so a hard kill cannot rescue streaming partial output. A verdict before kill is
   possible only if the reviewer is steered to wrap up before the hard deadline; otherwise the
   required outcome is a structured non-clean timeout/escalation record.
4. **Repeated same-head timeout failures are bounded at the review-start decision point.**
   For a `(PR, head SHA, reviewer failure class)` tuple, automatic retries must stop after a
   bounded policy and emit an operator-visible escalation. The cap belongs in the automated
   review-start/re-trigger path that decides to launch `ao review run` (for example the
   reconcile/reeval/wake/claimed-review surfaces and their shared review-start claim
   lifecycle), not only inside the single-run reviewer plugin. Reuse the existing
   per-head/cycle review-start claim/idempotency machinery from #267/#308/#332/#318 rather
   than adding a parallel counter.
5. **Prior-art fail-closed boundaries stay intact.** Empty output remains a failure per #9,
   failed runs do not count as head coverage per #60/#189, dead/ambiguous process recovery
   from #287 is not replaced, and timeout evidence uses shipped #312 redaction/bounds unless
   open #315 lands first.
6. **Operator adoption.** If the implementation adds or changes operator-visible timeout
   reasons, escalation text, or configuration examples, document the effective behavior and
   how to tell "slow tests skipped", "timeout before verdict", and "reviewer crashed" apart.

### Design analysis

#### Critical mechanics

The current reviewer wrapper enforces a hard `timeout: 10 * 60_000`. PR #457 showed that a
large diff plus real-time supervisor tests can consume that budget before Codex emits any
review result. The parser then correctly rejects empty output. The missing mechanics are:

- a budget ledger available to the reviewer/test runner decision;
- an enforcement point outside the LLM turn for reviewer-spawned test/full-suite commands;
- a slow/full-suite test policy that does not compete equally with review judgment;
- a soft-deadline path that asks the reviewer to finish before the hard kill, plus a
  structured timeout fallback when no verdict is possible;
- a per `(PR, head, failure-class)` retry/escalation cap in the review-start decision layer;
- failure evidence that lets operators distinguish timeout/no-verdict from malformed output.

#### Industry practice

For bounded automated reviewers, the common pattern is not "run every available test until
the outer process dies". CI owns exhaustive test execution; reviewers run selected checks
only when they are cheap enough to improve review confidence. Long-running automation uses
soft deadlines before hard cancellation, records cancellation reasons, and limits retries
for deterministic same-input failures. The same shape is already used elsewhere in this
repo: claims/dedup before sends, failed-run evidence, and operator-visible escalation
instead of silent retry loops.

#### Architecture sketch

```text
review run
  |
  v
reviewer wrapper ---- effective budget ----> reviewer/test policy
  |                                             |
  |                                             +--> exec-level test guard/timebox
  |                                             +--> run cheap targeted checks
  |                                             +--> skip slow/full-suite checks with audit
  |
  +--> normal verdict parser --> clean/findings/error
  |
  +--> soft timeout / hard timeout
          |
          v
      timeout evidence + same-head retry classifier
          |
          v
review-start decision / claim lifecycle
          |
          +--> bounded retry eligible
          +--> operator-visible escalation, no auto retry
```

#### Options

| Option | Cost | Risk | Sufficient |
|---|---:|---:|---|
| Prompt/prose-only budget instruction to Codex | Low | Same bypassable autonomous-LLM-turn class as earlier review/nudge leaks; Codex already ran tests despite review-scope guidance | No |
| Extend shipped reviewer failure handling with an exec-level test budget/timebox, timeout/no-verdict evidence, and same-head escalation cap in review-start decisions | Medium | Needs careful event-ordering fixtures around soft vs hard timeout and claim lifecycle | Yes |
| Only make #457 supervisor tests faster or excluded from reviewer runs | Low | Fixes the observed PR but leaves any future slow-test PR able to empty-timeout | No |
| Increase the hard timeout | Low | Hides the class, increases cost, and still fails on larger diffs/slower tests | No |
| Move all reviewer test execution to CI-only and never run local tests in review | Medium | Reduces timeout risk but can lose cheap regression signal for focused diffs | Partly |
| Replace reviewer process management with a new supervisor | High | Reimplements #287/#312 surfaces and broadens blast radius | No |

Chosen: extend the existing reviewer path. It is the cheapest sufficient executor with
acceptable risk because it reuses the existing parser/failure-evidence/run-state surfaces
and fixes the class rather than #457 alone. The chosen path explicitly requires an
enforceable command-budget layer and a review-start retry cap; a prompt-only change is not
a sufficient implementation.

#### Full-class scenario matrix

| Review state | Test plan | Time outcome | Prior same-head failures | Expected outcome |
|---|---|---|---|---|
| Verdict ready | none or cheap targeted | under budget | any | normal parser result; no timeout escalation |
| Verdict ready | slow test candidate | insufficient remaining budget | any | test skipped with audit; normal verdict may still emit |
| No verdict yet | cheap targeted running | soft deadline reached | below cap | structured timeout/no-verdict failure; retry eligibility follows policy |
| No verdict yet | cheap targeted running | hard kill before soft handler | below cap | non-clean timeout/no-verdict failure evidence; retry eligibility follows policy |
| No verdict yet | full suite requested | budget policy rejects | any | full suite not run by reviewer; CI remains the exhaustive executor |
| No verdict yet | slow tests already consumed budget | same-head failure cap reached | at/over cap | operator-visible escalation; no automatic same-head retry |
| No verdict yet | prompt says skip slow tests, model still invokes them | command budget exceeded | below cap | exec-level guard stops/denies the test command and records skipped/timeout audit; prompt-only compliance is not accepted as coverage |
| Reviewer emits malformed output | any | under budget | any | existing parse failure, not timeout/no-verdict |
| Reviewer process provably dead outside timeout | any | liveness recovery tick | any | #287 dead/ambiguous process handling, not this issue's timeout classifier |
| Failure evidence write fails | any | timeout path | any | run remains non-clean and emits distinct evidence/escalation failure |
| Concurrent retry deciders observe same timeout | any | after failure | at cap boundary | one terminal retry/escalation decision; no duplicate reviewer storm |

## Files in scope

- `plugins/ao-codex-pr-reviewer/**` - reviewer wrapper, parser/verdict integration,
  timeout classification, command-budget enforcement for reviewer-spawned checks, tests.
- `prompts/**` - reviewer prompt/rule text only if needed to express budget-aware local
  test policy. Prompt text is supporting scope, not the enforcement surface.
- `scripts/**` - review-start reconciliation/reeval/wake/claimed-review decision points,
  shared review-start claim lifecycle, or failure-evidence helpers where they already own
  reviewer run state or evidence.
- `tests/external-output-references/**` - capture/sample evidence for timeout/no-verdict
  artifacts if the implementation binds to external AO/Codex output.
- `docs/**` - focused operator-facing documentation and issue-draft verification notes.

## Files out of scope

- `vendor/**` and `packages/core/**`.
- Composio AO core reviewer internals.
- Rewriting #457's supervisor implementation or replacing its integration tests.
- Raising the hard timeout as the only fix.
- Changing CI required checks or GitHub branch protection.
- Worker-message delivery, review-finding delivery confirmation, or #287 liveness
  identity semantics except where referenced as prior-art boundaries.
- #315 implementation unless this draft explicitly waits for #315 or the worker adopts it
  as a prerequisite.

```denylist
vendor/**
packages/core/**
agent-orchestrator.yaml
.env
```

Scope boundary note: This denylist is scoped to `145-codex-reviewer-time-budget-and-timeout-escalation`.

```allowed-roots
plugins/ao-codex-pr-reviewer/**
prompts/**
scripts/**
tests/external-output-references/**
docs/**
```

## Acceptance criteria

1. **Effective budget is observable.** A fixture proves the reviewer path records the
   effective hard budget and any soft/test budget decision used for the run.

```producer-emission
producer: orchestrator-pack
datum: codex-reviewer.effectiveBudgetMs
selector: $.reviewer.effectiveBudgetMs
expected: present-positive-integer
proof-command: npm test -- ao-codex-pr-reviewer
```

2. **Slow/full-suite tests cannot consume the whole review, even if the model tries.** A PR
   #457-class fixture with slow supervisor tests proves an enforcement point outside the LLM
   turn prevents reviewer-spawned slow/full-suite commands from consuming the hard review
   budget. A prompt-only "do not run slow tests" implementation fails this criterion. The
   reviewer either runs budget-eligible targeted checks, skips/denies slow checks with a
   structured audit reason, or reaches the timeout/no-verdict path before the hard kill.

```producer-emission
producer: orchestrator-pack
datum: codex-reviewer.testBudgetDecision
selector: $.reviewer.testBudgetDecision
expected: skipped_or_denied_slow_test
proof-command: npm test -- ao-codex-pr-reviewer
```

3. **Timeout/no-verdict is distinct.** A fixture that simulates a reviewer killed before
   producing a verdict records a non-clean timeout/no-verdict outcome distinguishable from
   empty parse failure, malformed output, and normal findings.

```producer-emission
producer: orchestrator-pack
datum: codex-reviewer.failureClass
selector: $.reviewer.failureClass
expected: timeout_no_verdict
proof-command: npm test -- ao-codex-pr-reviewer
```

4. **Same-head repeated failures are bounded where reviews are launched.** Given repeated
   timeout/no-verdict failures for the same `(PR, head SHA, reviewer failure class)`, the
   reconcile/reeval/wake/claimed-review review-start decision path and shared claim lifecycle
   allow at most the configured policy retry, then emit an operator-visible escalation with no
   automatic same-head retry. A plugin-only counter that still lets the trigger layer launch
   another `ao review run` fails this criterion.

```producer-emission
producer: orchestrator-pack
datum: codex-reviewer.escalationReason
selector: $.reviewer.escalationReason
expected: repeated_timeout_no_verdict
proof-command: npm test -- ao-codex-pr-reviewer
```

5. **Prior-art fail-closed boundaries remain intact.** Existing empty-output, legacy prose,
   malformed JSON, findings JSON, and `NO_FINDINGS` tests continue to pass; empty output
   never becomes clean. A provably dead reviewer process still follows #287. Timeout evidence
   relies only on shipped #312 behavior unless #315 lands first.
6. **Scenario matrix coverage.** Each row in the full-class scenario matrix above has a
   fixture or explicit assertion in reviewer/reconcile tests.
7. **Evidence is redacted and bounded.** Timeout/no-verdict evidence inherits shipped #312
   evidence bounds. If the implementation depends on #315's stronger cookie redaction or
   configurable summary tail limit, #315 must be closed first; otherwise no raw tokens,
   cookies, auth headers, or environment dumps may be added beyond #312's current guarantee.
8. **Decomposition remains allowed.** If the implementer finds exec-level test budgeting and
   review-start retry escalation are independently shippable, they may land them as two
   ordered PRs/issues so long as the first slice does not claim the whole class is closed.

```positive-outcome
asserts: on a PR #457-class review where Codex reads a large diff and attempts to run slow supervisor tests that would otherwise consume the 600s hard limit, an exec-level reviewer budget guard prevents the test command from exhausting the review and the run finishes with either a normal verdict or a structured timeout_no_verdict escalation record; repeated same-head timeout_no_verdict failures are stopped at the review-start decision layer rather than retried indefinitely
input: realistic
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:codex-reviewer.effectiveBudgetMs
binding-type: structured
binding: reviewer run evidence records the effective wall-clock review budget
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
selector: $.reviewer.effectiveBudgetMs
expected: present-positive-integer

binding-id: orchestrator-pack:codex-reviewer.failureClass
binding-type: structured
binding: reviewer timeout before verdict is classified distinctly from parser failure
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
selector: $.reviewer.failureClass
expected: timeout_no_verdict

binding-id: orchestrator-pack:codex-reviewer.testBudgetDecision
binding-type: structured
binding: reviewer slow/full-suite test command is skipped or denied by an enforced budget decision
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
selector: $.reviewer.testBudgetDecision
expected: skipped_or_denied_slow_test

binding-id: orchestrator-pack:codex-reviewer.escalationReason
binding-type: structured
binding: repeated same-head timeout/no-verdict failures emit a bounded escalation reason
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
selector: $.reviewer.escalationReason
expected: repeated_timeout_no_verdict
```

## Upgrade-safety check

- No edits to `vendor/**`, `packages/core/**`, or Composio AO core.
- Empty-output fail-closed behavior from #9 remains unchanged.
- Failed/cancelled review runs still do not count as head coverage per #60/#189.
- #287 liveness recovery remains the owner for provably dead or ambiguous reviewer
  process identity outside the normal timeout path.
- CI remains the exhaustive test executor; reviewer local checks stay opportunistic and
  budget-aware.
- Prompt-only reviewer instructions are not accepted as a safety boundary for autonomous
  test execution.

## Verification

- `npm test -- ao-codex-pr-reviewer`
- Targeted reviewer timeout/no-verdict fixture tests covering every scenario-matrix row.
- Fixture proving prompt-only slow-test guidance is insufficient and the exec-level guard
  enforces the budget when the model attempts a slow/full-suite command anyway.
- Review-start trigger/claim lifecycle fixture proving repeated same-head timeout/no-verdict
  failures escalate at the launch decision layer across reconcile/reeval/wake/claimed-review
  surfaces.
- Existing parser/verdict tests for empty output, malformed output, findings, and
  `NO_FINDINGS`.
- Failure-evidence tests proving timeout/no-verdict evidence stays within shipped #312
  redaction/bounds, plus #315-specific tests only if #315 lands first.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/145-codex-reviewer-time-budget-and-timeout-escalation.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/145-codex-reviewer-time-budget-and-timeout-escalation.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Source verification

- Incident PR: #457, head `02fb66cc6455d8d76e8b4185fdb09f94a0e58870`.
- Failed reviewer runs: `opk-rev-965`, `opk-rev-966`, `opk-rev-969`.
- Verification report:
  `docs/investigations/TASK-457-review-empty-output-timeout-verification-report.md`.
