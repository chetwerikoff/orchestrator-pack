# Fleet-wide supervised-child liveness contract

Issue #853 moves supervised-child liveness production to a shared TypeScript runtime while keeping the supervisor freshness consumer and restart policy unchanged.

## Runtime contract

`scripts/kernel/side-process-liveness.ts` is the only implementation of the new bounded-call and intra-step heartbeat behavior.

When a registered supervised child invokes `gh` or `ao`:

1. the existing thin shell/PowerShell transport dispatches the command through the TS runtime;
2. the runtime applies the child-specific timeout from `scripts/orchestrator-side-process-liveness-contract.json`;
3. the command process group is terminated through the existing subprocess kernel on timeout;
4. a schema-v2 progress record advances `workCursor` at call start and after every completed call;
5. timeout evidence is stored as `bounded-external-call/v1` with only the call name, outcome, timeout, elapsed time, and observation time;
6. the common terminal progress helper converts a pending timeout into the existing `tick_error` outcome, so sustained failures continue through the current degraded/backoff and circuit-breaker path.

Raw stdout, stderr, command payloads, environment variables, authorization headers, and tokens are never copied into the timeout diagnostic.

The progress consumer, PID/tick identity fences, stale-heartbeat classification, livelock classification, dead-process handling, overlap suppression, crash restart accounting, and degraded restart accounting are not replaced by this contract.

## Safety budget

For each registry child, the effective stall threshold is:

```text
cadenceSeconds * max(2, stallGraceMultiplier) * 1000
```

The census rejects any configured external-call timeout above 50% of that threshold and reports the child, configured timeout, allowed budget, and remaining safety margin. The same census requires a bounded local-compute gap and evidence for every wired child.

The deterministic release gate extends the existing Issue #473 liveness matrix rather than adding unmeasured standalone Vitest files:

```bash
npm run test:foundation
npm test -- scripts/orchestrator-wake-supervisor-pr-lane-static.test.ts
```

The foundation suite imports the Issue #853 pure TypeScript cases and covers both named regression anchors, bounded timeout/degraded routing, redaction, atomic progress publication, fleet census drift, and the seed-to-trigger acceptance path. It also reruns the existing hang, livelock, identity, dead-process, overlap, and lock-safety matrix.

## Fleet census

`scripts/gate-runner/fleet-liveness-census.ts` reads the canonical side-process registry and fails closed when:

- a registered child has no wired declaration or reviewed exemption;
- either regression anchor is not wired;
- a timeout or local-compute gap exceeds its safety budget;
- a child no longer reports terminal outcomes through the shared progress helper;
- the `gh`, `ao`, or terminal transport bypasses the shared TS runtime;
- declared evidence paths disappear.

The mandatory regression anchors are `review-ready-report-state-seed` and `review-trigger-reeval`.

## Rollout and rollback

The change is process-local and requires no state migration. Existing progress records remain readable; schema-v1 terminal records remain valid, while sparse schema-v1 seed polling remains fail-closed as before.

After deploying the pack, stop and start the local wake supervisor from the pack root so every managed child inherits the updated `PATH` and common PowerShell progress shim:

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
```

Do not delete side-process state as part of the rollout.

Rollback is the normal code rollback followed by one supervisor restart. No progress/state rewrite is required.
