# RTK net-savings: measured, source-aware, low-risk-first rollout

GitHub Issue: #199

## Prerequisite

- `docs/issues_drafts/51-coworker-rtk-worker-adaptation.md` (GitHub #145, **merged**) —
  established coworker RTK on worker hosts: opt-in, passthrough-first, host-global,
  **additive** passthrough including the broad `ao ` subcommand family, and a 7-day
  **qualitative** observation. #145 deliberately deferred any measurement harness /
  scorer to "a follow-up issue if observation proves insufficient." **This is that
  follow-up.** It does not relitigate §R's PR-quality observation (§R.5) — it sizes the
  **token-savings opportunity** RTK is currently leaving on the table and gates the one
  change #145 forbade outright: narrowing the broad `ao` passthrough.
- `docs/issues_drafts/53-delegation-policy-global-fanout.md` (GitHub #149) — single-source
  delegation policy + thin pointers (`AGENTS.md`, `.cursor/rules`, `CLAUDE.md`). Any
  agent-facing guidance this issue adds follows that fan-out shape; it is not pasted into
  multiple surfaces.
- Architecture decision **§R** in `docs/issues_drafts/00-architecture-decisions.md`
  (synced to GitHub #3) — this issue **amends** §R; it must not contradict §R.2's
  host-global limitation or §R.3's "additive, never remove upstream defaults" rule.

## Goal

Replace "raise RTK adoption %" with a measured, risk-aware capture of the token savings
RTK is missing — starting with high-volume, low-risk read-only shell shapes — while
making the one risky lever (compacting signal-bearing `ao` / review / scope output)
unreachable until a pinned field-preservation test proves it is safe. Optimise **net
saved tokens on low-risk command shapes**, not adoption percentage.

## Binding surface

1. **Source-attribution feasibility is a gate, not an assumption.** Because the RTK hook
   is host-global (§R.2) and per-session toggling is unsupported, it is unknown whether
   `rtk discover` (or any RTK output) can attribute missed savings to a **caller/source**
   (orchestrator / AO Cursor worker / interactive Claude / interactive Cursor / ad-hoc
   shell). The work MUST first establish this. If native attribution does **not** exist,
   the plan MUST degrade gracefully: proceed on **command-shape × risk-tier** alone and
   mark source-segmentation **best-effort**. No later step may hard-depend on
   source attribution that the tooling cannot provide.

2. **Missed-savings inventory.** A documented, repeatable inventory of RTK missed savings
   with, at minimum, columns: command shape, occurrence count, estimated missed tokens,
   current passthrough match (yes/no + matching pattern), **risk tier**,
   **sensitivity/exactness override (yes/no)** (per §3), recommended
   action, and "field-preservation test required?". Source/caller is an additional column
   **only if** the feasibility gate found attribution. The inventory is the input to every
   downstream decision; it is not a one-off screenshot — the method to regenerate it MUST
   be documented.

3. **Risk tiering (contract).** Each command shape is classified:
   - **low** — `grep`, `find`, `cat`/file reads, `ls`, `wc`, and ordinary read-only
     exploration where exact bytes are not decision-bearing;
   - **medium** — `gh pr/issue … --json`, `git branch`, `git log` when not scope/review
     critical;
   - **high** — `ao status` / `ao review list` / `ao events` / `ao report` / `ao send` /
     `ao spawn` / `ao review send` / `ao-declare`, `git diff`, `gh pr checks`, and any
     scope / CI / review / declaration signal.

   An **overriding sensitivity/exactness rule trumps command family**: output that may
   carry secrets or credentials (`.env`, key/token files, generated auth output),
   private logs, raw **declaration / scope file contents**, or **exact-byte**
   config/schema content where the precise bytes are decision-bearing is **permanently
   no-compact** regardless of which command produced it and is **not** unlockable by §6
   (so a `cat`/`grep`/`find` of such a target is never "low"). The inventory MUST record
   this override per shape.

   **Permanently-raw vs §6-unlockable within the high tier (resolves the boundary):** the
   permanently no-compact set above, plus `ao` control / mutating / signal commands
   (`ao report` / `ao send` / `ao spawn` / `ao review send` / `ao-declare`), `git diff`,
   and `gh pr checks`, stay raw and are **never** compacted. The **only** high-tier output
   that §6/§7 may ever unlock is **structured read-only `ao … --json` inspection**
   (`ao status` / `ao review list` / `ao events`), and only after the §6 field-preservation
   test + schema-refresh gate passes. The tiering is the policy boundary: low may be
   compacted freely **only after the sensitivity/exactness override has cleared the
   shape**; permanently-raw high output is never compacted; `ao --json` inspection is
   compacted only once §6 passes.

4. **Low-risk guidance lands on the surface that owns the noise.** The durable change for
   low-risk shapes is guidance — "for reads, prefer the agent's dedicated file tools;
   reach for RTK wrappers only for raw shell that is genuinely needed" — placed on the
   surface(s) that the feasibility/inventory step shows actually generate the noisy
   sessions, following the #149 single-source-plus-pointer shape. It MUST NOT be written
   blindly into a worker-facing file when the noise originates elsewhere, and MUST NOT be
   duplicated across surfaces. **No-attribution fallback (per §1):** when source cannot be
   attributed, the guidance lands as a **single caller-independent canonical rule** (true
   for any agent that reads it) with #149-style thin pointers, or as operator/runbook
   guidance when no agent surface is implicated — it does **not** guess a specific noisy
   surface. Chasing adoption % is an explicit non-goal.

5. **Kill-gate after measurement.** Before any field-preservation harness is built, a
   written go/no-go MUST be recorded: if the measured opportunity for the **high-risk
   `ao`/inspection** families is below a stated materiality bar (define the bar in the
   inventory doc), the harness is **not built**, §R is left intact, and the issue closes
   on **low-risk capture + guidance alone**. The harness is conditional work, not a
   committed deliverable. **The no-go path authorizes no passthrough change beyond
   low-risk shapes** (see §6a).

6a. **Medium-risk is measurement/guidance-only; existing §R.3 families need the §6 gate.**
   Medium-tier shapes (`gh pr/issue … --json`, `git branch`, `git log`) are scoped to
   **inventory + guidance** in this issue — they authorize **no** passthrough/compaction
   change on their own, because the contextual qualifier "when not scope/review critical"
   is **not** an enforceable substring under host-global matching. Likewise, any change
   that would **compact or narrow an existing §R.3 passthrough family** (`git diff`,
   `git log`, `gh pr checks`, the `ao ` family, `ao-declare`) or any **signal-bearing
   `gh … --json`** MUST go through the **same §6-class field-preservation gate + schema
   refresh + exact-pattern rollback** as the `ao` path — never the qualifier alone. Only
   **low-risk shapes that are not already in §R.3 passthrough and have cleared the
   sensitivity/exactness override** may be compacted without that gate.

6. **Field-preservation test is a pinned, CI-enforced contract — the only key to the
   `ao` passthrough.** If and only if the kill-gate passes: a test using **pinned
   fixtures** (captured real `--json` outputs) MUST assert that piping each through RTK's
   JSON compaction preserves a documented **must-keep field set** — at minimum: run id,
   linked session id, PR number, status/state, finding counts (including open/sent),
   `terminationReason`, lifecycle & runtime state, CI status, review state, and event
   id / timestamp / type / error fields. The test MUST be wired into the **existing**
   verify entry points (`scripts/verify.ps1` and/or `scripts/check-reusable.ps1`) — **no
   new `.github/workflows/**` file** — and MUST fail if any must-keep field is dropped or
   altered. The CI guarantee is **scoped to fixture-covered fields**: static fixtures
   prove RTK preserves the fields they contain, not fields AO may later add or rename.
   Therefore narrowing the `ao` passthrough (§7) MUST additionally be gated on a
   documented **fixture-refresh / schema-snapshot** step — re-capture current AO sample
   output and diff its key set against the pinned must-keep map, re-performed on
   coworker/AO upgrades — before the narrowing takes effect. A one-shot manual check does
   not satisfy the CI portion.

7. **Touching the `ao` passthrough is gated, durable, and never blanket.** Only after §6
   is green may the broad `ao ` passthrough (§R.3) be narrowed, and only as a **vetted set
   of raw control commands + documented JSON-safe inspection forms** — never as a blanket
   "remove `ao`". The substring matcher makes blind removal unsafe (control/signal
   subcommands overlap). **The narrowing MUST be durable against #145's tracked helper +
   manifest + static guard:** a purely local (gitignored) passthrough edit is rejected,
   because the next helper re-run or host bootstrap would silently restore broad `ao `.
   The durable change updates the **tracked pack manifest and its canonical-family static
   guard** so the helper itself applies the vetted set instead of broad `ao `, and the
   static guard asserts broad `ao ` is **no longer** the applied family. Rollback restores
   the **exact §R.3 pattern** via the manifest/helper (`coworker rtk passthrough add 'ao '`
   — trailing space; bare `'ao'` over-matches), with `coworker rtk disable` as the
   host-level emergency rollback. This amends §R.3 (AC8); it does not touch upstream
   coworker defaults.

8. **Operator adoption.** Passthrough state and `coworker rtk` enablement are
   operator-owned and host-global (§R.2). Post-PR operator steps:
   - regenerate the missed-savings inventory on the operator host (the data is
     machine-local; the repo ships the method, not the operator's numbers);
   - apply any low-risk guidance per its merged surface (no operator action if the surface
     is a tracked rule file already consumed by sessions);
   - **only if §6/§7 land:** apply the narrowed passthrough via the documented procedure,
     re-run hook smoke (per #145 runbook), and keep `coworker rtk passthrough add 'ao '`
     ready as rollback.

## Files in scope

- `docs/**` — missed-savings inventory method + risk-tier table template, feasibility
  finding, kill-gate record, and (conditional) field-preservation test + passthrough
  narrowing procedure with rollback; cross-linked from the existing coworker RTK runbook.
- `scripts/**` — (conditional, past kill-gate) field-preservation test harness + pinned
  fixtures, wired into existing verify entry points; pwsh 7+ on Linux/WSL2.
- `prompts/agent_rules.md` and thin pointers (`AGENTS.md`, `.cursor/rules/**`) — low-risk
  read-exploration guidance, **only on the surface(s) the inventory identifies**, per #149.
- `docs/issues_drafts/00-architecture-decisions.md` — amend **§R** (add the measured,
  source-aware, low-risk-first follow-up and the field-preservation precondition).
- `docs/issue_queue_index.md` — this draft's registry row.

## Files out of scope

- `vendor/**`, `packages/core/**`, Composio AO upstream; forking/vendoring coworker.
- Re-running or relitigating #145's **PR-quality** qualitative observation (§R.5) — this
  issue measures token savings, a distinct axis.
- Removing or restoring **upstream** coworker default passthrough entries (operator-owned).
- **Blanket** removal of the `ao` passthrough family — explicitly forbidden.
- New `.github/workflows/**` files — reuse existing verify entry points.
- Token-chain ledger / cost-accounting integration.
- `agent-orchestrator.yaml` / live gitignored yaml — no AO config change.
- Orchestrator-only or per-session RTK slicing (unsupported upstream per §R.2).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
.github/workflows/**
plugins/**
tests/**
prompts/codex_review_prompt.md
```

```allowed-roots
docs/**
scripts/**
prompts/agent_rules.md
AGENTS.md
.cursor/rules/**
```

## Acceptance criteria

1. **Feasibility gate recorded.** A written finding states whether RTK can attribute
   missed savings to a caller/source. If it cannot, the inventory and plan proceed on
   command-shape × risk-tier only, and source-segmentation is explicitly marked
   best-effort; no acceptance criterion below depends on source data that does not exist.
2. **Inventory + risk tiers documented.** The repo documents a repeatable missed-savings
   inventory with the columns named in Binding surface §2 (including the
   **sensitivity/exactness override** column) and the three-tier classification with the
   command families named in §3, plus the overriding sensitivity/exactness rule. Provable
   by reading the doc.
3. **Metric stated.** The inventory/decision doc states the optimisation target as net
   saved tokens on low-risk shapes and names adoption % as a non-goal.
4. **Low-risk guidance placed correctly.** When source attribution exists, the
   read-exploration guidance exists on the surface(s) the inventory identifies, with
   #149-style pointers and no duplication. When attribution is unavailable, it exists as a
   single caller-independent canonical rule + pointers (or operator/runbook guidance) —
   the no-attribution path MUST be satisfiable, not left open. Either path provable by
   repo search for the guidance text + pointer(s).
5. **Kill-gate recorded.** The doc records the materiality bar and the go/no-go decision
   for the field-preservation harness. The no-go path closes the issue on **low-risk
   capture + guidance only** and authorizes no medium- or high-risk passthrough change;
   if no-go, criteria 6–7 are explicitly marked not-applicable and §R is unchanged beyond
   the framing amendment (criterion 8).
5a. **Medium-risk and existing-family changes gated.** The doc states medium-tier shapes
   are inventory/guidance-only, and that any change compacting/narrowing an existing §R.3
   passthrough family or a signal-bearing `gh … --json` requires the §6-class
   field-preservation gate + schema refresh + exact-pattern rollback (not the contextual
   qualifier). Provable by reading the doc.
6. **(If go) Field-preservation test enforced in CI.** A pinned-fixture test asserts the
   documented must-keep field set survives RTK JSON compaction for `ao status` /
   `ao review list` / `ao events`, is invoked from `scripts/verify.ps1` and/or
   `scripts/check-reusable.ps1`, and **fails** when a must-keep field is dropped
   (demonstrable by a deliberately mangled fixture). The doc states the CI guarantee
   covers fixture-present fields only and requires a fixture-refresh / schema-snapshot
   diff before any passthrough narrowing (AC7).
7. **(If go) Passthrough change is scoped, durable + reversible.** Any `ao` passthrough
   narrowing is expressed as a vetted raw-control set + documented JSON-safe inspection
   forms (never blanket removal), is applied through #145's **tracked manifest + helper**
   (not a local-only edit), and its **static guard** asserts broad `ao ` is no longer the
   applied family so a helper re-run cannot silently re-broaden it. Ships with the
   `coworker rtk passthrough add 'ao '` rollback.
8. **§R amended and synced.** §R records the measured/source-aware/low-risk-first
   follow-up, the field-preservation precondition for touching the `ao` passthrough, and
   (if go) that the vetted set replaces broad `ao ` in the tracked manifest; preserving
   §R.2 (host-global) and §R.3's "no upstream removal" rule; synced to #3.
9. **Upgrade-safe.** No AO core / vendor edits; no new repo secrets; coworker version and
   passthrough state stay operator-owned.

## Upgrade-safety check

- No edits under `vendor/**` or AO `packages/core/**`.
- No new `.github/workflows/**` files; verification reuses existing entry points.
- No unsupported YAML fields; no `agent-orchestrator.yaml` change.
- Field-preservation fixtures contain no secrets (scrub tokens/PII from captured `--json`).

## Verification

1. `pwsh -NoProfile -File scripts/verify.ps1` and
   `pwsh -NoProfile -File scripts/check-reusable.ps1` — green after changes.
2. Repo read confirms: feasibility finding (AC1), inventory method + risk tiers (AC2),
   stated metric (AC3), kill-gate record (AC5).
3. Repo search confirms the low-risk guidance text + #149 pointer(s) exist on exactly the
   identified surface(s) (AC4).
4. **If kill-gate = go:** mangle a copy of a pinned fixture (drop a must-keep field) and
   confirm the field-preservation test **fails**; restore and confirm it passes; confirm
   it runs from the existing verify entry point (AC6). Confirm any passthrough change is a
   vetted command set applied via the tracked manifest/helper, that the static guard
   asserts broad `ao ` is no longer applied, and that rollback is documented as the exact
   `coworker rtk passthrough add 'ao '` (trailing space — never bare `'ao'`) (AC7).
5. `00-architecture-decisions.md` shows the amended §R; #3 sync noted in the PR (AC8).
