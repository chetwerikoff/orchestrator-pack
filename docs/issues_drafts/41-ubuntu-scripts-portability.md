# Ubuntu port — script portability and Windows-only retirement

GitHub Issue: #118

## Prerequisite

- `docs/issues_drafts/39-ubuntu-linux-only-port.md` (GitHub #115) — epic tracker.
- `docs/issues_drafts/00-architecture-decisions.md` §P (GitHub #3) — Linux-only
  decision.

Child of the port epic. Independent of child A (docs/config); may land in
parallel. Child C (CI) depends on this issue, since a green Ubuntu CI run
requires portable scripts.

## Goal

Make every pack script under `scripts/` run on Ubuntu under `pwsh` 7+ with no
native-Windows assumption. After this issue there is no *active* runtime path
that depends on native Windows, Windows-only helper scripts that are impossible
or no-ops on Linux are removed, and home/state paths resolve correctly on Linux.

## Binding surface

1. **No active native-Windows runtime path.** Pack scripts under `scripts/`
   contain no active code branch that supports native Windows as a runtime
   target (e.g. `$IsWindows`-gated native-Windows behavior). Cross-platform
   constructs that also work under pwsh on Linux are fine. Historical Windows
   context is allowed only in migration / retirement docs (out of scope here),
   marked legacy — not in active script runtime paths.

2. **Path portability.** Scripts resolve user/home and state paths in a way that
   works on Linux: no `$env:USERPROFILE`, no hardcoded drive letters, no
   backslash-only separators for home/state resolution. The planner chooses the
   mechanism (e.g. `$HOME`, `Join-Path`); the criterion is observable
   cross-platform behavior, not a named helper.

3. **`check-pack-reviewer-persistent-env.ps1` runs on Linux.** This script
   currently fails on Ubuntu; after this issue it runs to a clean exit under
   `pwsh` on Linux (the Windows User/Machine registry fallback from §N degrades
   gracefully to process-only on non-Windows, per that decision).

4. **Retire Windows-only-impossible scripts.** Scripts that are no-ops or
   impossible on Linux are removed and de-referenced within `scripts/**` and any
   in-scope caller (other scripts, the `verify`/test harness). **Doc references**
   to retired helpers (e.g. in `docs/migration_notes.md`, recovery runbook) are
   **not** this child's scope — `docs/**` is denylisted here and that cleanup
   belongs to child A. Known member: `scripts/unlock-op-orchestrator-worktree.ps1`
   (Sysinternals `handle.exe`; no mandatory file locks on Linux). The planner
   identifies the full set. (`patch-codex-review4.ps1` is **not** here — owned by
   #20.)

5. **Enforce pwsh 7+.** `scripts/verify.ps1` detects and enforces PowerShell 7+
   as the supported runtime; Windows PowerShell 5.1 is rejected (not silently
   accepted) with a clear message.

## Files in scope

- `scripts/**` — portability, retirement, pwsh-7 enforcement.

## Files out of scope

- `README.md`, `agent-orchestrator.yaml.example`, `docs/**`, `prompts/**` — owned
  by child A (`40-ubuntu-config-readme-docs.md`).
- `.github/workflows/**` — owned by child C (`42-ubuntu-ci-runner.md`).
- `patch-codex-review4.ps1` retirement (owned by #20).
- Live `agent-orchestrator.yaml` (gitignored; operator-owned).
- `vendor/**`, `packages/core/**`, AO upstream.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
docs/**
README.md
.github/workflows/**
agent-orchestrator.yaml.example
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
```

## Acceptance criteria

1. **No active native-Windows runtime path** in `scripts/**`: a repo-wide search
   shows no `$IsWindows`-gated native-Windows runtime branch and no active use of
   `handle.exe` / Sysinternals / `$env:USERPROFILE` outside retired files.
2. **Path portability:** no script in scope uses `$env:USERPROFILE`, a hardcoded
   drive letter (e.g. `C:\`), or backslash-only separators for home/state
   resolution; equivalent paths resolve under `pwsh` on Linux. Verifiable by the
   marker search below (drive letters and `USERPROFILE`) plus reviewer inspection
   for backslash-built state paths.
3. **`check-pack-reviewer-persistent-env.ps1`** runs to a clean exit on Ubuntu
   under `pwsh`.
4. **Retirement:** `scripts/unlock-op-orchestrator-worktree.ps1` (and any other
   Windows-only-impossible script the planner identifies) is deleted, and no
   reference to the removed basenames remains in `scripts/**` or other in-scope
   callers. (Doc references to retired helpers are child A's scope.)
5. **pwsh 7+ enforcement:** `scripts/verify.ps1` fails with a clear message when
   run under PowerShell 5.1 and passes under pwsh 7+ on Linux.
6. **§P consistency:** changes agree with decision §P (Linux-only, pwsh-keep).

## Upgrade-safety check

- Scripts-only; no AO core, `vendor/**`, docs, config, or workflow edits (those
  belong to siblings A and C).
- Scripts stay `.ps1` run via `pwsh` (decision §P.4 / pwsh-keep); no `.sh`
  rewrite.
- No new secrets.
- Preserves planner freedom: no prescribed function names or path helpers.

## Verification

```powershell
pwsh -NoProfile -Command './scripts/check-pack-reviewer-persistent-env.ps1'
pwsh -NoProfile -Command './scripts/verify.ps1'
pwsh -NoProfile -Command './scripts/test-all.ps1'
# USERPROFILE, Sysinternals handle.exe, $IsWindows, and hardcoded drive letters (C:\):
Get-ChildItem scripts -Recurse -File |
  Select-String -Pattern 'USERPROFILE|handle\.exe|IsWindows|[A-Za-z]:\\'
```

- The search returns no active native-Windows runtime usage (only retired or
  cross-platform-safe matches, if any).
- `verify.ps1` under Windows PowerShell 5.1 exits non-zero with the pwsh-7
  requirement message; under pwsh 7 on Ubuntu it passes.
- No reference to `unlock-op-orchestrator-worktree.ps1` remains in `scripts/**`
  or in-scope callers (doc references are child A's scope).
