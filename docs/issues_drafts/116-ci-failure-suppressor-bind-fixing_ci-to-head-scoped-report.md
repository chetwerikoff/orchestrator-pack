# CI-failure suppressor must read fixing_ci from the head-scoped worker report, not session.status

GitHub Issue: #363

## Prerequisite

All merged; this draft **extends** #342 — it does not replace it. It fixes the
gap between #342's spec and what PR #344 actually shipped.

- `docs/issues_drafts/110-ci-failure-ping-suppress-on-live-worker-state.md`
  (GitHub #342, merged via PR #344) — specs the CI-failure ping suppressor that
  must `SUPPRESS` when the **live PR-owning worker is in `fixing_ci`**, evaluated
  once at delivery, with the full episode lifecycle (enqueue-only reaction,
  supersede-before-suppress precedence, strict outbox, atomic terminalization).
  **#342's own acceptance criteria already required** that the predicate consume
  *"exactly the shape the real AO session/lifecycle reader emits, captured as a
  golden snapshot (not a hand-shaped schema)"* with a schema-conformance test for
  *"a renamed / missing / re-nested field."* **This draft fixes the cell #344
  left open: the shipped predicate reads the wrong field and the shipped fixtures
  are hand-shaped, so the suppress path is structurally unreachable for a real AO
  0.9.x snapshot while the tests stay green.**
- `docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md`
  (GitHub #223, merged) — the capture-backed golden-sample field-shape guard with
  phantom-field detection. **This draft must make #342's live-worker fixture
  actually capture-backed under #223's guard**, so a hand-invented session shape
  can no longer pass the suppress-path tests.
- `docs/issues_drafts/110-...` cites #283 (GitHub #283, merged) — the prior
  reaction-event suppressor whose episode-keyed binding #342 deliberately replaced
  with a live-worker-state read. This draft keeps that replacement; it only
  corrects *where in the live worker record* the `fixing_ci` signal is read.

## Goal

A CI-failure ping is suppressed when the live PR-owning worker is actually fixing
CI, on the **real** AO session snapshot shape — not only on a hand-invented one.
Today the suppressor's `fixing_ci` read binds to a session-level status field that
a real AO 0.9.x snapshot never carries (`session.status` is `stuck` / `pr_open`,
and the worker's `fixing_ci` lives in its per-head report history), so the live
worker is never recognised as fixing and the ping is sent anyway. After this
change the suppressor recognises `fixing_ci` from the worker's report for the
episode's head, the suppress path is reachable on a captured production snapshot,
and the test suite proves it on that captured shape rather than a synthetic one.

```behavior-kind
action-producing
```

## Binding surface

What the repository commits to (contracts, not implementation):

- The live-worker `fixing_ci` signal is resolved from the **most recent report
  bound to the episode's head**, as it appears in the real AO session snapshot —
  not from a session-level status field, and not from a blind
  last-element-of-the-array read. Whatever field path the real snapshot uses to
  carry `fixing_ci`, the predicate reads it from there. (In the captured
  production shape this is the worker's per-head report `reportState`, while the
  session-level status is an unrelated lifecycle label such as `stuck` /
  `pr_open`.)
- **Recency among same-head reports is decisive, via the existing repo ordering
  contract:** when the report history holds several entries for the episode's
  head, the **latest** one is authoritative. Recency follows the **same AO 0.9.x
  chronological-emission-order normalization the repo already uses to resolve the
  head-ready report** (the established `findLatestReportForHead` /
  reverse-to-chronological convention — AO emits reports newest-first in the array,
  so naive array-tail selection is wrong) — this draft **reuses** that ordering
  rather than introducing a second, divergent one or a bespoke timestamp scan. An
  older `fixing_ci` superseded by a newer non-`fixing_ci` report for the *same*
  head (e.g. a later `started` / `ready_for_review` / `pr_open`) means the worker
  is no longer fixing — it must **not** suppress. Only a head whose latest report
  under that normalization is `fixing_ci` suppresses. If two same-head reports are
  genuinely indistinguishable in emission order, resolve toward **not**
  suppressing (deliver), so an ambiguous capture cannot silence a real CI failure.
- The signal is **head-scoped**: a `fixing_ci` report bound to a *different* head
  than the episode's must not, on its own, suppress that episode. The existing
  supersede-before-suppress precedence from #342 is preserved (a head/generation
  advance still terminalizes `abandoned-superseded` before any worker-state
  suppressor runs).
- All other #342 lifecycle invariants are unchanged: enqueue-only reaction,
  single atomic delivery-time evaluation, strict outbox
  (`pending → claimed/preflight → submit-intent-reserved → …`), and live-state
  suppression allowed **only pre-intent**. The **full inherited terminal-reason
  precedence is preserved exactly as #342 defines it** — the safe-suppress
  short-circuits (`helper_error_safe_suppress`,
  `ci_source_disagreement_safe_suppress`) first, then `abandoned-superseded`, then
  `suppressed-dedup` (the reaction's observable event), then
  `suppressed-intent-token`, then `suppressed-live-worker`, then
  `abandoned-no-live-owner`, then `sent`. This draft must **not** reorder where
  `suppressed-live-worker` sits relative to dedup/intent-token; it only corrects
  *how* the `fixing_ci` signal feeding the `suppressed-live-worker` branch is read.
  Positive liveness probe (a zombie `cleanup` session is not a valid owner),
  freshness SLA / expiry, and atomic compare-and-set terminalization are likewise
  unchanged.
- The live-worker fixture(s) backing the suppress path become **capture-backed**
  under the #223 field-shape guard: sanitized snapshots of the real
  session/lifecycle reader output, carrying only the fields the predicate
  consumes — no secrets, tokens, absolute paths, env values, or `.ao` payloads.
- Any predicate code path that exists to read the worker's `fixing_ci` report but
  is not reachable from the live delivery-time decision is either wired into that
  decision or removed — no dead binding that gives a false impression of coverage.

## Files in scope

- The CI-failure-notification decision/suppressor module(s) under `docs/`
  (the predicate that resolves the live PR-owning worker's `fixing_ci` state and
  emits the terminal action) and any shared session-report-state normalizer it
  depends on.
- The PowerShell reconcile wrapper / decide entrypoint under `scripts/` that
  feeds the live session snapshot to the predicate, if the snapshot it passes
  omits the per-head report history the corrected predicate needs.
- The CI-failure-notification tests and their fixtures under `scripts/`
  (`*.test.ts` + fixture JSON) — replace/augment the hand-shaped live-worker
  fixtures with capture-backed ones.
- Adoption check script(s) for this path under `scripts/` only if their assertion
  encodes the wrong session shape.

## Files out of scope

- `agent-orchestrator.yaml.example` reaction/orchestratorRules wiring (the
  reaction contract from #342 is unchanged).
- Any review / ci-green / worker-message reconcile path not involved in the
  CI-failure ping decision.
- `packages/core/**`, `vendor/**`, `.ao/**`.

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
docs/**
scripts/**
```

## Acceptance criteria

- On a captured real AO session snapshot where the PR-owning worker's
  session-level status is a non-`fixing_ci` lifecycle label (e.g. `stuck` /
  `pr_open`) **and** the worker's report for the episode's head carries
  `fixing_ci`, the suppressor terminalizes the episode as `SUPPRESS` with the
  `suppressed-live-worker` audit reason — not `SEND` / `no_suppressor`.
- The corresponding live-worker fixture is capture-backed and passes the #223
  field-shape guard (only consumed fields, sanitized); a hand-invented
  `status: 'fixing_ci'`-only session no longer stands in for the real shape on the
  suppress path.
- **Same-head recency transition:** when the worker's report history for the
  episode's head contains an older `fixing_ci` followed by a newer non-`fixing_ci`
  report (e.g. `started` / `ready_for_review` / `pr_open`), the episode does
  **not** produce `suppressed-live-worker` — it terminalizes `SEND` /
  `no_suppressor` (assuming no other suppressor matches), because the latest
  report for that head, not any historical `fixing_ci`, is authoritative.
- **Stale-head `fixing_ci`, episode head still current:** when the live worker's
  only `fixing_ci` report is bound to a head *older* than — and different from —
  the episode's head, and no `fixing_ci` report exists for the episode's own head,
  the suppressor does **not** produce `suppressed-live-worker`; the episode
  terminalizes `SEND` with the `no_suppressor` audit reason (assuming no other
  suppressor matches). A stale-head report must not stand in for the current head.
- **Episode head superseded:** when the PR head (or target generation) has
  advanced past the episode's head, the episode terminalizes `SUPPRESS` with the
  `abandoned-superseded` audit reason, decided **before** the worker-state
  suppressor runs (existing #342 precedence, asserted here as a separate fixture
  from the stale-head case above).
- When the field path the predicate reads for `fixing_ci` is renamed, removed, or
  re-nested relative to the captured shape, the decision is a **non-terminal,
  re-evaluable hard failure** (the #342 field-shape class) — **not** a silent
  `SEND`, and **not** the terminal `helper_error_safe_suppress` short-circuit. A
  shape/schema mismatch is classified distinctly from a helper *execution* error:
  the helper ran and returned a structurally-wrong snapshot, so it must surface as
  the re-evaluable shape failure (the snapshot is retried on a later tick), never
  consumed as a terminal helper-error suppression. Document this disposition so
  the two failure modes do not collapse into one reason.
- The `fixing_ci`-report reader is reachable from the production delivery-time
  decision, proven behaviorally: the suppress-path positive-outcome test drives
  the **production decision entrypoint** (the same function the reconcile wrapper
  calls), not the reader in isolation, so a reader that is disconnected from that
  decision makes the `SUPPRESS` / `suppressed-live-worker` assertion fail. Any
  former `fixing_ci`-report reader left unreachable from that entrypoint is
  removed.
- The existing #342 lifecycle assertions (enqueue-only reaction, pre-intent-only
  suppression, precedence ordering, liveness probe, expiry) continue to pass
  unchanged.

```positive-outcome
asserts: a CI-failure episode terminalizes SUPPRESS (suppressed-live-worker) when the PR-owning worker's session status is a non-fixing_ci lifecycle label but its report for the episode head is fixing_ci
input: external-tool-output
provenance: capture-backed
```

## Upgrade-safety check

- No edits to AO core, `vendor/**`, `packages/core/**`, or `.ao/**`.
- No new repo secrets; captured fixtures are sanitized to consumed fields only.
- No `agent-orchestrator.yaml` schema additions; the reaction/orchestratorRules
  contract from #342 is untouched.
- The change narrows a binding to the real snapshot shape; it must not relax any
  existing #342 precedence or outbox invariant.

## Verification

- Run the CI-failure-notification test suite; the new capture-backed
  positive-outcome fixture asserts `SUPPRESS` + `suppressed-live-worker` on the
  AO-shaped session (status non-`fixing_ci`, per-head report `fixing_ci`):
  `npx vitest run scripts/ci-failure-notification.test.ts`
- Run the external-output field-shape guard (the #223-lineage guard) over the new
  live-worker fixture(s) and confirm it passes (consumed fields only) and that a
  deliberately renamed/re-nested `fixing_ci` field path makes the
  schema-conformance test fail as a re-evaluable hard failure, not a `SEND`:
  `npx vitest run scripts/external-output-shape-guard.test.ts` and
  `pwsh -NoProfile -File scripts/check-external-output-shape-guard.ps1`
- Run the same-head recency fixture (captured in real AO array order): a head
  whose latest report by the chronological-emission normalization is non-`fixing_ci`
  while an earlier entry in its history is `fixing_ci` yields `SEND` /
  `no_suppressor`, not `suppressed-live-worker` — proving the decision follows the
  same normalization the head-ready path uses, not a match against any historical
  `fixing_ci`.
- Run the two head-scoping regressions as separate fixtures: (a) a `fixing_ci`
  report for an older, non-episode head with the episode head still current yields
  `SEND` / `no_suppressor` (no wrongful `suppressed-live-worker`); (b) an episode
  whose head is superseded by a newer PR head/generation yields `SUPPRESS` /
  `abandoned-superseded`.
- Run the existing #342 lifecycle tests and the path's adoption check and confirm
  no regression:
  `pwsh -NoProfile -File scripts/check-ci-failure-notification-adoption.ps1`
- Confirm the suppress-path positive-outcome test invokes the production
  delivery-time decision entrypoint (the function the reconcile wrapper calls), so
  a `fixing_ci`-report reader disconnected from that path fails the test rather
  than passing on a test-only or indirect call.
