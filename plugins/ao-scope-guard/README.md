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

## Runtime installation (layers 1 and 2)

Layer 3 (PR-level CI) lives in `.github/workflows/scope-guard.yml` (#6) and
remains the **second line** at merge time. Local enforcement uses the agent
wrapper first, then the pre-commit hook.

### Pre-commit hook (layer 2)

Opt-in via the pack installer in a **target repository** (not enabled by default
in the pack itself):

```powershell
.\scripts\install-git-hooks.ps1 -InstallScopeGuard
```

Requirements:

- `AO_ISSUE_NUMBER` must be set to the active GitHub Issue number.
- `AO_SESSION_ID` should be set when running under AO; otherwise the wrapper
  generates a wrapper iteration id.
- The hook invokes `scope-check --mode index` against staged paths.

Remove the hook:

```powershell
.\scripts\install-git-hooks.ps1 -UninstallScopeGuard
```

The installer is idempotent: re-running `-InstallScopeGuard` replaces the managed
hook with the same content.

### Bypass with justification

For emergency commits, set `AO_SCOPE_GUARD_BYPASS` to a short reason before
committing. Document the same reason in the commit message or PR. Bypass is
local only; PR CI (#6) still enforces scope.

```powershell
$env:AO_SCOPE_GUARD_BYPASS = "hotfix: unblock CI while declaration is regenerated"
git commit -m "..."
```

### Agent wrapper (layer 1)

Wrap cursor/codex invocations so scope is checked after each agent turn:

```powershell
node --import tsx plugins/ao-scope-guard/bin/agent-wrap.ts `
  --issue 5 `
  -- cursor agent ...
```

On success the wrapper runs `scope-check --mode worktree`, diffing the working
tree against `baseline.commit_sha` from the active declaration. On violation it
exits non-zero and refuses to proceed.

Environment variables:

- `AO_ISSUE_NUMBER` — issue number when `--issue` is omitted
- `AO_SESSION_ID` — iteration id under AO

### scope-check CLI

Direct invocation (used by the hook and wrapper):

```powershell
node --import tsx plugins/ao-scope-guard/bin/scope-check.ts `
  --issue 5 `
  --mode index

node --import tsx plugins/ao-scope-guard/bin/scope-check.ts `
  --issue 5 `
  --mode worktree `
  --iteration-id <id>
```

Declaration resolution order:

1. `.ao/declarations/{issue}.{iteration}.json` mirror (runtime)
2. `docs/declarations/{issue}.{iteration}.json` committed snapshot

If neither exists and the change set is **not** pure control artifacts, the
check fails with a structured JSON report on stderr.

### Control-artifact exclusion

These paths are always allowed and never reported as violations (hardcoded):

- `docs/declarations/**` — committed declaration snapshots
- `.ao/**` — gitignored runtime mirror/state

**Pure control-artifact policy:** when every changed path is a control artifact,
scope check exits 0 even without an active declaration.

**Mixed policy:** control-artifact paths are skipped; remaining paths require an
active declaration. No declaration → reject.

Violations emit exit code 1 and a structured JSON report listing out-of-scope,
denied, and invalid paths plus the active scope hash used for the decision.
