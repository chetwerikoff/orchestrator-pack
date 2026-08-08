# scope-guard contract

Runtime-neutral DD-024 scope enforcement without a core patch.

## Purpose

Prevent changes outside declared active scope before `git add` and commit, then
verify the same contract in PR-level CI as a second line of defense.

## Enforcement levels

### First line: runtime guard

The runtime guard runs in the agent execution path before staging or commit.
Supported integration surfaces are:

- the tracked agent wrapper;
- a workspace hook;
- the managed pre-commit hook;
- a command wrapper that validates the index before allowing the operation.

The guard loads the active declaration, enumerates changed paths, normalizes every
path relative to the repository root, rejects out-of-scope and denylisted paths,
and prints a structured violation report. It does not silently broaden scope or
destructively reset files.

### Second line: PR-level CI

`.github/workflows/scope-guard.yml` validates the authoritative merge-base diff
against the same Issue and declaration constraints. CI is audit and enforcement
after the fact; it does not replace local runtime guarding.

## Required inputs

- explicit Issue number;
- repository root;
- active declaration snapshot or validated control-artifact case;
- baseline ref and tree hash;
- changed paths from index, worktree, or PR diff;
- mandatory denylist and optional allowed roots from the live GitHub Issue.

## Required outputs

- pass or fail;
- out-of-scope, denied, and invalid paths;
- active scope hash;
- baseline identity;
- exact configuration or read failure when authority is unavailable.

## Upgrade-safe boundary

The implementation lives in wrappers, hooks, CI, and plugin code. It does not patch
`packages/core/**` or import a concrete runtime implementation.

## Local installation

Install the managed pre-commit hook in a target repository:

```powershell
pwsh -NoProfile -File scripts/install-git-hooks.ps1 -InstallScopeGuard
```

Remove it with:

```powershell
pwsh -NoProfile -File scripts/install-git-hooks.ps1 -UninstallScopeGuard
```

The installer is idempotent and refuses to overwrite an unmanaged hook.

Direct callers pass `--issue` explicitly. Wrappers create an explicit iteration ID
when one is not supplied.

```powershell
node --experimental-strip-types plugins/scope-guard/bin/scope-check.ts `
  --issue 1352 `
  --mode index

node --experimental-strip-types plugins/scope-guard/bin/scope-check.ts `
  --issue 1352 `
  --mode worktree `
  --iteration-id <id>
```

Wrap an agent command:

```powershell
node --experimental-strip-types plugins/scope-guard/bin/agent-wrap.ts `
  --issue 1352 `
  -- cursor agent ...
```

The wrapper captures the pre-command repository state, runs the command, and checks
the resulting worktree. A violation exits non-zero.

## Declaration resolution

Resolution order:

1. `.orchestrator-pack/declarations/{issue}.{iteration}.json` runtime mirror;
2. `docs/declarations/{issue}.{iteration}.json` committed snapshot.

If neither exists, non-control changes fail closed. Control artifacts are the
committed declarations and the gitignored pack mirror. Mixed changes still require
an active declaration.

## Bypass boundary

`OPK_SCOPE_GUARD_BYPASS` may document a local emergency reason for the managed hook.
It never bypasses PR-level CI, the Issue denylist, or current-head verification.

## Contract markers

- DD-024
- runtime guard before `git add` and commit
- PR-level CI as the second line
- denylist remains stronger than broad allow globs
- no core patch
