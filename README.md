# orchestrator-pack

`orchestrator-pack` is a runtime-neutral safety and governance pack for automated
software work. It keeps task scope, review, accounting, publication, and worker
lifecycle contracts in tracked repository surfaces rather than patching a concrete
orchestration runtime.

The pack is designed to survive runtime upgrades and replacements:

- business logic depends on `RuntimeAdapter` and exact composite identities;
- Orca is the currently registered concrete adapter, not an imported business-logic
  dependency;
- GitHub Issues are the live task specification and queue;
- GitHub pull requests and current-head checks are the delivery authority;
- no removed command-line client, daemon, configuration database, or state directory
  is required for normal operation, migration, rollback, or evidence.

## What the pack provides

### Governed task and scope plugins

- [`plugins/task-declaration`](plugins/task-declaration) — validates Issue scope,
  denylist, baseline, and one-amendment contracts. Command: `pack-declare`.
- [`plugins/scope-guard`](plugins/scope-guard) — enforces declared paths before
  commit and in PR CI. Commands: `scope-check`, `agent-wrap`.
- [`plugins/token-chain-ledger`](plugins/token-chain-ledger) — records chain,
  session, token, cost, and convergence evidence. Command: `pack-ledger`.
- [`plugins/codex-pr-reviewer`](plugins/codex-pr-reviewer) — runs bounded Codex PR
  review with structured terminal output. Command: `pack-codex-review`.

### Runtime-neutral execution contracts

- [`scripts/runtime/contracts.ts`](scripts/runtime/contracts.ts) defines runtime
  identities and operations.
- [`scripts/runtime/registry.ts`](scripts/runtime/registry.ts) owns concrete adapter
  registration.
- [`scripts/runtime/runtime-cli.ts`](scripts/runtime/runtime-cli.ts) exposes the
  tracked runtime-neutral command surface.
- [`scripts/lib/operator-publication.ts`](scripts/lib/operator-publication.ts)
  publishes one bounded operator message with zero or one dispatch attempt.
- [`scripts/lib/worker-degraded-ci-handoff.ts`](scripts/lib/worker-degraded-ci-handoff.ts)
  performs exact-composite degraded-CI handoff without short-ID discovery.

### Review and lifecycle contracts

- [`scripts/pack-review-runner.ts`](scripts/pack-review-runner.ts) starts and
  reconciles pack-owned review runs.
- The pack review store and claim authority preserve active, terminal, duplicate,
  concurrent, stale-head, malformed-state, and launch-failure outcomes.
- [`scripts/pack-worker-report`](scripts/pack-worker-report) is the public worker
  lifecycle report command and executes the native Node 22 TypeScript implementation
  in [`scripts/pack-worker-report.ts`](scripts/pack-worker-report.ts). The retired
  PowerShell implementation is not a compatibility or fallback path.
- Required CI, smoke, findings, and handoff must all bind to the current PR head.

### Repository guards

- [`scripts/runtime-retirement/retired-surface-guard.ts`](scripts/runtime-retirement/retired-surface-guard.ts)
  rejects reintroduced removed-runtime commands, HTTP clients, selectors, package
  identities, configuration roots, aliases, and adapter symbols.
- [`scripts/gate-runner`](scripts/gate-runner) hosts the TypeScript gate runner and
  preserved parity contracts.
- [`scripts/check-reusable.ps1`](scripts/check-reusable.ps1) enforces reusable-pack
  publishing boundaries.
- [`scripts/verify.ps1`](scripts/verify.ps1) runs the active repository verification
  suite.

## Requirements

- Node.js 22.x
- npm 10.x
- Git 2.25+
- PowerShell 7+ for retained PowerShell entrypoints
- authenticated GitHub transport for repository operations
- the configured agent and reviewer CLIs required by the selected workflow

Install dependencies from the frozen lockfile:

```bash
npm ci --include=dev
npm run check:node-major
```

## Verification

Run the active repository checks from the current head:

```bash
npm run typecheck:foundation
npm run lint:foundation
npm run test:foundation
npm run gate-runner-selftest
node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

Run affected plugin suites and task-specific focused tests in addition to these
repository-wide checks. A success from an earlier commit is not current-head
evidence.

## Task workflow

1. Use a published GitHub Issue as the live specification.
2. Record exact `denylist` and, when useful, `allowed-roots` blocks.
3. Create a branch linked to the Issue.
4. Implement the minimum behavior against runtime-neutral boundaries.
5. Run local scope, tests, typecheck, lint, retirement scan, and verification.
6. Open a PR whose first lines contain `Closes #N`, `Fixes #N`, or `Resolves #N`.
7. Address findings and required CI on the same current head.
8. Merge only under direct operator authority.

See:

- [`AGENTS.md`](AGENTS.md) for execution policy;
- [`docs/tiering.md`](docs/tiering.md) for task complexity;
- [`docs/repository_policy.md`](docs/repository_policy.md) for reusable content;
- [`docs/chat-executor-rules.md`](docs/chat-executor-rules.md) for connected executor
  behavior;
- [`docs/migration_notes.md`](docs/migration_notes.md) for current operator adoption.

## Security and state

Do not commit credentials, private logs, generated runtime state, local worktrees,
third-party private data, or user-machine configuration. Exact runtime effects
require an adapter-produced `{ runtime, id, generation }` identity; names, paths,
short IDs, stale records, and accounting values are not authority.

Host cleanup of software or state from a removed runtime is optional operator work
after merge. It is not a repository acceptance dependency and must not be used as a
fallback execution path.
