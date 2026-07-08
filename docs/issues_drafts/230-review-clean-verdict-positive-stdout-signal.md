# Pack review CLI positive clean-verdict stdout signal

GitHub Issue: [#663](https://github.com/chetwerikoff/orchestrator-pack/issues/663)

## Prerequisite

- **REUSED merged lineage (wire to; do not rebuild):**
  - `docs/issues_drafts/06-codex-reviewer-scope-context.md` (GitHub #9) — structured finding JSON, `NO_FINDINGS` / clean-review contract, empty Codex stdout is **not** clean at parse layer.
  - `docs/issues_drafts/44-codex-review-jsonl-verdict-source.md` (GitHub #127) — JSONL `review_output` as primary verdict source.
  - `docs/issues_drafts/45-codex-review-jsonl-explanation-findings-recovery.md` (GitHub #135) — bounded split-channel recovery.
  - `docs/issues_drafts/46-codex-review-native-output-format-alignment.md` (GitHub #136) — prompt → CLI hydration → mapper alignment.
  - GitHub #461 (time-budget / hard-kill escalation, **closed**) — hard-kill before verdict → dedicated failure class, exit non-zero. **Different class** from intentional clean silence; cite as contrast only.
- **Open queue (sequencing / surface coupling — do not silently conflict):**
  - `docs/issues_drafts/226-ao-harness-pack-pn-contract-unification.md` (GitHub #658) — freezes `scripts/invoke-pack-review.ps1` argv/stdout and AC#5 byte-identical golden. **Ordering rule below is mandatory.**
  - `docs/issues_drafts/225-agent-rules-restructure.md` (GitHub #654, in flight) — if runner interpretation table targets `prompts/agent_rules.md`, land **after #654 merges** or target restructured section; alternative surface = plugin README + pointer from existing review rules (no full-policy duplication).
  - `docs/issues_drafts/212-ao-010-review-pipeline-vocabulary-migration.md` (GitHub #625) — vocabulary migration only; do not resurrect dead `ao review run/list/send/execute` prose here.
- **Incident grounding (2026-07-07):** LLM orchestrator session driving foreground pack reviews on PR #657 retried the same clean review **six times** (15:35–16:21 UTC; rollouts under `~/.codex/sessions/2026/07/07/rollout-2026-07-07T{15-35-10,15-58-52,16-08-27,16-13-14,16-17-13,16-21-33}-*.jsonl`, cwd `…/orchestrator-pack-25`). Each attempt internally reached `exited_review_mode` with `findings: []`, `overall_correctness: "patch is correct"`, but the wrapper returned **exit 0 with zero stdout/stderr bytes**; the runner treated silence as failure and re-ran (~670k input tokens/run, ~35% of a 5h Codex window). Same class on PR #662 first attempt (15:35, cwd `…-30`). Condensed RCA: architect brief `docs/investigations/TASK-230-review-clean-verdict-positive-stdout-signal-brief.md`.

**Prior-art verdict (draft-author recon 2026-07-07):** **Genuinely new** for the foreground CLI stdout contract. Shipped code intentionally emits empty stdout on clean (`review_core.ts` `aoStdout: ''` when `findings.length === 0`; `review_cli.ts` skips write). No open or merged draft owns "always print terminal verdict record on stdout including clean." #658 owns daemon harness submit shape, not this manual/foreground signal.

**Decomposition check:** One PR — CLI stdout contract + README/rules interpretation + fixture regressions. Splitting docs-only (option b) was judged insufficient in the brief (recurred twice same day). Opt-in file flag alone (option c) loses when omitted.

**Pre-draft design gate (T2 light pass — architect brief carry-forward):**

| Option | Cost / risk | Sufficiency | Verdict |
|--------|-------------|-------------|---------|
| **(a) Always-print terminal verdict record on stdout (clean included)** + fixtures/README/rules | Low–medium — breaks consumers expecting empty stdout (tests, #658 golden if mis-ordered) | Fixes ambiguity class for all future stdout consumers | **Land** |
| **(b) Docs/rules only** («exit 0 + empty = clean») | Cheapest | Keeps loss-of-output indistinguishable from clean; incident recurred twice | **Reject** |
| **(c) Opt-in `--verdict-file`** (like `--github-comment-file`) | Medium — stdout unchanged | Silent again when flag omitted | **Reject** |
| **(d) Reference shipped `--github-comment-file`** only | Low | Positive artifact exists but not on stdout; runner does not pass flag today | **Reject alone** — precedent supports (a), not replaces it |

**Industry pattern:** CLIs that drive automation (terraform, kubectl, gh json fields, test runners) emit structured success records; silence reserved for "no structured contract" tools. Here the pack already emits structured JSON on findings path — clean is the asymmetric gap.

## Goal

Every **terminal outcome** of the pack review CLI (`plugins/ao-codex-pr-reviewer` foreground path reached via `scripts/invoke-pack-review.ps1` / `REVIEW_COMMAND`) MUST emit a **positive, machine-readable verdict record on stdout** — **clean included** (explicit clean verdict and zero finding count at minimum). Findings runs keep their structured payload shape; failure runs keep non-zero exit and stderr diagnostics (stdout may remain empty on failure). Documented contract (plugin README) and runner-facing rules state the exit/stdout interpretation table so an LLM runner never retries a completed clean review.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

## Binding surface

### Invariants (non-negotiable)

- **Positive stdout on every terminal success class.** On exit 0, stdout is **non-empty** and parseable as the pack terminal verdict record. Clean reviews emit an explicit clean verdict with `findingCount: 0` (or equivalent normative field — planner names shape). **Forbidden:** exit 0 with zero-length stdout on any completed review (clean, findings-only, or clean with scope-warning findings).
- **Findings path backward shape.** When structured findings are present, stdout remains valid structured JSON consumable by existing AO / fixture paths (`emit.ts` lineage). Adding clean fields must not break findings consumers that read `findings[]`.
- **Failure path unchanged.** Non-zero exit, stderr diagnostics, anti-fake-clean guard in `parse_output.ts` / JSONL fail-closed semantics — **no edits** to Codex invocation, session parsing, or "empty Codex output → error" behavior.
- **Foreground CLI only.** This draft owns the manual / `invoke-pack-review.ps1` / `REVIEW_COMMAND` foreground wrapper stdout contract. **Daemon harness clean submit** (`ao review submit` body on zero findings) stays with #658 AC#2 — do not conflate the two surfaces in one AC.
- **No AO core / vendor edits.** No changes under `vendor/**` or `packages/core/**`.
- **Sequencing with #658 (mandatory — pick one before implementation merges):**
  1. **Preferred:** Land **#230 before #658 implementation PR** so #658 AC#5 golden baseline is captured **after** the new stdout contract; or
  2. **Same cycle:** Architect amends #658 invariant ("manual wrapper frozen") and AC#5 golden wording to reference the new terminal verdict record (**architect-owned spec edit** — worker must not silently assume frozen empty stdout).
  Worker PR for this issue must record which branch was taken in the PR description.
- **Runner rules surface (schedule against #654):** Interpretation table lands in `plugins/ao-codex-pr-reviewer/README.md` at minimum. If also updating `prompts/agent_rules.md`, merge **after #654** or edit the post-restructure Review/CI section — **no duplicate full policy** across surfaces; at most README + short pointer in agent rules.
- **Precedent:** `--github-comment-file` already writes positive clean markdown when findings are zero (`review_core.ts`); stdout contract catches up to that class of positive artifact.

### Terminal outcome matrix (full class — fixture each row)

| Outcome class | Exit | stdout | stderr | Runner must |
|---------------|------|--------|--------|-------------|
| Clean (JSONL `findings: []`, patch correct) | 0 | Non-empty verdict JSON, explicit clean, `findingCount: 0` | diagnostics only (may be empty) | Treat as terminal success — **no retry** |
| Clean + scope-warning finding(s) | 0 | Non-empty verdict JSON (findings array may be non-empty) | diagnostics | Same as today for findings presence |
| Findings review | 0 | Non-empty structured findings payload | diagnostics | Parse findings; existing behavior |
| Codex/parse failure (empty output, legacy prose, contradictory JSONL) | non-zero | empty or ignored | failure diagnostics | Do not treat as clean; no stdout-trust |
| Hard-kill before verdict (#461 class) | non-zero | empty or ignored | budget-kill evidence class | Classified failure — not this draft |

```contract-evidence
binding-id: orchestrator-pack:review-cli:clean-stdout-verdict
binding-type: cli-behavior
binding: foreground pack review CLI on clean JSONL fixture exits 0 with non-empty stdout parseable as terminal verdict declaring clean and zero findings
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
expected: clean-stdout-verdict

binding-id: orchestrator-pack:review-cli:findings-stdout-shape
binding-type: cli-behavior
binding: foreground pack review CLI on findings fixture exits 0 with parseable structured findings payload matching pre-change findings shape (regression)
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
expected: findings-stdout-shape

binding-id: orchestrator-pack:review-cli:failure-not-silent-clean
binding-type: cli-behavior
binding: foreground pack review CLI on empty-output failure fixture exits non-zero; stdout must not parse as clean verdict
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
expected: failure-not-silent-clean

binding-id: orchestrator-pack:review-cli:readme-contract-table
binding-type: unstructured
binding: plugin README behavior table documents non-empty stdout for all exit-0 rows (clean and findings)
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
expected: readme-contract-table
```

## Files in scope

- `plugins/ao-codex-pr-reviewer/**` — `review_core.ts`, `review_cli.ts`, `emit.ts` as needed; tests and README
- `scripts/run-pack-review-fixture.mjs` — if aoStdout expectations change `(update)`
- `tests/**` — clean/empty-output regression fixtures `(update)`
- `plugins/ao-codex-pr-reviewer/README.md` — exit/stdout interpretation table `(update)`
- `prompts/agent_rules.md` **only when #654 has merged** — short pointer to README table `(optional update)`

## Files out of scope

- `vendor/**`, `packages/core/**`, `agent-orchestrator.yaml`
- Codex CLI invocation, `parse_output.ts` / `review_jsonl.ts` verdict-selection semantics (except stdout emission layer)
- #658 harness bridge, `ao review submit` body, daemon-triggered review path
- `scripts/invoke-pack-review.ps1` argv forwarding logic — **stdout content changes flow through the wrapper but argv contract is unchanged**
- `.github/workflows/*` — no workflow consumer of review stdout (verified 2026-07-07)
- #625 dead vocabulary migration

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
plugins/ao-codex-pr-reviewer/**
scripts/run-pack-review-fixture.mjs
tests/**
prompts/agent_rules.md
```

## Acceptance criteria

1. **Clean stdout verdict.** On a clean review fixture (JSONL `exited_review_mode` with empty `findings[]` and patch-is-correct overall), the foreground review CLI exits 0, stdout is **non-empty**, parses as JSON, and includes an explicit clean verdict with zero finding count. Red-then-green: fails while `aoStdout` remains `''` on clean path.

```positive-outcome
asserts: foreground pack review CLI on clean JSONL fixture exits 0 with non-empty stdout JSON declaring clean verdict and findingCount 0
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: review-cli
expected: clean-stdout-verdict
proof-command: plugin test suite clean-path case (review.test.ts clean aoStdout expectation) and/or fixture replay via run-pack-review-fixture.mjs
red-then-green: must fail when clean path returns empty stdout
```

2. **Findings stdout regression.** On a findings-bearing fixture, exit 0 stdout remains parseable structured JSON with `findings[]` populated; shape compatible with existing `emitAoReviewPayload` consumers (no dropped fields consumers rely on).

```positive-outcome
asserts: foreground pack review CLI on findings fixture exits 0 with parseable findings payload matching established structured shape
input: sample-backed
```

```producer-emission
producer: orchestrator-pack
datum: review-cli
expected: findings-stdout-shape
proof-command: existing findings-path tests in plugins/ao-codex-pr-reviewer/tests/review.test.ts remain green with updated clean expectations only
red-then-green: must fail if findings payload loses required structured fields
```

3. **Failure path not masquerading as clean.** Empty-output and legacy-prose failure fixtures exit non-zero; stdout does not satisfy clean-verdict predicate (empty or unparseable). Anti-fake-clean guard behavior unchanged.

```positive-outcome
asserts: empty-output failure fixture exits non-zero and stdout is not a valid clean verdict record
input: sample-backed
```

```producer-emission
producer: orchestrator-pack
datum: review-cli
expected: failure-not-silent-clean
proof-command: existing rejects-empty-stdout / fails-on-empty-stdout-fixture tests
red-then-green: must fail if empty Codex output yields exit 0 with clean verdict stdout
```

4. **Documented contract.** `plugins/ao-codex-pr-reviewer/README.md` behavior table: every exit-0 row shows **non-empty stdout** with the terminal verdict record (clean rows no longer say "empty stdout"). Includes runner guidance: **exit 0 + parseable clean verdict = terminal success; do not re-invoke review.**

```producer-emission
producer: orchestrator-pack
datum: review-cli
expected: readme-contract-table
proof-command: static check or review.test that fails if README clean rows still document empty stdout on exit 0
red-then-green: must fail while README rows say "empty stdout" for clean verdict paths
```

5. **Runner interpretation surface.** At least one runner-facing doc (README required; `prompts/agent_rules.md` optional per #654 schedule) states: zero-length stdout on exit 0 is **not** a valid success signal after this change; retry is forbidden when stdout parses as clean verdict on current PR head.

6. **#658 sequencing proof in PR.** Implementation PR description states whether #230 landed before #658 worker implementation or #658 spec was architect-amended for AC#5/invariant — no silent golden conflict.

## Upgrade-safety check

- Pack plugin + tests + docs only; no AO core install requirement.
- stdout contract change is intentional breaking change for consumers that equated exit-0 empty stdout with clean — tests and #658 golden (if applicable) updated in same cycle per sequencing rule.
- Findings JSON consumers gain optional clean-metadata fields only if backward-compatible; must not remove `findings` array.

## Verification

1. `npm test` (or documented plugin test command) in `plugins/ao-codex-pr-reviewer` — clean + findings + failure stdout cases (AC#1–#3).
2. `pwsh -NoProfile -File ./scripts/verify.ps1` and `pwsh -NoProfile -File ./scripts/check-reusable.ps1` green.
3. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/230-review-clean-verdict-positive-stdout-signal.md`
4. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/230-review-clean-verdict-positive-stdout-signal.md`
5. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/230-review-clean-verdict-positive-stdout-signal.md`
6. Manual spot-check: README table rows for clean JSONL and `NO_FINDINGS` last-message path show non-empty stdout (AC#4).

### Grounding captures (draft-author, 2026-07-07)

Evidence from architect brief and worktree reads — not fabricated:

```
# Clean path empty aoStdout (review_core.ts ~232):
aoStdout: findings.length > 0 ? emitAoReviewPayload(...) : ''

# CLI skips write when empty (review_cli.ts ~130-135):
if (result.aoStdout) { process.stdout.write(result.aoStdout); ... }

# README today (clean row):
| Review-mode JSONL | review_output clean | 0, empty stdout | findingCount: 0, run clean |

# aoStdout consumers (grep): review_cli.ts, review_core.ts, emit.ts,
# scripts/run-pack-review-fixture.mjs, review.test.ts (~1451, ~1625 empty expectations)
# No .github/workflows consumer of review stdout (brief verified)
```