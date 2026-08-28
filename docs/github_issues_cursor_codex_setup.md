# GitHub Issues + Cursor planner/worker + Codex reviewer setup

This profile uses GitHub Issues as the live task specification, Cursor for planning
and implementation, and Codex `gpt-5.5` for PR review. The pack owns scope, review
claims, structured verdicts, and publication independently of the selected runtime
adapter.

## Responsibilities

- planner: Cursor CLI;
- worker: Cursor CLI;
- reviewer: Codex CLI through the pack reviewer wrapper;
- task and acceptance authority: GitHub Issue;
- code identity: current pull request head;
- merge-readiness evidence: GitHub review plus required current-head CI;
- runtime effects: registered `RuntimeAdapter` with exact composite identity.

A concrete runtime may supply terminal or worker operations, but its configuration,
state, daemon, or CLI is not a task, review, or merge authority.

## Task convention

Every implementation Issue includes:

- clear problem and goal;
- advisory tier;
- acceptance criteria and scenario classes;
- mandatory `denylist` and optional `allowed-roots`;
- verification and smoke plan;
- explicit non-goals and forbidden behavior.

Every PR links one implementation Issue near the top:

```text
Closes #123
```

The declaration producer captures a clean baseline and writes the generated scope
snapshot. Workers do not hand-edit declarations or broaden scope to silence a guard.

## Local prerequisites

```powershell
node --experimental-strip-types scripts/verify.ts --strict-prereqs
cursor --version
codex --version
gh auth status
```

Node.js 22.x and npm 10.x are required. Install workspace dependencies from the
frozen lockfile:

```bash
npm ci --include=dev
npm run check:node-major
```

Authenticate Cursor and Codex through their normal secure local mechanisms. Do not
place credentials in repository files, Issues, PR text, prompts, or logs.

## Runtime registration

Concrete runtime selection lives in `scripts/runtime/registry.ts`. Business logic
imports `RuntimeAdapter` only. Before any runtime effect, resolve an adapter-produced
identity:

```text
{ runtime, id, generation }
```

Do not infer authority from a title, path, branch, process ID, short identifier,
stale store record, or environment string. Operator-owned adapter configuration
stays outside the repository unless a task explicitly adds a reusable example.

## Cursor planning and implementation

Use the published Issue as the planning input and preserve the declared scope. Run
Cursor in the target worktree through the normal agent entrypoint or the tracked
scope wrapper:

```powershell
node --experimental-strip-types plugins/scope-guard/bin/agent-wrap.ts `
  --issue 123 `
  -- cursor agent ...
```

The wrapper checks the worktree after the turn. It does not create runtime identity,
merge authority, or a hidden retry loop.

## Codex reviewer

The pack-owned review runner starts and tracks review. `PACK_REVIEWER=codex` selects
the Codex wrapper. The reviewer consumes the exact PR head, linked Issue scope, and
active declaration, then emits one structured terminal verdict.

Common inspection:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts list --pr-number <PR_NUMBER>
node --experimental-strip-types scripts/pack-review-runner.ts status --pr-number <PR_NUMBER>
```

The wrapper uses `codex exec review --json` and maps native review output into the
pack finding contract. Clean, findings, timeout, malformed, empty, and contradictory
outcomes remain distinct. A clean result for one head is not reused after the head
changes.

Do not invoke Codex as an independent publication path, bypass review claims, or
patch `packages/core/**` to add reviewer routing.

## Optional GitHub Actions review

`.github/workflows/codex-pr-review.yml` runs the same wrapper in read-only CI and may
publish GitHub-visible findings. The caller pins the pack ref and stores required
credentials only in encrypted Actions secrets.

The local and Actions routes share prompt, scope assembly, finding normalization,
and terminal verdict rules. They do not create two lifecycle or publication
authorities.

## Verification before handoff

```bash
npm run typecheck:foundation
npm run lint:foundation
npm run test:foundation
npm run gate-runner-selftest
node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
node --experimental-strip-types scripts/verify.ts
node --experimental-strip-types scripts/verify.ts --reusable-only
```

Also run affected plugin tests and task-specific smoke. Continue through review and
required CI on the same head. Merge only under direct operator authority.
