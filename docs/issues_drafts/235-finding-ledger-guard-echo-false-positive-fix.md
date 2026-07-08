# Fix finding-ledger guard false-positives on echoed review-prompt / contract-evidence text

GitHub Issue: #679

## Problem / Goal

`scripts/finding-ledger-guard.mjs` (`checkFindingLedgerGuard`, imported by
`scripts/lib/tier-gate-floor.ts` finding-ledger floor and wrapped by
`scripts/check-finding-ledger-guard.ps1`) extracts "reviewer findings" by regex-scanning the
**entire** text of each `*.capture.txt`. Review captures echo the review **prompt/rubric** and the
**draft body** verbatim, so the scanner treats non-findings as findings and fail-closes the publish
tier-gate on essentially every draft whose captures carry prose:

- **Contract-evidence echoes:** an echoed ` ```contract-evidence ` fence contains
  `binding-id: ao:datum:…` / `binding-type: structured|unstructured|cli-behavior`. The `\bid:` /
  `\btype:` regexes parse these as findings `ao` / `orchestrator-pack` with conflicting types across
  passes. Producer bindings are **not** reviewer findings.
- **Rubric / draft echoes:** the review rubric literally contains instructional `type: security`,
  `type: scope-violation`, and the words `denylist` / `allowed_roots` / `out of scope` (as tagging
  guidance), and the echoed draft body contains its own ` ```denylist ` fence and "Files out of
  scope" heading. The scanner flags these as protected findings needing ledger rows.

Second defect: `scripts/check-finding-ledger-guard.ps1` was observed printing violations while
returning **exit 0** on a corpus where `node scripts/finding-ledger-guard.mjs` returns **1**
(false green) — this misled a draft-author into reporting the ledger "GREEN".

**Goal:** the guard extracts findings ONLY from a capture's actual reviewer-findings content — not
from echoed rubric/prompt boilerplate, echoed draft body, or fenced blocks (` ```contract-evidence `,
` ```denylist `, ` ```allowed-roots `, other draft/spec fences). Genuine `security` /
`scope-violation` reviewer findings are still caught. The `.ps1` wrapper exit code mirrors the
`.mjs`.

**Context (workaround in place, not a fix):** draft 224 (#678) was synced by compressing its review
captures to header+verdict to sidestep this false-positive — the prescribed capture norm. This issue
removes the need for that workaround by fixing the parser.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

> **Tier note:** the publish tier-marker-screen false-fires red-flag markers `durable-state-evidence`
> (regex `\bledgers?\b`) and `ci-review-gating` (`\bgating\b`) on the *vocabulary* of this bug
> ("ledger", "gating") and would force T3 — the same over-aggressive-keyword class this fix targets.
> This is a contained single-module bug fix (T2). The issue was created via the sanctioned publish
> fallback rather than paper the false-forced T3 ceremony onto a regex fix.

## Binding surface

Pack-owned guard scripts only; no AO core, no contract change to how reviewers author findings
(genuine typed findings are still recognized). The parser gains a scoping rule; the wrapper gains
correct exit propagation.

```positive-outcome
asserts: finding-ledger-guard.mjs exits 0 on a capture that echoes a ```contract-evidence fence and the review rubric (with example `type: security` / `out of scope`) but contains no real reviewer finding; and exits non-zero on a capture with a genuine reviewer `type: security` finding absent from the ledger
input: realistic
```

## Fix-the-class scenario matrix (author must enumerate + test)

1. Capture echoing a ` ```contract-evidence ` fence (`binding-id:`/`binding-type:`) → **no** phantom
   findings.
2. Capture echoing the review rubric containing example `type: security` / `type: scope-violation` /
   words `denylist` / `out of scope` → **no** phantom findings.
3. Capture with a REAL reviewer `type: security` finding → **still caught**; must be ledgered.
4. Capture with a REAL `type: scope-violation` finding → **still caught**.
5. Capture echoing the draft body (own ` ```denylist ` fence + "Files out of scope" heading) → **no**
   phantom scope-violation.
