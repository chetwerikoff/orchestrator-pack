<p align="center">
  <img src="./docs/readme-assets/hero.svg" width="100%" alt="orchestrator-pack control plane: operator intent flows through an orchestrator and resumable managers into tracked ChatGPT turns; turn completion or failure wakes the owning workflow, while GitHub evidence and exact runtime identity ground execution">
</p>

`orchestrator-pack` is the governance and control layer around autonomous software work — including a **tracked, resumable wrapper around ChatGPT** rather than a fire-and-forget prompt loop.

Its current GPT workflows are **manager-driven and ChatGPT-centered**:

**Operator → Orchestrator → Manager → tracked ChatGPT turn → GitHub evidence**

The **orchestrator/supervisor** keeps whole-task continuity and supervises manager Tasks. A **manager** owns one concrete resumable workflow — task authoring, Issue execution, PR review, or another GPT-driven job. **ChatGPT** performs the author/reviewer/implementation turns through a tracked Browser-GPT transport. Runtime adapters and workers sit underneath that control plane and execute only under exact identity and scope.

The concrete runtime can change. The task, supervision, ChatGPT transport, and evidence contracts should not have to.

## What makes the pack different

| Feature | What it provides |
| --- | --- |
| **ChatGPT as managed transport** | Each tracked Browser-GPT turn has an input snapshot, invocation identity, owned conversation/output, and an authoritative `turn-result/v1` projected into a terminal envelope. |
| **Turn-completion wakeups** | When a tracked GPT turn launched from a worktree ends, `fleet-wake` can wake the idle pane that owns that worktree so the manager continues instead of waiting for a human to notice the browser finished. |
| **Error/stall routing** | A stalled or product-error ChatGPT conversation is routed directly to its unambiguous owning manager; if no single owner can be resolved, the coordinator/orchestrator receives the fleet alarm and recovery context. |
| **No blind resend** | Possible or proven prompt delivery preserves the same invocation/conversation and enters observation/harvest recovery; transport timeout or child exit alone never authorizes a duplicate send. |
| **Resumable supervision** | The manager owns the multi-turn GPT workflow; the orchestrator owns whole-task continuity across manager, GPT, runtime, CI, and recovery boundaries. |
| **Durable truth outside chat** | ChatGPT status text is advisory. Live Issue/PR state, current head, review, CI, smoke, and exact runtime identity decide progression and completion. |
| **Runtime-neutral effects** | Concrete effects go through a registered adapter and exact `{ runtime, id, generation }` identity instead of being coupled to one agent runtime. |

In other words, the project wraps ChatGPT in **identity, observation, wakeup, recovery, and durable-evidence contracts**, then places that transport inside a supervised software-delivery workflow.

## How work actually flows

| Layer | Responsibility |
| --- | --- |
| **Operator** | Supplies intent and retains final authority for actions such as merge. |
| **Orchestrator / supervisor** | Owns whole-task continuity, launches or resumes the existing supervised `work-class=manager` Task, watches manager progress, receives unresolved fleet alarms, and keeps the parent task alive through recoverable manager/GPT/runtime failures. |
| **Manager** | Owns one resumable workflow and its continuation: live Issue/PR state, tracked GPT turns, completion/error wakes, review convergence, CI, smoke when required, and truthful handoff. |
| **ChatGPT transport** | Performs the substantive Browser-GPT turns with invocation identity, terminal-envelope settlement, observation/recovery, and no-blind-resend semantics. |
| **GitHub** | Holds the durable authorities: live Issue specification, review/disposition comments, PR/current head, CI results, smoke records, and merge state. |
| **Runtime / workers** | Execute effects through a registered runtime adapter using exact `{ runtime, id, generation }` identity and the task's declared scope. |

This separation is deliberate: **the orchestrator supervises managers; managers supervise GPT-driven work; GitHub carries durable truth; runtimes execute effects.**

## GPT-centered workflows

### Discuss with GPT

[`discuss-with-gpt`](.cursor/skills/discuss-with-gpt/SKILL.md) is the explicit GPT consultation entry point.

It has two different modes:

- **Standalone adversarial review** challenges an existing local artifact through the custom ChatGPT project and keeps its own durable PASS/SHA validation contract.
- **Tracked create/review work** routes into the canonical manager + Browser-GPT workflows instead of inventing a second transport or retry model.

Brief-only “create a task with GPT” requests route to `create-issue-draft`; ordinary artifact challenge stays in the standalone discuss flow.

### Create or refine an Issue with GPT

[`create-issue-draft`](.cursor/skills/create-issue-draft/SKILL.md) owns GPT-assisted task authoring and acceptance.

