# orchestrator-pack

Upgrade-safe extensions, safety contracts, scripts, and CI for
ComposioHQ Agent Orchestrator (AO).

This repository is intentionally not a fork of AO. Do not patch `packages/core/**` or
vendor-modify upstream AO. Keep reusable pack behavior in tracked prompts, plugins,
scripts, documentation, configuration examples, and CI.

## Current pack review

PR review is pack-owned. `PACK_REVIEWER` selects Codex or Claude, review starts enter
`scripts/pack-review-runner.ts`, and the reviewer wrapper is
`scripts/invoke-pack-review.ps1`.

AO review HTTP API, `ao review submit`, and project reviewer configuration still exist
upstream in AO 0.10.3, but this pack does not use them as invocation, status, delivery,
fallback, dual-write, or merge-authority paths.

The complete current contract, including exact-head execution, durable PR ↔ session
binding, delivery outcomes, reviewer switching, recovery, and merge authority, is:

- [`docs/pack-review-runbook.md`](docs/pack-review-runbook.md)

Worker-only requirements remain in [`AGENTS.md`](AGENTS.md).

## What this pack adds

- `AGENTS.md` — tracked worker instructions.
- `docs/pack-review-runbook.md` — canonical current review contract.
- `scripts/pack-review-runner.ts` — pack-owned review lifecycle.
- `scripts/invoke-pack-review.ps1` — reviewer-agnostic wrapper.
- `plugins/**` — external plugin contracts and implementations.
- `prompts/**` — reusable prompt fragments.
- `scripts/**` — verification, lifecycle, and safety helpers.
- `.github/workflows/**` — repository checks.
- `agent-orchestrator.yaml.example` — legacy-import example / migration fixture, not live
  pack policy.

Historical AO Reviews Board and daemon-review documents are retained only for clearly
labelled compatibility or prototype context. They are not current review evidence.

## Supported environment

Primary runtime: Ubuntu or WSL2 Ubuntu with repositories on the Linux filesystem.

Recommended prerequisites:

- Node.js 20+
- Git 2.25+
- PowerShell 7+
- authenticated GitHub CLI
- the AO CLI version selected by the operator
- the configured worker and reviewer CLIs on `PATH`

Use the current AO operator upgrade guidance in
[`docs/ao-0-10-operator-upgrade-runbook.md`](docs/ao-0-10-operator-upgrade-runbook.md).

## Verify the pack

From the repository root:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
pwsh -NoProfile -File scripts/lint-self-architect.ps1 -Strict
```

For stricter local prerequisite validation:

```powershell
pwsh -NoProfile -File scripts/verify.ps1 -StrictPrereqs
```

Optional local pre-push hook:

```powershell
pwsh -NoProfile -File scripts/install-git-hooks.ps1
```

## Configure a target repository

First-time Ubuntu / WSL2 setup:

- [`docs/ubuntu-setup-runbook.md`](docs/ubuntu-setup-runbook.md)

Target-repository adoption:

- [`docs/target_repo_setup.md`](docs/target_repo_setup.md)
- [`docs/issue_template_example.md`](docs/issue_template_example.md)

`agent-orchestrator.yaml.example` is not the source of current review or worker policy.
AO 0.10.3 live project settings belong in supported ProjectConfig fields. Worker policy
comes from tracked `AGENTS.md`; pack-review policy comes from the canonical runbook and
pack side-process code.

## Repository publishing boundary

Commit only reusable pack material. Do not commit:

- real target-repository AO configuration;
- secrets or credentials;
- AO runtime state or local stores;
- target-repository worktrees and clones;
- generated logs or databases;
- modified upstream AO source checkouts.

See [`docs/repository_policy.md`](docs/repository_policy.md).

## Secrets

Pack scripts must not print or persist authentication tokens. Use the normal AO, GitHub
CLI, and environment-specific credential stores.
