# Orchestrator session launch death + branch_collision respawn loop on Windows

GitHub Issue: #91

## Prerequisite

- `docs/issues_drafts/25-worker-spawn-launch-safety.md` (GitHub #63) — **closed**; documents worker prompt-delivery launch failure (Signatures A/B) and recovery-runbook routing for **workers**. This issue adds the **orchestrator** surface and worktree preflight; it does not reopen #63.
- `docs/issues_drafts/15-orchestrator-recovery-runbook.md` (GitHub #40) — **closed**; shipped runbook at `docs/orchestrator-recovery-runbook.md`. This issue **amends** that runbook so orchestrator launch death and worktree hygiene are first-class, not mis-routed through the worker-only pointer in §27–33.
- `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md` (GitHub #28) — orchestrator role unchanged; only operator triage and pre-spawn hygiene.

## Goal

On Windows, the orchestrator session (`op-orchestrator` or config equivalent) must not enter a **branch_collision → kill → respawn → collision** loop or present as orchestrator `stuck` / `probe_failure` when the real failure is **launch death** (vendor prompt-delivery) or a **stale `orchestrator/*` worktree/branch** left from a prior recovery. The pack must make both failure classes **legible** (named signatures, PTY inspection, preflight cleanup before spawn) and document the correct operator path — distinct from worker-only Issue #63 and distinct from benign idle orchestrator.

Observed gap (2026-05-30): recovery runbook §27–33 tells operators to treat Signature A/B as **worker-only** and explicitly **not** to inspect the orchestrator PTY for launch failure. In practice the orchestrator can show the same vendor signatures (upstream [agent-orchestrator#2072](https://github.com/ComposioHQ/agent-orchestrator/issues/2072)) or die on a **dirty** `orchestrator/op-orchestrator` worktree after `ao session kill` + respawn. Operators lack a pack-side preflight to remove stale orchestrator worktrees/branches before `ao start`.

**Observed timeline (2026-05-30, post worktree cleanup + `ao stop`/`ao start`):** `op-orchestrator` respawned a fresh worktree (no `branch_collision` in events). Within ~60s: `session.spawned` → `working → detecting`, `agent_process_exited`, `ui.terminal_pty_lost`. Live `orchestrator-prompt-op-orchestrator.md` was **~20.5 KB** at first measurement. Stale-worktree hygiene is **ruled out** for that run; launch-death class **not confirmed** (see below).

**Leading hypothesis — prompt argv / Signature B (not yet confirmed):** After worktree cleanup, live `orchestrator-prompt-op-orchestrator.md` was **~20.5 KB** (above worker #63 empirical ~8 KB warning — **orchestrator-specific threshold not bisected**). `.workspace-trusted` present for `worktrees/op-orchestrator` — **trust rejected as sole cause**. Slim `orchestratorRules` still produced **~13.5 KB** file → session still reached `detecting` / `agent_process_exited`. A **~528 B** boot stub (repo-doc pointers) plus `ao session kill` + `restore` once yielded a **transient** `working` + `runtime=alive` on a single poll; **not durable**: same host later `session.json` shows `state=stuck`, `reason=probe_failure`, `runtime=exited` / `process_missing`, `lastTransitionAt` ~03:01Z with stub still in place (~18 min after stub write). **PTY/mux capture during restore** showed only bare `pwsh` title — **no captured line** `command line is too long` / Signature A text; **argv at CreateProcess not logged**. Mechanism `$(cat <orchestrator-prompt>)` → inflated child argv is **plausible by analogy to worker #63**, not observed on this run.

**Restore metadata — not a separate failure class (2026-05-30):** `restoreFallbackReason: "cursor.getRestoreCommand returned null"` is **expected** for Cursor (plugin always returns `null`; AO falls through to `getLaunchCommand` per `session-manager` restore path and emits `session.restore_fallback` warn). Do **not** treat this string alone as root cause. `detectingAttempts` climbing after restore still needs PTY/argv evidence (launch death vs post-boot exit vs probe false positive).

**Architect note:** Prototype operator scripts were **not** kept in `scripts/**` — that deliverable belongs in the worker PR for this issue (`planner's choice` in binding surface below). Any recovery helper must **not** exit success on a single `working && alive` poll; require sustained liveness (e.g. **≥3 consecutive 20s polls** over **≥60s** with no transition to `detecting`/`stuck`).

**Investigation log (2026-05-30, post draft/issue sync):**

| Step | Result |
|------|--------|
| GitHub #91 body | Re-synced from this draft; removed confident «Discriminator» wording |
| `ao start` after worktree cleanup | `orchestrator-prompt-op-orchestrator.md` **13 502 B**; within 20s → `detecting` / `runtime=exited` |
| `ptyHostGetOutput` / pipe poll (8×2s) | Pipe not connectable (`alive=false`, 0 bytes) — agent/PTY window missed or host gone |
| Sustained poll (5×20s) | **0** consecutive `working`+`alive` |
| Isolated `pwsh -Command` + `$(cat <13k file>)` | No stderr captured in 6s window (empty log) — **not** Signature B text observed |
| AO worker | `ao spawn 91` → session **op-57** (implementation deliverable) |

**Still required before claiming Signature B on orchestrator:** live `ao session attach op-orchestrator` during first spawn window **or** logged expanded argv / PTY line `command line is too long`; add orchestrator fixture to `tests/fixtures/` from that capture.

## Binding surface

1. **Named orchestrator launch-failure condition** — same Signature A (`printf` / `unknown option '-ne'`) and Signature B (`command line is too long`) as documented for workers in `docs/migration_notes.md` (Issue #63), but scoped to the **orchestrator** session PTY and lifecycle (`spawning → working → detecting → stuck` / `agent_process_exited` on the orchestrator id). Upstream durable fix remains vendor (`@aoagents/ao-plugin-agent-cursor` / AO core); pack adds detection surface and escalation pointer including orchestrator in the #2072 narrative.
2. **Named worktree-hygiene condition** — repeated `workspace.branch_collision` on orchestrator respawn, spawn failing because `orchestrator/<session-id>` branch or `.agent-orchestrator/.../worktrees/<session-id>` already exists from a prior kill without cleanup. Pack documents operator cleanup (worktree remove + branch delete) as **session-scoped** blast radius before `ao start`.
3. **Orchestrator preflight** — a pack script or extension of an existing diagnostic that, before orchestrator spawn (or as part of `scripts/orchestrator-diagnose.ps1` / verify), detects stale `orchestrator/*` branches and matching AO worktrees for the configured orchestrator session id and prints **actionable** remove commands (does not auto-delete without operator intent unless explicitly run with a documented `-Apply` flag — planner's choice).
4. **Launch-failure detection in verify** — extend the Issue #63 fixture pattern (`scripts/check-worker-launch-failure.ps1`) or add a sibling check so orchestrator PTY log fixtures with Signature A/B are regression-tested; wire into `scripts/verify.ps1`.
5. **Recovery runbook amendment** — `docs/orchestrator-recovery-runbook.md` (and draft `15-orchestrator-recovery-runbook.md` if kept in sync): replace the worker-only exclusion in the launch-failure pointer with a **decision table**: inspect **worker** PTY first when worker exits at spawn with no PR; inspect **orchestrator** PTY when orchestrator is `stuck`/`probe_failure` shortly after `ao start` or `ao session kill` + respawn, or when logs show `branch_collision` on `orchestrator/*`. Include ordered **worktree hygiene** step before step 3 kill/restart when stale `orchestrator/op-orchestrator` (or configured id) worktree exists.
6. **Migration notes** — subsection cross-link: orchestrator vs worker routing for Signatures A/B; worktree hygiene vs vendor #2072; pointer to preflight script.
7. **Decision log** — `docs/issues_drafts/00-architecture-decisions.md` new subsection: orchestrator launch death is not covered by worker-only #63 runbook routing; stale orchestrator worktree is pack-side hygiene, not vendor launch template.

## Files in scope

- `scripts/` — orchestrator launch-failure detection and/or worktree preflight (new or extension of `orchestrator-diagnose.ps1`, `check-worker-launch-failure.ps1`; planner's choice); `scripts/verify.ps1` wiring if verifiable.
- `tests/fixtures/` — PTY or log fixtures for orchestrator Signature A/B (may share pattern with worker launch fixtures).
- `docs/migration_notes.md` — orchestrator + hygiene subsection.
- `docs/orchestrator-recovery-runbook.md` — amend § launch-failure pointer and add worktree-hygiene step.
- `docs/issues_drafts/15-orchestrator-recovery-runbook.md` — keep in sync if still maintained.
- `docs/issues_drafts/00-architecture-decisions.md` + Issue #3 re-sync.
- `docs/issues_drafts/33-orchestrator-session-launch-death-and-worktree-hygiene.md` — this spec.

## Files out of scope

- `vendor/**`, `packages/core/**`, AO core spawn implementation (upstream #2072).
- Changing `orchestratorRules` quote safety (Issue #55) or worker `ao acknowledge` contract (draft `32`, #88).
- Automatic AO daemon recovery, schedulers, or modifying live `agent-orchestrator.yaml`.
- Removing **worker** worktrees (`op-*` on `feat/*`) — preflight targets **orchestrator** namespace only unless operator passes explicit worker id (document in runbook only).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
tests/**
prompts/**
```

## Acceptance criteria

- [ ] `docs/migration_notes.md` documents orchestrator launch death (Signatures A/B) and stale `orchestrator/*` worktree hygiene with distinct operator paths from worker #63.
- [ ] `docs/orchestrator-recovery-runbook.md` no longer states that Signature A/B on the orchestrator PTY is out of scope; includes a worktree-hygiene step before kill/restart when a stale orchestrator worktree/branch exists.
- [ ] Pack provides a documented preflight (script or diagnose subcommand) that lists stale orchestrator worktrees/branches and suggested cleanup commands for the session id from `ao status`.
- [ ] `scripts/verify.ps1` runs an automated check using fixtures for orchestrator Signature A/B (or shared fixtures with session-role label).
- [ ] `docs/issues_drafts/00-architecture-decisions.md` records the orchestrator vs worker triage split; Issue #3 body re-synced in the same PR.
- [ ] Upstream escalation note mentions orchestrator surface on ComposioHQ/agent-orchestrator#2072 (or successor issue) without claiming pack fixes vendor launch.
- [ ] Recovery/preflight helper (if shipped) exits **non-zero** unless orchestrator stays `working` with `runtime=alive` for **≥3 consecutive checks** spaced **≥20s** over **≥60s** (no single-poll false success).
- [ ] Runbook or migration notes state that **`restoreFallbackReason: cursor.getRestoreCommand returned null` is normal** for Cursor restore (fresh `getLaunchCommand` launch), not a standalone defect.
- [ ] At least one **orchestrator** PTY fixture or captured log line documents Signature A or B before the spec claims launch death vs idle/stuck for that class (correlation with prompt byte count alone is insufficient).

## Upgrade-safety check

- No edits under `vendor/**` or `packages/core/**`.
- No new secrets; preflight is read-only unless operator opts into destructive flags.
- No AO YAML schema changes.

## Verification

- `.\scripts\verify.ps1` passes including new launch/hygiene checks.
- Manual: with a fixture or captured orchestrator PTY log containing Signature A or B, preflight/diagnose output names **orchestrator launch death** and points to migration notes / #2072 — not orchestrator-stuck ping.
- Manual: with a stale `orchestrator/op-orchestrator` worktree present, preflight prints remove/branch-delete guidance; after operator cleanup, `ao start` + `ao status` shows a healthy orchestrator session without repeated `branch_collision` in spawn logs.
