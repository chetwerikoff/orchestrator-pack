# Worker smoke testing (Issues #1061, #1138, and #1343)

Workers prove operator-visible behavior with a **head-bound Orca smoke run** before
`ready_for_review`. CI remains mandatory and separate. Issue #1436 distinguishes the
implementing worker's smoke from the later independent smoke. Issue #1138 adds progress-aware
deadlines, durable spawn state, cooperative cancellation, deterministic recovery, and an
orthogonal lifecycle-cleanliness gate without changing Browser-GPT transport. Issue #1343
changes readiness evidence from one latest all-covering report to a trusted point-in-time fold of
canonical reports on one exact PR head.

## When smoke is required

| Issue body signal | Worker gate |
|---|---|
| No `smoke-test-plan` fence + `smoke-plan-floor` grandfather marker | Smoke not required (legacy queue only) |
| No `smoke-test-plan` fence on an action-producing Issue without grandfather marker | Smoke required; missing plan blocks handoff |
| `smoke-test-plan` with `not-applicable: true` + reason | Smoke skipped |
| `smoke-test-plan` with scenarios | Smoke required for the current PR head |

New action-producing tasks must declare a plan during authoring:

```bash
node scripts/draft-discipline.mjs smoke-test-plan --draft path/to/issue-body.md
```

Routine and complex smoke profiles come from the live process environment for the existing `PACK_EXECUTOR_SMOKE_*` names; `worker-smoke-run` does not load the gitignored local configuration file.

## Multi-agent smoke executor policy

`scripts/executor-profile-policy.ts` is the single tracked semantic owner for both
routine and complex smoke profiles. The smoke launcher consumes its descriptor,
validation, translation, catalog, and refusal semantics; this runbook does not
reimplement them.

The existing smoke profile triples stay unchanged. On the smoke surface the closed
agent-token set is `cursor` and `opencode`. Cursor continues through the existing
`agent` executable surface and keeps its historical opaque model/effort translation
inside the shared Cursor translator. OpenCode carries model and effort together through a pack-composed inline agent definition supplied via `OPENCODE_CONFIG_CONTENT` as `{"agent":{"<pack-agent-name>":{"model":"<model>","variant":"<effort>"}}}` and spawned as `opencode --agent <pack-agent-name>` on the top-level surface, with no `--model` or `--variant` flag. Model catalog checks are executor-specific: Cursor uses the Cursor model catalog; OpenCode uses `opencode models`.

A semantically valid OpenCode profile is not automatically spawnable. Before child
creation, `worker-smoke-run` obtains fresh non-mutating evidence from the spawned top-level surface — `opencode --help` (stdout+stderr, proving `--agent`), `opencode models --verbose` (proving effort is an available variant), and `opencode debug agent <pack-agent-name>` run with the inline definition (proving the resolved agent carries both) — and admits the spawn only if the observed route can carry both values. Probe surface must equal spawn surface; both edges capture stdout and stderr for every capability probe (catalog read stays stdout-only). Missing route support fails with `executor_route_unavailable`; a model-capable route without an effort channel fails with `executor_effort_channel_unavailable`. The launcher does not fall back to Cursor, drop effort, infer support from package presence, or invent an unsupported flag.

Cursor smoke route compatibility remains code-owned and does not gain a fresh route
probe. Both executor families still require the selected profile to be inherited by
a child before spawn. The inline definition is carried as an `OPENCODE_CONFIG_CONTENT` prefix in the composed command string, so the conditional RuntimeAdapter env seam remains unchanged.

Firefighter execution still chooses the existing routine or complex smoke profile.
There is no separate `PACK_EXECUTOR_FIREFIGHTER_*` profile or bypass around this
policy.

## Actor ordering

The two smoke actors are separate:

1. **Worker-owned smoke** is the implementing worker's exact-head gate. It runs
   after implementation and before pack-review, and the worker fixes and repeats
   it until that exact head passes.
2. **Independent smoke** is a separate post-review actor. It runs only after
   every tier/cap-governed pack-review obligation has settled.

