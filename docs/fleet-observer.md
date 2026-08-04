# S1 fleet observer

Issue #1258 adds one observer phase inside the existing scheduler tick. It
does not add a daemon, child process, watcher, timer owner, lock service, or
action path.

## Boundary and landing record

The prerequisite runtime-neutral boundary is Issue #1245, landed by PR #1264
at commit `54cf33decf062a7f38fa5a8a02d02053f5089db1`. The observer consumes
only its workspace-complete list/find, opaque identity and generation,
provenance, bounded output token, and bounded liveness result:
`busy | idle | gone | unknown`.

The observer does not import an adapter or Orca CLI, parse runtime output or
cursors, or persist runtime-private values. `internal` and `external`
provenance are both observation-only.

## Classification

Each listed `{id,generation}` incarnation is assigned a local `unitRef` such
as `u-000001`. The reference is not derived from runtime values and is never
reused within one generated `schedulerGeneration`. Runtime identity, output
tokens, and livelock streaks exist only in memory.

The precedence is:

1. `unknown` for any failed, expired, malformed, stale, contradictory, or
   `unknown` observation;
2. `exempt` for an exact current `{schedulerGeneration,unitRef}` exception;
3. `busy` only for positive new output;
4. `livelock` after the configured number of completed busy/no-progress ticks;
5. `idle` only for successful observations with positive liveness=`idle`.

Process existence, a spinner, unchanged scrollback, terminal text, browser
state, reports, pull requests, and reviews are not activity evidence.

Positive same-generation liveness=`gone` ends the incarnation immediately,
emits one `unit-disappeared` transition, and omits the row. A later
reappearance receives a fresh reference and one `unit-appeared` transition.
Contradictory generation evidence remains `unknown`.

## Configuration

The optional operator file is:

`~/.config/orchestrator-pack/fleet-observer.json`

```json
{
  "schemaVersion": 1,
  "livelockTicks": 60,
  "phaseBudgetMs": 5000,
  "maxConcurrency": 8,
  "exceptions": [
    {
      "kind": "HELD",
      "schedulerGeneration": "sg-example",
      "unitRef": "u-000001"
    }
  ]
}
```

Only the four reason labels `HELD`, `FOREIGN`, `OWED`, and `STANDDOWN` are
accepted. An entry applies only when both fields exactly match the current
snapshot census. Invalid keys, thresholds, budgets, concurrency, duplicate
references, or malformed references fail closed. No wildcard, basename,
regular expression, TTL, hot reload, derived `OWED`, or private-store join
exists.

The effective phase budget is
`min(phaseBudgetMs ?? 5000, max(1, floor(schedulerIntervalMs / 4)))`.
One fifth of that budget, capped at 250 ms, is reserved for deterministic
settlement. Concurrency defaults to 8 and is bounded to 1–32.

## Snapshot and limits

The sole durable state is:

`~/.local/state/orchestrator-pack/fleet-observer/snapshot.json`

The complete snapshot is written to a same-directory temporary file,
synchronized, atomically replaced, and read back before the deadline. It
contains a complete census, bounded transitions, and bounded progress. The
reader rejects partial, unsupported, contradictory, duplicate, oversized, or
over-unit files.

V1 limits are fixed:

- at most 256 discovered units;
- at most 1,048,576 UTF-8 bytes for serialized `snapshot.json`.

Overflow retains the previous census and records at most one
`tick-failed:fleet-cap-exceeded` progress item. It never publishes a
truncated census. Expired probes settle as `unknown` only when a complete
bounded candidate can still be committed.

On scheduler restart, a fresh `schedulerGeneration` is required. The local
unit counter may reuse a suffix, but old exceptions remain inert because
their namespace differs. Corrupt prior state never restores runtime
continuity.

## Diagnostics and rollback

The latest accepted snapshot is diagnostic evidence. Stale progress indicates
observer silence; it does not authorize any action and no second watchdog is
created. To roll back, revert the scoped scheduler/observer/docs/test change;
the local snapshot may be ignored or removed manually. No service or
supervisor child is started during adoption.

S1 ends at observation evidence. Nudge, send, stop, remove, escalation,
delivery, Browser-GPT, report, PR, review, merge, and exception-release policy
belong to later reviewed issues.
