# Optional autonomous orchestrator spawn policy toggles

GitHub Issue: #458

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md`
  (GitHub **#324**, shipped) - installed the autonomous orchestrator
  process-boundary deny for `ao spawn`, `ao spawn --claim-pr`, and mutating
  `git`, active only when `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`.
- `docs/issues_drafts/128-autonomous-bash-env-interposer-eval-hidden-defense.md`
  (GitHub **#406**, shipped) - hardened arming of the autonomous surface through
  the tmux-name bootstrap and PATH/interposer layer. Current live tree confirms
  the surface is armed by `scripts/autonomous-orchestrator-surface-bootstrap.sh`
  from `AO_TMUX_NAME=*orchestrator*`, not by `agentConfig.env`.
- Prior-art verdict: **extends shipped work**. This is not a new boundary
  mechanism; it narrows the #324 spawn deny into two explicit policy-controlled
  decisions while leaving the review-start, worker-send, and git gates intact.
- Policy change acknowledged: default-ON spawn privileges intentionally reverse
  the current #324/#97 default-deny posture for the spawn branch. This draft
  treats that as an operator policy decision, not an accidental relaxation.

## Goal

Make autonomous-orchestrator worker spawn access configurable through committed,
reviewable policy read by the process gate:

1. `allowSpawnNew` controls bare/new-work `ao spawn ...`.
2. `allowClaimPrResume` controls `ao spawn --claim-pr <PR>` resume/claim
   invocations after orchestrator restart or recovery.

Both toggles default **ON by explicit committed policy value**. Missing,
unreadable, or malformed policy must **fail closed** for the protected spawn
operation: deny with exit 93 and surface a clear policy-load reason. That keeps
"default ON" as an auditable repo state, not an accidental absence-of-file
fail-open.

```behavior-kind
action-producing
```

## Pre-draft design analysis

### Critical mechanics

- Current live `Test-AutonomousSpawnDenied` in
  `scripts/lib/Orchestrator-AutonomousBoundary.ps1` unconditionally denies
  `spawn` on the autonomous surface and has no config hook.
- `scripts/ao-autonomous-guard.ps1` calls `Test-AutonomousSpawnDenied` before
  the raw review-run and worker-send gates; a denied spawn exits 93 before
  reaching the real AO binary.
- Existing capability inventories are committed JSON under `docs/`, merged with
  `docs/autonomous-shared-capabilities.json` by
  `Get-MergedAutonomousCapabilityInventory`. Missing inventory currently throws;
  consumers do not silently allow on missing policy.
- `--claim-pr` is present in argv as an `ao spawn` flag. The split must classify
  claim-resume by parsing `spawn` argv flags, not by substring search over the
  full shell line.
- `ao session cleanup` is not process-denied and has no `orchestratorRules`
  prose ban. `ao session kill` remains prose-forbidden and out of scope.
- Live-tree prose split verified before this draft update: tracked
  `agent-orchestrator.yaml.example` already contains affirmative global spawn
  language ("Plan from open GitHub Issues, spawn coding workers..."). Its
  `never ao spawn` / `never --claim-pr` clauses are contextual review/CI/reconcile
  safety fences and must be preserved. The global "OPERATOR-GATED SPAWN -- do
  NOT plan/spawn" override exists in the local gitignored `agent-orchestrator.yaml`
  runtime file, so the implementation deliverable is operator adoption for that
  live file, not a tracked deletion of contextual `.example` fences.
- Known incident class: the PR #97/#324 worktree collision came from an
  orchestrator turn running `ao spawn --claim-pr` plus mutating `git branch -m`
  in the orchestrator worktree, parking the worker branch and killing the worker.
  Default-ON `allowClaimPrResume` must not silently revive that class.

### Common industry shape

Privileged automation is usually controlled through reviewed policy-as-code with
explicit defaults, fail-closed parse/load errors, narrow action classification,
and audit output for allowed privileged operations. Environment toggles are
weaker here because AO 0.9.x does not reliably propagate `agentConfig.env` into
the tmux shell where the guard runs.

### Architecture sketch

```text
orchestrator tmux shell
  -> BASH_ENV bootstrap sets AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1
  -> PATH resolves ao to scripts/ao
  -> scripts/ao-autonomous-guard.ps1
  -> Test-AutonomousSpawnDenied(argv)
       -> classify: spawn-new | claim-pr-resume | not-spawn
       -> read committed JSON policy + shared inventory pattern
       -> allow or deny exit 93
  -> real ao only when the classified action is allowed
