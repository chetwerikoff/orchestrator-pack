# Unit-armed watcher wake

Use this helper when a unit starts a detached Orca terminal and needs a separate
watcher terminal to wake the unit pane after that detached terminal exits. It is
only a one-shot wake helper; it is not a scheduler, retry loop, queue, or durable
coordination service.

The wake target is generation-bound. The helper resolves the target through the
registered `RuntimeAdapter` before it begins waiting, retains that exact
`{runtime,id,generation}` identity, revalidates the same identity after the watched
job exits, and performs at most one adapter dispatch.

## Canonical arm

The watched terminal is the detached job. The target terminal is the unit pane
that must resume when the job finishes.

```text
WATCHED_TERMINAL=<detached-job-terminal>
TARGET_TERMINAL=<unit-terminal>
WAKE_TEXT=WATCHER: <detached-job-terminal> exited; resume and inspect its result
```

Arm one disposable watcher terminal with the helper as its command:

```bash
orca terminal create \
  --title "{WATCHER} <detached-job-terminal>" \
  --command "node --experimental-strip-types <PACK_ROOT>/scripts/lib/Invoke-TypeScriptCli.ts --repo-root <PACK_ROOT> --script <PACK_ROOT>/scripts/unit-watcher-wake.ts -- --watch-terminal <detached-job-terminal> --target-terminal <unit-terminal> --wake-text 'WATCHER: <detached-job-terminal> exited; resume and inspect its result'" \
  --json
```

The helper first resolves `<unit-terminal>` through the registered runtime adapter.
For launch-assistant targets, a fresh helper process recovers the OpenCode control
from the existing persisted launch-terminal ownership record by exact runtime plus
the globally unique terminal id. The persisted spawn-receipt generation is not a
live pty-generation authority and may differ from the adapter's current generation.
The persisted workspace must match the live target, and a live title, when present,
must match the persisted launch title. Missing, stale, malformed, duplicate, or
mismatched records remain unbound. The helper still retains and revalidates the
exact live `{runtime,id,generation}` identity for runtime dispatch. If it cannot
obtain that exact live identity or the required `opencode-http` control binding,
it exits non-zero without waiting and without attempting a wake.

The helper then waits for the watched terminal's `exit` condition. Its default wait
timeout is 24 hours; use `--wait-timeout-ms <ms>` only when the job has a known
shorter bound.

## Wake text

Keep the wake text explicit about the watched terminal and the action to resume:

```text
WATCHER: <detached-job-terminal> exited; resume <unit-purpose> and inspect its result
```

After the watched job exits, the helper revalidates the exact target generation.
A closed target, a reused terminal handle, or a changed generation fails closed
before dispatch.

The helper then calls the registered runtime adapter exactly once:

```text
dispatchInput({ worker: <exact-runtime-identity>, text: <wake-text> })
```

The adapter owns provider-specific submission. For a bound OpenCode target this
uses the existing `opencode-http` prompt submission path. A raw Orca fallback still
uses the adapter-owned text-plus-Enter shape, but its `accepted:true` response is
not a submit witness and therefore remains `dispatch_unknown`.

Do not add a second send path and do not retry an ambiguous dispatch.

## Submission confirmation

The helper exits 0 only when the canonical adapter returns:

```json
{"status":"dispatched"}
```

For the current bound OpenCode path, that result is produced only after the
OpenCode prompt submit operation is accepted by the existing runtime control
surface. The helper prints:

```text
watcher wake submission confirmed: runtime=<runtime> target=<unit-terminal> generation=<generation> dispatch=dispatched
```

A raw Orca `terminal send --text ... --enter` response containing
`result.send.accepted === true` is deliberately **not** promoted to success. The
current adapter classifies that combined raw send as:

```json
{"status":"dispatch_unknown","reason":"submit_witness_unavailable"}
```

The helper exits non-zero for that result and prints the exact adapter dispatch
result. Known OpenCode targets with no bound control fail non-zero with
`opencode_control_unbound` before sending. Stale/reused target generations fail
non-zero before sending as well.

Watched-terminal wait failures still include the exact Orca command stdout/stderr.
Target-resolution and wake-delivery failures include the exact canonical
`RuntimeAdapter` result, because the helper does not bypass that boundary to inspect
or reinterpret provider-native send output.

## Cleanup

The watcher terminal is disposable. After it exits, close that watcher terminal
if it still remains visible:

```bash
orca terminal close --terminal <watcher-terminal> --json
```

If the helper failed, inspect the surfaced wait/adapter result and re-observe the
current target before deciding whether another wake is safe. An unconfirmed or
ambiguous dispatch is not permission for an automatic duplicate send.
