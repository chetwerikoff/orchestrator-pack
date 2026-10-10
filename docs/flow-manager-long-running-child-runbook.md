# Flow-manager long-running Browser-GPT child runbook (Issue #1164)

Canonical caller-side launcher and Browser-GPT adapter for long-running tracked
turns. The adapter is workflow-neutral: create-Issue, execute-Issue, pack-review,
and other callers keep their own substantive completion authority. The adapter
does not detach the Browser child independently; it starts the canonical launcher
at the supported detached boundary and waits for a committed handoff receipt
before acknowledging transport handoff.

For every Browser-GPT attempt, the caller/orchestrator must mint and retain one
non-empty invocation identity before invoking the adapter. The adapter validates
`--invocation-id` before detached launch or handoff acceptance and forwards those
exact bytes to the child. The same value is reused for recovery/harvest of **that one attempt**, not
for a second send: every real new Browser attempt must use a fresh invocation
ID, even across run/attempt labels or profiles. An occupied key requires a
fresh invocation ID, never deleting an old receipt or treating an old key as
authorization to retry.

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
  --owner-task-id <optional-opaque-task-id> \
  --owner-dispatch-id <optional-opaque-dispatch-id> \
  --handoff-receipt /absolute/path/handoff-receipt.json \
  --terminal-envelope /absolute/path/<attempt>-terminal.json \
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

## Tooling source

Run Browser-GPT tooling from the trusted pack checkout (the operator's
`orchestrator-pack` checkout on the default branch), never from a worker
branch under change. That covers this adapter and launcher, the turn entry, and
`browser-gpt-page-probe.ts`. Pass the worker worktree as `--cwd`; the child
runs there. The indexed handoff's `child_cwd` is the resolved **Browser child**
worktree only; it is not evidence of the invoking agent terminal's cwd,
ownership or terminal incarnation:

```bash
npm --prefix <pack-checkout> run --silent flow-manager-browser-gpt-long-run -- \
  ... \
  --cwd <worker-worktree>
```

The page probe likewise runs as `<pack-checkout>/scripts/browser-gpt-page-probe.ts`.

The adapter resolves the launcher and turn entry next to itself, so the checkout
that supplies the adapter supplies the engine. A relative `scripts/...` path run
inside a worker worktree executes that branch's copy, which may lack current
engine fixes; it is not the trusted engine.

## Launcher mechanics

`flow-manager-long-running-child.ts launch` is the sole terminal-envelope writer.

1. The Browser-GPT adapter forwards the exact caller-owned `--invocation-id`
   to both launcher and Browser child. Optional `--owner-task-id` and
   `--owner-dispatch-id` are independent, opaque caller assertions; no owner
   is inferred from profile, cwd or environment. An inherited
   `ORCA_TERMINAL_HANDLE` is snapshotted only as optional
   `launching_terminal_handle` routing data, never a terminal incarnation
   or permission to wake/stop the child.
2. Validate pairwise-distinct receipt, envelope, and Browser `--output` destinations,
   and refuse (`terminal_envelope_name_not_wakeable`) an envelope whose file name
   does not end in `terminal.json`: fleet-wake discovers envelopes only by that
   suffix, so any other name parks the caller with no wake. The adapter applies
   the same check before spawning the launcher. Nothing is sent and no file is
   written; the refusal carries `suggested_path` and a `hint` — re-run the same
   command with `--terminal-envelope <suggested_path>`.
3. For an invocation-bearing launch, check the prospective global invocation key
   and the same-profile, profile+CDP-keyed durable state-light observation
   **before** Browser spawn. Refuse any occupied or uncertain key, including a
   pre-index observation with no locator; supply a new ID rather than reusing
   an old attempt. Atomically exclusive-create one small
   `flow-manager-long-running-child-locator/v1` index under
   `/tmp/opencode/browser-gpt-receipts/<sha256(invocation-id)>.json`.
   This private (`0700` directory, `0600` index) navigation record stores
   only invocation/run/attempt and pointers to the **original** handoff and
   terminal paths. The index has no profile, CDP, prompt or chat transcript.
   Invalid, occupied, aliased, symlinked, partial or non-private indexes fail
   closed; a partial reservation stays occupied and requires a fresh ID.
4. Atomically create the original `flow-manager-long-running-child-handoff/v1`
   with unchanged existing keys and additive `invocation_id`, optional
   `owner_task_id`/`owner_dispatch_id`, `child_cwd`,
   `launcher_pid` from the actual launcher's `process.pid`, and an optional
   `launching_terminal_handle` hint. Read back and cross-check the original
   receipt/index before Browser spawn or adapter handoff acknowledgment.
   The original receipt/terminal/output destinations remain caller-selected.
5. Legacy direct `flow-manager-long-running-child.ts launch` with no invocation
   continues its original receipt/terminal and explicit-path wait. It creates
   no index and invents no invocation. A direct caller opting into an indexed
   invocation also supplies `--profile` and `--cdp` for the same-profile
   pre-spawn observation collision check.
