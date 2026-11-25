# Coordinator fleet alarm

Fleet sweep/wake is an advisory **selected-project** tick, not a continuation,
permission, reviewer, Task/Dispatch, merge, or completion authority. It reports
observed facts so the existing manager/coordinator can independently re-check
GitHub, Orca, and Browser-GPT send/no-resend state. A published review, comment,
PR head, check result or terminal incident is progress for inspection, **not**
evidence of the author's settled turn or completed task. Earlier-head green
checks never establish current-head green. No cooldown, admission, tick interval,
send ownership or scheduling policy changes in Issue #2661.

## PARKED, factual Issue Wake, and exact launching-owner incidents

A pane's last **own** non-empty content line `PARKED on <X>` classifies it
`PARKED` without a Task assignment, handoff receipt, process ID, generation
or producer completeness requirement. Ignore older/quoted/historical park
lines, newer own work and in-flight spinner lines. Preserve the incumbent final-visible `PARKED on ...` classifier, including
earlier scrollback naming a foreign tool or pane. That classifier is not proof
that an unknown park line is the agent's own outcome. Producer matches are
now **exact**, never substring or filename/attempt fallback matches.
A producer Wake is an advisory re-check, never a Browser-GPT resend.
Suspected bare-shell panes receive **no** direct text/Enter; report only the
existing coordinator-only liveness-unverified warning if available.

### Recognized producer grammar and next-tick routing (Issue #2687)

The exact supported final park forms are:

- `PARKED on GPT turn <inv>` (the ID is the **first whitespace-delimited token**;
  optional terminal `.`/`,`, trailing explanation such as `— waiting`, and
  `(self-wake armed)` do not enter its exact-match ID);
- `PARKED on GPT turns inv-a, inv-b, inv-c` (exactly three distinct IDs);
- `PARKED on review run prr-<32 lowercase hex>` (exact run ID, with optional
  ` (self-wake armed)` suffix; the line carries no head — see **Producer
  ownership** below for its H0 and status rules);
- `PARKED on pack-review PR #N head <sha40>`;
- `PARKED on PR #N review #M head <sha40>`;
- `PARKED on CI PR #N head <sha40>` (the PR-less `PARKED on CI on <sha>` and
  headless `PARKED on pack-review #N` remain recognized only to ask for an exact
  re-park, never as a completion source);
- `PARKED on merge-N`, `PARKED on PR #N merged`,
  `PARKED on #N merged into main`;
- `PARKED on terminal <handle> incarnation <id>` and
  `PARKED on merge agent terminal <handle> incarnation <id> PR #N`;
- `PARKED on orchestrator answer: <text>` (the original coordinator-owned,
  `parked:`-marked route alone handles this, with rearm only on a positively
  different answer episode; no duplicate named wake);
- `PARKED on time YYYY-MM-DDTHH:MM:SSZ` (a real strict Gregorian UTC
  deadline with seconds and `Z`);
- `PARKED on process pid <positive-PID> startticks <positive-decimal>`
  (recognized, but never a completion source; see **Time and PID**).

A GitHub API quota wait parks as `PARKED on time <core reset UTC>` from
`scripts/gh api rate_limit`; on wake, re-read, and if quota is still exhausted,
re-park on the new reset.

The former `PARKED until <UTC>` is **not** a time park and remains ordinarily
STOPPED. Old `PARKED on PR #42`, `PARKED on ci:...` and filename-, path-,
attempt- or partial-ID producer matching are **intentionally unsupported**;
none can cause a guessed direct Wake. The currently selected *native agent*
must have a positively attributable, non-running own final park-like response
for these unknowns to raise an immediate coordinator-only alarm. A mere
final visible marker, foreign/tool quote, older park followed by newer work,
question, `done`, `finished` or an unmarked status inventory cannot
establish the new own-outcome alarm. When ownness is unproven, retain ordinary
STOPPED/POLLING/busy paths, not a fabricated blocked verdict.

### Producer ownership (Issue #2840)

