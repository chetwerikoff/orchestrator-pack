# Worktree gate and claim completion must share one review-start ownership contract

GitHub Issue: #454

## Prerequisite

- `docs/issues_drafts/100-review-start-claim-atomic-single-winner.md` (GitHub #308, closed) - context: atomic per `(PR, head)` single-winner claim acquisition. This issue does not reimplement acquisition.
- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub #318, closed) - autonomous LLM review-start must use the claimed entry point before invoking `ao review run`. Already does: makes the orchestrator-claimed runner the lifecycle owner that completes the claim after the run returns.
- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub #324, closed) - context: autonomous process-boundary shims deny raw `ao review run` and mutating git while preserving AO-owned reviewer workspace setup.
- `docs/issues_drafts/129-review-start-claim-liveness-reaper.md` (GitHub #417, closed; PR #427 merged 2026-06-24) - review-start claim lifecycle, liveness reaper, launch-pending, and post-run completion semantics are already on main. Already does: defines post-run completion as mandatory and uses terminal outcomes/audit to distinguish successful run start from ambiguous visibility.
- `docs/issues_drafts/133-autonomous-review-worktree-git-provenance.md` (GitHub #429, closed / PR #446 merged) - claim-bound allow + canonical workspace path hardening for AO-owned `git worktree add --detach`. Already does: consumes the active review-start claim as `worktree_allow_consumed` to make the worktree gate idempotent.

**Prior-art verdict:** **New follow-up draft, not another #429 implementation detail.** The shipped #429 gate and shipped #318 claimed runner now both terminalize the same review-start claim. This is a post-merge ownership conflict between two contracts, not the original worktree-provenance build. Keep the #429 draft as prior art and ship this as a single-PR lifecycle/ownership fix.

## Verification Report

Independently re-verified against the live tree on 2026-06-25:

1. **Gate terminalizes the active claim - confirmed.** The autonomous worktree gate looks up a live active claim by the explicit worktree-add commit SHA, then moves the active claim to a terminal record with outcome `worktree_allow_consumed`. The move removes the active path, so the original `ClaimResult.path` no longer exists after allow.
2. **Post-run completion expects the claim still active - confirmed.** The orchestrator-claimed runner invokes `ao review run`, then calls post-run claim completion with the original claim result. That completion reads `ClaimResult.path`, attempts `run_started`, and returns `ambiguous_claim` when the active path is gone. The caller logs `ESCALATE claim completion ... reason=ambiguous_claim` but still returns `started=true`.
3. **Impact is observability/provenance, not review correctness - confirmed.** The review run has already been invoked and the runner reports `started=true`; the claim is not leaked because it is already terminal as `worktree_allow_consumed`; replay of another worktree allow on the same active claim is denied because the active record disappeared. What is lost is the successful post-run `run_started` terminal outcome and the `post_run_invoke` / post-run visibility audit trail used by lifecycle diagnostics. Reclaim/reaper logic consults those audits only for active claims; a terminal consumed claim is not rearmed by that path. The `ESCALATE claim completion ... reason=ambiguous_claim` path is only a log line today: no pack automation currently reacts to that claim-completion `ESCALATE` / `escalated_ambiguous` signal. Severity is therefore **P2**: noisy happy-path escalation and lost provenance, not a duplicate run or failed review.
4. **Unconfirmed premise measured - confirmed for the installed AO path.** Installed AO 0.9.5 prepares reviewer workspaces by creating `code-reviews/workspaces/<reviewerSessionId>` and running `git worktree add --detach <workspacePath> <ref>`, where `<ref>` is the review run's `targetSha` when present. The claimed runner acquires the review-start claim for the same head SHA before `ao review run`, and stores review runs with that target SHA. Under the autonomous surface, that AO-created git process flows through the pack git shim/worktree gate. Current local tests cover the shim and fixture form; the optional real-`ao review run` smoke is skipped, so this draft also requires an explicit seam fixture.
5. **Coverage gap - confirmed.** Existing post-run completion tests exercise completion while the active claim still exists. Existing worktree-gate tests cover allow, deny, and replay after consume. No test covers the sequence: claimed runner acquires claim -> worktree gate consumes/annotates/serves it -> post-run completion runs -> no spurious claim-completion escalation.

## Goal

Successful gated autonomous review-start must have exactly one owner for review-start claim terminalization. When AO-owned reviewer workspace setup passes the worktree gate and the subsequent `ao review run` is successfully invoked for the claimed head, post-run completion must finish with a `run_started`-equivalent audit trail and no false `ESCALATE`, while the worktree gate remains idempotent and cannot authorize a second worktree add for the same active claim/head.

```behavior-kind
action-producing
```

## Binding surface

- **Ownership contract:** The worktree gate and the claimed review-run lifecycle must not both terminalize the same active review-start claim on the successful path. The final design must name one terminalization owner for successful run start and make the other participant idempotent around that owner.
- **Successful path invariant:** A claimed autonomous review that acquires a review-start claim, authorizes one AO-owned reviewer workspace worktree add for that same head, and successfully returns from `ao review run` produces a `run_started`-equivalent terminal/audit trail and no claim-completion `ESCALATE`.
- **Idempotent worktree authorization:** The first permitted AO-owned worktree add for a claim/head may proceed; a second authorization attempt for the same claim/head is denied or treated as an already-consumed no-op before the real git mutation. Idempotency must not rely on losing the lifecycle owner's ability to complete the claim.
- **Sanctioned foreign-write annotation:** If the chosen design records worktree consumption on the active claim, the worktree gate is a sanctioned foreign writer: it runs in an AO reviewer/git child process with a different `processGuid` than the orchestrator-claimed holder. The gate may update only its consume/idempotency annotation under the claim mutex, must preserve holder identity and existing launch-pending/visibility fields, and must leave the record acceptable to lifecycle mutations by the original holder.
- **Contention tolerance:** Lock contention between lifecycle writes and gate annotation must not turn the first legitimate same-head worktree add into a hard deny. The design must use bounded retry, lock ordering, or an equivalent deterministic resolution for annotation-vs-lifecycle contention; fail-closed behavior remains required for mismatched, stale, implicit, escaping, or path-invalid attempts.
- **No silent broadening:** Missing claim, stale/dead holder, wrong head SHA, implicit worktree-add commit, path escape, wrong project namespace, and pre-existing workspace behavior remain denied as in #429. This issue changes ownership/phase semantics, not the worktree allow envelope.
- **Observability:** Audit/terminal records must preserve enough provenance to answer: which claim authorized the worktree add, which run-start completion finalized the lifecycle, and whether the gate had already observed a worktree consume for that head.
- **Adoption caveat / urgency:** On the current Cursor orchestrator, if #318/#324 adoption is not active and the operator invokes raw `ao review run`, this seam is mostly dormant because the claimed lifecycle is not the live starter. Once the documented `agent-orchestrator.yaml.example` adoption is active (`AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`, pack `scripts/` before `ao`/`git`, and `scripts/invoke-orchestrator-claimed-review-run.ps1` for review starts), every successful gated autonomous review through the worktree gate exercises this seam. Severity is **P2**: no duplicate run or lost review, but false escalation and lost provenance on the happy path.
- **Durable spec-level fix:** Do not patch merged #446 code as a one-off. Ship the ownership contract, fixtures, and regression guard so future gate/lifecycle changes preserve it.

## Files in scope

- `scripts/**` - review-start claim lifecycle, autonomous worktree gate, claimed review-run wrapper, and tests/fixtures for the seam.
- `tests/external-output-references/**` - only if the planner adds or updates redacted captures.
- `docs/**` - issue/draft references or runbook notes only when needed for adoption caveat or audit semantics.

## Files out of scope

- AO core / vendored Composio packages.
- `agent-orchestrator.yaml` machine-local config.
- The original #429 path-hardening allow envelope, except where tests must prove no regression.
- Manual/operator raw `ao review run` behavior outside the autonomous claimed surface.
- New review-start acquisition policy; this issue starts after a claim is already acquired.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

Scope boundary note: This denylist is scoped to `141-worktree-gate-claim-completion-ownership`.

```allowed-roots
scripts/**
tests/external-output-references/**
docs/**
```

## Acceptance criteria

### Scenario matrix

| Claim state before worktree add | Worktree gate event | AO run result | Expected lifecycle outcome |
|---|---|---|---|
| active, live holder, matching head/path | first AO-owned add for claimed head | success + covering run visible | one `run_started`-equivalent terminal/audit; no `ambiguous_claim`; no `ESCALATE` |
| active, live holder, matching head/path | first add while gate annotates as sanctioned foreign writer | success + covering run visible | holder identity and launch/visibility fields preserved; real holder can still complete |
| active, live holder, matching head/path | gate annotation contends with lifecycle write/mutex | pending first add | contention alone does not deny the first authorization; bounded retry/order resolves without duplicate mutation |
| active, live holder, matching head/path | first AO-owned add for claimed head | success, run not immediately visible | existing visibility-fence semantics still apply; no false escalation caused only by gate consumption |
| active, live holder, matching head/path | second add for same claim/head | any | second real git mutation denied or no-op; no duplicate authorization |
| missing / terminal / stale holder / wrong head / implicit commit | attempted add | any | deny unchanged from #429 |
| path escape / namespace mismatch / pre-existing workspace | attempted add | any | deny unchanged from #429 |
| run fails before/while invoking AO | gate may or may not have observed worktree add | failure | retry/release/failure semantics remain bounded; no active claim leak |
| concurrent same-head claimed starters | racing add/completion | any | single-winner claim invariant from #308 remains; no two successful automated starts |

1. **Positive seam fixture (AC#1):** A fixture exercises the full event order: acquired claim -> AO-owned worktree gate authorization for the same head -> post-run completion. Assert successful completion is `run_started`-equivalent, no `ambiguous_claim`, no false `ESCALATE`, and audit records preserve both worktree authorization and run-start provenance. The proof must include the foreign-writer shape: gate annotation preserves holder identity and launch/visibility fields, and the original holder still completes the claim. Use planner-chosen named fixtures; do not require a specific new test filename or test filter.

```producer-emission
producer: orchestrator-pack
datum: worktree-gate-claim-completion-seam
expected: run-started-no-escalate
proof-command: planner-chosen named AC#1 fixture
```

2. **Worktree idempotency retained (AC#2):** A same-claim/head replay of worktree authorization cannot perform a second real `git worktree add`. The proof must cover the selected ownership design, not only the old active-file-disappears behavior, and must include gate-annotation vs lifecycle-write contention where contention alone cannot deny the first legitimate worktree add. Use planner-chosen named fixtures; do not require a specific new test filename or test filter.

```producer-emission
producer: orchestrator-pack
datum: worktree-gate-claim-completion-seam
expected: replay-denied
proof-command: planner-chosen named AC#2 fixture
```

3. **Deny envelope unchanged (AC#3):** Missing claim, stale/dead holder, wrong head, implicit commit, path escape, namespace mismatch, and pre-existing workspace fixtures from #429 remain green. Existing regression proof should include `npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t claim-bound-worktree`.

```producer-emission
producer: orchestrator-pack
datum: worktree-gate-claim-completion-seam
expected: deny-envelope-unchanged
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t claim-bound-worktree
```

4. **Completion semantics unchanged outside the seam (AC#4):** Existing post-run visibility, run-not-visible fencing, run failure/release, reclaim, and reaper fixtures remain green. The fix must not treat every terminal claim as success; only the specifically authorized worktree-consumed state for the same claim/head may participate in successful completion. Existing lifecycle regression proof should include `npx vitest run scripts/review-start-claim.test.ts scripts/review-start-claim-lifecycle.test.ts scripts/orchestrator-claimed-review-run.test.ts`.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-completion
expected: lifecycle-regression-green
proof-command: npx vitest run scripts/review-start-claim.test.ts scripts/review-start-claim-lifecycle.test.ts scripts/orchestrator-claimed-review-run.test.ts
```

5. **Audit/provenance (AC#5):** The resulting records let an operator distinguish successful gated review start from `run_not_visible`, `released_for_retry`, stale recovery, or manual resolution. The happy path must not rely on an `ESCALATE` log as the only signal.

```positive-outcome
asserts: a claimed autonomous review-start whose AO-owned worktree add is authorized for the same head completes without `ambiguous_claim` escalation, records run-start-equivalent provenance, and still rejects a second worktree add for the same claim/head
input: realistic
```

```contract-evidence
binding-id: orchestrator-pack:worktree-gate-claim-completion-seam:run-started-no-escalate
binding-type: cli-behavior
binding: gate-authorized same-head reviewer worktree setup followed by successful claimed review-run completion does not produce ambiguous_claim or ESCALATE, records run-start-equivalent provenance, preserves holder identity, and preserves launch/visibility fields across sanctioned foreign-write annotation
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:worktree-gate-claim-completion-seam:replay-denied
binding-type: cli-behavior
binding: after one authorized worktree add for a claim/head, a second authorization attempt for the same claim/head cannot perform another real git worktree add, and annotation-vs-lifecycle contention does not deny the first legitimate authorization solely because the mutex is busy
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:worktree-gate-claim-completion-seam:deny-envelope-unchanged
binding-type: cli-behavior
binding: #429 negative worktree-gate cases remain denied
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:review-start-claim-completion:lifecycle-regression-green
binding-type: cli-behavior
binding: review-start claim completion/reaper/reclaim/failure visibility semantics remain green outside the worktree-consumed seam
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Upgrade-safety check

- No `vendor/**`, `packages/core/**`, or `.ao/**` edits.
- No new machine-local secrets or unsupported AO YAML schema.
- Keep the fix pack-side and upgrade-safe; AO core reviewer workspace behavior is treated as an upstream producer observed through CLI/process behavior.
- Do not remove #429 path hardening, explicit commit/head matching, or fail-closed parse behavior.

## Verification

- Run AC#1-AC#4 planner-chosen equivalent named fixtures. AC#3 and AC#4 should also keep the named existing regression commands listed above green.
- Run aggregate pack verification:

```powershell
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
```

## Decisions (design analysis)

### 1. Critical mechanics

- **State ownership:** one active review-start claim is currently read by two actors. The worktree gate wants a single-use authorization marker; the claimed runner wants to terminalize successful review start after `ao review run` returns.
- **Event ordering:** AO reviewer workspace setup happens inside `ao review run`; installed AO 0.9.5 creates the reviewer workspace with `git worktree add --detach <workspacePath> <run.targetSha>`. That child git invocation occurs after claim acquisition and before post-run completion.
- **Idempotency:** the gate needs a durable "worktree already authorized for this claim/head" fact to deny replay.
- **Foreign writer:** the gate runs in an AO reviewer/git child process, not the orchestrator-claimed holder process. Any active-claim annotation path must be explicitly permitted to write only the gate's consume marker while preserving holder identity and fields that the holder's lifecycle completion needs.
- **Mutex contention:** lifecycle writes such as launch-pending/visibility and gate consume annotation share the same `(PR, head)` claim surface. Busy-lock behavior must not convert a legitimate first worktree authorization into a deny; contention handling is part of the contract, not an implementation afterthought.
- **Audit:** successful review-start lifecycle expects a run-start outcome/audit. Terminalizing earlier as worktree-consumed loses that semantic unless completion recognizes or owns the final transition.

### 2. World practice

For state machines with multiple observers, the usual durable pattern is **single terminal owner + intermediate phase markers**. A gate can record "capability consumed" as an intermediate, idempotent state, while the lifecycle owner performs the final terminal transition after the side effect's outcome is known. Treating every terminal state as equivalent success is cheaper but weakens observability and makes future recovery rules harder to reason about.

### 3. Architecture sketch

```
claimed runner acquires active claim for (PR, head)
  -> AO review run starts
     -> AO reviewer workspace invokes git worktree add --detach <workspace> <head>
        -> worktree gate records/observes one consume for this claim/head
        -> second consume is refused
  -> AO review run returns
  -> claimed runner completes the claim as run_started-equivalent
```

### 4. Options

| Option | Cost | Risk | Sufficiency |
|---|---|---|---|
| **A. Completion recognizes `worktree_allow_consumed` terminal as success** | Lowest | Blurs worktree authorization with run-start completion; easy to mask run-not-visible/failure cases; weak audit unless extra records are added | Sufficient only for the false ESCALATE symptom |
| **B. Gate records a consumed/intermediate marker but leaves final terminalization to post-run completion** | Medium | Requires replay/idempotency to use the marker instead of active-file disappearance, and requires a sanctioned foreign-write annotation that preserves holder/launch/visibility fields with contention-tolerant locking | Best contract: one terminal owner, preserves `run_started` audit, keeps gate idempotent |
| **C. Split into two linked records: keep review-start claim lifecycle untouched and add separate worktree-consume token store** | Higher | More storage and cross-record drift; harder cleanup/reaper story | Sufficient but heavier than needed unless annotation cannot be made atomic |
| **D. Fold into #429 by documenting `worktree_allow_consumed` as the final successful outcome** | Low | Bakes the conflict into the spec and loses #318/#417 post-run semantics | Rejected; this is the bug class |

**Chosen direction:** **Option B unless implementation evidence proves annotation cannot be made atomic.** It is the cheapest sufficient executor with acceptable risk: the lifecycle owner remains responsible for terminalization, the gate keeps a durable replay guard, and the audit trail remains meaningful. Option C is the fallback if the active-claim format cannot safely carry a consume marker without widening races. Option A is acceptable only as a temporary mitigation, not the durable spec-level fix.

### 5. Full-class enumeration

The matrix in **Acceptance criteria** is the required fixture set. The class is not only "happy path consumed then completion": every state where the gate observes or records worktree consumption while another lifecycle owner expects to complete the same claim must have a defined outcome.