6. Start the Browser-GPT child with stdin closed, stdout parsed in-process, stderr
   to a null sink.
7. Start with the shared bounded startup allowance. Accept the first valid
   phase-bearing `observation-heartbeat/v1` as event-loop liveness and then reset
   the recurring live-child deadline from each accepted heartbeat.
8. Accept the first valid child-produced `turn-result/v1` from stdout as the sole
   completion authority, then use only the existing candidate exit grace.
9. Classify startup silence as `child_startup_timeout`, recurring live-child silence
   as `child_liveness_timeout`, and actual exit without a result as
   `child_terminal_result_missing`; none implies browser Stop-generating or resend.
10. Atomically publish one `flow-manager-long-running-child-terminal/v1` envelope.

There is no completion-mode selector. Authority is fixed to `browser-turn-result-v1`.

### Receipt locator, PID and waiter (non-terminal)

The adapter prints the existing `flow-manager-browser-gpt-long-run-accepted/v1`
keys plus `invocation_id`, `receipt_locator`, the original handoff's verified
`launcher_pid` and `child_cwd`, and optional owner/terminal-handle data.
In synchronous `OPK_FM_LONG_CHILD_DISABLE_DETACH=1` mode,
`runProcess.onSpawn` captures the newly spawned launcher's OS PID, separately
from its exit status. In detached mode, the launch command observes the actual
background launcher PID. The adapter refuses a pre-existing handoff file or
invocation locator **before spawning**, even when every run/attempt/invocation
ID, path and owner matches the old launch. After spawn, it compares that
freshly observed PID with the original committed handoff's `launcher_pid`
before emitting accepted/v1; synchronous pre-spawn refusal exit status 2
is never accepted. An identical retry after a lost acknowledgment must
recover the **original** invocation using `wait`, not relaunch or re-send
it. A committed handoff remains handoff evidence even if its Browser child
later exits nonzero; it never proves a successful turn or delivery.

Indexed wait uses **either** the exact invocation or the adapter-returned
`receipt_locator`, with the original run/attempt to verify the single indexed
attempt. It reads only the documented discovery root and existing original
handoff/terminal files, including from a different cwd:

```bash
npm run --silent flow-manager-long-running-child -- wait \
  --run-identity <id> --attempt-identity <id> \
  --invocation-id <original-invocation-id> --deadline-ms 5000

npm run --silent flow-manager-long-running-child -- wait \
  --run-identity <id> --attempt-identity <id> \
  --receipt-locator /tmp/opencode/browser-gpt-receipts/<sha256-id>.json \
  --deadline-ms 5000
```

Do not combine locator selectors with the legacy explicit paths. An indexed
direct launch may have preserved a relative caller-supplied handoff spelling
inside terminal/v1. The indexed waiter checks it against the original indexed
absolute receipt and committed launch identity without resolving that old
relative spelling against the **waiter's** cwd; it does not rewrite legacy
terminal payloads. An unindexed pre-upgrade or standalone direct receipt
cannot be upgraded or silently looked up by ID; keep using its original
explicit-path wait. The only test
redirection is the existing two-part
`OPK_FM_LONG_CHILD_TEST_GATE=fixture-root-v1` plus
`OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT=<disposable-absolute-root>` fixture
gate. A single environment variable cannot redirect production discovery.

**Legacy explicit-path wait** remains unchanged:

```bash
npm run --silent flow-manager-long-running-child -- wait \
  --run-identity <id> \
  --attempt-identity <id> \
  --handoff-receipt /path/handoff.json \
  --terminal-envelope /path/<attempt>-terminal.json \
  --deadline-ms 5000
```

Deadline expiry reports envelope absence only. It carries no success, retry, or
launcher-loss authority. The caller's own tool/shell timeout must exceed
`--deadline-ms` by a comfortable margin; repeated short deadlines are the
contract, and deadline expiry printed by the waiter itself is the only legal
“envelope absent” evidence.

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

Ambiguous post-send loss never authorizes blind re-send. A closed or
unobservable original chat tab while child heartbeats are healthy is not
an unrecoverability witness: the child may still reconnect, finish census,
find an owned-marker successor and emit a valid `turn-result/v1`.
No parent-side page-loss deadline, `chat_page_gone` terminal, child abort,
tab close, or new wake/retry authority is introduced. Locator-backed recovery
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
the append-only invocation index, Browser reply output, or terminal envelopes
from prior attempts. Older explicit-path launch/wait remains usable. An
occupied/partial index is preserved as non-success evidence: repair the root
permissions when needed and use a **new invocation ID** for any genuinely
new Browser attempt, never unlink/resend an uncertain old attempt.

After merge, recycle live flow-manager/worker sessions that must pick up changed
tracked instructions.