- the live GitHub Issue is the only task specification and queue entry;
- the supervised manager owns the author/reviewer lifecycle;
- the GPT author owns substantive Issue edits and finding dispositions;
- independent GPT reviewers publish revision-named review comments;
- the manager launches review rounds, checks live comments/dispositions, enforces the substantive floor, and applies `spec-review:accepted` only when the current contract is satisfied.

### Execute an Issue through GPT

[`execute-issue-with-gpt`](.cursor/skills/execute-issue-with-gpt/SKILL.md) is the canonical path for explicit “execute / continue this Issue” requests.

The orchestrator/supervisor owns **completion continuity**, not implementation. It launches or resumes the existing manager Task and keeps the parent task alive until current GitHub evidence reaches the workflow's verified terminal state or a genuine external top-level stop exists.

The manager owns one resumable external GPT Issue-execution session, re-reads live Issue state at every turn, drives implementation through ChatGPT, then continues through PR review, CI, required smoke, and handoff.

### Review a PR with GPT

[`review-pr-with-gpt`](.cursor/skills/review-pr-with-gpt/SKILL.md) routes explicit PR review through the same supervised manager model. The pack-owned review runner owns current-head review execution and reconciliation; review chats do not become implementation chats.

## Durable authorities

The conversational hierarchy does not replace repository authority.

| Surface | Authority |
| --- | --- |
| **Task** | A published GitHub Issue is the live specification and queue entry. |
| **Scope** | `denylist` / `allowed-roots` plus task declaration and scope guard bound what may change. |
| **Runtime effect** | An adapter-produced exact `{ runtime, id, generation }` identity is required. |
| **Delivery** | The pull request and its current head are the delivery authority. |
| **Review + CI** | Required review and required CI are evaluated against the exact current PR head. |
| **Smoke** | When the Issue declares a scenario-bearing smoke plan, the owning workflow publishes the existing same-PR smoke report. |
| **Merge** | Merge remains operator-controlled; green CI or manager completion does not imply merge authority. |

## What the pack provides

### Supervision and GPT transport

- [`docs/orchestration-runbook.md`](docs/orchestration-runbook.md) defines supervised Tasks, manager/worker lifecycle, recovery, handoff, and completion rules.
- [`docs/browser-gpt-turn-runbook.md`](docs/browser-gpt-turn-runbook.md) owns one tracked Browser-GPT turn: launch, observation, attribution, terminal result, same-invocation recovery, send/no-resend, and publication mechanics.
- [`docs/chatgpt-task-execution-runbook.md`](docs/chatgpt-task-execution-runbook.md) composes multiple GPT turns into one managed Issue-execution workflow.
- [`scripts/fleet/fleet-wake.ts`](scripts/fleet/fleet-wake.ts) turns terminal-envelope completion, CI completion, and ChatGPT stall/error observations into targeted wakes for the owning pane or coordinator.
- [`scripts/lib/orchestrator-side-process-supervisor.ts`](scripts/lib/orchestrator-side-process-supervisor.ts) supervises the bounded scheduler child and its restart/backoff lifecycle; it is separate from the ChatGPT wake-routing path.
- [`.cursor/skills/discuss-with-gpt/`](.cursor/skills/discuss-with-gpt) provides the explicit GPT consultation route.

### Task and scope governance

- [`plugins/task-declaration`](plugins/task-declaration) validates Issue scope and declaration contracts (`pack-declare`).
- [`plugins/scope-guard`](plugins/scope-guard) enforces declared paths before commit and in PR CI.
- [`plugins/token-chain-ledger`](plugins/token-chain-ledger) records chain/session/token/cost evidence when accounting is enabled.

### Runtime-neutral execution

- [`scripts/runtime/contracts.ts`](scripts/runtime/contracts.ts) defines runtime identities and operations.
- [`scripts/runtime/registry.ts`](scripts/runtime/registry.ts) owns concrete adapter selection. The current production loader registers Orca as the default adapter.
- [`scripts/runtime/runtime-cli.ts`](scripts/runtime/runtime-cli.ts) exposes the tracked runtime-neutral command surface.
- Business logic acts on exact composite runtime identity, not a display name, path, short ID, or stale record.

### Review, CI, and lifecycle evidence

- [`scripts/pack-review-runner.ts`](scripts/pack-review-runner.ts) starts and reconciles pack-owned review runs.
- [`plugins/codex-pr-reviewer`](plugins/codex-pr-reviewer) provides bounded structured Codex PR review where that reviewer source is selected.
- [`scripts/pack-worker-report`](scripts/pack-worker-report) is the public worker lifecycle report command.
- Required CI and review authority stay current-head bound; an existing same-PR smoke PASS may remain reusable across later heads under the current smoke contract.

## Typical managed task

