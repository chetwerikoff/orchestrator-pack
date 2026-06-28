# Test fixture must not mutate live `.ao/autonomous-real-binaries.json`

GitHub Issue: [#494](https://github.com/chetwerikoff/orchestrator-pack/issues/494)

## Prerequisite

- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub #318, closed) and
  `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub #324, closed) —
  established the pack `scripts/ao` shim and gitignored `.ao/autonomous-real-binaries.json` as the
  non-turn-visible real-binary indirection for autonomous orchestrator sessions.
- `docs/issues_drafts/128-autonomous-bash-env-interposer-eval-hidden-defense.md` (GitHub #406, closed) —
  ships `createIsolatedInterposerPack()` / `writeIsolatedAutonomousRealBinariesConfig()` /
  `withIsolatedInterposerPack()` in `scripts/_test-interposer-pack-fixture.ts`.
- `docs/issues_drafts/146-autonomous-surface-spawn-budget.md` (GitHub #462, closed) — same isolated-pack
  pattern.
- **Follow-up (separate drafts, not prerequisites):**
  - `docs/issues_drafts/159-autonomous-real-binaries-broken-pointer-policy.md` — optional runtime
    policy when config names a broken `ao` pointer.
  - Sibling leak: `worker-nudge-gate.test.ts` finally-only `repoRoot/.ao` writer — same class,
    **out of scope** (separate issue unless zero-cost alignment during refactor).
- Queue check on 2026-06-28: no open draft/issue on the `withAoSpawnProbeStub` fixture-leak axis.
  **Re-verify at GitHub sync** (`gh issue list` + `docs/issue_queue_index.md`). Related meta-class:
  #324 `opk-probe` interposer tests (`autonomous-orchestrator-interposer.test.ts` already use
  `withIsolatedInterposerPack` + probe stub) — **target pattern for this fix**.

Prior-art recon verdict: **converge `withAoSpawnProbeStub` onto the shipped interposer-pack
pattern** already used in `autonomous-orchestrator-interposer.test.ts`. Do not merge with #157 or
#159.

## Goal

Autonomous test fixtures that stub `ao` via `.ao/autonomous-real-binaries.json` must never write
into the operator's live pack checkout. A killed or crashed test must be unable to leave
`repoRoot/.ao/autonomous-real-binaries.json` pointing at a deleted `/tmp/autonomous-ao-stub-*`
path. **This issue is the complete fix for the reported incident class** — isolation removes the
shared target; runtime resolver policy is deferred to #159.

```behavior-kind
action-producing
```

## Binding surface

**Incident (operator, 2026-06-28).** Gitignored `.ao/autonomous-real-binaries.json` pointed `ao` at
`/tmp/autonomous-ao-stub-JE9ILO/ao-stub.sh` — matching `withAoSpawnProbeStub`'s temp-stub pattern.
File absent after `/tmp` cleanup → operator symptom labeled `STUB_MISSING` (operator label, not a
pack error string). Manual restore from `.ao/autonomous-real-binaries.json.pre-boundary-fix.bak`.
**Separate from** #157 (`head_ref_mismatch` grant ref axis).

**Facts from code (2026-06-28):**

1. **Path collision — Fact.** `withAoSpawnProbeStub` writes
   `repoRoot/.ao/autonomous-real-binaries.json`; runtime reads the same path under pack root.
2. **Finally-only rollback — Fact.** Restore only in `finally` — not crash-safe for shared state.
3. **Kill-between-write-and-finally — Hypothesis.** Operator incident + fixture path pattern.
4. **Consumers — Fact.** `withAoSpawnProbeStub` imported by `autonomous-spawn-policy.test.ts`,
   `autonomous-orchestrator-boundary.test.ts`, `autonomous-spawn-worktree-gate.test.ts`.
5. **Isolation precedent — Fact.** `withIsolatedInterposerPack()` + probe stub in
   `autonomous-orchestrator-interposer.test.ts` — config under `pack.packRoot/.ao/...`, invokes
   `pack.aoShimPath` / copied guards; `BASH_ENV` via `pack.bootstrapPath` where interposer tests
   need bash interposition.
6. **Script-location pack root — Fact (load-bearing).** `scripts/ao` and copied
   `ao-autonomous-guard.ps1` resolve pack root from **script location** (`SCRIPT_DIR/..` /
   `Get-PackRootFromBoundaryLib`), not process `cwd`. Consumers today call `repoRoot/scripts/ao`,
   `repoRoot/scripts/ao-autonomous-guard.ps1`, and prepend `repoRoot/scripts` to `PATH` — **config
   relocation alone is insufficient**; tests must use isolated pack copies so config reads and shim
   location share the same temp `packRoot`.
7. **Who else writes `repoRoot/.ao/autonomous-real-binaries.json`? — Fact.** Tracked code:
   `withAoSpawnProbeStub`, sibling `worker-nudge-gate.test.ts` (out of scope). Non-test: operator
   manual copy per `docs/migration_notes.md` — no in-repo installer/setup writer.

**Contract:**

1. **Isolation (primary).** Refactor `withAoSpawnProbeStub` to build an isolated interposer pack
   (prefer delegating to `withIsolatedInterposerPack`), write stub config only under
   `pack.packRoot/.ao`, and pass **`pack`** to the callback so consumers invoke isolated
   `pack.aoShimPath` / copied guards — not `repoRoot/scripts/*`.
2. **Env alignment.** Where consumers set `PATH`, `BASH_ENV`, or `cwd`, align with isolated pack
   (`pack.scriptsDir`, `pack.bootstrapPath`, `pack.packRoot`) — not repoRoot script paths inside
   probe-stub tests.
3. **Rollback is not the safety story.** Correctness must not depend on `finally` restoring operator
   boot config.
4. **Coverage preserved.** Shipped resolver/guard logic via interposer pack copies — not mocks.
5. **Sentinel in helper.** Before/after trap on `repoRoot/.ao/autonomous-real-binaries.json` inside
   the helper; not duplicated per test file.

```contract-evidence
none
```

## Files in scope

- `scripts/_test-autonomous-ao-stub-fixture.ts`
- `scripts/autonomous-spawn-policy.test.ts`
- `scripts/autonomous-orchestrator-boundary.test.ts`
- `scripts/autonomous-spawn-worktree-gate.test.ts`
- `scripts/_test-interposer-pack-fixture.ts` (only if shared extraction is cheapest)

## Files out of scope

- `.ao/**`, resolver/shim runtime policy (#159), `worker-nudge-gate.test.ts`, #157, vendor/core

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
```

## Acceptance criteria

1. **No live `.ao` writes.** Helper uses isolated `packRoot` only. **Runtime sentinel** (in helper):
   snapshot/trap `repoRoot/.ao/autonomous-real-binaries.json` before/after each invocation; fail on
   mutation. Scoped to helper window — not global verify (avoids `worker-nudge-gate` / operator
   mid-run false positives). CI grep supplementary only.
2. **Consumers use isolated pack entrypoints.** All three suites: isolated `pack.aoShimPath` /
   copied guards; `PATH`/`BASH_ENV`/`cwd` aligned with `pack` per Binding surface §6–7.
3. **Callback exposes `pack`.** Refactored helper passes isolated pack fixture to consumers (planner
   owns exact callback shape).
4. **All three consumer suites green** under isolated pack.
5. **Kill-safe by construction.** Minimal helper comment: isolation, not `finally`, is the durable fix.
6. **No regression** to interposer / spawn-budget suites.

```positive-outcome
asserts: withAoSpawnProbeStub runs through isolated packRoot shims with aligned PATH/BASH_ENV; repoRoot/.ao/autonomous-real-binaries.json unchanged across helper window; three consumer suites pass
input: realistic
verification-mode: offline
```

### Scenario matrix (Mode 2)

| Scenario | Expected after fix |
|----------|-------------------|
| Test completes | Isolated pack cleaned; `repoRoot/.ao` untouched |
| Test killed after isolated write | Operator config unchanged |
| Consumer uses repoRoot shim with isolated config only | **Prevented** — AC#2 |

## Upgrade-safety check

- Test/fixture changes only; no AO core/vendor edits.

## Verification

- Targeted vitest: three consumer suites; optional regression proving sentinel catches repoRoot write.
- `pwsh -NoProfile -File ./scripts/verify.ps1` green (cite unrelated blockers if any).

## Codex review log

**Pass 1 (2026-06-28):** P2 verify command Windows-style → fixed to `pwsh -NoProfile -File ./scripts/verify.ps1`.

**Pass 2 (2026-06-28):** `NO_FINDINGS`.

**Sync gate:** Codex clean; ready for GitHub sync on operator request.

## Architect review log

| Pass | Key corrections |
|------|-----------------|
| 2026-06-28 #1 | Split from #159; isolation = incident-complete |
| 2026-06-28 #2 | Script-location pack_root; interposer target pattern; sentinel in helper |
| 2026-06-28 #3 | Removed #159 scope bleed; PATH/BASH_ENV/cwd alignment; callback exposes `pack` |
