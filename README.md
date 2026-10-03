<p align="center">
  <img src="./docs/readme-assets/hero.svg" width="100%" alt="orchestrator-pack — runtime-neutral governance for automated software work, from Issue scope through worker execution, PR evidence, review and CI, smoke, and operator-authorized merge">
</p>

`orchestrator-pack` is a runtime-neutral governance layer for automated software work. It keeps **task scope, execution identity, review, CI/smoke evidence, publication, and worker lifecycle rules** in tracked repository and GitHub surfaces instead of patching the orchestration core.

The concrete runtime can change. The governance contract should not have to.

## The contract at a glance

| Stage | Authority |
| --- | --- |
| **Task** | A published GitHub Issue is the live specification and queue entry. |
| **Scope** | `denylist` / `allowed-roots` plus task declaration and scope guard bound what may change. |
| **Execution** | Runtime effects require an adapter-produced exact `{ runtime, id, generation }` identity. |
| **Delivery** | The pull request and its current head are the delivery authority. Earlier-head evidence does not prove the current head. |
| **Review + CI** | Required review and required CI are evaluated against the exact current PR head. |
| **Smoke** | When a task declares a scenario-bearing smoke plan, the PR owner runs it and publishes the existing same-PR smoke report. |
| **Merge** | Merge is operator-controlled; ordinary execution does not infer merge authority from lifecycle state or green checks. |

That separation is the core design: **runtime selection is replaceable; task and delivery evidence stay explicit.**

## What the pack provides

### Task and scope governance

- [`plugins/task-declaration`](plugins/task-declaration) validates Issue scope and declaration contracts (`pack-declare`).
- [`plugins/scope-guard`](plugins/scope-guard) enforces declared paths before commit and in PR CI (`scope-check`, `agent-wrap`).
- [`plugins/token-chain-ledger`](plugins/token-chain-ledger) records chain/session/token/cost evidence when accounting is enabled (`pack-ledger`).

### Runtime-neutral execution

- [`scripts/runtime/contracts.ts`](scripts/runtime/contracts.ts) defines runtime identities and operations.
- [`scripts/runtime/registry.ts`](scripts/runtime/registry.ts) owns concrete adapter selection. The current production loader registers Orca as the default adapter.
- [`scripts/runtime/runtime-cli.ts`](scripts/runtime/runtime-cli.ts) exposes the tracked runtime-neutral command surface.
- Business logic acts on exact composite runtime identity, not a display name, path, short ID, or stale record.

### Review, CI, and lifecycle evidence

- [`scripts/pack-review-runner.ts`](scripts/pack-review-runner.ts) starts and reconciles pack-owned review runs.
- [`plugins/codex-pr-reviewer`](plugins/codex-pr-reviewer) provides bounded structured Codex PR review (`pack-codex-review`).
- [`scripts/pack-worker-report`](scripts/pack-worker-report) is the public worker lifecycle report command.
- Required CI and review authority stay current-head bound; an existing same-PR smoke PASS can remain sufficient after later head changes when the task requires smoke.

### Repository and retirement guards

- [`scripts/verify.ts`](scripts/verify.ts) owns structural verification and reusable-pack checks.
- [`scripts/gate-runner`](scripts/gate-runner) hosts the TypeScript gate runner.
- [`scripts/runtime-retirement/retired-surface-guard.ts`](scripts/runtime-retirement/retired-surface-guard.ts) prevents removed runtime surfaces from being reintroduced.

## Start here

### Requirements

- Node **24.x** and npm **11.x** as declared by [`scripts/toolchain/node-version.json`](scripts/toolchain/node-version.json) and `package.json`
- Git 2.25+
- authenticated GitHub transport for repository operations
- the agent/reviewer CLIs required by the workflow you select

Install from the frozen lockfile and verify the checkout:

```bash
npm ci --include=dev
npm run check:node-major
npm run check:npm-major
node --experimental-strip-types scripts/verify.ts --strict-prereqs
node --experimental-strip-types scripts/verify.ts --reusable-only
```

For a full development verification pass, also run:

```bash
npm run typecheck:foundation
npm run lint:foundation
npm run test:foundation
npm run gate-runner-selftest
node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
node --experimental-strip-types scripts/verify.ts
```

Run affected plugin suites and task-specific focused tests in addition to the repository-wide checks.

## Typical task flow

1. Publish a GitHub Issue as the live specification.
2. Declare the task boundary with exact `denylist` and, when useful, `allowed-roots`.
3. Work on an Issue-linked branch and implement the minimum behavior inside that boundary.
4. Verify locally and inspect the complete diff before publication.
5. Open a PR with `Closes #N`, `Fixes #N`, or `Resolves #N` near the top.
6. Resolve required CI and review against the current PR head.
7. If the task declares smoke, run its scenario after review convergence and green required CI.
8. Merge only under the authority defined by [`AGENTS.md`](AGENTS.md).

The detailed worker lifecycle lives in [`docs/orchestration-runbook.md`](docs/orchestration-runbook.md). The README is an entry point, not a second copy of that contract.

## Deploy into another repository

`orchestrator-pack` can be used from a stable pack checkout while a project card supplies the selected target repository, primary checkout, default branch, Browser-GPT project, and target-owned verification commands.

Start with [`docs/target_repo_setup.md`](docs/target_repo_setup.md). For policy embedding and coexistence with target-owned rules, read [`AGENTS.md`](AGENTS.md#target-repository-embedding-and-coexistence).

## Repository map

| Path | Purpose |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Canonical repository and execution policy. |
| [`plugins/`](plugins) | Task declaration, scope, accounting, and review plugins. |
| [`scripts/runtime/`](scripts/runtime) | Runtime-neutral contracts, registry, identity, and lifecycle primitives. |
| [`scripts/pr2-foundation/`](scripts/pr2-foundation) | Active scheduler/foundation orchestration surfaces. |
| [`docs/`](docs) | Runbooks, setup, tiering, migration, and operator guidance. |
| [`.cursor/skills/`](.cursor/skills) | Pack-owned task/review/execution skills. |
| [`.github/workflows/`](.github/workflows) | CI and reusable repository gates. |

## Non-negotiable boundaries

- **Do not patch the upstream orchestration core.** Pack behavior lives in the extension surfaces owned by this repository.
- **Do not invent runtime authority.** Effects require the registered adapter and exact composite identity.
- **Do not treat stale evidence as current.** Required CI and review conclusions bind to the exact PR head they observed.
- **Do not commit machine state or secrets.** Credentials, private logs, generated runtime state, local worktrees, and user-machine configuration stay out of the repository.
- **Do not turn README prose into policy.** The owning runbooks and `AGENTS.md` remain authoritative when this overview is necessarily shorter.

## Documentation

- [`AGENTS.md`](AGENTS.md) — canonical policy and edit/merge authority
- [`docs/tiering.md`](docs/tiering.md) — task complexity rubric
- [`docs/repository_policy.md`](docs/repository_policy.md) — scope and reusable-content policy
- [`docs/chat-executor-rules.md`](docs/chat-executor-rules.md) — connected chat executor behavior
- [`docs/orchestration-runbook.md`](docs/orchestration-runbook.md) — worker/orchestrator lifecycle
- [`docs/target_repo_setup.md`](docs/target_repo_setup.md) — target-project deployment
- [`docs/migration_notes.md`](docs/migration_notes.md) — operator adoption and migration notes
