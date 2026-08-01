# Flow-manager long-running Browser-GPT child runbook (Issue #1164)

Canonical caller-side launcher and Browser-GPT adapter for create-issue-draft long
turns. The adapter does not detach the Browser child independently; it starts the
canonical launcher at the supported detached boundary and waits for a committed
handoff receipt before acknowledging acceptance.

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
  --new-chat \
  --project-url <configured-project-url>
```

## Launcher mechanics

`flow-manager-long-running-child.ts launch` is the sole terminal-envelope writer.

1. Validate pairwise-distinct receipt, envelope, and Browser `--output` destinations.
2. Atomically create one `flow-manager-long-running-child-handoff/v1` receipt
   (`completion_mode: browser-turn-result-v1` fixed constant).
3. Start the Browser-GPT child with stdin closed, stdout parsed in-process, stderr
   to a null sink.
4. Accept the first valid child-produced `turn-result/v1` from stdout; tolerate
   `observation-heartbeat/v1` heartbeats.
5. Finalize with bounded candidate or no-candidate stdout/exit graces.
6. Atomically publish one `flow-manager-long-running-child-terminal/v1` envelope.

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
stays in the same conversation and does not rewrite the envelope.

### Environment overrides (operator / test)

| Variable | Purpose |
|----------|---------|
| `OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS` | Post-result exit/EOF grace |
| `OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS` | Post-exit stdout drain grace |
| `OPK_FM_LONG_CHILD_DISABLE_DETACH` | Run launcher synchronously (tests) |

## Rollback

Rollback changes only future command selection. It does not rewrite receipts,
Browser reply output, or terminal envelopes from prior attempts.

After merge, recycle live flow-manager/worker sessions that must pick up changed
tracked instructions.
