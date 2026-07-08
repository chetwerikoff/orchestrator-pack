# Pack-wide launch-argv contract inventory — census, discovery scan, validator wiring

GitHub Issue: #661

## Prerequisite

- `docs/issues_drafts/227-side-process-registry-launch-argv-contract.md` (GitHub #659, **in flight**) — **already does:** fixes `escalation-router` registry↔script argv binding and ships a fleet guard validating all **15** `children[]` launch contracts (`passProjectId` / `requiresOrchestratorSession` / `extraArgs` × script param blocks). **This draft consumes that guard as a validator reference** — does not widen, duplicate, or re-derive supervisor-registry argv binding.
- `docs/issues_drafts/217-worker-recovery-spawn-argv-ao-0-10-2.md` (GitHub #638, **merged**) and `docs/issues_drafts/223-worker-recovery-spawn-grant-prompt-convergence.md` (GitHub #652, **merged**) — **already does:** recovery-path `ao spawn` argv cutover + `check-ao-spawn-shape` guard. **Inventory absorbs as one validator row** for external-`ao` spawn surfaces — not duplicated.
- `docs/issues_drafts/206-ao-010-session-status-readers-migration.md` (GitHub #619, **merged**) — **already does:** session/status reader rebind + `check-ao-cli-argv-shape.ps1` capture-backed argv probes + `check-ao-dead-argv-bypass.ps1` blacklist over two hard-coded in-scope file lists. **Inventory references both**; consolidation (absorb blacklist into inventory rows vs keep as parallel validator) is planner-owned — parallel-untracked mechanisms forbidden.
- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub #431, **merged**) and `docs/issues_drafts/160-gh-rest-allowlist-review-forms-and-universal-wrapper-rule.md` / `168-*` lineage — **already does:** pack `scripts/gh` argv→REST inventory + static classification guards. **Integrate as existing validator** — do not rewrite wrapper transport.
- `docs/issues_drafts/95-orchestrator-message-egress-registry.md` (GitHub #298, **merged**) — **already does:** machine-readable catalog + fail-closed static discovery + owner-mechanism manifests (`orchestrator-message-catalog.json`, audit-roots manifest, owner-mechanisms manifest). **Pattern precedent** for inventory + discovery + allowlist discipline — not scope overlap.
- `docs/issues_drafts/218-journaled-worker-send-0102-argv-cutover.md` (GitHub #640, **unsynced local**) — **already does (pending):** journaled `ao send` argv cutover for AO 0.10.2. Same dead-argv class; **reference only** — do not absorb send-transport cutover into this inventory PR.

**Prior-art verdict (draft-author recon 2026-07-07):** **Genuinely new** for pack-wide caller→callee launch-surface inventory and fail-closed discovery. Per-surface guards (#638/#652 spawn, #619 session/status, #659 registry children, gh inventory) each closed one incident; no merged or open draft owns repo-wide launch census + discovery scan + validator registry. Corpus search (`launch argv`, `argv inventory`, `dead-argv`, `launch contract`) found #227 fleet guard as prerequisite consumer, not a substitute.

**Decomposition check:** **One keystone PR (this draft).** Scope is one coherent contract: machine-readable inventory + repo-wide census + fail-closed discovery scan + wiring existing validators as coverage claims. Missing callee-type validators (ps1→node, codex/cursor/opencode CLIs) are **deferred** to a follow-up slice recorded in Decisions — census may allowlist-with-reason until that slice lands; keystone does not block on building new capture contracts.

## Goal

Close **dead-argv discovery drift** pack-wide: every production caller→callee process-launch surface in the pack's production audit roots — `scripts/**`, `plugins/**`, and the runtime `.mjs` modules hosted under `docs/**` — is enumerated in a machine-readable inventory, a static CI discovery scan fails on any **new** unregistered launch hit, and each inventory row declares either a **validator-backed** coverage claim (existing guard proves caller argv against callee contract — the only rows that count toward argv-contract closure) or an explicit **allowlist-debt** entry (discovery-satisfied but contract-unvalidated until a follow-up validator lands) — with **no runtime invocation behavior changes**.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T2-T3
```

## Binding surface

### Dead-argv class (mechanism boundary)

| Term | Meaning |
|------|---------|
| **Caller** | Pack code that constructs argv for a child process |
| **Callee** | Script or external CLI the caller launches |
| **Dead argv** | Caller-built argv the callee cannot bind; no CI check exercises the production argv tuple against the callee contract |
| **Launch surface** | A callsite where production code spawns a child (not test self-spawn of code-under-test) |

**Industry frame:** consumer-driven contract testing (Pact-style) — caller argv expectations verified against callee contract in CI. Local KB (wiki/synto) has **no direct material** on argv consumer-driven contract testing; in-repo precedents (#95 message egress registry, gh argv inventory) anchor the pattern.

### Pre-draft design gate (architect brief carry-forward + draft-author pass)

**Critical mechanics:** Launch surfaces span ps1→ps1, ps1→node/tsx, ts/mjs→external CLI, plugin bin entrypoints, and the pack's runtime `.mjs` modules hosted under `docs/**` (architect probe 2026-07-07: 6 `docs/*.mjs` production modules contain `child_process` launch idioms — e.g. `docs/spawn-worktree-grant.mjs`, `docs/review-stuck-run-reaper.mjs`, `docs/orchestrator-message-registry.mjs` — outside `scripts/**`/`plugins/**`). Existing validators are per-callee-type fragments with no cross-surface index. `check-ao-dead-argv-bypass.ps1` is blacklist-over-fixed-lists — drift outside lists is invisible (#619 AC#9). Discovery must be **fail-closed**: unmapped hit = red CI (the #641 escalation-router failure shape).

**Components sketch (planner names files):**

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│ LAUNCH INVENTORY │◄────│ DISCOVERY SCAN   │────►│ VALIDATOR REGISTRY  │
│ (rows: caller,   │     │ (static idioms   │     │ (refs: #659 guard,  │
│  callee, source, │     │  across scripts/ │     │  #638 spawn shape,   │
│  validator id)   │     │  + plugins/)     │     │  #619 argv shape,    │
└────────┬────────┘     └────────┬─────────┘     │  gh inventory, …)   │
         │                       │               └──────────┬──────────┘
         │                       │                          │
         └───────────────────────┴──────────────────────────┘
                    every scan hit → row OR allowlist-with-reason
```

**Options judged (cost / risk / sufficiency):**

| Option | Verdict |
|--------|---------|
| **A — Extend `check-ao-dead-argv-bypass` file lists only** | **Rejected** — same blacklist class; new surfaces stay invisible until hand-listed (#641 lesson) |
| **B — Reference/extend shipped per-surface validators under one inventory + discovery** (message-egress #95 + gh inventory precedent) | **Land** — cheapest sufficient executor; reuses #659/#638/#619/gh guards as validator rows |
| **C — Runtime argv interceptor / wrapper on every spawn** | **Rejected** — violates no-runtime-change constraint; high risk |

**Prior art in option B:** #95 catalog + audit-roots discovery; gh `classifyArgv` inventory; #659 fleet param-block guard — composed, not reimplemented.

### Full-class scenario matrix (caller-lang × callee-type × argv-source)

Expected outcome **per cell** after keystone ships:

| caller \\ callee → | pack-ps1 | pack-node/tsx | ao (external) | gh (pack wrapper) | codex/cursor/opencode | other-external |
|--------------------|----------|---------------|---------------|-------------------|----------------------|----------------|
| **ps1** | inventoried; #659 validator when registry-backed, else validator-backed or allowlist-debt | allowlist-debt *or* follow-up validator | inventoried + #638/#619 validators | inventoried + gh inventory validator | allowlist-debt *or* follow-up validator | allowlist-debt |
| **ts/mjs** | inventoried; #659 when registry-backed | allowlist-debt *or* follow-up | inventoried + #638/#619 validators | inventoried + gh inventory | allowlist-debt *or* follow-up | allowlist-debt |
| **argv: registry/inventory** | row cites registry child + #659 | row cites launch tuple + validator id | row cites capture/help source | row cites inventory route id | allowlist-debt or capture validator | row + reason |
| **argv: hard-coded** | row + validator | row + validator or allowlist-debt | row + capture validator | row + gh validator | allowlist-debt | allowlist-debt |
| **argv: computed** | row + validator; unanalyzable → hash-pinned allowlist (#95 pattern) | same | same | same | allowlist-debt until validator | allowlist-debt |

**Coverage kinds (inventory row metadata):**

| Kind | Closes dead-argv class? | Meaning |
|------|-------------------------|---------|
| `validator-backed` | yes (for that row) | Row references a CI guard that exercises caller argv vs callee contract |
| `allowlist-debt` | no — tracked gap | Discovery-satisfied; explicit reason + follow-up owner; does not count as class closure |

**Test-exclusion rule (mandatory):** `spawnSync` / `execFileSync` / `Start-Process` inside `*.test.ts`, `*.test.mjs`, `*.test.ps1`, and dedicated test-helper modules whose sole purpose is exercising code-under-test are **not** production launch surfaces. The discovery scan must implement this as an **explicit exclusion class** (path pattern + optional manifest), not silent skip. Grounding: **83** ts/mjs spawn-idiom files under `scripts/`, **59** are `*.test.ts` (2026-07-07 worktree grep).

**Call-operator handling (mandatory, observable):** Every PowerShell `&` / call-operator launch hit must classify into exactly one category: `inventoried`, `test-excluded`, `allowlist-hash-pinned`, or `fail` — no planner-only "infeasible" skip bucket.

**Consolidation policy:** Future dead-argv incidents extend inventory rows and fixtures — not new parallel blacklist scripts. Existing bespoke guards may be absorbed into inventory rows or kept as referenced validators; leaving them untracked by inventory is forbidden.

**Operator adoption:** none — CI/inventory only; no `agent-orchestrator.yaml` or `ao stop`/`ao start` change.

```contract-evidence
binding-id: orchestrator-pack:launch-inventory:every-production-surface-rowed
binding-type: cli-behavior
binding: machine-readable launch inventory lists every production caller→callee surface discovered in scripts and plugins audit roots
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
expected: every-production-surface-rowed

binding-id: orchestrator-pack:launch-discovery:unmapped-hit-fails
binding-type: cli-behavior
binding: static discovery scan exits non-zero when a launch idiom hit has no inventory row and no allowlist-with-reason entry
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
expected: unmapped-hit-fails

binding-id: orchestrator-pack:launch-inventory:validator-row-coverage
binding-type: cli-behavior
binding: every inventory row names a validator id that resolves to an existing guard script or explicit allowlist class
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
expected: validator-row-coverage

binding-id: orchestrator-pack:launch-inventory:existing-guards-referenced
binding-type: cli-behavior
binding: check-ao-spawn-shape, check-ao-cli-argv-shape, check-ao-dead-argv-bypass, gh inventory classifier, and #659 side-process launch guard each have at least one inventory row referencing them
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
expected: existing-guards-referenced

binding-id: orchestrator-pack:launch-discovery:test-exclusion-explicit
binding-type: cli-behavior
binding: discovery scan documents and applies explicit test-file exclusion rule without silently skipping production hits
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
expected: test-exclusion-explicit
```

## Files in scope

- `scripts/**` — inventory data, discovery scan, validator registry manifest, census tooling, CI wiring, co-located `*.test.ts` / `*.test.mjs` guard tests `(new/update)`
- `plugins/**` — included in discovery audit roots; plugin `tests/**` only when a plugin launch surface is inventoried `(scan + targeted tests)`
- `tests/external-output-references/**` — red-then-green fixtures and capture-backed references `(new/update)`
- `docs/**` — runtime `.mjs` modules are part of the discovery audit roots `(scan + inventory rows)`; generated human-readable launch-surface map if planner adds generator `(new/update, optional)`

## Files out of scope

- Runtime changes to any caller's argv construction or callee launch behavior
- `#659` / draft 227 implementation — prerequisite only; consume its guard, do not edit registry child scripts for this issue
- gh wrapper transport rewrite (#431/#501, drafts 160/168 lineage)
- `packages/core/**`, `vendor/**`, `agent-orchestrator.yaml`, `.ao/**`
- Draft 218 / #640 journaled send argv cutover (reference)
- New capture contracts for codex/cursor/opencode CLIs — **deferred follow-up** (Decisions)
- ps1→node validator implementation — **deferred follow-up** unless trivially coverable by allowlist-with-reason in census

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
plugins/**
tests/external-output-references/**
docs/**
```

## Acceptance criteria

1. **Full census.** A machine-readable launch inventory enumerates every production caller→callee launch surface under the agreed audit roots (`scripts/**`, `plugins/**`, and `docs/**` runtime modules per Binding surface). Each row records: stable row id, caller location, callee identity, callee-contract source class (`pack-ps1-param-block` | `captured-external-help` | `gh-inventory-route` | `allowlist-only`), **coverage kind** (`validator-backed` | `allowlist-debt`), and validator id (required when `validator-backed`) or allowlist reason + follow-up owner (required when `allowlist-debt`). Census completeness is verified against the **checked-out candidate tree** (the same tree the discovery scan analyzes in CI) — not a stale baseline branch snapshot.

```positive-outcome
asserts: launch inventory contains a row for every production launch surface the discovery scan reports on a clean tree, with no orphan rows lacking a reachable callsite
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: launch-inventory
expected: every-production-surface-rowed
proof-command: implementation-specific inventory completeness check cross-referenced against discovery scan output on clean tree
red-then-green: fixture tree with one deliberate unlisted production launch site fails completeness; listed tree passes
```

2. **Fail-closed discovery.** A static CI discovery scan finds launch idioms (`Start-Process`, `pwsh -File`, `& pwsh`, `pwsh -NoProfile`; Node `spawnSync`, `execFileSync`, `spawn`, `exec`, `execFile`, `fork`; `node`/`tsx` child launch; and PowerShell call-operator `&` invocations). Every hit classifies into exactly one outcome: **inventoried row** (including `allowlist-debt` rows backed by hash-pinned allowlist metadata), **test-excluded** (per explicit rule), or **fail**. Hash-pinned allowlist metadata is an inventory row attribute — not a substitute for omitting the row. Any production hit that is not test-excluded and lacks an inventory row fails CI with file and span. Scan never silently passes unanalyzable constructs (#95 precedent). **Root-set completeness:** the idiom sweep itself runs over all tracked pack files (not only the declared audit roots); a production launch idiom found **outside** the declared audit roots must still classify (inventoried / test-excluded / allowlisted-with-reason) or fail CI — audit roots are a classification aid, never a scope limiter (the census must not repeat the too-narrow-boundary failure this class is about).

```positive-outcome
asserts: discovery scan exits non-zero on a fixture that adds a new unregistered production launch callsite and exits zero once the site is inventoried or allowlisted-with-reason
input: sample-backed
```

```producer-emission
producer: orchestrator-pack
datum: launch-discovery
expected: unmapped-hit-fails
proof-command: implementation-specific discovery scan against fixture tree with synthetic unregistered launch site
red-then-green: unregistered fixture fails; same site after inventory row or allowlist passes
```

3. **Validator registry.** Every `validator-backed` inventory row's validator id resolves to an existing repo guard invoked in CI. `allowlist-debt` rows are permitted for discovery closure but must not be counted in any "class closed" aggregate; a CI check fails when an `allowlist-debt` row lacks reason text and follow-up owner. Rows with invalid validator ids fail CI.

```producer-emission
producer: orchestrator-pack
datum: launch-inventory
expected: validator-row-coverage
proof-command: implementation-specific validator-id resolution check over all inventory rows
red-then-green: row pointing at nonexistent validator id fails; corrected reference passes
```

4. **Existing guard absorption.** At minimum, these shipped validators each have ≥1 inventory row naming them **or** an explicit absorbed-coverage record proving their in-scope patterns are fully represented in inventory rows (planner chooses keep-as-referenced vs absorb): `scripts/check-ao-spawn-shape.ps1` (#638/#652), `scripts/check-ao-cli-argv-shape.ps1` (#619), `scripts/check-ao-dead-argv-bypass.ps1` (#619/#640), pack `scripts/gh` inventory classifier (#431/#501), and the #659 side-process registry launch-contract guard (exact script name from #659 merge). Parallel-untracked mechanisms are forbidden — if a guard is absorbed, its patterns must live in inventory rows and the guard may be retired in the same PR.

```producer-emission
producer: orchestrator-pack
datum: launch-inventory
expected: existing-guards-referenced
proof-command: implementation-specific check that each named shipped validator has at least one inventory row referencing it
red-then-green: tree with one shipped guard absent from inventory fails; referenced tree passes
```

5. **Explicit test exclusion.** Discovery implements and documents the test-exclusion rule from Binding surface. A fixture `*.test.ts` spawn of code-under-test does not require a production inventory row; a production file with the same idiom does. Negative fixture: production callsite wrongly excluded → scan fails.

```producer-emission
producer: orchestrator-pack
datum: launch-discovery
expected: test-exclusion-explicit
proof-command: implementation-specific discovery scan on paired fixture trees (test-only vs production callsite)
red-then-green: production hit treated as test-only fails; test file correctly excluded passes
```

6. **Scenario matrix fixtures (red-then-green).** Committed fixtures cover at least:
   - **#641-shape:** registry `passProjectId:true` vs script missing matching param — must fail via #659 validator row (or discovery+inventory linkage), not a bespoke new blacklist-only script.
   - **#638-shape:** recovery `ao spawn` argv missing required flags — must fail via spawn-shape validator row.
   - **Unregistered surface:** new `spawnSync`/`Start-Process` in a production file with no row — discovery fails.
   - **Allowlist-with-reason:** dynamic/unanalyzable launch construct covered only by hash-pinned allowlist entry; body change without allowlist update fails (#95 allowlist discipline).

7. **CI wiring.** Discovery scan and inventory completeness checks run on the same path as `scripts/verify.ps1` and/or `scripts/check-reusable.ps1` (planner chooses hook point). No new runtime spawn wrappers.

8. **No runtime argv mutation.** Grep/static audit confirms zero edits to production argv assembly in caller scripts beyond inventory metadata, test fixtures, and guard wiring — verified by scope guard or reviewer checklist.

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`.
- No `agent-orchestrator.yaml` or AO core changes.
- Inventory and discovery are read-only CI contracts; production launch behavior unchanged.
- gh wrapper transport not rewritten — inventory references existing classifier only.
- #659 guard consumed, not duplicated.

## Verification

1. `pwsh -NoProfile -File scripts/verify.ps1` and `pwsh -NoProfile -File scripts/check-reusable.ps1` — pass with new discovery wired.
2. Run new discovery scan on clean tree — exit 0.
3. Run discovery scan on unregistered-launch fixture — exit non-zero, names site.
4. Inventory validator-resolution check — all rows resolve; deliberate bad validator id fails.
5. Confirm ≥1 inventory row references each of: spawn-shape guard, cli-argv-shape guard, dead-argv-bypass guard, gh inventory, #659 launch-contract guard.
6. Test-exclusion paired fixtures — pass/fail as AC#5.
7. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/229-pack-wide-launch-argv-contract-inventory.md`
8. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/229-pack-wide-launch-argv-contract-inventory.md`

## Decisions

- **Prior art:** #638/#652 and #641/#659 proved the dead-argv class on recovery spawn and registry children; #619/#640 guards are blacklist fragments; #95 and gh inventory prove inventory+discovery pattern in this repo. This draft closes the **index + discovery** gap without re-deriving per-surface fixes.
- **Tier:** recomputed **T3** — advisory T2–T3; full 3-axis scenario matrix + repo-wide census + new contract surface.
- **Decomposition:** keystone only (this draft). **Deferred follow-up slice** (not authored as draft 229): callee-type validators missing today — ps1→node (`publish-issue-body-sync.ps1` pattern), codex/cursor/opencode review-pipeline CLIs — implement capture-backed validators when census proves non-trivial; until then **allowlist-with-reason** in inventory satisfies fail-closed discovery. Record owner as future draft after #659 merges.
- **Absorb vs keep #619 blacklist:** planner chooses; acceptance forbids parallel-untracked `check-ao-dead-argv-bypass` if inventory ships.
- **Grounding (2026-07-07 worktree):** 15 registry children; 19 ps1 + 83 ts/mjs spawn-idiom files (59 test); validator script sizes match brief. See `.review/229-pack-wide-launch-argv-contract-inventory/grounding-capture.txt`.
- **Architect pre-sync amendment (2026-07-07):** audit roots widened to include `docs/**` runtime `.mjs` modules — live probe found 6 production modules with `child_process` launch idioms under `docs/` that `scripts/**`+`plugins/**` roots would miss; AC#2 gained the root-set completeness rule (repo-wide idiom sweep; roots classify, never scope-limit).