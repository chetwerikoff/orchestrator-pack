# ao-scope-guard contract

DD-024 equivalent for Composio AO without patching AO core.

## Purpose

Prevent agent changes outside declared active scope before they are staged or
committed, and provide PR-level CI as a second line of defense.

## Enforcement levels

### First line: runtime guard

The runtime guard must run in the agent execution path before `git add` and
before commit creation. Acceptable implementation surfaces include:

- agent wrapper around the AO agent plugin;
- workspace hook;
- repository pre-commit hook installed by the pack;
- command wrapper that validates the index before allowing commit.

Runtime behavior:

1. Load active scope from `ao-task-declaration` state.
2. Enumerate modified and staged paths.
3. Normalize every path relative to repository root.
4. Reject paths outside declared allow scope.
5. Reject paths matching the denylist even if they also match a broad allow glob.
6. Print a clear violation report.
7. Do not silently broaden scope.

The guard may block the operation. It should not destructively reset files unless
that behavior is explicitly configured by the user.

### Second line: PR-level CI

The GitHub Action checks the PR diff against the same active scope. It blocks
merge if out-of-scope files appear in the PR.

CI is audit/enforcement after the fact. It is not a replacement for runtime
guarding because an agent can mutate the working tree and index before CI runs.

## Required inputs

- active scope from `ao-task-declaration`;
- repository root;
- baseline ref/tree hash;
- changed path list from git status/diff or PR diff;
- denylist.

## Required outputs

- pass/fail status;
- list of out-of-scope paths;
- list of denied paths;
- active scope hash used for the decision;
- baseline hash/state used for the decision.

## Upgrade-safe boundary

Implement as wrapper/hook/CI/plugin integration. Do not patch Composio AO
`packages/core/`.