The enforced order is:

```text
implementation
  -> worker-owned smoke PASS
  -> pack-review cycle
  -> review finding: fix + worker-owned smoke PASS + next review cycle
  -> review obligations settled
  -> independent smoke
  -> independent finding: fix + fresh independent smoke
  -> completion
```

Pack-review admission refuses an exact head without a passing worker-owned
smoke. Independent-smoke dispatch refuses unsettled review obligations. Once
independent smoke has started, pack-review remains forbidden, including after an
independent-smoke fix. A fresh head after an independent finding therefore gets
fresh independent smoke, not another review cycle.

## Pre-smoke prerequisite preparation (parent worker)

Before invoking `worker-smoke-run run`, the parent worker MUST make the environment capable of
executing the real Issue-declared scenarios. The smoke child is not responsible for discovering or
creating missing external prerequisites after launch.

### Smoke-parent first-attempt bootstrap

The parent must pass two independent gates before the first smoke child is
created: dependency/setup readiness and executor-profile readiness. A passing
worker-profile proof does not prove the smoke profile, and a ready worktree
does not prove that a child inherits the profile.

For a fresh smoke worktree, use the existing Orca setup path and continue only
after its successful setup/ready receipt:

```bash
orca worktree create \
  --name <worktree-name> \
  --repo <repo-selector> \
  --base-branch <base-ref> \
  --issue <N> \
  --setup run \
  --json
```

When the smoke parent is using an existing delivery worktree, positively bind it
with `orca worktree current --json` and re-read the already-recorded setup-ready
result; current-worktree binding alone is not setup readiness. A failed,
incomplete, or unknown setup result blocks smoke before child creation.

After setup and all Issue-declared external prerequisites are ready, export the
selected routine or complex triple into the same launching process. Do not print
concrete values, source them inside the smoke launcher, or split export and launch
across unrelated terminal/tool calls. `worker-smoke-run` itself validates the
selected triple, executor-specific model catalog, fresh route capability where
required, and child inheritance before any smoke spawn. A failure reports the first
profile/capability blocker and creates no smoke child.

Only after setup readiness and external-prerequisite readiness, invoke the existing
smoke command in that same exported environment:

```bash
export PATH="$PWD/scripts:$PATH"
worker-smoke-run run \
  --issue <N> \
  --pr <PR> \
  --head-sha <40-hex> \
  --smoke-complexity <routine-or-complex> \
  --smoke-actor worker-owned \
  --issue-body-file <issue-body-file> \
  --repo-root "$PWD" \
  --cwd "$PWD"
```

Do not add a profile loader, fallback, retry, second selector, or alternate executor
when pre-launch admission fails. Fix the selected operator-local profile or the
external installed capability and make a fresh attempt.

The parent worker must:

1. inspect the current Issue `smoke-test-plan`, every declared scenario, and any named
   skill/runbook/tool contract;
2. derive a concrete prerequisite inventory, including external services, fixtures, credentials or
   account state, listeners, browser conversations, and other long-lived resources required by the
   scenarios;
3. provision each required prerequisite through the repository-approved skill or tool and retain
   its ownership identity or handle so only that resource can be maintained and later cleaned;
4. verify an observable readiness condition for every prerequisite before smoke admission;
5. keep every prerequisite available from before the smoke command is invoked until that command
   terminalizes and ownership-scoped smoke cleanup completes; and
6. refuse to launch smoke and report the concrete blocker when any prerequisite is absent,
   ambiguous, unhealthy, or expected to expire before the lifecycle can finish.

For resources with a TTL, select a lifetime that covers at least the four-hour absolute lifecycle
ceiling plus the two-minute cooperative shutdown bound and a practical setup/teardown margin. An
approved non-disruptive retention mechanism may be used instead, but it must not execute a smoke
scenario, change the behavior under test, or write child-owned progress/completion evidence.

