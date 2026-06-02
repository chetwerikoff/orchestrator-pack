# Codex review: native output format alignment (source-side mitigation)

GitHub Issue: #136

## Prerequisite

- `docs/issues_drafts/44-codex-review-jsonl-verdict-source.md` (GitHub #127) — **closed**;
  JSONL-first verdict selection on `main`.
- `docs/issues_drafts/45-codex-review-jsonl-explanation-findings-recovery.md` (GitHub #135) —
  split-channel **recovery** (symptom mitigation). Recommended land order: **#135 before #136**.
  #136 is **prevention**, not a replacement for #135.
- **Existing code (do not duplicate):** `plugins/ao-codex-pr-reviewer/lib/review_jsonl.ts`
  already maps hydrated `review_output.findings[]` via `parseCodexReviewOutput` /
  `normalizeReviewFinding` (native fields `title`, `body`, `priority`, `code_location` → pack
  `StructuredFinding`). This issue **changes the prompt** and **hardens/tests** that existing
  path — it does **not** introduce a second mapper.
- Observed mismatch (2026-06-02, Codex CLI **0.133.0**): when the internal reviewer returns
  **pack-format JSON** (as the pre-#136 prompt required), review-mode often leaves
  `review_output.findings[]` empty and dumps JSON into `overall_explanation`. When the internal
  reviewer returns **native Codex review output**, CLI hydrates `review_output.findings[]` and
  `overall_correctness` correctly (op-rev-26 healthy vs op-rev-28 split-empty on PR #134).

## Goal

Stop asking Codex review-mode for pack JSON in the prompt; request output that CLI reliably
hydrates into `review_output`. **Harden and test** the existing native JSONL → pack mapping in
`review_jsonl.ts` on that hydrated schema. Do **not** scrape raw prose from secondary channels.

## Binding surface

Apply the 5-mode framework:

- **Real problem:** prompt requires pack JSON; CLI review-mode hydrates native review output
  into `findings[]`, not pack JSON from internal `<results>`.
- **Assumption destroyed:** pack JSON in the prompt is compatible with reliable JSONL hydration.
- **Risk control:** work only on hydrated structured fields; conservative type/code classification
  on structured `title`/`body`; deterministic fail-closed on unreadable hydrated entries.
- **Executor:** prompt change + harden existing mapper + fixture tests; Codex review remains gate.

**What we do in this issue:**

1. **Prompt** — change `prompts/codex_review_prompt.md` from pack JSON / exact `NO_FINDINGS`
   to **native Codex review output** that CLI 0.133.0 hydrates (see hydrated schema below).
2. **Mapper** — **harden** existing `review_jsonl.ts` native → pack path (classification,
   severity, path normalization, incomplete-entry rules). Do **not** add a parallel mapper module.

**Critical invariant — two different prohibitions:**

```
FORBIDDEN (secondary-channel scraping):
  overall_explanation / last-message free text
  → regex for [P1]/[P2], paths, or findings
  → pack finding

ALLOWED (hydrated structured fields):
  review_output.findings[].title / body / priority / code_location
  → existing normalizeReviewFinding / resolveFindingType logic
  → pack StructuredFinding
```

Prose in the reviewer reply is input to **Codex CLI hydration only**. The wrapper verdict path
works on **`review_output` after hydration**, not on raw explanation/last-message text.

### Expected hydrated JSONL schema (fixture-level contract)

Implementation and tests MUST target this machine shape from `exited_review_mode.review_output`
(as seen in CLI 0.133.0 healthy sessions and existing fixtures under
`plugins/ao-codex-pr-reviewer/tests/fixtures/`), not human `[P2]` wording alone:

**Finding review:**

- `findings[]` — non-empty array of objects with at least:
  - `title` (string, often `[Pn] …`)
  - `body` (string)
  - `priority` (number, optional if bracket priority in title)
  - `code_location.absolute_file_path` (string, when file-specific)
  - optional `code_location.line_range`
- `overall_correctness` — `"patch is incorrect"` (or equivalent non-clean verdict per #127)
- `overall_explanation` — may contain summary prose; **not** a verdict source for the wrapper

**Clean review:**

- `findings[]` — `[]`
- `overall_correctness` — `"patch is correct"` (exact match per existing `isPatchCorrectVerdict`)
- Do **not** replace with vague “LGTM” / narrative-only clean prose as the primary contract.

The planner MUST derive prompt clean wording from observed healthy hydrated sessions (e.g.
op-rev-27 class) and lock it with a **clean native fixture** — not invent prose that CLI fails
to hydrate into `patch is correct` + empty `findings[]`.

### Prompt contract change (outcome, not exact wording)

- Remove pack JSON (`{"findings":[…]}`) and exact-token `NO_FINDINGS` as the **primary**
  review-mode reply requirement when `codex exec review --json` is used.
- Require native Codex review-style output that produces the hydrated schema above.
- Preserve scope context, finding bar, denylist / control-artifact rules, materiality calibration —
  **response shape only** changes.

### Existing mapper — harden, do not rewrite

`review_jsonl.ts` already implements the native → pack path. This issue may **adjust** it only
where acceptance criteria below require stricter behavior. Expected baseline (preserve unless
spec explicitly tightens):

**Severity** (from `priority` and/or `[Pn]` in `title`):

- numeric `priority <= 1` **or** bracket `P0`/`P1` → `severity: blocking`
- `P2`+ / higher numeric priority → `severity: non-blocking`
- missing priority → `non-blocking`, but **do not drop** the finding

**Verdict:** non-empty hydrated `findings[]` with non-clean `overall_correctness` → findings
path per #127. `severity: non-blocking` does not imply a clean review.

**Type / code:** use existing structured classification on hydrated `title`/`body` (scope /
denylist / out-of-scope signals → `scope-violation`; otherwise infer `quality` / `spec` / `ci` /
`test` / `security` as today). When uncertain → generic stable code; **never drop** the finding.

**Path:** from `code_location.absolute_file_path` via existing repo-relative normalization only.
**Never** invent path from body text.

**Incomplete hydrated entries — deterministic (no per-entry silent drop):**

- missing or empty `title` **or** `body` on any raw hydrated entry → **fail closed entire run**
  (existing behavior when normalized count ≠ raw count).
- file-specific finding: `code_location.absolute_file_path` present but cannot normalize to a
  repo-relative path → **fail closed entire run**.
- legitimately non-file finding (policy/repo-level): `path: null` allowed when no file anchor
  is required; do not scrape a path from body text to compensate.

### Relationship to #135

- **#135** = split-channel **recovery** (pack-json / exact `NO_FINDINGS` in secondary channels).
- **This issue** = **prevention** via prompt + hardened hydrated path.
- Do **not** remove or weaken #135 in this issue.

## Files in scope

- `prompts/codex_review_prompt.md` — native review output contract.
- `plugins/ao-codex-pr-reviewer/lib/**` — harden existing native JSONL → pack mapping (primarily
  `review_jsonl.ts` integration with #127 verdict selection); **no second mapper**.
- `plugins/ao-codex-pr-reviewer/tests/**` — fixtures for hydrated schema (op-rev-26 class
  findings, op-rev-27/op-rev-26 class clean, op-rev-28 class split as #135 context) and regression
  tests on the **existing** mapping path.
- `plugins/ao-codex-pr-reviewer/README.md` — document prompt + hydrated-schema → existing mapper flow.
- `docs/migration_notes.md` — split-channel root cause; pointer to #135 recovery.
- `docs/issues_drafts/46-codex-review-native-output-format-alignment.md` — this spec.
- `docs/issue_queue_index.md` — registry row.
- `docs/issues_drafts/06-codex-reviewer-scope-context.md` — if #9 contract still mandates pack JSON only.
- `docs/issues_drafts/00-architecture-decisions.md` — only if cross-issue anchor needed.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`, AO core semantics.
- #135 split-channel recovery implementation (separate issue).
- A new parallel mapper module duplicating `parseCodexReviewOutput` / `normalizeReviewFinding`.
- Scraping `[P1]`/`[P2]` or paths from `overall_explanation` / last-message prose (#135 shapes only).
- Retry-until-clean, reviewer model switch, workflow rewrites.

## Denylist

```denylist
# issue 136 — native review output format alignment
vendor/**
packages/core/**
.ao/**
scripts/**
.github/workflows/**
```

```allowed-roots
prompts/codex_review_prompt.md
plugins/ao-codex-pr-reviewer/**
docs/migration_notes.md
docs/issues_drafts/46-codex-review-native-output-format-alignment.md
docs/issue_queue_index.md
docs/issues_drafts/06-codex-reviewer-scope-context.md
docs/issues_drafts/00-architecture-decisions.md
```

## Acceptance criteria

**Prompt**

- Updated prompt no longer requires pack JSON or exact `NO_FINDINGS` as the primary review-mode
  reply when JSONL is enabled.
- Clean prompt wording is validated against a **clean native fixture** producing `findings: []`
  and `overall_correctness: "patch is correct"` — not against vague LGTM prose alone.

**Mapper (existing path hardened)**

- Hydrated op-rev-26-class JSONL (`findings[].title/body/priority/code_location`,
  `overall_correctness: patch is incorrect`) maps through **existing** `review_jsonl.ts` path to
  pack findings emitted to AO with repo-relative paths, severity rules above, and signatures
  compatible with auto-fix / scope contracts.
- Hydrated clean fixture (`findings: []`, `overall_correctness: patch is correct`) → clean AO effect.
- No new code path scrapes raw prose or `[Pn]` markers from `overall_explanation` / last-message
  for verdict selection.
- Structured classification on hydrated `title`/`body` (scope-violation inference, generic code
  fallback) remains allowed and tested.
- Incomplete hydrated entry rules above are enforced and tested (fail closed entire run; no silent
  per-entry drop).
- #127 contradictory / malformed JSONL fail-closed behavior unchanged.

**Tests (required close gate)**

- Fixture: op-rev-26-class native hydrated findings → pack map success.
- Fixture: clean native hydrated review → clean verdict.
- Fixture: op-rev-28-class split shape retained as regression context (#135 owns recovery behavior;
  document interaction if tested separately).
- Fixture: incomplete hydrated finding (missing title/body or unnormalizable required path) →
  fail closed.
- Fixture: contradictory JSONL (#127) → fail closed.
- No regression on existing `session-findings.jsonl` / `session-clean.jsonl` class fixtures unless
  prompt change intentionally updates them with documented reason.

**Manual evidence (required before close, not sole gate)**

- One live `codex exec review --json` run (or recorded session artifact) showing the updated prompt
  produces populated hydrated `findings[]` for a finding review and correct clean hydration for a
  clean review — flaky model output must not be the only automated gate.

**Docs**

- README and migration notes describe: native prompt → CLI hydration → **existing** mapper → AO;
  #135 recovery for legacy split-channel runs.

## Upgrade-safety check

- No AO core or vendor edits; no new secrets.
- `codex exec review --json` invocation unchanged.
- GitHub Actions dual-path continues using the same prompt file; workflow must stay green.
- Planner freedom on exact prompt wording; acceptance criteria are behavioral and fixture-backed.

## Verification

```bash
npm test -- plugins/ao-codex-pr-reviewer/tests/review.test.ts
```

```powershell
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
```

Before close: attach manual evidence note (issue comment or PR test plan) from one live or recorded
`codex exec review --json` run with the updated prompt.
