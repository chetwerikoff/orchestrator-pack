# Worker `ao acknowledge` pickup contract in agent rules

GitHub Issue: #88

## Prerequisite

- `docs/issues_drafts/25-worker-spawn-launch-safety.md` (GitHub #63) — closed; documents Windows launch failures where the worker never reaches a healthy session. This issue covers the **opposite** path: launch succeeds but AO marks the session `stuck` with `no_acknowledge` because the agent never ran pickup.
- `docs/issues_drafts/15-orchestrator-recovery-runbook.md` (GitHub #40) — operator recovery when orchestrator/worker sessions are `stuck` / `probe_failure`; no change to runbook scope here beyond what the new rules prevent.

## Goal

Every Cursor worker under AO must run `ao acknowledge` within one minute of session start, before other implementation work, so `reportWatcher` does not classify the session as `no_acknowledge` → `stuck` while the process is still alive.

## Binding surface

- Universal worker rules in `prompts/agent_rules.md` (and, if still used for Windows argv limits, a consistent pickup line in `prompts/agent_rules_spawn_stub.md`) state the **mandatory first action** after reading the initial prompt.
- Rules are explicit that skipping acknowledge blocks the orchestrator review loop and triggers recovery/kill per the recovery runbook.
- No change to AO core, vendor packages, or `agent-orchestrator.yaml` schema.

## Files in scope

- `prompts/agent_rules.md`
- `prompts/agent_rules_spawn_stub.md` (if the stub remains the spawn-time rules entry on Windows)

## Files out of scope

- `vendor/**`, `packages/core/**`
- AO / Cursor plugin launch mechanics (upstream)
- `agent-orchestrator.yaml` (local operator config)
- Orchestrator rules text beyond a cross-reference if needed for triage

```denylist
vendor/**
packages/core/**
packages/**
.github/workflows/**
scripts/**
plugins/**
```

```allowed-roots
prompts/**
```

## Acceptance criteria

1. `prompts/agent_rules.md` contains a **First action (AO pickup)** section visible near the top of worker-facing instructions that requires `ao acknowledge` in the worktree **before** `ao-declare`, edits, or PR work.
2. The section states a **time bound** (≤ 60 seconds from session start) and names the AO symptom when skipped (`no_acknowledge`, session `stuck`).
3. If `agent_rules_spawn_stub.md` is still referenced for spawn, it repeats the same first-action requirement (stub may defer full rules to the worktree file **after** acknowledge).
4. A reader can verify the contract without running AO: `Select-String -Pattern 'acknowledge' prompts/agent_rules.md` shows the pickup section; same for the stub when present.
5. `.\scripts\verify.ps1` passes after the change.

## Upgrade-safety check

- Pack-only prompt text; no AO core or vendor edits.
- No new secrets or workflow triggers.
- Preserves planner freedom for all implementation beyond the pickup command sequence.

## Verification

```powershell
Select-String -Pattern 'acknowledge|First action' prompts/agent_rules.md
if (Test-Path prompts/agent_rules_spawn_stub.md) {
  Select-String -Pattern 'acknowledge' prompts/agent_rules_spawn_stub.md
}
.\scripts\verify.ps1
```

Manual (optional, Windows): after merge, spawn a worker on a small open issue; within 2 minutes `ao status` shows acknowledge/report activity and the session is not `stuck` with `no_acknowledge`.
