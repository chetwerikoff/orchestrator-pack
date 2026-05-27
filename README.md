# orchestrator-pack

Upgrade-safe safety pack for ComposioHQ Agent Orchestrator (AO).

This repository is intentionally not a fork of `ComposioHQ/agent-orchestrator`.
The AO core remains installed and updated from upstream, preferably through the
npm package `@aoagents/ao`. Everything local to this pack lives in config,
prompt templates, external plugin contracts, scripts, and CI checks.

Hard boundary:

- Do not clone AO into `packages/core`.
- Do not patch `packages/core/` or any upstream AO source.
- If a source checkout is needed for reference, place it under
  `vendor/agent-orchestrator`, treat it as disposable/upstream-only, and keep it
  free of local changes.

## What this pack adds

- `agent-orchestrator.yaml.example` — Windows-friendly AO config example.
- `prompts/agent_rules.md` — portable safety rules injected through
  `agentRulesFile`.
- `prompts/self_architect_check.md` — concise self-review block for agents.
- `plugins/*/README.md` — external plugin contracts only; no core patches.
- `scripts/bootstrap.ps1` — safe helper for checking prerequisites and optionally
  installing the AO CLI.
- `scripts/verify.ps1` — read-only structure/prerequisite verification.
- `scripts/check-reusable.ps1` — guard that rejects tracked files outside the
  reusable-pack policy.
- `scripts/install-git-hooks.ps1` — optional local pre-push hook installer that
  runs verification before `git push`.
- `scripts/patch-codex-review4.ps1` — temporary Windows compatibility patch for
  AO 0.9.2 built-in Codex review (wrong subcommand + shell argument splitting).
  Safe to re-run; no-ops once AO ships the upstream fix.
- `docs/github_issues_cursor_codex_setup.md` — GitHub Issues + Cursor CLI
  planner/worker + Codex reviewer setup notes.
- `.gitignore` — keeps local AO configs, runtime state, target repos, vendor
  checkouts, generated artifacts, and secrets out of Git.
- `.github/workflows/scope-guard.yml` — CI skeleton for the second line of
  defense.

## Official AO baseline

Recommended install:

```powershell
npm install -g @aoagents/ao
```

Windows baseline:

- Use `defaults.runtime: process` (native ConPTY/process runtime).
- `tmux` is not required on Windows.
- PowerShell 7+ is recommended for AO usage, but the verification scripts avoid
  requiring secrets or elevated privileges.

### AO 0.9.2 Windows Codex review patch

**Why it exists:** AO 0.9.2 calls the wrong Codex subcommand on Windows and passes
arguments with `shell: true`, which splits multi-word flags incorrectly. The patch
rewrites the bundled review chunk so AO invokes `codex exec review` reliably.

**Affected version:** `@aoagents/ao` **0.9.2** on Windows only. AO **0.9.3+** is
expected to include the upstream fix; the script detects the installed version and
exits 0 with a no-op message when patching is unnecessary.

