# Repository publishing policy

This repository contains only reusable `orchestrator-pack` material that can be
applied to other projects without copying user-machine configuration, generated
state, credentials, or a concrete orchestration implementation.

## Allowed tracked content

- `plugins/**` — reusable plugin implementations, contracts, and tests;
- `prompts/**` — reusable prompt fragments;
- `scripts/**` — reusable runtime-neutral commands, guards, tests, and tooling;
- `.github/workflows/**` — reusable CI checks;
- `docs/**` — active architecture, runbooks, migration notes, evidence, and
  explicitly historical artifacts in excluded archive/draft locations;
- `.claude/skills/**` — canonical skill instructions;
- `.cursor/skills/**` — generated skill pointers;
- `.cursor/rules/**` — tracked Cursor rules;
- root policy and tooling files such as `README.md`, `AGENTS.md`, `CLAUDE.md`,
  `.gitignore`, `package.json`, and TypeScript configuration.

## Forbidden tracked content

Do not commit:

- credentials, tokens, certificates, private keys, or secret-bearing `.env` files;
- user-machine or operator-owned concrete runtime configuration;
- generated runtime, review, session, queue, cache, database, or worktree state;
- target repository clones, unrelated worktrees, scratch directories, or logs;
- modified upstream source under `vendor/**`;
- patches under `packages/core/**`;
- compatibility aliases or copied implementations of a removed runtime;
- personal or third-party private data not explicitly authorized by the task.

The repository `.gitignore` is a developer aid, not authority. Scope and reusable
content guards remain binding even when a path is not ignored.

## Task and scope authority

For new tasks, the published GitHub Issue is the sole live specification and queue
entry. It must contain a mandatory `denylist` and may contain `allowed-roots`.
Implementation PRs link exactly one Issue with `Closes #N`, `Fixes #N`, or
`Resolves #N` near the top of the PR body.

The committed declaration at
`docs/declarations/<issue-number>.pr-scope.json` is generated evidence. Do not
hand-edit it, copy a stale declaration, or broaden it to make an unrelated diff
pass.

Pre-existing tracked drafts and indexes are historical publishing inputs only.
New task authoring does not create them unless the direct user explicitly requests
the governed publishing flow for an existing artifact.

## Agent skills

Each skill is authored once under `.claude/skills/<name>/SKILL.md`. Cursor skill
files are generated pointers whose frontmatter is derived from the canonical file
and whose body only directs the agent to read it.

After adding a skill or changing canonical frontmatter, run:

```powershell
pwsh -NoProfile -File scripts/generate-skill-pointers.ps1
pwsh -NoProfile -File scripts/check-skill-pointer-drift.ps1
```

Do not hand-maintain divergent instructions in a pointer.

## Runtime-neutral boundary

Business logic imports `RuntimeAdapter`, not a concrete implementation. Runtime
effects require an adapter-produced `{ runtime, id, generation }` identity. A title,
path, process ID, branch, short identifier, stale state record, or accounting value
never authorizes an effect.

Do not publish a concrete runtime binary, daemon client, configuration database,
state root, fallback transport, dual execution path, migration converter, or second
selector as reusable pack content unless a new Issue explicitly establishes a
runtime-neutral public contract and scope.

## Local verification

From the repository root with PowerShell 7 and Node 22:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
npm run typecheck:foundation
npm run lint:foundation
npm run gate-runner-selftest
node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
```

Run affected plugin and focused tests as well. Require the current-head scope guard,
all protected-branch or pack-required CI, and current-head review where applicable.
A previous-head success does not prove the current head.

New or changed TypeScript must use Node 22 and the repository's native execution
policy. Do not introduce Node 20, emitted build artifacts, `tsx`, `ts-node`, or
loader fallbacks. Optional Git hooks may run the same checks before push, but hooks
never replace server-side CI.

## GitHub protection

Protect the default branch so:

1. changes arrive through pull requests;
2. required current-head checks must pass;
3. the scope guard and reusable-content guard cannot be bypassed by a normal merge;
4. direct pushes are restricted;
5. merge remains an explicit operator action unless repository policy deliberately
   enables a governed alternative.

## Documentation-only PRs

A documentation-only PR is no-ceremony only when every changed path is Markdown
under the explicitly allowed documentation or skill surfaces and the PR body does
not link an implementation Issue. One code, workflow, declaration, root policy, or
non-Markdown path moves the PR into the implementation flow.

A governed historical draft publication may use the explicit spec-only marker and a
non-closing Issue reference. It must remain within the narrow historical draft,
architecture, and skill Markdown allowlist and must not close the implementation
Issue.

These lighter paths never authorize runtime effects, generated declaration edits,
secrets, implementation code, or bypass of skill-pointer drift checks.

## Evidence and history

Current active runbooks must describe only supported behavior. Historical commands,
configuration, packages, or state layouts belong in Git history or an explicitly
excluded archive surface and are non-authoritative.

Do not rewrite GitHub Issue, PR, review, CI, or audit history. Do not claim that a
check ran or a runtime action occurred without exact read-back evidence.

## Plan-first execution

Before edits, inspect the live task, current default branch, current PR head, open
review threads, and current CI. Write the shortest workable plan for the complete
task, then execute through the plan rather than stopping at the first failed guard.

A blocker is a reason to re-check evidence and try the legitimate alternative
route. Report exact errors and remaining uncertainty. Never convert an unavailable
check into a claim that the code passed.

## Scope discipline

- Link every branch and PR to its source Issue; PR bodies must include `Closes #N`,
  `Fixes #N`, or `Resolves #N` in the first few lines.
- Do not touch files outside the active declaration or Issue scope.
- Every task needs explicit paths or a validated denylist.
- Treat broad declarations such as `src/**` or `**/*` as suspicious; narrow them.
- Normalize repository-relative paths before comparing them with scope.
- Before every commit, inspect the complete status and diff.
- Do not rewrite another task's declaration to make the current diff pass.
- When a scope check reports a mismatch, fix the artifact or the diff; do not
  broaden scope merely to silence the check.

Pre-existing queued-task artifacts are historical inputs only. New tasks do not
create a tracked draft or queue-index row unless the user explicitly requests the
legacy publishing flow for an already-existing artifact.

## Build the minimum

Build the smallest implementation that satisfies the acceptance criteria. Avoid
unrequested abstraction unless required by a public boundary, cross-platform
contract, generated-drift prevention, risky-seam testability, or upgrade safety.
Validation, security, data-loss prevention, identity checks, and required tests are
not optional simplifications.
