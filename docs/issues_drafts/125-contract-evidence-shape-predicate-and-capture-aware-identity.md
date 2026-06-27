# Contract-evidence checker: shape/presence predicates and capture-aware binding identity

GitHub Issue: #394

## Prerequisite

- `docs/issues_drafts/117-spec-contract-evidence-grounding-gate.md` (GitHub #366, merged
  via PR #367) — *already does:* authoring-time `contract-evidence` gate with
  capture-manifest grounding, fail-closed pre-sync check, canonical binding identity
  `(producer, datum)`, and literal `expected` matching against committed captures.
  **Gap this draft closes:** identity ignores which capture grounds a row; `expected`
  accepts only literal string equality — no shape/presence predicates for variable-value
  fields.
- `docs/issues_drafts/115-reviewer-coworker-contract-mapping-pass.md` (GitHub #362) —
  *already does:* reviewer-time spec→diff contract-mapping pass for shipped
  contract-evidence rows. **Must remain compatible** — this draft does not change
  reviewer semantics.
- `docs/issues_drafts/119-contract-evidence-legacy-list-anti-tamper.md` (GitHub #377) —
  *already does / in queue:* mechanical guard on the legacy-grandfather list.
  **Must remain compatible** — list resolution and grandfather skip behavior unchanged.
- `docs/issues_drafts/123a-review-pending-info-handoff-admission.md` (GitHub #390) and
  `docs/issues_drafts/123b-review-ready-report-state-seed-backstop.md` (GitHub #391) —
  *recurrence context:* live-capture work exposed both checker gaps; shape assertions
  for variable-value fields (`subject.session.id`, `subject.pr.number`, timestamps)
  were deferred to recurrence tests and a separate gate-tooling follow-up (this draft).

## Goal

Extend the authoring-time contract-evidence checker (#366) so draft authors can ground
bindings on **field shape and presence** (not only literal values) and so **distinct
captures** grounding the same producer datum do not false-positive as conflicting
bindings. The anti-phantom guarantee must stay fail-closed: a shape assertion still
requires the field to exist in the committed capture and match the declared form.

```behavior-kind
action-producing
```

```contract-evidence
none
```

This draft changes the repo-owned validator and its fixture corpus — not an external
AO/gh/codex producer field. Grounding for the draft itself is via golden-sample /
contract-evidence test fixtures (input = the `contract-evidence` block format), not
capture rows against live producer output.

## Binding surface

- **Shape/presence predicates (additive).** Authors MUST be able to declare that a
  selector-resolved value in a committed capture is present and conforms to a named
  form — at minimum: non-empty string; integer; positive integer; boolean; present
  (any non-null/non-undefined resolved value). Predicate tokens and syntax are
  planner-chosen; this spec names only the **semantics** each form must enforce.
- **Literal equality preserved.** Existing rows whose `expected` is a concrete literal
  continue to pass/fail exactly as today (`String(value) === expected` semantics for
  scalars). Shape predicates are an additional `expected` interpretation, not a
  replacement.
- **Capture-aware canonical identity.** Conflict detection identity MUST be scoped
  to `(canonical producer, canonical datum, normalized evidence)` — not
  `(producer, datum)` alone. Two rows that share producer and datum (whether datum
  comes from `binding-id` or normalized `selector`) but reference **different**
  `evidence` captures MUST NOT be rejected as a binding conflict solely because
  of that evidence difference. Rows that share producer, datum, **and** capture
  but assert incompatible `expected` values (literal or predicate) MUST still
  conflict.
- **Binding-id uniqueness (orthogonal).** Within one `contract-evidence` block,
  each `binding-id` string MUST appear at most once. Reusing the same `binding-id`
  across rows is an authoring error independent of capture-aware identity — this
  preserves fail-closed discipline when an author double-books one binding name
  (today's `duplicate-identity-conflict` class; error class may change but verdict
  stays FAIL).
- **Literal vs predicate disambiguation.** Shape/presence predicates are drawn from
  a **closed reserved set** chosen by the planner. If `expected` matches a reserved
  predicate token, evaluate as predicate; otherwise evaluate as literal equality
  (today's behavior). A producer value that literally equals a predicate token
  MUST still be assertable via literal quoting or an escape rule the planner
  documents — the closed set MUST NOT subsume legitimate literal values without
  an escape path.
- **Structured capture rows only.** Shape/presence predicates apply only to
  structured `capture@` rows with a `selector`. Unstructured token rows, CLI-behavior
  rows, and `NEW(...)` rows keep today's literal / producer-emission semantics
  unchanged.
- **Fail-closed predicate semantics.** For any shape/presence predicate:
  - selector does not resolve / field absent in capture → **FAIL** (same as literal
    mismatch today);
  - field present but wrong type or violates the form (e.g. empty string for
    non-empty-string, `0` or negative for positive-integer, non-boolean for boolean,
    non-integral or string-encoded number for integer predicates)
    → **FAIL**;
  - field present and satisfies the form → **PASS**.
  A shape predicate is **not** an escape hatch: it cannot pass when the field is
  missing or the capture does not contain a conforming value.
- **Determinism and idempotence.** Running the checker twice on the same draft bytes
  and committed capture tree yields the same pass/fail verdict and diagnostics.

## Files in scope

- `scripts/contract-evidence.mjs` — predicate evaluation and capture-aware identity.
- `scripts/contract-evidence.test.ts` and fixtures under
  `tests/fixtures/draft-discipline/contract-evidence/` — golden samples for literal,
  predicate, multi-capture, binding-id reuse, literal/predicate disambiguation, and
  conflict scenarios; **reclassify** `duplicate-identity-conflict.md` if the failure
  diagnostic path changes while keeping verdict FAIL.
- Author-facing format documentation for the `expected` field (planner-chosen location:
  migration notes, inline help text, or a small doc under `docs/`).
- `scripts/check-draft-discipline.ps1` integration if the entrypoint needs a flag or
  message tweak (only if required for new diagnostics).

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**` — no AO core changes.
- Reviewer-time re-verification (#376 / draft 118) — consumes rows; must keep working
  but is not modified here unless a compatibility shim is strictly required.
- Legacy-list anti-tamper guard (#377 / draft 119) — separate build; must pass
  unchanged.
- Changing which drafts require a `contract-evidence` block or editing
  `contract-evidence-legacy-drafts.json`.
- Retroactively expanding `123a`/`123b` contract-evidence blocks — optional follow-up
  after this lands; not part of this issue's close criteria.

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `125-contract-evidence-shape-predicate-and-capture-aware-identity`.

```allowed-roots
scripts/**
tests/**
docs/**
```

## Operator adoption

None. Validator and CI only; no `agent-orchestrator.yaml` or daemon restart.

## Acceptance criteria

```positive-outcome
asserts: a draft whose contract-evidence block uses a shape predicate (e.g. non-empty string) on a selector that resolves in the committed capture passes check-draft-discipline contract-evidence; the same row with the field absent or an empty string at that selector fails
input: external-tool-output
provenance: sample-backed
```

```positive-outcome
asserts: a draft with two contract-evidence rows sharing the same producer and selector but different capture@ evidence refs and different literal expected values passes; the same two rows pointing at the same capture with different expected values fails with a binding conflict
input: external-tool-output
provenance: sample-backed
```

```positive-outcome
asserts: a draft that reuses the same binding-id string in two contract-evidence rows fails check-draft-discipline contract-evidence with a binding-id reuse diagnostic
input: external-tool-output
provenance: sample-backed
```

1. **Predicate pass — conforming capture.** Given a fixture draft and committed capture
   where selector `$.foo` resolves to a non-empty string, a row with
   `expected: <non-empty-string predicate>` passes.
2. **Predicate fail — absent field.** Same draft shape; capture lacks `$.foo` → FAIL
   with an actionable diagnostic (selector did not resolve / value mismatch class).
3. **Predicate fail — wrong form.** Field present but empty string for
   non-empty-string; non-integer for integer; zero/negative for positive-integer;
   non-boolean for boolean → FAIL each demonstrated by at least one fixture.
4. **Predicate fail — not an escape hatch.** A row cannot pass a shape predicate when
   the capture value is missing — provably distinct from "any expected passes."
5. **Literal regression.** Every contract-evidence fixture that **expects PASS**
   today still passes without modification (including `grounded-pass.md`,
   CLI-behavior fixtures, NEW-row fixtures, legacy-grandfather skip). Fail-fixtures
   that encoded the **false-positive** cross-capture identity bug (`duplicate-identity-conflict.md`)
   are **reclassified** — see AC6–AC7.
6. **Multi-capture non-conflict.** Two rows: same canonical `(producer, datum)` but
   **different** `evidence` captures and different literal `expected` values → PASS
   (no `conflicting binding assertion`). Fixture demonstrates selector-derived datum
   (distinct `binding-id` per row allowed) — the #123a class (live vs synthetic
   snapshot of the same selector).
7. **True conflict preserved — same capture.** Two rows: same canonical
   `(producer, datum, evidence)`, incompatible `expected` → FAIL with
   `conflicting binding assertion` (same class as
   `shared-evidence-conflicting-expected.md`).
8. **Binding-id reuse still fails.** Two rows sharing the same `binding-id` string
   in one block → FAIL (dedicated diagnostic; `duplicate-identity-conflict.md`
   remains a negative fixture — verdict FAIL, message may differ from today's
   identity-map path).
9. **Mixed block.** One draft block containing both literal and predicate rows → each
   row evaluated independently; aggregate pass only if all rows pass.
10. **Literal/predicate disambiguation.** Fixture: capture value is literally the
    string `true` (or another token in the reserved set); row with literal-quoted
    (or escape-documented) `expected` passes; unescaped reserved token evaluates
    as predicate per closed-set rules.
11. **Downstream compatibility.** `pwsh … check-draft-discipline.ps1 -Command contract-evidence`
    exits 0 on current `main` for drafts `123a`, `123b`, `119`, and `120` without
    editing those draft files.
12. **Legacy-list guard unaffected.** `npm test -- --run scripts/contract-evidence-legacy-list-guard.test.ts`
    passes without changes to #377 guard semantics.
13. **#118 compatibility note.** Reviewer-time re-verify (#376 / draft 118) is not
    modified here. If it literal-compares `expected` today, predicate rows remain
    valid spec text and any re-verify extension is a **separate follow-up** unless
    a minimal compatibility shim is strictly required to keep #118 from false-failing
    predicate rows (planner judges; not a default scope expansion).
### Scenario matrix (class coverage)

| Class | Capture | Row expected | Verdict |
|-------|---------|--------------|---------|
| A1 | field absent | literal | FAIL |
| A2 | field absent | shape predicate | FAIL |
| B1 | value matches literal | literal | PASS |
| B2 | value differs | literal | FAIL |
| C1 | conforming shape | shape predicate | PASS |
| C2 | wrong shape (empty, wrong type) | shape predicate | FAIL |
| C3 | numeric string where integer required | integer predicate | FAIL (fail-closed) |
| D1 | same producer+datum, **different** captures, different literals | literal each | PASS (no false conflict) |
| D2 | same producer+datum+**same** capture, different literals | literal | FAIL (conflict) |
| D3 | same `binding-id` string twice (any evidence) | any | FAIL (binding-id reuse) |
| E1 | mixed literal + predicate rows | mixed | per-row independent |
| F1 | reserved-token literal value | literal escape/quote | PASS |
| F2 | reserved-token literal value | unescaped reserved token | predicate path (not literal match) |

## Upgrade-safety check

Pack-only change under `scripts/**` and test fixtures. No new secrets, no AO YAML
schema, no vendor/core edits. Additive `expected` interpretation — existing drafts
must not require re-authoring.

## Verification

```powershell
npm test -- --run scripts/contract-evidence.test.ts
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/125-contract-evidence-shape-predicate-and-capture-aware-identity.md
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/125-contract-evidence-shape-predicate-and-capture-aware-identity.md
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/123a-review-pending-info-handoff-admission.md
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/123b-review-ready-report-state-seed-backstop.md
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/119-contract-evidence-legacy-list-anti-tamper.md
pwsh -NoProfile -File scripts/verify.ps1
```

## Decisions (design analysis)

### Prior art

| Source | What it settled | Relation to this draft |
|--------|-----------------|------------------------|
| #366 / draft 117 | Authoring gate, literal `expected`, identity `(producer, datum)`, fail-closed capture check | **Extends** — does not replace |
| #362 / draft 115 | Reviewer spec→diff mapping | **Compatible** — out of scope |
| #377 / draft 119 | Legacy-list anti-tamper | **Compatible** — out of scope |
| #376 / draft 118 | Reviewer-time producer-reality re-verify | **Downstream consumer** — rows may gain predicates; re-verify must understand them |
| #390 / #391 (123a/123b) | Deferred shape rows to tests; documented checker gap | **Motivation** — unblock optional future row expansion |
| `scripts/contract-evidence.test.ts` | Literal, CLI, NEW, identity-conflict fixtures | **Baseline** — must keep passing |

**Scope verdict:** extends #366 in one validator PR — not a duplicate of #366, #119,
or #118. No open draft covers these two checker gaps.

### Critical mechanics (current → required)

```
[draft contract-evidence block]
        |
        v
 parseContractEvidenceRows  -->  one row = key-value record
        |
        v
 canonicalBindingIdentity(producer, datum)   <-- evidence NOT in key today
        |
        v
 recordBindingIdentity  -->  conflict if same identity + incompatible assertions
        |                      (bindingAssertionsCompatible returns false when
        |                       prior.evidence !== row.evidence)
        |
        +--> [NEW] binding-id uniqueness (per block, orthogonal)
        v
 resolve capture@manifest  -->  selector  -->  valuesEqual (literal only)
                                              | predicate branch [NEW]
```

**Hole 1 — literal-only `valuesEqual`:** `String(value) === expected` for scalars;
no interpretation of `expected` as a type/shape token. Variable-value fields (session
id, PR number, SHA, timestamp) cannot be grounded without brittle over-binding.

**Hole 2 — evidence-blind identity:** `canonicalBindingIdentity` derives
`producer:datum` from `binding-id` or normalized `selector`, ignoring `evidence`.
`bindingAssertionsCompatible` treats differing `evidence` as incompatible. Two rows
about the same selector from **different** captures (e.g. live `review.pending` vs
synthetic `session.working`) false-positive as conflicts although they assert
different real producer states, not contradictory claims.

**Insertion points (WHAT, not HOW):** (a) an additive branch when evaluating
`expected` against selector-resolved capture values (including multi-match
`some()` semantics already used for literals); (b) extend canonical identity to
include normalized capture reference; (c) explicit per-block `binding-id` uniqueness
check so `duplicate-identity-conflict` stays FAIL without reintroducing false
cross-capture conflicts on distinct `binding-id` rows.

### World practices

| Approach | Used for | Relevance |
|----------|----------|-----------|
| JSON Schema (`type`, `minLength`, `minimum`) | API contract validation | Standard vocabulary for shape without fixed values; risk of importing a full schema engine |
| Pact / contract-test matchers (`like`, type matchers) | Consumer-driven contracts | Match structure, ignore variable instances — closest analog to our capture-backed rows |
| Golden-sample structural diff | Regression on captured CLI/JSON output | Already used in #223 / draft 76 for test fixtures; this draft applies the same *idea* at authoring time |
| OpenAPI / protobuf field presence | Service contracts | "Required field of type X" without fixing value |

Industry pattern: separate **value equality** (literals) from **structural
constraints** (type, non-empty, range) and key identity by **which snapshot** is
under test.

### Options (cost / risk / sufficiency)

| Option | Cost | Risk | Sufficiency | Verdict |
|--------|------|------|-------------|---------|
| **0 — Keep workaround** (shape checks only in recurrence tests; contract-evidence stays literal-only) | Lowest | Every live-capture draft repeats 123a/123b deferral; variable-value fields stay outside authoring gate; anti-phantom weaker for those fields | **Insufficient** — fixes the case, not the class | **Reject** |
| **1 — Minimal predicate vocabulary + capture-aware identity** (small reserved token set; extend identity with evidence; per-block binding-id uniqueness) | Medium (one validator + fixtures + doc) | Predicate token sprawl if unbounded; mitigated by closed minimal set + fail-closed semantics | **Sufficient** for current and foreseeable drafts | **Choose** |
| **2 — JSON Schema subset per row** | High (schema parser, errors, author ergonomics) | Over-engineering; authors must learn schema; reviewer/#118 coupling | More than needed | **Reject** |
| **3 — Reference only** (document literals as intentional; no code change) | Zero | Does not fix either hole | **Insufficient** | **Reject** |

**Cost-rule verdict: build option 1.** Cheapest executor that closes both structural
holes with acceptable risk given `contract-evidence.test.ts` + Codex review as safety
net. Option 0 is cheaper today but externalizes cost to every future draft author.

### Task decomposition

Single-PR build: one validator module, fixture corpus, format documentation. No split
unless implementation discovers an independent reviewer-axis change (unlikely — #362
maps spec text to diff; predicate rows remain spec text).

## Architect review (3 passes)

### Pass 1 — findings

| ID | Severity | Finding | Verdict |
|----|----------|---------|---------|
| P1-1 | P1 | AC5 «all fixtures unchanged» contradicts `duplicate-identity-conflict.md` — that fixture encodes today's false-positive (different evidence → identity conflict) | **Accept** → AC5 split pass vs fail fixtures; AC8 binding-id reuse |
| P1-2 | P1 | Identity scoped to `producer+selector` is wrong when `binding-id` supplies datum (draft 120 pattern) | **Accept** → `producer+datum+capture` |
| P1-3 | P1 | No rule for literal value colliding with predicate token (e.g. string `"true"`) | **Accept** → closed reserved set + escape path (AC10, F1/F2) |
| P1-4 | P2 | Predicates on unstructured/CLI/NEW rows unspecified | **Accept** → structured-only binding surface |
| P1-5 | P2 | #118 may literal-compare `expected` — scope creep risk | **Accept** → AC13 explicit follow-up default |

### Pass 2 — findings

| ID | Severity | Finding | Verdict |
|----|----------|---------|---------|
| P2-1 | P1 | Integer predicate vs JSON string number (`"42"`) unspecified | **Accept** → fail-closed C3 + binding surface |
| P2-2 | P2 | Selector multi-match behavior for predicates unstated | **Accept** → inherit literal `some()` semantics in mechanics |
| P2-3 | P2 | Missing positive-outcome for binding-id reuse | **Accept** → third positive-outcome block |
| P2-4 | P2 | Fixture reclassification not in Files in scope | **Accept** → explicit in scope list |

### Pass 3 — findings

| ID | Severity | Finding | Verdict |
|----|----------|---------|---------|
| P3-1 | P2 | `binding-id` uniqueness is additive behavior not in user brief | **Accept** — necessary so capture-aware identity does not turn `duplicate-identity-conflict` into a false PASS; orthogonal to hole 2 |
| P3-2 | P3 | «literal-quoted» slightly prescriptive | **Partial** — escape mechanism is planner-owned; spec requires *some* path, not a syntax |
| P3-3 | — | Residual: optional follow-up to expand 123a/123b rows post-merge | **Reject bind** — already out of scope; stays optional follow-up |

**Convergence:** pass 3 — no open P1; mechanical checks PASS. No further full passes planned.

## Decision log

- **2026-06-22 — Grounding (code inspection).** `valuesEqual` (contract-evidence.mjs
  ~486–493): literal `String(value) === expected` only. `canonicalBindingIdentity`
  (~273–286): `producer:datum` without evidence. `recordBindingIdentity` (~261–269):
  `bindingAssertionsCompatible` returns false when `prior.evidence !== row.evidence`,
  producing `conflicting binding assertion` for same producer+selector across captures.
- **2026-06-22 — 123a deferral.** Draft 123a explicitly moved wire-shape assertions to
  recurrence tests and pointed checker shape-predicate gap to this follow-up.
- **2026-06-22 — Chosen option 1.** Minimal closed predicate set + capture-aware
  identity; reject workaround-only (option 0) as class-insufficient.
- **2026-06-22 — Architect review (3 passes).** P1-1..P1-5, P2-1..P2-4, P3-1..P3-3
  resolved; see **Architect review** section. Key additive: per-block `binding-id`
  uniqueness preserves `duplicate-identity-conflict` FAIL without reintroducing
  cross-capture false conflicts on distinct binding-ids.