```

### Options judged

1. **Committed JSON policy read by the spawn gate (chosen).** Cost: low-medium;
   reuses the existing inventory pattern and test harness. Risk: low if
   malformed/missing policy fails closed. Sufficiency: full for operator-visible
   policy and process-boundary enforcement.
2. **Environment flags.** Cost: low, but risk high in this repo because the exact
   surface exists due to AO 0.9.x env propagation gaps. Insufficient: the gate
   may not see the operator's intended value.
3. **Prose-only `orchestratorRules` change.** Cost: very low, but already proven
   insufficient by the #324/#97 incident class. Rejected.
4. **AO core permission model or upstream change.** Cost and lead time high,
   requires changing or waiting on Composio AO core. Not the cheapest sufficient
   executor for this pack.

### Decomposition fallback

The cheapest sufficient target is one implementation that ships both toggles
with AC#5 satisfied. If proving AO-level `--claim-pr` serialization, internal-git
provenance, and concurrent duplicate-resume behavior is not cheap enough for the
same worker slice, split rather than stall: ship the policy reader, fail-closed
loading, `allowSpawnNew`, and prose/operator adoption, but do not claim this
issue has satisfied `allowClaimPrResume` unless the committed default remains
explicitly ON and the runtime gate still applies a cleanup-first plus
duplicate-resume-safe precondition. An OFF-by-policy override for
`allowClaimPrResume` is a scope split/follow-up, not an accepted implementation
of this default-ON issue. Do not ship blind default-ON claim-pr resume without
AC#5 or an explicit amended scope that keeps the unsafe path closed.

### Scenario enumeration

- `allowSpawnNew=true`, `allowClaimPrResume=true`: both classified spawn shapes
  pass on the autonomous surface; review-run/send/git gates remain unchanged.
- `allowSpawnNew=false`, `allowClaimPrResume=true`: bare/new-work spawn denies
  exit 93; `spawn --claim-pr <PR>` may pass only after classification as
  claim-resume.
- `allowSpawnNew=true`, `allowClaimPrResume=false`: bare spawn may pass;
  `--claim-pr` denies exit 93.
- Both false: current spawn-deny behavior is preserved.
- Missing/unreadable/malformed policy: protected spawn denies exit 93 regardless
  of desired default values.
- Manual or worker session without `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`:
  unchanged pass-through behavior.
- `--claim-pr` variants: flag before or after other spawn args, with value as
  next token or an accepted `--claim-pr=<PR>` spelling if AO accepts that shape,
  must classify as claim-resume. Bare spawn must not be misclassified by issue or
  branch names containing the text `claim-pr`.
- Claim-pr resume while an old worker/session/worktree is still alive: do not
  assume downstream AO refuses the duplicate. The implementation must prove one
  of the safe outcomes: AO serializes/refuses duplicate `--claim-pr` against a
  live/healthy owner, or the pack-side resume gate requires cleanup-first (or an
  equivalent observable no-live-owner precondition) before permitting
  `allowClaimPrResume=true` to reach real `ao`.
- Internal git during `ao spawn --claim-pr`: #324's mutating-git deny remains a
  partial mitigation only if the real AO child process still resolves through the
  pack git guard. The worker must verify whether AO's internal git uses a
  sanctioned provenance such as `AO_AUTONOMOUS_GIT_INTERNAL_EXEC` or is denied by
  the guard; the draft must not rely on an unverified internal-git path.
- Duplicate orchestrator surfaces after restart: exactly one resume attempt may
  win, or both must converge to a refusal/cleanup-required result. A policy toggle
  must not become a race-amplifier for two workers on one PR/worktree.
- Toggle changed mid-flight: each guard invocation reads a coherent policy
  snapshot for that command. Already-started workers are not retroactively killed
  when a toggle flips OFF.
- Cleanup/kill: cleanup remains available because there is no new cleanup gate;
  kill remains prose-forbidden and must not be relaxed.

## Binding surface

- The autonomous `ao spawn` gate reads a committed JSON policy file, following
  the existing autonomous capability-inventory merge/read pattern instead of env
  flags.
- The spawn decision is split into two independent semantic policy capabilities:
  `allowSpawnNew` and `allowClaimPrResume`. `allowClaimPrResume=true` means
  policy-eligible, not "blindly bypass duplicate-session/worktree safety."
- Default ON is represented by committed `true` values for both toggles.
- Policy file absence, parse error, unreadable file, unknown required schema, or
  non-boolean toggle value denies the protected spawn action with an explicit
  reason. This is the safe fail-closed nuance for the default-ON policy.
- Tracked `agent-orchestrator.yaml.example` contextual safety clauses for
  review/CI/reconcile paths must remain intact. The worker must not remove
  `never ao spawn` / `never --claim-pr` text from those per-path fences to satisfy
  a broad grep.
- Operator adoption is first-class: the implementation must provide explicit
  adoption instructions for the local gitignored `agent-orchestrator.yaml` global
  OPERATOR-GATED-SPAWN override. Until that live override is replaced with
  policy-driven wording, the JSON process gate may allow spawn but the runtime
  orchestrator prose still tells the model never to spawn, so the feature is not
  observable in normal operation.
- A policy-permitted autonomous spawn should emit an audit-visible line (stderr,
  event, or repo-standard log chosen by the implementer) that names the
  classified action and policy decision without leaking secrets.

## Files in scope

- `scripts/` - autonomous AO guard, boundary helper, policy reader, tests, and
  any existing capability inventory checker needed for this policy.
- `docs/` - committed autonomous spawn policy/capability inventory and this
  issue draft.
- `agent-orchestrator.yaml.example` and committed prompt/config source text -
  preserve contextual review/CI/reconcile lifecycle fences; update only if a
  tracked global spawn-policy pointer is actually present.
- the repo's existing operator-adoption/runbook surface - exact operator step
  for updating the live gitignored `agent-orchestrator.yaml` global spawn
  override.

## Files out of scope

- Review-start gate behavior.
- Raw worker-send / nudge gate behavior.
- Mutating git gate behavior.
- AO core or vendored Composio packages.
- New process gate for `ao session cleanup`.
- Relaxing, gating, or reimplementing `ao session kill`.
- Committing the local gitignored `agent-orchestrator.yaml`.
- Removing contextual review/CI/reconcile `never ao spawn` / `never --claim-pr`
  safety clauses from `agent-orchestrator.yaml.example`.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `143-orchestrator-spawn-policy-toggles`.

## Acceptance criteria

1. **Policy file and fail-closed loading:** a committed JSON policy exists with
   explicit default values equivalent to `allowSpawnNew=true` and
   `allowClaimPrResume=true`. On autonomous surface, missing/unreadable/malformed
   policy or non-boolean toggle values deny the classified spawn action with
   exit 93 and a reason naming policy load/validation.

```producer-emission
producer: orchestrator-pack
datum: autonomous-spawn-policy-load
expected: explicit-default-on-and-fail-closed-on-load-error
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t "spawn policy"
```

2. **Independent action split:** on autonomous surface, bare/new-work `ao spawn`
   is policy-allowed iff `allowSpawnNew`; `ao spawn --claim-pr <PR>` is
   policy-eligible iff `allowClaimPrResume` and the claim-pr resume safety
   criterion below is satisfied. The matrix covers true/false combinations
   independently.

```producer-emission
producer: orchestrator-pack
datum: autonomous-spawn-policy-matrix
expected: independent-toggles
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t "spawn policy matrix"
```

3. **Robust `--claim-pr` classification:** tests cover accepted argv spellings
   and ordering for claim-pr resume, plus negative controls where a bare spawn
   target merely contains `claim-pr` text. Misclassification must not allow the
   wrong capability.

```producer-emission
producer: orchestrator-pack
datum: autonomous-spawn-claim-pr-classification
expected: robust
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t "claim-pr classification"
```

4. **Surface scoping unchanged:** manual/operator and worker sessions without
   `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1` continue to pass through `ao spawn`
   and `ao spawn --claim-pr` as before. Review-run, worker-send, and git gates
   still enforce their existing contracts.

```producer-emission
producer: orchestrator-pack
datum: autonomous-spawn-surface-scoping-regression
expected: unchanged
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts scripts/autonomous-orchestrator-interposer.test.ts -t "spawn policy|review run|worker send|tree-mutating git|allow matrix"
```

5. **Claim-pr resume collision safety:** `allowClaimPrResume=true` does not
   permit a blind duplicate worker/worktree claim. The worker proves one safe
   path with automated fixture or redacted local capture:
   - AO refuses/serializes `ao spawn --claim-pr <PR>` when a live healthy worker
     or existing worktree already owns the PR; or
   - the pack gate refuses claim-pr resume with a cleanup-required/no-live-owner
     reason until `ao session cleanup` or equivalent observable cleanup has made
     the old owner/worktree safe to replace.

   Indeterminate ownership/liveness is treated as occupied: if the old owner,
   session, claim, or worktree state cannot be established, claim-pr resume must
   deny or return cleanup-required and must not reach real AO.

   Concurrent restart race is part of the same AC: two autonomous surfaces trying
   `ao spawn --claim-pr <PR>` for the same PR before either new owner/worktree is
   visible must not both reach real AO. The proof must show either AO-level
   serialization, or a pack-side single-flight/claim-before-spawn guard where one
   attempt wins and the loser gets an explicit already-owned/in-progress refusal.
   A cleanup-first precondition alone is insufficient unless it is paired with
   that concurrency fence.

   This proof must also state what happens to internal git during allowed
   `ao spawn --claim-pr`: whether #324's git guard denies it, or whether AO uses
   sanctioned internal provenance. The old incident class (`claim-pr` plus
   mutating `git branch -m` in the orchestrator worktree) must be covered by the
   proof, not waved to an assumed downstream refusal.

```producer-emission
producer: orchestrator-pack
datum: autonomous-spawn-claim-pr-collision-safety
expected: safe-or-cleanup-required
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts scripts/autonomous-orchestrator-interposer.test.ts -t "claim-pr collision|cleanup-required|duplicate resume|internal git"
```

6. **Operator adoption and prose targeting:** the implementation does not delete
   contextual review/CI/reconcile safety clauses from
   `agent-orchestrator.yaml.example`. It instead adds a tracked operator-adoption
   step for the live gitignored `agent-orchestrator.yaml`: replace the global
   OPERATOR-GATED-SPAWN override with policy-driven wording so the runtime model
   may spawn only according to the committed spawn policy. The adoption proof
   distinguishes:
   - tracked `.example` global stance is already spawn-positive and keeps
     per-path `never ao spawn` / `never --claim-pr` fences;
   - local live `agent-orchestrator.yaml` may still need operator adoption and is
     not committed;
   - `ao session kill`, raw worker-send, raw review-run, and mutating git prose
     remain forbidden where currently scoped.

```producer-emission
producer: orchestrator-pack
datum: autonomous-spawn-operator-adoption
expected: documented-and-preserves-per-path-fences
proof-command: npx vitest run -t "operator adoption|per-path fences|spawn policy adoption"
```

7. **Audit:** a policy-permitted autonomous spawn produces an operator-visible
   audit line naming `spawn-new` or `claim-pr-resume` and the policy decision.
   Denied cases keep exit 93 and explanatory stderr.

```producer-emission
producer: orchestrator-pack
datum: autonomous-spawn-policy-audit
expected: emitted
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t "spawn policy audit"
```

8. **Old invariant tests updated:** tests that currently assert "spawn always
   denied" on autonomous surface are rewritten into policy-matrix tests, including
   `scripts/autonomous-orchestrator-boundary.test.ts` and
   `scripts/autonomous-orchestrator-interposer.test.ts`. Tests for unrelated
   forbidden command envelopes that deliberately ban worker lifecycle actions
   remain scoped to those envelopes and are not globally relaxed.

```positive-outcome
asserts: on autonomous surface with committed policy true/true, bare ao spawn reaches the downstream AO stub and ao spawn --claim-pr reaches it only when claim-pr collision safety is proven or cleanup-required precondition is satisfied; with either toggle false or malformed policy, only the matching protected action denies exit 93; manual surface pass-through and review-run/send/git denies are unchanged; operator adoption instructions replace the live global spawn ban without removing tracked per-path review/CI fences
input: realistic
```

```contract-evidence
binding-id: orchestrator-pack:autonomous-spawn-policy-load:explicit-default-on-and-fail-closed-on-load-error
binding-type: cli-behavior
binding: committed policy true true allows bare spawn and makes claim-pr policy-eligible only subject to AC#5 collision safety, while missing unreadable malformed or non-boolean policy denies protected spawn exit 93
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:autonomous-spawn-policy-matrix:independent-toggles
binding-type: cli-behavior
binding: allowSpawnNew controls bare spawn and allowClaimPrResume controls spawn claim-pr independently on autonomous surface
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:autonomous-spawn-claim-pr-classification:robust
binding-type: cli-behavior
binding: argv parsing classifies claim-pr resume only from accepted claim-pr flag spellings and does not substring-match bare spawn targets
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:autonomous-spawn-surface-scoping-regression:unchanged
binding-type: cli-behavior
binding: manual and worker surface spawn pass-through plus review-run worker-send and git gates remain unchanged
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:autonomous-spawn-claim-pr-collision-safety:safe-or-cleanup-required
binding-type: cli-behavior
binding: claim-pr resume either refuses serializes duplicate live owner or requires cleanup first with indeterminate liveness treated as occupied and a concurrent duplicate-resume fence, and internal git behavior under allowed claim-pr is verified against the #324 git gate
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:autonomous-spawn-operator-adoption:documented-and-preserves-per-path-fences
binding-type: config-behavior
binding: operator adoption documents live gitignored yaml global override replacement while preserving tracked contextual review CI reconcile lifecycle fences
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)

