# Architecture

## Principle

`orchestrator-pack` is a runtime-neutral governance and execution pack. Business
logic depends on tracked contracts, explicit configuration inputs, GitHub state,
and `RuntimeAdapter`; it does not patch or depend on a concrete orchestration core.

The current concrete runtime implementation is selected only through
`scripts/runtime/registry.ts`. A runtime effect requires an adapter-produced exact
identity:

```text
{ runtime, id, generation }
```

Names, titles, branches, paths, process IDs, short identifiers, stale records, and
accounting fields are never effect authority.

## Sources of truth

1. Published GitHub Issue — live task specification, tier, scope, and acceptance.
2. Current default branch and current PR head — code and policy identity.
3. GitHub PR review and required current-head checks — delivery verdict.
4. Pack review runner/store — operational review state for runner-owned attempts.
5. Tracked active documentation and policy.
6. Historical drafts, captures, and Git history — non-authoritative audit evidence.

New tasks do not create a tracked draft or queue-index row. Pre-existing
`docs/issues_drafts/**` and `docs/issue_queue_index.md` remain historical publishing
inputs only.

## Layout

```text
orchestrator-pack/
  AGENTS.md
  CLAUDE.md
  README.md
  docs/
  prompts/
  plugins/
  scripts/
  tests/
  .claude/skills/
  .cursor/skills/
  .cursor/rules/
  .github/workflows/
```

`packages/core/**` is outside the pack edit boundary. `vendor/**` is disposable
read-only reference material and is excluded from active runtime authority.

## Extension layers

### Policy and prompt layer

`AGENTS.md` is the universal worker rulebook. `CLAUDE.md` adds architect-specific
routing without duplicating universal policy. Prompts define reusable bounded
instructions; they do not carry hidden runtime state or authorization.

Canonical procedure bytes live under `.cursor/skills/**/SKILL.md`. The matching
`.claude/skills/**/SKILL.md` files are generated thin pointers with copied discovery
frontmatter. Classified non-`SKILL.md` helpers may remain under a pointer skill only
as implementation support when a current caller requires that exact path; they do
not become procedure authority and are not duplicated under the Cursor canonical
root.

### Plugin layer

- `task-declaration` generates auditable scope and baseline evidence from a live
  GitHub Issue.
- `scope-guard` enforces the declaration locally and in PR-level CI.
- `token-chain-ledger` records explicit token, cost, finding, and convergence
  observations.
- `codex-pr-reviewer` maps bounded Codex review into the pack finding contract.

Plugins are implementations of public pack contracts. They do not import a
concrete runtime, patch a core package, or invent a second authority.

### Runtime adapter layer

`scripts/runtime/contracts.ts` defines runtime identities and operations.
`scripts/runtime/registry.ts` owns concrete adapter registration.
`scripts/runtime/runtime-cli.ts` is the tracked runtime-neutral command surface.

Callers validate all inputs before resolving an adapter. Missing, malformed, stale,
reused, or mismatched identity yields a typed non-effect outcome. No implicit
discovery, compatibility alias, dual execution, state conversion, or fallback
transport is permitted.

### Side-process layer

The pack-owned wake supervisor manages the exact child roster in
`scripts/orchestrator-side-process-registry.json`. Each child has one bounded
responsibility and explicit state, cadence, timeout, and identity inputs.

The listener, heartbeat, worktree-trust watcher, legacy review sender, and retired
fleet children are absent. Silence is never sufficient death evidence; cleanup and
restart require identity and lifecycle proof.

## Task authoring

The canonical `create-issue-draft` skill under `.cursor/skills/**` owns the
task-authoring flow. Browser GPT is the spec author and terminal architectural
reviewer according to the task tier. A flow-manager may coordinate pulls, captures,
dispositions, and stage progression, but it does not become the specification author
or acceptance judge.

Task Issues define observable outcomes, constraints, scenario classes, acceptance,
smoke, denylist, and allowed roots while preserving implementation freedom. Internal
names and layouts are prescribed only when they are existing public surfaces or are
the behavior under change.

## Scope and declaration

The declaration producer reads the linked Issue, captures a clean baseline, writes
`docs/declarations/<issue>.<iteration>.json`, and mirrors it under the gitignored
pack state root. Only one amendment is allowed per iteration.

The runtime guard validates worktree or index changes before commit. PR-level CI
validates the authoritative merge-base diff as the second line. The denylist always
wins over broad allow globs. A missing authoritative declaration fails closed except
for a pure control-artifact case.

## Review paths

### Pack-owned local review

`scripts/pack-review-runner.ts` is the review start/list/status authority for
runner-owned attempts. It owns exact PR-head binding, start claims, duplicate
suppression, cycle caps, run-store state, and handoff to the existing publication
path.

The selected reviewer is resolved through `PACK_REVIEWER`. Codex, Claude, or GPT
wrappers may implement the review computation, but no wrapper becomes an
independent runner lifecycle authority.

A terminal runner result must be non-empty, structured, and bound to the exact PR
head. Clean on the same head is terminal. Findings remain open until addressed or
explicitly dispositioned. Failed, cancelled, timed-out, malformed, contradictory,
or empty output remains non-clean.

