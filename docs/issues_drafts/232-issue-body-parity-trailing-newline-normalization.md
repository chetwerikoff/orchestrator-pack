# Issue-body parity must treat trailing-newline-only differences as a match

GitHub Issue: [#665](https://github.com/chetwerikoff/orchestrator-pack/issues/665)

## Prerequisite

None blocking.

**Prior art (reused — this draft revises a shipped decision):**

- `docs/issues_drafts/176-publish-issue-body-transport-and-parity.md` (GitHub #542,
  closed/merged) — ships the draft issue-body sync helper, sanctioned `--body-file`
  transport, live REST body read after create/edit, and the content parity predicate.
  **Already does:** mutation audit, literal-temp-path detection, truncation vs
  content-mismatch classification, CRLF normalization, and **at-most-one** trailing
  newline tolerance. **This draft supersedes** the trailing-newline tolerance slice of
  #542 only; transport, REST read path, draft extraction (`slice(2)`), and
  fail-on-substantive-mismatch behavior stay as shipped.

**Adjacent (surveyed, not dependencies):**

- `docs/issues_drafts/208-t3-stage-completeness-sync-gate.md` (#620) and
  `docs/issues_drafts/189-tier-gate-recompute-and-stage-selection.md` — touch publish
  sync receipts, not body-equality normalization.
- `docs/issues_drafts/99-publish-delegation-worktree-isolation.md` (#304) — isolates
  delegated publish from the architect tree; does not define parity comparison.

**Prior-art verdict:** **Extends/references existing** — a single-PR correctness fix to
the #542 parity predicate; no open issue covers trailing-newline-only false mismatches.

**Incident (verified 2026-07-07):** syncing draft 231 to issue #664 repeatedly returned
`mismatch class: content-mismatch` while the live REST body was byte-identical to the
expected draft body except for **one extra trailing newline** after a fenced code block.
The issue body was correct; the sync helper never reported success.

## Goal

After every draft issue-body create/edit, the parity comparison treats **any
trailing-newline-only difference** between the local expected body and the live REST
body as a **match** by canonicalizing both sides (strip **all** trailing `\n` after
CRLF normalization) before equality — **without** weakening detection of real content
differences. Literal temp-path bodies, truncation, and substantive edits must still
cause the sync path to refuse success.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

## Binding surface

- **Canonical trailing-newline normalization.** The parity predicate normalizes each
  side with existing CRLF handling (`\r\n` → `\n`), then removes **only** a trailing
  run of `\n` characters (`/\n+$/` → empty suffix) before string equality. No other
  whitespace folding (no internal space collapse, no trailing-space strip, no case
  change).
- **`bodiesMatchForParity` contract.** After canonicalization, equal strings → match.
  Any difference in non-trailing-newline content → no match.
- **`classifyMismatch` contract preserved.** After the same canonicalization used for
  equality:
  - `literal-temp-path` when the live body is a literal `@/tmp/...` path (unchanged).
  - `truncated` when canonicalized live is a strict prefix of canonicalized expected
    (live shorter, expected starts with live).
  - `content-mismatch` for all other substantive differences.
- **`compareIssueBodies` / `syncPublishIssueBody` behavior.** Success is reported only
  when parity holds under the revised predicate; substantive mismatch still returns
  `ok: false` with `mismatchClass` and an actionable message. Mutation transport
  (`gh issue create/edit --body-file`), REST read path, and draft extraction from
  `extractExpectedIssueBodyFromDraft` (`lines.slice(2).join('\n')` — H1 + blank line
  dropped; `GitHub Issue:` line and below are the body) are **unchanged**.
- **#542 decision revision (explicit).** Shipped #542 allowed **at most one** trailing
  newline between sides. GitHub REST can return **two** trailing newlines when the body
  ends in a fenced code block; this draft replaces that allowance with full trailing-
  newline stripping on both sides. Tests that encoded the old rule (notably
  `publish-issue-body-sync.test.ts` line 246: `alpha\nbeta` vs `alpha\nbeta\n\n` →
  no match) are updated to expect **match**.

No operator-facing surface changes — pack script behavior and regression tests only.

```contract-evidence
binding-id: orchestrator-pack:issue-body-parity:trailing-newline-only-match
binding-type: cli-behavior
binding: bodiesMatchForParity and compareIssueBodies treat trailing-newline-only differences (including two-or-more trailing newlines on one side) as a match after CRLF normalization
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:issue-body-parity:substantive-mismatch-still-refuses
binding-type: cli-behavior
binding: compareIssueBodies returns match false with content-mismatch when non-trailing-newline content differs
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:issue-body-parity:truncation-class-preserved
binding-type: cli-behavior
binding: classifyMismatch still returns truncated (not content-mismatch) when canonicalized live is a strict prefix of canonicalized expected
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:issue-body-parity:literal-temp-path-preserved
binding-type: cli-behavior
binding: classifyMismatch still returns literal-temp-path for @/tmp/... live bodies before trailing-newline normalization affects the verdict
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:issue-body-parity:code-fence-ending-fixture
binding-type: cli-behavior
binding: parity helpers match when expected ends with a closing fenced code block plus one trailing newline and live REST body ends with the same content plus two trailing newlines (issue 664 shape)
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
```

## Files in scope

- `scripts/lib/publish-issue-body-sync.ts` — parity normalization helpers and their
  callers (`bodiesMatchForParity`, `classifyMismatch`, `compareIssueBodies`).
- `scripts/publish-issue-body-sync.ts` — only if the planner needs a thin re-export or
  call-site touch (behavior unchanged at the CLI boundary).
- `scripts/publish-issue-body-sync.test.ts` — update line-246 contract; add fenced-code-
  block ending fixture.
- `tests/**` — additional fixtures only if the planner splits helper unit tests.
- This spec file.

## Files out of scope

- Draft markdown layout and `extractExpectedIssueBodyFromDraft` / `slice(2)` semantics.
- Sanctioned `gh issue create/edit --body-file` transport and REST read argv shape.
- Tier-gate / stage-completeness publish receipts (`.ps1` wrappers, #620).
- `agent-orchestrator.yaml`, `.ao/**`, `plugins/**`, CI workflows, skill prose unless
  recon proves drift against the revised predicate (none found).
- `vendor/**`, `packages/core/**`.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
tests/**
docs/**
```

## Acceptance criteria

1. **Trailing-newline-only match (supersedes #542 test at line 246).**
   `compareIssueBodies('alpha\nbeta', 'alpha\nbeta\n\n').match` is **true**.
   `bodiesMatchForParity` agrees for the same pair. One-sided single trailing newline
   cases that already pass (line 243–245) remain **true**.

```producer-emission
producer: orchestrator-pack
datum: issue-body-parity
expected: trailing-newline-only-match
proof-command: implementation-specific publish-issue-body-sync parity unit test
```

2. **Substantive mismatch still refuses.** Non-trailing content differences (e.g.
   `alpha\nbeta` vs `alphaX\nbeta`) yield `match: false` with
   `mismatchClass: content-mismatch`.

```producer-emission
producer: orchestrator-pack
datum: issue-body-parity
expected: substantive-mismatch-still-refuses
proof-command: implementation-specific publish-issue-body-sync parity unit test
```

3. **Truncation class preserved.** When canonicalized live is a strict prefix of
   canonicalized expected (live strictly shorter in content, not merely fewer trailing
   newlines at EOF), `classifyMismatch` returns `truncated` (not `content-mismatch`).
   Pairs that differ only by trailing newlines at EOF are **matches**, not truncation
   cases.

```producer-emission
producer: orchestrator-pack
datum: issue-body-parity
expected: truncation-class-preserved
proof-command: implementation-specific classifyMismatch unit test
```

4. **Literal temp-path preserved.** Live body `@/tmp/tmp.IoxWVuqfWY` still classifies as
   `literal-temp-path`; existing REST parity integration test for issue #538 continues
   to refuse success.

```producer-emission
producer: orchestrator-pack
datum: issue-body-parity
expected: literal-temp-path-preserved
proof-command: implementation-specific publish-issue-body-sync integration test
```

5. **Fenced-code-block ending regression.** A fixture where expected ends with a closing
   fenced code block plus one trailing newline and live ends with the same content plus
   **two** trailing newlines — the shape observed on issue #664 — yields
   `match: true` from `compareIssueBodies` and allows `syncPublishIssueBody` to report
   success when other deps are nominal.

```producer-emission
producer: orchestrator-pack
datum: issue-body-parity
expected: code-fence-ending-fixture
proof-command: implementation-specific publish-issue-body-sync parity unit or integration test
```

6. **No broad whitespace normalization.** A pair that differs only by trailing spaces on
   a content line (not trailing newlines at EOF) still yields `match: false`. Internal
   newline count and non-EOF whitespace are unchanged by the predicate.

7. **Positive sync path unchanged aside from predicate.** When live REST body matches
   expected under the revised rule, `syncPublishIssueBody` still reports `ok: true`,
   emits mutation audit metadata, and does not alter transport argv class.

```positive-outcome
asserts: compareIssueBodies and syncPublishIssueBody report success when the live REST body differs from the expected draft body only by trailing newlines after a fenced code block, and still refuse when literal temp-path or substantive content differs
input: realistic
```

## Upgrade-safety check

- Pack-owned `scripts/**` only; no Composio AO core or `vendor/**` edits.
- No new repo secrets, no unsupported YAML, no new long-running operator process.
- Stricter-in-appearance but correcter parity: success is reported in cases that were
  false negatives; no case that was a true substantive mismatch becomes a match unless the
  only raw difference is trailing `\n` characters.

## Verification

- `node --import tsx --test scripts/publish-issue-body-sync.test.ts` — includes updated
  line-246 expectation, substantive-mismatch and truncation cases, literal-temp-path
  regression, and the fenced-code-block ending fixture (AC#5).
- Focused unit coverage for `bodiesMatchForParity` / `classifyMismatch` if the planner
  extracts them.
- `.\scripts\verify.ps1` and `.\scripts\check-reusable.ps1` pass on the implementation
  PR branch.

## Grounding captures

Architect brief `docs/investigations/TASK-232-issue-body-parity-trailing-newline-brief.md`
(2026-07-07). Code pointers verified on main:

| Surface | Location | Notes |
| --- | --- | --- |
| Draft body extraction | `scripts/lib/publish-issue-body-sync.ts` `extractExpectedIssueBodyFromDraft` (126–128) | `lines.slice(2).join('\n')` — out of scope to change |
| CRLF normalization | `normalizeIssueBodyForParity` (131–133) | Preserved |
| Defect site | `stripAtMostOneTrailingNewline` (135–138) | Strips **at most one** `\n` — causes false `content-mismatch` when GitHub adds two |
| Equality | `bodiesMatchForParity` (140–142) | Builds on strip-at-most-one |
| Classification | `classifyMismatch` (148–161) | Same normalization; `truncated` prefix rule |
| Sync orchestration | `syncPublishIssueBody` (323+) | Pushes `--body-file`, reads REST, `compareIssueBodies` |
| Encoded old contract | `scripts/publish-issue-body-sync.test.ts` (242–247) | Line 246: `\n\n` tail → `false` today; must become `true` |
| Origin spec | `docs/issues_drafts/176-publish-issue-body-transport-and-parity.md` / #542 | At-most-one trailing newline decision superseded here |

Incident reproduction (draft 231 → #664): expected body ended with a closing fence and
one trailing newline; live REST body had two trailing newlines → `content-mismatch`
under current helper; byte-identical content aside from trailing newlines.

## Decisions

### Design analysis (light — T2)

**Critical mechanics:** string equality on issue bodies after CRLF normalization; EOF
trailing `\n` runs are presentation-only for REST round-trip; truncation detection uses
prefix compare on canonicalized bodies; literal `@/tmp/` detection is a separate early
class.

**Industry pattern:** Normalizer / canonical data model — canonicalize both inputs to a
common form before equality (wiki KB; not pack-specific).

**Options (cost rule):**

| Option | Cost | Risk | Sufficiency | Decision |
| --- | ---: | ---: | ---: | --- |
| (a) Strip **all** trailing `\n` on both sides before compare | Low | Low — cannot hide non-newline diffs | Sufficient | **Chosen** |
| (b) Raise “at most N” trailing-newline allowance | Low | High — arbitrary N, brittle vs GitHub | Insufficient | Rejected |
| (c) Normalize draft send side to fixed EOF newline | Medium | High — read-side asymmetry remains | Insufficient | Rejected |
| (d) Special-case non-fail-closed newline diffs | Medium | Medium — more branches than (a) | Redundant | Rejected |
| (e) Reference / extend #542 helpers in place | Low | Low | Sufficient | **Chosen** — same module, predicate-only change |

**Class enumeration:** Single predicate boundary — not a multi-step lifecycle or retry
cause. Matrix is trailing-newline-only vs substantive vs truncated vs literal-temp-path
(covered in ACs).
