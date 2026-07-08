# RTK missed-savings inventory and kill-gate (Issue #199)

Measured, risk-aware follow-up to [#145](https://github.com/chetwerikoff/orchestrator-pack/issues/145) /
architecture [§R](issues_drafts/00-architecture-decisions.md#r-coworker-rtk-passthrough-first-adoption-on-worker-hosts-issue-145).
This document is the **repeatable inventory method**, feasibility finding, risk-tier contract,
kill-gate record, and medium/high-risk gating policy. Operator numbers are **machine-local**;
the repo ships the method, not your host's counts.

**Cross-links:** [coworker RTK runbook](coworker-rtk-runbook.md) · regeneration helper
[`scripts/invoke-rtk-discover-inventory.ps1`](../scripts/invoke-rtk-discover-inventory.ps1)

## Optimisation target (non-goal)

- **Target:** net saved tokens on **low-risk** command shapes (reads and ordinary exploration
  where exact bytes are not decision-bearing).
- **Non-goal:** raising RTK adoption percentage. Adoption is a proxy; this issue optimises
  quantified missed savings by shape and risk tier.

## 1. Source-attribution feasibility (AC1)

**Finding:** `rtk discover` (upstream RTK binary; not exposed via `coworker rtk`) can list
missed savings by **command shape** (`supported` / `unsupported` buckets with counts and, for
supported shapes, `estimated_savings_tokens`). Its JSON schema has **no caller/source
dimension** — no field for orchestrator vs AO Cursor worker vs interactive Claude vs
interactive Cursor vs ad-hoc shell. Session files are scanned in aggregate; attribution would
require upstream RTK or host-global hook metadata that does not exist today.

**Degradation:** inventory and decisions proceed on **command-shape × risk-tier** only.
Source-segmentation is **best-effort / unavailable**. No acceptance criterion below depends
on source data.

**How we verified:** `rtk discover --format json` on a host with session history — output
fields are `sessions_scanned`, `total_commands`, `supported[]`, `unsupported[]`,
`agent_status`; no `caller`, `source`, or `session_role` keys. Re-verify after RTK upgrades
with `rtk discover --help` and a sample JSON dump.

## 2. Regenerating the inventory (AC2)

### Prerequisites

- `rtk` on `PATH` (install per [coworker RTK runbook](coworker-rtk-runbook.md)).
- Claude Code / Cursor session history on the operator host (discover reads local session
  stores; an empty host returns zero rows — that is valid, not a script failure).

### Command

```bash
# From pack repo root — default: current project, last 30 days
pwsh -NoProfile -File scripts/invoke-rtk-discover-inventory.ps1

# Broader scan (example from implementation host)
pwsh -NoProfile -File scripts/invoke-rtk-discover-inventory.ps1 -AllProjects -SinceDays 90 -Limit 100

# Optional JSON artifact for diffing over time
pwsh -NoProfile -File scripts/invoke-rtk-discover-inventory.ps1 -OutputJson /tmp/rtk-inventory.json
```

The helper:

1. Runs `rtk discover --format json`.
2. Loads pack + upstream passthrough patterns from tracked manifests.
3. Emits a markdown table with the columns below.
4. Computes the kill-gate assessment (§5).

### Required columns

| Column | Meaning |
|--------|---------|
| **Command shape** | Normalized shape from discover (`command` or `base_command`). |
| **Occurrence count** | Invocation count in the scan window. |
| **Estimated missed tokens** | From discover `estimated_savings_tokens` when present; `—` for unsupported shapes. |
| **Passthrough match** | `yes` + matching pattern, or `no` — substring match against pack + upstream manifests. |
| **Risk tier** | `low` \| `medium` \| `high` \| `unknown` (§3). |
| **Sensitivity/exactness override** | `yes` when output may carry secrets, credentials, declaration/scope file contents, or exact-byte decision-bearing config (§3). |
| **Recommended action** | Guidance-only, low-risk capture candidate, permanently-raw, or §6-gated (see tier rules). |
| **Field-preservation test required?** | `yes` only when compacting/narrowing an existing §R.3 family or signal-bearing `gh … --json` would be proposed. |

**Source/caller column:** omitted — attribution unavailable (§1).

## 3. Risk-tier contract (AC2, AC5a)

### Tier families

| Tier | Command families (non-exhaustive; classify by prefix/shape) |
|------|-------------------------------------------------------------|
| **low** | `grep`, `find`, `cat`/file reads, `ls`, `wc`, `head`, `tree`, ordinary read-only exploration where exact bytes are not decision-bearing. |
| **medium** | `gh pr` / `gh issue … --json`, `git branch`, `git log` when not scope/review critical. |
| **high** | `ao status` / `ao review list` / `ao events` / `ao report` / `ao send` / `ao spawn` / `ao review send` / `ao-declare`, any other `ao …`, `git diff`, `gh pr checks`, scope/CI/review/declaration signal. |

Classification logic: [`scripts/lib/Get-RtkMissedSavingsInventory.ps1`](../scripts/lib/Get-RtkMissedSavingsInventory.ps1).

### Sensitivity/exactness override (trumps tier)

Output that may carry **secrets/credentials** (`.env`, key/token files, generated auth output),
**private logs**, raw **declaration/scope file contents**, or **exact-byte** config/schema
content where precise bytes are decision-bearing is **permanently no-compact** regardless of
command family — not unlockable by §6. A `cat`/`grep`/`find` of such a target is never `low`.

### Permanently-raw vs §6-unlockable (high tier boundary)

| Class | Examples | Compaction |
|-------|----------|------------|
| **Permanently raw** | Sensitivity override targets; `ao report` / `ao send` / `ao spawn` / `ao review send` / `ao-declare`; `git diff`; `gh pr checks` | Never compacted |
| **§6-unlockable only** | Structured read-only `ao … --json` inspection (`ao status`, `ao review list`, `ao events`) | Compacted only after pinned field-preservation test + schema-refresh gate passes |

**Low** shapes may be compacted freely **only after** the sensitivity override clears the shape.

### Medium-risk and existing §R.3 families (AC5a)

- **Medium-tier** shapes (`gh pr/issue … --json`, `git branch`, `git log`) are **inventory +
  guidance only** in this issue — they authorize **no** passthrough/compaction change on their
  own. The qualifier "when not scope/review critical" is **not** enforceable under host-global
  substring matching.
- Any change that would **compact or narrow an existing §R.3 passthrough family** (`git diff`,
  `git log`, `gh pr checks`, the `ao ` family, `ao-declare`) or any **signal-bearing
  `gh … --json`** requires the **same §6-class field-preservation gate + schema refresh +
  exact-pattern rollback** as the `ao` path — never the contextual qualifier alone.
- Only **low-risk shapes not already in §R.3 passthrough** that have cleared the sensitivity
  override may be compacted without that gate.

## 4. Sample inventory excerpt (implementation host, illustrative)

Generated with `-AllProjects -SinceDays 90` during #199 implementation. **Re-run on your
host** — numbers will differ.

| Command shape | Count | Est. missed tokens | Passthrough | Risk | Sensitivity | Recommended action |
|---------------|------:|-------------------:|:------------|:-----|:------------|:-------------------|
| `grep -n` | 159 | 47,029 | no | low | no | low-risk capture candidate |
| `ls -la` | 134 | 31,858 | no | low | no | low-risk capture candidate |
| `head -20` | 79 | 26,332 | no | low | no | low-risk capture candidate |
| `git log` | 105 | 11,563 | yes (`git log`) | medium | no | inventory + guidance only |
| `gh pr` | 86 | 22,478 | yes (`gh pr`) | medium | no | inventory + guidance only |
| `ao review` | 18 | — | yes (`ao `) | high | no | permanently-raw or §6-gated JSON only |
| `ao events` | 16 | — | yes (`ao `) | high | no | permanently-raw or §6-gated JSON only |
| `ao status` | 15 | — | yes (`ao `) | high | no | permanently-raw or §6-gated JSON only |

Low-risk quantified opportunity dominates supported discover rows; high-risk `ao` shapes appear
in the **unsupported** bucket (no RTK wrapper exists for `ao` — they are passthrough-protected
by design).

## 5. Kill-gate (AC5)

### Materiality bar

Build the §6 field-preservation harness **only if** the measured opportunity for **high-risk
`ao`/inspection families** is **≥ 15%** of:

> (sum of `estimated_savings_tokens` for **low-risk** supported shapes) +
> (high-risk `ao` invocation count × **250** conservative tokens saved per invocation)

The per-invocation constant is intentionally conservative: `rtk discover` does not estimate
token savings for unsupported `ao` shapes; 250 tokens reflects partial JSON compaction
headroom, not full stdout replacement. Operators may re-run the helper after narrowing the
constant with local byte-count probes — the **15% bar** stays fixed.

### Recorded decision (this merge)

| Input | Value |
|-------|-------|
| Low-risk quantified missed tokens | 123,819 |
| High-risk `ao` invocations | 70 |
| High-risk `ao` estimated missed tokens (70 × 250) | 17,500 |
| High-risk share | **12.4%** |
| **Decision** | **no-go** |

**Outcome:**

- §6 field-preservation harness: **not built** (AC6 **not applicable**).
- §7 `ao ` passthrough narrowing: **not applied** (AC7 **not applicable**); broad `ao `
  remains in [`scripts/rtk-passthrough-pack.manifest.json`](../scripts/rtk-passthrough-pack.manifest.json).
- Issue closes on **low-risk capture + guidance** (§4 of issue #199).
- §R amended with follow-up framing and field-preservation **precondition** only (§R.7).

Re-open the kill-gate when operator inventory regeneration shows high-risk share ≥ 15%.

## 6. Field-preservation test (AC6 — not applicable)

**Status:** not applicable — kill-gate **no-go** (§5).

If a future operator regeneration yields **go**, the harness MUST:

- Use pinned fixtures (scrubbed `ao status` / `ao review list` / `ao events --json` samples).
- Assert RTK JSON compaction preserves the documented must-keep field set (run id, linked
  session id, PR number, status/state, finding counts including open/sent, `terminationReason`,
  lifecycle & runtime state, CI status, review state, event id/timestamp/type/error fields).
- Wire into `scripts/verify.ps1` and/or `scripts/check-reusable.ps1` — no new workflow file.
- CI guarantee covers **fixture-present fields only**; passthrough narrowing additionally
  requires fixture-refresh / schema-snapshot diff on coworker/AO upgrades.

## 7. `ao` passthrough narrowing (AC7 — not applicable)

**Status:** not applicable — kill-gate **no-go** (§5).

If a future **go** decision lands after §6 is green:

- Narrow only to a **vetted raw-control set + documented JSON-safe inspection forms** — never
  blanket `ao` removal.
- Apply via tracked manifest + [`scripts/apply-coworker-rtk-passthrough.ps1`](../scripts/apply-coworker-rtk-passthrough.ps1);
  static guard must assert broad `ao ` is **no longer** the applied family.
- Rollback: `coworker rtk passthrough add 'ao '` (trailing space — never bare `'ao'`);
  emergency: `coworker rtk disable`.

## 8. Low-risk guidance (AC4)

Source attribution is unavailable (§1). Guidance is a **single caller-independent canonical
rule** in [`AGENTS.md`](../AGENTS.md) (**RTK read-exploration**)
with #149-style thin pointers from `AGENTS.md` and `.cursor/rules/`.

**Rule (summary):** for read-only file exploration, prefer the agent's dedicated file tools
(`Read`, `Grep`, `Glob`); reach for RTK shell wrappers only for raw shell that is genuinely
needed. Chasing RTK adoption % is explicitly out of scope.

## Operator adoption (post-merge #199)

1. Regenerate this inventory on the operator host (§2) and archive the markdown/JSON if useful.
2. No passthrough or enablement change is required for the **no-go** path.
3. Workers load updated read-exploration guidance via `agentRulesFile` after `ao stop` /
   `ao start` when `AGENTS.md` changed.

See also [migration_notes.md](migration_notes.md) (RTK net-savings #199).
