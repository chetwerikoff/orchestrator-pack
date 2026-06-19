# Fix reviewer failure evidence cookie redaction and summary tail limit (opk-rev-327)

GitHub Issue: #315

## Prerequisite

- `docs/issues_drafts/101-reviewer-failure-evidence-log.md` (GitHub #312, closed via
  PR #313) — shipped incremental, secret-safe reviewer failure evidence artifacts
  and recovery enrichment. This draft fixes two post-merge defects Codex flagged in
  `opk-rev-327` (review run `6dcffc1e`, PR #313) that remain on `main`.

**Prior art:** No open issue or draft covers these two defects. Review
`opk-rev-326` was clean on the same SHA; `opk-rev-327` opened two findings that
were not fixed before merge.

## Goal

Restore the secret-safety and operator-knob contracts promised by #312: persisted
reviewer failure evidence must redact entire multi-value `Cookie` (and equivalent)
headers, and recovery audit summaries must honor
`AO_REVIEW_FAILURE_EVIDENCE_SUMMARY_TAIL_LIMIT` on the main enrichment path — not
only when callers pass an explicit limit to the summary builder.

```behavior-kind
action-producing
```

## Binding surface

**Re-used from #312 (do not re-implement):** evidence artifact schema, incremental
phase recording, output tail limits via `AO_REVIEW_FAILURE_EVIDENCE_OUTPUT_TAIL_LIMIT`,
recovery linkage via `enrichRecoveryEvidenceWithFailure`, and the
`assertFailureEvidenceSecretSafe` gate.

**Fixed by this issue:**

1. **Whole-header redaction** — when reviewer stdout/stderr contains a header line
   such as `Cookie: sid=abc; refresh=def`, scrubbing must remove the entire header
   value (all cookie pairs), not only the first `\S+` token. Partial redaction that
   leaves trailing cookie material must not pass the secret-safety check.
2. **Summary tail limit on recovery path** — `resolveFailureEvidenceForRun` (and any
   other #312 recovery enrichment entry that builds audit summaries) must apply
   `resolveSummaryTailLimit()` so the documented env knob affects recovery audit
   summaries, matching the behavior already tested for explicit
   `buildFailureEvidenceSummary(..., { summaryTailLimit })` callers.

No change to review verdict authority, claim semantics, or #287 terminalization.

## Files in scope

- `docs/reviewer-failure-evidence.mjs` — scrubbing and recovery summary assembly
- `scripts/reviewer-failure-evidence.test.ts` — regression fixtures for both defects
- `scripts/check-reviewer-failure-evidence.ps1` — only if wiring assertions need
  updating for the new cases

## Files out of scope

- `plugins/**`, `prompts/**`, `agent-orchestrator.yaml.example`
- Review wrapper entrypoints beyond any import-only touch required by tests
- AO core / vendor

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
plugins/**
prompts/**
```

## Acceptance criteria

- Multi-cookie header scrubbing: input tail containing
  `Cookie: sid=abc; refresh=def` persists with no literal `sid=`, `refresh=`, or
  `def` substrings; `assertFailureEvidenceSecretSafe` rejects any artifact that
  still contains cookie material after scrubbing.
- Recovery summary limit: with
  `AO_REVIEW_FAILURE_EVIDENCE_SUMMARY_TAIL_LIMIT` set to a value smaller than the
  stored stdout/stderr tail, `resolveFailureEvidenceForRun` returns a summary whose
  bounded tail fields respect that limit (not the hard-coded 1024 default).
- Existing #312 tests for Bearer redaction, output tail env limit, and
  `buildFailureEvidenceSummary` explicit limit continue to pass unchanged in
  behavior.
- No forbidden evidence fields (`command`, `env`, raw `token`, etc.) are introduced.

```positive-outcome
asserts: recordFailureEvidenceOutput persists a stderr tail where a multi-pair Cookie header is fully redacted and resolveFailureEvidenceForRun summary tails honor AO_REVIEW_FAILURE_EVIDENCE_SUMMARY_TAIL_LIMIT
input: realistic
```

## Upgrade-safety check

- Pack-only change under `docs/` and `scripts/`; no AO core or vendor edits.
- Evidence schema version unchanged unless a backward-compatible field addition is
  strictly required (prefer no schema bump).
- Env var names and defaults from #312 remain stable.

## Verification

- `npx vitest run scripts/reviewer-failure-evidence.test.ts`
- `pwsh -NoProfile -File scripts/check-reviewer-failure-evidence.ps1`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/102-reviewer-failure-evidence-redaction-and-summary-limit.md`
- `pwsh -NoProfile -File scripts/verify.ps1`

## Source findings (opk-rev-327)

| Severity | Title | Fingerprint |
|----------|-------|-------------|
| P1 | Redact entire Cookie headers before persisting output | `ee73ac1cb3219506b0ad847afc7a4c74f7f6eee8a7afd0ae8525f9e05a2e300f` |
| P2 | Honor the configured summary tail limit | `793ceefa87ec96db6c2ef89011adbbfe6243b2eed67dd78e11207f6ce45550eb` |
