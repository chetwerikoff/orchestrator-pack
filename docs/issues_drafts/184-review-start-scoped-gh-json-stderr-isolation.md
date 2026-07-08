# Review-start scoped gh JSON capture must isolate stderr
GitHub Issue: [#566](https://github.com/chetwerikoff/orchestrator-pack/issues/566)

## Prerequisite

- `docs/issues_drafts/170-orchestrator-command-runtime-bootstrap-contract.md`
  (GitHub #532, closed by PR #533) shipped the general autonomous command-runtime
  bootstrap/preflight contract: validate `pwsh`, `node`, pack `scripts/gh`,
  native `gh`, PATH, and structured-output stderr safety before side effects.
  This draft does not rebuild that runtime preflight; it closes the missed
  review-start scoped PR/head lookup class that still mixed stderr into JSON
  parsing after #532.
- `docs/issues_drafts/160-gh-rest-allowlist-review-forms-and-universal-wrapper-rule.md`
  (GitHub #501, closed by PR #503) shipped the rule that GitHub reads go through
  pack `scripts/gh` and inventory-listed canonical forms. This draft keeps that
  transport contract and adds parse isolation for the scoped review-start read.
- `docs/issues_drafts/120-event-driven-review-trigger-on-ready-for-review-handoff.md`
  (GitHub #381, shipped) and
  `docs/issues_drafts/58-safe-review-trigger-reconciliation.md` (GitHub #163,
  shipped) own automated review-start eligibility after worker
  `ready_for_review`. This draft does not change readiness semantics; it
  prevents a valid ready head from being starved by polluted GitHub JSON capture.

**Prior-art verdict:** **Extends shipped #532/#501/#381/#163**. Existing work
covers command-runtime bootstrap, gh REST routing, and review-start readiness.
The recurrence on 2026-07-01 showed a narrower uncovered surface: the scoped
PR/head lookup used before a claimed review start can still collapse to
`head_resolution_failed` when wrapper or shell diagnostics are merged into the
JSON stream.

**Incident note (2026-07-01):** PR #565 / worker `opk-121` reported
`ready_for_review` again after fixing the first review finding. GitHub showed
the PR open, mergeable, current head `31fc8c6143c23e6db1b47fa8525aced110e2f84e`,
and 17/17 green checks, but the autonomous review start denied before claim with
`head_resolution_failed`. The observed failure text included bash debugger
stderr (`/usr/share/bashdb/... No such file or directory`) merged into the
PowerShell command output before JSON parsing.

**Knowledge-base note:** Local wiki notes `Baseline`, `Fault tolerance`, and
`Commit stage` reinforce the relevant principles: command environments should
be reproducible, partial failures should produce bounded diagnostics instead of
silent service loss, and CI/fixtures should catch the regression at commit time.
Synto returned no relevant article/source segment.

## Goal

Make the review-start scoped GitHub PR/head lookup stderr-safe and liveness-safe
so a worker that has handed off a green, current `ready_for_review` head is not
left awaiting external review merely because shell or wrapper diagnostics
polluted a JSON-producing `gh` read.

```behavior-kind
action-producing
```

## Binding surface

- The scoped open-PR/head lookup used by autonomous review-start entry points
  before they acquire the review-start claim.
- The structured-output contract for JSON-producing GitHub reads in that path:
  stdout JSON is the only parse input; stderr remains separate evidence and may
  produce a deterministic infrastructure denial.
- Review-start liveness after a recoverable head-read infrastructure failure:
  a green, current, uncovered ready head must be re-evaluated by the next
  eligible trigger/reconcile turn, not permanently treated as covered or
  operator-only.
- Operator-visible diagnostics for this class must distinguish "PR/head does not
  exist or is not open" from "GitHub read output was polluted/unparseable".

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/**`
- `prompts/**` only for operator-facing diagnostic/runbook wording if needed

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- `.agent-orchestrator/**`
- Local shell dotfiles, machine-local secrets, and credential stores
- New GitHub transport routes unrelated to the review-start scoped PR/head read
- Changing review readiness semantics, CI required-check semantics, or reviewer
  execution behavior
- Worker cleanup/respawn recovery

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
node_modules/**
```

```allowed-roots
scripts/**
docs/**
tests/**
prompts/**
```

## Acceptance criteria

1. **Scoped review-start PR/head lookup parses stdout JSON only.** A regression
   fixture feeds the review-start scoped GitHub read path a valid PR JSON stdout
   stream plus independent stderr text matching the observed bash-debugger
   warning class. The path resolves the current open PR head from stdout and
   does not pass the combined streams to JSON parsing.

```producer-emission
producer: orchestrator-pack
datum: review-start-scoped-gh-json-capture
expected: stdout-only-parse-with-independent-stderr
proof-command: implementation-specific focused review-start gh capture fixture
```

2. **Polluted or malformed stdout is a deterministic infrastructure denial, not
   a fake missing PR.** A fixture where stdout itself is not valid JSON, or where
   no parseable PR object can be obtained, produces a stable diagnostic such as
   `structured_output_polluted` or an equivalent infrastructure-read reason.
   It must not silently return an empty open-PR list indistinguishable from a
   closed/missing PR.

```producer-emission
producer: orchestrator-pack
datum: review-start-scoped-gh-json-capture
expected: malformed-json-infra-denial-not-empty-pr-list
proof-command: implementation-specific focused malformed stdout fixture
```

3. **Ready green head still starts after harmless stderr.** Given a realistic
   snapshot where a worker is idle after `ready_for_review`, the PR is open, CI
   is green, the current head is uncovered, and the GitHub PR read emits valid
   stdout plus harmless stderr, the autonomous review-start gate reaches the
   review-run start path for that head instead of returning
   `head_resolution_failed`.

```positive-outcome
asserts: valid stdout PR/head JSON plus harmless stderr still leads to a review-start attempt for a green uncovered ready head
input: external-tool-output
provenance: sample-backed
```

```producer-emission
producer: orchestrator-pack
datum: review-start-scoped-gh-json-capture
expected: ready-head-starts-with-stderr
proof-command: implementation-specific focused ready-head review-start fixture
```

4. **Recoverable read failures are re-evaluable.** A transient infrastructure
   denial from the scoped GitHub read records enough reason/provenance for
   operator diagnosis and allows the next eligible trigger/reconcile turn to
   re-read the current PR head. The failure must not create a covered-head row,
   consume a review-start claim, or suppress future attempts for the same head.

5. **Diagnostics preserve the useful distinction.** Verification shows separate
   observable outcomes for: open PR with valid stdout and stderr warning; closed
   or missing PR; malformed/polluted stdout; and `gh` command failure. The
   operator-facing status must not collapse all four into bare
   `head_resolution_failed`.

6. **No workaround path is introduced.** The implementation must not add raw
   `curl`, `gh api graphql`, temporary `gh` shims, shell-dotfile edits,
   `unset GH_WRAPPER_ACTIVE`, or a direct REST branch outside the existing pack
   `scripts/gh` inventory architecture.

```contract-evidence
binding-id: orchestrator-pack:review-start-scoped-gh-json-capture:stdout-only-parse-with-independent-stderr
binding-type: cli-behavior
binding: review-start scoped GitHub PR/head lookup parses stdout JSON separately from stderr
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:review-start-scoped-gh-json-capture:malformed-json-infra-denial-not-empty-pr-list
binding-type: cli-behavior
binding: malformed or polluted scoped GitHub JSON read reports infrastructure denial instead of fake empty PR list
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:review-start-scoped-gh-json-capture:ready-head-starts-with-stderr
binding-type: cli-behavior
binding: harmless stderr alongside valid PR/head stdout does not block review-start for a green uncovered ready head
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
```

## Upgrade-safety check

- No edits to Composio AO core or vendored packages.
- No local shell profile, credential, or machine-local secret changes.
- The pack `scripts/gh` REST-wrapper and inventory architecture remain the only
  durable GitHub read transport.
- The issue does not broaden autonomous recovery, git, spawn, or worker-message
  permissions.
- Diagnostics may include sanitized command class, PR number, exit status, and
  stderr tail, but must not leak secrets or raw credential-bearing environment
  values.

## Verification

- Focused fixture proving AC#1 with valid PR JSON stdout plus bash-debugger-style
  stderr.
- Focused fixture proving AC#2 with malformed stdout / unparseable PR object.
- Review-start gate fixture proving AC#3 on a green, uncovered,
  `ready_for_review` head.
- Reconcile or claim-lifecycle regression proving AC#4.
- Diagnostic matrix fixture proving AC#5.
- Static or focused guard proving AC#6.
- `npx vitest run` for any new JS/TS tests added under `scripts/**` or `docs/**`.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/184-review-start-scoped-gh-json-stderr-isolation.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/184-review-start-scoped-gh-json-stderr-isolation.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Prior art

The repo already shipped command-runtime bootstrap (#532), REST-wrapper routing
(#431/#501/#520), and review-start readiness gates (#163/#195/#381). The missed
class is narrower than a new runtime framework: a JSON-producing scoped GitHub
read inside the review-start pre-claim path still used a stream shape where
stderr could poison head resolution.

### Design options

| Option | Trade-off | Decision |
|---|---|---|
| A. Reopen/rewrite #532 | Captures the general principle but repeats a closed broad contract and risks hiding the specific recurrence in already-shipped work | Rejected |
| B. Add only an operator manual-review runbook note | Fast unblock, but it preserves silent starvation for the next ready head | Rejected |
| C. Add a narrow follow-up for review-start scoped GitHub JSON capture | Smallest sufficient fix: one class, clear fixtures, builds on shipped runtime and review-start contracts | Chosen |
| D. Change readiness or claim logic to ignore head-resolution failures | Could force progress, but risks starting reviews on stale or wrong heads | Rejected |

### Scenario matrix

| Case | GitHub read output | PR/head state | Expected outcome |
|---|---|---|---|
| 1 | Valid stdout JSON, empty stderr | Open current PR | Head resolved normally |
| 2 | Valid stdout JSON, harmless stderr warning | Open current PR | Head resolved; ready green uncovered head may start review |
| 3 | Malformed stdout | Unknown | Deterministic infrastructure denial, no fake empty PR |
| 4 | Non-zero `gh` command failure | Unknown | Deterministic infrastructure denial with sanitized evidence |
| 5 | Valid JSON for closed/missing PR | Not open | Review not started as a real PR-state denial |
| 6 | Transient infrastructure denial then later valid read | Open current PR | Later eligible turn re-evaluates; no claim consumed by failed read |
