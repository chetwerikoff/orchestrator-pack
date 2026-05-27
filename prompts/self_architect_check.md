# Self-architect check

Before implementing, staging, or committing, run this short check:

1. Paired script/template edits: am I changing the same behavior in both a script
   and a template? If yes, extract or generate from one source of truth.
2. Duplicated prompt literals: did I copy a rule/prompt/path string into multiple
   files? If yes, centralize it before continuing.
3. Broad declarations: is the declared scope a whole directory or glob when a
   file-level scope would work? If yes, narrow it or justify it explicitly.
4. New subsystem smell: am I adding a new subsystem for behavior that AO already
   has through config, reactions, session metadata, or plugin slots? If yes,
   reuse AO's mechanism.
5. Core patch smell: am I about to patch upstream AO core? If yes, stop and use
   plugin/config/prompt/wrapper/hook/CI instead.

## Mechanical check

Run the pack lint before staging or opening a PR:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lint-self-architect.ps1
```

Include unstaged edits when checking your working tree:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lint-self-architect.ps1 -IncludeUnstaged
```

CI uses `-Strict`, which fails only on the narrow rules below. Default mode always
exits 0 and prints structured `[WARN]` / `[STRICT]` lines with file paths, line
ranges, and a one-line rationale.

**Strict rules (exit 1 when matched):**

- `duplicate-literal` — the same ≥ 10 consecutive lines appear in two or more
  scanned files.
- `paired-edit-divergence` — a script and a template were both changed and share
  an ≥ 8-line block with partial overlap that no longer matches exactly.

**Warning-only heuristics** (local default mode only; skipped under `-Strict` / CI):

- `near-duplicate-literal` — similar but not identical blocks in the configured
  short-line window. CI omits this scan for speed; local runs cap candidates via
  `scripts/lint-self-architect.config.json`.

Thresholds and scan paths live in `scripts/lint-self-architect.config.json`.
To suppress a justified duplicate, add an entry under `suppressions` with `rule`,
`files`, and an optional `reason` field.
