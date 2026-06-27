# Autonomous bash-env interposer: eval-hidden and PATH-override defense-in-depth

GitHub Issue: #406

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub **#324**,
  shipped) — process-boundary deny for `ao spawn`, tree-mutating `git`, and raw worker
  `ao send` via `scripts/ao` / `scripts/git` shims + `autonomous-bash-env.sh` interposer.
- `docs/issues_drafts/121-llm-turn-worker-nudge-per-cycle-gate.md` (GitHub **#384**, shipped) —
  incident class: orchestrator composed bare `ao send` ungated; gated path is
  `invoke-gated-worker-nudge` → `journaled-worker-send` with claim token.
- **Operator adoption (2026-06-22):** `~/.config/deepseek/coworker.env` arms orchestrator
  via `AO_TMUX_NAME` (Cursor shell children omit `AO_SESSION_ID`), PATH prepend of
  `scripts/`, DEBUG trap to re-prepend after Cursor `/tmp/WRAPDIR` PATH reset, and
  interposer source.
- **Channel constraint (empirical #107):** AO 0.9.x does **not** propagate orchestrator
  `agentConfig.env` into the live tmux session — a marker placed there never reaches the
  Cursor shell (proven this incident). The only env channel that reaches the orchestrator
  command shells is **`BASH_ENV`** (machine `~/.bashrc` → `coworker.env`), and the only
  session discriminator that reaches them is **`AO_TMUX_NAME`**. So the durable wiring
  cannot live in `agentConfig.env`; full `agentConfig`-native arming is **parked on a
  #107 fix** (AO-core, out of scope here).

## Problem (empirically confirmed)

Cursor orchestrator Shell-tool commands run as:

```
/bin/bash -O extglob -c '<wrapper … builtin eval "$1" …>' -- <real command>
```

`BASH_EXECUTION_STRING` is the **wrapper**, not the real command. When the interposer
decides the wrapper needs no binary rewrite, it can return early **without** arming
per-command interception — so eval-hidden commands with **absolute** `/usr/bin/git` etc.
bypass the guard.

Bare `ao`/`git` are caught only when `scripts/` is first in PATH (PATH leg).
Explicit `env PATH=/usr/local/bin:/usr/bin:/bin …` removes the leg and bypasses
guard (empirical P5b: spawn succeeded).

PATH prepend alone is **necessary and sufficient for typical turns** but **fragile**
to env-override.

**Second confirmed bug (2026-06-22 live — functional, broke the protected path):**
the interposer's script rewrite/reexec path treats guard forwarder shims
(`scripts/ao` → `~/.local/bin/ao`) like ordinary scripts. The mangled temp script
(`unexpected EOF`) made `ao review list` return **exit 2 with empty 0-byte JSON** —
the orchestrator's review-coordination read silently broke (the guard damaged the very
review loop it protects). Operator band-aid in `coworker.env`: source the interposer /
arm its DEBUG trap only when `BASH_EXECUTION_STRING` is set or `$0 == bash`, never when
`$0` is a forwarder script. The durable fix belongs in the tracked interposer, not the
dotfile.

**Durability risk (why this is no longer optional):** the *working* enforcement
(PATH-prepend DEBUG trap, interposer gating, `AO_TMUX_NAME` arm) currently lives only
in the gitignored `~/.config/deepseek/coworker.env`, which **reverts on coworker
upgrade/regeneration** → the guard would silently die and regress to the inert
`#384`/`#373` state with no signal. Moving the wiring into tracked, CI-tested code is
the durability fix, not just defense-in-depth.

## Goal

Move the working enforcement into the **tracked** interposer (CI-tested) and close the
two confirmed bypasses — so the guard does not depend on dotfile integrity and does not
damage legit read-verbs:

1. **Forwarder-shim reexec bug (primary, durability):** executing a guard forwarder shim
   (`scripts/ao`, `scripts/git`, `~/.local/bin/ao`, or any shim resolving to a guard) as
   `$0` must not be rewritten/reexec'd/mangled; legit `ao`/`git` read-verbs run clean.
   Fold the dotfile's `$0 == bash` / `BASH_EXECUTION_STRING` gating into the tracked
   interposer.
2. **Eval-hidden absolute paths:** when the wrapper `BASH_EXECUTION_STRING` is unchanged by
   binary rewrite, interception must still be armed **before** the hidden command runs so
   `eval "$1"` / dynamic commands with absolute `/usr/bin/git` or `/…/ao` are rewritten
   or denied — not skipped by early return alone.
3. **Durable wiring: heavy logic tracked, thin bootstrap operator-side.** Two layers, because
   neither `agentConfig` (#107) nor tracked code (provenance) can set the marker from the live
   session:
   - **Tracked interposer** (e.g. under `scripts/`): the heavy logic — PATH re-prepend,
     forwarder-shim skip, eval-hidden arming. It reads **only** `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`
     (never `AO_TMUX_NAME` — preserves the #324 provenance contract). This is the durability win:
     the logic no longer lives in / reverts with `coworker.env`.
   - **Thin bootstrap** (the small operator/launch glue that survives in `coworker.env`, loaded
     via `BASH_ENV` **independently of** and **before** the tracked interposer): maps the live
     `AO_TMUX_NAME` orchestrator session → `SURFACE=1`, prepends pack `scripts/`, sources the
     tracked interposer, **and owns fail-closed** — if the tracked interposer is missing/unloadable
     it must leave protected ops denied (keep the `scripts/` deny-shims resolvable / not expose the
     real `ao`/`git`), since a missing interposer cannot deny itself. The bootstrap is the only
     operator-side glue (a few lines, the part that maps env→marker); the upgrade-revert exposure
     shrinks from "all logic" to "this small hook."
4. **PATH-override class:** **parked for a follow-up** (confirmed bypass via
   `env PATH=/usr/local/bin:/usr/bin:/bin ao spawn` — empirical P5b). This issue closes
   forwarder-shim reexec + eval-hidden absolutes + tracked durability; PATH-override deny
   is out of scope here to avoid an open-ended optional AC.

## Non-goals

- Replacing the operator `coworker.env` hook outright before the tracked file is adopted
  (transition keeps both; `coworker.env` collapses to a one-line `. <tracked-file>` after).
- Fixing AO-core `agentConfig.env` non-propagation (#107) so `agentConfig` could arm the
  guard natively — that is the parked upstream path; this slice uses the live `BASH_ENV` +
  `AO_TMUX_NAME` hook instead. Operator adoption (the hook + one-line source) is documented
  in `docs/migration_notes.md` per the #101 `.example` ↔ migration-notes contract.
- Blocking PowerShell / direct `node ao` paths (separate surfaces).

## Provenance / arming matrix (must hold)

Tracked guard logic arms **only** when `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1` — **not** from
`AO_TMUX_NAME`, session name, or other incidental env inside tracked code (same provenance
contract as #324). The marker itself is set **outside** tracked code by the thin bootstrap hook
(operator glue in `coworker.env`, loaded via `BASH_ENV` before the interposer) that maps the live
`AO_TMUX_NAME` orchestrator session → `SURFACE=1` (because neither `agentConfig` — #107 — nor the
provenance-bound tracked code may). **Fail-closed is the bootstrap's job, not the interposer's:**
if the tracked interposer is missing/unloadable the bootstrap (independently loaded) must leave
protected operations denied (deny-shims resolvable / real `ao`/`git` not exposed), not fail-open
(#117 / #318 line) — a missing interposer cannot deny itself.

| Surface | `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE` | `ao spawn` (deny probe) | raw `ao send` (deny) | gated `ao send` (allow) | read `ao review list --json` |
|---------|--------------------------------------|-------------------------|----------------------|-------------------------|--------------------------------|
| Orchestrator (`SURFACE=1` set by launch hook) | `1` | deny **93** (`autonomous_spawn_denied`) | deny **93** (`autonomous_raw_worker_send_denied`) | allow (not **93**; reaches journaled transport) | exit **0**, valid JSON |
| Worker session (no surface marker) | unset / `0` | allow **0** | allow (not raw-deny path) | n/a on worker surface | exit **0** |
| Operator shell (no surface marker) | unset | allow (not this issue's deny path) | allow | allow | allow |

## Contract evidence

All bindings are **repo-owned guard/interposer behavior** (the deny contract, forwarder-shim
read-verb cleanliness, and the `AO_TMUX_NAME`→`SURFACE` arming hook) — not a predicate parsing
an external producer wire-field. Each is grounded by this issue's own acceptance fixtures
(deny matrix, read-verbs-clean, live-arming) and the empirical runs in **Evidence** below, so
no external capture binding applies (same shape as #122 / #124).

```contract-evidence
none
```

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `128-autonomous-bash-env-interposer-eval-hidden-defense`.

```allowed-roots
scripts/**
docs/**
tests/**
agent-orchestrator.yaml.example
docs/migration_notes.md
```

## Acceptance criteria

Orchestrator fixtures arm by **actually loading the tracked wiring** through `BASH_ENV`
(the tracked interposer file) with `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1` set the way the
launch hook would set it from `AO_TMUX_NAME` — **not** by hand-building a parallel env, and
**without** sourcing the gitignored `coworker.env` block. A test must exercise the **live
arming path** (hook maps the orchestrator session marker → `SURFACE=1`; tracked file sourced
via `BASH_ENV`), so that regressing the tracked file, its `BASH_ENV` sourcing, or the hook
fails CI even when the interposer logic in isolation still passes.

**Eval-hidden shape (requirement, not a per-AC mandate):** protected deny/allow cases
include at least one fixture where the real command is behind `eval` (command hidden from
the outer `bash -c` literal), not only flat `bash -c '<literal>'`. Example shape observed
in live Cursor turns: `bash -O extglob -c 'builtin eval "$1"' x '<command>'`.

Deny cases use observable stub forwarders (record argv; must **not** be invoked on deny).
Illustrative argv: spawn probe session id, a temp-repo `README.md` for mutating git, raw
send target session + message body.

- [ ] **Tracked durability (live arming, not `agentConfig`):** the heavy logic lives in a
  **tracked** file; the thin bootstrap (operator glue, loaded via `BASH_ENV`) maps `AO_TMUX_NAME`
  → `SURFACE=1`, prepends `scripts/`, and sources the tracked file. A test exercises this
  **live arming path end-to-end** via the bootstrap + tracked file (marker set as the bootstrap
  would, not a hand-built parallel env): a protected deny smoke (`ao spawn` → **93**) and a read
  smoke (`ao review list --json` → **0**) both hold. Removing/regressing the tracked file, its
  `BASH_ENV` sourcing, or the bootstrap mapping must fail CI (wired into `verify.ps1`).
- [ ] **Fail-closed when interposer absent (bootstrap-owned):** with the bootstrap armed but the
  **tracked interposer file removed/unloadable**, protected ops still deny (`ao spawn`/raw `ao send`
  → **93** via the bootstrap-kept deny-shims; real `ao`/`git` not exposed) — **fail-closed**, not
  pass-through. The check targets the bootstrap (independently loaded), since a missing interposer
  cannot deny itself. (Full `agentConfig`-native injection is parked on a #107 AO-core fix — see
  Prerequisite.)
- [ ] **Read-verbs clean:** on orchestrator surface, `ao review list --json`, `ao status
  --json`, and `ao events list --json` each exit **0** with parseable JSON stdout; stderr
  must not show interposer script mangling (e.g. broken `/tmp/ao-autonomous-script.*`
  rewrite). Rationale: guard forwarder shims (`scripts/ao`, `scripts/git`, installed
  `~/.local/bin/ao`, and shims resolving to a guard) executed as `$0` must forward without
  rewrite/reexec collateral — the live failure mode that broke review coordination.
- [ ] **PATH re-prepend after runtime reset:** tracked-armed orchestrator env starts with
  pack `scripts/` first, then simulates Cursor's post-`BASH_ENV` PATH prepend (e.g. synthetic
  `/tmp/WRAPDIR` before system dirs) without `coworker.env`. After reset, eval-hidden deny
  (`ao spawn` → **93**) and eval-hidden read (`git status` through shims) still behave —
  proving the tracked re-prepend arms. Distinct from parked `env PATH=…` override
  (P5b bypass).
- [ ] **Orchestrator deny matrix:** on orchestrator surface, each cell exits **93** with
  matching deny reason; stub argv file unchanged:

  | invocation shape | absolute / mutating git | bare `ao spawn` | raw `ao send` |
  |------------------|-------------------------|-----------------|---------------|
  | flat (`bash -c` literal) | e.g. `/usr/bin/git checkout -- <file>` | e.g. `ao spawn <probe-sid>` | e.g. `ao send <sid> <msg>` |
  | eval-hidden | same git argv behind `eval` | same spawn behind `eval` | same raw send behind `eval` |

- [ ] **Allow matrix (worker + gated send):** (a) worker surface (no surface marker),
  eval-hidden `ao spawn <probe-sid>` → **0**; stub records spawn + probe sid; stderr lacks
  spawn deny. (b) orchestrator surface, **sanctioned** gated worker send
  (`invoke-gated-worker-nudge` → `journaled-worker-send` with valid claim token) → not **93**;
  must not be classified as `autonomous_raw_worker_send_denied`.
- [ ] **Transition double-arm idempotent:** when both the operator `coworker.env` block and the
  adopted tracked file + hook are active at once, arming is idempotent — no duplicate `scripts/`
  segments in effective PATH, no conflicting DEBUG-trap chains, protected deny/read behavior
  unchanged from single-arm baseline.
- [ ] `pwsh -NoProfile -File ./scripts/verify.ps1` green.

## Evidence / references

- Empirical scratch runs 2026-06-22 (PATH leg P1–P4 = 93; P5b bypass with env PATH override).
- Empirical raw `ao send` deny (2026-06-22): `env BASH_ENV="$HOME/.config/deepseek/coworker.env"
  AO_TMUX_NAME=opk-orchestrator /bin/bash -O extglob -c 'builtin eval "$1"' x 'ao send opk-x hi'`
  → exit **93**, stderr `autonomous_raw_worker_send_denied`.
- Prior diagnosis: orchestrator uses `bash -c` + eval wrapper; `BASH_ENV` in cursor-agent env.
- Interposer implementation anchors: `scripts/autonomous-bash-env.sh` —
  `__ao_autonomous_interpose_execution_string` early return (~lines 292–293) without DEBUG
  trap; `__ao_autonomous_maybe_reexec_preprocessed_script` mangling forwarder shims.
- Raw send deny contract: `Test-AutonomousRawWorkerSendDenied` / `scripts/ao-autonomous-guard.ps1`.
- Gated send allow path: `scripts/invoke-gated-worker-nudge.ps1` →
  `scripts/journaled-worker-send.ps1` (#384).

## Framework triggers

- **Recurrence class:** non-representative test fixture (flat `-c`) masked eval-hidden gap.
- **Defense-in-depth:** operator PATH leg + tracked interposer fix.

## Parked

- **PATH-override deny** (`env PATH=…` stripping `scripts/` — empirical P5b bypass): follow-up
  issue after this slice lands; residual risk documented in Evidence.
- **`agentConfig`-native arming** (AO-core #107 fix so `agentConfig.env` reaches the session):
  upstream follow-up; until then the live `BASH_ENV` + `AO_TMUX_NAME`-hook path is the channel.
- Bare-name rewrite without PATH leg (heavier; PATH leg covers typical Cursor turns).
- pwsh / node direct exec surfaces.