A sweep `PARKED` classification is an observation, not direct-send authority.
A direct named-producer Wake or correction for GPT, PR, CI, review, merge or
review-run parks needs the **parking manager**: exactly one current
selected-project/repository manager WorkerAssignment whose live exact
`orchestration worker-show --dispatch <bindingKey> --full --json` worker is
this pane's native handle, incarnation, worktree and branch, and whose park is
positively its **own final outcome**: the provenance-aware own response, or a
native OpenCode screen whose actual final `PARKED` occurrence is itself an
assistant-rendered line outside every `┃` gutter (OpenCode renders incoming
messages and tool output inside that gutter); an older equal assistant line
never vouches for a later guttered copy. A raw last
`PARKED` line from a tool result, quotation or `User:`/`Tool:` context is never
recipient authority, at selection or at the pre-send check. Duplicate rows,
an unreadable census, a replaced Dispatch/generation/incarnation or a
suspected bare shell withhold the direct send. One verification runs
immediately before the **single** native text+Enter call (assignment,
worker-show, pane, own final park and, for PR producers, the own PR head); a
`sent` mark needs the returned native `turn_started` receipt, otherwise the
mark stays `attempted_unverified`. Replacement or head movement *inside* the
native send is not observable here and is not claimed closed. Without a proven
parking manager the only route is the coordinator-only warning with "reconcile
this manager's live Task/Dispatch/pane, then re-park on a supported own
producer"; never a borrowed or different pane.

