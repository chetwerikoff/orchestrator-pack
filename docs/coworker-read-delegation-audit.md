# Coworker read-delegation stop-time audit (Issue #255)

Phase 1 enforcement for coworker read delegation: a **tolerant compliance signal** at
work-unit completion. The audit **never blocks reads**; it surfaces missed bulk reads for
review and emits metrics for a deferred Phase-2 hard-block decision.

Canonical ask thresholds live in [`AGENTS.md`](../AGENTS.md).
Implementation: [`docs/read-delegation-audit.mjs`](../docs/read-delegation-audit.mjs).
Hook entry: [`scripts/invoke-read-delegation-audit-stop.ts`](../scripts/invoke-read-delegation-audit-stop.ts).

## Contract invariants

| Invariant | Rule |
|-----------|------|
| **Both surfaces** | Runs on Claude `Stop` and Cursor `stop`; same flag verdict per equivalence class. |
| **Work unit** | One inbound user message / task delivery → bounded by the next inbound request. Reads aggregate inside the unit (anti-chunking). |
| **Triggers** | T1 **delegable** file-read floor is the single ordinary threshold in `AGENTS.md` (**more than 600 lines**). File-count does not introduce a second numeric policy trigger. Index-served in-tree source lines do not count toward T1. |
| **Tolerant signal** | Emits a compliance finding; never blocks. |
| **Not flagged** (still in denominator) | Machine-observed `coworker ask --profile code`; edit of any file in unit; excepted reason in status. |
| **Excluded from denominator** | Code-class (`--allow-code`) reads; actual review executions carrying a trusted per-work-unit marker from the tracked review wrapper; **index-served** Cursor reads of tracked first-party source-code under committed allowed roots (Issue #309). Ambient machine-global reviewer env such as `PACK_REVIEWER` / `REVIEW_COMMAND` never excludes an ordinary unit. |
| **Delegation proof** | Status text alone does **not** count — coworker invocation or coworker-log record tied to the work-unit key. |
| **Fail-open + fail-loud** | Handler errors exit 0 (no wedge) and append `audit_error` health records; degraded windows never read as zero residual. |
| **Concurrency** | Append-only JSONL metric artifact; stable `eventId` per work unit; duplicate stop events do not double-count. |

## Metric artifact

Default path: `~/.orchestrator-pack/read-delegation-audit.jsonl`

Per adoption window the summarize command reports:

- `residualNonCompliance` = flagged work units ÷ delegable trigger-firing work units
- `flaggedReadLines` — aggregate volume of flagged reads
- `indexServedExcludedLines` — non-blocking side metric for excluded index-served volume
- `denominatorCause` — closed-set cause for the window: `normal`, `no-trigger`, or `all-excluded`
- `reviewHookCaptureBranch` — standing capability loaded from the versioned capture record: `world-a-no-review-hook`, `world-b-hook-present`, or runtime `unknown` when missing/stale/malformed
- `auditErrors` / `missingWindows` — per-surface health (degraded when >0); all-excluded and unknown capability windows are also degraded/fail-loud

```bash
node docs/read-delegation-audit.mjs summarize <<'EOF'
{"artifactPath":"$HOME/.orchestrator-pack/read-delegation-audit.jsonl"}
EOF
```

## Operator adoption (post-merge)

For installations that already point both Stop/stop hooks at the deleted PowerShell wrapper (`scripts/invoke-read-delegation-audit-stop.ps1`), repoint them at `scripts/invoke-read-delegation-audit-stop.ts` at merge time (see operator action below). Machine-local hook JSON is **not** tracked; new installations should wire the TypeScript handler on both surfaces.

### 1. Resync tracked policy copies

After merge, resync machine-local mirrors of `AGENTS.md`:

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
        "command": "node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/invoke-read-delegation-audit-stop.ts"
      }
    ]
  }
}
```

Hook JSON requires absolute paths: prefix each `scripts/...` segment with your
orchestrator-pack checkout root (for example
`/home/you/orchestrator-pack/scripts/lib/Invoke-TypeScriptCli.ts` and
`/home/you/orchestrator-pack/scripts/invoke-read-delegation-audit-stop.ts`).

**Verify:** complete one fresh no-side-effect Cursor worker turn with an ordinary >600-line read; confirm
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
        "command": "node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/invoke-read-delegation-audit-stop.ts"
      }
    ]
  }
}
```

Use the same absolute-path prefix rule as Cursor for both `Invoke-TypeScriptCli.ts` and
`invoke-read-delegation-audit-stop.ts` under your checkout root.

**Verify:** same JSONL artifact append as Cursor after a fresh no-side-effect Claude session completes one ordinary >600-line work unit (`reviewerPath:false`, `inDenominator:true`).

### 4. Reload affected sessions

Start a fresh Claude/Cursor session or recycle only the affected managed session through its currently supported runtime/session mechanism so it reloads the updated tracked policy and hook wiring.

### 5. Phase-2 probe (informational)

See [`scripts/fixtures/read-delegation-audit/cursor-before-read-file-deny-probe.json`](../scripts/fixtures/read-delegation-audit/cursor-before-read-file-deny-probe.json)
for the captured `beforeReadFile` deny response shape. Phase 1 does **not** enable deny.

## Deferred: Phase 2

Pre-read hard block is **out of scope** here. A follow-up may adopt it only when Phase-1
metrics show residual non-compliance above a data-gated bar **and** deny is confirmed on the
target surface.
