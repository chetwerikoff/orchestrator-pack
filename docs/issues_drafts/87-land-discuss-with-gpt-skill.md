# Land the `discuss-with-gpt` skill (declare + de-personalize)

GitHub Issue: #302

## Prerequisite

None. The working implementation already exists, untracked, at
`.claude/skills/discuss-with-gpt/` (authored and hardened over a 9-pass
adversarial convergence loop). This task only lands it in git, cleanly.

## Goal

Bring the existing, tested `discuss-with-gpt` skill under version control via a
worker declaration so it passes the scope guard, and remove operator-specific
hardcoded values so the committed skill is reusable rather than tied to one
operator's ChatGPT account and Windows profile.

```behavior-kind
action-producing
```

## Binding surface

- The skill (`SKILL.md`, the Playwright driver, the Chrome launcher) becomes
  tracked under `.claude/skills/discuss-with-gpt/` via the worker's
  `ao-declare` declaration, so the non-markdown files satisfy the PR scope
  guard (`.github/workflows/scope-guard.yml` → `pr-scope-guard`).
- **No operator-specific value is hardcoded in committed code.** The ChatGPT
  project URL and the Chrome user-data-dir / profile path must come from
  operator configuration (an environment variable and/or a gitignored local
  config), with a neutral, non-personal placeholder as the only committed
  default. The committed tree must not contain a real personal ChatGPT project
  id or an absolute machine-local profile path.
- The skill's existing behavior contract is preserved: connect-only over CDP,
  draft read from disk, per-pass PASS_ID/SHA + draft-boundary nonce echo
  validation, machine-validated findings packet, fail-loud state record on
  every exit, the non-negotiable stop rule + audit line. Landing must not
  regress these.
- **Operator adoption:** after merge, the operator sets the project URL (env or
  local config) and runs the launcher to start/login the automation Chrome
  once. List these steps in the PR `## Operator adoption` section.

## Files in scope

- `.claude/skills/discuss-with-gpt/**` (the skill dir: `SKILL.md`, the driver,
  the launcher, and any small local-config example the worker adds).
- A gitignore entry for the operator's local config file, if the worker chooses
  a file-based config.

## Files out of scope

- Any other skill under `.claude/skills/`.
- `agent-orchestrator.yaml` / `.example`, CI workflows, `scripts/**`,
  `plugins/**`, `packages/**`, `vendor/**`.
- The skill's behavior/validation logic (preserve as-is except where a hardcoded
  operator value must become configurable).

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
.claude/skills/discuss-with-gpt/**
```

## Acceptance criteria

- `.claude/skills/discuss-with-gpt/` is tracked: `SKILL.md`, the driver, and the
  launcher appear in `git ls-files`.
- A repo-wide search of the committed tree finds **no** real personal ChatGPT
  project id (the `g-p-…` segment that was in the local copy) and **no**
  absolute machine-local profile path (e.g. a `C:\…` user-data-dir) in tracked
  files.
- The driver resolves the target project URL from operator configuration (env
  var and/or gitignored local config); with that configuration unset it fails
  loud with an actionable message rather than silently using a personal URL.
- The launcher resolves the Chrome profile path and project URL the same way (no
  personal default committed).
- `SKILL.md` documents the operator configuration (which env var / config file,
  what to set) in its preconditions.
- `pwsh -NoProfile -File scripts/check-reusable.ps1` passes for the new tracked
  files.
- The PR carries a worker declaration covering the changed paths so the scope
  guard's `pr-scope-guard` job passes.

```positive-outcome
asserts: with the operator project URL configured, the driver run against a logged-in automation Chrome prints STATE=completed_valid and VALIDATION=ok for a real draft
input: external-tool-output
provenance: capture-backed
```

(Capture basis: local runs already produced `STATE=completed_valid`
`VALIDATION=ok` artifacts under `~/.local/state/discuss-with-gpt/`; the worker
reproduces one after the config change.)

## Upgrade-safety check

- No edits to AO core, `packages/**`, `vendor/**`, CI workflows, or
  `agent-orchestrator.yaml`.
- No new repo secret is introduced; the operator config holds the (non-secret)
  project URL and a local profile path, and the config file (if any) is
  gitignored.
- No unsupported YAML; the skill is self-contained under `.claude/skills/`.

## Verification

- `git ls-files .claude/skills/discuss-with-gpt/` lists the skill files.
- `grep -r` over the tracked tree for the old `g-p-…` project id and for a
  `C:\\` profile path returns nothing in committed files.
- Unset the operator config and run the driver: it exits with a clear
  configuration error (not a personal-URL default).
- Set the config to the operator's project, launch Chrome via the launcher, run
  the driver against a sample draft: observe `STATE=completed_valid` /
  `VALIDATION=ok`.
- `pwsh -NoProfile -File scripts/check-reusable.ps1` → `[PASS]`.
