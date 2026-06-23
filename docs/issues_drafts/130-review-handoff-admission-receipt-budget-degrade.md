# Handoff admission must degrade on lookup failure without exhausting receipt budget

GitHub Issue: #418

## Prerequisite

- `docs/issues_drafts/123a-review-pending-info-handoff-admission.md` (GitHub **#390**,
  merged) — admits `review.pending` / `ready_for_review` handoff envelopes through
  identity admission. **Gap:** retryable `admission_lookup_unknown` on GitHub lookup
  failure re-invokes open-PR fetch on every pending-retry tick until
  `handoff_receipt_bound_exceeded`, blocking poll/seed backstops for minutes.
- `docs/issues_drafts/123b-review-ready-report-state-seed-backstop.md` (GitHub **#391**,
  merged) — co-primary poll path when handoff does not complete. This issue keeps
  seed eligible while handoff is lookup-degraded.

## Sibling

- `docs/issues_drafts/129-review-start-claim-liveness-reaper.md` (GitHub **#417**) —
  claim lifecycle (hold budget, liveness reaper, post-run visibility). **Independent
  time segment** in PR #407 incident (~9 min claim hold vs ~14 min handoff receipt
  burn). Ship in either order; no hard prerequisite either way.

## Prior-art recon

| Source | Settled | Gap |
|--------|---------|-----|
| **#390** | Handoff admission + retryable lookup unknown | No fail-fast/backoff on repeated identical lookup failures; receipt budget consumed by retry loop |
| **#381** | ≤30s receipt→run bound when handoff succeeds | Bound applies to receipt window, not degraded lookup path |
| **#417 (sibling)** | Claim I/O hold | Listener receipt loop is separate surface |

**Decomposition:** Node admission filter (`*.mjs`) + listener pending-retry loop vs
PowerShell claim module — **single-runtime PR** each.

## Goal

When handoff identity admission fails with retryable `admission_lookup_unknown` because
a supervised lookup (open PR list, session list, or supervised-repo metadata) failed,
the listener must **not** spend the full handoff receipt retry budget re-attempting the
same failing lookup every tick. Poll/seed backstops (#391) must remain able to start
review within the #381 latency target while lookups are degraded. Structured audit must
identify **which** lookup dimension failed.

```behavior-kind
action-producing
```

```contract-evidence
none
```

Evidence: listener logs (`admission_lookup_unknown`, `handoff_receipt_bound_exceeded`),
`docs/review-handoff-wake-admission.mjs` (three lookup flags), pending-retry loop in
handoff admission state helper. PR #407: ~14 min receipt burn before seed took claim.

## Binding surface

**Re-used:** #390 admission predicates, #381 receipt bound when handoff trigger runs,
#391 seed eligibility unchanged.

**Added:**

- On retryable `admission_lookup_unknown` caused by a lookup failure, pending-retry
  processing must **not** tight-loop identical failing lookups every tick until receipt
  exhaustion. Observable limits (planner owns mechanism): bounded retry count per
  receipt for the same failure identity, minimum spacing between identical retries,
  and receipt budget preserved for poll/seed yield — not consumed solely by repeated
  identical lookup errors.
- Receipt budget must not be the **only** path that yields to poll/seed — degraded
  handoff must not starve #391 for minutes when readiness is otherwise satisfied.
- Audit row per admission attempt must record which lookup dimension failed (open PR /
  session / supervised repo) — today all collapse to one reason string.

## Files in scope

- Handoff wake admission runtime: admission filter, listener pending-retry path,
  admission state helper, and their tests/fixtures (planner picks exact paths within
  allowed roots).

## Files out of scope

- Review-start claim lifecycle (#417).
- Repo-wide GitHub API rate-limit budget.
- AO webhook payload / priority semantics.

## Denylist

```denylist
# handoff admission receipt degrade
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

**Allowed roots:** same pack envelope as merged #390 — `scripts/**`, `plugins/**`, `docs/**`, `tests/external-output-references/**`.

## Acceptance criteria

- Fixture: `openPrLookupFailed` (or rate-limit) on first handoff attempt → ≤3
  identical attempts, ≥10s spacing, receipt budget **not** exhausted solely by
  repeated identical lookup errors; audit names `openPr` dimension.
- Fixture: `sessionLookupFailed` and `supervisedRepoLookupFailed` each → backoff +
  audit names the failing dimension (not collapsed to one reason string).
- Fixture: from **first retryable `admission_lookup_unknown`** on a qualifying
  handoff receipt to **automated review run start** (seed or other eligible path) ≤30s
  when readiness is otherwise satisfied (CI green, accepted report) — clock anchor
  matches #381-style measurability.
  **Seed runs in parallel:** poll/seed eligibility is not gated on handoff retry
  exhaustion; the ≤30s bound is met by the concurrent seed path (e.g. ~5s cadence),
  while handoff retry limits independently preserve receipt budget.
- Regression: successful lookups → handoff still triggers review within ≤30s (#381).

```positive-outcome
asserts: repeated admission_lookup_unknown from the same lookup failure does not exhaust the handoff receipt budget before poll/seed can start review when readiness is otherwise satisfied
input: realistic
```

## Verification

- Replay PR #407 handoff segment: receipt not exhausted at ~14 min solely on identical
  lookup retries; seed eligible earlier.
- Unit fixture on pending-retry loop: lookup failure → backoff, not tight-loop gh fetch.

## Decisions

**Incident segment:** 07:37:52–07:51:13 `admission_lookup_unknown` retries;
`handoff_receipt_bound_exceeded` at 07:51:13 — independent of 07:51:23 seed claim.

**Chosen:** backoff + fail-fast within receipt; do not couple to claim reaper (#417).

## Related

- GitHub **#390**, **#391**, **#381**, sibling **#417** (`129-review-start-claim-liveness-reaper.md`).
