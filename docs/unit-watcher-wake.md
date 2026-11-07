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
The persisted workspace must match the live target. Missing, stale, malformed,
duplicate, or mismatched records remain unbound. The helper still retains and revalidates the
exact live `{runtime,id,generation}` identity for runtime dispatch. If it cannot
obtain that exact live identity, it exits non-zero without waiting or attempting
a wake. An OpenCode target without persisted launch ownership is still eligible:
after waiting, the adapter submits the full prompt through Orca's native receipt
path. No control binding is inferred from a title, command string, or session catalog.

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
uses the existing preferred `opencode-http` prompt submission path. Without that
binding, a full text-plus-Enter prompt uses the canonical native send in
`scripts/orca-runtime/send-receipt.ts`. It observes the same accepted prompt once
with a bounded `--wait-submit`; it does not resend it.

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

A native receipt confirms submission only when its exact accepted send reports
supported observation and the additive `input_accepted`, `turn_started` stages.
`result.send.accepted === true` alone is deliberately **not** promoted to success.
Accepted-only, queued, timed-out, malformed, contradictory, failed and `old-host`
receipts remain:

```json
{"status":"dispatch_unknown","reason":"<receipt classification reason>"}
```

The helper exits non-zero for that result and prints the exact adapter dispatch
result. Unbound OpenCode targets can receive full prompts through this native
path; partial `writeOnly` or `submitOnly` operations still refuse with
`opencode_control_unbound`. Stale/reused target generations fail before sending.

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

If the helper failed, its owner or coordinator reads the detached result and the
exact current target pane, then reconciles the result itself. An unconfirmed or
ambiguous dispatch is not permission for a duplicate send or a second Enter.