**Apply or re-check after upgrades:**

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/patch-codex-review4.ps1
```

Re-run after every `npm install -g @aoagents/ao`. The script is idempotent on 0.9.2
(already-patched installs report a no-op and exit 0).

**Verify whether you still need it:**

1. `ao --version` — if the output is **0.9.3 or newer**, the patch should no-op.
2. Run the script — it prints whether it patched, was already applied, or is not
   needed for your AO version.
3. Confirm built-in review works: create or open a PR in AO and check that the
   dashboard **Reviews** board shows Codex output (not a failed review run).

**Removal condition:** delete `scripts/patch-codex-review4.ps1` and remove README
references once AO **≥ 0.9.3** is released, verified on Windows, and the no-op path
has been confirmed on a clean `npm install -g @aoagents/ao` without manual edits to
`node_modules`.

After patching on 0.9.2, AO calls `codex exec review` locally when a PR is created.
Review results appear in the AO dashboard under "Reviews".

Required external prerequisites for a real AO run:

- Node.js 20+
- Git 2.25+
- GitHub CLI (`gh`) authenticated for GitHub repositories
- npm, to install `@aoagents/ao`

## Run environment and pack verification

From this directory:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

If `pwsh` is not available, Windows PowerShell also works:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

The verifier is read-only. It prints:

- `node`, `git`, `gh`, `npm`, and `ao` versions when available;
- whether Node is at least 20 and Git is at least 2.25;
- `gh auth status` result without printing tokens or environment secrets;
- whether `agent-orchestrator.yaml.example` exists;
- whether `prompts/*.md` exists;
- whether each plugin contract README contains the expected contract markers;
- whether tracked files match the reusable-pack publishing policy when the
  directory is a Git worktree.

Missing AO CLI is reported as a warning, not a pack integrity failure, because AO
can be installed later.

For a stricter local prerequisite check:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1 -StrictPrereqs
```

## Repository publishing policy

This repository should push only reusable pack material:

- plugins and their tests/contracts under `plugins/**`;
- reusable scripts under `scripts/**`;
- reusable prompts under `prompts/**`;
- reusable docs under `docs/**`;
- CI under `.github/workflows/**`;
- examples/templates/schemas and root metadata/config examples.

Do not push real target-repo AO configs, secrets, AO runtime state, target repo
worktrees/clones, generated logs/databases, or upstream AO checkouts.

Before pushing, run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-reusable.ps1
```

After this directory is initialized as a Git repo, install the local pre-push
hook:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-git-hooks.ps1
```

The same reusable-content guard runs in GitHub Actions. After creating the
GitHub repo, protect `main` so direct pushes cannot bypass the workflow: require
PRs and require the `scope-guard` check to pass.

Full policy: `docs/repository_policy.md`.

## Bootstrap helper

Default mode is safe and read-only apart from console output:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
```

It delegates to `scripts/verify.ps1`, prints the same versions/status checks, and
then prints the recommended AO install command:

```powershell
npm install -g @aoagents/ao
```

It does not require `sudo` or Administrator privileges. If global npm installs
are blocked on your machine, configure npm to use a user-owned prefix instead of
running with elevated privileges.

To explicitly install AO CLI through npm:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -InstallAO
```

If `ao` is already installed, both scripts check `ao --version`.

## Configure AO for a target repository

Copy the example config and edit the project block for the real target repo:

```powershell
Copy-Item agent-orchestrator.yaml.example agent-orchestrator.yaml
notepad agent-orchestrator.yaml
```

Keep this line in the project block so AO injects the pack's portable rules:

```yaml
agentRulesFile: prompts/agent_rules.md
```

The example deliberately sets:

- `defaults.runtime: process`
- `defaults.agent: cursor`
- role overrides so both planner/orchestrator and coder/worker use Cursor CLI
- `defaults.workspace: worktree`
- `defaults.notifiers: [desktop]`
- explicit GitHub Issues tracker and GitHub SCM configuration
- automatic handling for `ci-failed` and `changes-requested`
- no auto-merge for `approved-and-green`

Reviewer note: current upstream AO config schema directly exposes orchestrator and
worker role overrides, but not a first-class `reviewer:` role field. Keep the
requested Codex `gpt-5.5` reviewer upgrade-safe by wiring it through an external
plugin/workflow or explicit Codex review session; do not add unsupported YAML
fields and do not patch AO core.

## Start AO only with an explicit target repo

This pack does not run AO against a real repository by default.

After you have selected a target repository, run one of these explicitly:

```powershell
# Local repository
cd C:\Users\che\Documents\Projects\your-target-repo
ao start

# Or pass a local path from anywhere
ao start C:\Users\che\Documents\Projects\your-target-repo

# Or pass a GitHub URL
ao start https://github.com/your-org/your-repo
```

You can also ask the bootstrap script to print the exact next command without
starting AO:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -TargetRepo C:\Users\che\Documents\Projects\your-target-repo
```

## Secrets policy

The scripts in this pack do not read, store, print, or request API keys/tokens.
They call `gh auth status` only to check whether GitHub CLI authentication is
available. Any future plugin implementation must keep secrets in the normal AO,
GitHub CLI, or environment-specific secret stores, not in this repository.