Example: when a scenario requires a separate active browser conversation, use the approved browser
skill or tool before smoke launch, create or select a dedicated owned chat, verify that it is usable,
and keep that chat active for the full prerequisite lifetime. Do not reuse the smoke child’s owned
tab or an unrelated user chat. Clean only the dedicated prerequisite resource after the smoke
command and owned lifecycle cleanup have finished.

Preparation supplies capability, not the expected result: it must not perform the declared scenario,
pre-satisfy the assertion being tested, fabricate smoke evidence, or mutate child-owned
`progress.ndjson`, completion bodies, or seals.

Responsibility remains split as follows:

- the parent worker provisions, verifies, retains, and later releases external prerequisites;
- `worker-smoke-run` owns profile admission, child creation, prompt delivery, observation, lifecycle
  state, report publication, cancellation, and owned-terminal cleanup; and
- the smoke child executes the declared scenarios and produces progress/completion evidence.

## Supported worker path

```bash
export PATH="$PWD/scripts:$PATH"
worker-smoke-run run \
  --issue <N> \
  --pr <PR> \
  --head-sha <40-hex> \
  --smoke-complexity <routine-or-complex> \
  --smoke-actor worker-owned \
  --issue-body-file /tmp/issue-body.md \
  --repo-root "$PWD" \
  --cwd "$PWD"
```

The post-review actor uses the same bounded launcher and exact target binding,
with `--smoke-complexity` set to exactly `routine` or `complex`, but must opt
in explicitly with `--smoke-actor independent`:

```bash
worker-smoke-run run \
  --issue <N> \
  --pr <PR> \
  --head-sha <40-hex> \
  --smoke-complexity <routine-or-complex> \
  --smoke-actor independent \
  --issue-body-file /tmp/issue-body.md \
  --repo-root "$PWD" \
  --cwd "$PWD"
```

The launcher
admits that actor only after the existing pack-review authority records settled
obligations; it records a started independent attempt before child creation and
binds the final PASS to that attempt's exact head.

The supported lifecycle is:

1. `orca worktree current --json` positively binds the supplied cwd to the existing
   Orca-managed worktree.
2. A smoke-only admission lock is acquired. Deterministic preflight classifies and safely
   cleans prior worker-smoke state before any new child is created.
3. The run id, run directory, and `lifecycle.json` reservation are durably written before
   terminal creation. The create subprocess has a finite timeout.
4. A successful create response must return a terminal handle. That handle is written to the
   same registry before prompt delivery; no title/list/recency heuristic may replace it.
5. Publish-complete delivery and sealed current-run completion retain the Issue #1115 contract.
6. After delivery, only legal child-produced declared-scenario transitions refresh the stall
   deadline. A separate absolute safety ceiling is never reset.
7. Every terminal path converges on the same cancellation/cleanup routine. Only the recorded
   handle may be closed. Operator-action files are tombstoned and `terminal.json` records the
   result even when no PR smoke report is published.
8. The PR comment is published only after owned-terminal cleanup. `gate-check` independently
   requires exact-target smoke evidence, current-head CI, and clean lifecycle state.

## Report admission and trust boundary

`gate-check` first resolves one trusted target: canonical repository slug, positive exact Issue and
PR numbers, full requested head SHA, the fetched exact Issue body, the PR-to-Issue closing relation,
and the live PR head. The repository view, origin remote, Issue URL, and PR URL must agree. Missing,
ambient-only, multiple, stale, or mismatched identity is non-accepting before any report contributes.

The report census comes from the exact PR issue-comment endpoint. `gh api --paginate --slurp`
exhausts and flattens every page; malformed pages, duplicate comment ids, missing metadata, parse
failure, or inability to stabilize the snapshot fail closed. The gate compares bounded repeated
complete censuses. It evaluates only after two consecutive canonical snapshot digests agree and
revalidates the live PR head before returning allow.

A comment is eligible only when GitHub actor metadata matches the authenticated principal used by
the current publication path. Body fields such as `producer`, `terminal-handle`, and
`orca-executable` remain mandatory report invariants, not authentication. A matching body from
another actor is a non-candidate. A trusted report comment with `updated_at != created_at` is
invalid. Privileged deletion and trusted-account forgery remain outside this evidence model; the
current census cannot prove deleted history.

