# Architecture

## Principle

`orchestrator-pack` is a thin, upgrade-safe layer around upstream Composio AO.
The AO lifecycle remains upstream-owned. Local behavior is expressed as:

- YAML config examples;
- prompt templates;
- external plugin contracts;
- read-only verification scripts;
- GitHub Actions checks.

No local code should modify upstream AO core.

## Task queue

GitHub Issues are the live queue. Local specs live in `docs/issues_drafts/`.
The draft filename prefix and the GitHub Issue number are **different schemes** —
resolve mappings via [`issue_queue_index.md`](issue_queue_index.md) and read live
state with `gh issue view`, never from draft-file presence alone.

Local Codex PR review **is active**. AO drives it via `ao review run`, `send`,
`list`, and `execute`; orchestration lives in `orchestratorRules` in
`agent-orchestrator.yaml`. See [`README.md`](../README.md#local-codex-review-active),
[`AGENTS.md`](../AGENTS.md), and
[`docs/github_issues_cursor_codex_setup.md`](github_issues_cursor_codex_setup.md).

## Layout

```text
orchestrator-pack/
  README.md
  agent-orchestrator.yaml.example
  docs/
  prompts/
  plugins/
  scripts/
  .github/workflows/
```

Optional upstream reference checkout:

```text
vendor/agent-orchestrator/
```

Rules for `vendor/agent-orchestrator`:

- disposable reference only;
- no local modifications;
- never used as `packages/core`;
- may be removed and recloned at any time.

## Extension layers

### Worker rule delivery (AO 0.10.2+)

AO workers receive normative policy from tracked [`AGENTS.md`](../AGENTS.md) in the worktree —
native pickup for Cursor and Codex workers. There is no `agentRulesFile` injection channel on
AO 0.10.2. After merge, **recycle live worker AO sessions** so worktrees pick up the new file;
AO restart alone is not required for worker rule delivery.

### Config layer

`agent-orchestrator.yaml.example` demonstrates stock AO settings:

- Windows `process` runtime;
- Cursor CLI as the default agent;
- role overrides so the planner/orchestrator and coder/worker both use Cursor CLI;
- worktree isolation;
- desktop notifications;
- explicit GitHub Issues tracker and GitHub SCM config;
- worktree isolation and native worker rule pickup via tracked `AGENTS.md`;
- safe reactions that do not auto-merge.

Local Codex review is wired through `orchestratorRules` and the `ao review` CLI
(see [Review paths](#review-paths)). The upstream AO schema supports
`orchestrator` and `worker` role overrides. On AO 0.9.x there is no `reviewer:`
YAML role that AO reads — adding `reviewer:` parses without error but is
silently ignored; never patch AO core to add reviewer routing.

### Prompt layer

[`AGENTS.md`](../AGENTS.md) is the single worker/agent rulebook — native pickup in AO
0.10.2+ worktrees (Cursor and Codex workers). Script-owned orchestrator review
documentation lives in [`script-owned-review-pipeline.md`](script-owned-review-pipeline.md).

`prompts/self_architect_check.md` is a small reusable review block to reduce
unnecessary subsystems, duplicate prompt literals, and broad scope declarations.

### Plugin-contract layer

The plugin directories are contracts, not implementations:

- `ao-task-declaration` declares active scope and baseline state.
- `ao-scope-guard` enforces active scope at runtime and defines the PR CI backup.
- `ao-token-chain-ledger` aggregates cost/tokens by chain across sessions.
- `ao-codex-pr-reviewer` defines Codex `gpt-5.5` review contracts for the local AO primary path and optional GitHub Actions path.

Future implementations should bind to AO plugin slots, wrappers, hooks, or
external state files. They must not patch AO core.

### Review paths

**Wake-supervisor fleet reference (Issue #702).** Per-child triggers, verify commands,
known-broken flags, and fleet scenarios F1/F1b/F2:
[`wake-supervisor-fleet-operator-reference.md`](wake-supervisor-fleet-operator-reference.md).

**Event-driven first review (Issue #381).** The orchestrator wake listener admits
`ready_for_review` hand-off notifications on the **hand-off semantic envelope**
(`notification` + `session.working` + `ready_for_review` + PR subject), not on
transport priority. An `info`-priority hand-off is promoted out of the priority
drop, identity-bound to the supervised project/repo/open PR, then evaluated through
the shared #195/#352 readiness predicate and started via the #267/#308 claim and
#332 per-cycle gate. `merge.ready` completion wakes remain a separate fast path
(Issue #207). The 10-minute reconcile backstop is unchanged.

The primary review path is AO's **active** local Codex review flow. AO drives
it through `ao review run`, `send`, `list`, and `execute`; orchestration and the
autonomous loop live in `orchestratorRules` in `agent-orchestrator.yaml`.
Discover current runs with `ao review list <project>` and the AO dashboard.
Local Codex review writes findings to the dashboard and can feed blocking
feedback back to Cursor workers through AO reactions such as
`changes-requested -> send-to-agent`.

On AO 0.9.x, a `reviewer:` YAML block is silently ignored — wire review through
`orchestratorRules` and `ao review`, not a `reviewer:` key.

The periodic `review-trigger-reconcile` backstop still requires
`ready_for_review` on the current head while a worker is actively working
(Issue #195). When a live owner has gone quiescent — idle, no pending
unconsumed delivery, stable green head past the stuck-grace debounce — without
ever handing off, the reconciler may start review against that live session
(Issue #261). Not-live or ambiguous owners fail closed (`no_live_review_target`,
`ambiguous_head_owner`).

GitHub Actions Codex review remains an optional path for PR comments, reusable
workflow consumers, and external visibility. It must use the same prompt, scope
context, and structured finding format as the local path; it must not define an
independent review schema.

The common finding format and signature rules are defined in
`docs/issues_drafts/00-architecture-decisions.md` section F.

Operators may temporarily point **REVIEW_COMMAND** at a local Claude Sonnet
bridge (gitignored `.ao/` scripts) instead of Codex; see
[`reviewer-switch-runbook.md`](reviewer-switch-runbook.md).

**Post-merge lifecycle (AO 0.9.x).** PR merge triggers AO **worker** session and
worktree cleanup; it does **not** lifecycle-couple existing `code-reviews/` runs
(observed: runs persist in `needs_triage` / `waiting_update` until a new review
targets a different SHA or upstream adds cancel/outdate-on-merge). Pack policy
until upstream enhancement: `orchestratorRules` **MERGED PR — REVIEW LOOP
TERMINAL** (Issue #54) — verify merge via GitHub, then orchestrator inaction on
stale runs plus operator runbooks; not hand-editing review-run JSON.

### Finding-routing enactment — Gate 0 (AO 0.9.2, 2026-06-02)

Spike for draft `docs/issues_drafts/50-finding-routing-selective-send-enactment.md`
(pack finding router: `forward` / `backlog` / `drop`). Environment: `ao` **0.9.2**
(`@aoagents/ao`), project `orchestrator-pack`, store under
`~/.agent-orchestrator/projects/orchestrator-pack/code-reviews/`.

| Capability | Question | Result |
|------------|----------|--------|
| **A — selective send** | Can orchestration send a subset of open findings on a run? | **No.** `ao review send <run>` has no per-finding filter. `@aoagents/ao-core` `sendCodeReviewFindingsToAgent` loads **all** `status: "open"` findings, one worker message, bulk `sent_to_agent`. CLI: `run \| execute \| send \| list` only. |
| **A′ — terminal non-forward** | Can backlog/drop clear `openFindingCount > 0` without send? | **No for automated enactment.** Finding statuses: `open` \| `dismissed` \| `sent_to_agent` \| `resolved` (`code-review-store.d.ts`). `openFindingCount` counts only `open`. No `backlogged` / `dropped`. `dismissed` would clear the predicate, but **no** `ao review dismiss` (or equivalent) — UI dismiss only (recovery runbook). Classifier backlog/drop that leaves findings `open` **re-triggers** pack rules (`needs_triage` + `openFindingCount > 0` → send). Same upstream class as #122. |
| **B — `prior_sent`** | Is send history visible at the routing decision point? | **No.** `ao review list --json` exposes run aggregates only. Per-finding JSON on disk (`fingerprint`, `status`, `linkedSessionId`, `sentToAgentAt`) is **not** an orchestrator/CLI contract. `ao-token-chain-ledger` finding signatures require explicit append — **not** wired to `ao review send`. |

**Verdict:** Per-finding routing **enactment** in production is **upstream-blocked**
(A + A′). Pack read-hook over `code-reviews/findings/` can compute B offline but
cannot enact routes without supported AO transitions; hand-editing `code-reviews/`
is forbidden. **Offline** trilogy (drafts 47–49) remains unblocked.

**Upstream tracking (pack [#140](https://github.com/chetwerikoff/orchestrator-pack/issues/140)) — two tracks:**

| Track | Issues | Role |
|-------|--------|------|
| **Pipeline (preferred)** | [#1631](https://github.com/ComposioHQ/agent-orchestrator/issues/1631) router, [#1346](https://github.com/ComposioHQ/agent-orchestrator/issues/1346) `ao artifact dismiss\|send`, [#1345](https://github.com/ComposioHQ/agent-orchestrator/issues/1345) | Native classifier domain: command stage (findings JSON) + router + A′ |
| **Legacy fallback** | [#2088](https://github.com/ComposioHQ/agent-orchestrator/issues/2088) | `ao review` 0.9.x per-finding send + dismiss CLI |
| **Delivery trust** | [#1943](https://github.com/ComposioHQ/agent-orchestrator/issues/1943), [#614](https://github.com/ComposioHQ/agent-orchestrator/issues/614) | `forward` ≠ delivered; need skipped-reason observability |
| **Backlog sink candidate** | [#1494](https://github.com/ComposioHQ/agent-orchestrator/issues/1494) | Native `ao backlog` vs pack `docs/` file (#139) |

Classifier defaults to **pipeline command / findings JSON**, not legacy-only. Pack: tracking
+ docs (#122 discipline); no prod wiring until A + A′ on chosen track. Queue: §Q —
**#139 + #140 now**; **#141/#142 deferred**.

**Read-only diagnostic (legacy path):** `scripts/review-bulk-send-diagnose.ps1` surfaces
runs where bulk `ao review send` would ship all open findings or `openFindingCount` stays
stuck after partial send — no mutation; fixture mode for offline checks.

Operator usage (Gate 0 — `active-blocked-upstream`, pack #140):

```powershell
pwsh -NoProfile -File scripts/review-bulk-send-diagnose.ps1
pwsh -NoProfile -File scripts/review-bulk-send-diagnose.ps1 -ProjectId orchestrator-pack -Json
pwsh -NoProfile -File scripts/review-bulk-send-diagnose.ps1 -FixturePath scripts/fixtures/review-bulk-send-diagnose/needs-triage-multi-open.json
```

Flagged kinds: `bulk_send_trap`, `stuck_open`, `multi_open_awaiting_dispatch`. Use when
`needs_triage` / `waiting_update` runs keep `openFindingCount > 0` but per-finding routing
is expected — bulk send ships all open findings; partial send can leave remainder stuck
without CLI dismiss/backlog (**A′** blocked). **Do not** hand-edit `code-reviews/findings/`
(#122 class). Until upstream **A + A′** land (pipeline #1631/#1346 preferred, legacy #2088),
treat flagged runs as upstream-blocked, not worker defects. Delivery trust still requires
#1943 / #614 before prod `forward` acceptance (shared invariant #1).

### CI layer

`.github/workflows/scope-guard.yml` runs the read-only verifier and, on
`pull_request` events, `scripts/pr-scope-check.ps1` — the third guard layer from
#3.C. The check reads the PR body via `gh pr view` (not workflow `env` injection
of `pull_request.body`, which truncates multiline text with colons), the linked
issue body, the latest committed declaration snapshot on the PR head, and
`gh pr diff --name-only`, then enforces the #3.A validation formula (with fork
fail-closed policy and opt-in degraded mode).

On pull requests whose diff is **markdown-only** under the workflow allowlist
(`docs/**`, skill/rule trees, top-level `*.md` / `AGENTS.md`, each path ending
in `.md`/`.mdc`), the heavy advisory jobs (contract tests, self-architect lint)
are skipped; the required verifier and PR scope guard still run (#155).

CI is the third line of defense. Runtime scope guard and the pre-commit hook
remain mandatory because an agent can mutate the working tree and index before a
PR exists.

## Data boundaries

Allowed local state locations for future implementations:

- AO session metadata when exposed by upstream AO;
- workspace-local `.ao/` state that is gitignored;
- external JSONL/SQLite ledgers outside committed source;
- CI artifacts for audit output.

Disallowed:

- committed secrets;
- local patches in `packages/core`;
- hidden changes under `vendor/agent-orchestrator`;
- mandatory migration of the old `.ai-loop/` layout.

### CI-failure notification dedup predicate (Issue #283)

The turn-driven orchestrator CI-failure ping is gated by a repo-side deterministic helper,
`docs/ci-failure-notification.mjs`, invoked through the tracked PowerShell wrapper
`scripts/ci-failure-notification.ps1` under the supported operator runtime (pwsh 7+ / WSL2).
The predicate's terminal action is a closed enum: `SEND` or `SUPPRESS`. Reaction bindability,
self-fix bindability, helper errors, and token state are diagnostics recorded in the audit,
never third actions.

The episode identity is `{repo, PR number, head SHA, aggregate red-period discriminator,
active notification target}`. Suppression is exact-key only: a `reaction.action_succeeded`
/ `reactionKey=ci-failed` event, `fixing_ci` report, or write-ahead intent token for a
superseded session, earlier SHA, earlier red period, or sibling PR cannot suppress the active
session's only ping. The helper uses an atomic create-if-absent intent token before any
orchestrator send; an ambiguous post-crash token resolves to at-most-once suppression, while
an observable `ao send` failure must release the token for bounded retry or mark it
failed-owned with visible operator escalation.

This closes the dominant reaction-first duplicate path. It deliberately does not close the
reverse ordering where the orchestrator sends before AO's unconditional built-in `ci-failed`
reaction, because the daemon reaction cannot consult repo-side state.

### Native AO CI-nudge suppression (operator-local `tmux` shim, 2026-07-15)

AO 0.10.2's daemon (closed-source; no source, no CLI/config toggle) pastes its own
unconditional CI-failure nudge directly into the worker's tmux pane whenever a PR check
turns red, independent of the pack's own predicate above. It has three problems the pack
cannot fix at the daemon: it fires regardless of whether the worker is already mid-fix for
that exact failure (dedup is per `{PR, check, head SHA}` only —
`pr.last_nudge_signature` — with no notion of worker busy-state); the paired `Enter` that
is supposed to submit the pasted text is unreliable for at least the Codex/cursor-agent
worker harness, leaving an unconsumed bracket-pasted draft sitting in the pane input (same
failure class as §H decisions 4/5, `#216`/`#293`, whose submit-only-Enter narrow exception
is scoped only to review-finding pastes, not this channel); and the content is a raw log
tail with no diagnosis. Draft `#755` (`docs/issues_drafts/269-ci-red-delivery-watchdog.md`)
already commits this channel to read-only/no-disable-hooks — the pack must not write to
`pr.last_nudge_signature` or otherwise mutate AO's own ledger.

The daemon's tmux adapter (`internal/adapters/runtime/tmux.execRunner.Run`,
confirmed from the binary's own embedded Go symbol table) shells out to the real `tmux`
CLI rather than talking to a control socket, and the daemon process's `PATH` places
`~/.local/bin` ahead of `/usr/bin`. An operator-local shim at `~/.local/bin/tmux`
therefore sees every `tmux` invocation the daemon makes: it pattern-matches literal
`send-keys -l` payloads against the fixed AO nudge string
(`"CI is failing on your PR. Review the output below and push a fix."`), drops only
that exact call plus the immediately-following paired `Enter` to the same target (a
short-lived per-target marker prevents a bare `Enter` firing into whatever the worker is
mid-typing once the nudge text itself never lands), and passes every other invocation
(session lifecycle, review-finding pastes, ordinary worker key sends) straight through to
the real binary unchanged.

This is deliberately **not** a binary patch to the AO daemon: a byte patch cannot survive
an update by construction (dpkg overwrites `/usr/lib/agent-orchestrator` in place; the
self-updating copy under `~/.local/lib/agent-orchestrator-<version>` is a new file in a new
version-numbered directory) and risks corrupting the binary's GC/stack metadata. The PATH
shim survives updates instead, because it depends only on AO continuing to invoke the
external `tmux` CLI — a far more stable contract than any internal offset. It would stop
working only if AO ever switched to a raw control-socket protocol, which is self-detecting
(the shim's audit log goes quiet while nudges resume reaching the pane).

**Status: operator-machine-local only**, not a pack-owned/tracked artifact — no install
script, no PR, no Issue. See
[`docs/tmux-ci-nudge-shim-runbook.md`](tmux-ci-nudge-shim-runbook.md) for install/verify/
rollback steps on a given host. Formalizing this for multi-operator distribution (mirroring
the `cursor-agent` TUI shim, Issue #725) would need its own draft.
