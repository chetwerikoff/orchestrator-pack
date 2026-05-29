# Codex PR review — finding bar and calibration

GitHub Issue: #51

## Prerequisite

- Draft `docs/issues_drafts/06-codex-reviewer-scope-context.md` (shipped as
  GitHub Issue #9, merged) owns `prompts/codex_review_prompt.md` and its
  `NO_FINDINGS` + structured-finding machine contract. This issue **amends the
  same prompt** with a calibration section; #9 is already merged, so this is an
  enhancement, not a blocker.

Background: the worker-PR Codex reviewer (local AO `codex exec review` steered
by `prompts/codex_review_prompt.md`, plus the optional GitHub Actions path that
reuses the same prompt) currently has no explicit *finding bar*. It will emit
cosmetic or speculative findings — style, naming, low-value cleanup, "could be
nicer" — which then route through `reactions.changes-requested` to the worker
and burn iterations of the auto-fix loop on non-actions. The open-source
`openai/codex-plugin-cc` adversarial-review prompt solves this with a
`finding_bar` + `calibration` + `grounding` stance ("report only material
findings", "prefer one strong finding over several weak ones", "every finding
defensible from context"). We want that discipline in our **standard** review
prompt — without changing the machine contract or adopting an adversarial
ship/no-ship stance.

## Goal

Strengthen `prompts/codex_review_prompt.md` so the reviewer suppresses cosmetic
and speculative noise and prefers a small set of well-grounded, material
findings, while **never** suppressing scope-violation or security findings and
keeping the existing `NO_FINDINGS` token, JSON object format, mandatory finding
fields, and scope-context behavior byte-for-byte intact in contract terms. The
change is additive prompt text; both review paths inherit it through the shared
prompt with no wrapper, schema, or workflow edit.

## Binding surface

Observable by reading `prompts/codex_review_prompt.md`:

1. A **finding-bar / calibration** section instructs the reviewer to report only
   *material* findings and to suppress pure style, naming, formatting, low-value
   cleanup, and speculative concerns that lack evidence in the diff or provided
   context.
2. A **calibration** clause: prefer a few well-grounded findings over many weak
   ones; do not dilute serious findings with filler.
3. A **grounding** clause: every finding must be defensible from the diff or the
   provided context; do not invent files, paths, lines, code paths, or runtime
   behavior.
4. An explicit **carve-out**: findings of the **existing** contract types
   `type: scope-violation` and `type: security` are material by definition and
   are **never** dropped by the finding bar. (No new finding type is introduced;
   these are the same `type` values already enumerated in the prompt.)
5. The existing **severity model is unchanged** — `blocking` / `non-blocking`
   stays; `non-blocking` continues to carry *substantive* non-blocking issues,
   and the bar removes cosmetic noise, not the non-blocking tier.
6. **No machine-contract drift**: the `NO_FINDINGS` clean-review token, the
   single-JSON-object response shape, the mandatory fields
   (`type`, `code`, `severity`, `path`, `summary`, `source`), the
   `{{SCOPE_SECTION}}` / `{{SOURCE}}` placeholders, and the scope-flagging rules
   are preserved exactly.

## Files in scope

- `prompts/codex_review_prompt.md` — add the calibration / grounding / carve-out
  text; leave the contract sections intact.
- `docs/issues_drafts/19-codex-review-finding-bar.md` — this spec.

## Files out of scope

- `plugins/ao-codex-pr-reviewer/**` — the wrapper, parser, schema, and tests.
  The bar is reviewer-prompt behavior; the wrapper and `NO_FINDINGS` filter
  (owned by Issue #9) do not change.
- `.github/workflows/codex-pr-review.yml` — the optional path reuses the same
  prompt and inherits the change automatically; no separate edit.
- `prompts/agent_rules.md`, `prompts/codex_review_prompt.md`'s machine contract
  sections (NO_FINDINGS, JSON shape, mandatory fields) — refine wording around
  them only; do not alter their meaning.
- `docs/issues_drafts/06-codex-reviewer-scope-context.md` — the closed upstream
  contract spec; do not rewrite it.
- AO core, `packages/core/**`, `vendor/**`.

## Denylist

```denylist
# issue 51 — calibration prompt worker scope
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
prompts/agent_rules.md
plugins/**
.github/workflows/**
docs/issues_drafts/06-codex-reviewer-scope-context.md
```

```allowed-roots
prompts/codex_review_prompt.md
docs/issues_drafts/19-codex-review-finding-bar.md
docs/declarations/51.op-29.json
```

## Acceptance criteria

- **Finding bar present.** `prompts/codex_review_prompt.md` contains a section
  instructing the reviewer to report only material findings and to suppress pure
  style, naming, formatting, low-value cleanup, and evidence-free speculative
  concerns.
- **Calibration present.** The prompt states a preference for fewer
  well-grounded findings over many weak ones and forbids padding serious
  findings with filler.
- **Grounding present.** The prompt requires every finding to be defensible from
  the diff / provided context and forbids inventing files, paths, lines, or
  runtime behavior.
- **Carve-out explicit.** The prompt states that findings of the existing
  `type: scope-violation` and `type: security` categories are always reported
  and are exempt from the finding bar; it introduces no new finding type.
- **Severity tiers retained.** The prompt still defines `blocking` /
  `non-blocking`, and the calibration text does not instruct the reviewer to
  drop the non-blocking tier — only cosmetic/speculative noise.
- **Machine contract intact (strictly additive diff).** The calibration text is
  added as new lines/sections; the PR diff against
  `prompts/codex_review_prompt.md` contains **zero removed (`-`) lines** — no
  existing line is modified, re-wrapped, or deleted. Provable by
  `git diff --numstat` / `git diff` showing 0 deletions for that file. Because
  nothing is removed, every existing contract line (including the
  `scope-violation` vs code-quality sentence) is preserved by construction.
- **Contract literals still present.** Grep of `prompts/codex_review_prompt.md`
  finds each literal verbatim: `NO_FINDINGS`, `{"findings":[...]}`, each
  mandatory field name (`type`, `code`, `severity`, `path`, `summary`,
  `source`), `{{SCOPE_SECTION}}`, `{{SOURCE}}`, and `scope-violation`.
- **No wrapper/workflow edit.** The diff touches only
  `prompts/codex_review_prompt.md` and this draft; no file under
  `plugins/ao-codex-pr-reviewer/**` or `.github/workflows/**` changes.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, AO runtime, the reviewer wrapper,
  the parser, or the finding schema.
- No new repository secrets, dependencies, runtime hooks, or YAML changes.
- Markdown-only change to a prompt template consumed by both review paths.
- The `NO_FINDINGS` machine contract and structured-finding identity rules from
  Issue #9 are unchanged.

## Verification

- **Static — bar / calibration / grounding.** Reading
  `prompts/codex_review_prompt.md` shows the three added clauses and the
  scope/security carve-out.
- **Static — contract preserved (strictly additive).** `git diff --numstat` for
  `prompts/codex_review_prompt.md` reports 0 deletions, and grep confirms
  `NO_FINDINGS`, `{"findings":[...]}`, the six mandatory fields,
  `{{SCOPE_SECTION}}`, `{{SOURCE}}`, and `scope-violation` are still present
  verbatim.
- **Static — scope of diff.** `git diff --name-only` on the PR head lists only
  `prompts/codex_review_prompt.md`,
  `docs/issues_drafts/19-codex-review-finding-bar.md`, and the AO declaration
  snapshot `docs/declarations/51.op-29.json` (required by PR scope guard).
- **Smoke.** `scripts/verify.ps1`, `scripts/check-reusable.ps1`, and
  `scripts/test-all.ps1` are clean on PR head; the existing
  `plugins/ao-codex-pr-reviewer` tests still pass unchanged (the bar is prompt
  text; the parser and `NO_FINDINGS` filter are untouched).
- **Note — behavioral effect not unit-tested.** Whether the reviewer actually
  emits fewer cosmetic findings is model behavior, not statically provable here;
  the observable contract is the presence of the calibration text plus the
  unchanged machine contract. A spot-check on a real PR diff is optional, not a
  merge gate.
