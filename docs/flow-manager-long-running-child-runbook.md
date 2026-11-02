# Flow-manager long-running Browser-GPT child runbook (Issue #1164)

Canonical caller-side launcher and Browser-GPT adapter for long-running tracked
turns. The adapter is workflow-neutral: create-Issue, execute-Issue, pack-review,
and other callers keep their own substantive completion authority. The adapter
does not detach the Browser child independently; it starts the canonical launcher
at the supported detached boundary and waits for a committed handoff receipt
before acknowledging transport handoff.

A managed Browser-GPT launch requires the current upstream-admitted, nonempty
Task+Dispatch pair as `--owner-task-id` and `--owner-dispatch-id`; the adapter
correlates it with the original handoff but does not independently prove its
freshness. Mint and retain one invocation identity before the attempt. Reuse it
only to observe/recover that exact attempt. If delivery may have occurred,
reconcile the original Page and exact bound GitHub target before any new Send;
do not replace the invocation or retry while evidence is unresolved. Each
independent physical Send has its own invocation identity. A proven occupied
identity is not retry authority; use a new identity only for a distinct,
admitted attempt after the original outcome is resolved.

A continuation names its predecessor with `--predecessor-invocation-id` and
`--predecessor-attempt-identity` only. The launcher reads that earlier
invocation's original Run/Task/Dispatch from its own durable locator and
handoff; the current Task or Run is never substituted. A positively settled
`ok`/landed predecessor is a no-op for Stop, cleanup and resend, and never admits
the new Send: the current Task+Dispatch is separately admitted. A missing,
foreign, non-`ok` or unreadable predecessor refuses before Send. Every pre-spawn
refusal prints its exact code and an executable `nextStep` on caller stderr
(exit 2, zero Send, no accepted/v1). After a child may have started, the
adapter prints its own wrapper code plus original-invocation wait/Page/GitHub
reconciliation and claims neither child refusal nor zero Send.

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
  --owner-task-id <upstream-admitted-task-id> \
  --owner-dispatch-id <upstream-admitted-dispatch-id> \
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

1. The managed adapter requires the current upstream-admitted `--owner-task-id`
   and `--owner-dispatch-id` pair, forwards both to the launcher, and checks the
   same values against the original handoff/locator. Their freshness remains the
   existing upstream Dispatch responsibility. Legacy direct launch/wait stays
   ownerless and diagnostic-only for effects. An inherited
   `ORCA_TERMINAL_HANDLE` is snapshotted only as optional
   `launching_terminal_handle` routing data, never a terminal incarnation or
   permission to wake/stop the child.
2. Receipt and terminal input paths contribute only their basenames. The
   handoff, terminal and global locator resolve beneath one private
   `$XDG_STATE_HOME/orchestrator-pack/`; with XDG unset, use
   `~/.local/state/orchestrator-pack/`. The terminal basename must end in
   `terminal.json` so fleet-wake can discover it. Browser `--output` remains
   caller-selected. Pairwise aliases, basename collisions, unsafe root
   ownership/permissions, symlinks or invalid XDG refuse before Browser spawn.
   The adapter returns the resolved durable paths in accepted/v1.
3. For an invocation-bearing launch, check the prospective global invocation key
   and same-profile, profile+CDP-keyed durable state-light observation before
   Browser spawn. Refuse any occupied or uncertain key, including a pre-index
   observation with no locator. Atomically exclusive-create one
   `flow-manager-long-running-child-locator/v1` index at
   `$XDG_STATE_HOME/orchestrator-pack/browser-gpt-receipts/<sha256(invocation-id)>.json`
   (or the HOME fallback root). The private (`0700` directory, `0600` index)
   navigation record stores invocation/run/attempt and pointers to the original
   handoff and terminal. It contains no profile, CDP, prompt or chat transcript.
   Invalid, occupied, aliased, symlinked, partial or non-private indexes fail
   closed; a partial reservation stays occupied.
4. Atomically publish the original
   `flow-manager-long-running-child-handoff/v1` with unchanged identity fields,
   `invocation_id`, the required managed owner Task+Dispatch pair, `child_cwd`,
   `launcher_pid` from the actual launcher process and optional
   `launching_terminal_handle`. Read back and cross-check the receipt/index
   before Browser spawn or adapter handoff acknowledgment. Terminal envelopes
   are complete before becoming visible.
5. Legacy direct `flow-manager-long-running-child.ts launch` with no invocation
   retains ownerless diagnostics and creates no index. A direct caller opting
   into an indexed invocation also supplies `--profile` and `--cdp` for the
   same-profile pre-spawn observation collision check.
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
is never accepted.

