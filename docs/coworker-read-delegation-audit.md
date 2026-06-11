# Coworker read-delegation stop-time audit (Issue #255)

Phase 1 enforcement for coworker read delegation: a **tolerant compliance signal** at
work-unit completion. The audit **never blocks reads**; it surfaces missed bulk reads for
review and emits metrics for a deferred Phase-2 hard-block decision.

Canonical ask thresholds live in [`prompts/agent_rules.md`](../prompts/agent_rules.md).
Implementation: [`docs/read-delegation-audit.mjs`](../docs/read-delegation-audit.mjs).
Hook entry: [`scripts/invoke-read-delegation-audit-stop.ps1`](../scripts/invoke-read-delegation-audit-stop.ps1).

## Contract invariants

| Invariant | Rule |
|-----------|------|
| **Both surfaces** | Runs on Claude `Stop` and Cursor `stop`; same flag verdict per equivalence class. |
| **Work unit** | One inbound user message / AO task delivery → bounded by the next inbound request. Reads aggregate inside the unit (anti-chunking). |
| **Triggers** | T1 file-read floor **>400 lines**; diff/log **>200 lines** (independent of T1). File-count fires only with **≥400 combined lines** (folded T2). |
| **Tolerant signal** | Emits a compliance finding; never blocks. |
| **Not flagged** (still in denominator) | Machine-observed `coworker ask --profile code`; edit of any file in unit; excepted reason in status. |
| **Excluded from denominator** | Code-class (`--allow-code`) reads; actual review executions carrying a trusted per-work-unit marker from the tracked review wrapper. Ambient machine-global reviewer env such as `PACK_REVIEWER` / `REVIEW_COMMAND` never excludes an ordinary unit. |
| **Delegation proof** | Status text alone does **not** count — coworker invocation or coworker-log record tied to the work-unit key. |
| **Fail-open + fail-loud** | Handler errors exit 0 (no wedge) and append `audit_error` health records; degraded windows never read as zero residual. |
| **Concurrency** | Append-only JSONL metric artifact; stable `eventId` per work unit; duplicate stop events do not double-count. |

## Metric artifact

Default path: `~/.orchestrator-pack/read-delegation-audit.jsonl`

Per adoption window the summarize command reports:

- `residualNonCompliance` = flagged work units ÷ delegable trigger-firing work units
- `flaggedReadLines` — aggregate volume of flagged reads
- `denominatorCause` — closed-set cause for the window: `normal`, `no-trigger`, or `all-excluded`
- `reviewHookCaptureBranch` — standing capability loaded from the versioned capture record: `world-a-no-review-hook`, `world-b-hook-present`, or runtime `unknown` when missing/stale/malformed
- `auditErrors` / `missingWindows` — per-surface health (degraded when >0); all-excluded and unknown capability windows are also degraded/fail-loud

```bash
node docs/read-delegation-audit.mjs summarize <<'EOF'
{"artifactPath":"$HOME/.orchestrator-pack/read-delegation-audit.jsonl"}
EOF
```

## Operator adoption (post-merge)

For installations that already point both Stop/stop hooks at `scripts/invoke-read-delegation-audit-stop.ps1`, no hook JSON wiring change is required for #264. Machine-local hook JSON is **not** tracked; new installations should wire the same handler on both surfaces.

### 1. Resync tracked policy copies

After merge, resync machine-local mirrors of `prompts/agent_rules.md`:

- `~/agent-rules/coworker-policy.md`
- generated `~/.codex/AGENTS.md`
- `~/.cursor-global` symlink target

Use your existing sync step (outside this repo).

### 2. Cursor `~/.cursor/hooks.json`

Add a `stop` entry alongside existing hooks (e.g. RTK `beforeShellExecution`):

```json
{
  "version": 1,
  "hooks": {
    "stop": [
      {
        "command": "pwsh -NoProfile -ExecutionPolicy Bypass -File /ABS/PATH/TO/orchestrator-pack/scripts/invoke-read-delegation-audit-stop.ps1"
      }
    ]
  }
}
```

Replace `/ABS/PATH/TO/orchestrator-pack` with your checkout path.

**Verify:** complete one fresh no-side-effect Cursor worker turn with an ordinary >400-line read; confirm
`~/.orchestrator-pack/read-delegation-audit.jsonl` gains a `work_unit_verdict` line with `reviewerPath:false` and `inDenominator:true`. The stop
hook passes `transcript_path` in its stdin JSON; the handler derives reads/edits/shell events
from that transcript when `workUnits` / `events` are not pre-populated.

### 3. Claude `.claude/settings.json`

Add a `Stop` hook (file is gitignored — operator-local only):

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "pwsh -NoProfile -ExecutionPolicy Bypass -File /ABS/PATH/TO/orchestrator-pack/scripts/invoke-read-delegation-audit-stop.ps1"
      }
    ]
  }
}
```

**Verify:** same JSONL artifact append as Cursor after a fresh no-side-effect Claude session completes one ordinary >400-line work unit (`reviewerPath:false`, `inDenominator:true`).

### 4. Restart AO

`ao stop` then `ao start` so workers load recalibrated thresholds from `agentRulesFile`.

### 5. Phase-2 probe (informational)

See [`scripts/fixtures/read-delegation-audit/cursor-before-read-file-deny-probe.json`](../scripts/fixtures/read-delegation-audit/cursor-before-read-file-deny-probe.json)
for the captured `beforeReadFile` deny response shape. Phase 1 does **not** enable deny.

## Deferred: Phase 2

Pre-read hard block is **out of scope** here. A follow-up may adopt it only when Phase-1
metrics show residual non-compliance above a data-gated bar **and** deny is confirmed on the
target surface.