A canonical current-target candidate has exactly one `pack-worker-smoke-report/v1` marker, one
`worker-smoke-report` machine block, and one non-conflicting Issue/PR/head binding. Duplicate or
mixed markers, blocks, target lines, or scenario tuples invalidate the whole candidate. PASS,
FAIL, and BLOCKED use the same admission floor: expected producer, non-empty executable and terminal
handle, unmodified tracked files, accepted owned-terminal cleanup, and complete rows with action,
expected, observed, and a supported outcome. Top-level PASS additionally requires every included
row to pass. An invalid candidate contributes no row observation.

The singular local receipt remains the current-publication witness used at the final gate. It is
not historical authority for earlier aggregate contributors and does not order comments.

## Exact-head point-in-time coverage

The current Issue plan is folded by the exact trimmed `(action, expected)` tuple. Canonical
candidates are ordered by GitHub `created_at`, then numeric comment id. Report-local timestamps,
run start order, terminal order, receipt write order, API array order, and local clocks are not
authority.

For each current tuple, the latest admitted-valid row wins:

- `pass` covers the tuple;
- `fail`, `blocked`, or `skipped` leaves it uncovered;
- a later `pass` restores coverage; and
- omission preserves the prior latest row.

PASS observations may accumulate across several canonical comments on the exact same head. A
single ordinary all-PASS report is still sufficient. A valid top-level FAIL or BLOCKED applies its
valid matching rows and sets a global non-accepting block even when it contains zero current-plan
tuples. An admitted-invalid current-target candidate also sets that block without changing row
state. A later admitted top-level PASS clears the global block; omitted tuples retain their prior
row state.

A different full head SHA starts from zero. Old-head reports cannot contribute, revoke, restore,
quarantine, or appear in current-head candidate diagnostics. On a same-head Issue edit, unchanged
exact tuples retain observations, changed and added tuples start uncovered, and removed tuples
disappear. This is tuple-local reuse, not a hidden whole-plan revision claim.

The semantic authority point is the final stabilized census used by one gate invocation. A relevant
publication observed while stabilization is in progress forces a complete re-evaluation or bounded
denial. A comment published after the final stable observation belongs to the next invocation and
does not retroactively rewrite an already-emitted `ready_for_review` record.

Partial coverage is never autonomous-ready. Machine-readable diagnostics include the target,
scenario count, covered tuples, missing tuples, latest non-PASS tuples, invalid/rejected candidate
reasons, global block, and complete/partial state. Each collection emits at most 50 items with the
complete total and explicit truncation/overflow flags. Tuple previews and free-form reasons are at
most 256 UTF-8 bytes per item, and the serialized diagnostic payload is at most 64 KiB. These caps
never truncate the internal census or tuple fold.

This evidence gate applies to autonomous `ready_for_review` admission. It does not create a waiver,
approval token, second authorization service, or unavoidable veto over a direct top-level operator
command. Evidence and diagnostics remain truthful in every path.

## Report and control-plane semantics

Top-level `PASS | FAIL | BLOCKED`, pack-generated non-PASS causes, and control-plane diagnostics
remain unchanged for each individual run. Pack-generated non-PASS causes continue to include zero
parsed scenarios, missing/invalid agent reports, and executed scenario failures. The aggregate does
not claim that separate comments prove distinct fresh agents or retain a per-run attestation; fresh
disposable-agent creation and cleanup remain lifecycle responsibilities.

Issue #1125 control-plane classification also remains unchanged:

| Phase | Stable cause |
|---|---|
| `worktree current` or terminal create cannot launch, returns empty stdout, or returns malformed JSON before a handle is acquired | `orca_control_plane_unavailable_preflight` |
| send/read/submit/close returns a recognized channel code after a handle is acquired | `orca_control_plane_lost_mid_smoke` |

