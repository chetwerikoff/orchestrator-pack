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
5. Accept the first valid child-produced `turn-result/v1` from stdout; tolerate
   `observation-heartbeat/v1` heartbeats.
6. Finalize with bounded candidate or no-candidate stdout/exit graces.
7. Atomically publish one `flow-manager-long-running-child-terminal/v1` envelope.

There is no completion-mode selector. For turns without a governed GitHub
publication expectation, authority remains fixed to `browser-turn-result-v1`.
For governed author/reviewer publication, the terminal envelope is diagnostic
and the publication-aware waiter below is the manager completion boundary.

### Waiter

Ordinary non-publication wait:

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

For a governed reviewer publication, the manager must pass the exact accepted
publication identity:

```bash
npm run --silent flow-manager-long-running-child -- wait \
  --run-identity <id> \
  --attempt-identity <id> \
  --handoff-receipt /path/handoff.json \
  --terminal-envelope /path/envelope.json \
  --deadline-ms 5000 \
  --publication-kind reviewer \
  --repository <owner/repo> \
  --issue-number <N> \
  --source-revision <rNN> \
  --invocation-id <caller-owned-invocation-id> \
  --stage <stage> \
  --source-slot <slot>
```

For an author publication on an authoritatively known Issue number, use the
manager-held hash of the author-produced exact body bytes. That hash must be
computed before the GitHub mutation; a hash derived from the REST response is
not an expectation:

```bash
npm run --silent flow-manager-long-running-child -- wait \
  --run-identity <id> \
  --attempt-identity <id> \
  --handoff-receipt /path/handoff.json \
  --terminal-envelope /path/envelope.json \
  --deadline-ms 5000 \
  --publication-kind author \
  --repository <owner/repo> \
  --issue-number <N> \
  --source-revision <rNN> \
  --body-sha256 <prepublication-sha256>
```

When publication identity is present, a fresh REST-visible exact artifact is
terminal even if the child is dead/silent and the envelope is an incident.
Foreign/edited reviewer matches and exact author-body mismatches are blocked.
Missing or unavailable REST evidence remains non-terminal.

For a concurrent reviewer batch, the manager passes one identical
`--publication-batch-json` array to each sibling waiter after all siblings are
launched. Each array entry is:

```json
{
  "repository": "owner/repo",
  "issue_number": 123,
  "source_revision": "r05",
  "invocation_id": "uuid",
  "stage": "architectural-review",
  "source_slot": "01"
}
```

The waiter invokes the existing concurrent-batch classifier on the live REST
observations. One published sibling changes a silent/missing sibling to
`possible-or-actual`, `resendForbidden: true`, `settlement: incident`; the
emitted incident records the current invocation and published sibling
invocations. Zero published artifacts do not prove delivery. A blocked current
publication is not overridden by a sibling.

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
  `turn-result/v1` for ordinary non-publication transport settlement.

For governed GitHub publication, delivery/completion attribution is read from
the published artifact over REST. Child delivery state remains diagnostic and
never overrides that publication authority. Ambiguous post-send loss never
authorizes blind re-send. Locator-backed recovery stays in the same
conversation and does not rewrite the envelope.

### Environment overrides (operator / test)

| Variable | Purpose |
|----------|---------|
| `OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS` | Post-result exit/EOF grace |
| `OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS` | Post-exit stdout drain grace |
| `OPK_FM_LONG_CHILD_DISABLE_DETACH` | Run launcher synchronously (tests) |

## Rollback

Rollback changes only future command selection. It does not rewrite receipts,
Browser reply output, terminal envelopes, or publication observations from prior
attempts.

After merge, recycle live flow-manager/worker sessions that must pick up changed
tracked instructions.
