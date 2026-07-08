# In-place restructure of `prompts/agent_rules.md`

GitHub Issue: #654

## Prerequisite

- `docs/issues_drafts/224-worker-rules-delivery-restoration.md` — **queued, not synced** — **coordination only:** lands **after** this draft; its section-extraction generator binds to post-restructure `##` headings (fail-closed on rename). This draft establishes the heading API and line budget; **do not** implement 224's delivery mechanism, §S amendment, or `AGENTS.md:115` fix here.
- `docs/issues_drafts/53-delegation-policy-global-fanout.md` (GitHub #149, merged) — **already does:** thin `.mdc` pointers per entrypoint referencing `prompts/agent_rules.md` sections. **This draft preserves** byte-stable titles for Coworker CLI delegation, RTK read-exploration, RCA spec discipline; rewords AGENTS.md coworker/RTK framing only (core vs deep-dive).
- `docs/issues_drafts/212-ao-010-review-pipeline-vocabulary-migration.md` — **already does:** documents AO 0.10.2 reality (no `agentRulesFile` injection). **This draft fixes** stale injection prose still inside `agent_rules.md` (lines ~3, ~156–157, ~996 and related).
- Shipped coworker/RTK/RCA/draft-author pointer rules (`.cursor/rules/*.mdc`, `alwaysApply: true`) — **already do:** four guaranteed pointer surfaces. **Must remain** byte-exact on pointer file content; section **titles** in `agent_rules.md` for the three agent_rules-pointing rules stay byte-stable.

**Prior-art verdict (draft-author recon 2026-07-07):** **Genuinely new.** Corpus + `docs/issue_queue_index.md` + GitHub issue search found no queued draft that in-place restructures `prompts/agent_rules.md` for line-budget reduction while preserving CI mirror phrases and establishing a heading API for draft 224. #149 / #212 / #224 address delivery and fan-out; none perform the content reorganization, doc splits, or stale-prose correction bounded here.

**Decomposition check:** One PR — restructure `prompts/agent_rules.md`, add `docs/coworker-delegation.md` + `docs/tiering.md`, minimal `AGENTS.md` pointer reword (coworker/RTK only), CI check retargets **only where heading merges/renames force it**. No `docs/review-pipeline.md` extraction (future draft). No worker delivery restoration (224). Confirmed: brief bounds one draft = one PR; do not expand.

**Pre-draft design gate (T3 — architect brief + recon carry-forward):**

1. **Critical mechanics:** Single canonical file `prompts/agent_rules.md` (path invariant); ~13 CI scripts grep whole-file substrings (title-pinned script-doc sections + mirror phrases + reviewer-contract phrases + coworker floor phrases); four `alwaysApply` `.mdc` pointers deep-link section titles; post-restructure headings become extraction keys for 224's generator; content classes: worker action rules, script-owned documentation (CI mirrors), architect/draft policy (moves to `docs/tiering.md`), coworker deep-dive (moves to `docs/coworker-delegation.md`).

2. **Industry / best practice:** Large monolithic policy files are typically split into **core contract + reference annexes** with stable anchors; generated or grep-guarded mirrors for automation; "same PR retarget" for any anchor move (fail-closed CI).

3. **Architecture sketch (target state):**

```
prompts/agent_rules.md (~390–450 lines, sole path)
  ├── worker contract block (pickup, scope, review/CI/handoff, pre-flight)
  ├── coworker core (~85–115) + 2 pinned phrases
  ├── pointer-stable sections (Coworker title, RTK, RCA titles)
  └── script-owned pipeline doc block (title-substring pinned; trimmed)

docs/coworker-delegation.md (new, ~150) — examples, PR-diff recipe
docs/tiering.md (new, ~150) — tier rubric + per-tier draft flow (architect)

CI scripts ──grep──► agent_rules.md (unchanged path; retarget only on anchor drift)
.mdc pointers ──link──► stable ## titles in agent_rules.md
224 generator (future) ──extract──► exact ## heading strings (API)
```

4. **Options (≥3):**

| Option | Summary | Cost / risk | Sufficiency |
| --- | --- | --- | --- |
| **A — In-place restructure + doc splits (this draft)** | Trim/merge/regroup in-file; move architect + coworker deep-dive to new `docs/` pages; preserve CI phrases; strip `(Issue #NNN)` suffixes now | Medium — one multi-surface PR; careful phrase inventory | **Cheapest sufficient** — hits ~390–450 line budget without rename or check-retarget explosion |
| **B — Rename file + retarget all consumers** | New filename (e.g. `worker_rules.md`) | High — ~13 checks + AGENTS + 4 `.mdc` + verify.ps1 | Rejected — brief forbids path change |
| **C — Move script-doc to `docs/review-pipeline.md` + retarget checks** | Phase-2 extraction | High — separate check migration | **Deferred** — explicitly out of scope; future draft |
| **D — Reference / defer to 224 only** | Let delivery draft shrink context via injection | Low effort | **Insufficient** — 224 extracts blocking subset but does not fix 1035-line source, stale injection prose, or architect policy mixed into worker surface |

5. **Full-class enumeration (heading/CI anchor drift):** Any `##` heading **merge, rename, or umbrella fold** that alters a CI `-notlike` substring → same-PR check retarget **required** (fail-closed). Strip `(Issue #NNN)` suffix only when substring precedes suffix (safe for title-pinned checks). **Merge into Review/CI/Handoff contract** must preserve **every** reviewer-contract and contract-evidence reverify phrase verbatim (enumerated in Binding surface). **Pointer-covered titles** must remain byte-stable. **224 coordination:** heading renames after 224 lands cost generator regeneration — document in migration notes.

## Goal

Restructure `prompts/agent_rules.md` in place from ~1035 lines to **~390–450 lines** by merging worker-facing sections, moving architect/draft policy and coworker deep-dive to new reference docs, trimming script-owned documentation to pinned title-substrings/mirror-phrases plus one-line "script-owned; do not start" pointers, fixing stale AO-injection delivery prose, and stripping closed-issue `(Issue #NNN)` heading suffixes — **without** changing the file path, **without** breaking any CI grep anchor, and **without** touching draft-224 ownership zones (`AGENTS.md:115`, §S dead leg). Post-restructure `##` headings become a **de-facto API** for draft 224's section extractor.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
escalation-markers: multi-surface-span, shared-contract-dependency, ci-review-gating
```

## Binding surface

### Delivery model correction (mandatory)

Replace all claims that Composio AO injects this file via `agentRulesFile` with the AO 0.10.2 reality: rules reach agents via **tracked worktree files** — native `AGENTS.md` pickup and always-applied `.cursor/rules/*.mdc` pointers — not via any AO injection channel. Minimum stale lines to fix (re-verify at implementation): `prompts/agent_rules.md` ~:3, ~:156–157, ~:996, and injection framing in ~:27–30 / ~:43 region. **Operator adoption:** do **not** prescribe `ao stop` / `ao start` to "reload" this file; state adoption consistent with tracked-files-on-next-spawn/pull (exact wording in Operator adoption + migration notes).

### Hard invariants (architect-settled — do not relitigate)

1. **Path:** `prompts/agent_rules.md` only — never rename.
2. **CI mirror phrases in-file:** script-documentation sections stay in this file for phase 1; may trim/regroup but every check-pinned title-substring and mirror-phrase survives **verbatim** (see tables below).
3. **Check-retarget invariant:** heading merge/rename that breaks a grep substring → retarget that check in the **same PR**.
4. **Keep-trimmed in-file (do not move to docs):** First action; Tracker/role policy; Scope discipline + Before commit (merged); Queued task specs; Shared source of truth; Upgrade-safe AO usage; Build the minimum; Managed session constraints; Operator adoption handoff.
5. **Coworker split:** ~85–115 line worker core stays in-file; examples/PR-diff recipe/rationale → `docs/coworker-delegation.md`. **Pinned phrases that MUST remain in `agent_rules.md`:** literal `more than 400 lines` (T1 volume floor); phrase `index-coverage carve-out`.
6. **Tier policy move:** Task complexity tier rubric + Per-tier draft-review flow → `docs/tiering.md` with short in-file pointer. **Exception:** `### Worker pre-flight (blocking)` (~:888 today) is worker-facing — **move into** Review/CI/Handoff worker contract with pointer to `docs/tiering.md` for full rubric.
7. **Strip `(Issue #NNN)`** from all `##` headings (18 referenced issues closed); safe where substring precedes suffix.
8. **Pointer title byte-stability:** `## Coworker CLI delegation`, `## RTK read-exploration`, `## RCA spec discipline` — titles unchanged (`.mdc` deep-links).
9. **224 coordination (operator-approved):** this PR lands first; 224 revises under new structure. Do not touch `AGENTS.md:115` or `00-architecture-decisions.md` §S ~:644.

### Title-pinned CI checks (substring must survive in whole file)

| Check script | Grep anchor (case-insensitive `-notlike`) |
| --- | --- |
| `scripts/check-review-wake-trigger.ps1:159` | `*event-driven review trigger*` |
| `scripts/check-review-trigger-reeval.ps1:68` | `*Deferred-head review re-evaluation*` |
| `scripts/check-review-ready-report-state-seed.ps1:130` | `*Report-state review-start seed*` |
| `scripts/check-dead-worker-reconcile.ps1:44` | `*Autonomous dead-worker respawn*` |
| `scripts/check-ci-green-wake-reconcile.ps1:42` | `*CI-green orchestrator nudge*` |

Planner may fold these under one umbrella `## Script-owned review pipeline (documentation)` **if** each title substring still appears in the file (e.g. as subheading text or retained `##` lines). A **new** umbrella heading must not become a grep target unless paired with check updates.

### Mirror-phrase checks (phrases, not titles)

| Check script | Required phrases in `prompts/agent_rules.md` |
| --- | --- |
| `scripts/check-orchestrator-review-head-coverage.ps1:51–65` | `Orchestrator review-run coverage`, `Issue #189`, `covered terminal`, `PRE-RUN COVERAGE RE-CHECK`, `prNumber-less`, `fail closed to`, `Orchestrator LLM role vs script-owned review`, `review-trigger-reconcile.ps1`, `review-trigger-reeval.ps1`, `orchestrator-wake-listener.ps1`, `does **not** start or drive routine`, `issue #641`, `Script-owned procedure` |
| `scripts/check-orchestrator-review-head-ready.ps1:41–52` | `Head ready for review`, `Issue #195`, `review-head-ready.mjs`, `uncovered-but-not-ready`, `PRE-RUN HEAD-READY RE-CHECK`, `review-trigger-reconcile.ps1`, `review-trigger-reeval.ps1`, `orchestrator-wake-listener.ps1`, `does **not** apply this gate for routine rounds`, `issue #641` |
| `scripts/check-gh-wrapper.ps1:53–54` | `scripts/gh` (REST inventory routing documentation) |
| `scripts/check-command-runtime-forbidden-workaround.ps1:35` | command-runtime bootstrap phrases (preserve via grep audit before merge) |
| `scripts/check-coworker-delegation-threshold-drift.ps1:22` | `more than 400 lines` |
| `scripts/check-read-delegation-policy-consistency.ps1:61` | `index-coverage carve-out` |

### Reviewer-contract phrase inventory (must survive Contract merge)

Before merging Local Codex review / Review finding delivery / AO review response contract / Worker CI gate sections, preserve **every** phrase from:

- `scripts/check-reviewer-contract-mapping.ps1:26–41` in `agent_rules.md`: `Contract-mapping pass (reviewers only)`, `candidate evidence`, `direct diff inspection`, `invoke-reviewer-contract-mapping.ps1`, `-LedgerFile`, `-InvokeCoworker`, `mapping_pending`, `skipped_no_spec`, `ambiguous_spec`, `artifact_prep_failed`, `skipped_input_limit`, `stale_head`, `stale_spec`, `--paths`, `untrusted data`
- `scripts/check-contract-evidence-reverify.ps1:529–538` in `agent_rules.md`: `Checkpoint-2 contract-evidence re-verification`, `candidate evidence only`, `launch-contract-evidence-reverify.ps1`, `ReviewTargetRoot`, `resolve-bound-issue-snapshot.ps1`, `producer-verified`, `verification-mode`, `never auto-blocks`, `compared-to-record`

Implementation MUST run both checks green after restructure; add a one-time inventory comment in PR/migration notes listing source sections → merged contract destination.

### Anti-bloat guards (recurrence prevention — operator-mandated 2026-07-07)

The restructure must also prevent the two mechanisms that grew the file to 1035
lines in the first place:

1. **Admission policy in the preamble.** The restructured preamble states the
   placement rule (~5 lines): content is admitted into `prompts/agent_rules.md`
   ONLY if it is a **worker-LLM behavioral contract** (prose an agent must read
   to act correctly). Documentation of script-owned behavior goes to `docs/*`
   with at most a pinned one-line pointer; architect/draft-authoring policy goes
   to `docs/` or skills. A draft adding a section here must name the audience
   and enforcement class. The preamble also states the **no-new-mirrors rule**:
   new CI checks must NOT require mirror phrases/sections in this file — they
   pin `docs/` pages instead (existing pinned checks are grandfathered until the
   phase-2 `docs/review-pipeline.md` extraction).
2. **Fail-closed grep-consumer inventory.** A checked-in inventory (JSON under
   `scripts/`, precedent: the gh REST-read inventory) lists every script allowed
   to read/grep `prompts/agent_rules.md` (the ~13 current `check-*.ps1`,
   `draft-discipline.mjs`, `verify.ps1`, reviewer-policy lib). A new guard
   (`scripts/check-agent-rules-grep-inventory.ps1`, wired into `verify.ps1`)
   scans `scripts/` for `agent_rules` readers and fails CI on any consumer
   absent from the inventory — adding a new mirror-pinning check now requires a
   deliberate inventory row in the same PR, killing the silent ratchet.

### Target outline (planner balances to ≤450 lines)

Bounds only — not a mandated template. If sum exceeds 450, trim the script-owned pipeline block first (retain pinned substring + one-line script-owned note per section).

| Block | ~Lines | Notes |
| --- | --- | --- |
| Preamble + corrected delivery note | ~15 | No injection claims |
| First action | ~8 | |
| Tracker and role policy | ~10 | |
| Scope discipline (+ Before commit merged) | ~10 | |
| Small worker rules (Queued specs / Shared source / Upgrade-safe) | ~15 | |
| Build the minimum | ~14 | |
| Coworker CLI delegation (core + 2 pinned phrases + deep-dive pointer) | ~85–115 | Title byte-stable |
| RTK read-exploration | ~15 | Title byte-stable |
| gh wrapper transport | ~18 | `scripts/gh` phrase |
| Command-runtime bootstrap | ~12 | |
| Review / CI / Handoff worker contract | ~150 | Includes Worker pre-flight (blocking) + all reviewer-contract phrases |
| Script-owned review pipeline (documentation) | ~45 | Title-pinned + #189/#195 mirror phrases |
| Managed session constraints | ~6 | |
| RCA spec discipline | ~18 | Title byte-stable; `draft-discipline.mjs` mirror |
| Task tiering pointer → `docs/tiering.md` | ~8 | |
| Operator adoption handoff | ~16 | Fixed stale restart claim |

**New files:**

- `docs/coworker-delegation.md` (~150) — worked examples, PR-diff recipe, extended rationale moved from coworker section.
- `docs/tiering.md` (~150) — Task complexity tier rubric + Per-tier draft-review flow (minus Worker pre-flight duty).

### Settled section verdict table (34 → regrouped)

Implement per architect brief verdict table (all 34 rows). Key merges: sections 2–3, 15–16, 19, 23–26, 30 → Review/CI/Handoff contract; 5+6 → Scope; 17–22, 28–29 → script-owned pipeline block (trimmed); 31–32 → `docs/tiering.md`; 11 split → core in-file + `docs/coworker-delegation.md`.

### AGENTS.md in-scope edits (only)

Reword coworker and RTK pointer blocks from "single source of truth" to **core vs deep-dive** framing (examples now in `docs/coworker-delegation.md`). **Forbidden:** line ~115 AO-restart-on-`agent_rules.md`-change (224's zone).

### Open questions (planner resolves in PR; default if silent)

1. **`CLAUDE.md` stale `agentRulesFile` lines** (~:3–7, ~:18–24, ~:111) — **default: defer** to follow-up unless zero-conflict fix obvious; must not touch 224 zones.
2. **Script-doc grouping** — separate trimmed `##` vs one umbrella — planner choice if pinned substrings preserved.
3. **Check retarget log** — if zero heading substring changes, migration notes state "no retargets; suffix strip only."

```contract-evidence
binding-id: orchestrator-pack:agent-rules:line-budget
binding-type: cli-behavior
binding: restructured prompts/agent_rules.md line count at most 450 (ceiling-only guard; ~390–450 expected)
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:agent-rules:ci-mirror-phrases
binding-type: cli-behavior
binding: all title-pinned and mirror-phrase CI checks pass without weakening grep anchors
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:agent-rules:reviewer-contract-phrases
binding-type: cli-behavior
binding: check-reviewer-contract-mapping.ps1 and contract-evidence reverify phrase sets present in agent_rules.md after contract merge
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
```

## Files in scope

- `prompts/agent_rules.md` — in-place restructure `(update)`
- `docs/coworker-delegation.md` `(new)`
- `docs/tiering.md` `(new)`
- `docs/migration_notes.md` — restructure adoption / heading-API note / retarget log entry `(update)`
- `AGENTS.md` — coworker/RTK core-vs-deep-dive reword only `(update)`; **exclude** line ~115
- `scripts/check-review-wake-trigger.ps1`, `scripts/check-review-trigger-reeval.ps1`, `scripts/check-review-ready-report-state-seed.ps1`, `scripts/check-dead-worker-reconcile.ps1`, `scripts/check-ci-green-wake-reconcile.ps1`, `scripts/check-gh-wrapper.ps1`, `scripts/check-orchestrator-review-head-coverage.ps1`, `scripts/check-orchestrator-review-head-ready.ps1`, `scripts/check-command-runtime-forbidden-workaround.ps1`, `scripts/check-coworker-delegation-threshold-drift.ps1`, `scripts/check-read-delegation-policy-consistency.ps1`, `scripts/check-reviewer-contract-mapping.ps1`, `scripts/check-contract-evidence-reverify.ps1` — retarget **only** when a heading change breaks a grep anchor `(update)`
- `scripts/draft-discipline.mjs` / `scripts/rca-spec-discipline-surfaces.json` — update **only** if RCA section anchor text changes `(update)`; title byte-stable preferred
- `scripts/` — new line-budget + moved-content + grep-consumer-inventory guard scripts and the inventory JSON only `(new)`; wire into `verify.ps1` if not covered by reusable CI `(update)` to `scripts/verify.ps1` only
- `tests/**` — line-budget guard (ceiling-only), phrase-presence regression tests `(new/update)`

## Files out of scope

- `AGENTS.md:115` stale AO-restart instruction (draft 224)
- `docs/issues_drafts/00-architecture-decisions.md` §S ~:644 dead `agentRulesFile` leg (draft 224)
- `docs/review-pipeline.md` extraction + check retargets (future draft)
- Worker rules delivery generator / generated `.mdc` bundle (draft 224)
- `.cursor/rules/draft-author-relocation.mdc` content (byte-exact; not part of this restructure)
- Renaming `prompts/agent_rules.md`
- Policy **substance** changes beyond trim/merge/move (no new worker duties)

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
prompts/agent_rules.md
docs/coworker-delegation.md
docs/tiering.md
docs/migration_notes.md
AGENTS.md
scripts/check-review-wake-trigger.ps1
scripts/check-review-trigger-reeval.ps1
scripts/check-review-ready-report-state-seed.ps1
scripts/check-dead-worker-reconcile.ps1
scripts/check-ci-green-wake-reconcile.ps1
scripts/check-gh-wrapper.ps1
scripts/check-orchestrator-review-head-coverage.ps1
scripts/check-orchestrator-review-head-ready.ps1
scripts/check-command-runtime-forbidden-workaround.ps1
scripts/check-coworker-delegation-threshold-drift.ps1
scripts/check-read-delegation-policy-consistency.ps1
scripts/check-reviewer-contract-mapping.ps1
scripts/check-contract-evidence-reverify.ps1
scripts/draft-discipline.mjs
scripts/rca-spec-discipline-surfaces.json
scripts/verify.ps1
scripts/check-agent-rules-line-budget.ps1
scripts/check-agent-rules-moved-content.ps1
scripts/check-agent-rules-grep-inventory.ps1
scripts/agent-rules-grep-inventory.json
tests/**
```

## Acceptance criteria

1. **Line budget.** `prompts/agent_rules.md` is at most **450 lines** after restructure (LF endings; ~390–450 expected). The CI/test guard enforces the **ceiling only** — no lower bound (a shorter file must never fail CI).

```positive-outcome
asserts: wc -l prompts/agent_rules.md reports ≤450 on green CI
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: agent-rules
expected: line-budget
proof-command: npx vitest run -t "agent rules line budget"
red-then-green: artificially inflated file fails; restructured file passes
```

2. **CI mirror preservation.** All checks in Binding surface "Title-pinned" and "Mirror-phrase" tables pass on Ubuntu CI without relaxing patterns.

```positive-outcome
asserts: pwsh -NoProfile -File scripts/verify.ps1 passes including all agent_rules grep guards
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: agent-rules
expected: ci-mirror-phrases
proof-command: pwsh -NoProfile -File ./scripts/verify.ps1
red-then-green: remove one pinned substring fails targeted check; restore passes
```

3. **Reviewer-contract phrases.** `scripts/check-reviewer-contract-mapping.ps1` and contract-evidence reverify prompt-phrase tests pass.

```positive-outcome
asserts: both reviewer-policy phrase suites green after Review/CI/Handoff merge
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: agent-rules
expected: reviewer-contract-phrases
proof-command: pwsh -NoProfile -File scripts/check-reviewer-contract-mapping.ps1
red-then-green: omit one required phrase fails; full contract passes
```

4. **New reference docs.** `docs/coworker-delegation.md` and `docs/tiering.md` exist. **Moved-content guard (observable):** after restructure, `prompts/agent_rules.md` must **not** contain any of these former deep-dive anchors (grep guard or vitest): `Task complexity tier rubric`, `Per-tier draft-review flow`, the long coworker worked-example blocks (planner enumerates forbidden headings in the new guard script from brief § moved-to-docs list). Coworker **pinned phrases** (`more than 400 lines`, `index-coverage carve-out`) and **pointer-stable titles** remain in-file. `docs/coworker-delegation.md` must contain the PR-diff recipe section; `docs/tiering.md` must contain the full tier rubric body formerly under sections ~822 and ~898.

```positive-outcome
asserts: forbidden deep-dive heading substrings absent from prompts/agent_rules.md; present in target docs/*.md
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: agent-rules
expected: moved-content-guard
proof-command: pwsh -NoProfile -File scripts/check-agent-rules-moved-content.ps1
red-then-green: re-insert tier rubric into agent_rules fails; split layout passes
```

5. **Stale delivery prose removed (in-scope files).** Within `prompts/agent_rules.md` (and Operator adoption / preamble edits in this PR), no remaining claim that AO injects this file via `agentRulesFile`; delivery described as tracked files + pointers. Stale `CLAUDE.md` injection lines remain an explicit **defer** (open question #1) — AC#6 does not require editing `CLAUDE.md`.

6. **Pointer title stability.** Grep confirms exact titles: `## Coworker CLI delegation`, `## RTK read-exploration`, `## RCA spec discipline` unchanged.

7. **Worker pre-flight placement.** `### Worker pre-flight (blocking)` duty appears in Review/CI/Handoff contract (not solely in `docs/tiering.md`).

8. **224 zones untouched.** Diff excludes `AGENTS.md:115` and `00-architecture-decisions.md` §S AO-worker injection bullet.

9. **Migration notes.** PR body or `docs/migration_notes.md` entry documents: operator adoption (no AO restart for injection), heading-API note (post-restructure `##` headings are the extraction surface draft 224 will bind to; later renames cost a 224 regeneration), check-retarget log (or explicit none), new docs summary.

10. **Admission policy present.** The restructured preamble contains the placement rule and the no-new-mirrors rule (Binding surface § Anti-bloat guards); a grep guard or test asserts both marker phrases exist in `prompts/agent_rules.md`.

```positive-outcome
asserts: preamble admission-policy and no-new-mirrors marker phrases present in prompts/agent_rules.md
input: realistic
```

11. **Grep-consumer inventory fail-closed.** `scripts/check-agent-rules-grep-inventory.ps1` + checked-in inventory cover every current `agent_rules` reader under `scripts/`; adding an uninventoried reader fails the guard.

```positive-outcome
asserts: guard passes on current tree; injecting a stray Get-Content agent_rules consumer into scripts/ fails it
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: agent-rules
expected: grep-consumer-inventory
proof-command: pwsh -NoProfile -File scripts/check-agent-rules-grep-inventory.ps1
red-then-green: uninventoried reader fails; inventoried set passes
```

## Operator adoption

After merge: **no `ao stop` / `ao start` required** to deliver restructured rules — AO 0.10.2 does not inject this file. Changes take effect via **tracked worktree files** on next worker spawn / pull. Operators merging locally should pull `main`; live worker sessions pick up on recycle (224 will own fuller recycle guidance). `scripts/verify.ps1` treats `prompts/agent_rules.md` edits as adoption-touching — run verify locally before merge. Document in Operator adoption handoff section (corrected prose).

## Upgrade-safety check

- Path invariant preserves ~13 checks and four `.mdc` pointers without mass retarget.
- Phrase-level CI guards prevent silent enforcement drift during merges.
- No AO core / vendor edits.
- Heading API documented for downstream 224 — renames after 224 lands require generator regen (fail-closed).
- Does not implement delivery restoration — complementary to 224.

## Verification

1. Line-budget test/guard (AC#1).
2. `pwsh -NoProfile -File scripts/check-reviewer-contract-mapping.ps1` (AC#3).
3. `pwsh -NoProfile -File scripts/check-contract-evidence-reverify.ps1` (phrase subset).
4. Each title-pinned check script from Binding surface (AC#2).
5. `pwsh -NoProfile -File scripts/check-coworker-delegation-threshold-drift.ps1` and `scripts/check-read-delegation-policy-consistency.ps1`.
6. `node --import tsx scripts/draft-discipline.mjs` RCA mirror surfaces for `agent_rules.md`.
7. `pwsh -NoProfile -File ./scripts/verify.ps1` green.
8. Manual: `.mdc` pointer links resolve to stable section titles.

## Decisions

- **Prior art:** genuinely new restructure scope; extends 224 coordination without implementing 224.
- **Land option A** (in-place + doc splits) — cheapest sufficient vs rename (B), review-pipeline extraction (C), 224-only deferral (D).
- **Ordering:** this draft merges before 224; suffix strip now, heading stability documented in migration notes (no checked-in heading manifest — if 224's generator wants one, 224 introduces it to match its own design; architect lens cut 2026-07-07).
- **224 double-ownership:** explicit out-of-scope for AGENTS.md:115 and §S.
- **CLAUDE.md:** defer stale injection lines unless zero-conflict (open question #1).
- **Check retarget:** expect none if umbrella preserves title substrings; any break = same-PR retarget (fail-closed).
- **Coordinator handoff:** operator-approved obligations reproduced in Binding surface §224 coordination.
- **Anti-bloat guards (operator-mandated 2026-07-07):** admission policy + no-new-mirrors rule in the preamble, plus fail-closed grep-consumer inventory (gh-inventory precedent) — prevention of the two demonstrated bloat mechanisms (default-dumping and CI mirror ratchet) lands with the restructure itself, not a follow-up.

## Coordination with draft 224 (operator-approved)

Post-restructure `##` headings are the future extraction API for 224's generator (fail-closed on rename). Strip `(Issue #NNN)` suffixes in this PR so 224 binds to clean names. Do not edit 224's draft table to match — 224 revises after merge. Do not touch `AGENTS.md:115` or §S dead leg. AGENTS.md coworker/RTK: core-vs-deep-dive only. Full-file-via-pointer context cost drops to ~390 lines in this PR; 224 adds blocking injection separately — do not optimize beyond natural fallout.