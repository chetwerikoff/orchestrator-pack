<p align="center">
  <img src="./docs/readme-assets/hero.svg" width="100%" alt="orchestrator-pack role-separated control plane: architect, orchestrator, manager, worker, and reviewer have distinct responsibilities; task creation flows from brief through GPT authoring and independent review to an accepted GitHub Issue; tracked ChatGPT turns wake their owning workflow">
</p>

`orchestrator-pack` is a governance layer for autonomous software work. It turns a task idea into a reviewed GitHub Issue, drives implementation and review through tracked ChatGPT turns, and treats only GitHub evidence (Issue, PR head, review, CI, smoke) as proof that the work is done.

The concrete agent runtime can be replaced; the task, review, and evidence contracts stay the same.

```text
[Operator] --> [Orchestrator] --> [Manager] --> [ChatGPT turn]
                keeps the task     owns one         authors, reviews,
                alive, recovers    workflow         implements
                                       |
                                       v
                              [GitHub evidence]
                     Issue - PR head - review - CI - smoke
```

## Why it is different

- **Reviewed tasks.** Every task is a GitHub Issue that passes independent GPT review before anyone implements it ([how](#from-an-idea-to-an-accepted-issue)).
- **Multiple agents, different lenses.** A spec is challenged by several independent GPT reviewers, a Claude architectural lens, and optionally Codex — not by the agent that wrote it ([how](#architect-and-review-lenses)).
- **Separate roles.** Architect, orchestrator, manager, worker, and reviewer each own a distinct part of the work instead of one agent doing everything.
- **ChatGPT as a tracked transport.** Each GPT turn is recorded, can be resumed after a failure, and is never blindly re-sent.
- **Automatic wakeups.** When a GPT turn finishes or stalls, the workflow that owns it is woken up — no human needs to watch the browser.
- **GitHub is the truth.** What the chat says is advisory; progress is decided by the live Issue/PR state, current-head CI, and review.
- **Runtime-neutral.** Effects go through a registered runtime adapter (Orca today) and an exact runtime identity.

## Roles

| Role | Responsibility |
| --- | --- |
| **Orchestrator** | Keeps the whole task alive, launches managers, recovers from failures. |
| **Manager** | Owns one resumable workflow end to end: create an Issue, execute it, or review a PR. |
| **Worker** | Implements one bounded change within the declared scope. |
| **Reviewer** | Independently reviews the task or the PR and publishes findings. |
| **Architect** | Decides what must be true, in what order, at which boundaries, and how success is proved; read-only unless explicitly authorized to edit. |

## From an idea to an accepted Issue

Task creation is a workflow of its own, not a note written before the real work:

```text
[Brief] --> [GPT author] --> [Independent reviews] --> [Author answers findings] --> [Final review] --> [Accepted Issue]
                 ^                                              |
                 +------------- new Issue revision -------------+
```

- **The Issue is the spec.** The live GitHub Issue is the only task specification and queue entry.
- **The author answers every finding.** Each review finding is either fixed in a new Issue revision or rejected with a reason — nothing is silently dropped.
- **Review depth scales with complexity.** A simple task gets one review; a complex one gets several parallel GPT reviews plus a Claude review ([tiers](docs/tiering.md)).
- **Acceptance is a label.** Only when the required reviews and answers line up does the Issue get `spec-review:accepted` and become ready to execute.

## Architect and review lenses

The architect designs the task, not the code. Before proposing a non-trivial contract it lays out at least three materially different options, picks the cheapest one that is sufficient, and names its risks. Implementation details — names, file layout, libraries, tests — are left to the implementer within the published constraints.

A spec is never judged only by its author. Each lens comes from a separate agent in a fresh context:

| Lens | Agent | When |
| --- | --- | --- |
| Independent architectural reviews, run in parallel | GPT, each in a new chat | complex tasks (T2, T3) |
| Architectural lens from a different model family | Claude | the most complex tasks (T3) |
| Final architectural review | GPT | every task |
| Adversarial challenge of a draft | Codex ([`adversarial-draft-review`](.cursor/skills/adversarial-draft-review/SKILL.md)) or GPT ([`discuss-with-gpt`](.cursor/skills/discuss-with-gpt/SKILL.md)) | on request, before publishing |

Reviewers publish their own findings on the Issue; nobody merges, rewrites, or silently drops another reviewer's findings.

## Main workflows

| Skill | Use it to |
| --- | --- |
| [`create-issue-draft`](.cursor/skills/create-issue-draft/SKILL.md) | Turn a brief into an accepted Issue (GPT author + independent reviews, depth by [tier](docs/tiering.md)). |
| [`execute-issue-with-gpt`](.cursor/skills/execute-issue-with-gpt/SKILL.md) | Implement an accepted Issue through GPT, then drive the PR through review, CI, and smoke. |
| [`review-pr-with-gpt`](.cursor/skills/review-pr-with-gpt/SKILL.md) | Review an existing PR on its current head. |
| [`discuss-with-gpt`](.cursor/skills/discuss-with-gpt/SKILL.md) / [`adversarial-draft-review`](.cursor/skills/adversarial-draft-review/SKILL.md) | Challenge a draft or idea with GPT or Codex. |

Merge is never the implementer's decision: it requires operator authority.

## Start here

Requirements:

- Node **24.x** and npm **11.x** as declared by [`scripts/toolchain/node-version.json`](scripts/toolchain/node-version.json)
- Git 2.25+
- authenticated GitHub transport
- the runtime, agent, reviewer, and Browser-GPT capabilities your workflow needs

Install and verify:

```bash
npm ci --include=dev
npm run check:node-major
npm run check:npm-major
node --experimental-strip-types scripts/verify.ts --strict-prereqs
node --experimental-strip-types scripts/verify.ts --reusable-only
```

Full development check:

```bash
npm run typecheck:foundation
npm run lint:foundation
npm run test:foundation
npm run gate-runner-selftest
node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
node --experimental-strip-types scripts/verify.ts
```

To use the pack with another repository, see [`docs/target_repo_setup.md`](docs/target_repo_setup.md).

## Documentation

README is an overview; the documents below are authoritative.

- [`AGENTS.md`](AGENTS.md) — project policy, edit boundaries, merge rules
- [`docs/orchestration-runbook.md`](docs/orchestration-runbook.md) — orchestrator, manager, and worker lifecycle
- [`docs/browser-gpt-turn-runbook.md`](docs/browser-gpt-turn-runbook.md) — one tracked ChatGPT turn
- [`docs/chatgpt-task-execution-runbook.md`](docs/chatgpt-task-execution-runbook.md) — multi-turn Issue execution through GPT
- [`docs/tiering.md`](docs/tiering.md) — task complexity tiers
- [`docs/repository_policy.md`](docs/repository_policy.md) — scope and reusable-content policy
- [`docs/target_repo_setup.md`](docs/target_repo_setup.md) — deploying into a target repository
- [`docs/migration_notes.md`](docs/migration_notes.md) — operator adoption notes

Code: [`plugins/`](plugins) (task declaration, scope guard, accounting, review), [`scripts/runtime/`](scripts/runtime) (runtime adapter contracts), [`scripts/fleet/`](scripts/fleet) (wakeups), [`.github/workflows/`](.github/workflows) (CI).
