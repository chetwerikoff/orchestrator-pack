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

For an exactly parsed GPT-named PARKED pane, fleet wake first checks
#2478's deterministic invocation index under
`/tmp/opencode/browser-gpt-receipts/<sha256(invocation-id)>.json`. A present
index must validate the one private original handoff, run/attempt, launcher
PID and original terminal path; an invalid index never falls through to an
older lookalike envelope. The original terminal/v1 must match the original
handoff pointer and timestamps; its child cwd and launching terminal handle
are **not** native Task ownership witnesses. With no index, the exact old
#2473 unique matching observed-invocation + handle/worktree route remains.

All simultaneously observed exact native GPT-PARKED claimants are counted
before a named indexed effect. One independently bound Task/Dispatch can
qualify without optional owner IDs; multiple claimants can qualify **only**
when both caller-asserted owner Task and Dispatch IDs uniquely match one
native claimant. Ambiguous owners and mismatching assertions alarm the
coordinator, never elect a recipient by iteration order. The already-global
`gpt:<original-terminal-path>` mark has no recorded recipient: if previously
consumed, the new named Wake is suppressed with
`legacy-event-already-attempted; recipient-unproven`, even when the earlier
legacy recipient was a different launcher/child pane. Nothing clears or
reassigns that mark. If there was no indexed GPT-PARKED claimant in the
earlier tick, normal legacy delivery and consumption still apply.

An absent original envelope with sound receipt and positive PID-*exists*
observation is only provisional `pending` while the existing native park
epoch is younger than 30 minutes; reused/zombie PIDs cannot attest original
launcher identity. At 30 minutes it instead alarms
`pid-identity-unverified; envelope-absent` and retains the ordinary Reminder.
An absent PID alarms `launcher-gone; envelope-absent`; EPERM/unknown PID or
unreadable epoch alarms `launcher-identity-unverifiable`. Invalid receipt/
index, terminal identity, unsafe terminal or missing evidence use bounded
coordinator diagnostics. These are operator re-check prompts, not inferred
success, resend or recovery authority.

For a validated original terminal and an unconsumed global event, the named
Wake can send only to the uniquely eligible native Task. Its **display-only**
original absolute path is percent-encoded as UTF-8 lowercase `%xx` for
disallowed characters; the existing safe atom caps are 512 input characters
and 240 encoded ASCII characters. Unrepresentable evidence raises
`unsafe-evidence; path-unrepresentable`, with no unit send or new event mark.
A fresh read-only terminal census, own screen and native Task/Dispatch check
precedes text+Enter, and another follows the four-second delay before the
second Enter. Observable replacement before the first effect raises
`pane-changed-before-send` with zero marks; replacement during the delay
raises `pane-changed-during-wake; uncertain-unit-wake`, leaves both
pre-effect `attempted_unverified` marks and skips the second Enter. Handle-only
sends still have a non-atomic read/send race.

When a validated original indexed terminal is vetoed in the **same tick**
by owner ambiguity, unrepresentable evidence or a detectable pre-send
identity change, the subsequent independent legacy GPT route skips *only*
that terminal event before recipient selection, even if a third eligible
launcher pane matches its handle/cwd. This is an ephemeral handoff, not a
durable `gpt:<path>` mark; unrelated legacy events continue. The coordinator
gets the fixed reason and opaque episode digest, with instruction to inspect
the indexed receipt/terminal and current Task and continue/recover manually
only under existing authority. Existing 30-minute coordinator throttle,
reminders, other PARKED kinds and permission alarms remain independent.

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