Every producer resolves to one of three findings: **own** (pending until its
exact event, then one Wake), **positively foreign** (one per-episode "park on
your own producer" correction to the verified parking manager only), or
**unverified** (coordinator-only warning; no completion and no direct send).

- **GPT.** The exact invocation ID selects the private
  `browser-gpt-receipts/<sha256(id)>.json` index read by
  `readPredecessorReceiptLocator`; its original handoff supplies
  `owner_task_id`, `owner_dispatch_id`, `launching_terminal_handle` and
  `child_cwd`. Own pending needs both owner fields equal to the manager's
  Task+Dispatch, a launching handle equal to the manager's current native
  terminal, and a child cwd in a selected-project linked worktree (it may be a
  different linked worktree from the launcher). Only a coherent **different**
  owner Task+Dispatch pair proves a foreign GPT turn. A matching pair with a
  stale, changed, missing or unjoinable launching handle, a missing, partial
  or unreadable owner pair, a missing/legacy index, an unproven cwd or an
  attempt-ID-only park is **unverified**: the coordinator is asked to
  reconcile the exact own invocation, named only as `sha256:<16 hex>` of the
  park token (the private index file name) so no untrusted token bytes reach
  the coordinator. A launcher mismatch never proves
  foreignness. A copied ID on another pane does not veto the proven owner.
- **CI, PR review and pack-review with an explicit head H0.** The live
  `pulls/N` body must have one unique `Closes/Fixes/Resolves #Issue` equal to
  the manager's Issue; a different closer is foreign, a missing or ambiguous
  closer is unverified. An open, unmerged own PR at H1 ≠ H0 gets at most one
  head-moved re-check/re-park advisory naming H1; H0 success, failure, pending
  or cancellation never transfers to H1. A closed or merged PR at a different
  head gets no moved-head advisory, only the coordinator re-park next step. At
  H0 the incumbent exact-head CI and pack-review rules apply, also after the
  PR closes or merges without moving. `PR #N review #M head H0` completes only
  when review M's `commit_id` is H0 and it is submitted.
- **PR-less and headless forms.** `PARKED on CI on <sha>` and `PARKED on
  pack-review #N` cannot invent a historic H0 or inherit a current-head
  result. A verified parking manager gets one request to re-park as
  `CI PR #N head <sha40>` or `pack-review PR #N head <sha40>`.
- **Review run `prr-<id>`.** One selected-project run record supplies H0 =
  `targetSha`. `headSha` is normalized by the production record parser, and a
  legacy record without a raw `headSha` reads back as `targetSha`; equal
  normalized values are only an internal consistency check, and an actually
  surfaced mismatch, parser-rejected record or unreadable selected-project
  run store is unverified (coordinator-only, no direct Reminder). The run's PR is
  joined through the live PR body closer above, then H0 is compared with the
  **live** own PR head: unchanged H0 reports only the run's actual terminal
  status (or the verified runner-dead diagnostic; active stays pending); an
  open own PR at H1 ≠ H0 gets only the head-moved re-check, active or
  terminal; a closed PR at a different head or a missing owner/head join goes
  to the coordinator.
- **Named merge.** `merge-N`, `PR #N merged` and `#N merged` complete only for
  an own PR (same closer rule). Waiting for another Issue's merge uses a typed
  external dependency or the coordinator, not a guessed Wake.
- **Native or merge-agent terminal.** A bare terminal has no retained
  producer Task or delegation origin, so every bare terminal park, **live or
  exited**, is **unverified**, including apparently foreign or orphan
  terminals: neither a completion Wake, a direct Reminder nor a direct foreign
  correction, and never a silent pending. The coordinator gets the
  supported next steps: the own GPT terminal envelope, an own PR merge or a
  typed external dependency.
- **Exceptions.** Strict UTC time, `orchestrator answer` and the named
  systemd/smoke unit waits keep their own deadline, coordinator-answer and
  shared-unit completion advisories without a Task ownership claim.

**GPT terminal re-check.** An own single turn (above) is eligible with its independently
parsed `TERMINAL_SCHEMA` artifact **at the indexed `terminal_envelope_path`**
containing byte-exact `observed_invocation_id`, the indexed run/attempt identity
and the present, equal indexed handoff receipt path, a recorded `cwd` equal to
the indexed `child_cwd` and a `terminal_handle` equal to the verified launching
manager terminal, and a coherent ended result
(an explicit `lifecycle_outcome` of `success` or `incident` is required; a
missing lifecycle, or `success` without a recorded turn-result state, is
uncertain, never an inferred `ok`) (`ok`, `not-sent`,
`driver_error:<cause>` or another positively terminal non-contradictory
outcome). An unmarked terminal **already present
before the first own PARKED** triggers an outcome-naming advisory on the next
tick; non-`ok` never asserts success. The existing
`terminal-path:<handle>:<path>` `sent`/`attempted_unverified` mark prevents
repeat sends across STOPPED-first delivery, PARKED/STOPPED transitions and
identical re-parks, including original-owner incident notification. Only a
distinct envelope path creates another terminal event; marks do not establish
external harvest. A triplet resolves only with **three distinct** own, exact
observed-ID/indexed-identity/settled events and remains one advisory re-check,
not three success verdicts. The `invocationId` fallback,
artifact basename/path, attempt identity, workspace regex and remote URL are
not direct completion evidence. The incumbent STOPPED-pane terminal-envelope
GPT-completion advisory uses the same exact observed ID, settled non-failure,
current native launching handle and linked selected-project Git evidence;
missing fields or attempt/basename-only IDs cannot send a legacy Wake.

For the PARKED route the indexed handoff `child_cwd`, and for the STOPPED route the
envelope `cwd`, must be a present absolute path
resolving inside the selected project's **currently linked Git worktree**.
The selected project card supplies `projectId`, verified
`primaryRoot` and `repository`; compare real paths, exact nested Git root,
common-dir identity and the primary checkout's read-only
`git worktree list --porcelain -z` membership. The child may run in an
*alternate* currently linked worktree, not necessarily the launcher's own.
Reject foreign/nested repositories, symlink or path-prefix lookalikes and
separate clones advertising the same origin. Missing/unreadable/conflicting
selected Git evidence never licenses direct completion.

**Pending versus uncertain versus settled.** A GPT turn with zero settled
envelopes is ordinary own pending **only after the pre-terminal indexed owner
proof above**; then a single in-flight turn, or a triplet with zero/one/two
settlements, retains the existing **30-minute Reminder**, not an immediate
alarm or triplet completion. That Reminder for a task-owned producer goes only
to a verified parking manager on its own pending park, with the same pre-send
check; an unverified or corrected park, and every bare terminal or PID park
(live or exited), gets no direct Reminder and keeps only the coordinator route. A missing or unreadable index, or a matching
owner Task+Dispatch with a stale, changed, absent or unjoinable launching
handle, is unverified and gets the coordinator exact-invocation reconcile step,
not a direct foreign correction. A global same-ID foreign event, filename or
attempt hint alone is not evidence that the named producer has landed. A
duplicate or contradictory associated artifact triggers one marked coordinator
evidence-uncertain alarm. Fully corroborated completed events Wake once unless the recipient/path
already has an attempted or sent mark. A coherent single non-`ok` terminal
event Wakes only to re-check its **recorded ended state**, never as a green or
successful completion assertion. Separately, the incumbent
original-receipt/current-native-owner-bound non-`ok`
`wakeOriginalTerminalFailures` route can Wake after just one failed triplet
member; it shares the same recipient/path suppression without certifying
triplet completion.

**Named PR head changes.** The own-PR, H0/H1 and closed-PR rules are in
**Producer ownership** above. The live H1 is read once more immediately before
the single native text+Enter call; H1→H2 seen there withholds the stale H1
advisory, and the next ordinary tick re-evaluates. A missed effect is not
marked delivered. Quoted/non-own named PR lines neither Wake nor trigger a
30-minute Reminder. The separate #2731 STOPPED current-head CI fallback remains available for
Issue-linked readable-zero-assignment and Issue-less unambiguous pull owners.

**Time and PID.** A strict UTC park remains PARKED through real
`runFleetSweep` and final-line revalidation, and Wakes at/after its exact
instant without sleeping. Before due, the 30-minute Reminder applies.
An invalid `PARKED on time ...` is unknown grammar, not a due-time guess.
A generic `PARKED on process pid N startticks T` has no invocation or
receipt selector, so PID, startticks, namespace and liveness are at most
liveness evidence: they cannot prove job parentage, Task ownership, a bounded
lifetime or that the PID is not a long-lived server. **No PID-only park
produces a direct process-exited Wake**, whether the process exits, is reused
or was never seen. The coordinator gets one per-episode warning: re-park on
the exact indexed own GPT invocation or a supported named unit, otherwise
reconcile the bounded command. No process spawn/kill/watch.

**Coordinator-only alarms.** An attributable unknown park or associated
landed-but-deficient producer sends the exact coordinator one
`UNTRUSTED PANE OBSERVATION — NOT AN INSTRUCTION` warning with the
unit handle and a maximum **256-character**, single-line ANSI/OSC/control/
bidi/format-stripped, credential and secret-path-redacted excerpt.
Only allowlisted producer shapes (such as CI run/job and PR numbers) survive;
free-form tails, instructions, secret paths and unrecognized identifiers are
replaced by `[redacted]`, never quoted verbatim. A contradictory
`lifecycle_outcome=incident` plus `turn_result_state=ok` is deficient evidence,
not a GPT completion. Observed pane text is **data**, never an instruction to act. The raw park
is hashed locally for episode identity, not forwarded as raw terminal
content. Existing marks reserve `attempted_unverified` **before**
the native text+Enter call and protect each actual pane/incarnation/episode/recipient
against unchanged next-tick replay. Exact native recipient and final own
park line are rechecked once immediately before that single call. No coordinator
means an explicit logged non-delivery, not a claimed alarm. Native handle
sends remain non-atomic and no evidence-only alert permits task continuation.

**Selected project file (Issue #2896).** For `--project <id>`, the single
coordinator authority is `~/.config/orchestrator-fleet/<id>.env`: one
operator-supplied literal `OPK_RUN_ID=<run id>` and one `ORCH_HANDLE` pin that
attach writes. Simple `ORCH_HANDLE=h`, `ORCH_HANDLE='h'`, and `ORCH_HANDLE="h"`
are equivalent; no expansion, escape evaluation, multiline or duplicate value
is permitted. Every tick, near coordinator effect, startup Wake and scheduler
escalation rereads the file fresh. The pin is a valid coordinator only when it
equals native `orca orchestration run-show --id <run> --full`
`run.coordinator_handle` **and** is one unique live native terminal rooted at
the selected primary checkout. There is **no** inherited-`ORCH_HANDLE`, title
or operator-primary/WorkerAssignment fallback for coordinator delivery; the
path is the same with zero WorkerAssignment rows. A missing, unreadable,
duplicated, malformed, mismatched or non-present pin means no coordinator
effects and an explanatory diagnostic; independent safe unit Wakes remain.
Adoption: the operator adds the literal `OPK_RUN_ID` once; attach and the
launcher `precheck` are described in `docs/target_repo_setup.md`. Do not
restart a service or edit a user env/drop-in.

**F7 remains evidence-limited.** Existing
`collectFleetDiagnostics`+`runFleetAlarmTick` already warns once
`suspected_bare_shell` only when the previously designated
same-handle/incarnation/worktree/branch agent is now shell-titled with readable
screen. The warning means **agent-child liveness unverified**, not `DEAD`,
and never sends into that shell. A still agent-like title returning
`agent_unverified` lacks an observable child-exit/shell witness; the
reported F7 false negative is **not fixed** and no second detector is
introduced. The normal tick remains 300 seconds unless explicitly configured
otherwise; "next tick" is not a 60-second SLA.

**Issue-directed published GitHub progress** is a narrower separate route:
current numbered WorkerAssignment must uniquely bind selected project and
repository, the exact Issue, Task, Dispatch and its current live native
worker, terminal handle, incarnation and worktree/branch. The unique current
pane must itself be PARKED and send-safe. A matching PR must have exactly
one unambiguous explicit closing target from Closes/Fixes/Resolves; `Refs #A`
alone does not bind A. Thus `Refs #A; Closes #B` admits only B;
references-only and conflicting distinct closers admit neither. A same-repo
foreign Issue comment, stale/duplicate/unavailable assignment, Run objective,
Task prose or guessed branch never selects an Issue Wake recipient. Independently
verified same-Issue new comment/review, head H1-to-H2, or a current-head CI or
pack-review change can cause one coalesced direct re-check **attempt per pane
per tick**, even if the pane's local GPT turn record is stale. The manager
then verifies the current head and its own unsent/unharvested turn separately.

**A valid not-ok terminal envelope** (`lifecycle_outcome=incident` or a
present non-`ok` `turn_result_state`) can trigger an independent direct
owner re-check. Correlate original attempt, invocation and envelope with the
original handoff receipt's invocation/launching terminal/Task/Dispatch and
corroborate the current exact selected-project native owner and assignment.
The original verified launching pane is eligible even when STOPPED, PARKED
or idle, with no named wait or cooldown expiry and no coordinator. The
reported mgr-334/`term_0dfb5c20` incident is an example, **not** a
host-reproduced cause. A bare terminal handle, envelope `cwd`, child
worktree, title or receipt hint alone cannot prove ownership. Wrong,
ambiguous, stale, recycled or unreadable identity means non-delivery;
a valid success/ok envelope does not activate this failure-specific path.
A not-ok envelope does not itself complete, fail or resend the child turn.

Every independently due direct fact uses the incumbent episode/event marks.
Persist `attempted_unverified` **before** a text/send effect; failed
reservation means zero sends. Upgrade to `sent` only after both the text
and submit actions are confirmed. Ambiguous submit or failed post-send
upgrade preserves the uncertain mark and suppresses blind replay on the
next tick; only existing positively confirmed non-delivery rearm is eligible.
Independent later facts remain eligible. Revalidate current recipient near
effect. Native sends are handle-only; in-send incarnation replacement and
cross-tick transactional exactly-once receipt are **not** proved.

## Missing units, coordinator absence, and reminders

On a complete current native/Assignment/Task/Dispatch census, confirmed
missing/gone previous panes plus positively replaceable #2655 evidence and
nonterminal Issue work may produce a **coordinator-only recovery-needed**
advisory, even with zero STOPPED panes. Unknown, partial, unreadable,
foreign or live evidence proves no disappearance or completion and never
licenses a new worker or replacement; #2655 remains the sole recovery owner.
Coordinator-only STOPPED/POLLING, PERMISSION, missing-unit and Run-mail
alarms require an exact present coordinator. With no coordinator, independently
safe exact direct-pane Wake, owner-bound banner and existing pane Reminder
can still be attempted. The tick returns `no_orchestrator` with actual
`paneWakeAttempts`, `paneWakeConfirmed` and `paneWakeNotConfirmed`
(counting every attempted pane delivery, including uncertain, with attempts
equal to confirmed plus not-confirmed); that state means **no coordinator
advisory delivered**, not that no safe pane was reached.

STOPPED/POLLING coordinator alarms are **state-change only** (Issue #2896).
Per-pane history is keyed by the pane's `[state, incarnationId]` episode,
independent of which coordinator is current, is carried across observation
gaps and is never rebuilt from the coordinator. A record of an attempted or
sent incident is kept until the pane positively reports a different state (only
never-notified records expire after 7 days, with a hard cap on record count); a
positively observed state change is recorded even while no coordinator is valid.
Opaque or unreadable saved history is unknown, not new: current incidents are
not replayed and the tick logs `alarm_history_unreadable` for manual
reconciliation. A new
coordinator, a hot repin, a restart, elapsed time or an `attempted_unverified`
timer never replays an unchanged incident: only a different pane state,
incarnation or a new fact alarms. Marks with the prefixes `terminal-path:`,
`gone-issue:` and `park-uncertain:` are sticky, so an ambiguous possible
effect is never timer-replayed; legacy recipient-suffixed `park-uncertain:`
marks are recognized by prefix. Direct unit Wakes keep their own five-minute
unverified retry. The 30-minute reminder is **removed** from the coordinator
STOPPED alarm; a reminder is otherwise a re-check,
not a forced continuation. New, attributable progress can wake early;
unchanged busy/live state grants no completion, unknown liveness is
unverified, and positively gone/incomplete work requires coordinator
investigation. A recognized PARKED pane with no due fact keeps its named producer
Reminder (task-owned producers only for a verified own pending park, see
Producer ownership); only positively owned unknown parks and positively associated
landed-but-deficient producer artifacts raise immediate coordinator uncertainty
alarms. Suspected bare shell never gets direct Wake text. Coordinator
replacement does not make unchanged alarms eligible again (see above).
PERMISSION is a distinct intervening
pane state; one-shot permission warnings do not change STOPPED/POLLING
throttle, ordinary reminders, producer wakes or the existing cooldown.
Local ChatGPT banners and Run mail retain their independent rules.

### STOPPED projections for gone owners, red required CI and lost wait processes (Issue #2896)

All three are coordinator-only advisories on the same state-change dedup.

- **Gone owner with a positively failed required check.** An existing
  gone-owner Dispatch (`alarmGoneIssueOwners` evidence) is joined to exactly one
  open PR by its unique closing Issue and the PR's current head. When a
  required check on that exact head is positively failed, the message says so
  (`STOPPED: Issue #N assigned manager is positively gone ... PR #X has
  required check ... failing on head ...`) under the existing `gone-issue:` key.
  Required identity comes from the card `requiredCi` selectors
  (`workflow / job`) or branch-protection `required_status_checks`
  (`checks[].context` with `app_id`, plus `contexts[]`); complete check-runs
  on the exact head are required and the newest run per identity decides. A
  card `workflow / job` selector is matched to the job's check suite through the
  head's workflow runs; a same-name job of another workflow, several suites for
  one identity or unreadable workflow evidence yields no red-CI claim.
  Optional, stale or unreadable data never produces a red-CI claim.
- **Lost wait process.** An own `PARKED on <process pid>` wait whose earlier
  matching live probe is retained in the parked epoch and whose later
  same-namespace probe is absent, exited or has different start ticks raises
  one coordinator STOPPED mark per exact pid episode. Promotion from the
  uncertain advisory does not retype.

Residuals: no atomic exactly-once native send, no process-liveness witness
across PID namespaces, and history that is opaque or lost is reported as
unknown rather than rebuilt.

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
tail. The sweep itself makes no Orca mutation. An OpenCode idle prompt with
model, context percentage, `esc interrupt` and `ctrl+p commands` status chrome
is **STOPPED** unless actual current-work evidence is observed; the
diagnostic `agent_unverified` reason remains a separate liveness statement.
A primary-root agent-titled pane counts as a unit **only** with the exact current
selected coordinator and `worker-list` → `worker-show` → `run-show`
Dispatch/Run/native join, even if `WORKSPACE_RE` matches the primary path.
Title-only, foreign, ambiguous or stale primary candidates are excluded;
non-primary workspace selection is unchanged.

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

A healthy tick logs `nothing stopped` when there is no newly
actionable pane. A project with no matching coordinator logs
`normal fleet result: no orchestrator pane found` only after independently
safe direct-pane Wakes/reminders/banners; coordinator-only alarms are not sent
and the result includes actual direct-pane attempted/confirmed/uncertain counts. STOPPED/POLLING alarms are per-pane and fire once per state transition.
Changes to another pane do not duplicate an existing alarm. PARKED never
causes an immediate coordinator alarm; a matching producer event sends
a direct re-check Wake to its pane, and an unresolved park receives its
existing Reminder on elapsed 30-minute slots. `suspected_bare_shell`
is the one exception: send no Wake text to the shell and alarm the
coordinator once for that pane's state change. The plain named-PARKED route uses per-(pane,event) marks, plus a shared
(handle,envelope-path) mark for exact GPT terminal outcomes; a pre-marked path
does not rearm when the pane re-parks. Named CI/pack-review Wake never claims
a superseded or unknown current head is green. Missing exact head, pane or
Dispatch/Run evidence is a logged recheck hint, not another coordinator alarm.
The separate Issue-directed and original-owner not-ok envelope routes require exact live
ownership. Failed reads suppress only routes lacking their required evidence,
not other independently safe recipient sends.

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
For `PARKED` panes, independently re-check the named dependency on
Wake or Reminder. A named obsolete PR head means re-read the current PR/head,
not that earlier or current checks are green. A previously marked GPT envelope
path must not be treated as a fresh Wake; an unmarked already-terminal single
GPT envelope can be rechecked next tick even on non-`ok`. Idle OpenCode
status chrome alone is STOPPED; primary-root units require current exact
Dispatch/Run binding regardless of workspace pattern. Never resume, resend or
merge solely because the fleet notifier reported an event. Treat bare-shell coordinator alarms as
operator investigation, never as permission to type into a shell.

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
