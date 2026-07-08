# Coworker RTK for AO Cursor workers (opt-in)

Operator runbook for adapting the optional [coworker RTK](https://github.com/Arcanada-one/coworker/blob/main/docs/rtk-plugin.md)
plugin on **Linux / WSL2 worker hosts** running Cursor CLI under Agent Orchestrator.
RTK compacts noisy shell output via Cursor `beforeShellExecution` hooks; this pack extends
the passthrough allowlist so **signal-bearing** git, gh, ao, and declaration output stays
verbatim for review and CI triage.

**Prerequisites:** [Ubuntu setup runbook](ubuntu-setup-runbook.md) (ext4 paths, pwsh 7+,
Cursor CLI). Worker pickup contract: [`docs/issues_drafts/32-worker-acknowledge-pickup-contract.md`](issues_drafts/32-worker-acknowledge-pickup-contract.md).

**Architecture:** decision [§R](issues_drafts/00-architecture-decisions.md#r-coworker-rtk-passthrough-first-adoption-on-worker-hosts-issue-145)
(includes measured net-savings follow-up §R.7 per
[#199](https://github.com/chetwerikoff/orchestrator-pack/issues/199)).

## Scope and limitations

| Topic | Policy |
|-------|--------|
| **Opt-in** | RTK stays off until the operator completes the adoption checklist on that host. |
| **Host-global hook** | `coworker rtk enable` writes `~/.cursor/hooks.json` — **all** cursor-agent sessions on the machine (orchestrator, workers, ad-hoc CLI). Per-worker or per-tmux-pane RTK toggling is **not supported** upstream. |
| **Workers first** | Initial trial targets AO worker hosts (`defaults.worker.agent: cursor`). Orchestrator-only RTK is out of scope unless workers show net benefit and the operator opts in separately. |
| **Dedicated host** | When available, run the first trial on a **dedicated or idle worker host**. Side-by-side RTK on/off on one host is impossible. Single-host operators enable all-or-nothing and rely on the observation window + immediate disable if regressions appear. |
| **Not in CI** | Hook smoke and the 7-day observation window are **operator-only**; they do not block PR merge. |

## Passthrough: upstream defaults + pack families

Coworker ships **13** upstream default passthrough patterns (substring match on the shell
command). The operator’s installed coworker version owns those defaults — the pack **does not**
re-apply or restore them.

This pack adds **five pattern families** (additive only):

| Family | Manifest pattern(s) | Why |
|--------|----------------------|-----|
| `git diff` | `git diff` | Diff hunks must not be RTK-summarized during review/CI triage. |
| `git log` | `git log` | History context for declaration / scope reasoning. |
| `gh pr checks` | `gh pr checks` | Required-CI discipline in worker rules. |
| `ao *` | `ao ` | All `ao` subcommands (`status`, `review`, `spawn`, `report`, `send`, …). |
| `ao-declare` | `ao-declare`, `npx ao-declare` | Direct executable and `npx ao-declare --issue … --declared-paths …`. |

Tracked manifests:

- Pack (applied by helper): [`scripts/rtk-passthrough-pack.manifest.json`](../scripts/rtk-passthrough-pack.manifest.json)
- Upstream snapshot (validation only): [`scripts/rtk-passthrough-upstream-defaults.manifest.json`](../scripts/rtk-passthrough-upstream-defaults.manifest.json)

### Apply pack patterns (before enable)

```bash
# From pack repo root — requires coworker on PATH, after `coworker rtk install` only
pwsh -NoProfile -File scripts/apply-coworker-rtk-passthrough.ps1

# Merge preview (CI-safe; no coworker required)
pwsh -NoProfile -File scripts/apply-coworker-rtk-passthrough.ps1 -WhatIf
```

**Pass criterion (effective config):** every pack manifest pattern appears in:

```bash
coworker rtk passthrough list
```

Optional upstream drift log (informational — does **not** block enable):

```bash
pwsh -NoProfile -File scripts/apply-coworker-rtk-passthrough.ps1 -CompareUpstream
```

Compare output to the upstream-default manifest; record missing/changed upstream entries for awareness. Coworker version drift does not block step 4 below.

## Operator adoption (post-merge)

RTK is **not** enabled automatically when this PR merges.

1. **Baseline (observation log)** — Note recent worker PRs/tasks (how many / which window) and qualitative signals **before** RTK: Codex review findings, CI failures, iteration churn.
2. **Install coworker** per [upstream docs](https://github.com/Arcanada-one/coworker); run `coworker rtk install` only — **do not** `coworker rtk enable` yet.
3. **Apply pack passthrough** with the helper (above). Verify all pack families in `coworker rtk passthrough list`. Log upstream-default drift if any (informational).
4. **`coworker rtk enable`** — only after step 3 passes.
5. **Hook smoke** (below) — effective-config gate before production observation.
6. **Observation window** — workers run normal tasks for **7 calendar days** (adjust with one-line rationale if needed). Record post-enable notes on the same three signals. Conclusion: `continue` | `extend` | `disable`.
7. **Rollback if needed** — `coworker rtk disable` (see Rollback). Do **not** hand-edit `hooks.json` for routine disable.

## Hook smoke (effective-config gate)

Run on a host with `coworker rtk enable` and Cursor `beforeShellExecution` active.
Each sample must show documented **expected substrings in raw output** — no RTK compaction
markers, no truncated diff hunks, no missing snapshot fields.

| Family | Sample command | Expected substrings (examples) |
|--------|----------------|--------------------------------|
| `git diff` | `git diff` against a **known dirty/staged** file in a throwaway clone | Documented hunk lines (`+`/`-`/`@@`) from that file |
| `git log` | `git log -n 3 --oneline` on a repo with known commits | Documented subject and short hash |
| `gh pr checks` | `gh pr checks <known-open-pr>` | Documented check names / status fields |
| `ao *` | `ao status` in a running AO project | Documented status fields (project, session state) |
| `ao-declare` | `ao-declare --issue N --declared-paths 'docs/foo.md'` in a **disposable** temp clone | `declared_paths`, issue id — not denylist hash text |
| `npx ao-declare` | `npx ao-declare --issue N --declared-paths 'docs/foo.md'` in the same disposable target | Same observable snapshot fields |

Use an **isolated disposable target** (temp clone or reset per runbook) for declaration smokes so you do not mutate pack `.ao/declarations/**` or live project state.

### Negative control (mandatory for `git diff`)

1. Remove the `git diff` family: `coworker rtk passthrough remove 'git diff'`
2. Re-run the same `git diff` sample — confirm observable compaction/truncation vs the passthrough-enabled run.
3. **Restore** via `pwsh -NoProfile -File scripts/apply-coworker-rtk-passthrough.ps1`, re-verify `coworker rtk passthrough list`, and confirm positive `git diff` smoke passes before production observation.

Negative control is **not required** for `ao *` / `ao-declare` — positive smoke is sufficient.

**Optional:** read-heavy negative control (`grep` / `cat` / `ls`) if your RTK version compacts them — confirms the hook is active, not only list bookkeeping.

## Production observation (operator-only)

**What this is:** enable with passthrough → observe real worker outcomes → rollback by command if needed.

**What this is not:** shell-output capture harnesses, truncation rubrics, `rtk proxy` fixtures,
provenance sidecars, or mechanical scorers — those measure proxy fidelity, not whether workers
ship worse PRs.

### Procedure

1. Apply pack passthrough + list verify **before** `coworker rtk enable` (above).
2. `coworker rtk enable` → hook smoke.
3. Log enable date + `coworker --version`.
4. Workers run normal tasks **7 calendar days**.
5. Compare before/after **qualitative notes** on:
   - Codex review findings (severity / recurrence)
   - CI failures (new classes vs noise)
   - Iteration churn (round-trips to green / review)
6. Conclusion: **`continue`** | **`extend`** | **`disable`** (`coworker rtk disable`).

Observation gates **sustained RTK on the host**, not worker PR acceptance. Worse or ambiguous → extend or disable.

### Observation log template

```text
Host:
Coworker version:
RTK enable date:
Baseline window (PRs/tasks): 
Baseline — Codex:
Baseline — CI:
Baseline — churn:

Post-enable — Codex:
Post-enable — CI:
Post-enable — churn:

Conclusion (continue | extend | disable):
Notes:
```

## Rollback

**Primary rollback** for all Cursor sessions on the host:

```bash
coworker rtk disable
```

This removes/restores coworker-managed hook entries. Operators **must not** hand-edit
`~/.cursor/hooks.json` for routine rollback.

**Diagnosis only** (not primary rollback): upstream documents per-command escape hatches such as
`RTK_DISABLED=1` and `rtk proxy …` — use for triage, not as the default disable path.

## Static verification (CI)

On every clean checkout (no coworker required):

```bash
pwsh -NoProfile -File scripts/check-rtk-passthrough-static.ps1
```

Also invoked from `scripts/verify.ps1`. The guard asserts the **canonical five-family checklist**
(including both `ao-declare` forms) and that the helper **merge preview** would apply every pack
pattern additively.

## Missed-savings inventory (Issue #199)

Token-savings opportunity is measured with `rtk discover`, not adoption %. Regenerate the
inventory on the operator host (machine-local numbers):

```bash
pwsh -NoProfile -File scripts/invoke-rtk-discover-inventory.ps1
pwsh -NoProfile -File scripts/invoke-rtk-discover-inventory.ps1 -AllProjects -SinceDays 90
```

Full method, risk tiers, kill-gate record, and medium/high-risk gating:
[`docs/rtk-missed-savings-inventory.md`](rtk-missed-savings-inventory.md).

Current kill-gate: **no-go** for field-preservation harness and `ao ` passthrough narrowing —
low-risk guidance + inventory only. Re-evaluate when regeneration shows high-risk `ao` share
≥ 15% per the inventory doc.

Worker read-exploration guidance (prefer file tools for reads): **RTK read-exploration** in
[`AGENTS.md`](../AGENTS.md).

## Related docs

- [RTK missed-savings inventory](rtk-missed-savings-inventory.md)
- [Ubuntu / WSL2 setup](ubuntu-setup-runbook.md)
- [Coworker CLI delegation](../AGENTS.md) (separate from RTK)
- Upstream RTK plugin: https://github.com/Arcanada-one/coworker/blob/main/docs/rtk-plugin.md
