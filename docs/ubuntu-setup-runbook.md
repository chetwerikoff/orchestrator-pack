# Ubuntu / WSL2 setup runbook

This guide prepares a Linux environment for `orchestrator-pack` without installing
or configuring a concrete orchestration platform.

## Supported platform boundary

| Environment | Supported | Notes |
|---|---:|---|
| Ubuntu 22.04+ on a Linux filesystem | Yes | Primary target |
| WSL2 Ubuntu with repositories under `/home` | Yes | Supported Windows path |
| Native Windows repositories and Windows PowerShell 5.1 | No | Use WSL2 and PowerShell 7 |

Keep the pack and target repositories on the Linux filesystem. Avoid `/mnt/c` for
active worktrees because cross-filesystem metadata and file-watch behavior is less
predictable.

For WSL2, a minimal `/etc/wsl.conf` may disable Windows `PATH` injection when it
causes Linux tools to resolve to Windows executables:

```ini
[interop]
appendWindowsPath=false
```

Apply a WSL configuration change by shutting down the distribution from Windows
and starting it again.

## Base packages

```bash
sudo apt update
sudo apt install -y git curl build-essential
```

Install PowerShell 7 using Microsoft's current Ubuntu package instructions, then
verify:

```bash
pwsh --version
```

Install GitHub CLI from its official package source and authenticate using the
normal device or browser flow:

```bash
gh --version
gh auth status
```

Do not place tokens in repository files, shell history, tracked configuration, or
Issue/PR text.

## Node.js 22 and npm 10

Use a Linux-native Node.js 22.x installation. Verify both tools before installing
workspace dependencies:

```bash
node --version
npm --version
```

The repository contract is Node 22.x and npm 10.x. From the pack root:

```bash
npm ci --include=dev
npm run check:node-major
npm run check:npm-major
```

Do not introduce a second TypeScript launcher, emitted JavaScript build, `tsx`,
`ts-node`, or Node 20 fallback.

## Agent and reviewer CLIs

Install only the CLIs required by the selected workflow and expose them on the
Linux `PATH`. Validate each executable directly from the shell inherited by the
pack process. Keep credentials in the provider's normal secure store.

The pack review engine is selected through the tracked reviewer configuration and
pack-owned runner. Do not invoke a reviewer plugin directly as a substitute for the
runner's claim, head, cap, and publication authority.

## Clone and verify

```bash
mkdir -p ~/projects
cd ~/projects
git clone https://github.com/chetwerikoff/orchestrator-pack.git
cd orchestrator-pack
npm ci --include=dev
pwsh -NoProfile -File scripts/verify.ps1 -StrictPrereqs
pwsh -NoProfile -File scripts/check-reusable.ps1
npm run typecheck:foundation
npm run lint:foundation
npm run test:foundation
```

Use `scripts/bootstrap.ps1 -InstallDependencies -StrictPrereqs` as a convenience
wrapper. It never starts a runtime, creates target-side state, or mutates user
configuration.

## Runtime registration

Runtime operations flow through `RuntimeAdapter` and the registry in
`scripts/runtime/registry.ts`. Before an effect, resolve an adapter-produced exact
identity:

```text
{ runtime, id, generation }
```

Do not authorize effects from a title, process ID, path, branch, display name,
short identifier, stale record, or accounting field. Operator-owned configuration
for a concrete adapter stays outside the repository unless the task explicitly
adds a reusable example.

## Target repository workflow

1. Clone the target repository under the Linux filesystem.
2. Create or select a published GitHub Issue with exact denylist and allowed roots.
3. Create a linked branch and PR.
4. Use pack scripts from the trusted pack checkout.
5. Run target tests plus pack scope, review, and current-head CI checks.
6. Merge only under direct operator authority.

No target-side action is performed merely by cloning or verifying this pack.

## Diagnostics

Run these from the pack root:

```bash
pwsh -NoProfile -File scripts/verify.ps1 -StrictPrereqs
npm run gate-runner-selftest
node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
npm run typecheck:foundation
npm run lint:foundation
```

When a command fails, preserve the exact stderr/stdout, current commit SHA, runtime
identity, and affected path. Do not replace a missing prerequisite with a temporary
wrapper or claim that an unrun check passed.

## Updating the pack

Before updating, record the current branch and commit. Pull the intended branch,
install from the frozen lockfile, rerun verification, and recycle only managed
processes that must load changed tracked files. Host cleanup for removed software
or state is separate optional operator work and never authorizes fallback behavior.
