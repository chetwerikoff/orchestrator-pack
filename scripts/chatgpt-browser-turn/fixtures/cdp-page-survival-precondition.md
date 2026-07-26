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
3. Confirm the turn process exits within seconds of the result line in `--output`.
4. Confirm CDP target count returns to the starting value (owned helper tab closed).
5. For possible-delivery retention, confirm a retained recovery tab remains reachable in the operator browser after the process exits.

## Result template

```
date: 2026-07-26T15:43:00Z
profile: (live automation Chrome on loopback)
cdp: http://127.0.0.1:9222
targets_before: 15
targets_after_success_turn: (not run — full turn requires operator profile path and ChatGPT credentials)
targets_after_disconnect_probe: 16
process_exit_seconds_after_result: (not run)
adopted_context_page_survives_disconnect: yes
notes: Playwright connectOverCDP client created about:blank in adopted context; after browser.close() the target remained in /json/list. Probe tab was closed manually after observation.
```

If `adopted_context_page_survives_disconnect` is **no**, stop implementation and revise the specification rather than carving out connection release on possible-delivery paths.