6. `.ps1` wrapper on a failing corpus → **non-zero exit** (mirrors `.mjs`); clean corpus → exit 0.

## Files in scope

- `scripts/finding-ledger-guard.mjs` — scope finding extraction to real findings; skip echoed
  rubric/prompt/draft/fenced-block text.
- `scripts/check-finding-ledger-guard.ps1` — exit-code propagation mirrors the `.mjs`.
- `scripts/lib/tier-gate-floor.ts` — only if the floor wiring needs it (it imports
  `checkFindingLedgerGuard`; prefer fixing at the source).
- `scripts/finding-ledger-guard.test.ts` (or the planner's test path) — scenario-matrix coverage.

## Files out of scope

- Draft 224's ledger/captures content and its #678 sync (done via the header+verdict workaround).
- `publish-issue-body-sync` parity fail-close behavior — tracked separately as **#665**.
- The tier-marker-screen vocabulary false-fire (`durable-state-evidence`/`ci-review-gating` on words)
  — adjacent same-class defect; may be a follow-up, not this PR.
- AO core, `vendor/**`, `packages/core/**`.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
docs/declarations/**
```

```allowed-roots
scripts/**
tests/**
```

## Acceptance criteria

1. **Echoed contract-evidence produces no findings.** A capture containing an echoed
   ` ```contract-evidence ` fence (`binding-id:`/`binding-type:` lines) yields zero parsed findings;
   `node scripts/finding-ledger-guard.mjs` does not flag `ao`/`orchestrator-pack` conflicting types
   from such echoes.
2. **Echoed rubric/draft produces no findings.** A capture echoing the review rubric (example
   `type: security` / `type: scope-violation`) or the draft body (own ` ```denylist ` fence, "Files
   out of scope" heading) yields zero protected-signal findings.
3. **Genuine findings still caught.** A capture with a real reviewer `type: security` or
   `type: scope-violation` finding absent from the ledger still fails the guard (no regression in
   true-positive detection).
4. **`.ps1` exit parity.** `check-finding-ledger-guard.ps1` returns the same exit code as
   `node scripts/finding-ledger-guard.mjs` on the same inputs (non-zero on violations, 0 on clean).
5. **Scenario-matrix tests.** All six scenarios above are covered by tests that fail before the fix
   and pass after (red-then-green).
6. **No over-block regression.** Running the fixed guard against an existing real converged review
   corpus (e.g. a header+verdict corpus) passes; against a corpus with a genuinely un-ledgered
   security finding, fails.

```contract-evidence
none
```

This is a pack-internal guard bug fix; it binds no new external producer datum. Enforceable content
is the parser scoping + wrapper exit behavior, proven by the scenario-matrix tests.

## Verification

- `node scripts/finding-ledger-guard.mjs --ledger <fixture-ledger> --captures-dir <fixture-captures>`
  red-then-green across the scenario matrix.
- `pwsh -NoProfile -File scripts/check-finding-ledger-guard.ps1 -CapturesDir <dir> -LedgerPath <ledger>`
  exit code matches the `.mjs` (AC#4).
- `pwsh -NoProfile -File ./scripts/verify.ps1` and `./scripts/test-all.ps1` green.

## Decisions

- **Contained T2 single-module fix** — one guard + its wrapper + tests; no reviewer-authoring
  contract change (typed findings still recognized).
- **Created via publish fallback** — the tier-marker-screen false-forces T3 on the words
  "ledger"/"gating" (the same over-parse class being fixed); running full T3 adversarial/design
  ceremony on a regex fix is disproportionate. Recorded transparently.
- **Adjacent same-class defects:** parity fail-close = **#665** (existing); tier-marker-screen
  vocabulary false-fire = possible follow-up. This PR fixes the finding-ledger parser + wrapper only.
- **Workaround stays valid** — header+verdict captures remain the capture norm regardless; this fix
  makes prose-carrying captures no longer catastrophic.
