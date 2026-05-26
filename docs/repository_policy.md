# Repository publishing policy

This repository should contain only reusable `orchestrator-pack` material that can
be applied to other projects.

## Commit and push

Allowed categories:

- `plugins/**` — external plugin implementations/contracts/tests;
- `prompts/**` — reusable prompt fragments and agent rules;
- `scripts/**` — reusable setup, verification, guard, and developer scripts;
- `.github/workflows/**` — reusable CI checks;
- `docs/**` — reusable architecture, migration, and usage notes;
- config examples such as `agent-orchestrator.yaml.example`;
- repository metadata such as `README.md`, `AGENTS.md`, `.gitignore`, and
  package/tooling config for this pack.

Do not commit or push:

- real `agent-orchestrator.yaml` files for a target repo;
- `.env*` secrets, tokens, certificates, SSH keys, or local credential files;
- AO runtime/session state: `.ao/`, `.agent-orchestrator/`, ledgers/databases;
- target repository clones, worktrees, scratch directories, or generated logs;
- `vendor/agent-orchestrator` or any modified upstream AO source;
- `packages/core/**` patches from Composio AO.

## Local pre-push check

Before pushing, run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-reusable.ps1
```

Optional local hook, after this directory is a Git repo:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-git-hooks.ps1
```

The hook is not committed by Git, but the installer script is reusable. It makes
`git push` run both pack verification and the reusable-content guard locally.

On Windows PowerShell without `pwsh`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/check-reusable.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-git-hooks.ps1
```

## GitHub protection

After the GitHub repo exists, protect the default branch so direct pushes cannot
bypass the guard:

1. Require pull requests before merging.
2. Require the `scope-guard` workflow to pass.
3. Require `scripts/check-reusable.ps1` to pass in CI.
4. Disable or restrict direct pushes to `main`.
5. Keep auto-merge off unless the reusable-content guard is required and green.

CI is the server-side backstop. The local `.gitignore` and `check-reusable.ps1`
are the developer-side backstop.
