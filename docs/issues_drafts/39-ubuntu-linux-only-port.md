# Ubuntu / Linux-only port (epic)

GitHub Issue: #115

## Prerequisite

- `docs/issues_drafts/00-architecture-decisions.md` §P (GitHub #3) — Ubuntu /
  Linux-only port target. This epic implements §P; the decision log is the
  contract.
- `docs/issues_drafts/10-patch-codex-review4-retirement.md` (GitHub #20) —
  `patch-codex-review4.ps1` retirement is tracked there. This epic does **not**
  re-scope that script; it only depends on it being gone on Linux.

No hard dependency on other open implementation issues. The port is drivable
from the still-Windows orchestrator during the transition.

## Goal

Make `orchestrator-pack` run natively on Ubuntu (and WSL2 Ubuntu, the only
supported Windows path) without native-Windows assumptions. After this epic,
a clean Ubuntu checkout can install, run the pack scripts via `pwsh`, boot the
AO dashboard, and pass the test suite, with no `$IsWindows` branches or
Windows-only helpers left behind. Native Windows ceases to be a runtime target
(decision §P). The branch chain is `feat/ubuntu-port` → `main`.

This is an umbrella epic: the planner MAY land it as one PR or split it into
focused PRs per area. The acceptance criteria below define the end state; the
split is the planner's call.

## Binding surface

The repository commits to the following Linux-first end state. Concrete about
observable outcomes, deliberately silent on file shapes.

1. **Linux-first example config.** `agent-orchestrator.yaml.example` reflects a
   Linux/pwsh-7 runtime. The Windows PowerShell 5.1 launch-hazard prose in
   `orchestratorRules` (the §G / §I quote-safety and `printf`-launch warnings
   that exist only because of Windows PS 5.1) is removed or replaced, since it
   does not apply to pwsh 7 on Linux. Quote-safety of the literal is still not
   required to regress — but the *rationale* prose tied to Windows is dropped.

2. **Windows-only scripts retired.** Scripts that are no-ops or impossible on
   Linux are removed and de-referenced from any wiring, callers, docs, and
   `verify`/test harness. Known members of this class:
   - `scripts/unlock-op-orchestrator-worktree.ps1` (Sysinternals `handle.exe`;
     no mandatory file locks on Linux).
   - (`patch-codex-review4.ps1` is handled by #20 — out of scope here.)
   The planner identifies the full set; the criterion is that no retired
   script remains referenced anywhere in the tree.

3. **Cross-platform path portability.** Pack scripts resolve user/home and
   state paths in a way that works on Linux (e.g. `$HOME` rather than
   `$env:USERPROFILE`, no hardcoded drive letters or backslash-only paths).
   `scripts/check-pack-reviewer-persistent-env.ps1`, which currently fails on
   Linux, runs cleanly on Ubuntu. The planner chooses the portability
   mechanism; the criterion is observable cross-platform behavior, not a named
   helper.

4. **Ubuntu setup runbook.** A new operator-facing doc captures the non-obvious
   environment gotchas needed to stand up the pack on Ubuntu/WSL2 from scratch,
   covering at least: snap `node` forcing the npm prefix (use a user-writable
   prefix instead of `/usr/local`); `/snap/bin` not being on `PATH` by default;
   `appendWindowsPath=false` in `/etc/wsl.conf` for a clean PATH on WSL; and
   native `cursor-agent` + `codex` CLI installation. This is documentation; the
   operator executes it (decision §P.5).

5. **CI keeps the port green.** CI runs the pack's verification and test entry
   points on Ubuntu via `pwsh` (the same logical checks today's Windows path
   runs: the `verify` script and the full test harness). A regression that
   breaks Linux fails CI. The planner picks the workflow/job shape; the
   criterion is that an Ubuntu job exercising `pwsh` + the test suite exists and
   gates merges.

### Operator adoption

This epic changes operator-facing surfaces (`agent-orchestrator.yaml.example`,
a new setup runbook, environment expectations). Post-PR, the operator MUST:

- Re-clone or relocate the target repo and AO state onto the Linux filesystem
  (`/home/...`, ext4) — never `/mnt/c` (decision §P.3).
- Merge the Linux-first `agent-orchestrator.yaml.example` deltas into the live
  gitignored `agent-orchestrator.yaml`, including the dropped Windows prose.
- Follow the new Ubuntu setup runbook for env provisioning (npm prefix,
  `/snap/bin` PATH, `/etc/wsl.conf`, native `cursor-agent` + `codex` CLI).
- Re-run `ao doctor`, `ao start --no-orchestrator`, and `ao stop` on Ubuntu to
  confirm a clean boot/teardown before relying on the loop.

The live yaml merge and environment provisioning are operator-owned and are
**not** performed by the worker.

## Files in scope

- `agent-orchestrator.yaml.example` — Linux-first config; drop Windows-only prose.
- `scripts/**` — retire Windows-only scripts; path portability.
- `.github/workflows/**` — Ubuntu CI job running `pwsh` + the test suite.
- `docs/**` — new Ubuntu setup runbook (new file, planner names it);
  `docs/migration_notes.md` operator-adoption subsection.
- `docs/issues_drafts/00-architecture-decisions.md` — §P (decision log; already
  added in the spec PR, referenced here).
- `docs/issues_drafts/39-ubuntu-linux-only-port.md` — this spec.
- `prompts/agent_rules.md` — only if a universal rule references a retired
  Windows-only script or a Windows-only assumption that must be corrected.

## Files out of scope

- `vendor/**`, `packages/core/**`, AO upstream.
- Live `agent-orchestrator.yaml` (gitignored; operator-owned).
- `patch-codex-review4.ps1` retirement (owned by #20).
- Environment provisioning itself (operator-manual; the runbook documents it,
  the worker does not run it).
- The live gitignored yaml merge and any machine-local CLI config.

## Denylist

```denylist
packages/core/**
vendor/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
agent-orchestrator.yaml.example
scripts/**
.github/workflows/**
docs/**
prompts/**
```

## Acceptance criteria

1. **Linux-first example config.** `agent-orchestrator.yaml.example` no longer
   carries Windows PowerShell 5.1-specific launch-hazard rationale prose in
   `orchestratorRules`; the existing quote-safety check (if still relevant on
   Linux) passes or is retired with justification.
2. **No retired script remains referenced.** `scripts/unlock-op-orchestrator-worktree.ps1`
   (and any other Windows-only-impossible script the planner identifies) is
   deleted, and a repository-wide search finds no remaining references to the
   removed basenames in scripts, docs, workflows, or YAML.
3. **Path portability.** `scripts/check-pack-reviewer-persistent-env.ps1` runs to
   a clean exit on Ubuntu under `pwsh`. No pack script in scope relies on
   `$env:USERPROFILE`, drive letters, or backslash-only path separators for
   home/state resolution.
4. **Ubuntu setup runbook exists.** A new doc covers, at minimum: snap-node npm
   prefix workaround, `/snap/bin` on PATH, `appendWindowsPath=false` in
   `/etc/wsl.conf`, and native `cursor-agent` + `codex` CLI install. It is
   linked from `docs/migration_notes.md` or an existing docs index.
5. **Ubuntu CI job.** A CI workflow runs the pack's `verify` entry point and the
   full test harness on `ubuntu-latest` via `pwsh`, and a deliberately
   Linux-breaking change fails that job.
6. **Decision consistency.** The epic and all changed files are consistent with
   `docs/issues_drafts/00-architecture-decisions.md` §P (Linux-only, same repo,
   ext4 invariant, pwsh-keep, worker/operator boundary).
7. **Operator adoption documented.** The PR body carries an `## Operator
   adoption` section and `docs/migration_notes.md` gains a matching subsection
   per the §M handoff contract.

## Upgrade-safety check

- Pack-only example YAML, scripts, docs, workflows, and universal prompts; no
  AO core or `vendor/**` edits.
- No new repository secrets.
- No native-Windows runtime support is added back; deletions of Windows-only
  paths are intentional per §P.
- Live `agent-orchestrator.yaml` is never edited by the worker; only the
  `.example` is changed (operator merges).
- Preserves planner freedom: no prescribed script names, function shapes,
  workflow structure, or library versions.

## Verification

```powershell
# On Ubuntu / WSL2 Ubuntu under pwsh 7:
pwsh -NoProfile -Command './scripts/verify.ps1'
pwsh -NoProfile -Command './scripts/test-all.ps1'
pwsh -NoProfile -Command './scripts/check-pack-reviewer-persistent-env.ps1'
ao doctor
ao start --no-orchestrator   # dashboard boots on the tmux runtime
ao stop                      # clean teardown, no orphans
```

- **Retired-script check:** a repo-wide search for each removed basename returns
  no references outside its own (now absent) file.
- **CI:** the Ubuntu job is present and green on the port branch; a temporary
  Linux-breaking commit makes it red (then reverted).
- **Runbook:** the new doc enumerates the four env gotchas in §4 above and is
  reachable from a docs index or `migration_notes`.

**Pre-sync note:** decision set and port findings validated on a live WSL2
Ubuntu polygon 2026-06-01 (recorded in architect memory). Run the Codex draft
review pass before `gh issue create`.