Pre-spawn validation and refusal tiers: see [Owner wait and refusal tiers](#owner-wait-and-refusal-tiers).

An identical retry after a lost acknowledgment must
recover the **original** invocation using `wait`, not relaunch or re-send
it. A committed handoff remains handoff evidence even if its Browser child
later exits nonzero; it never proves a successful turn or delivery.

Managed indexed wait and the owner-run reaper: see
[Owner wait and refusal tiers](#owner-wait-and-refusal-tiers).

Do not combine locator selectors with legacy explicit paths. An indexed direct
launch may have preserved a relative caller-supplied handoff spelling inside
terminal/v1; the waiter checks it against the original indexed absolute receipt
without resolving that old spelling against the waiter's cwd. Ownerless/direct
or unauthenticated wait remains diagnostic-only; it never creates a terminal,
controls a process, or authorizes a retry.
The only test redirection is the existing two-part
`OPK_FM_LONG_CHILD_TEST_GATE=fixture-root-v1` plus
`OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT=<disposable-absolute-root>` fixture gate.

**Legacy ownerless direct wait** remains read-only and diagnostic-only:

```bash
npm run --silent flow-manager-long-running-child -- wait \
  --run-identity <id> \
  --attempt-identity <id> \
  --handoff-receipt <caller-path>/handoff.json \
  --terminal-envelope <caller-path>/<attempt>-terminal.json \
  --deadline-ms 5000
```

Caller paths contribute only basenames; wait resolves artifacts under the same durable state root.

Deadline expiry reports envelope absence only. It carries no success, retry, or
launcher-loss authority. The caller's own tool/shell timeout must exceed
`--deadline-ms` by a comfortable margin; repeated short deadlines are the
contract, and deadline expiry printed by the waiter itself is the only legal
“envelope absent” evidence.

### Durability boundary

The original private handoff, terminal and keyed locator live beneath the single
XDG/HOME state root, rather than tmpfs. Browser reply output and disposable
proof/build scratch retain their existing caller-selected lifecycle. The
launcher commits each JSON artifact complete-before-visible with exclusive
publication; the v1 record schemas and filenames are unchanged.

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

## Owner wait and refusal tiers

The adapter runs the launcher's own pre-spawn validation in-process once,
before detachment; it reserves nothing (only the launcher reserves the
invocation key). Refusals come in three tiers:

- proved pre-child refusal: the actual code and an executable `nextStep` on
  the caller's stderr, exit 2, zero Send, no accepted/v1;
- authenticated launcher pre-SEND refusal after detachment: the launcher
  leaves one bounded, scrubbed `<resolved-handoff>.refusal.json` companion for
  the same invocation/Run/attempt/launcher PID, and the adapter relays its
  code and `nextStep` (exit 2, no accepted/v1); the companion is not a receipt
  or an envelope;
- anything after a launcher may have started (missing/foreign companion,
  late handoff, PID or locator read-back mismatch): the adapter's own known
  code plus original-invocation wait/Page/exact-GitHub reconciliation. Physical
  SEND is unknown (`POSSIBLY_DELIVERED`); this is never resend authority.

Managed indexed wait reads the original invocation/Run/attempt and, when
supplied, verifies both owner flags against the original handoff and locator.
By default it is read-only and diagnostic. Only the owner-run `wait` may publish
one complete-before-visible uncertainty envelope, and only when (i) the original
handoff/locator carries both nonempty owner flags, (ii) the caller supplies both
matching original values and the existing supervisor/native Dispatch and
current-assignment reads corroborate that original Task+Dispatch as currently
approved, (iii) the original launcher is positively dead (same-namespace exit
or a distinct replacement startticks), and (iv) no terminal exists. It never
signals or displaces a live launcher: a live, unknown or past-deadline launcher
is reported nonterminal with an owner-reconciliation `nextStep`. Copied flag
strings, a historical receipt, a path or a PID alone are not current authority;
Task and Dispatch freshness stays upstream. Without that authority, continue
with the original invocation's Page and exact GitHub reconciliation; do not
infer success or retry. Wait reads the original keyed locator, handoff and
terminal beneath the same resolved durable root, including from a different cwd:

```bash
npm run --silent flow-manager-long-running-child -- wait \
  --run-identity <original-run> --attempt-identity <original-attempt> \
  --invocation-id <original-invocation-id> \
  --owner-task-id <original-approved-task> \
  --owner-dispatch-id <original-approved-dispatch> \
  --profile <original-profile> --cdp <original-cdp> --deadline-ms 5000

npm run --silent flow-manager-long-running-child -- wait \
  --run-identity <original-run> --attempt-identity <original-attempt> \
  --invocation-id <original-invocation-id> \
  --receipt-locator <resolved-state-root>/browser-gpt-receipts/<sha256-id>.json \
  --owner-task-id <original-approved-task> \
  --owner-dispatch-id <original-approved-dispatch> --deadline-ms 5000
```

Optional `--profile`/`--cdp` let an owner-run wait reattach read-only to the
exact original Page (same private profile key, CDP hash, owned target ID,
marker and bound conversation). Only two stable reads of a finished attributed
assistant generation count as `page_finished`; a missing, foreign or
unreachable Page, absent flags or an active generation is `page_unverified`,
and a redirected original conversation is `conversation_unavailable` (start a
fresh chat; advice only). The wait never sends, stops, closes or harvests.
GitHub evidence comes from the optional `github_effect_baseline` the driver
adds to the original handoff before physical SEND (exact bound PR head SHA, or
SHA-256 of the exact `--bound-issue` body). A changed exact target is
`target_progress_observed` with attribution unverified (a concurrent writer is
possible); a missing baseline, unchanged or unreadable target is
`effect_unverified`. Neither proves Send or authorship; delivery stays
`POSSIBLY_DELIVERED` unless the original record holds a verified harvested
primary. Each wait output with an owner pair carries `owner_wait` with its
effect, reason, `nextStep` and `no_signal_sent: true`.
