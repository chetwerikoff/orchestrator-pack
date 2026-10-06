# Unit-armed watcher wake

Use this helper when a unit starts a detached Orca terminal and needs a separate
watcher terminal to wake the unit pane after that detached terminal exits. It is
only a one-shot wake helper; it is not a scheduler, retry loop, queue, or durable
coordination service.

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

The helper waits for the watched terminal's `exit` condition. Its default wait
timeout is 24 hours; use `--wait-timeout-ms <ms>` only when the job has a known
shorter bound.

## Wake text

Keep the wake text explicit about the watched terminal and the action to resume:

```text
WATCHER: <detached-job-terminal> exited; resume <unit-purpose> and inspect its result
```

The helper passes that text to exactly one Orca command of this shape:

```text
orca terminal send --terminal <unit-terminal> --text <wake-text> --enter --json
```

Do not hand-write a second send path or omit `--enter`.

## Submission confirmation

A successful process exit from Orca is not enough. The helper confirms submission
only when the send command's own JSON output contains:

```json
{"ok":true,"result":{"send":{"accepted":true}}}
```

On that exact witness it exits 0 and prints:

```text
watcher wake submission confirmed: accepted:true target=<unit-terminal>
```

If Orca returns `ok:true` without `result.send.accepted === true`, the helper
classifies the result as `delivery-unknown`, exits non-zero, and prints the exact
send-command stdout/stderr. Structured failures such as
`terminal_not_found` are also non-zero and include the exact command output.
The helper does not automatically resend an unconfirmed wake.

## Cleanup

The watcher terminal is disposable. After it exits, close that watcher terminal
if it still remains visible:

```bash
orca terminal close --terminal <watcher-terminal> --json
```

If the helper failed, inspect the surfaced Orca output and re-observe the current
target before deciding whether another wake is safe. Do not treat an unconfirmed
submission as permission for an automatic duplicate send.
