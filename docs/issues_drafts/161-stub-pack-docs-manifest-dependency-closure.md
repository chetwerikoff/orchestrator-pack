# Isolated test stub-pack `docs/*.mjs` copy manifests must be dependency-closed (drift guard)

GitHub Issue: [#508](https://github.com/chetwerikoff/orchestrator-pack/issues/508)

## Prerequisite

- `docs/issues_drafts/128-autonomous-bash-env-interposer-eval-hidden-defense.md` (GitHub #406,
  **closed**) — ships `createIsolatedInterposerPack()` in
  `scripts/_test-interposer-pack-fixture.ts` with its own hardcoded `docs/*.mjs` allowlist.
- `docs/issues_drafts/158-test-fixture-autonomous-real-binaries-live-leak.md` (GitHub #494,
  **closed**, PR #497) — refactored `withAoSpawnProbeStub` to build on the isolated interposer pack
  and added `spawn-worktree-git-ref.mjs` to `AO_SPAWN_PROBE_STUB_PACK_DOCS` after a merge-time
  `ERR_MODULE_NOT_FOUND`. **That commit fixed the case, not the class.**
- `docs/issues_drafts/108-claimed-review-resolver-dependency-closure.md` (GitHub #335, **closed**) —
  same *dependency-closure* class for a PowerShell load path: a manual list drifted from real
  imports; tests masked the gap until live runtime broke. **Prior-art reference** for fail-closed
  regression coverage at fixture-build time — not a duplicate scope and not a fourth design option.
- `docs/issues_drafts/157-spawn-grant-head-ref-oid-binding.md` (GitHub #493) — neighbor on spawn
  worktree grant semantics; **do not merge** (orthogonal runtime contract).
- Prior-art recon (2026-06-28): no open issue/draft on stub-pack `docs/*.mjs` manifest drift.
  `scripts/check-skill-pointer-drift.ps1` and contract-evidence producer-closure checks are the
  closest shipped drift-guard precedents.

**Verification facts (2026-06-28, live tree):**

| Manifest site | Roots | Transitive `docs/*.mjs` closure | Missing from declared roots |
|---------------|-------|--------------------------------|-----------------------------|
| `AO_SPAWN_PROBE_STUB_PACK_DOCS` (`_test-autonomous-ao-stub-fixture.ts` L54–67) | 13 | 17 | `autonomous-orchestrator-boundary.mjs`, `mechanical-reconcile-bounds.mjs`, `orchestrator-claimed-review-run.mjs`, `review-mechanical-cli.mjs` |
| `createIsolatedInterposerPack()` docs loop (`_test-interposer-pack-fixture.ts` L55–63) | 4 | 15 | 11 modules (e.g. `review-head-ready.mjs`, `review-trigger-reconcile.mjs`, …) |
| **Union** (what `withAoSpawnProbeStub` actually copies today) | 17 | 17 | **none** — currently complete only by accidental overlap |

Runtime import chain (multi-line import matters — single-line grep misses it):
`spawn-worktree-grant.mjs` → (L9–14, multi-line) `spawn-worktree-git-ref.mjs` → (L5)
`autonomous-orchestrator-boundary.mjs`, plus `grant.mjs` → `review-mechanical-cli.mjs`. PR #497
added only `spawn-worktree-git-ref.mjs`; the other two are supplied today by interposer-manifest
overlap, not the AO list.

**Latent today?** Combined `withAoSpawnProbeStub` pack is import-closed **now**; each manifest
alone is not. Interposer-only packs cannot load `orchestrator-claimed-review-run.mjs` or
`autonomous-orchestrator-boundary.mjs` from pack-local paths. **Detection is not zero today** —
consumer suites such as `autonomous-spawn-worktree-gate.test.ts` already fail on
`ERR_MODULE_NOT_FOUND` when a pack-local module is missing. The gap is **opaque diagnostics at
runtime inside unrelated tests** and **no dedicated fixture-build guard** that names
`(fixture site, module, missingDep)` before merge. That right-sizes scope: loud, early failure — not
re-implementing Node's module graph in regex.

## Goal

Each isolated test stub-pack fixture entry must produce an **import-closed effective pack** (the
`docs/*.mjs` set that fixture actually copies, including intentional composition such as interposer
+ AO docs in `withAoSpawnProbeStub`). Incompleteness must **fail loudly at fixture-build time** with
`(fixture site, module, missingDep)` — not only as an opaque `ERR_MODULE_NOT_FOUND` deep inside a
consumer suite after merge. Cover **both** manifest sites; do not re-add one filename per incident.

```behavior-kind
action-producing
```

## Binding surface

**Critical mechanics**

- Both fixtures copy `repoRoot/docs/<file>` → `packRoot/docs/<file>` one file at a time via `cpSync`
  from hardcoded filename arrays — no import resolution today.
- `withAoSpawnProbeStub` composes **both** manifests (interposer pack + extra AO docs); per-list
  completeness can hide behind union overlap — **closure is judged on the effective pack each fixture
  entry builds**, not on a static per-list audit in isolation.
- ESM loads all static `import './x.mjs'` at module load (including multi-line `import { … } from
  './x.mjs'`); missing siblings fail at first `node` / `import()` from pack-local `docs/`.
- `docs/*.mjs` also contain JSDoc type imports (`@param {import('./foo.mjs').Type}`) — erased at
  runtime; any text/regex "resolver" that treats them as copy deps will over-copy into isolated
  packs.
- **Import-safety assumption (load-bearing today):** pack `docs/*.mjs` entry modules are safe to load
  as dependencies — top-level CLI runners self-gate on `process.argv[1]` basename before stdin I/O or
  `process.exit` (e.g. `runStdinJsonCli` in `review-mechanical-cli.mjs` L132–140 returns early when
  not the entry script; library-only modules such as `review-mechanical-cli.mjs` itself have no
  top-level CLI block). **This property is worth preserving**; a loader-based guard must not assume
  it forever without containment (see AC#6).
- Only these two `scripts/**` sites hardcode `docs/*.mjs` copy lists (`grep cpSync.*repoRoot.*docs`
  2026-06-28). `autonomous-orchestrator-interposer.test.ts` copies scripts, not docs manifests.

**Options judged (cheapest sufficient wins)**

| Option | Cost | Risk | Sufficiency |
|--------|------|------|-------------|
| **B. Loader-based fail-closed guard (lean)** | Low — after pack assembly, resolve/load each entry `docs/*.mjs` from pack-local paths in an **isolated subprocess** (closed stdin, timeout); Node's loader finds missing siblings | Naive in-process `import()` can hang on stdin or `process.exit()` if a module loses import-safety | **Cheapest sufficient** when subprocess-contained — immune to multi-line imports and JSDoc false deps |
| A. Regex/ad-hoc string parse → transitive copy list | Medium–high — must handle multi-line imports; must ignore JSDoc `import('…')` type refs | False negatives (missed multi-line) → same `ERR_MODULE_NOT_FOUND` under false "we have a resolver"; false positives (JSDoc) → over-copy | Over-engineered for test fixtures; **not recommended** |
| C. Copy all `docs/*.mjs` | Low implementation | Pulls unrelated modules/side effects; defeats allowlist intent | Over-broad; rejected |
| D. Real ESM lexer (execute-free resolve) | Low–medium — e.g. `es-module-lexer` / Node internal lexer | Adds dep or glue; only needed if subprocess `import()` is insufficient | Valid **alternative** to in-process `import()` when a module is not import-safe; handles multi-line, ignores JSDoc |

**Outcome bound (planner picks mechanism):** every fixture entry's **effective pack** is
import-closed; violation fails at fixture-build with `(fixture site, module, missingDep)`. **Lean
toward subprocess-contained loader guard (B)** as cheapest sufficient executor; real ESM lexer (D)
is allowed when `import()` is unsafe; collapsing the two root lists into one shared constant is
optional planner DRY if zero-cost — not required.

**Explicit non-mandates:** no regex/ad-hoc string extraction of import paths; no architecture sketch
prescribing resolver pipelines; do not require per-list static closure that duplicates modules across
composed manifests. (A real ESM lexer is **not** forbidden.)

**Out of scope:** runtime/production pack assembly, `docs/**` module edits, #157 grant semantics.

```contract-evidence
none
```

## Files in scope

- `scripts/_test-interposer-pack-fixture.ts`
- `scripts/_test-autonomous-ao-stub-fixture.ts`
- `scripts/**` — shared fixture-build guard + guard regression test (planner picks paths)
- `scripts/verify.ps1` — only if guard is wired into structural verify (optional; vitest-only OK)

## Files out of scope

- `docs/*.mjs` production modules (no import edits to fix fixtures)
- `plugins/**`, `prompts/**`, `.github/workflows/**`
- `vendor/**`, `packages/core/**`
- #157, #159, operator config policy

## Denylist

```denylist
vendor/**
packages/core/**
docs/**
plugins/**
prompts/**
```

```allowed-roots
scripts/**
```

## Acceptance criteria

1. **Both fixture entrypoints** (`createIsolatedInterposerPack` and `withAoSpawnProbeStub` /
   `copyAoSpawnProbeStubPackDocs`) run the **same** import-closure guard on the **effective pack**
   they assemble — not independent per-list static audits.
2. **Closure unit = effective pack:** for each fixture entry, after assembly, every `docs/*.mjs`
   entry module the fixture expects to be loadable from pack-local paths must resolve/load without
   `ERR_MODULE_NOT_FOUND`. **Forbidden:** regex/ad-hoc string extraction of import paths (breaks on
   multi-line; false positives on JSDoc). **Allowed:** Node loader via **subprocess-contained**
   `import()` when modules are import-safe (AC#6); or a real ESM lexer (e.g. `es-module-lexer`) for
   execute-free dependency resolution when `import()` is unsafe.
3. **Fail-closed guard with clear diagnostics:** fixture-build failure names `(fixture site, module,
   missingDep)` (or equivalent structured message). **Binding demo:** inject a synthetic missing
   sibling import (add `import './synthetic-missing.mjs'` to a copied module, do not copy the target
   → guard fails with that dep named) — **not** the 2026-06-28 per-list historical gaps (union pack
   is already closed; those gaps are analysis facts, not a reproducible guard fixture).
4. **`withAoSpawnProbeStub` composition preserved:** existing consumer suites stay green —
   `autonomous-spawn-worktree-gate.test.ts`, `autonomous-spawn-policy.test.ts`,
   `autonomous-orchestrator-boundary.test.ts`, and interposer/spawn-budget suites using
   `createIsolatedInterposerPack`.
5. **No new runtime contract** — test-infra only; production `docs/` layout unchanged.
6. **Guard runner containment (execution paths only):** when the guard uses subprocess-backed
   **module execution** (`import()` / `node` load of entry modules), that subprocess must have stdin
   closed (or `/dev/null`) and a bounded timeout. A non-import-safe module must fail the guard
   cleanly (timeout or structured non-zero exit) — **not** hang or kill the vitest worker.
   **Execute-free paths** (real ESM lexer dependency resolution with no module execution) are
   exempt from subprocess containment but must still fail closed with `(fixture site, module,
   missingDep)` diagnostics.

```positive-outcome
asserts: each stub-pack fixture entry's effective pack passes subprocess-contained import-closure guard at build time; synthetic missing-sibling injection fails guard with (site, module, missingDep); non-import-safe module cannot hang or process.exit the vitest worker; consumer stub-pack suites remain green
input: realistic
verification-mode: offline
```

### Scenario matrix

| Scenario | Expected |
|----------|----------|
| Copied module gains `import './bar.mjs'`, `bar.mjs` not copied into effective pack | Guard fails at fixture-build: `(site, module, bar.mjs)` |
| `withAoSpawnProbeStub` (interposer + AO composition) | Guard runs on composed effective pack; green on current tree |
| Interposer-only `createIsolatedInterposerPack` | Guard runs on that entry's effective pack only |
| Planner merges root lists into one shared constant | Allowed if zero-cost; not required |
| Entry module loses basename gate / reads stdin at top level | Guard subprocess times out or exits non-zero cleanly; vitest worker survives |

## Upgrade-safety check

- Test/fixture infra only; no AO core, vendor, or operator env changes.
- Allowlist intent preserved (copy only declared roots; guard validates loadability, does not mandate
  copying all of `docs/`).

## Verification

1. Targeted vitest over stub-pack fixture consumers (spawn-worktree gate, spawn-policy, boundary,
   interposer, spawn-budget) — all green.
2. Guard regression from AC#3 — synthetic missing-import injection fails guard; passes on fixed tree.
3. Guard containment from AC#6 — when guard uses subprocess module execution: closed stdin + timeout;
   vitest worker survives a deliberately non-import-safe stub module (planner-owned negative fixture).
   Lexer-only execute-free path exempt from subprocess requirement.
4. `pwsh -NoProfile -File ./scripts/verify.ps1` green (or cite unrelated blockers).

## Architect review log

| Pass | Key corrections |
|------|-----------------|
| 2026-06-28 #1 | Drop Option A mandate (multi-line + JSDoc traps); closure unit = effective pack; loader-based guard; AC#3 synthetic binding demo; consumer suites already fail — scope = early loud diagnostics |
| 2026-06-28 Codex #1 | `review-architect-artifact.ps1 -Kind issue-draft` — NO_FINDINGS |
| 2026-06-28 #2 | Import-safety assumption + AC#6 subprocess containment; narrow AC#2 to forbid regex/ad-hoc only; allow real ESM lexer |
| 2026-06-28 Codex #2 | P2: AC#2 lexer vs AC#6 subprocess — scoped AC#6 to execution paths only; re-review NO_FINDINGS |
