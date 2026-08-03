# Switching the pack reviewer (GPT, Codex, or Claude)

This runbook describes the portable pack-owned reviewer selector. The selector
is independent of the process that launches a review.

## Authority and precedence

The review entrypoint resolves the reviewer in this order:

1. `PACK_REVIEW_BOUND_REVIEWER` — explicit binding for one invocation.
2. Persistent user preference.
3. Legacy `PACK_REVIEWER` — compatibility fallback when no preference exists.

The persistent preference is stored at:

```text
$XDG_CONFIG_HOME/orchestrator-pack/reviewer.json
```

If `XDG_CONFIG_HOME` is unset, the platform user config directory is used,
normally `$HOME/.config/orchestrator-pack/reviewer.json`.

The document schema is `pack-reviewer-preference/v1` and the only selectable
values are `gpt`, `codex`, and `claude`. Writes replace the file atomically
where the host filesystem supports atomic rename and use user-only file
permissions where supported.

An invalid preference fails closed. The legacy environment is not used to hide
a corrupted saved choice.

## Reviewer adapters

| Reviewer | Wrapper |
|---|---|
| Browser GPT | `scripts/run-pack-review-gpt.ts` |
| Codex | `scripts/run-pack-review.ps1` |
| Claude Sonnet | `scripts/run-pack-review-claude.ps1` |

All adapters return the same pack verdict contract. A GPT failure, quota
problem, login problem, malformed payload, or stale-head rejection does not
silently switch to another adapter.

## Inspect the current selection

From the pack repository root:

```bash
npm run --silent pack-reviewer-status
```

The output includes the preference path, saved value, legacy environment value,
effective reviewer, and selected wrapper.

## Persist a reviewer

Use the pack command:

```bash
npm run --silent pack-reviewer-set -- --reviewer gpt
npm run --silent pack-reviewer-set -- --reviewer codex
npm run --silent pack-reviewer-set -- --reviewer claude
```

The command validates, writes, rereads, and resolves the requested reviewer.
It does not:

- set a temporary process variable;
- edit a shell profile;
- edit repository configuration;
- start, stop, reload, or inspect an agent runtime.

Verify the result:

```bash
npm run --silent pack-reviewer-status -- --expected gpt
```

The next review invocation reads the saved value automatically.

## One-shot reviewer binding

An invocation that deliberately needs a different reviewer may use
`PACK_REVIEW_BOUND_REVIEWER`. This binding has higher precedence for that
invocation only. It must not be used to change the persistent default and must
not be left in a long-lived shell.

## Legacy compatibility

`PACK_REVIEWER` remains supported for installations that have not yet created
the preference file. Once a saved preference exists, it wins over a stale
shell, IDE, or launcher value. This prevents an old `PACK_REVIEWER=codex` from
undoing a saved GPT choice.

If no saved preference and no valid legacy value exist, review fails closed.

## Runtime boundary

This selector has no vendor runtime commands. Runtime selection is a separate
composition-root concern controlled by the configured runtime adapter. Changing
the runtime module therefore does not require changing this runbook or the
reviewer skill.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| Effective reviewer is wrong | Saved preference is different | Run `pack-reviewer-set` with the intended value |
| Effective reviewer is unset | No saved or valid legacy value | Persist `gpt`, `codex`, or `claude` |
| Saved file is invalid | Manual edit or interrupted write | Run `pack-reviewer-set` to replace it |
| Old shell still exports another value | Legacy fallback is stale | Saved preference should win; verify with status |
| Review used another adapter | Invocation binding or stale review evidence | Check the invocation binding and current-head runner evidence |

Do not invoke adapter wrappers directly to bypass selector resolution.
