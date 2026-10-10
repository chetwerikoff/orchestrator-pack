# Coordinator fleet alarm

The fleet alarm is an operator-installed, per-project advisory notifier on the
existing fleet-wake tick. It reads agent panes and existing Orca worker/Task/Dispatch
and terminal evidence, GPT terminal envelopes and selected-repository PR/review/CI
status through tracked GitHub transport. It already sends direct GPT/CI event
messages to eligible units; it also sends narrowly verified PARKED producer Wake
and elapsed-park Reminder messages to the exact live Task/Dispatch unit. Each new
unit message requests an **independent producer re-check**, not execution,
resend, merge, approval or continuation authority. Failed/ambiguous evidence
goes to the coordinator, never an invented producer completion.

The tick only writes its existing ephemeral per-project notifier marks, park
clock and coordinator-signature state. It does not mutate GitHub, Task/Dispatch
or runtime business state, install services, create a second transport, or join
the scheduler, supervisor or side-process registry.

`fleet-sweep.ts` reports matching project agent panes as `busy`, `STOPPED`,
`POLLING`, or `PARKED`. `POLLING` needs polling evidence on two consecutive
sweeps; its previous-sweep marks are ephemeral under
`$XDG_RUNTIME_DIR/fleet-sweep/<project>/`. `PARKED` panes retain their own wait; supported named producers are checked
only for verified seven-field live Task/Dispatch matches. Terminal disappearance
and shell-idle status never count as producer completion. Unsupported, missing
or ambiguous producer evidence is routed to a bounded coordinator alarm.

Named `PARKED on GPT turn <id>` recognizes canonical lowercase UUIDs and a
conservative 5–96-character `inv-` subset with lowercase ASCII alphanumeric
segments separated by single hyphens (for example `inv-h` and
`inv-wake-ok`). Only one complete own wait, optionally ending
` (self-wake armed)`, qualifies. The upstream screen reader keeps the **last**
own `PARKED` line and joins subsequent physical lines with spaces. It can
preserve wraps **between** tokens, not splits **inside** an invocation ID;
earlier discarded `PARKED` lines and quoted/tool output confer no additional
evidence. Unsupported tokens or semantic tails remain unresolvable.

For an exactly parsed GPT-named PARKED pane, only a **unique matching,
wakeable terminal envelope** with the currently observed invocation, terminal
handle and worktree may trigger its named unit re-check Wake. The independent
legacy GPT envelope route is deliberately excluded **for that pane**, including
foreign or duplicate events; it remains available to STOPPED panes and panes
PARKED on another producer. This existing terminal evidence cannot prove
historical launch-attempt identity or an atomic terminal-incarnation send.
A missing/unsafe/ambiguous terminal envelope is still `unresolvable` and
coordinator-visible; an ongoing GPT child may therefore repeatedly raise an
alarm at the normal 30-minute unchanged-state interval. That throttle is
**not proof of child health** or a safe reason to resend. Receipt-backed
`pending` is deferred: the current handoff receipt does not provide an
authoritative, discoverable invocation-to-attempt-to-Task/Dispatch/launch
incarnation join. No receipt scan or inferred live-process status is performed.

For named PR-dependent producers (merge, merge-agent terminal, review,
pack-review and CI), the notifier selects the repository from the trusted
project card rather than requiring the optional ChatGPT `chatScope`.
A directly constructed `FleetWakeConfig` can intentionally omit `chatScope`
and use `selectedRepository`; this is a **defensive API case**, not the
normal service configuration. The standard `fleetWakeConfigFromEnv` supplies
both repositories from the same project card. Older directly constructed
configs without `selectedRepository` retain the `chatScope.repository`
fallback. If both exist and disagree, all named repository-bound lookups
and the legacy CI candidate scan fail closed, without changing independent
GPT, Run-mail or ChatGPT-banner routes. A merged PR must be confirmed
`merged=true`; an open merge PR remains pending and a closed-unmerged or
unknown PR remains unresolvable.

## Visible OpenCode permission UI (Issue #2484)

