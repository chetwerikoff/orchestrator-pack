# Ubuntu port — Linux-first config, README, and docs

GitHub Issue: #117

## Prerequisite

- `docs/issues_drafts/39-ubuntu-linux-only-port.md` (GitHub #115) — epic tracker.
- `docs/issues_drafts/00-architecture-decisions.md` §P (GitHub #3) — Linux-only
  decision; this child implements its documentation and config surface.

Child of the port epic. Independent of child B (scripts) and child C (CI); may
land in parallel with B.

## Goal

Remove the Windows-first default mental model from the repository's
documentation and example config, and give operators a Linux/Ubuntu setup path.
After this issue, `README.md` presents pwsh-on-Linux as the baseline (not a
fallback), `agent-orchestrator.yaml.example` is Linux-first, and there is a
runbook for standing up the pack on Ubuntu/WSL2 from scratch.

## Binding surface

1. **Linux-first example config.** `agent-orchestrator.yaml.example` reflects a
   Linux / pwsh-7 runtime. The Windows PowerShell 5.1-specific launch-hazard
   rationale prose in `orchestratorRules` (the §G / §I quote-safety / `printf`
   warnings that exist only because of Windows PS 5.1) is removed or replaced,
   since it does not apply to pwsh 7 on Linux. The orchestratorRules literal
   stays valid for the existing quote-safety check, which MUST keep passing.
   (If that check turns out to be Windows-only and warrants retirement, that is
   child B's scope — it lives under `scripts/`, which this child denylists.)

2. **README de-Windowsization.** `README.md` no longer presents native Windows
   as the primary baseline. Specifically: it does not describe a "Windows
   baseline", does not call the example config "Windows-friendly", and does not
   instruct users to run `powershell.exe` / Windows PowerShell as the default
   setup path. The supported Windows path is stated as WSL2 Ubuntu only. Any
   retained Windows reference is explicitly historical or retirement-related.

3. **Ubuntu setup runbook.** A new operator-facing doc captures the non-obvious
   environment gotchas to stand up the pack on Ubuntu/WSL2 from scratch,
   covering at least: snap `node` forcing the npm prefix (use a user-writable
   prefix instead of `/usr/local`); `/snap/bin` not on `PATH` by default;
   `appendWindowsPath=false` in `/etc/wsl.conf` for a clean PATH on WSL; and
   native `cursor-agent` + `codex` CLI installation.

4. **WSL2 / ext4 boundary.** The docs state explicitly that the only supported
   Windows path is WSL2 Ubuntu, with the target repo and AO state on the Linux
   filesystem (ext4, `/home/...`), never `/mnt/c` (decision §P.3).

5. **Doc references to retired Windows-only helpers.** Docs no longer instruct
   operators to run Windows-only helper scripts that the port retires — known
   case: `unlock-op-orchestrator-worktree.ps1` (referenced in
   `docs/migration_notes.md` and the recovery runbook). The script deletion
   itself is child B's scope; removing the *doc* guidance that points at it is
   this child's, since `docs/**` is owned here.

6. **Operator adoption.** Post-PR steps are documented (see below).

### Operator adoption

This issue changes `agent-orchestrator.yaml.example` and operator-facing docs.
After merge the operator MUST:

- Merge the Linux-first `agent-orchestrator.yaml.example` deltas into the live
  gitignored `agent-orchestrator.yaml`, including the dropped Windows prose.
- Relocate the target repo and AO state onto ext4 (`/home/...`), never `/mnt/c`.
- Follow the new Ubuntu setup runbook for environment provisioning.

The live yaml merge and environment provisioning are operator-owned; the worker
documents them and does not execute them.

## Files in scope

- `README.md` — de-Windowsization.
- `agent-orchestrator.yaml.example` — Linux-first config.
- `docs/**` — new Ubuntu setup runbook (new file, planner names it);
  `docs/migration_notes.md` operator-adoption subsection.

## Files out of scope

- `scripts/**` — owned by child B (`41-ubuntu-scripts-portability.md`).
- `.github/workflows/**` — owned by child C (`42-ubuntu-ci-runner.md`).
- `patch-codex-review4.ps1` retirement (owned by #20).
- Live `agent-orchestrator.yaml` (gitignored; operator-owned).
- `vendor/**`, `packages/core/**`, AO upstream.

## Denylist

```denylist
packages/core/**
vendor/**
.ao/**
agent-orchestrator.yaml
scripts/**
.github/workflows/**
prompts/**
```

```allowed-roots
README.md
agent-orchestrator.yaml.example
docs/**
```

## Acceptance criteria

1. **Linux-first config.** `agent-orchestrator.yaml.example` no longer carries
   Windows PowerShell 5.1-specific launch-hazard rationale prose in
   `orchestratorRules`; the existing quote-safety check still passes (retiring
   that check, if Windows-only, is child B's scope, not this child's).
2. **README not Windows-first.** `README.md` does not present Windows as the
   primary baseline, does not label the example config "Windows-friendly", and
   does not present `powershell.exe` / Windows PowerShell as the default setup
   path. pwsh on Linux is the baseline.
3. **No active-doc Windows artifacts.** A repo-wide search of active setup docs
   (`README.md` and the new runbook) for `C:\`, `powershell.exe`,
   `Windows-friendly`, `ConPTY`, and `Windows baseline` either returns no
   matches or each remaining match is explicitly historical / retirement-only.
4. **Ubuntu setup runbook exists** covering, at minimum: snap-node npm prefix
   workaround, `/snap/bin` on PATH, `appendWindowsPath=false` in
   `/etc/wsl.conf`, and native `cursor-agent` + `codex` CLI install; linked from
   `docs/migration_notes.md` or an existing docs index.
5. **WSL2/ext4 boundary documented:** docs state the supported Windows path is
   WSL2 Ubuntu only with repo + AO state on ext4, never `/mnt/c`.
6. **Operator adoption documented:** the PR carries an `## Operator adoption`
   section and `docs/migration_notes.md` gains a matching subsection (§M).
7. **No doc guidance to retired Windows-only helpers:** `docs/**` (including
   `migration_notes.md` and the recovery runbook) no longer instructs operators
   to run `unlock-op-orchestrator-worktree.ps1`; any remaining mention is
   explicitly retirement/legacy-tagged.
8. **§P consistency:** changed files agree with decision §P.

## Upgrade-safety check

- Pack-only docs and example YAML; no AO core, `vendor/**`, scripts, or workflow
  edits (those belong to siblings B and C).
- No new secrets; orchestratorRules stay valid for the quote-safety check.
- Preserves planner freedom: no prescribed runbook filename, headings, or prose
  structure.

## Verification

```powershell
# Run under pwsh 7+ on Ubuntu.
# Criterion 3 — all five markers across only the active setup docs: README.md and the
# runbook the planner adds (substitute its path for docs/<runbook>.md). Do NOT scan all
# of docs/ — draft/history docs under docs/issues_drafts/** intentionally contain markers.
Select-String -Path README.md, docs/<runbook>.md `
  -Pattern 'C:\\|powershell\.exe|Windows-friendly|ConPTY|Windows baseline'
Select-String -Pattern 'Operator adoption' docs/migration_notes.md
pwsh -NoProfile -Command './scripts/verify.ps1'
pwsh -NoProfile -Command './scripts/check-reusable.ps1'
```

- The marker search over `README.md` + the new runbook returns nothing active
  (only legacy/retirement-tagged lines, if any).
- The new runbook enumerates the four env gotchas in criterion 4 and the
  WSL2/ext4 boundary in criterion 5.
- `agent-orchestrator.yaml.example` quote-safety check still passes.
