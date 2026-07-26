# AC2 live CDP precondition (Issue #1007)

Recorded observation for the tracked browser-turn teardown design.

## Assumption

When the helper connects to the operator's automation Chrome via `connectOverCDP`, pages created in the adopted browser context **survive** client disconnect (`browser.close()` on the Playwright CDP client).

## Why this matters

AC4 requires possible-delivery recovery pages to remain open after the turn process exits. AC2 requires the CDP client connection to be released on every terminal path. The design is valid only if disconnecting the client does not close tabs the operator must inspect.

## Observation method

Against the dedicated automation profile on `http://127.0.0.1:9222`:

1. Note CDP target count.
2. Run a successful `--new-chat` turn via `npm run chatgpt-browser-turn`.
3. Confirm the turn process exits unaided (foreground exit code 0 without SIGTERM) after the result line is written to `--output`; wall time between the result line and process exit was not instrumented.
4. Confirm CDP target count returns to the starting value (owned helper tab closed).
5. For possible-delivery retention, confirm a retained recovery tab remains reachable in the operator browser after the process exits.

## Recorded results

```
date: 2026-07-26T16:00:00Z
verified_head: b59976abf76c5856bd55124e3a475566276b3388
live_turn_head: 76fbb589bc62a86d12a25ec46093963291256981
profile: automation profile (clean, no incidents before or after)
cdp: http://127.0.0.1:9222
targets_before: 6
targets_after_success_turn: 6
process_exit_seconds_after_result: unaided (foreground exit 0 without SIGTERM; wall time not instrumented)
adopted_context_page_survives_disconnect: yes
turn_result: state ok, output byte_length 5, sha256 68faf648728e1563dce0162523dad670123775c56ca6fa6813b9220f5c383217
witness: user e9f1234a-3f45-4844-b4bb-c8bfeca82bf4 -> assistant daf9264e-b829-4bda-a227-65fef0cd1a7a
notes: Operator live verification on PR #1018. Successful new-chat turn completed, process returned exit 0 on its own (first unaided exit today; prior turns required SIGTERM). CDP page count returned to baseline. Disconnect-probe observation (about:blank in adopted context survives browser.close()) recorded separately on 2026-07-26T15:43:00Z.
```

If `adopted_context_page_survives_disconnect` is **no**, stop implementation and revise the specification rather than carving out connection release on possible-delivery paths.
