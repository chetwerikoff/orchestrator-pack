# Flow-manager long-running Browser-GPT child runbook (Issue #1164)

Canonical caller-side launcher and Browser-GPT adapter for create-issue-draft long
turns. The adapter does not detach the Browser child independently; it starts the
canonical launcher at the supported detached boundary and waits for a committed
handoff receipt before acknowledging acceptance.

For every Browser-GPT attempt, the caller/orchestrator must mint and retain one
non-empty invocation identity before invoking the adapter. The adapter validates
`--invocation-id` before detached launch or handoff acceptance and forwards those
exact bytes to the child. The same value is reused for supported recovery/harvest;
its presence is common turn identity and does not select direct-publication mode.

## Package commands

```bash
npm run --silent flow-manager-browser-gpt-long-run --
npm run --silent flow-manager-long-running-child --
```

Production Browser-GPT long-running turns use the adapter (`--silent` keeps npm lifecycle banners off stdout so acceptance JSON parsers stay clean):

```bash
npm run --silent flow-manager-browser-gpt-long-run -- \
  --run-identity <opaque-run-id> \
  --attempt-identity <opaque-attempt-id> \
  --invocation-id <caller-owned-invocation-id> \
  --handoff-receipt /absolute/path/handoff-receipt.json \
  --terminal-envelope /absolute/path/terminal-envelope.json \
  --output /absolute/path/reply.txt \
  --profile /absolute/path/to/automation-profile \
  --cdp http://127.0.0.1:9222 \
  --input /absolute/path/to/message.txt \
  --chat-url https://chatgpt.com/c/<conversation-id>
```

Fresh conversation:

```bash
npm run --silent flow-manager-browser-gpt-long-run -- \
  ... \
  --invocation-id <caller-owned-invocation-id> \
  --new-chat \
  --project-url <configured-project-url>
```

## Launcher mechanics

`flow-manager-long-running-child.ts launch` is the sole terminal-envelope writer.

1. The Browser-GPT adapter validates the caller-owned invocation identity before
   starting this launcher or acknowledging handoff.
2. Validate pairwise-distinct receipt, envelope, and Browser `--output` destinations.
3. Atomically create one `flow-manager-long-running-child-handoff/v1` receipt
   (`completion_mode: browser-turn-result-v1` fixed constant).
4. Start the Browser-GPT child with stdin closed, stdout parsed in-process, stderr
   to a null sink.
5. Start with the shared bounded startup allowance. Accept the first valid
   phase-bearing `observation-heartbeat/v1` as event-loop liveness and then reset
   the recurring live-child deadline from each accepted heartbeat.
6. Accept the first valid child-produced `turn-result/v1` from stdout as the sole
   completion authority, then use only the existing candidate exit grace.
7. Classify startup silence as `child_startup_timeout`, recurring live-child silence
   as `child_liveness_timeout`, and actual exit without a result as
   `child_terminal_result_missing`; none implies browser Stop-generating or resend.
8. Atomically publish one `flow-manager-long-running-child-terminal/v1` envelope.

There is no completion-mode selector. Authority is fixed to `browser-turn-result-v1`.

### Waiter (non-terminal)

```bash
npm run --silent flow-manager-long-running-child -- wait \
  --run-identity <id> \
  --attempt-identity <id> \
  --handoff-receipt /path/handoff.json \
  --terminal-envelope /path/envelope.json \
  --deadline-ms 5000
```

Deadline expiry reports envelope absence only. It carries no success, retry, or
launcher-loss authority.

### Survival boundary (demonstrated)

- normal initiating-caller exit after committed handoff;
- caller process-tree teardown;
- caller process-group teardown.

Terminal-session teardown, containers, host reboot, and cross-host survival are
explicitly unproven and out of scope for this version.

### Delivery (three states)

- `not-sent` — positive pre-send evidence, including `output_conflict` with
  `send_count: 0` and post-handoff child start failure;
- `POSSIBLY_DELIVERED` — send attempted or cannot be excluded; `send_count: 1`
  alone is insufficient for `landed`;
- `landed` — authoritative witness/owned-prompt evidence in the child
  `turn-result/v1`.

Ambiguous post-send loss never authorizes blind re-send. Locator-backed recovery
stays in the same conversation and does not rewrite the envelope. A heartbeat proves
only Node event-loop liveness; browser/CDP/composer progress remains governed by its
existing operation budgets. The heartbeat scheduler is turn-scoped, non-keepalive,
and disposed at settlement. Cancellation receipts remain evidence only on startup,
liveness-timeout, and actual-exit branches and do not create Stop-generating authority.

### Environment overrides (operator / test)

| Variable | Purpose |
|----------|---------|
| `OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS` | Post-result exit/EOF grace |
| `OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS` | Post-exit stdout drain grace |
| `OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS` | Bounded pre-first-heartbeat process/bootstrap + canonical-admission allowance |
| `OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS` | Maximum healthy recurring event-loop heartbeat gap |
| `OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS` | Recurring live-child idle window; must be strictly larger than the maximum healthy gap |
| `OPK_FM_LONG_CHILD_DISABLE_DETACH` | Run launcher synchronously (tests) |

## Rollback

Rollback changes only future command selection. It does not rewrite receipts,
Browser reply output, or terminal envelopes from prior attempts.

After merge, recycle live flow-manager/worker sessions that must pick up changed
tracked instructions.
