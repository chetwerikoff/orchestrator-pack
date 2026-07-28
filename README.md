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

## Local Codex review (active)

Local Codex PR review **is active** in this pack. AO drives it through the
first-class `ao review` CLI (`run`, `send`, `list`, `execute`). Orchestration
and the autonomous review loop are wired in the project's `orchestratorRules`
block in `agent-orchestrator.yaml` (see `agent-orchestrator.yaml.example`).
Discover current runs with `ao review list <project>` or the AO dashboard
Reviews board.

On AO 0.9.x there is no `reviewer:` YAML role that AO reads — if you add
`reviewer:` to YAML, AO parses it without error or warning but silently ignores
it; wire review through `orchestratorRules` and `ao review`, not a `reviewer:`
key.

See also: [`AGENTS.md`](AGENTS.md),
[`docs/architecture.md`](docs/architecture.md#review-paths),
[`docs/github_issues_cursor_codex_setup.md`](docs/github_issues_cursor_codex_setup.md),
and [`plugins/ao-codex-pr-reviewer/README.md`](plugins/ao-codex-pr-reviewer/README.md).

## What this pack adds

- `agent-orchestrator.yaml.example` — Linux-first AO config example (Ubuntu / WSL2, pwsh 7+).
- `AGENTS.md` — portable safety rules for AO workers (native pickup on AO 0.10.2+).
- `prompts/self_architect_check.md` — concise self-review block for agents.
- `plugins/*/README.md` — external plugin contracts only; no core patches.
- `scripts/bootstrap.ps1` — safe helper for checking prerequisites and optionally
  installing the AO CLI.
- `scripts/verify.ps1` — read-only structure/prerequisite verification.
- `scripts/check-reusable.ps1` — guard that rejects tracked files outside the
  reusable-pack policy.
- `scripts/lint-self-architect.ps1` — warning-first lint for duplicated prompt
  literals and paired script/template drift (see `prompts/self_architect_check.md`).
- `scripts/install-git-hooks.ps1` — optional local pre-push hook installer that
  runs verification before `git push`.
- `scripts/patch-codex-review4.ps1` — **legacy (retired on Linux):** temporary
  patch for AO 0.9.2 built-in Codex review on native Windows only. Not used on
  Ubuntu/WSL2; removal tracked separately.
- `docs/github_issues_cursor_codex_setup.md` — GitHub Issues + Cursor CLI
  planner/worker + Codex reviewer setup notes.
- `.gitignore` — keeps local AO configs, runtime state, target repos, vendor
  checkouts, generated artifacts, and secrets out of Git.
- `.github/workflows/scope-guard.yml` — CI skeleton for the second line of
  defense.

## Official AO baseline

**Platform:** Ubuntu 22.04+ or **WSL2 Ubuntu** only. Native Windows is not a
supported runtime — use WSL2 and keep repos on the Linux filesystem (`/home/...`,
ext4), never `/mnt/c`. See
[`docs/ubuntu-setup-runbook.md`](docs/ubuntu-setup-runbook.md).

Recommended install (when npm publishes your target version):

```bash
npm install -g @aoagents/ao
```

When npm lags behind the stable GitHub release (for example **0.10.2** while npm
still exposes **0.10.0**), use the GitHub release asset path documented in
[`docs/ao-0-10-operator-upgrade-runbook.md`](docs/ao-0-10-operator-upgrade-runbook.md).
Treat GitHub releases, not npm `latest`, as the source for **0.10.1+** adoption
until platform packages catch up.

Linux baseline:

- Run pack scripts with **pwsh 7+** (`pwsh -NoProfile -File scripts/...`).
- Use `defaults.runtime: process` (or `tmux` if you prefer AO’s tmux runtime).
- Install `cursor-agent` / `agent` and `codex` on `PATH` for worker and review
  paths — see the Ubuntu setup runbook.

Required external prerequisites for a real AO run:

- Node.js 20+
- Git 2.25+
- GitHub CLI (`gh`) authenticated for GitHub repositories
- npm, to install `@aoagents/ao`

## Run environment and pack verification

From this directory (Ubuntu or WSL2):

```powershell
pwsh -NoProfile -File scripts/verify.ps1
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
pwsh -NoProfile -File scripts/verify.ps1 -StrictPrereqs
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
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
pwsh -NoProfile -File scripts/lint-self-architect.ps1
```

### Self-architect lint

The lint scans staged changes by default (add `-WithWorkingTree` to include unstaged
and untracked files). It depends only on Git and PowerShell.

```powershell
pwsh -NoProfile -File scripts/lint-self-architect.ps1
pwsh -NoProfile -File scripts/lint-self-architect.ps1 -Strict
```

`-Strict` is used in CI and exits 1 only for:

- **duplicate-literal** — identical blocks of ≥ 10 consecutive lines in two or
  more files under configured scan paths.
- **paired-edit-divergence** — both a script and a template changed in the same
  diff and share an ≥ 8-line partially matching block that diverged.

Heuristic near-duplicate detection emits `[WARN]` lines only. Configure paths,
thresholds, and justified suppressions in `scripts/lint-self-architect.config.json`:

```json
{
  "suppressions": [
    {
      "rule": "duplicate-literal",
      "files": ["prompts/example-a.md", "prompts/example-b.md"],
      "reason": "intentional shared boilerplate"
    }
  ]
}
```

After this directory is initialized as a Git repo, install the local pre-push
hook:

```powershell
pwsh -NoProfile -File scripts/install-git-hooks.ps1
```

The same reusable-content guard runs in GitHub Actions. After creating the
GitHub repo, protect `main` so direct pushes cannot bypass the workflow: require
PRs and require the `scope-guard` check to pass.

Full policy: `docs/repository_policy.md`.

## Bootstrap helper

Default mode is safe and read-only apart from console output:

```powershell
pwsh -NoProfile -File scripts/bootstrap.ps1
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
pwsh -NoProfile -File scripts/bootstrap.ps1 -InstallAO
```

If `ao` is already installed, both scripts check `ao --version`.

## Configure AO for a target repository

**First-time Ubuntu / WSL2 environment** (snap npm prefix, PATH, `wsl.conf`,
agent CLIs):

- [`docs/ubuntu-setup-runbook.md`](docs/ubuntu-setup-runbook.md)

End-to-end adoption checklist (pre-commit hook, Codex CI workflow, first scoped
issue, `ao-declare`, and scope-guard smoke tests):

- [`docs/target_repo_setup.md`](docs/target_repo_setup.md)
- [`docs/issue_template_example.md`](docs/issue_template_example.md) — minimal
  GitHub Issue body with mandatory `denylist` and optional `allowed-roots` fences

Copy the example config and edit the project block for the real target repo:

```powershell
Copy-Item agent-orchestrator.yaml.example agent-orchestrator.yaml
# edit with your preferred editor, e.g. nano or $EDITOR on Linux
```

Keep worker rules in the tracked `AGENTS.md` file — AO 0.10.2+ workers pick it up natively
from the worktree (recycle worker sessions after merge; no `agentRulesFile` key):

```yaml
# Worker rules: AGENTS.md (native pickup — no agentRulesFile on AO 0.10.2+)
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

Review wiring: local Codex review is active via `orchestratorRules` and the
`ao review` CLI (see [Local Codex review](#local-codex-review-active) above).
On AO 0.9.x, a `reviewer:` YAML block is silently ignored (no schema error) —
do not rely on it. Keep Codex `gpt-5.5` review upgrade-safe through
`orchestratorRules` and `ao review`; do not patch AO core.

## Start AO only with an explicit target repo

This pack does not run AO against a real repository by default.

After you have selected a target repository, run one of these explicitly:

```bash
# Local repository (path on ext4, e.g. /home/you/projects/your-target-repo)
cd /home/you/projects/your-target-repo
ao start

# Or pass a local path from anywhere
ao start /home/you/projects/your-target-repo

# Or pass a GitHub URL
ao start https://github.com/your-org/your-repo
```

You can also ask the bootstrap script to print the exact next command without
starting AO:

```powershell
pwsh -NoProfile -File scripts/bootstrap.ps1 -TargetRepo /home/you/projects/your-target-repo
```

## Secrets policy

The scripts in this pack do not read, store, print, or request API keys/tokens.
They call `gh auth status` only to check whether GitHub CLI authentication is
available. Any future plugin implementation must keep secrets in the normal AO,
GitHub CLI, or environment-specific secret stores, not in this repository.