### Direct connected-GitHub review

A direct ChatGPT reviewer with connected GitHub may independently inspect the live
PR and publish an ordinary GitHub PR review `COMMENT` anchored to the exact reviewed
commit. It is canonical pack-review evidence only when GitHub binds it to that exact
40-hex commit, the repository owner authored it, and its body contains exactly one
`opk-pack-review:v1` marker whose `head` equals the review commit. A clean marker
must declare `blocking=false`.

Direct reviews are independent and have no quorum or cardinality requirement. Their
count does not consume the automatic runner budget and never creates a pending state
by itself. Runner-owned reviews and direct reviews share GitHub review state and the
existing `orchestrator-pack/pack-review` required-status context; no second review
store or status writer is introduced.

A direct blocking review on an unchanged head remains blocking until an authorized
adjudication makes it irrelevant or the code changes. On a later descendant head,
prior direct blockers are coarsely resolved when the accepted exact-current
WorkerReport is `ready_for_review` or `completed`, required CI is green for that
head, and exact-head smoke passes. No fresh clean re-review or per-finding mapping is
required solely to close that completed fix cut. A later canonical blocking review
reopens the gate.

### Optional GitHub Actions review

The reusable Actions review invokes the same reviewer wrapper and finding mapper in
read-only CI. It may provide external visibility, but it does not define a second
schema, retry policy, or publication authority.

### Reconciliation

Pack-owned reconciliation children consume current GitHub and pack state, apply the
shared eligibility predicate, and start at most one claimed runner review when
required. They do not recover through a removed runtime command or infer liveness
from silence. Direct-review publication uses ordinary pre/post PR-head read-back;
a review that lands on a stale head remains historical evidence and cannot directly
flip the newer head's status.

## Finding contract

A normalized finding contains:

```json
{
  "type": "correctness|scope-violation|ci|security|architecture|other",
  "code": "stable-machine-code",
  "severity": "blocking|major|minor|info",
  "path": "repo/relative/path-or-null",
  "summary": "bounded explanation",
  "source": "reviewer-or-guard",
  "signature": "stable-sha256"
}
```

Signatures derive from normalized type, code, and path. Human prose is not parsed
as authority when a structured channel exists. Temporary unknown outcomes remain
typed and retryable only by the explicit caller-owned policy. Direct-review
per-finding IDs, run IDs, slots, rounds, and mapping metadata are optional and are
not readiness authority.

## Publication

`scripts/lib/operator-publication.ts` validates its complete input before one
bounded dispatch attempt. `scripts/lib/worker-degraded-ci-handoff.ts` uses exact
composite identity for degraded-CI handoff.

Runner-owned worker delivery remains separate from GitHub review durability. The
direct-review path publishes only the owner-attested GitHub review artifact and
reuses the existing required-status context; it does not become a fallback transport
inside a failed runner. A transport failure remains a failure even when an operator
URL exists.

## Worker lifecycle

Workers continue after implementation through current-head CI, review findings,
smoke, and durable handoff. `pack-worker-report` may record lifecycle state only
after proving repository, worker, PR, and head binding. If that binding cannot be
proved, the report write is skipped without weakening the remaining obligations.

Required CI and smoke must bind to the same current head. A previous-head pass,
missing check, stale review, or unverifiable receipt does not satisfy acceptance.
After exact-head smoke PASS, readiness is derived from current facts rather than
persisted as a second lifecycle state: PR/target/head identity, required CI, review
obligation and unresolved blockers, at-cap facts, exact-head smoke, and the accepted
current WorkerReport corroborated by WorkerStatus must all be acceptable.

## TypeScript and shell policy

Repository automation is TypeScript on Node 22. The PowerShell estate is retired:
there is no active `.ps1`/`.psm1`/`.psd1` execution path, compatibility wrapper, or
availability probe. Reintroducing PowerShell requires a new task that explicitly
changes this terminal architecture rather than treating it as a fallback.

No Node 20, emitted JavaScript build, `tsx`, `ts-node`, or loader fallback is part of
the execution contract.

## Operator adoption

A change to runtime registration, supervised processes, operator-owned inputs, or
tracked policy delivery documents exact post-merge adoption in
`docs/migration_notes.md` and the PR body. Managed workers do not mutate the
operator host unless directly ordered.

Host cleanup of removed software, configuration, caches, or state is optional
operator work after merge. It is neither repository acceptance nor rollback.

## Upgrade safety

- one source of truth per contract;
- no core patch;
- no concrete runtime import in business logic;
- no compatibility alias or dual path;
- exact identity before effects;
- bounded caller-owned retry;
- current-head evidence;
- immutable GitHub and audit history;
- planner freedom inside observable constraints.

## TypeScript script authoring

Files under `scripts/**` use the tracked Node 22 TypeScript toolchain. The earlier
PowerShell migration freeze is complete; removed shell wrappers and shims are not
available as compatibility surfaces. `AGENTS.md` remains the canonical execution
policy rather than duplicating a second policy body here.
