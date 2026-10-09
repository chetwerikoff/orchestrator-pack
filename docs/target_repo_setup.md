# Target repository setup

End-to-end checklist for adopting `orchestrator-pack` in a repository operated
through the registered runtime adapter.

## Required pack surfaces

The target repository or trusted pack checkout must provide:

- `plugins/task-declaration/**`;
- `plugins/scope-guard/**`;
- `plugins/token-chain-ledger/**` when accounting is enabled;
- `plugins/codex-pr-reviewer/**` when local Codex review is enabled;
- `scripts/pr-scope-runner.ts` and its TypeScript authority;
- `.github/workflows/scope-guard.yml`;
- `AGENTS.md` and the relevant prompts;
- workspace configuration bound to `scripts/toolchain/node-version.json`.

For target-repository embedding, precedence, project-owned extensions, and
pack-relative authority pointers, see the canonical [`AGENTS.md`
target-repository policy](../AGENTS.md#target-repository-embedding-and-coexistence).
This document is setup guidance only and does not restate that policy.

## Deploy the pack into a target project

This procedure has two distinct roots and one selected target binding:

- `$PACK_ROOT` is the stable machine-wide checkout that owns pack scripts,
  skills, and runbooks. It is never target identity.
- `primaryRoot` comes from the selected project card and is the target
  repository's primary checkout.
- Select exactly one project with `--project <projectId>` or
  `OPK_PROJECT_ID`. If both are present they must match. There is no cwd,
  git-remote, `--repo-root`, machine-wide project-URL, or pack-project fallback.

Prerequisites: `$PACK_ROOT` is on current `main` with
`npm ci --include=dev` complete; the declared Node runtime is active; `gh auth status` is
green; the automation Chrome is logged into ChatGPT; and Orca is running.

1. **ChatGPT project.** Create a ChatGPT project for the target and copy its
   project URL (for example `https://chatgpt.com/g/<slug>/project`).
2. **Project card.** Create
   `~/.config/orchestrator-pack/projects/<projectId>.json` (or the equivalent
   under `$XDG_CONFIG_HOME`) with `projectId`, `repository`,
   `primaryRoot`, `defaultBranch`, `orcaWorkspacePattern`,
   `orchestratorTitlePattern`, `browserGpt.projectUrl`, and
   `verification`. `projectId` must equal the filename. `repository` must
   match `git remote get-url origin` in `primaryRoot`; unrelated additional
   remotes do not participate in the binding. Validate the card:

   ```bash
   node --experimental-strip-types "$PACK_ROOT/scripts/lib/Invoke-TypeScriptCli.ts" --repo-root "$PACK_ROOT" --script "$PACK_ROOT/scripts/lib/target-context.ts" -- check --project <projectId>
   ```

   A successful check prints the resolved repository, primary root, default
   branch, configured `requiredCi` (when present), and project URL.
   `requiredCi` is optional. When configured it must be a non-empty array of
   GitHub Actions selectors in canonical `<workflow> / <job>` syntax: exactly
   one literal ` / ` separator, non-empty trimmed components, and no duplicate
   workflow/job tuple after case-insensitive normalization. Example:
   `"requiredCi": ["CI / checks"]`.

   A present `requiredCi` is authoritative for pack required-CI gate selector
   discovery and replaces branch-protection lookup for that selected project.
   Use it only for GitHub Actions workflow/job selectors. For classic commit
   statuses or third-party contexts, omit `requiredCi` and configure readable,
   non-empty required-status branch protection on the selected default branch.

   `verification.local` is required for target
   work and must be a non-empty ordered list of non-empty shell command strings.
   `verification.focused` is optional and may hold one non-empty scoped
   verification template, but it never replaces `verification.local`. For example:

   ```json
   {
     "verification": {
       "local": ["npm test", "npm run typecheck"],
       "focused": "npm test -- {path}"
     }
   }
   ```

   Missing/empty/focused-only verification and blank local commands are invalid
   for target verification. There is no fallback to pack verification commands.
3. **Target-mode GitHub binding.** Export the same selected project id for every local target-running pack entrypoint:

   ```bash
   export OPK_PROJECT_ID=<projectId>
   ```

   Tracked `scripts/gh` authorizes this selection before any native/network
   GitHub path. The effective host is `github.com` and the effective repository
   is exactly the selected card's `repository`; an explicit `--repo`/`-R`,
   `GH_REPO`, REST repository path, or full PR/Issue URL may only corroborate
   that repository. Conflicting host/repository ingress fails before native
   `gh`, and arbitrary `gh api graphql` is unsupported in target mode.
   `GH_WRAPPER_ACTIVE` is an internal recursion marker and does not bypass this
   check. Do not set `GH_REPO` as a target selector.

4. **Pack policy in the target.** Run:

   ```bash
   node --experimental-strip-types "$PACK_ROOT/scripts/lib/Invoke-TypeScriptCli.ts" --repo-root "$PACK_ROOT" --script "$PACK_ROOT/scripts/bootstrap.ts" -- --target-repo <primaryRoot>
   ```

   Keep the managed `orchestrator-pack` policy block intact. Add target-owned
   rules outside the markers with the project-card path, shared orchestrator
   prompt path, shared templates path, target verification commands, and the
   target's orchestration rules (see "Shared prompt and templates" below).
5. **Agent rules.** Symlink the global Cursor rules into
   `<primaryRoot>/.cursor/rules/` as described by `~/agent-rules/README.md`.
6. **Scope guard and CI.** Install `.github/workflows/scope-guard.yml` and the
   reusable policy workflows. Run
   `$PACK_ROOT/scripts/install-git-hooks.ts --install-scope-guard` for the
   target and add required Actions secrets to the target repository. Configure
   branch protection/rulesets separately. #2187 owns only target-local command
   verification; required-check readiness, live policy, pack-review requirement
   semantics, and PR/base/comparison/merge authority remain outside this Issue.
7. **Orca.** Register `<primaryRoot>` as an Orca repository using its supported
   setup path and confirm new worktrees match `orcaWorkspacePattern`.
8. **Supervisor — non-pack targets require #2186.** Do not execute this step for
   a non-pack target until #2186 has landed and been adopted. The operator
   launcher requires the project id on every action; an omitted id is an error
   and there is no implicit `orchestrator-pack` default:
   ```bash
   opk-wake-supervisor <projectId> start
   opk-wake-supervisor <projectId> status
   opk-wake-supervisor <projectId> stop
   ```
   After `start`, `status` must identify the selected `projectId`, the
   exact `repository` from that #2185 project card, and one
   `pr2-scheduler` child. Expect supervisor state under
   `.../orchestrator-pack-wake-supervisor/<projectId>/`. A repository-binding
   mismatch or an unbound non-empty namespace is a stop condition, not
   permission to reuse the state. #2186 owns removing scheduler target
   inference from cwd/`--repo-root`.
9. **Fleet wake.** Remove the retired
   `~/.config/orchestrator-fleet/<projectId>.env` if it exists. Render/install
   `scripts/fleet/fleet-wake@.service` from the stable `$PACK_ROOT`
   checkout, replacing `{PACK_ROOT}` with that absolute pack checkout path.
   Its `ExecStart` must execute the in-pack entrypoint and pass
   `--project %i`; it must never locate pack code under target
   `primaryRoot`. Then run:

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now fleet-wake@<projectId>
   ```

   Smoke this with a target whose `primaryRoot` contains no pack scripts.
   After one interval,
   `tail -3 ~/.local/state/orchestrator-fleet/<projectId>.fleet-wake.log`
   must show a normal result such as `orchestrator busy`, `nothing stopped`,
   or `woke`, not `no orchestrator pane found`.
10. **Orchestrator.** Open the agent terminal in `<primaryRoot>` and run
   `opk-orch-primary <projectId> <terminal-handle>`. Verify
   `operator-primary-binding show --project <projectId>` names the intended
   assignment and that
   `operator-primary-binding show --project orchestrator-pack` is unchanged.
11. **Browser-GPT smoke.** Run one standalone
    `driver.mjs --project <projectId> --new-chat` pass on a trivial artifact.
    The chat must open under the selected card's ChatGPT project URL. Machine
    browser/profile settings remain in `local.config.json`; `projectUrl`
    does not.
12. **First task — non-pack targets require #2186 and #2187.** Do not run the
    end-to-end target task until both dependencies have landed and been adopted.
    Then create one small target Issue and drive it to a PR through the normal
    flow. Verify every GitHub effect lands in `<repository>`, every
    per-project state namespace uses `<projectId>`, and verification runs the target-owned commands.
13. **Rollback.** Disable fleet wake with
    `systemctl --user disable --now fleet-wake@<projectId>`. If #2186 has
    landed and step 7 started the per-project supervisor, run
    `opk-wake-supervisor <projectId> stop`. Remove that project card. Other
    target cards and the pack project remain untouched.

Operator-local `~/.local/bin/opk-*` launchers and the shared prompts/templates
are deliberately not tracked by this repository. They must read the selected
card and pass `--project <id>`; pack scripts are invoked from `{PACK_ROOT}`,
never "from this worktree". The shared prompt/template placeholders are
`{PROJECT_ID}`, `{REPOSITORY}`, `{PRIMARY_ROOT}`, `{PACK_ROOT}`,
`{DEFAULT_BRANCH}`, and `{VERIFY}`.

**Shared prompt and templates — one copy for every project.** A new target gets
no per-project copy of any of them:

| File | Used by | Target delivery |
|---|---|---|
| `~/.local/state/orchestrator-session/PROMPT.md` | the orchestrator of every project | `opk-orch-start`/`opk-orch-primary` start spec names the project id and card |
| `~/.local/state/create-issue-draft/briefs/manager-preamble.md` | every manager | pasted first into each manager spec |
| `.../briefs/worker-preamble.md` | every worker | pasted into each worker dispatch |
| `.../briefs/fm-prompt-universal-existing-issue.md`, `fm-prompt-universal-brief-only.md` | authoring managers | by path, after the project line |
| `.../briefs/ff-prompt-universal.md` | every seat's firefighter (defect home: the pack or the seat's own project) | pasted after the manager preamble; the project line names the defect home |

Before the first target task, check that each file still resolves project values
from the spec's project line or the card and runs pack tools from `{PACK_ROOT}`
with the project selected: no hard-coded pack repository, card path, ChatGPT
project segment, `$PWD/scripts`, or "from this worktree" for pack tools. Target
rules the orchestrator and units must follow (data safety, smoke environment,
required CI name, merge-time local adoption, setup repair) go into a target-owned
section of the target `AGENTS.md`, outside the managed markers; the shared prompt
reads them from there.

For each target task, render `{VERIFY}` from the selected card as the tracked
target-verification invocation below, passing the task's **explicit current
worktree root** rather than cwd or card `primaryRoot`. The operator-owned
renderer must shell-quote/escape substituted arguments safely (including paths
with spaces or shell metacharacters), rather than interpolating raw text:

```bash
node --experimental-strip-types "$PACK_ROOT/scripts/lib/Invoke-TypeScriptCli.ts" \
  --repo-root "$PACK_ROOT" --script "$PACK_ROOT/scripts/lib/target-context.ts" -- \
  verify --project "$PROJECT_ID" --target-worktree "$TARGET_WORKTREE_ROOT"
```

The verifier first requires non-empty `verification.local`, canonicalizes
the supplied root, requires that root itself to be the Git worktree top level,
and requires its canonical `origin` repository to equal the selected card's
`repository`. Only then does it run each local command, in declaration
order, as `sh -lc <command>` with cwd set to that worktree and the inherited
environment. Spawn failure or non-zero exit stops immediately. It never infers a
worktree from cwd, substitutes `primaryRoot`, or runs pack verification as a
fallback. `verification.focused` is optional metadata for scoped paths that
explicitly support it; ordinary target verification still runs the full local list.

Updating the shared worker preamble and firefighter/flow-manager templates to
supply this rendered `{VERIFY}` is an operator adoption step outside tracked
repository acceptance.

## Restore an existing supervised manager after reboot

This is an **existing Task / existing worktree** procedure, not a fresh manager
or a new coordinator. Select the project card first and use the corresponding
repository, Run, Task, Issue and exact Orca worktree. The Task must belong
uniquely to the chosen Run under native `task-list --run`. Check its current
Dispatch **before** preparing a terminal:

```bash
orca orchestration run-show --id "$RUN_ID" --json
orca orchestration task-list --run "$RUN_ID" --json
orca orchestration dispatch-show --task "$TASK_ID" --json
```

When `dispatch-show.dispatch` is **present**, do not launch a new Dispatch:
the existing coordinator must reconcile/continue that same Dispatch. If it
is absent, the current supervised launch assistant can restore a clean
non-ancestor manager worktree only with an explicit **same-task Issue**:

```bash
node --experimental-strip-types "$PACK_ROOT/scripts/lib/Invoke-TypeScriptCli.ts" \
  --repo-root "$PACK_ROOT" --script "$PACK_ROOT/scripts/pr2-foundation/supervised-task-launch-assistant.ts" -- \
  --project "$PROJECT_ID" --work-class manager --issue-number "$ISSUE_NUMBER" \
  --run "$RUN_ID" --task "$TASK_ID" --worktree "$WORKTREE_SELECTOR" \
  --base-branch "origin/$DEFAULT_BRANCH"
```

The assistant verifies that the worktree is clean and uniquely owned by its
local branch, then fetches only the default **remote-tracking** ref. For an
otherwise non-ancestor HEAD it requires exactly one currently **open PR whose
live body closes that Issue** with `Closes/Fixes/Resolves #N`; the PR must be
in the selected repository, have that same repository as head (not a fork),
base `$DEFAULT_BRANCH`, head branch equal to the observed local branch and
full head SHA equal to the observed local HEAD. It rechecks branch/HEAD/clean
status and PR before launching. Missing, ambiguous, closed, foreign, dirty,
unpublished or changed evidence refuses without reset, rebase, merge or
fast-forward of the manager branch. A fresh manager created from the default
branch continues through the existing separate `--manager-brief --worktree-name`
path. The early/final Task Dispatch absence checks are both required for a new
start, even when the worktree and terminal were already prepared.

### Coordinator Run binding is independent of worker-start

**Never** recover a coordinator by calling `worker-start` against the
coordinator terminal or by bypassing `terminal_is_coordinator`. An observed
`run-show.coordinator_handle` is historical binding evidence, **not** a
current-liveness observation of the old coordinator. The currently documented
native observations have **not** established an independent, exact Run/old
terminal pre-bind liveness witness. Accordingly, **refuse** the
`orca orchestration run-use` mutation if the old coordinator is live,
unknown, mismatched, or cannot be authoritatively proved no longer live. Record
the exact Run and old handle and manually reconcile that pair using already
supported native authority. A fresh terminal's existence or a fixture alone
cannot authorize takeover.

Only **after** separate native proof/reconciliation establishes that takeover
is safe may the operator use a genuinely runtime-issued new coordinator
terminal with `ORCA_TERMINAL_HANDLE` and the supported native binding:

```bash
# CONDITIONALLY AUTHORIZED: do not execute until old Run/terminal liveness is resolved.
orca orchestration run-use --id "$RUN_ID" --json
orca orchestration run-current --json
orca orchestration run-show --id "$RUN_ID" --json
```

Both post-bind reads must identify the **same** existing Run, and
`run-show.coordinator_handle` must equal the actual
`ORCA_TERMINAL_HANDLE`. These are **post-bind** checks; they never substitute
for the missing **pre-bind** old-coordinator liveness authority. Where the
native `--from <exact_current_handle>` form applies, supply only the actually
observed current handle, not a guessed or stale one. Do not create a second Run.

### Logical operator-primary pointer is separate

The tracked `scripts/operator-primary-binding.ts` changes only a
**project-scoped logical WorkerAssignment pointer**. It cannot perform native
`run-use`, create a terminal or reclassify a gone predecessor. Read the
current project card and the current, same-project/repository **local**
WorkerAssignment first; if there is none, refuse pointer mutation:

```bash
node --experimental-strip-types "$PACK_ROOT/scripts/operator-primary-binding.ts" show --project "$PROJECT_ID"
# For a verified current local assignment and an absent pointer ONLY:
node --experimental-strip-types "$PACK_ROOT/scripts/operator-primary-binding.ts" bind \
  --project "$PROJECT_ID" --task-id "$TASK_ID" --binding-key "$DISPATCH_ID" --operator-attested
# For an existing pointer, replace uses the entire observed old pointer:
node --experimental-strip-types "$PACK_ROOT/scripts/operator-primary-binding.ts" replace \
  --project "$PROJECT_ID" --task-id "$TASK_ID" --binding-key "$DISPATCH_ID" \
  --expected-task-id "$OLD_TASK_ID" --expected-binding-key "$OLD_BINDING_KEY" \
  --expected-assignment-id "$OLD_ASSIGNMENT_ID" \
  --expected-assignment-generation "$OLD_ASSIGNMENT_GENERATION" --operator-attested
node --experimental-strip-types "$PACK_ROOT/scripts/operator-primary-binding.ts" show --project "$PROJECT_ID"
orca orchestration worker-show --dispatch "$DISPATCH_ID"
```

`show` must point to the actual current project/repository assignment and
the last native read separately revalidates its runtime target. A stale or
cross-project pointer/assignment must be reconciled, not overwritten blindly.
All examples above are **instructions**, not proof that a live coordinator,
old terminal, current Task, or operator pointer was repaired. See
`docs/migration_notes.md` for post-merge adoption and rollback.

## Managed AGENTS.md block

Target-project rules live outside one marker pair. Pack rules live inside that
pair as the complete current pack `AGENTS.md` and are replaced when the pack
checkout is updated. Bytes outside the markers stay untouched.

```text
<!-- orchestrator-pack:start -->
...complete current orchestrator-pack AGENTS.md...
<!-- orchestrator-pack:end -->
```

Adopt or update the block with the existing bootstrap target path. The source
is the pack checkout that runs the command.

```bash
node --experimental-strip-types scripts/bootstrap.ts --target-repo /path/to/target
```

A missing target `AGENTS.md` is created with one managed block. An existing
file with no markers keeps its bytes and gains one appended block. One valid
pair is replaced only between the markers. Running again with the same pack
`AGENTS.md` does not change the file.

The command fails before writing when the target root is the pack checkout,
the target `AGENTS.md` is a symlink or any other non-regular file, that file
is the source pack `AGENTS.md`, the source pack `AGENTS.md` contains either
managed marker, or the target markers do not form one valid pair.

Do not copy a removed runtime configuration, state directory, daemon launcher, or
compatibility wrapper into the target repository.

## Prerequisites

- Node/npm majors declared in `scripts/toolchain/node-version.json`;
- Git 2.25+;
- authenticated GitHub transport;
- the selected agent and reviewer CLIs.

```bash
node --version
npm --version
git --version
gh auth status
```

Install from the frozen lockfile and verify the pack:

```bash
npm ci --include=dev
node --experimental-strip-types scripts/verify.ts --strict-prereqs
node --experimental-strip-types scripts/verify.ts --reusable-only
```

## Scope authority

The published GitHub Issue is the live task specification. It contains a mandatory
`denylist` block and may contain `allowed-roots`. The committed declaration is
`docs/declarations/<issue-number>.pr-scope.json`, generated by the tracked
declaration producer.

Generate the declaration with an explicit Issue number and immutable source inputs.
Do not derive authority from a runtime session environment variable.

## Install local scope enforcement

From the target repository root:

```bash
node --experimental-strip-types scripts/install-git-hooks.ts --install-scope-guard
```

The managed hook derives the Issue number from the linked branch when possible and
passes it explicitly. Direct callers must pass `--issue`:

```bash
node --experimental-strip-types plugins/scope-guard/bin/scope-check.ts `
  --issue 1352 `
  --mode index
```

Wrap an agent turn when worktree enforcement is required:

```bash
node --experimental-strip-types plugins/scope-guard/bin/agent-wrap.ts `
  --issue 1352 `
  -- cursor agent ...
```

The wrapper checks the worktree after the command and fails on out-of-scope or
denylisted paths. It never silently broadens scope.

## Runtime registration

Runtime effects use `RuntimeAdapter` from `scripts/runtime/contracts.ts`; the
concrete implementation is selected by `scripts/runtime/registry.ts`. Before an
effect, resolve an adapter-produced exact identity:

```text
{ runtime, id, generation }
```

Do not authorize effects from a title, branch, path, process ID, short identifier,
stale store row, or accounting value. Operator-owned concrete configuration stays
outside the repository unless the task explicitly adds a reusable example.

## Review setup

The pack-owned review runner is the start/list/status authority:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts list --pr-number 1378
```

Use the configured `PACK_REVIEWER` value and the normal review runner entrypoint.
Do not invoke a reviewer plugin directly, bypass start claims, or add a concrete
runtime transport as a fallback.

For GitHub Actions Codex review, store required credentials only in the target
repository's encrypted Actions secrets and use the tracked reusable workflow.
Never place credentials in pack files, Issue text, PR text, or logs.

## First task

1. Create a GitHub Issue from `docs/issue_template_example.md`.
2. Add exact `denylist` and, when helpful, `allowed-roots` fences.
3. Create a branch linked to the Issue.
4. Generate the declaration artifact; do not hand-edit it.
5. Implement the minimum scoped change.
6. Run scope checks, focused tests, typecheck, lint, retirement scan, and verify.
7. Open a PR whose first lines contain `Closes #N`, `Fixes #N`, or `Resolves #N`.
8. Address review findings and required CI on the same current head.
9. Merge only under direct operator authority.

## Required CI

Protect the default branch and require the pack merge-contract checks, including:

- PR scope guard;
- reusable repository policy;
- TypeScript typecheck and policy lint;
- affected tests;
- runtime-retirement scan;
- any task-specific required check.

Required-CI evaluation is owned by `scripts/lib/required-ci.ts`. It uses the
tracked canonical `gh pr checks` projection, then immediately re-reads the live
PR head before a green result can be used. A matching post-projection head is an
inferred current-head binding; the projection itself is not claimed to have
reported a SHA. Head movement makes the evidence stale/non-green. The known
H1→H2→H1 ABA residual between the pre-bound expected head and post-projection
read is intentionally documented rather than hidden with a second transport.

A success from an earlier SHA does not satisfy the current head.

## Operator adoption

When a change modifies concrete runtime registration, supervised processes,
operator-owned inputs, or tracked policy delivery, document the exact post-merge
steps in `docs/migration_notes.md` and the PR body. Do not mutate the operator's
machine from a managed worker unless the direct user orders that exact action.