binding-id: orchestrator-pack:autonomous-spawn-policy-audit:emitted
binding-type: cli-behavior
binding: allowed autonomous spawn emits operator-visible audit with classified action and policy decision
producer: orchestrator-pack
evidence: NEW(produced-by AC#7)
```

## Upgrade-safety check

- No edits to `vendor/**`, `packages/core/**`, or Composio AO core.
- Policy source is committed JSON read from disk by the gate, so it survives the
  current `agentConfig.env` propagation gap.
- The failure mode for absent policy is deny, not accidental allow.
- The change is limited to spawn/claim-pr process-gate behavior and prose that
  describes that behavior.

## Verification

- `npx vitest run scripts/autonomous-orchestrator-boundary.test.ts`
- `npx vitest run scripts/autonomous-orchestrator-interposer.test.ts`
- Any existing autonomous capability inventory checker updated or added for the
  new spawn policy inventory.
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Contract evidence gathered for this draft

- `Test-AutonomousSpawnDenied` currently returns
  `autonomous_spawn_denied` unconditionally for subcommand `spawn` when the
  autonomous surface is active; no config hook exists.
- Confirmed call site: `scripts/ao-autonomous-guard.ps1` invokes
  `Test-AutonomousSpawnDenied -Argv $args` before review-run/send gates and exits
  93 on deny.
- Current tests encode the old invariant: examples include
  `scripts/autonomous-orchestrator-boundary.test.ts` "denies autonomous spawn
  across command spellings" and "scripts/ao shim denies spawn --claim-pr on
  autonomous surface", plus multiple interposer tests expecting `ao spawn` to
  exit 93.
- Existing JSON inventory merge throws on missing per-gate inventory and merges
  `docs/autonomous-shared-capabilities.json`; this supports fail-closed policy
  load semantics rather than absence-as-allow.
- `ao session cleanup` was not found as a process-level deny and appears only
  descriptively in local `agent-orchestrator.yaml`; `ao session kill` remains in
  the forbidden prose. The tracked config source to edit is
  `agent-orchestrator.yaml.example`, not the local runtime file.
- `scripts/autonomous-orchestrator-surface-bootstrap.sh` confirms delivery
  channel: tmux name `*orchestrator*` sets
  `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`, prepends pack `scripts/`, and sources
  the tracked interposer; the gate reads repo files at runtime from that path.
