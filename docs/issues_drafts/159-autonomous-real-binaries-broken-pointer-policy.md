# Autonomous boot config: policy when explicit `ao` pointer is broken

GitHub Issue: [#495](https://github.com/chetwerikoff/orchestrator-pack/issues/495)

## Prerequisite

- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub #318, closed) /
  `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub #324, closed) —
  `.ao/autonomous-real-binaries.json` as non-turn-visible real-binary indirection.
- **`docs/issues_drafts/158-test-fixture-autonomous-real-binaries-live-leak.md` (GitHub [#494](https://github.com/chetwerikoff/orchestrator-pack/issues/494), open)** — isolates
  test fixtures so they cannot poison live config. **Recommended ship order:** #158 first; this issue
  is optional hardening, not required to close the fixture-leak incident.
- Queue check on 2026-06-28: no open draft on this axis. **Re-verify at GitHub sync.**

Prior-art recon verdict: **amend pack resolver policy** on the autonomous surface. Separate from
#158 (test hygiene) and #157 (spawn grant refs).

## Goal

When gitignored `.ao/autonomous-real-binaries.json` **exists** and names an explicit `ao` path that
is missing or non-executable, the pack must stop **silently masking** misconfiguration on the
autonomous orchestrator surface. Choose and implement a policy that balances detectability vs boot
continuity — without breaking normal dev invocation of the pack `scripts/ao` shim.

```behavior-kind
action-producing
```

## Binding surface

**Incident context (2026-06-28, from #158).** Leaked test stub left config pointing at deleted
`/tmp/autonomous-ao-stub-*`. Operator labeled outcome `STUB_MISSING` — **not** a pack error string.
With typical `~/.local/bin/ao` present, autonomous boot likely **continued via fallback** while the
dead explicit pointer remained — defect class is **silent masking**, not proven hard boot failure.

**Facts from code (2026-06-28):**

1. **Bash selector — Fact.** `scripts/ao` `resolve_real_ao()`: configured `ao` missing or
   non-executable (`-x` check) → falls through to PATH / home fallbacks (lines 41–60).
2. **PS selector — Fact.** `Resolve-AutonomousRealBinaryPath` / `Resolve-RealAoExecutable` in
   `Orchestrator-AutonomousBoundary.ps1`; `ao-autonomous-guard.ps1` execs via
   `$realAo = Resolve-RealAoExecutable`. Configured path missing (`Test-Path` fails) → same PATH /
   home fallback pattern.
3. **Two autonomous exec paths — Fact.** Under surface active (see #4):
   - **Fast path:** `scripts/ao` → `exec "$(resolve_real_ao)"` for read-only argv.
   - **Guard path:** `scripts/ao` → copied/guard `ao-autonomous-guard.ps1` → `Resolve-RealAoExecutable`
     → exec.
   Policy must be **consistent across both paths**.
4. **Surface detection — Fact.** Bash: `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`. PS:
   `Test-OrchestratorAutonomousSurfaceActiveForBoundary` (same env var). Policy applies when this is
   active.
5. **`AO_REAL_BINARY` — Fact.** Bash skips it when surface=1 (lines 28–39). PS skips it when surface
   active (`Resolve-RealAoExecutable` branches). Masking channels under surface: PATH + home
   fallbacks, not `AO_REAL_BINARY`.
6. **Non-surface dev shim — Fact.** Surface unset → bash/PS retain `AO_REAL_BINARY` + PATH fallbacks;
   unconditional hard-fail on broken config would regress normal `repoRoot/scripts/ao` dev use.
7. **Empty/missing `ao` key — Fact.** Empty or absent `ao` in parsed config behaves like no usable
   explicit pointer (falls through today). This issue targets **explicit non-empty pointer that is
   broken**; empty-key equivalence is planner discretion but must not widen silent masking for
   non-empty broken paths.

**Scope boundary:**

- Policy when surface active (#4) and config file **exists** with broken **non-empty** explicit `ao`.
- Non-surface invocations unchanged.
- **`git` / `gitSystemBinary` fields:** out of scope (ao axis only); #318 inventory already validates
  `git` wrapper shape when config exists.

**Contract (planner picks A or C — B rejected):**

| Option | Behavior | Status |
|--------|----------|--------|
| **A. Hard-fail (surface only)** | Broken explicit `ao` → exit non-zero + message (config path + `docs/autonomous-real-binaries.example.json`) | Allowed |
| **B. Silent fallback** | Status quo | **Rejected** |
| **C. Loud fallback (surface only)** | Keep fallback **and** emit operator-visible signal from the **resolver/exec path at boot time** (stderr or audit line); inventory violation is supplementary, not sufficient alone | Allowed; **default recommendation** |

**Additional rules (A or C):**

- Config exists but JSON unparseable → misconfiguration on surface (not absent-config equivalence).
- Inventory reports broken explicit `ao` when config exists — **in addition to** resolver-path signal
  under Option C (inventory alone must not satisfy AC#6).

```contract-evidence
none
```

## Files in scope

- `scripts/ao`
- `scripts/lib/Orchestrator-AutonomousBoundary.ps1`
- `scripts/lib/Test-AutonomousCapabilityInventory.ps1` (if inventory rule extended)
- `docs/migration_notes.md` (if operator-visible behavior changes)

## Files out of scope

- Test fixture isolation (#158), `.ao/**` committed state, vendor/core, #157, `git` selector policy

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
```

Scope note: vitest regressions for this issue live under `scripts/**` (same tree as in-scope
resolver changes) — no separate `tests/**` root required.

## Acceptance criteria

1. **Surface-scoped policy.** Applies only when surface active (#4) and config exists with broken
   non-empty explicit `ao`. Non-surface unchanged.
2. **Dual-path parity.** Chosen policy (A or C) in bash `resolve_real_ao()` fast path **and** PS
   `Resolve-AutonomousRealBinaryPath` / guard exec path.
3. **Regression: broken pointer on surface.** Isolated-pack fixture; valid `~/.local/bin/ao` (or PATH
   `ao`) available — assert A (hard-fail) or C (fallback + visible signal); not silent-only.
4. **Regression: parse error.** Invalid JSON + file exists → misconfiguration on surface.
5. **Regression: non-surface unchanged.** Broken config, surface unset — `AO_REAL_BINARY` / PATH
   fallback still works.
6. **Option C observability (if C chosen).** Resolver/exec path emits the defined operator-visible
   signal when falling back (bash fast path **and** PS guard path). Inventory-only reporting does
   **not** satisfy this AC.

```positive-outcome
asserts: autonomous-surface fixture with config naming deleted ao stub and valid ~/.local/bin/ao — bash fast-path and PS guard-path consistent (A: both fail; C: both fallback with resolver-path visible signal); non-surface unchanged
input: realistic
verification-mode: offline
```

### Scenario matrix

| Scenario | Surface | Expected |
|----------|---------|----------|
| Valid config, executable `ao` | active | Normal exec both paths |
| Broken non-empty explicit `ao`, fallback exists | active | A: fail both; C: fallback + signal both |
| Broken explicit `ao` | inactive | PATH/`AO_REAL_BINARY` fallback (unchanged) |
| Invalid JSON, file exists | active | Misconfiguration (not absent-config) |
| Config absent | active | Existing fallback unchanged |

## Decisions

### Cost / risk (A vs C)

| | **A. Hard-fail** | **C. Loud fallback (default)** |
|--|------------------|--------------------------------|
| Detectability | High — boot stops | High — if signal is mandatory and tested |
| Operator continuity | Low — must fix config before boot | High — boot may proceed |
| Regression risk | Medium — surface-only scope limits blast | Low–medium — must not spam/noise on every read |
| Incident class fit | Strong if masking is unacceptable | Strong if continuity matters but silence was the bug |

### Planner choice (open until implementation)

Document A vs C in PR. **Default: Option C.** **Option A** if fail-fast autonomous boot is preferred.

## Upgrade-safety check

- Document operator-visible behavior in `docs/migration_notes.md` if added.
- No AO core/vendor edits.

## Verification

- Focused vitest under `scripts/**`: AC#3–6 using isolated-pack fixtures (same pattern as #158).
- `pwsh -NoProfile -File ./scripts/verify.ps1` green.

## Codex review log

**Pass 1 (2026-06-28):**

| Finding | Verdict | Action |
|---------|---------|--------|
| P1 Option C inventory-only loophole | Accept | Option C requires resolver-path boot-time signal; inventory supplementary |
| P2 allowed-roots vs vitest | Partial | Scope note: regressions under `scripts/**` |
| P2 verify Windows path | Accept | `pwsh -NoProfile -File ./scripts/verify.ps1` |

**Pass 2 (2026-06-28):** `NO_FINDINGS`.

**Sync gate:** Codex clean; ship after #158; GitHub sync on operator request.

## Architect review log

| Pass | Key corrections |
|------|-----------------|
| 2026-06-28 #1 | Split from #158; Options A/B/C; surface scope |
| 2026-06-28 #2 | PS exec selector + dual-path parity; Option C observability AC |
| 2026-06-28 #3 | Surface detection fact; empty-key boundary; cost/risk table; git out of scope |

**Sync gate:** Codex clean after pass 2; optional hardening after #158 ships.

## GPT / prior review note

#158 GPT loop (pass 1–3) informed early resolver draft; architect passes #1–3 supersede on scope,
PS parity, and split.