`orca worktree current` is still the only positive worktree authority. The harness does not
restart Orca, reconnect, discover sockets, select another worktree, or promote arbitrary valid
JSON errors into a control-plane cause.

## Delivery and completion authority

Each attempt has one run identity. Delivery requires `delivery.sealed.json` bound to that run;
`terminal send` success alone is not proof. Ambiguous delivery never authorizes a full-prompt
resend. The existing visible-bracketed-paste recovery may submit Enter without re-sending text.
Delivery establishment is separately bounded to **10 minutes** and cannot be extended by scenario
progress that has not begun.

Completion is accepted only from one publish-complete current-run pair:

```text
completion-<sha256>.body
completion-<sha256>.sealed.json
```

The seal must bind the current run and exact body digest. Partial bytes, PTY text, in-memory
lookalikes, wrong-run artifacts, malformed reports, and duplicate terminalizations do not become a
PASS. PTY reads remain secondary liveness/diagnostic evidence only.

## Finite scenario progress and deadlines

After delivery, the child appends progress events to `progress.ndjson`. For each Issue-declared
scenario ordinal, the only accepted sequence is:

```text
not_started -> started -> terminal(pass|fail|blocked|skipped)
```

An event advances progress only when it is durable, binds the current run, names the next declared
ordinal, and is the next legal transition. The following never refresh stall age:

- wrong-run or stale bytes;
- unknown ordinals;
- duplicate or backward transitions;
- terminal-before-start, post-terminal, or non-monotonic transitions;
- free-form milestones, heartbeats, mtime/byte growth, PTY chatter, or process liveness;
- anything written by the supervisor.

Production defaults:

| Bound | Default | Meaning |
|---|---:|---|
| terminal create | 60 seconds | `spawnSync` cannot block the parent indefinitely |
| delivery | 10 minutes | delivery must seal before scenario waiting starts |
| progress stall | 25 minutes | no accepted declared-scenario transition during this interval terminates as `progress_stall` |
| absolute lifecycle ceiling | 4 hours | terminates as `absolute_safety_ceiling`; progress never resets it |
| cooperative shutdown | 2 minutes | bounded wait for child acknowledgement or sealed completion before handle close |

The absolute ceiling starts with lifecycle reservation/create and is not granted again after
another phase. A legal slow plan may therefore run beyond the former 30-minute wall, while true
stall and absolute-ceiling outcomes remain mechanically distinct.

## Child-only progress and cancellation protocol

The smoke prompt names the run-local progress, cancel-request, and acknowledgement paths. The
registered child must:

1. append `started` before each declared scenario;
2. append one terminal outcome after that scenario;
3. check `cancel-request.json` between scenarios, before each new Browser-GPT turn, and immediately
   after an already-started turn returns;
4. after cancellation, start no new scenario or turn and write current-run cancellation
   acknowledgement or ordinary sealed completion.

The supervisor may create the run, deliver/nudge the prompt, observe durable artifacts, write the
cancel request, wait, and clean the bound child. It has no production path that writes accepted
progress or completion. Browser-GPT send-once, owned-tab, sibling-independence, and final-capture
behavior remain owned by Issues #1120 and #1140 and are not reimplemented here.

## Durable spawn state and ambiguity recovery

`lifecycle.json` records a finite per-run state such as reservation, create in progress, bound,
ambiguous unbound, cleanup pending, clean, or cleanup failed. It is not a lease, daemon, heartbeat,
global process database, or general scheduler.

When create times out, is cancelled, returns no output, returns malformed output, or otherwise
cannot prove a handle, the reservation becomes `ambiguous_unbound`. On a later supported preflight
it may become `abandoned_unbound` only when all current-run evidence says execution never began:

- no handle was durably bound;
- no delivery seal exists;
- no accepted progress exists;
- no completion seal or cancellation acknowledgement exists.

The original ambiguity diagnostic remains durable. Any unattributable terminal is left alone:
without a bound handle the parent never delivered the prompt, so it neither adopts nor kills that
terminal. Any delivery/execution evidence forbids abandonment and keeps the state blocking.

