---
name: switch-pack-reviewer
description: >-
  Switch the pack PR reviewer between GPT, Codex, and Claude and persist the
  choice for future review invocations. Use when the user asks to switch the
  reviewer, set gpt/codex/claude, fix a reviewer mismatch, or inspect the
  saved reviewer preference.
---

# Switch pack reviewer

This skill changes the pack-owned reviewer preference. It does not start,
stop, reload, or inspect an agent runtime. The review runner reads the saved
choice when the next review invocation starts, so the procedure is portable
across runtime modules.

## Reviewer authority

The canonical precedence is:

1. `PACK_REVIEW_BOUND_REVIEWER` — an explicit reviewer bound to one invocation.
2. The persistent user preference.
3. Legacy `PACK_REVIEWER` — compatibility fallback only when no preference is saved.

The persistent preference is stored at:

```text
$XDG_CONFIG_HOME/orchestrator-pack/reviewer.json
```

When `XDG_CONFIG_HOME` is unset, the store uses the platform user config
location, normally `$HOME/.config/orchestrator-pack/reviewer.json`.
The file is pack-owned, user-scoped, atomically replaced, and contains only
the schema and selected reviewer.

An invalid saved file fails closed. It must be repaired with this skill; an
ambient environment value must not silently select a different reviewer.

## Triggers

- The user names `gpt`, `codex`, or `claude`.
- The user reports that the wrong reviewer ran.
- The user asks to make a reviewer choice permanent.
- The user asks for the current reviewer or reviewer status.

If the request is only about reviewing an issue draft and does not ask to
change the machine preference, skip this skill.

## Procedure

### 1. Record the current state

From the pack repository root:

```bash
npm run --silent pack-reviewer-status
```

Record the saved reviewer, effective reviewer, preference path, and whether
the legacy environment is present. A saved preference takes precedence over a
stale `PACK_REVIEWER` inherited from a shell, IDE, or runtime.

### 2. Persist the requested reviewer

Use exactly one of:

```bash
npm run --silent pack-reviewer-set -- --reviewer gpt
npm run --silent pack-reviewer-set -- --reviewer codex
npm run --silent pack-reviewer-set -- --reviewer claude
```

The command validates the value, writes the user preference, and verifies that
the effective reviewer is the requested one. It does not export a temporary
process variable, edit a shell profile, or require a runtime restart.

### 3. Verify

```bash
npm run --silent pack-reviewer-status -- --expected <gpt|codex|claude>
```

`[PASS]` is required. If it fails, preserve the diagnostic output and stop;
do not compensate by setting `PACK_REVIEWER` in another shell or by invoking a
reviewer wrapper directly.

### 4. Report

Tell the user:

- saved reviewer and preference file;
- effective reviewer and wrapper;
- whether a legacy `PACK_REVIEWER` exists and is being ignored;
- that the next pack review will use the saved reviewer automatically.

## Runtime boundary

This skill has no vendor runtime commands. Runtime selection belongs to the
pack's runtime composition root and is controlled by its configured adapter
selection. A future runtime module can replace the current one without
changing this skill because reviewer selection is resolved at review
invocation time.

## One-shot exceptions

For a deliberate one-review exception, use the runner's invocation-bound
reviewer mechanism. Do not overwrite the persistent preference and do not
leave a shell-level `PACK_REVIEWER` override behind.

GPT uses the browser review adapter and does not silently fail over to Codex or
Claude. A failed review is a failed invocation that must be diagnosed or
retried according to the review runner contract.

## Related commands

```bash
npm run --silent pack-reviewer-status
npm run --silent pack-reviewer-set -- --reviewer gpt
```
