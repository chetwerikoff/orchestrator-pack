# Autonomous-orchestrator boundary (#324) is inert in the live login-shell turn → orchestrator corrupts its own session branch

GitHub Issue: #353

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md`
  (GitHub #324) — shipped `scripts/ao`, `scripts/git`, the guards, and the
  `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE` mechanism. This issue makes that boundary
  **actually take effect in the live orchestrator turn**; it does not redesign the
  guards.
- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub #318) —
  same inert-in-live-session class for the review-start guard.
- `docs/issues_drafts/33-orchestrator-session-launch-death-and-worktree-hygiene.md`
  (GitHub #91) — shipped `orchestrator-worktree-preflight.ps1`, extended by the
  defense-in-depth section below.

## Goal

The #324 process boundary must be **provably active in the orchestrator's live
turns**: a bare `ao spawn`/`--claim-pr` or tree-mutating `git` (`branch -m`,
`checkout`, …) issued from an orchestrator turn must be **denied (exit 93)**,
while read-only `ao`/`git` still work — and this must hold **durably and under
CI**, not as hand-edited local files.

Today #324 is shipped and even "adopted" (config + `ao stop/start`) yet **does
nothing** in the running orchestrator, so the orchestrator keeps running
`ao spawn --claim-pr <PR>` and `git branch -m feat/X …` itself, which corrupts its
own session record's `branch` to a worker branch and detonates as a
worktree-collision on the next restore.

## Root cause (evidence-backed, 2026-06-17)

1. **The boundary never reaches the orchestrator's command shell.** The opencode
   runtime shim sets `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1` and prepends pack
   `scripts/` to `PATH` (AO 0.9.x merges `project.env` only, **not**
   `agentConfig.env`, so the shim compensates). But the orchestrator's bash tool
   runs commands in a **login shell**, and `~/.profile` / `~/.bashrc` **rebuild
   `PATH` from scratch**, dropping the `scripts/` prepend. `BASH_ENV` is sourced
   **before** the profile (verified), so it cannot re-assert `scripts/`; the
   existing `BASH_ENV` interposer only rewrites **absolute** `git`/`ao` paths, not
   bare names. Net: bare `ao` → `~/.local/bin/ao` (operator diag wrapper), bare
   `git` → `/usr/bin/git` — the guards under `scripts/` are never reached.
2. **So the orchestrator's own turn mutates state unblocked.** Command log proof:
   the orchestrator session ran `ao spawn --claim-pr 334` at `15:56:21`; `feat/332`
   first appears in the event stream `15:56:27` (6 s later). AO's claim path
   (`checkoutPR`) stamped the claimed PR's branch (`feat/332`) onto the
   **orchestrator's** session record `branch` (the only code that writes that
   field; the `refreshTrackedBranch` writer is worker-only and skips the
   orchestrator).
3. **Takeover orphans the field.** When the real worker later claims the same PR,
   AO's takeover resets the orchestrator's `pr` to none but **does not touch
   `branch`** — leaving `branch=feat/332, pr=none`.
4. **Restore detonates.** On `ao start`, orchestrator restore reuses the persisted
   `branch` verbatim (`git worktree add … feat/332`) and collides with the worker
   worktree holding `feat/332` → `Workspace missing … restore failed`.

The verified, durable lever: **bare `ao`/`git` resolve to `~/.local/bin` first
even in login shells** (profile itself puts `~/.local/bin` ahead of `/usr/bin`),
and the **env var `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE` survives profile
re-sourcing** (unlike a `PATH` prepend). So a surface-gated guard at the
bare-resolution layer catches bare `ao`/`git` regardless of the lost `scripts/`
prepend. (Manually verified: with such guards, login-shell `ao spawn` / `git
branch -m` / `git checkout` → rc 93; `git status` / read-only → rc 0; non-surface
transparent.)

## Binding surface

### A. Primary — make the boundary durably active in the live login-shell turn

1. **Surface-gated guards at the bare-resolution layer.** The pack must install,
   at the location where bare `ao`/`git` resolve in the orchestrator's login-shell
   turn (today `~/.local/bin`), thin guards that — **only** when
   `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1` — route the invocation through the
   existing pack guards (`scripts/ao` / `scripts/git`), and are otherwise
   **transparent** (forward to the real `ao` / system `git`). Gating on the env
   var (not `PATH`) is required because the env var survives profile re-sourcing
   and `PATH` prepends do not. The planner owns the install mechanism (generated
   shim, symlink, or runtime-shim integration) and exact paths.
2. **Loop-safety (mandatory).** The guard chain must not recurse: the real-binary
   resolution must use **absolute** paths, not bare `ao`/`git` (which would
   re-enter the layer-A guard). At minimum: `.ao/autonomous-real-binaries.json`
   `ao` points at the real binary (not the operator wrapper), and the git guard
   passes straight through when `AO_AUTONOMOUS_GIT_INTERNAL_EXEC=1` (the flag the
   guard sets while invoking the real git). A fixture must prove no infinite loop
   on an allowed read-only command.
3. **Durable + operator-applied.** The deliverable is a **pack-owned installer**
   (in `scripts/`, wired into the orchestrator-runtime setup / runbook), because
   the guard files live **outside the repo** (`~/.local/bin`) and a worker PR
   cannot place them there directly. The PR ships the installer + guard content +
   tests + docs; the **operator runs the installer** post-merge (documented step).
   Re-running the installer must be idempotent and must supersede any hand-placed
   guard.
4. **Provably-active acceptance (the #318/#324 lesson).** "Edited config + `ao
   start`" is **not** sufficient evidence. The contract is a **login-shell**
   check: under `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`, `bash -lc 'ao spawn …'`
   and `bash -lc 'git branch -m …'` / `git checkout …` return **93**, while
   `bash -lc 'git status'` / read-only return **0**; with the surface unset, both
   are transparent.

### B. Secondary — restore-branch sanitization (defense-in-depth)

Even with A active, a **legacy** corrupted record (branch already drifted to a
worker branch) would still detonate on the next restore. Extend
`orchestrator-worktree-preflight.ps1` to detect and repair it:

5. **Detect + repair, fail-closed.** Resolve the **actually configured**
   orchestrator session id (daemon-independent — `sessionPrefix` →
   `<prefix>-orchestrator`, not a hard-coded example; the current preflight misses
   `opk-orchestrator` because it looks for `op-orchestrator`). When the
   orchestrator record's `branch` is outside the `orchestrator/*` namespace (or
   empty), repair it to the canonical `orchestrator/<sessionId>` that AO's own
   `spawnOrchestrator` computes. Validate the file's identity (session id,
   project, record type) **before every terminal decision** (repair, healthy,
   refusal); never classify a stale/mismatched record `healthy`.
6. **Safe mutation.** Repair only when the AO daemon is **not alive for this
   project** (fail-closed liveness gate, bound to project/session identity).
   Field-minimal, atomic (parse-validate → same-dir temp → atomic rename,
   preserving mode/ownership and every other field). Preserve a full byte-for-byte
   backup **out-of-repo** and audit **every** terminal outcome (incl. refusals)
   via a stable machine-readable reason-code contract. If the canonical branch is
   attached to a different worktree → report non-repairable, don't rewrite.

### C. Tests, docs, decision log

7. **Regression tests (hermetic).** Layer-A: login-shell deny/allow + loop-safety
   + non-surface transparency. Layer-B: id-resolution (incl. non-default prefix),
   cross-namespace repair, identity-mismatch refusal, daemon-alive refusal, atomic
   field-minimal write, absent-record no-op. All run under an isolated temp AO
   home; a guard ensures tests never touch the real `~/.agent-orchestrator`.
8. **Docs.** `docs/orchestrator-recovery-runbook.md` + `docs/migration_notes.md`:
   why the PATH prepend dies in a login shell, the install step, the
   provably-active login-shell check, and the legacy-record repair path — distinct
   from #91/#318/#324.
9. **Upstream escalation note.** Durable cures belong upstream too: AO should honor
   `agentConfig.env` for this runtime (so the boundary env reaches the turn without
   a shim), and orchestrator **restore should re-derive `orchestrator/<sessionId>`**
   rather than trusting the mutable persisted `branch`. Pack guards are mitigation.
10. **Decision log** — `docs/issues_drafts/00-architecture-decisions.md`: #324 was
    inert because the boundary bound to `PATH`, which the login shell rebuilds;
    the durable lever is an env-gated guard at the bare-resolution layer. (Issue #3
    live sync per the standing publish convention, not a code-gate.)

## Files in scope

- `scripts/` — installer for the surface-gated `~/.local/bin` ao/git guards
  (+ guard content), loop-safety wiring; extension of
  `orchestrator-worktree-preflight.ps1` (id resolution + record-branch repair).
- `tests/` + fixtures — layer-A and layer-B coverage.
- `docs/orchestrator-recovery-runbook.md`, `docs/migration_notes.md`.
- `docs/issues_drafts/00-architecture-decisions.md` (decision-log update in this PR).
- `docs/issues_drafts/107-orchestrator-restore-branch-sanitization.md` — this spec.

## Files out of scope

- `vendor/**`, `packages/core/**`, AO core (`agentConfig.env` handling +
  restore re-derive are upstream escalation only — item 9).
- Direct edits to `~/.local/bin/**` in the PR (outside the repo; the operator runs
  the installer — but the installer and a verification of its effect are in scope).
- Live `agent-orchestrator.yaml`; AO YAML schema changes.

## Denylist

```denylist
vendor/**
packages/core/**
```

```allowed-roots
scripts/**
docs/**
tests/**
```

## Acceptance criteria

- [ ] Under `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`, a **login-shell**
      (`bash -lc`) bare `ao spawn`, `git branch -m`, and `git checkout <branch>`
      return **93**; bare `git status` / `ao` read-only return **0** — even with
      pack `scripts/` absent from `PATH` (profile-rebuilt).
- [ ] With the surface unset, the installed `ao`/`git` guards are **transparent**
      (forward to real `ao` / `/usr/bin/git`); a fixture proves no behavior change.
- [ ] No recursion: an allowed read-only command under surface completes (no
      infinite loop); real-binary resolution uses absolute paths;
      `.ao/autonomous-real-binaries.json` `ao` is the real binary, and the git
      guard passes through on `AO_AUTONOMOUS_GIT_INTERNAL_EXEC=1`.
- [ ] A pack installer (in `scripts/`, wired into the runtime setup/runbook)
      idempotently installs/supersedes the guards; the documented operator step is
      "run the installer", and a verification confirms the login-shell deny holds
      afterward.
- [ ] Preflight resolves the **real** orchestrator session id (incl. non-default
      prefix; no false "clean") and repairs a cross-namespace `branch` to canonical
      `orchestrator/<sessionId>`, fail-closed on daemon-alive / identity-mismatch /
      attached-elsewhere, with atomic field-minimal write + out-of-repo full backup
      + audit of every terminal outcome.
- [ ] Hermetic tests cover layer-A (login-shell deny/allow, loop-safety,
      transparency) and layer-B (repair matrix), under an isolated temp AO home
      with a guard against touching the real `~/.agent-orchestrator`.
- [ ] Runbook + migration notes document the login-shell PATH-rebuild cause, the
      install step, the provably-active check, and the legacy-record repair.
- [ ] Upstream escalation note records the `agentConfig.env` + restore-re-derive
      cures as AO-core-owned.
- [ ] `docs/issues_drafts/00-architecture-decisions.md` records the inert-boundary
      class and the env-gated-guard lever.

## Upgrade-safety check

- No edits under `vendor/**` or `packages/core/**`; no AO YAML schema change.
- Installed guards are transparent off-surface, so non-orchestrator `ao`/`git`
  usage is unaffected; idempotent install; backups out-of-repo, no secrets
  committed.
- Loop-safety proven by fixture before the guards can ship.

## Verification

- `bash -lc` under surface=1 (scripts/ NOT on PATH): `ao spawn` / `git branch -m`
  / `git checkout` → rc 93; `git status` → rc 0. Surface unset → transparent.
- After `ao session kill opk-orchestrator` + record delete + `ao start`, a real
  orchestrator turn that attempts `ao spawn --claim-pr <PR>` is **denied** (no new
  worker, no `feat/*` stamped onto the orchestrator card).
- Legacy: seed a record with `branch` = a worker branch held by a sibling worktree
  → run the daemon-stopped repair → `ao stop`→`ao start` launches cleanly on
  `orchestrator/<sessionId>`.
- Pack verify path passes including the new hermetic fixtures.