## Cancellation, cleanup, and restart recovery

Cancellation, operator stop, supported termination signal, delivery exhaustion, progress stall,
absolute ceiling, child verdict, handled exception, and restart recovery use one ownership-scoped
cleanup contract:

1. stop admitting new scenario work;
2. write an idempotent current-run cancel request when an active child is being stopped;
3. wait at most the shutdown bound for child acknowledgement/completion;
4. close only handles durably recorded in that run registry;
5. tombstone `live/OPERATOR-ACTION-*.txt` before declaring the run clean;
6. write `terminal.json` with reason, acknowledgement observation, close outcome, and cleanup
   result;
7. remain idempotent on retry: a clean/abandoned entry is not closed or terminalized again.

No terminal-list lookup, title matching, process scan, or recency heuristic is cleanup authority.
Unrelated or unattributable Browser-GPT work is never killed, adopted, or made blocking merely
because it exists.

## Deterministic preflight and concurrent starts

Before create, preflight performs one bounded classify/clean/re-evaluate pass:

- stale smoke admission owned by a dead supervisor may be removed;
- safely removable operator files are tombstoned;
- expired unbound create reservations are classified and abandoned only under the evidence rules
  above;
- bound/incomplete prior runs are closed by their recorded handle only;
- corrupt state, failed close, executable ambiguous state, or unsafe routing state remains blocking.

Admission uses a worker-smoke-only create-once lock. At most one concurrent `worker-smoke-run run`
may cross the spawn boundary. The loser refuses without touching the winner. This is not a global
Browser-GPT lock and does not serialize unrelated browser work.

## Readiness gate

`pack-worker-report --state ready_for_review` invokes `worker-smoke-run gate-check`. Handoff is
allowed only when all independent predicates hold:

- the exact target and complete comment census stabilize on the requested live PR head;
- every current tuple's latest admitted observation is PASS and the global block is clear;
- required CI is green for the same head;
- the current clearing publication's terminal cleanup and singular receipt/provenance validate; and
- there is no active admission, live bound worker-smoke child, incomplete teardown, executable
  ambiguous state, corrupt registry, or unsafe smoke operator-routing file.

This handoff is the worker-owned-smoke boundary. It does not authorize
independent smoke. Independent smoke is admitted only by the settled review
state, and its PASS on the final head is the completion evidence. No later
pack-review is legal after that actor starts.

Accumulated historical comments supply tuple evidence only; they are not authenticated or ordered
by the singular receipt. A same-head aggregate PASS cannot bypass unclean lifecycle state. Operator
cancellation may omit a new FAIL comment, but it still must produce clean durable lifecycle state
before admission or handoff.

## Runtime verification and rollback

Run the focused current-head suite before marking the PR ready:

```bash
node scripts/run-vitest-with-harness.mjs run --maxWorkers=1 scripts/worker-smoke.test.ts
node scripts/run-vitest-with-harness.mjs run --maxWorkers=1 scripts/worker-smoke-entrypoint-1359.test.ts
```

The suite covers the existing send-once and lifecycle boundaries plus shared
routine/complex executor-policy admission, the OpenCode pre-spawn external effort
gate, exact-target admission, canonical actor/envelope validation, edited and
malformed evidence, cross-run accumulation, quarantine clearing, row
revocation/restoration, page crossing, high-water stabilization, head reset,
same-head Issue edits, publication-order ties, bounded diagnostics, and one-run
compatibility. A real Orca smoke run remains required when the binding Issue's smoke
plan requires it.

Rollback is allowed only after current lifecycle state is clean. No aggregate state cleanup is
needed because the fold creates no cache, ledger, service, watcher, or second durable store.

## Orca executable selection

Use `OPK_RUNTIME_CLI_COMMAND` when exported. Otherwise prefer `orca-dev`, then `orca-ide`, then `orca`.
Do not assume `/usr/bin/orca` is the CLI on Linux.