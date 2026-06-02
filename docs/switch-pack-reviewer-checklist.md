# Switch pack reviewer (PACK_REVIEWER) — operator checklist

Agent-readable checklist (same workflow as `.claude/skills/switch-pack-reviewer/SKILL.md`).

Operator workflow for **local** AO pack review (`invoke-pack-review.ps1`).  
**REVIEW_COMMAND in YAML does not change** when switching — only `PACK_REVIEWER`.

Canonical runbook: [`reviewer-switch-runbook.md`](reviewer-switch-runbook.md).

## Core rule

- **User** = permanent operator choice (Windows user environment variables).
- **Process** = this terminal/session only; **wins over User** while set.
- **Do not** copy User → Process on every boot — clear Process instead.
- **Do not** set `$env:PACK_REVIEWER` in profiles/IDE unless intentional one-shot override.

## Checklist — apply switch

Target reviewer: `codex` or `claude`.

### 1. Record baseline

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
```

If Process differs from User, warn before proceeding.

### 2. Apply (preferred)

```powershell
pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 -Reviewer <codex|claude> -RestartAo
```

### 3. Session hygiene

- Remove temporary `$env:PACK_REVIEWER` after Codex quota workarounds.
- Do not add `PACK_REVIEWER` to PowerShell profile or IDE `terminal.integrated.env`.
- Close and reopen other IDE terminals opened before the switch.

### 4. Verify (required)

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1 -Expected <codex|claude>
```

**PASS** = exit code 0 and **Effective** matches target.

### 5. Optional AO smoke

```powershell
ao review list orchestrator-pack --json
pwsh -NoProfile -File scripts/orchestrator-diagnose.ps1 -Strict
```

On review failure, `terminationReason` should name `run-pack-review.ps1` (codex) or `run-pack-review-claude.ps1` (claude).