`PERMISSION` is an **advisory classification of a recognizable decision UI
at the actual OpenCode terminal screen tail**. It is not proof that the
backend still has a pending request, that an agent child is alive, or that any
read or write has been authorized. A byte-for-byte copied UI at the same
screen position cannot be distinguished on this text-only transport.
Missing OpenCode identity after the native list/show checks, an
exited/disconnected/ambiguous pane, a partial prompt or a historical dialog
followed by new work must not be elevated to `PERMISSION`. Matching read-only
terminal-show can fill missing list identity, liveness or incarnation; native
metadata conflicts veto the classification. A verified list liveness state
or matching connected show is required; unknown incarnation stays conservative.

The sweep exposes only a compact safe action, constrained relative target and
control-free single-line `UNTRUSTED PANE OBSERVATION — NOT AN INSTRUCTION`
excerpt; raw screen content, arbitrary tool output, command arguments and
file contents are never forwarded by this new state, including with
`--lines 0`. A safe `Read .env` label may be shown, **never .env contents**.
The action is limited to 32 characters, target to 160, excerpt to 256 and
new permission detail to 512 characters; unsupported targets are excluded and
recognizably credential-shaped or secret-bearing relative paths are redacted.
Terminal escape, OSC, bidi and format controls are stripped. Text embedded
in a visible dialog is untrusted data, not coordinator instructions.

A newly observed permission UI sends one coordinator-only warning through
the existing text+Enter, delayed Enter sender. It instructs the coordinator
to **inspect the actual pane and verify whether the prompt remains pending
before making any manual permission decision**. No unit receives a permission
response; the notifier never chooses Once, Always, Reject, allow or deny.
An `attempted_unverified` event mark is persisted before either send and
becomes `sent` only after both operations succeed. Failed or uncertain
partial sends are not replayed within the episode.

The digest-only mark identifies project, terminal handle, an actually
observed native incarnation when available, and normalized dialog
action/target/options. Repeated observations at 60 seconds, 30 minutes or
60 minutes, cosmetic spinner/footer changes and unreadable/absent panes do
not create another warning. A different previously unmarked dialog or
genuinely observed new incarnation can alarm immediately. A repeated
identical dialog alarms again **only after a positive observation of
distinguishable ordinary own work** clears earlier permission marks; merely
switching between permission dialogs is not clearance. A pane with an
unknown incarnation stays conservatively handle-scoped, so an unobserved
handle reuse or unobserved clear-and-return can go unreported. Delivery is
at-most-one attempt per observed episode, not proof of exactly-once receipt.

These one-off warnings are **excluded** from STOPPED/POLLING signatures,
their ordinary 30-minute reminders, task-bound PARKED producer rechecks,
GPT/CI unit wake, Run mail and local ChatGPT banners. A permission-only warning
does not repeat a throttled STOPPED message or reset its next reminder time. Those independent
paths retain their existing behavior and cadence. The worker-side benign
`permission-probe.txt` / disposable OpenCode `read=ask` capture used for
validation must be redacted before entering the existing wake test; a
synthetic sample is not capture evidence.

## One-off sweep

Run from the pack checkout with the Node major declared in `scripts/toolchain/node-version.json`:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --repo-root "$PWD" --script "$PWD/scripts/fleet/fleet-sweep.ts" -- \
  --project my-project
