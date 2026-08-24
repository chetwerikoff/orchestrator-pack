# Fleet escalation delivery (S3)

Issue #1260 adds the notification-only S3 phase after the durable S1/S2 reconciliation handoff. S3 has one authority: the exact `fleet-reconciliation-handoff/v1` record that the current scheduler invocation just committed and read back. It does not re-observe workers, re-run S1/S2 policy, or derive escalation eligibility from runtime state.

## Input authority

The accepted record must match the current scheduler invocation exactly:

- `schema: fleet-reconciliation-handoff/v1`;
- authoritative `projectId` and GitHub `repository`;
- exact activation lineage;
- exact scheduler generation and positive tick sequence;
- `decision: orchestrator_required`;
- one current `FleetReconciliationReason`;
- valid handoff digest and successful same-invocation durable read-back.

The reason vocabulary is inherited from reconciliation without reinterpretation:

`target_unresolved`, `target_stale`, `observer_untrusted`, `assignment_untrusted`, `remote_not_applicable`, `runtime_unavailable`, `dispatch_unknown`, and `effect_untrusted`.

Malformed, contradictory, stale-lineage, wrong-tick, unsupported, uncommitted, or unread-back evidence is rejected before target resolution and publication.

## Canonical content

`FleetEscalationContentV1` is deterministic UTF-8 JSON derived only from bounded durable reconciliation facts: project/repository identity, activation lineage, scheduler generation, tick sequence, upstream decision/reason, and optional durable role/Issue/Task/assignment metadata already present in the handoff.

The canonical digest domain deliberately excludes the S3 invocation id, handoff recording time, raw runtime identity, terminal/session/title/path/PID/pane data, prompts/replies/transcripts, credentials/authenticated URLs, transport-private identifiers, and scheduler stdout serialization state. Equivalent accepted durable reconciliation evidence therefore produces byte-identical content and digest.

## Exact operator target

S3 does not choose a target. The sole target authority is the landed #1532 producer `withCurrentOperatorPrimaryTarget(...)` with `operatorPrimarySyncResult(...)`.

That producer performs the current logical `operator-primary` binding -> exact current local `WorkerAssignment` -> registered adapter `resolveAssignmentWorker(...)` -> immediate exact `findWorker(...)` / `sameRuntimeWorker(...)` snapshot proof while the PACK logical store lock is held. The runtime identity is available only inside the admitted synchronous action.

All closed pre-action producer failures remain zero-attempt `invalid_target` results:

`binding_absent`, `binding_stale`, `assignment_untrusted`, `remote_not_applicable`, `runtime_unavailable`, `target_unresolved`, `target_not_current`, `binding_store_busy`, `binding_fence_failed`, `deadline_invalid`, and `deadline_exhausted`.

There is no fallback to the S2 worker, handoff metadata, first runtime match, title/path/PID/pane/session heuristics, cached runtime identity, or alternate route.

The current machine-local `operator-primary` designation is runtime state, not repository history. Repository adoption of #1532 does not itself prove that a live designation is present on a particular host; each S3 invocation resolves the current state through the producer above.

## Publication truth

Inside an admitted target action S3 calls the landed TypeScript seam `publishOperatorMessageOnce(...)` at most once.

- `submitted`: the runtime submit attempt was accepted. It is **not** delivery, acknowledgement, processing, or completion proof.
- `pre_dispatch_failure`: the effect definitely did not reach the submit boundary.
- `ambiguous`: submit/delivery truth is uncertain; resend is forbidden.

A synchronous publication throw is conservatively closed as `publish_attempted + ambiguous + attemptCount: 1`. The same closure applies if the target producer reports `action_failed` or `action_result_invalid` after `actionEntered: true`. No entered state is rewritten to `not_attempted`, and every S3 result has `retryAuthority: none`.

S3 has no retry, resend, fallback channel, queue, acknowledgement protocol, result store, journal, recorder callback, delivery daemon, or dedup store. Two separately admitted explicit invocations can therefore produce duplicate alerts; ambiguity never authorizes a second attempt.

## Scheduler result surface

The only S3 result witness is the normal scheduler caller surface. When the S3 phase is evaluated, `runSchedulerTick(...)` exposes the constructed `FleetEscalationInvocationResultV1` as `fleetEscalation`.

`runSingleTick` and `runLoop` may later serialize that already-constructed scheduler return to stdout. Output serialization success/failure is outside S3 publication truth, cannot rewrite `submitted | pre_dispatch_failure | ambiguous`, and creates no retry authority. There is no `evidenceRecording` dimension or separate recorder lifecycle.

The dedicated proof command is:

```text
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/pr2-foundation/fleet-escalation-proof.ts --
```

On success it emits exactly one terminal `fleet-escalation-proof/v1` JSON record. The proof traverses the real scheduler -> S3 -> landed #1532 target producer -> current `publishOperatorMessageOnce(...)` boundary while injecting side-effect-free local runtime/state dependencies so no external operator message is sent. Its required evidence includes:

- `producer: orchestrator-pack`;
- `datum: $.fleetEscalation.result`;
- `expected: operator-escalation-only`;
- `productionBoundary: scheduler-to-current-operator-publication-seam`;
- `resultSurface: runSchedulerTick-return`;
- `attemptCount: 0 | 1`;
- `publication: not_attempted | submitted | pre_dispatch_failure | ambiguous`;
- `forbiddenActuatorCalls: 0`;
- `aoOrPowerShellCalls: 0`;
- `retryAuthority: none`.

## Non-remediation boundary

Operator notification is S3's only side effect. S3 cannot nudge or submit to a worker, spawn/stop/restart/kill/adopt a worker, repair/remove a workspace, mutate `WorkerAssignment` or `operator-primary`, acquire claims/leases/reapers, start or publish reviews, merge, label, or modify Issues/PRs or unrelated GitHub state. It adds no AO/PowerShell route and no new daemon/service/timer/watcher/webhook/cron/provider framework.

## Prerequisite landing record

The implementation base contains all required prerequisite landings as ancestors:

| Dependency | Landing PR | Commit |
| --- | --- | --- |
| #1245 | #1264 | `54cf33decf062a7f38fa5a8a02d02053f5089db1` |
| #1258 | #1278 | `c83c27d9a1d87a5e8136deef76abaa014b5a105c` |
| #1259 | #1357 | `6cce14b7379a80e5999179476432e6c6e0bcadd8` |
| #1352 | #1378 | `936e8bd4530aa25085a7a3299efd1588fdf814b4` |
| #1420 | #1421 | `8c70a1fc70fceeb998bbab077408bbc07e9d93eb` |
| #1440 | #1446 | `7250a03a2b1b5dc429da39596d965f409c1ad449` |
| #1532 | #1585 | `c1a6680a96af28a5b33711d73dbacf2297b82b24` |

The #1260 implementation branch was cut from default-branch commit `f4eaf9c88952c22ea2920f28f53cf8521832cd4b`, where those landings are already present.

## Rollback

Rollback is an ordinary revert of the #1260 implementation. Because S3 owns no durable retry/dedup/result lifecycle and no remediation authority, rollback does not require state migration or cleanup beyond removing the scheduler hook and S3 component introduced by the change.
