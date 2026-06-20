# Reviewer-time re-verification of contract-evidence against producer reality

GitHub Issue: #376

## Prerequisite

- `docs/issues_drafts/117-spec-contract-evidence-grounding-gate.md`
  (GitHub #366, closed — merged via PR #367) — *already does:* adds the
  **authoring-time** contract-grounding gate. Every binding a draft makes to an
  upstream producer datum carries a `contract-evidence` row — either
  `capture@<manifest-entry>` (with `selector`/`expected` or `token`/`exit-status`)
  grounded against a committed capture manifest, or `NEW(produced-by AC#k)` for a
  repo-owned datum the implementing PR will create, paired with a
  `producer-emission` acceptance criterion. This draft **consumes that
  exact format at reviewer time** — it does not redefine it, and it is the
  post-code re-verification layer #366 explicitly deferred (see its "Files out of
  scope").
- `docs/issues_drafts/75-rca-spec-discipline-against-misdirected-fixes.md`
  (GitHub #221, closed) — *already does:* requires positive-outcome criteria
  whose input is external-tool output to be production-representative
  (capture-backed). This draft applies the same "verify against reality"
  principle one phase later — at review, against the live producer.
- `docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md`
  (GitHub #223, closed) — *already does:* maintains per-state capture-backed
  reference fixtures and detects phantom fields. Reviewer-time re-capture
  **relies on #76's capture-generation discipline** for the genuineness of the
  captures a row references; this draft re-checks the asserted value against the
  producer, it does not re-derive capture authenticity.
- `docs/issues_drafts/115-reviewer-coworker-contract-mapping-pass.md`
  (GitHub #362, **open**) — *complementary, out of scope here — do not modify:*
  #362 is the reviewer-time **spec→diff** axis ("does the code satisfy the
  acceptance criteria?"): it maps each criterion to implementation/test evidence
  or a gap. This draft is the orthogonal **spec→producer-reality** axis ("does
  the datum the spec binds to actually exist / get emitted by the producer?").
  Spec and code can agree on a fiction; #362 as specced does not catch that. The
  two axes run side by side and neither subsumes the other.

## Goal

Close the half of the binding-bug class that authoring-time grounding (#366)
structurally cannot reach. A `contract-evidence` row that was true when the
draft was authored can be **false by the time the code is reviewed**:

1. **Staleness** — the producer's output changed between spec authoring and
   implementation, so the asserted value no longer holds.
2. **Producer-vs-row divergence** — the producer's current output no longer
   carries the row's asserted value. checkpoint-2 observes *this* divergence
   (row vs producer); whether it stems from a changed producer (staleness) or a
   row that was wrong is the reviewer's call. (Detecting that the *code* bound to
   something other than the spec is #362's spec→diff axis, not this one — this
   draft does not claim it.)
3. **Unfulfilled `NEW` obligation** — a `NEW(produced-by AC#k)` row promised the
   implementing PR would make the producer emit a datum, but at ship time the
   producer still does not emit it. This is the exact
   "consumer encodes a fiction nobody produces" hole (#342:
   `session.status` read where `reports[].reportState` lives) that #366
   recorded as an obligation but explicitly left for post-code enforcement.

Add a **reviewer-time (checkpoint-2) re-verification step**: for the PR under
review, re-check every `contract-evidence` row from the linked issue against the
**actual producer**, and surface drift / staleness / unfulfilled-`NEW` as
**candidate findings the main reviewer validates**. The check holds no
block/merge authority — it produces evidence, not verdicts (same trust model as
#362 / #115).

```behavior-kind
action-producing
```

## Binding surface

What the repo commits to:

- The pack's **reviewer flow gains a checkpoint-2 re-verification step**. For the
  PR under review it loads the `contract-evidence` rows from an **immutable
  snapshot** (see *Snapshot identity* below) and re-checks each row in **one of
  two explicitly-labelled verification modes**:
  - **Live re-verification** (the strong mode that closes the class): re-run the
    producer and compare its **current** output to the row's asserted value. For
    capture rows this means re-executing the manifest's recorded command and
    comparing `selector`→`expected` (structured) / `token` presence
    (unstructured) / `exit-status` (cli-behavior). For `NEW` rows it means
    running AC#k's `producer-emission` proof against producer reality and
    confirming the producer genuinely emits the promised `datum`/`expected`. A
    divergence is a candidate finding; an unfulfilled `NEW` obligation is a
    candidate finding (the post-code `NEW` enforcement #366 deferred).
  - **Compared-to-record** (the weak fallback, for producers that cannot be
    safely or deterministically re-run — see *Execution-safety contract*): verify
    the committed capture still matches its manifest `hash`/value. This proves
    capture integrity, **not** that current producer reality still matches — so a
    compared-to-record row is **explicitly NOT "producer-verified"**, and the
    staleness/drift class for such producers stays open at review time (the row
    is reported as integrity-checked-only, prompting the reviewer to re-capture
    if it matters).
  Every row's emitted result names which mode produced it; a row is only
  "producer-verified" when it passed **live** re-verification.
  **Execution model (two refs).** The checker logic, manifest, and **command
  definition** always resolve from the **trusted base** (a PR cannot doctor them);
  the **producer is executed against the intended review target** — for a capture
  row, the live/base producer it re-checks; for a `NEW` row, the PR-under-review
  producer, in the sandbox. So PR-head drift is still observable (the producer is
  the review target) while self-certification is blocked (the command/comparison
  is base-defined).
  **Mode precedence (defined once, all boundaries/ACs defer here):** a **live**
  check runs only when the base-defined command is safe; (a) an **inherently
  non-reproducible** producer (boundary 2) or an **unsafe / mutating /
  not-safe-reproducible / issue-body-supplied** command falls back to
  **compared-to-record** if a committed capture exists, else `status: unverified`
  (reason `unsafe-or-undeclared-command`); (b) a producer that is **reachable in
  principle but offline / times out / over-budget** at review time is
  `status: unverified` (reason `producer-unreachable`) — **not** compared-to-record
  (a transient outage must surface "could not check producer reality", not be
  masked as integrity-OK); (c) a row with **no live command and no committed
  capture** is `status: unverified` (reason `unsupported-producer`).
- **Execution-safety contract** (re-verification runs external producer
  commands, so this is a security surface). Live re-verification MUST: run only
  commands that **resolve to a committed, trusted source** — a capture row's
  command comes from the manifest, and a `NEW` row's `producer-emission`
  `proof-command` must resolve to a committed trusted manifest entry or
  repo-owned allowlisted command, **never executed verbatim from the (mutable)
  issue body**; operate read-only — it must not mutate repo or GitHub/`ao`/codex
  state; be bounded by a timeout; and redact credentials from any recorded
  output. A command that is diff-supplied/issue-body-supplied, would mutate, is
  not declared safe/reproducible, or exceeds the bound → yields **no live
  result**, and the row falls back per **Mode precedence** above. The planner
  owns the mechanism (allowlist / sandbox / env shape); this draft fixes the
  invariants. This closes the arbitrary-command-execution hole: a malicious or
  edited issue body cannot turn reviewer-time re-verification into a shell.
  **Trusted-base resolution (the check cannot be doctored to self-certify):** the
  check's own logic and the **capture-row** comparison machinery (manifest +
  capture commands) resolve from the **trusted base/protected snapshot, not the
  PR-head copy**; a capture-row command or checker file modified by the PR under
  review is not run as trusted → that row is `unverified`
  (reason `untrusted-pr-modified`). **NEW rows are the
  deliberate exception:** the producer code and `producer-emission` proof a `NEW`
  row verifies are *legitimately introduced by the PR under review* (verifying
  that is the whole point), so they are executed — but only under a sandbox that
  is **read-only AND credential-isolated and network-restricted** (PR-head proof
  code must not be able to read secrets or exfiltrate over the network — running
  untrusted PR code is the risk), and only when the proof genuinely exercises the
  real producer path (boundary condition 4), never trusting a hand-shaped proof.
  **Read-only is a falsifiable postcondition, not just a label:** after a normal
  live check the repo / `.ao` / GitHub-facing / worktree state is unchanged, and a
  command that attempts to mutate is blocked or sandboxed (a trusted command that
  *accidentally* writes is caught, not only undeclared commands). The sandbox is
  also **credential-isolated and network-restricted** — essential for `NEW`-row
  proofs, which execute PR-head code: it must not be able to read secrets or
  exfiltrate over the network. Any `observed` / `asserted` value recorded in the
  output is **redacted and length-bounded** so a producer value cannot leak
  secrets or flood the result.
- **Linked-issue resolution.** Before any snapshot is taken, the linked issue is
  resolved **deterministically**, and every ambiguity is an explicit
  **run-level** state, never a silent fallback: no linked issue, multiple linked
  issues, a PR-vs-issue mismatch, or an unavailable snapshot each yields a named
  run-level outcome surfaced to the reviewer (not "no rows → verified"). The
  planner picks the resolution rule; this draft requires it be deterministic and
  that ambiguity is surfaced.
- **Snapshot identity AND capture point.** The contract-evidence rows re-verified
  come from a single **immutable, content-addressed** snapshot — not a live
  re-fetch that can drift, and **not a timestamp** (which is not content
  identity). Crucially, the snapshot is captured at a **defined point bound to the
  PR lifecycle** (e.g. PR-open / review-request artifact / draft-publication
  snapshot), **not re-fetched at review time** — otherwise the result would be
  reproducible yet check the *post-edit* obligations, which does not close the
  issue-drift boundary. If the bound source **differs from the current issue
  body**, the check proceeds against the immutable bound snapshot and surfaces a
  **non-terminal `snapshot-drift` flag** on a `rows-evaluated` run (the reviewer
  is told the issue was edited after capture); if the bound source is
  **unavailable**, that is the terminal run-level `unavailable-snapshot` state.
  Each emitted
  result carries identifiers sufficient to reproduce exactly what was checked:
  issue number, a **content hash / blob SHA of the snapshot body**, and a per-row
  hash. The planner picks the bound source and precedence; this draft requires it
  be immutable, content-addressed, captured at a PR-bound point, and recorded.
- **Output contract (defined once).** Each row emits machine-readable fields
  with fixed value sets — never collapsed into a single enum:
  - `status` ∈ {`verified`, `divergent`, `unfulfilled-new`, `unverified`,
    `integrity-failed`} — the outcome of the row.
  - `verification-mode` ∈ {`live`, `compared-to-record`, `not-run`} — how the row
    was checked. A row counts as **producer-verified only when** `status:
    verified` **and** `verification-mode: live`. `not-run` is used when neither a
    live check nor a record comparison ran (so the mode is never falsely
    `live`/`compared-to-record`).
  - `reason` — present **iff** `status: unverified` — ∈
    {`producer-unreachable`, `unsafe-or-undeclared-command`,
    `unsupported-producer`, `non-genuine-proof`, `untrusted-pr-modified`}
    (`non-genuine-proof` = a `NEW`-row proof that ran but exhibited **no
    observable producer-path invocation**, e.g. an echo-only proof — emission
    could not be genuinely determined; `untrusted-pr-modified` = a capture-row
    command or checker file modified by the PR under review, so it is not run as
    trusted).
  - `observed` / `asserted` values whenever a comparison ran.
  Drift vs staleness is the **single** `divergent` status the reviewer
  disambiguates (not two machine states); manifest-integrity failure is the
  `integrity-failed` status; an unfulfilled `NEW` obligation is the
  `unfulfilled-new` status. This field contract is the one machine-readable output
  definition the whole draft refers to.
- **Run-level outcome vocabulary (fixed, separate from row status).** The
  non-row, whole-run states have their own fixed value set — not free-form —
  ∈ {`no-rows`, `no-linked-issue`, `multiple-linked-issues`, `pr-issue-mismatch`,
  `unavailable-snapshot`, `check-error`, `partial-run`, `rows-evaluated`} — so the
  reviewer wiring surfaces them consistently and machine checks are stable. A
  checker crash or partial run (e.g. crash before the first row, or after some
  rows) is the **fail-safe** `check-error` / `partial-run` state: surfaced to the
  reviewer as **non-verified** evidence, never a silent pass and never reported as
  "verified". `snapshot-drift` is **not** a separate run-level state — it is a
  **non-terminal flag** on a `rows-evaluated` run (see *Snapshot identity*): the
  run proceeds against the immutable bound snapshot and the drift is surfaced
  alongside the results.
- **Output is candidate evidence only.** The check surfaces candidates; the
  **main reviewer** independently validates each against the diff, the producer,
  and the cited spec snapshot, then assigns severity and the final verdict. The
  check **never auto-blocks or auto-merges** and honors the existing never-block
  invariant (it must never wedge a PR, mirroring #232 / #92).
- **No silent transition.** Every run surfaces a per-row status summary to the
  reviewer — including zero-candidate runs and `unverified` /
  `verification-mode: not-run` / compared-to-record rows — so no state silently
  disappears from review context
  (the project's silent-status-transition failure class). This is a
  surface-to-the-reviewer requirement, **not** a mandate to build a durable
  append-only audit store (that subsystem stays out of scope — see Files out of
  scope).

This draft fixes the **whole class**, not the three named recurrences. The
re-verification must define deterministic behavior for every boundary condition
below (each gets a captured-fixture test in Verification):

1. **No block / `contract-evidence: none`.** Linked issue predates #366, or
   affirmatively binds to nothing. → there is nothing to re-verify; the check
   records the run-level `no-rows` outcome. It must **not** false-fail, and
   must **not** report the PR as "producer-verified" — absence of rows is
   distinct from verified rows.
2. **External, non-reproducible producer** (a `gh` / `codex` / `ao` output that
   cannot be safely or deterministically re-emitted at review time). → run in
   **compared-to-record** mode (see Binding surface): integrity-check the capture
   only, label it not-producer-verified, and never claim a live producer re-check
   that did not happen.
3. **Producer changed AND code adapted correctly** (spec stale, code right) vs.
   **code bound to old fiction** (spec stale, code wrong). Both present as a
   drift candidate. → the check surfaces the divergence with both values; it does
   **not** auto-resolve which case it is — the reviewer decides.
4. **`NEW` row whose AC#k is green in CI but whose `producer-emission` proof is
   itself hand-shaped / unreachable** (the #342 recursion: green ≠ reachable). →
   checkpoint-2 verifies producer emission **independently** (re-runs the proof
   against producer reality); it does not trust the AC's green checkmark.
   **Precedence is explicit:** only a proof that **actually ran** and showed the
   producer does **not** emit the datum → `status: unfulfilled-new`; a proof that
   is **absent / unresolvable / unsafe** → `status: unverified`
   (`verification-mode: not-run`) with the matching `reason`
   (`unsupported-producer` when no runnable proof resolves, or
   `unsafe-or-undeclared-command` when the proof is unsafe) — never conflate "the
   PR failed to emit" with "the check could not safely determine emission". The proof must exhibit an **independently
   observable producer-path invocation**, not merely echo/print the expected
   datum; a resolvable-but-echo-only/hand-shaped proof that ran without an
   observable producer-path invocation → `status: unverified`
   (reason `non-genuine-proof`) — not `verified` and not `unfulfilled-new`. **Residual limit (honest):** checkpoint-2 verifies *emission at the
   producer boundary* — a sufficiently elaborate fake producer can still emit the
   datum, so judging the producer's *genuineness* remains the **main reviewer's**
   call (the candidate-evidence model); the check surfaces the emission, it does
   not certify authenticity.
5. **Linked issue body edited after the PR opened** (issue drift). → re-verify
   against the immutable recorded snapshot (see *Snapshot identity*); the emitted
   result carries the snapshot identifiers so the check is reproducible.
6. **Manifest hash mismatch** (capture file changed vs. its manifest record). →
   integrity failure is itself a candidate finding **and is terminal for that
   row**: no producer comparison runs on a row whose evidence cannot be trusted
   (any further diagnostic output is separately labelled, never mixed into a
   producer-verified result).
7. **Subset of rows fails.** → per-row verdict; one failing row among many is
   surfaced individually, not collapsed into a single pass/fail.
8. **Producer unreachable at review time** (offline / missing creds / sandbox). →
   **escalate without suppression**: record an explicit `unverified`
   (reason `producer-unreachable`) candidate. Never silently pass as verified,
   and never hard-block the PR.
9. **Unsafe / undeclared command** — the manifest command would mutate state or
   is not declared safe-reproducible. → no live check; per **Mode precedence**,
   fall back to compared-to-record if a committed capture exists, else
   `unverified` (reason `unsafe-or-undeclared-command`); never a silent pass.
10. **Host variation** — the reviewer may run under WSL/Ubuntu or another host. →
   manifest-path resolution and command execution must be host-independent so the
   same row yields the same verdict regardless of host (the pack is Linux-primary
   per #39; no host-specific verdicts).
11. **Unsupported producer** — the row's producer is **not resolvable for either
   mode**: no trusted manifest command to run live **and** no committed capture to
   compare against (e.g. an unrecognized producer, or one with neither evidence
   form available). → `status: unverified` (reason `unsupported-producer`),
   distinct from `producer-unreachable` (a known producer that is merely offline)
   and from `compared-to-record` (a non-reproducible producer that *does* have a
   committed capture). Never a silent pass.
12. **Vestigial row** — binds a consumer the diff does not touch. → still
   re-verify the producer datum (it is a standing contract) and report if stale.

## Files in scope

- Reviewer-flow re-verification logic and its fixtures (planner chooses files
  and shapes).
- Reviewer prompt/wiring needed to surface candidates to the main reviewer.

## Files out of scope

- `docs/issues_drafts/115-reviewer-coworker-contract-mapping-pass.md` and any
  #362 implementation — **not modified**; this is a parallel axis.
- The authoring-time gate (`scripts/contract-evidence.mjs` and the
  `create-issue-draft` grounding step from #366) — **consumed, not changed**.
- The legacy-grandfather-list anti-tamper hardening — its own draft
  (`docs/issues_drafts/119-contract-evidence-legacy-list-anti-tamper.md`).
- Capture-content genuineness / scrubbing — owned by #76.
- A **durable, append-only audit store / dashboard** of re-verification runs. The
  "no silent transition" requirement is satisfied by surfacing per-row status to
  the reviewer at review time; a persistent audit subsystem is a separate build.
- AO / `gh` / codex product code.
- The standalone **CI-enforcement lifecycle** of `NEW` obligations beyond
  reviewer-time re-verification (protected-snapshot, privileged-publication,
  tamper-resistant implementation-CI machinery). #366 scoped this out as a
  separable governance build; it stays out here. If review pressure pushes the
  re-verification toward a durable enforcement subsystem, scope it to a follow-up
  rather than piling on machinery.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
scripts/contract-evidence.mjs
scripts/draft-discipline.mjs
docs/issues_drafts/115-reviewer-coworker-contract-mapping-pass.md
```

```allowed-roots
scripts/**
tests/**
prompts/**
code-reviews/**
docs/**
```

The named out-of-scope files (the #366 authoring gate `scripts/contract-evidence.mjs`,
the discipline harness `scripts/draft-discipline.mjs`, and the #362 draft) are in
the denylist so the enforceable change boundary — not only the prose — keeps this
PR from satisfying itself by editing the authoring gate or the parallel-axis draft
instead of building reviewer-time re-verification. The check **imports/consumes**
the #366 format; it does not modify it.

The reviewer-flow integration point is the **reviewer prompt** (`prompts/`,
e.g. `agent_rules.md`) instructing the check plus the **check itself**
(`scripts/`), exercised through a real `ao review run --execute <session>` invocation (the
actual review verb — there is no bare PR-taking `ao review`; the planner picks the
fixture session) — **no AO-core / `packages/core` / `.ao` edit is required or
permitted**. The prompt/wiring that
**triggers and surfaces** checkpoint-2 is itself resolved from the **trusted
base** at review time (same invariant as the checker): a PR that edits
`prompts/`/wiring to skip or forge re-verification does **not** disable it — the
reviewer still receives the trusted-base summary. **Bootstrap:** the PR that
*implements* checkpoint-2 is necessarily exercised in **fixture / e2e mode** (the
trusted base does not yet contain the checker/prompt); the trusted-base-resolution
invariant binds **future** real reviews once this has landed — it is not a
contradiction for the initial PR. If the end-to-end criterion (AC#13) appears to
need an AO-core edit, that is a signal the integration was mis-designed, not a
reason to widen the denylist.

## Contract evidence

The implementing PR creates one repo-owned datum the reviewer flow then depends
on: the per-row re-verification outcome. It does not yet exist, so it is a `NEW`
obligation whose producer-emission is proven by the implementation.

The bindings this draft makes to **already-shipped #366 formats** (the
`contract-evidence` row schema, the capture manifest fields, the
`producer-emission` block) are committed, version-controlled repo-owned
contracts named in Prerequisite and Binding surface. They are **not exempt and
not hand-shaped**: the field names this check consumes were verified against the
shipped #366 implementation/fixtures (`scripts/contract-evidence.mjs` +
`tests/.../contract-evidence/`) at authoring, and the implementing PR **grounds
them against that committed schema source** — its checker tests parse the real
#366 fixtures/format (under #76 capture discipline), not hand-shaped issue text.
**Deliberate decision (not an oversight):** per #366's own rule "completeness is
owned by review, not the linter", enumerating each consumed #366 field as its own
`contract-evidence` row is intentionally left to the grounding ask + Codex draft
review, **not** the mechanical block. A `capture@` row would require a committed
capture manifest of the #366 schema, which (a) is incompatible with this
sync-only draft (captures are committed by the implementing PR, not at authoring),
and (b) would be redundant with the implementing PR's own #366-format fixtures
that already ground the schema under #76 discipline. Forcing rows here would be
over-grounding an in-repo, directly-readable committed contract. **Open question
recorded for the implementing PR:** commit the #366-schema fixtures/manifest its
checker parses, so the consumed schema is grounded at code time.

```contract-evidence
binding-id: orchestrator-pack:reverify-status:divergent
binding: per-row reviewer-time re-verification status — divergent is one of {verified, divergent, unfulfilled-new, unverified, integrity-failed} (see Output contract)
producer: orchestrator-pack
evidence: NEW(produced-by AC#14)
```

## Acceptance criteria

1. For a PR whose linked issue carries a **capture row** whose producer output
   **still matches** the asserted value, checkpoint-2 emits a **passing per-row
   status** (`status: verified`, `verification-mode: live`) and no candidate
   finding.
2. For a **capture row** whose producer output **no longer carries** the asserted
   value, checkpoint-2 emits `status: divergent` with the asserted and observed
   values (the reviewer disambiguates drift vs staleness).
3. For a **`NEW` row** whose `producer-emission` proof **passes** against producer
   reality, checkpoint-2 emits `status: verified`, `verification-mode: live`, no
   `reason`, and no candidate finding (a `NEW` obligation is only fulfilled when
   verified **live** — never via compared-to-record).
4. For a **`NEW` row** whose `producer-emission` proof **actually ran and showed
   the producer does not emit** the datum, checkpoint-2 emits `status:
   unfulfilled-new` as a candidate finding — the #342 "fiction nobody produces"
   hole closed at code time. A proof that is **absent / unresolvable / unsafe**
   yields `status: unverified`, `verification-mode: not-run`, with a `reason` from
   the fixed set (`unsupported-producer` / `unsafe-or-undeclared-command`), **not**
   `unfulfilled-new` (the two are materially different reviewer signals).
5. Re-verification output is **candidate evidence only**: the main reviewer
   retains the final verdict; the check never auto-blocks or auto-merges and
   honors the never-block invariant. Every run surfaces a per-row status summary
   (including zero-candidate runs and `unverified` / `verification-mode: not-run` /
   compared-to-record rows) so no state silently disappears.
6. A row is reported **producer-verified only when it passed live
   re-verification**; a **compared-to-record** row (non-reproducible/unsafe
   producer) is labelled integrity-checked-only and is **not** producer-verified.
7. Live re-verification honors the **execution-safety contract**: every command —
   capture-row commands **and** `NEW`-row `producer-emission` proof-commands —
   resolves only to a committed trusted manifest entry / repo-owned allowlisted
   command (never executed verbatim from the issue body), read-only, time-bounded,
   credentials redacted; an issue-body-supplied / unsafe / undeclared / mutating
   command, or a timeout / over-budget attempt, yields **no live result** and the
   row falls back per **Mode precedence** (compared-to-record if a committed
   capture exists, else `status: unverified` — reason
   `unsafe-or-undeclared-command` for an unsafe command, `producer-unreachable`
   for a timeout/over-budget attempt). **Trusted-base:** the checker and the
   capture-row comparison machinery resolve from the trusted base snapshot, not
   PR-head — a capture-row command/checker file modified by the PR under review is
   not run as trusted (that row → `unverified`); `NEW`-row producer/proof code is
   the deliberate exception (PR-introduced, run under the sandbox with real
   producer-path exercise). **Read-only is falsifiable:** a fixture
   mutating-command through the trusted path is blocked/sandboxed, and repo /
   `.ao` / GitHub-facing / worktree state is **unchanged** after a normal live
   check. Any `observed` / `asserted` value emitted is **redacted and
   length-bounded**.
8. Each emitted result carries **immutable, content-addressed snapshot
   identifiers** (issue number, snapshot body content-hash/blob SHA, per-row hash;
   not a bare timestamp) so an edited issue body cannot silently change what was
   checked, and the result populates the **Output contract** fields (status /
   verification-mode / reason) per the single definition in Binding surface
   (states are not collapsed into one label).
9. Linked-issue resolution is **deterministic** and every ambiguity (no issue /
   multiple issues / PR-issue mismatch / unavailable snapshot) is an explicit
   **run-level** state surfaced to the reviewer — never a silent "no rows →
   verified" fallback.
10. A row with a **manifest hash mismatch** is terminal: `status:
   integrity-failed`, no producer comparison mixed into a verified result.
11. The **full Output contract** is grounded by a schema fixture: every field
   (`status`, `verification-mode`, `reason`, `observed`, `asserted`) and its fixed
   value set is exercised by a real run — so the new output cannot itself harbour
   a phantom field (the same class this draft guards against, applied to its own
   emission), not only the representative `divergent` value.
12. Every boundary condition 1–12 in Binding surface has **deterministic,
   captured-fixture-backed** behavior with **strict precedence** between the
   non-passing reasons — `producer-unreachable` (known producer, offline) vs
   `unsupported-producer` (no manifest command **and** no committed capture) vs
   `compared-to-record` (non-reproducible producer **with** a capture) vs
   `unsafe-or-undeclared-command` are mutually distinguishable, each with a
   fixture; **producer-unreachable** yields `status: unverified` (never a silent
   pass), a **no-block** linked issue is the run-level `no-rows` outcome (distinct
   from "verified"), and the verdict is **host-independent**.
13. The per-row summary is surfaced **through the actual reviewer-flow
   invocation end-to-end** (not only via unit tests) — a real `ao review run
   --execute <fixture-session>` (the `--execute` form actually runs the review;
   the bare form only queues it) over a fixture PR yields the candidates and the
   passing/`unverified` per-row statuses to the main reviewer, via the reviewer
   prompt (`prompts/`) + the check, with **no AO-core edit**; a prompt/script-only
   "paper" integration that never reaches a live `ao review run --execute` does not
   satisfy this.
14. The re-verification producer emits `status: divergent`
   (`reverify-status`) when a capture row's producer value diverges from the
   asserted value — proven by a test that **runs the actual re-verification
   command over a divergence fixture and asserts the emitted structured field**,
   not by aggregate `npm test` alone (the proof must exercise the real producer
   path, or it is the very green-test fiction this draft fights).

```positive-outcome
asserts: checkpoint-2 emits a divergent status when the producer's current value diverges from the row's asserted capture value
input: external-tool-output
provenance: capture-backed
```

```producer-emission
producer: orchestrator-pack
datum: reverify-status
expected: divergent
proof-command: npm test -- reverify
```

## Upgrade-safety check

- No edits to AO core, `packages/core/**`, or `vendor/**`.
- Re-verification integrates via the reviewer flow's existing extension points;
  it adds **no new always-on blocking gate** and cannot wedge a PR.
- No unsupported `agent-orchestrator.yaml` schema (no `reviewer:` block on AO
  0.9.x).
- The check degrades to an explicit "unverified" candidate when the producer
  environment is unavailable; it never fails the reviewer flow itself.

## Verification

- One fixture per acceptance criterion (1–14) and one per boundary condition
  (1–12), each backed by a committed capture / manifest pair where a producer
  value is involved (no hand-shaped producer output — #76 discipline).
- A **read-only postcondition** fixture: a mutating command through the trusted
  path is blocked/sandboxed, and a repo/`.ao`/worktree state snapshot is
  byte-identical before and after a normal live check.
- An **unsupported-producer** fixture (no manifest command and no committed
  capture) → `unverified` (reason `unsupported-producer`) — distinct from
  `producer-unreachable` and `compared-to-record`.
- A `NEW`-fulfilled fixture asserts `verification-mode: live` (not
  compared-to-record).
- A redaction/length-bound fixture for `observed` / `asserted` values.
- A **trusted-base** fixture: a PR that modifies the capture-row manifest/command
  or the checker itself → that row is `unverified` (not run as trusted);
  separately, a `NEW`-row producer/proof introduced by the PR **is** run under the
  sandbox.
- A **snapshot-drift** fixture: the PR-bound snapshot differs from the current
  (edited) issue body → a `rows-evaluated` run carrying a non-terminal
  `snapshot-drift` flag (verified against the bound snapshot), not a silent check
  of either.
- A **hand-shaped NEW-proof** fixture: a resolvable/committed `producer-emission`
  proof that merely echoes the expected datum (no observable producer-path
  invocation) → **not** verified.
- A **NEW-proof precedence** triple: proof ran and producer doesn't emit →
  `unfulfilled-new`; proof absent/unresolvable → `unverified`; proof unsafe →
  `unverified` (reason `unsafe-or-undeclared-command`).
- A `verification-mode: not-run` fixture for an `unverified` row where neither
  live nor record comparison ran.
- Linked-issue ambiguity fixtures: no-issue / multiple-issues / PR-issue
  mismatch / unavailable-snapshot → distinct run-level states (not "verified").
- A `NEW`-row whose `producer-emission` proof-command does **not** resolve to a
  committed trusted command → not run, `status: unverified`
  (reason `unsafe-or-undeclared-command`).
- A divergence fixture: capture row asserts value V; producer fixture now emits
  V′ → assert `status: divergent` carrying both V and V′.
- A staleness vs. correct-adaptation pair: same divergence, assert the check
  surfaces both values as `divergent` without auto-classifying.
- A `NEW`-fulfilled fixture (producer-emission proof passes → `verified`) and a
  `NEW`-unfulfilled fixture (proof **ran and showed non-emission** →
  `unfulfilled-new`); a proof **absent/unresolvable** → `unverified` (per the
  NEW-proof precedence, **not** `unfulfilled-new`).
- A producer-unreachable fixture → `unverified` (reason `producer-unreachable`),
  reviewer flow still completes; an unsafe/undeclared-command fixture →
  `unverified` (reason `unsafe-or-undeclared-command`), command not run.
- A manifest-hash-mismatch fixture → `integrity-failed`, terminal (no producer
  comparison).
- A `contract-evidence: none` fixture → run-level `no-rows`, not "verified".
- A host-independence fixture: the same row yields the same verdict across path
  separators / cwd.
- An **end-to-end reviewer-flow fixture**: a real `ao review run --execute <fixture-session>`
  over a fixture PR surfaces the candidates and the passing/`unverified` per-row
  statuses to the reviewer (AC#13) — proving the integration is not paper-only.
- A **vestigial-row fixture**: the linked issue carries a row for a consumer the
  diff does not touch; the checker still re-verifies it and reports its per-row
  outcome (boundary condition 12).
- A **run-level vocabulary fixture**: each run-level outcome
  (`no-linked-issue` / `multiple-linked-issues` / `pr-issue-mismatch` /
  `unavailable-snapshot` / `check-error` / `partial-run` / `no-rows` /
  `rows-evaluated`) is emitted from its fixed set, and `snapshot-drift` appears as
  a non-terminal flag on a `rows-evaluated` run.
- A **prompt/wiring-tamper** fixture: a PR edits `prompts/`/wiring to skip or
  forge re-verification → the reviewer still receives the trusted-base summary.
- A **checker-crash** pair: crash before the first row → `check-error`; crash
  after some rows → `partial-run`; both surfaced as non-verified, never a silent
  pass.
- The output-contract schema fixture: assert distinct `status` /
  `verification-mode` / `reason` fields with their fixed value sets.
- The candidate-evidence contract: assert the check exposes candidates to the
  reviewer and never emits a merge/block decision.

## Decisions (adversarial review)

GPT loop: 10 passes; stopped because cap-10; last-pass accepted=3; final
STATE=completed_valid VALIDATION=ok pass=aa16fa75-7894-4f80-a37f-5458fd61c25a
sha=2017e329bbec87f17fed5dec559f9f1e38f2ee36fc150b8fb4e6dc063feecd60.
**The pass-10 consistency fixes (two-ref execution model; unreachable→`unverified`
not compared-to-record; `skipped`/`not-run` vocabulary tidy) were applied
post-cap and not re-reviewed by GPT** — they are clear consistency corrections,
not new design.

Codex architect review (`review-architect-artifact.ps1`): converged to
**NO_FINDINGS at iteration 5**. Accepted across iterations: a `non-genuine-proof`
reason for echo-only NEW proofs; `untrusted-pr-modified` reason for PR-doctored
capture commands; real `ao review run --execute <session>` command (no bare
PR-review verb exists); NEW-row sandbox made credential-isolated + network-
restricted (it runs PR-head code); the "drift" claim narrowed to producer-vs-row
divergence (code-vs-spec stays #362's axis). The #366-schema-row request was
**deliberately declined** per #366's "completeness owned by review, not the
linter" (recorded as an implementing-PR open question, not an authoring row).

Key decisions across the loop (accept = revised; reject = left, with reason):
- **Accepted:** two verification modes (live vs compared-to-record); a row is
  producer-verified only under live; execution-safety contract (trusted-base
  command resolution, read-only falsifiable postcondition, redacted/bounded
  output, NEW-row proof must resolve to a committed trusted command not the
  mutable issue body); content-addressed PR-bound snapshot + deterministic
  linked-issue resolution; single Output contract + fixed run-level vocabulary;
  NEW-proof precedence (ran-and-non-emission → `unfulfilled-new`, otherwise
  `unverified`); end-to-end real-review integration (no AO-core edit); host
  independence; out-of-scope files moved into the denylist.
- **Rejected:** splitting into schema-only + wiring-only drafts (one
  single-PR build; e2e wiring folded in); building a durable append-only audit
  store (out of scope — surface-to-reviewer is enough).
- **Residual risk (documented, not built):** checkpoint-2 verifies emission *at
  the producer boundary*; distinguishing a genuine producer from an elaborate
  committed fake remains the **main reviewer's** authenticity judgment
  (candidate-evidence model) — an irreducible limit, not a missing mechanism.
