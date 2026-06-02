---
name: switch-pack-reviewer
description: >-
  Switch local pack PR reviewer between Codex and Claude via PACK_REVIEWER.
  Use when the user asks to switch reviewer, set codex/claude for review,
  fix wrong reviewer running, or avoid Process overriding User env — e.g.
  «переключи ревьюера», «поставь codex», «используется claude вместо codex»,
  «PACK_REVIEWER», «switch reviewer», «reviewer codex/claude».
  Runs checklist, applies User scope, clears Process override, restarts AO,
  and verifies effective reviewer with show-pack-reviewer-status.ps1.
---

# Switch pack reviewer (PACK_REVIEWER)

Operator workflow for **local** AO pack review (`invoke-pack-review.ps1`).  
**REVIEW_COMMAND in YAML does not change** when switching — only `PACK_REVIEWER`.

Canonical docs: [`docs/reviewer-switch-runbook.md`](../../../docs/reviewer-switch-runbook.md).

## Triggers

- User names target: **codex** or **claude**
- User reports mismatch: global User is one value, reviews use another
- User asks to «переключить ревьюера», «поставь codex/claude», «fix PACK_REVIEWER»

**Skip** when the ask is only architectural (issue draft) with no machine change.

## Core rule (tell the user if confused)

- **User** = permanent operator choice (Windows «переменные среды» пользователя).
- **Process** = sticker on this terminal/session; **wins over User** while set.
- **Do not** copy User → Process on every boot — clear Process instead.
- **Do not** set `$env:PACK_REVIEWER` in profiles/IDE unless intentional one-shot override.

## Checklist — apply switch

Target reviewer: `codex` or `claude` (from user message; if unclear, ask once).

### 1. Record baseline

From pack repo root:

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
```

Note Process / User / Machine and **Effective**. If Process differs from User, warn before proceeding.

### 2. Apply (preferred — one command)

```powershell
pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 -Reviewer <codex|claude> -RestartAo
```

This script:

- Sets **User** `PACK_REVIEWER` via `[Environment]::SetEnvironmentVariable(..., 'User')`
- Clears **Process** in the current session (`Remove-Item Env:PACK_REVIEWER`)
- Restarts AO (`ao stop` → `ao start orchestrator-pack`) when `-RestartAo` is passed

**Manual equivalent** (only if scripts unavailable):

```powershell
[Environment]::SetEnvironmentVariable('PACK_REVIEWER', '<codex|claude>', 'User')
Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue
ao stop
ao start orchestrator-pack
```

### 3. Session hygiene (prevent recurrence)

- Do **not** leave `$env:PACK_REVIEWER = 'claude'` after a Codex quota workaround — remove when done.
- Do **not** add `PACK_REVIEWER` to PowerShell profile, Cursor `terminal.integrated.env`, or project `.env`.
- Tell the user to **close and reopen** other IDE terminals still open from before the switch (they keep old Process env until closed).

### 4. Verify effective reviewer (required)

`set-pack-reviewer.ps1` verifies in a child `pwsh` with process scope cleared (Cursor/agent parents often inject `PACK_REVIEWER`).

Standalone check:

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1 -Expected <codex|claude>
```

The status script clears process scope before resolving so **User** wins when global is set.

**PASS** = exit code 0, line `Effective` matches target, no override warning.

If FAIL:

| Symptom | Fix |
|---------|-----|
| Process still set to other value | `Remove-Item Env:PACK_REVIEWER`; re-run status |
| Effective unset | Set User again; new shell from `set-pack-reviewer.ps1` |
| User wrong | Re-run `set-pack-reviewer.ps1` |

### 5. Verify AO path (when `ao` on PATH)

After `-RestartAo`, optional smoke:

```powershell
ao review list orchestrator-pack --json
```

On next review failure, `terminationReason` should name:

| Target | Wrapper in terminationReason |
|--------|------------------------------|
| codex | `run-pack-review.ps1` |
| claude | `run-pack-review-claude.ps1` |

Strict gate (optional):

```powershell
pwsh -NoProfile -File scripts/orchestrator-diagnose.ps1 -Strict
```

### 6. Report to user

Include:

- Table: Process / User / Machine / **Effective**
- Whether AO was restarted
- PASS or FAIL from step 4
- Reminder: other open terminals may still override until reopened

## Quick reference

| Goal | Command |
|------|---------|
| Status only | `pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1` |
| Switch + verify + restart AO | `pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 -Reviewer codex -RestartAo` |
| Clear session override only | `Remove-Item Env:PACK_REVIEWER` then status script |

## Related

- [`docs/reviewer-switch-runbook.md`](../../../docs/reviewer-switch-runbook.md)
- [`scripts/lib/Resolve-PackReviewer.ps1`](../../../scripts/lib/Resolve-PackReviewer.ps1)