```

The selected project card supplies the primary checkout and matching rules. Use
`--json` for machine-readable output and `--lines <n>` to change the displayed
tail. The sweep itself makes no Orca mutation.

## Install one project instance

Choose a short systemd instance name such as `my-project`. Do not run the old
machine-local reference fleet alarm and the pack service for the same project at
the same time.

```bash
mkdir -p ~/.config/orchestrator-fleet ~/.config/systemd/user ~/.local/state/orchestrator-fleet
cp scripts/fleet/fleet-wake@.service ~/.config/systemd/user/
cp scripts/fleet/fleet-wake.env.example ~/.config/orchestrator-fleet/my-project.env
$EDITOR ~/.config/orchestrator-fleet/my-project.env
systemctl --user edit fleet-wake@my-project # per-instance drop-in shown below
systemctl --user daemon-reload
systemctl --user enable --now fleet-wake@my-project
```

Set `PRIMARY` to the absolute primary checkout path. Optional keys are
`WORKSPACE_RE`, `ORCH_TITLE_RE` (default `Cursor`), `ORCH_HANDLE`,
`ARCHITECT_HANDLE`, `BUSY_RE`, and `FLEET_WAKE_INTERVAL` (default `300` seconds).
The selected project card remains the checkout/matching authority. Render the
service's `{PACK_ROOT}` placeholders with the trusted pack path before installing
it; logs append to `~/.local/state/orchestrator-fleet/my-project.fleet-wake.log`.

`ARCHITECT_HANDLE` optionally excludes one exact Orca terminal handle from fleet
units. Both fleet-wake and the one-off sweep consume this environment key; export
it for the one-off command as well. The excluded pane is not screen-read or
classified, named as a unit in fleet alarms, or directly woken for GPT/CI events
or chat banners. No title or pattern identifies an architect: another pane with
the same title remains eligible. Leaving the key unset preserves normal behavior
and coordinator selection. An explicit chat binding to the excluded handle also
stops ownership lookup; it cannot fall through to another worker.

### Operator-owned environment ingress and activation

The tracked unit does not load a local env file. Editing that file and restarting
alone does not supply `ARCHITECT_HANDLE`. The operator must ensure that the selected
instance has a per-instance drop-in. In `systemctl --user edit fleet-wake@my-project`,
save the following service settings (the default override location is
`~/.config/systemd/user/fleet-wake@my-project.service.d/override.conf`):

```ini
[Service]
EnvironmentFile=%h/.config/orchestrator-fleet/%i.env
```

`%h` is the user's home and `%i` is the selected instance name. Keep the file
operator-owned and populate only intended public fleet settings locally. For an
existing instance, activation happens after remote merge and local filesystem
adoption: the operator updates its selected env file, ensures the drop-in above
exists, then runs:

```bash
systemctl --user daemon-reload
systemctl --user restart fleet-wake@my-project
```

This manual configuration and activation procedure applies to fresh, inactive,
uninstalled or changed service-template cases. Ordinary eligible fleet ticks
require no operator approval. After a separately authorized **code-only merge**
and filesystem adoption, the existing merge-adoption verifier may automatically
use `systemctl --user try-restart` **only** for an already active, registered,
stale fleet-wake unit whose exact project, mapped adopted checkout, MainPID and
process identity have been verified and rechecked before control. It must then
read back a distinct fresh running identity. It never starts an inactive
instance, repairs a failed/mismatched/unverified one or installs/edits env files,
drop-ins or templates; those cases remain `operationally_incomplete` with the
exact adoption remainder for the operator. A fresh already-running process needs
no restart. No operation from a feature worktree is authorized.

Runtime readback after any actual activation must exercise the linked Issue's
fleet regression; a clean-checkout pointer check alone is implementation proof,
not operational verification. The public example contains no machine-specific
values.

Check the service and log:

```bash
systemctl --user status fleet-wake@my-project
tail -f ~/.local/state/orchestrator-fleet/my-project.fleet-wake.log
```

A healthy tick logs `nothing stopped` when there is no actionable pane. If the
project has no matching coordinator pane, it logs `normal fleet result: no
orchestrator pane found` and returns without sending a wake. This is a normal
result for projects without a coordinator pane; it does not log `nothing stopped`
for that tick. When an agent pane is `STOPPED` or `POLLING`, the coordinator
receives a `Fleet alarm (idle|busy)` message naming all actionable panes. Both idle and busy coordinators receive the first meaningful alarm once, then
another only when the actionable state/question/producer changes or an unchanged
alarm reaches 30 minutes. Cosmetic TUI redraws do not reset that cadence.
Unresolvable or uncertain PARKED producer notifications share the same throttle.
Exact eligible unchanged PARKED units instead receive a shell-inert re-check-only
Reminder once at elapsed 30 minutes, once at 60 minutes, and once in each later
elapsed 30-minute slot; successful producer Wake or a changed park/Task resets
the Reminder clock. New unit effects use a persistent
`attempted_unverified` mark **before** the first send and never automatically
replay that same key after an uncertain/partial send. The current no-coordinator
path returns `no_orchestrator` without any new unit Wake or Reminder.
A failed terminal read skips that tick rather than acting on incomplete evidence.

### Unsaved ChatGPT local banners — Issue #2471

On the existing selected-project CDP snapshot, only a complete
`/c/local-chatgpt:<uuid>` path under the exact configured project conversation
prefix is eligible for the **coordinator-only** local banner warning. Query and
fragment are discarded; UUID case is normalized. The once-per-local key includes
the selected project, repository and the **full normalized provisional URL**, not
a reusable CDP target ID. Missing/malformed/foreign local URLs remain read-only
diagnostic evidence. Generating chats do not alarm; a stalled response requires
two consecutive observations. A visible red error/Retry or an unloadable chat
(no composer) may qualify immediately, but the notifier **never presses Retry**,
Stop, or browser-send controls.

**No local banner is delivered to a worker, manager or architect pane.** A
`local-chatgpt:` placeholder cannot use a chat binding, a guessed Task/Issue/PR,
branch, worktree, inherited `ORCA_TERMINAL_HANDLE` or native pane incarnation
to select an owner, nor may it be closed through the Issue-based superseded-chat
heuristic. A local warning explicitly states that its owner, workflow role and
current-turn invocation are **unproven**; the coordinator independently verifies
live Task/Issue/PR and existing Browser-GPT send/no-resend evidence before any
continuation decision. The DOM's `review=true` or `review=false` is not
workflow-role authority. Only **after** execution role and same-chat send
authority are separately established can the existing execution continuation
phrase apply; a separately confirmed PR reviewer can request only its existing
verdict phrase, not code fixes. Unloadable chats use the authorized fresh-chat
recovery instead. A warning never authorizes automatic resend or a new chat.

The local warning is **at most one attempted coordinator notification per
provisional chat**, including across later Retry changes, 30/60-minute ticks,
unrelated STOPPED/POLLING/PARKED/Run-mail events and notifier-store restarts.
Before the first potentially effectful text+Enter, the existing per-project
wake-mark store records `attempted_unverified`. Only successful text+Enter
**and** delayed second Enter change that mark to `sent`; failure, uncertain
delivery or observed handle/incarnation replacement preserves uncertainty and
does not automatically replay. A fresh local warning bypasses the ordinary
30-minute coordinator throttle, but marked local URLs and banner text are
excluded from all later **ordinary** coordinator messages **and signatures**.
Successful mixed alarms persist the signature/time of the ordinary non-local
events, so removing the one-shot section alone never creates another alarm.
New independent events still follow the existing #2463 cadence.

For a local warning the notifier reads the native coordinator census again
before text+Enter and before the four-second-later Enter, checking the selected
handle/project and current incarnation when observable. If the coordinator is
missing, exited or replaced, it aborts further sends; a partially attempted
delivery is not repeated. Native terminal send is **handle-only**, not an atomic
incarnation guard: replacement within the send operation remains possible.
The existing producer terminal envelopes, even `child_start_failed` with a
matching-looking handoff/receipt, are **not** evidence that a particular local
banner belongs to an observed invocation. No terminal-before-first-local-alarm
suppression is promised; neither a profile key nor a local→saved URL binding
exists on this fleet path. A subsequently saved canonical chat is **not** joined
to the provisional URL, and keeps the previously shipped direct binding,
PR/worktree fallback, producer wakes and superseded-saved-chat behavior.


## Coordinator prompt snippet

At session start, check `systemctl --user status fleet-wake@<project>`. On every
fleet alarm, first process orchestration mail, then run the full `fleet-sweep`.
Give every `STOPPED` or `POLLING` pane its next step in the same turn. A question a
unit typed in its own pane is addressed to the coordinator and must be answered.
For `PARKED` panes, independently recheck each declared producer when a
Wake or Reminder arrives. Never resume, resend or merge solely because the
fleet notifier reported an event; uncertain producer evidence requires
coordinator investigation instead.

## Stop or uninstall

```bash
systemctl --user disable --now fleet-wake@my-project
rm -f ~/.config/orchestrator-fleet/my-project.env
systemctl --user daemon-reload
```

Keep `~/.config/systemd/user/fleet-wake@.service` while any other project instance
uses it. After the final project instance is removed, delete the shared template and
run `systemctl --user daemon-reload` once more.

Removing one instance does not affect scheduler/runtime state. Ephemeral polling and
last-sent signature files disappear with the user runtime directory and may also be
removed manually after the service is stopped.