1. The **operator** gives the orchestrator a task or an existing Issue.
2. The **orchestrator** resolves the exact task and launches/resumes the supervised **manager** Task.
3. The **manager** reads authoritative GitHub state and selects the owning GPT workflow.
4. **ChatGPT** authors, reviews, implements, or fixes through tracked turns owned by that workflow.
5. When a tracked turn ends, its terminal envelope can wake the idle owning pane; stalls/product errors are routed to the owning manager when unambiguous, otherwise to the orchestrator/coordinator.
6. The manager reconciles the turn against **live Issue/PR state**, not chat self-report; uncertain delivery is recovered on the same invocation rather than blindly resent.
7. Runtime effects are performed only through declared scope and exact runtime identity.
8. The manager drives the PR through current-head review and required CI.
9. If the Issue requires smoke, the owning workflow executes and publishes it.
10. The orchestrator keeps whole-task continuity until the manager produces a truthful terminal handoff.
11. Merge happens only when the **operator** separately has the authority and requests it.

## Start here

### Requirements

- Node **24.x** and npm **11.x** as declared by [`scripts/toolchain/node-version.json`](scripts/toolchain/node-version.json) and `package.json`
- Git 2.25+
- authenticated GitHub transport for repository operations
- the runtime, agent, reviewer, and Browser-GPT capabilities required by the workflow you select

Install from the frozen lockfile and verify the checkout:

```bash
npm ci --include=dev
npm run check:node-major
npm run check:npm-major
node --experimental-strip-types scripts/verify.ts --strict-prereqs
node --experimental-strip-types scripts/verify.ts --reusable-only
```

For a full development verification pass:

```bash
npm run typecheck:foundation
npm run lint:foundation
npm run test:foundation
npm run gate-runner-selftest
node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
node --experimental-strip-types scripts/verify.ts
```

Run affected plugin suites and task-specific focused tests in addition to the repository-wide checks.

## Deploy into another repository

`orchestrator-pack` can run from a stable pack checkout while a project card supplies the selected target repository, primary checkout, default branch, Browser-GPT project, and target-owned verification commands.

Start with [`docs/target_repo_setup.md`](docs/target_repo_setup.md). For policy embedding and coexistence with target-owned rules, read [`AGENTS.md`](AGENTS.md#target-repository-embedding-and-coexistence).

## Repository map

| Path | Purpose |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Canonical repository and execution policy. |
| [`.cursor/skills/`](.cursor/skills) | Manager-facing GPT authoring, execution, review, consultation, and support skills. |
| [`docs/`](docs) | Browser-GPT, task execution, orchestration, setup, tiering, migration, and operator runbooks. |
| [`scripts/pr2-foundation/`](scripts/pr2-foundation) | Supervised Task/scheduler/foundation orchestration surfaces. |
| [`scripts/runtime/`](scripts/runtime) | Runtime-neutral contracts, registry, identity, and lifecycle primitives. |
| [`plugins/`](plugins) | Task declaration, scope, accounting, and review plugins. |
| [`.github/workflows/`](.github/workflows) | CI and reusable repository gates. |

## Non-negotiable boundaries

- **Do not collapse the hierarchy.** Orchestrator, manager, GPT turn, GitHub authority, and runtime effect are different roles/surfaces.
- **Do not patch the upstream orchestration core.** Pack behavior lives in repository-owned extension surfaces.
- **Do not invent runtime authority.** Effects require the registered adapter and exact composite identity.
- **Do not treat chat self-report as durable completion.** Reconcile against the owning GitHub/runtime evidence.
- **Do not treat stale evidence as current.** Required CI and review conclusions bind to the exact PR head they observed.
- **Do not commit machine state or secrets.** Credentials, private logs, generated runtime state, local worktrees, and user-machine configuration stay out of the repository.
- **Do not turn README prose into policy.** `AGENTS.md` and the owning runbooks remain authoritative.

## Documentation

- [`AGENTS.md`](AGENTS.md) — canonical policy and edit/merge authority
- [`docs/orchestration-runbook.md`](docs/orchestration-runbook.md) — orchestrator, manager, worker, recovery, CI, smoke, and handoff lifecycle
- [`docs/browser-gpt-turn-runbook.md`](docs/browser-gpt-turn-runbook.md) — one tracked Browser-GPT turn
- [`docs/chatgpt-task-execution-runbook.md`](docs/chatgpt-task-execution-runbook.md) — managed multi-turn GPT Issue execution
- [`docs/tiering.md`](docs/tiering.md) — task complexity rubric
- [`docs/repository_policy.md`](docs/repository_policy.md) — scope and reusable-content policy
- [`docs/chat-executor-rules.md`](docs/chat-executor-rules.md) — connected chat executor behavior
- [`docs/target_repo_setup.md`](docs/target_repo_setup.md) — target-project deployment
- [`docs/migration_notes.md`](docs/migration_notes.md) — operator adoption and migration notes
