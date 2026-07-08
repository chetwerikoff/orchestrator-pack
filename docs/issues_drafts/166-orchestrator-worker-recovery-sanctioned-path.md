# Autonomous orchestrator worker recovery needs a sanctioned worktree cleanup path

GitHub Issue: #522

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub #324, closed) - shipped the autonomous process-boundary deny for `ao spawn` and tree-mutating git. This draft narrows that boundary only for a probed worker-recovery path; it must not reopen arbitrary `branch`, `checkout`, `switch`, `worktree add`, or raw mutating git.
- `docs/issues_drafts/143-orchestrator-spawn-policy-toggles.md` (GitHub #458, closed) - shipped committed, fail-closed spawn policy with `allowSpawnNew` and `allowClaimPrResume`; both are currently enabled in `docs/autonomous-spawn-policy.json`. This draft reuses that policy instead of adding a second spawn permission model.
- `docs/issues_drafts/82-session-runtime-liveness-contract-satisfiable.md` (GitHub #250, closed) - shipped the shared session-runtime liveness rule for AO status rows, including affirmative death for terminal runtime/status values and fail-closed handling of present non-live runtime values. This draft reuses that liveness contract for orphan-vs-live discrimination.
- `docs/issues_drafts/34-review-layer-resilience-after-worker-respawn.md` (GitHub #98, closed) - shipped review-layer resilience after a worker respawn. This draft owns only the git-boundary cleanup and sanctioned spawn/resume path that lets the worker exist again; review-run hygiene remains #98.
- `docs/issues_drafts/15-orchestrator-recovery-runbook.md` (GitHub #40, closed) - shipped the manual operator recovery runbook. This draft introduces the sanctioned primitive that the runbook and orchestrator can invoke, without copying the runbook prose.
- `docs/issues_drafts/148-autonomous-spawn-worktree-git-provenance.md` (GitHub #470, closed), `docs/issues_drafts/149-spawn-grant-worktree-name-binding.md` (GitHub #472, closed), and `docs/issues_drafts/157-spawn-grant-head-ref-oid-binding.md` (GitHub #493, closed) - shipped spawn-grant provenance for worker `worktree add`, session/worktree-name binding, and head-ref OID binding. They intentionally do not authorize `worktree prune` or `worktree remove`.
- `docs/issues_drafts/89-worker-message-delivery-confirmed-consumption.md` (GitHub #373, closed) - shipped the source-agnostic delivery/fence/escalation pattern this recovery path must not bypass or fork when it escalates repeated failures.
- `docs/issues_drafts/162-spawn-grant-repository-identity-binding.md` (GitHub #511, open) - current planned fix for repository-identity binding across linked worktrees. This draft must either depend on #511 or prove that recovery-spawn runs from pack root so the existing grant path no longer hits `repository_root_mismatch`.

## Goal

Give the autonomous orchestrator one narrow, auditable worker-recovery path that can enumerate dead worker worktrees, clean up only worktrees proven orphaned or tied to terminated sessions, and then re-spawn or claim-pr-resume through the existing spawn policy and grant gate without using `SURFACE=0`, PATH escapes, or raw git.

```behavior-kind
action-producing
```

## Binding surface

- Read-only `git worktree list` and `git worktree list --porcelain` are classified as non-mutating on the autonomous surface. `worktree add`, `worktree remove`, `worktree prune`, `worktree move`, and other mutating worktree subcommands remain denied outside sanctioned provenance.
- The pack exposes one sanctioned worker-recovery primitive for the autonomous orchestrator. It may be admitted as a blessed parent for the minimum git child operations needed for recovery, but only when the primitive itself has selected a bounded candidate set through the liveness and ownership checks below.
- There is one public recovery command/API surface. Script, plugin, reconcile, and operator-requested paths may wrap it, but tests must prove they delegate to the same primitive, claim validation, and audit lifecycle.
- The recovery primitive reuses #250 session-runtime liveness. A live or ambiguous worker is never force-removed. Only a dangling gitdir orphan or a worktree tied to an affirmatively terminated session may proceed to cleanup.
- Cleanup eligibility requires positive pack/AO ownership evidence for the worktree or gitdir record. Absence of a live AO row is never sufficient by itself; missing, foreign, stale, or conflicting ownership evidence is ambiguous and skips destructive cleanup.
- A terminated session is not automatically disposable. Before `worktree remove --force`, recovery must inspect for uncommitted, untracked, ignored-but-relevant, or unpushed work and either preserve it or skip removal with an operator-visible blocked audit. The planner owns the preservation mechanism.
- `git worktree prune` is out of scope for the sanctioned recovery primitive because it is repo-wide. Recovery may use only candidate-scoped cleanup such as `git worktree remove --force <selected-path>` after the gates in this draft pass.
- Cleanup and respawn are one claim-before-act lifecycle. The primitive records a durable recovery attempt before destructive work, takes a per-worker or per-PR recovery claim before mutation, skips when another recovery/reconcile actor holds the claim, and leaves a re-runnable signal on partial failure. The lifecycle must be ordered and crash-safe: claim acquired -> intent/audit persisted -> post-claim revalidation -> cleanup -> respawn/resume -> final state.
- Recovery state, lock, preserved-artifact records, and audit records live in one declared machine-local project state namespace shared by reconcile and operator-invoked recovery, outside all repo denylisted/generated runtime directories (`.ao/**`, `.agent-orchestrator/**`, `vendor/**`, `packages/core/**`, `node_modules/**`). The namespace identity and lock key derivation are part of the public contract so all entrypoints share the same duplicate-prevention view.
- The blessed-parent path is not a script-name-only allow. Cleanup git children must be tied to the recovery claim and selected candidate set; direct invocation with arbitrary candidate paths must fail closed.
- Path comparisons and cleanup targets must be realpath/canonical-path checked on the runtime where the orchestrator lives. This draft does not require a Windows/junction/case-insensitive matrix unless the implementation expands the recovery surface to those hosts.
- Respawn and claim-pr-resume route through #458 policy and the existing spawn grant path. This issue must not introduce a second spawn permission, broaden cross-repo grants, or bypass #511 repository-identity binding.
- Before respawn or claim-pr-resume, recovery checks local AO ownership/task mapping first. A live or different owner blocks respawn; the same affirmatively dead owner covered by the active recovery claim does not. GitHub REST may refine stale/closed/merged decisions when available, but REST unavailability or rate limiting must not by itself block recovery of a locally-owned dead worker.
- Recovery retries are bounded. Repeated cleanup/spawn failures use backoff and converge to operator-visible escalation instead of an unbounded retry storm.
- The autonomous trigger is explicit: recovery may run only for operator-requested spawn/recover, or for a reconcile classification that has positive dead-worker evidence and no live owner. Plain `Stuck` without the #250/probed-dead evidence is not enough.
- Operator-requested spawn uses the same sanctioned path when it needs worker recovery, so manual LLM turns and reconcile ticks do not learn separate cleanup recipes.
- The self-clearable `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=0` window is explicitly out of scope. This draft enables a legal path; it does not harden that deferred escape surface.

```contract-evidence
binding-id: orchestrator-pack:worker-recovery:readonly-worktree-list
binding-type: cli-behavior
binding: autonomous boundary allows git worktree list and list --porcelain as read-only while preserving mutating worktree denies
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:worker-recovery:sanctioned-cleanup-parent
binding-type: cli-behavior
binding: worker recovery primitive is the only sanctioned parent for candidate-scoped worktree remove
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:worker-recovery:liveness-discrimination
binding-type: structured
binding: recovery cleanup acts only on dangling gitdir or affirmatively terminated sessions and fails closed on live or ambiguous sessions
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:worker-recovery:claim-lock-idempotency
binding-type: structured
binding: recovery attempts use a durable claim/lock lifecycle with re-runnable partial-failure state
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:worker-recovery:policy-routed-respawn
binding-type: cli-behavior
binding: respawn and claim-pr-resume from recovery route through existing spawn policy and grant checks
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)

binding-id: orchestrator-pack:worker-recovery:post-claim-revalidation
binding-type: structured
binding: recovery revalidates candidate identity after claim and before destructive cleanup
producer: orchestrator-pack
evidence: NEW(produced-by AC#10)

binding-id: orchestrator-pack:worker-recovery:artifact-preservation
binding-type: structured
binding: dirty worktree and local artifacts are preserved or block force removal
producer: orchestrator-pack
evidence: NEW(produced-by AC#13)

binding-id: orchestrator-pack:worker-recovery:spawn-freshness
binding-type: cli-behavior
binding: recovery respawn uses local AO ownership first and treats GitHub REST as optional stale-state refinement
producer: orchestrator-pack
evidence: NEW(produced-by AC#15)

binding-id: orchestrator-pack:worker-recovery:bounded-retry-escalation
binding-type: structured
binding: recovery retries are bounded and escalate visibly instead of storming
producer: orchestrator-pack
evidence: NEW(produced-by AC#16)

binding-id: orchestrator-pack:worker-recovery:trigger-admission
binding-type: structured
binding: autonomous recovery trigger requires operator request or probed-dead reconcile classification
producer: orchestrator-pack
evidence: NEW(produced-by AC#17)
```

## Files in scope

- `scripts/**`
- `plugins/**`
- `docs/**`
- `tests/external-output-references/**`
- `.github/workflows/**`
- `agent-orchestrator.yaml.example`
- `README.md`

## Files out of scope

- Changes to `ComposioHQ/agent-orchestrator` core or vendored AO packages.
- Rewriting #250 liveness semantics instead of consuming them.
- Re-solving #98 review-layer orphan-run cleanup.
- Hardening or closing the `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=0` escape window.
- Broadening spawn grants across unrelated repositories.
- Any merge, issue sync, or publication work for this draft.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
node_modules/**
```

## Acceptance criteria

1. **AC#1 - Read-only worktree enumeration is allowed, mutating worktree remains denied.** With `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`, a boundary fixture proves `git worktree list` and `git worktree list --porcelain` return the read-only allow reason, while `git worktree add`, `git worktree remove --force <path>`, `git worktree prune`, `git worktree move`, and `git branch -m` still deny unless admitted by their existing sanctioned paths.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery
expected: readonly-worktree-list
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t "worktree list recovery boundary"
```

2. **AC#2 - Recovery has one sanctioned git parent and no general bypass.** A test proves the new recovery primitive is admitted as a sanctioned parent only for candidate-scoped cleanup after candidate selection. Raw `git worktree prune` is never admitted; the same `git worktree remove --force` argv from the LLM turn, from an unrelated script, or from a spoofed parent chain remains denied with the autonomous mutating-git reason.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery
expected: sanctioned-cleanup-parent
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t "sanctioned worker recovery parent"
```

3. **AC#3 - Liveness discrimination reuses #250 and fails closed.** Recovery fixtures cover at least these cells: dangling gitdir with positive pack/AO ownership evidence and no live AO session -> candidate-scoped cleanup only; dangling gitdir with missing/foreign/conflicting ownership evidence -> no destructive action; worktree tied to `runtime: exited` or `runtime: process_missing` plus matching ownership -> terminate/cleanup eligible; present non-live/unknown runtime -> fail closed unless #250 classifies it as affirmatively dead; missing runtime plus otherwise live/head-owning row -> live/ambiguous, no `--force`; no AO row but ambiguous ownership metadata -> no destructive action and durable signal.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery
expected: liveness-discrimination
proof-command: npx vitest run -t "worker recovery liveness discrimination"
```

4. **AC#4 - Live worker regression guard for #324 collision class.** A fixture with a live worker whose worktree is parked on the wrong branch does not run `worktree remove --force`, does not park/rename branches, and does not create a second owner. It routes to the existing sanctioned reclaim/resume path or emits a fail-closed operator-visible signal if reclaim cannot be proven safe.

5. **AC#5 - Concurrent recovery is single-winner and idempotent.** A reconcile tick and an orchestrator-invoked recovery for the same worker or PR race under a shared claim. Exactly one actor may perform cleanup/respawn side effects; the loser records a no-op/claim-lost outcome. The claim store uses atomic create/compare-and-set semantics or an equivalent repo-supported primitive, has explicit stale-claim recovery, and writes intent/audit before any destructive git operation. Re-running after each partial failure state either completes the missing next step or records why it is still blocked, without double-remove or double-spawn.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery
expected: claim-lock-idempotency
proof-command: npx vitest run -t "worker recovery claim lifecycle"
```

6. **AC#6 - Respawn and claim-pr-resume stay policy- and grant-routed.** After cleanup eligibility is proven, recovery invokes `ao spawn` / `ao spawn --claim-pr <PR>` only through the existing #458 policy gate and spawn worktree grant path, with AC#12's repository-identity proof in force. Fixtures prove `allowSpawnNew=false` denies new spawn, `allowClaimPrResume=false` denies claim-pr resume, missing/malformed policy fails closed, and a valid policy still cannot bypass grant failure.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery
expected: policy-routed-respawn
proof-command: npx vitest run scripts/autonomous-spawn-policy.test.ts scripts/autonomous-spawn-worktree-gate.test.ts -t "worker recovery|spawn policy|repository identity"
```

7. **AC#7 - Operator-requested spawn reaches the same path.** A fixture or scripted dry run proves an operator-requested autonomous spawn that needs dead-worker recovery uses the recovery primitive instead of directly composing `SURFACE=0`, PATH escapes, raw `/usr/bin/git`, or an alternate cleanup command.

8. **AC#8 - Durable audit explains every destructive decision.** Each recovery attempt records the candidate identity, source evidence, canonical path evidence, liveness verdict, ownership proof, claim holder/outcome, git cleanup decision, spawn/claim-pr decision, and final state before or at the side-effect boundary. Audit must distinguish `skipped_live`, `skipped_ambiguous`, `skipped_foreign_owner`, `removed_dangling_gitdir`, `removed_terminated_session`, `spawn_denied`, `spawn_started`, `claim_lost`, and `partial_failure`.

9. **AC#9 - Full scenario class is covered.** Tests or documented fixtures cover: orphan worktree with positive ownership proof -> candidate-scoped remove; dangling/ambiguous worktree without positive ownership proof -> skip; worktree present with terminated session -> cleanup + respawn; live worker on wrong branch -> no force remove; PR needs a worker and none exists -> gate-routed claim-pr spawn; concurrent recovery -> claim/lock; worktree removed but spawn denied -> re-runnable partial failure; spawn succeeds but audit/finalization fails -> rerun first reconciles the existing session/PR owner and does not spawn a duplicate; live worker misread as orphan -> liveness probe blocks force removal.

10. **AC#10 - Post-claim revalidation before destruction.** After acquiring the recovery claim and immediately before any `worktree remove --force`, the primitive re-reads the worktree path, realpath/canonical identity, HEAD/ref or available ownership marker, AO row, #250 liveness verdict, and recovery claim/candidate-set binding. If the worker/session/worktree appears to have changed, been replaced, become live, or become ambiguous since selection, cleanup is skipped and audited.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery
expected: post-claim-revalidation
proof-command: npx vitest run -t "worker recovery post-claim revalidation"
```

11. **AC#11 - Runtime path canonicalization is tested.** Fixtures cover realpath/canonical-path handling on the orchestrator runtime, including spaces in paths and symlink/resolved-link variants where supported by that runtime. A mismatch after canonicalization prevents destructive cleanup.

12. **AC#12 - Repository-identity path is mechanically checked.** The implementation includes a preflight or test guard proving recovery spawn/resume does not hit `repository_root_mismatch`. Acceptable proofs: #511's repository-identity binding is present, or recovery-spawn runs from pack root in a way that makes the existing grant mint/consume roots match without weakening cross-repo denial. The worker must explicitly answer which path was chosen.

13. **AC#13 - Dirty worktree and local artifacts block blind removal.** A terminated-session worktree with tracked modifications, untracked files, relevant ignored outputs, or local commits not proven pushed/merged is not deleted blindly. Recovery either preserves the work or skips removal with an operator-visible blocked state. A clean terminated worktree may be removed only after this gate passes.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery
expected: artifact-preservation
proof-command: npx vitest run -t "worker recovery artifact preservation"
```

14. **AC#14 - Repo-wide prune is forbidden.** The sanctioned recovery primitive never invokes `git worktree prune`. A boundary/process fixture proves prune remains denied on the autonomous surface, and cleanup uses only the selected candidate path.

15. **AC#15 - Spawn freshness uses local AO ownership first.** Before spawn/resume, recovery validates the local AO task/PR/session mapping and blocks on local evidence of closed, superseded, reassigned, or owned by a live/different worker. A stale ownership row for the same session already admitted as affirmatively dead by the active recovery claim is not an `already-owned` blocker. GitHub REST may be consulted when available, but REST unavailability or rate limiting is not by itself a recovery blocker. If REST returns a definitive closed/merged state that conflicts with local AO state, recovery blocks and escalates the stale mapping.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery
expected: spawn-freshness
proof-command: npx vitest run -t "worker recovery spawn freshness"
```

16. **AC#16 - Recovery retries are bounded and escalate.** Repeated cleanup/spawn failures use a bounded retry budget with backoff. After the budget is exhausted, recovery stops acting for that candidate and emits an operator-visible escalation through the existing durable escalation/fence pattern rather than continuing to retry every reconcile tick.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery
expected: bounded-retry-escalation
proof-command: npx vitest run -t "worker recovery bounded retries"
```

17. **AC#17 - Autonomous trigger admission is explicit.** Recovery may start from operator-requested spawn/recover or from a reconcile classification that proves a dead/terminated worker and no live owner. Plain `Stuck`, stale activity alone, or inability to query GitHub is not enough to enter destructive recovery.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery
expected: trigger-admission
proof-command: npx vitest run -t "worker recovery trigger admission"
```

18. **AC#18 - Boundary tests assert process outcomes, not only reasons.** Tests for allowed `worktree list` and denied mutating worktree commands assert exit code, stderr/stdout contract, and filesystem side effects/non-side effects in addition to the internal allow/deny reason.

19. **AC#19 - One public entrypoint and shared state namespace.** Script, plugin, reconcile, and operator-requested paths delegate to the same public recovery primitive. A fixture proves two entrypoints racing for the same worker use the same machine-local project state namespace and lock identity outside all denylisted/generated repo runtime directories, so one wins and the other observes the shared claim/audit state.

20. **AC#20 - Existing reseat/escalation surfaces remain the escalation seam.** Recovery does not introduce a competing durable escalation drain or a second worker-message/reseat fence. Repeated failure, dirty-worktree blocked states, stale AO mapping, and uncertain spawn outcomes route to the existing #373-style durable escalation/fence seam or document a narrow extension of it.

```positive-outcome
asserts: a policy-allowed autonomous recovery of a terminated worker removes only the proved-dead worker worktree and starts or resumes exactly one replacement through the existing spawn gate
input: realistic
```

## Upgrade-safety check

- No AO core or vendored package edits.
- No unsupported YAML fields.
- No new secrets, credentials, or machine-local credential files.
- The #324 process boundary remains default-deny for raw mutating git; this draft adds one bounded recovery door, not a general git escape.
- Repository-identity safety remains mandatory: either #511 is in force or the recovery-spawn cwd/root proof demonstrates the existing gate already satisfies same-repo and cross-repo behavior.

## Verification

- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/166-orchestrator-worker-recovery-sanctioned-path.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/166-orchestrator-worker-recovery-sanctioned-path.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/166-orchestrator-worker-recovery-sanctioned-path.md`
- Boundary regression tests proving AC#1 and AC#2.
- Recovery state-machine tests proving AC#3, AC#4, AC#5, AC#8, AC#9, AC#10, AC#13, AC#14, AC#16, AC#17, AC#19, and AC#20.
- Runtime path canonicalization fixtures proving AC#11.
- Spawn policy / spawn grant / freshness tests proving AC#6, AC#7, AC#12, and AC#15, including either the #511 repository-identity path or the pack-root cwd proof.
- Boundary process-level tests proving AC#18.
- Pack checks before implementation handoff:
  - `pwsh -NoProfile -File scripts/verify.ps1`
  - `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions (design analysis)

### Confirmed observations

- `pwsh` harness against `Test-AutonomousGitDenied` with `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1` confirmed the live table on 2026-06-29: `git worktree list`, `git worktree list --porcelain`, `git worktree prune`, `git worktree remove --force <path>`, and `git branch -m` all deny with `autonomous_mutating_git_denied`; `git status` allows with `read_only_git`. Exit code is not carried by the direct function return.
- REST via pack `scripts/gh` confirmed #511 is open on 2026-06-29. Local `git log -- scripts/lib/Autonomous-SpawnWorktreeGate.ps1` shows #470 and #493 commits, not #511.
- Local grep found no existing orphan-worktree reaper or worker-recovery primitive in `scripts/**` or `plugins/**`; hits for `worktree prune/remove` are boundary tests or prior spawn-grant drafts.

### Knowledge-base note

The local wiki's `Fault tolerance` note frames recovery as restoring a consistent state after partial failure; `Baseline` favors reproducible recreation from version-controlled state over manual repair. Synto returned no relevant articles or source segments. Applied here: recover by a narrow, state-restoring primitive with durable evidence, and respawn through existing gates instead of ad hoc shell repair.

### Prior art

Coworker bulk recon over the shipped/queued drafts found the non-duplicate gap at the intersection of #250 liveness, #324/#472 git cleanup denial, #458 spawn policy, #470/#472/#493 spawn grant axes, and open #511 repository identity. Existing work either blocks raw mutation, allows only `worktree add`, protects live workers, handles review-layer cleanup after respawn, or documents manual operator recovery. None owns autonomous dead-worker cleanup plus gate-routed respawn.

### Design options

| Option | Trade-off | Decision |
|---|---|---|
| A. Fold #511 into this draft and build recovery end-to-end in one issue | Removes prerequisite wait but merges two security-boundary axes into one review: repository identity and destructive cleanup | Rejected. #511 already exists and has a narrower security proof. This draft may depend on it, but should first test whether pack-root cwd avoids the mismatch without a new repo-identity change. |
| B. Add a sanctioned recovery primitive that reuses #250 liveness, #458 policy, repository-identity proof from AC#12, and #267/#318-style claim-before-act | Smallest new surface that fixes the actual class; risk is the new blessed parent becoming a bypass unless tests bind it tightly | Chosen. It extends shipped contracts without duplicating them and gives GPT/Codex a focused security boundary to review. |
| C. Keep recovery manual and update the runbook/operator guidance | Lowest implementation risk, but leaves the autonomous orchestrator without a legal path and preserves the observed bypass incentive | Rejected. The operator explicitly asked for capability, not more manual procedure. |
| D. Require #511 as unconditional hard prerequisite | Simple ordering and strongest reuse of the open repo-identity draft, but blocks recovery even if running spawn from pack root already satisfies the existing grant root comparison | Deferred to AC#12 proof. The worker must answer whether recovery-spawn can run from pack root; if yes, #511 is not on the critical path for this draft. |

### Discrimination contract

The primitive must classify candidates from a consistent snapshot of worktree inventory plus AO status/session metadata. Positive ownership evidence may come from AO project/session metadata, the session runtime workspace path, pack-owned worktree naming/project identity, gitdir/worktree linkage to the pack repository, and the expected `.agent-orchestrator/.../worktrees/` project namespace. A candidate is cleanup-eligible only when these sources consistently identify the same pack-owned worker and it is either a dangling gitdir orphan or tied to a session that #250 classifies as affirmatively not live. Any live, missing-runtime-but-otherwise-live, mismatched-owner, stale, or ambiguous row is skipped before any `--force`. The wrong-branch/live-session cell is explicitly not cleanup; it must use sanctioned reclaim/resume or surface an operator-visible blocked signal.

### Scenario matrix

| Case | Worktree | AO/session liveness | Ownership confidence | Expected outcome |
|---|---|---|---|---|
| 1 | dangling gitdir | no live session | high orphan confidence | candidate-scoped cleanup only; no prune |
| 1b | dangling gitdir | no live session | missing/foreign/conflicting | skip + audit |
| 2 | present clean | affirmatively terminated | high | post-claim revalidate, cleanup, then policy/grant-routed respawn |
| 2b | present dirty/artifact-bearing | affirmatively terminated | high | preserve/quarantine or skip; no direct force remove |
| 3 | present | live | high | no force remove; reclaim/resume or skip |
| 4 | absent | no worker for PR | high PR need | policy/grant-routed `--claim-pr` spawn |
| 5 | present | ambiguous | low | no destructive action; durable signal |
| 6 | present | terminated | concurrent recovery claim held | loser no-ops with claim-lost audit |
| 7 | removed | spawn denied | high prior cleanup | partial failure; re-run resumes after denial clears |
| 8 | removed | spawn succeeded but final audit failed | high existing owner | rerun reconciles existing owner; no duplicate spawn |
| 9 | same path/name re-created before cleanup | revalidation differs or is ambiguous | apparent match | skip via AC#10 |
| 10 | local AO says active, REST unavailable | n/a | local need current | recovery may proceed through local gates |
| 10b | REST definitively closed/merged | n/a | local need stale | no spawn; stale-mapping escalation |
| 11 | two recovery entrypoints race | same worker | shared state namespace | one winner; loser observes shared claim |
| 12 | repeated cleanup/spawn failure | same candidate | high | bounded retries then escalation; no storm |
| 13 | stuck but not probed-dead | ambiguous | low | no destructive recovery trigger |

### GPT adversarial loop

Pass 1 (`STATE=completed_valid`, `VALIDATION=ok`, pass `25770245-e944-465a-bbee-b6b87c09d281`, sha `8602c3dd6bd9a0746c361cfe3bd467a917201f36b199ebed57288a0ba879d298`) produced 7 findings. Accepted/partial: positive ownership proof for dangling gitdirs; ordered atomic claim/audit phases with stale-claim recovery; claim/capability binding for blessed-parent cleanup; post-claim pre-destruction revalidation; cross-platform path canonicalization fixtures; duplicate-owner reconciliation after spawn partial success; mechanical #511 preflight. Rejected: splitting into two issues, because the operator brief requires one end-to-end shippable recovery unit and dry-run-only would not provide the legal recovery path. Some accepted details are superseded by the architect simplification below.

Pass 2 (`STATE=completed_valid`, `VALIDATION=ok`, pass `22c8ef1f-8401-4e85-b8e2-d5e48520ebe4`, sha `055f0ce7f7d4bba542fa048a290037c8eff06df8b0b62ac6795cd93075180fba`) produced 6 findings. Accepted: dirty-tree/artifact preservation before force removal; repo-wide `worktree prune` must be avoided or all affected records independently admitted; authoritative task/PR freshness before spawn; recovery capability single-use/TTL/finalization/generation binding; ABA-resistant versioned identity; process-level boundary assertions beyond allow/deny reason. Some accepted details are superseded by the architect simplification below.

Pass 3 (`STATE=completed_valid`, `VALIDATION=ok`, pass `877d176b-021a-4da4-ab5a-648c550ac7ab`, sha `c4ae7e49e31a583e4395f8a3b85457e501a38eebd1311538fdf2c87b041c812d`) produced 5 findings. Accepted and applied after cap: declared shared machine-local state namespace outside `.ao/**`; bounded content-addressed quarantine manifest; GitHub REST vs AO mapping precedence/fail-closed conflict rule; one public primitive delegated by script/plugin/operator paths; contract-evidence rows for post-claim revalidation, artifact preservation, spawn freshness, capability replay denial, and ABA-resistant identity. Post-GPT change not re-reviewed because the 3-pass cap was reached. Some accepted details are superseded by the architect simplification below.

GPT loop: 3 passes; stopped because cap-3; last-pass accepted=5; final STATE=completed_valid VALIDATION=ok pass=877d176b-021a-4da4-ab5a-648c550ac7ab sha=c4ae7e49e31a583e4395f8a3b85457e501a38eebd1311538fdf2c87b041c812d

### Architect simplification after GPT

The post-GPT draft was tightened to remove speculative machinery: crypto-style replay capability semantics collapsed into AC#10/#5, separate ABA requirements collapsed into post-claim revalidation, Windows/junction/case-insensitive path fixtures collapsed into runtime realpath checks, quarantine mechanism details were left to the planner, repo-wide `worktree prune` was forbidden, and GitHub REST became optional refinement rather than a recovery blocker. Added real gaps: bounded retries/escalation, #373-style escalation seam, explicit autonomous trigger admission, and the AC#12 question of whether pack-root cwd can avoid #511 on the critical path.
