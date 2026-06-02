# Ubuntu port — CI runner migration to Ubuntu

GitHub Issue: #119

## Prerequisite

- `docs/issues_drafts/39-ubuntu-linux-only-port.md` (GitHub #115) — epic tracker.
- `docs/issues_drafts/41-ubuntu-scripts-portability.md` (GitHub #118) — script
  portability. **Hard dependency:** a green Ubuntu CI run requires the scripts to
  run cleanly under `pwsh` on Linux, which is that issue's deliverable. This
  issue must merge after it.
- `docs/issues_drafts/00-architecture-decisions.md` §P (GitHub #3).

## Goal

Make CI gate the repository on Ubuntu instead of Windows. Today every job in
`.github/workflows/scope-guard.yml` runs on `windows-latest`; after this issue
the pack's verification, tests, scope guard, and self-architect lint run on
`ubuntu-latest` under `pwsh`, so a Linux regression blocks merge and Windows is
no longer the gating runtime (decision §P).

## Binding surface

1. **Gating jobs run on Ubuntu.** The jobs in `.github/workflows/scope-guard.yml`
   that currently gate merges (structure verify, contract tests, PR scope guard,
   self-architect lint) execute on `ubuntu-latest` via `pwsh`. This is a
   migration of the gating runner, not an added parallel Windows-plus-Ubuntu
   matrix; native Windows is not the merge gate.

2. **Linux regression is caught.** A change that breaks the pack on Linux makes
   the Ubuntu CI gate fail.

3. **No Windows-only CI setup remains in the gating path.** The migrated jobs do
   not depend on `windows-latest`-only tooling. PowerShell 7 (`pwsh`) and Pester
   are available on the Ubuntu runner; any required modules are installed in the
   job rather than assumed from a Windows image.

The planner chooses job/workflow structure, step names, and how `pwsh` is
invoked; the criteria below bound the outcome, not the YAML shape.

## Files in scope

- `.github/workflows/**` — runner migration.
- `scripts/**` — only if a CI helper script is needed (e.g. a regression-gate
  helper); not for portability work, which is child B's deliverable.

## Files out of scope

- `README.md`, `agent-orchestrator.yaml.example`, `docs/**`, `prompts/**` — owned
  by child A.
- Script portability / retirement / pwsh-7 enforcement — owned by child B
  (`41-ubuntu-scripts-portability.md`). This issue only changes the runner.
- `patch-codex-review4.ps1` retirement (owned by #20).
- `vendor/**`, `packages/core/**`, AO upstream.

## Denylist

```denylist
.ao/**
vendor/**
packages/core/**
docs/**
prompts/**
README.md
agent-orchestrator.yaml.example
agent-orchestrator.yaml
```

```allowed-roots
.github/workflows/**
scripts/**
```

## Acceptance criteria

1. **Ubuntu gate:** the gating jobs in `.github/workflows/scope-guard.yml` run on
   `ubuntu-latest` via `pwsh`; none of the merge-gating jobs run on
   `windows-latest`.
2. **Regression caught:** a deliberately Linux-breaking change causes the Ubuntu
   CI gate to fail (demonstrated, then reverted).
3. **No Windows-only assumption:** the migrated jobs install or invoke `pwsh` and
   Pester on Ubuntu rather than relying on `windows-latest` preinstalled tooling.
4. **§P consistency:** the workflow change agrees with decision §P (Linux-only
   gate).

## Upgrade-safety check

- CI workflow (and at most a CI helper script); no AO core, `vendor/**`, docs, or
  config edits.
- No new repository secrets.
- Preserves planner freedom: no prescribed job names, step layout, or action
  versions.

## Verification

```powershell
Select-String -Pattern 'runs-on:\s*windows-latest' .github/workflows/scope-guard.yml
Select-String -Pattern 'runs-on:\s*ubuntu-latest' .github/workflows/scope-guard.yml
```

- The first search returns no gating job on `windows-latest`; the second shows
  the migrated jobs on `ubuntu-latest`.
- On a PR, the Ubuntu jobs run green; a temporary Linux-breaking commit turns the
  gate red, then is reverted.
