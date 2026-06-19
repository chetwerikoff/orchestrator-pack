# Orchestrator message registry, map, and single-source audit

GitHub Issue: #298

## Prerequisite

- These already-merged issues built the runtime this draft **catalogues** — it does
  **not** re-implement any of them:
  - `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205,
    merged) — the single supervised host that already owns every send-process (wake
    listener, heartbeat, review-trigger reconcile, ci-green worker-wake,
    review-finding delivery-confirm).
  - `docs/issues_drafts/77-worker-message-submit-source-agnostic.md` (GitHub #232,
    merged) and `89-worker-message-delivery-confirmed-consumption.md` (GitHub #281,
    merged) — the source-agnostic, journaled worker-message delivery/submit layer
    (outbox, crash-safe accounting, confirmed consumption).
  - `docs/issues_drafts/90-ci-failure-notify-cross-path-dedup.md` (GitHub #283,
    merged) — the CI-failure ping episode-key dedup; and
    `88-review-start-atomic-claim.md` (GitHub #267, merged) — the per-(PR, head)
    single-flight review-start claim. These are the existing per-message-class dedup
    instances this registry **references**, not replaces.

## Goal

Make the orchestrator's message-sending **legible and guarded** with one declarative
**message registry** (catalog) of every orchestrator-originated message, a
**human-readable map** generated from it ("what fires when, which process owns it, who
it can collide with"), and a **CI audit** that every real send site corresponds to a
catalogued entry. The registry is documentation + a guard **over** the already-unified
runtime (#205 host, #232/#281 delivery, #283/#267 per-class claims) — it is **not** a
new runtime gateway, claim store, or delivery layer, and it re-implements none of that
shipped machinery. It exists because the send logic is currently spread across ~6
scripts with no single enumerable answer to "which events send which messages, by which
process, and where could two of them collide" — the question that made the CI-red
double-ping (#283) expensive to find. Catching the **next** such overlap should be a
catalog lookup + a CI failure, not another incident.

```behavior-kind
action-producing
```

The "action" produced is a **verdict**: the audit/overlap check emits an observable
PASS/FAIL (naming the offending site) and the generator emits the map. No success path
sends a message, wakes a worker, or submits a draft — those remain owned entirely by the
referenced runtime; this issue adds only catalog/generation/check artifacts.

## Background (why this is open)

The orchestrator originates messages from several independent senders — ci-green-wake,
the CI-failure ping (#283), review-send, review-finding-delivery, orchestrator-wake,
and the worker-message submit arbiter (#232/#281). The runtime is already substantially
unified: #205 supervises all of these processes, and #232/#281 made the actual
delivery/submit **source-agnostic and journaled**. The duplicate class is also handled
per-instance: #283 dedups the CI-failure ping (episode key), #267 makes review starts
single-flight ((PR, head) claim).

What does **not** exist is a single, enumerable description: no one place answers "what
are all the message classes, what event fires each, which #205-supervised process owns
it, what dedup/claim instance (if any) protects it, and which classes could target the
same worker with overlapping intent." That knowledge is implicit across the scripts.
The cost of that gap is concrete: the CI-red double-ping (#283) needed a whole dedicated
issue to discover and fix, when a catalogued overlap relationship would have surfaced it
as a lookup. This issue closes the **legibility + registration** gap, not a live bug
(no observed duplicate is currently open).

## Binding surface

- **Declarative message catalog keyed by `message_class_id` (single source of truth,
  data not code).** Each **send-helper invocation** carries or resolves a stable
  **`message_class_id`**, and the catalog has exactly one entry per id (1:1). Keying on
  the message class — not the helper function — is what stops a *new* semantic class from
  hiding behind an already-registered helper. A `message_class_id` binds to a **single
  coherent callsite signature**: the same id appearing at **divergent callsites**
  (different helper / trigger / recipient shape) **fails** the audit — so a new sender
  cannot hide by *reusing* an existing valid id while lying about its trigger, owner,
  recipient, or intent. Per entry: the `message_class_id`, the
  **triggering event/condition** — bound to a stable code anchor **and a source hash /
  parsed signature of the predicate body itself**, so a change to the firing logic *inside*
  the same function (e.g. widening "CI red after reconcile" to "CI red or timeout") drifts
  the hash and **fails** the drift check until the catalog/map is updated; the "what fires
  when" map cannot silently lie even when the anchor stays put. (A semantically-equivalent
  refactor that changes the hash just re-confirms — a cheap false-positive; the residual is
  only the reverse, which the body-hash makes near-impossible.) — the **owning process**
  (which #205-supervised
  reconciler/listener), a **canonical `recipient_key`** (the durable recipient identity
  class — head-owning worker / specific session / orchestrator) and a **canonical
  `intent_key`** (the logical worker-visible intent), the **mechanism** (`ao send` /
  `ao review send` / draft-submit), and **two distinct ownership fields**: a
  **`delivery_idempotency_owner`** (the mechanism that prevents re-sending the *same
  queued message* after crash/resume — e.g. #281 outbox `delivery_id`) and a
  **`semantic_dedup_owner`** (the mechanism that prevents *two different classes* sending
  a semantically duplicate message to the same recipient — e.g. #283 episode-key, #267
  (PR, head) claim), each a reference to an existing mechanism or an explicit `none`.
  A `semantic_dedup_owner` is **not a bare reference** — it declares its **coverage
  scope** (the normalized `recipient_key` + `intent_key` pair and the `message_class_id`s
  it actually suppresses), and the overlap check is satisfied **only when the owner's
  declared scope covers the specific collision** — so an entry cannot pass by pointing at
  a real-but-irrelevant owner (e.g. #283 covering CI-status but cited for an unrelated
  collision). The declared scope is **statically bound** to the implementing file/function
  and the **claim-key field names** that mechanism actually keys on (a coverage claim
  naming fields the mechanism does not have **fails**). The deeper *behavioral* proof —
  that the real claim key in fact suppresses that pair at runtime — stays owned by **that
  mechanism's own issue and tests** (#283/#267/#281), a **named residual** this catalog
  references rather than re-validates (re-deriving runtime behavior here is exactly the
  redundancy this issue avoids). Every non-`none` owner reference must **resolve to an allowlisted existing
  issue/mechanism identifier** (and, where determinable, the real script/function that
  implements it) — a stale or mistyped reference fails the catalog check, so the map
  cannot claim phantom protection from a mechanism that was renamed or removed. The
  **owning-process** field is likewise resolved against the **actual #205 supervised
  process inventory**: a process name that is not in the supervisor's registry (renamed,
  removed, or moved out of supervision) fails the check, so stale ownership cannot hide
  in the map. The catalog **references** existing claims; it does not define or run them.

- **Generated, committed human-readable map — deterministic and bounded.** A
  human-readable "what fires when / which process / who it can collide with" map is
  **generated from the catalog and committed to the repo**; CI **regenerates it and fails
  when the committed map differs from the freshly regenerated output** (the standard
  checked-in-generated-artifact pattern — no circularity, the committed copy is the thing
  compared). Generation is **deterministic** (canonical ordering + normalized formatting,
  so the diff is never flaky) and **bounded**: the committed map is concise per-class rows
  plus owned/unowned overlap **summaries**, not an O(n²) pairwise dump — full pair detail
  is emitted only on a failing check or behind a separate debug artifact. The map is the
  artifact the user asked for ("describe by what logic they fire, what processes they
  touch").

- **Overlap is inferred from a checked key taxonomy, not free-form text.** **Both**
  `recipient_key` **and** `intent_key` are drawn from a **closed, reviewed taxonomy** (a
  declared enum with an explicit **alias / overlap (parent-child) table**), not free text.
  The catalog carries **canonical recipient dimensions** (e.g. PR / head / session-owner
  equivalence class) rather than only broad labels, and the alias table applies to
  **recipient_key too**. Because "this session resolves to that worker" is *instance-level*
  knowledge a static check cannot always decide, abstraction-level recipient pairs (a
  "head-owning worker" vs a "specific session" that *could* be the same worker) are treated
  as **conservative overlaps** — flagged unless cleared by a `semantic_dedup_owner` or an
  evidenced override (fail toward flag, not toward silent miss). Exact key equality alone
  would miss the cross-abstraction duplicate; conservative overlap on the canonical
  dimensions catches it without depending on runtime instance resolution. Likewise near-synonym intents (`ci-red` vs
  `red-status`) resolve to overlapping keys. The overlap check **infers** a collision when
  two entries have overlapping `recipient_key` **and** overlapping `intent_key`
  (symmetric, via the alias/overlap table), and flags any such pair whose collision is not
  owned by a **`semantic_dedup_owner`** — a `delivery_idempotency_owner` alone does
  **not** satisfy overlap suppression (it stops re-sends of one message, not two classes
  colliding). A manual override for a genuine non-overlap is **not a bare flag**: it must
  carry a rationale, the reviewer, a linked issue/PR, the affected `message_class_id`s,
  and **concrete non-collision evidence** — one of: proven **trigger mutual-exclusion**
  (the two classes can never fire for the same episode), proven **recipient
  non-equivalence** (they never resolve to the same concrete target), or a **reachability
  proof** that both never reach one recipient at once. (Evidence is *not* "they don't
  collide under normalized keys" — that would be circular: if they didn't, the check
  wouldn't flag them.) So the override cannot become a quiet escape hatch for the very
  duplicate class this guards. The
  default is inferred, so a new colliding sender cannot pass merely by omitting an
  overlap declaration. This makes the CI-red-class gap a catalog-time finding. The
  registry adds **no** runtime suppressor; runtime dedup stays owned by the referenced
  per-class instances (#283/#267/#281).

- **Single-source audit (the "1 place" guard), keyed by message class not just helper.**
  Raw sends must occur **only inside named send-helper functions**, and **every reachable
  send path must resolve a `message_class_id` that has a 1:1 catalog entry**.
  "Reachable" is bound to an **explicit audit root set** — the #205 supervised-process
  entrypoints, the CI-invoked scripts, and the registered manual/orchestrator command
  entrypoints — not a planner-chosen scan: a sender reached only through one of those roots
  (a scheduled reconciler, a sourced script, a draft-submit on a different invocation tree)
  must still be detected, and the root set is what bounds "reachable" so the audit neither
  misses a real sender nor invents false stale-entry failures. The **root set itself is
  validated for completeness against independent sources** — the #205 process inventory,
  the CI workflow invocations, and the command registry — and the audit **fails if any such
  entrypoint is absent from the root set**, so a new CI workflow / registered command /
  supervisor entrypoint cannot hide an uncatalogued send tree behind a self-omitted root.
  "Raw send"
  is given an **auditable signature for each mechanism** — `ao send`, `ao review send`,
  **and the draft-submit side-effect** (the worker-input submit the #232/#281 arbiter
  performs) — so the draft-submit path is detected with the same rigor as the `ao`
  commands, not left as an undefined exception a future submit path could slip through. The
  static analysis is **fail-closed**: a parse error, an **unanalyzable dynamic-execution
  construct** (`Invoke-Expression`, `bash -c`, eval'd / command-array / variable-built
  invocation), an unresolved sourcing/import, or an unknown helper alias **fails** the
  audit unless covered by an explicit reviewed allowlist fixture — the audit never reports
  PASS on a construct it could not actually analyze. **Binding a callsite to a
  `message_class_id` never requires editing a frozen runtime file** (which would violate
  additive-only): for an **existing** runtime callsite, the catalog itself is the binding
  authority — it declares the mapping from a **stable callsite signature** (file / function
  / anchor + predicate body hash) to the `message_class_id`, derived by read-only static
  parse, so no runtime literal is added. A **new** helper API introduced *after* this guard
  carries a **literal / static enum** `message_class_id` at its own (non-frozen) boundary.
  Either way the id is **explicit and statically resolvable** — never a runtime-data /
  helper-default inference (which still **fails** unless allowlisted with a pinned callsite
  signature) — so the 1:1 mapping and divergent-callsite detection stay statically provable. An allowlist entry is **not permanent**: it binds to a
  **stable code anchor + a source hash / parsed signature** of the allowlisted span, so a
  later edit inside an allowlisted dynamic wrapper (a new raw send, a changed resolved
  class) **drifts** the hash and **fails** until re-reviewed — an exception never becomes a
  silent blind spot. The audit **fails** when
  (a) a raw send appears **outside** a registered helper (catching wrappers, aliases,
  variable-built commands, sourced helpers — not a fragile literal grep), (b) a send path
  carries **no `message_class_id`** or one with **no catalog entry**, or (c) a catalog
  entry maps to **no** reachable send path (stale entry). The **baseline of "every
  message class"** is enumerated **independently of the catalog** — from the real
  send-helper callsites + the seeded raw-send fixtures + the named known classes in
  **Background** — and each must match a catalog id; the completeness check never trusts
  the catalog's own declared universe as its baseline. This mirrors the existing
  forbidden-command lints (`Review-MechanicalForbiddenCommand` and siblings). An
  intentional exclusion is an explicit, reviewed allowlist entry.

- **Strictly additive — re-implements nothing already shipped.** This issue adds a
  catalog, a generated map, an overlap check, and a registration audit. It does **not**
  modify the **behavior** of the claim store, state machine, outbox, delivery/submit
  path, supervisor, or escalation surface (#205/#232/#281/#283/#267). The additive-only
  guard is unambiguous: the issue declares an **explicit path matrix** — the
  **protected-runtime path set** (the runtime files whose behavior must not change) and
  the **new catalog/audit/map tool paths** — and the diff must edit **none** of the
  protected set. Crucially, the protected set is **derived from the prerequisite issues'
  declared file inventory** (#205/#232/#281/#283/#267) and is **immutable to the gated
  diff**: the implementation PR **cannot author or weaken the boundary it is judged
  against** (a fixture proves an attempt to shrink/redefine the protected matrix in the
  same diff fails). The boundary is a fixed pre-existing manifest, not self-declared, and
  is **computed from the *current* runtime surface** — the real send-helper callsites,
  the #205 supervised-process entrypoints, and the owner implementation bindings —
  **cross-checked** against the prerequisite issue inventories (not derived from the
  historical issue file lists alone, which could be stale vs the current script layout). The audit/catalog tooling obtains what it needs by **static parsing**
  (the default — it does **not** execute-import runtime scripts, because in Node/PowerShell
  importing a script runs its top-level code, which could read live config, touch state,
  spawn a watcher, or open a session — violating "no new unsupervised process" / "no pane
  scraping" / additive-only). There is **no executing-import fallback**: the tooling never
  runs a runtime script to obtain a value (a script's top-level side effect would already
  have happened before any "side-effect-free" check could fail it). A value that cannot be
  obtained by **static parse or a pre-existing manifest** is instead **declared in the
  catalog** (minimal, reviewed duplication) — but this catalog-declare
  fallback is for **catalog-intrinsic** metadata **only**. The **independent baselines the
  audit validates the catalog *against*** — the #205 supervised-process inventory and the
  owner/mechanism bindings — must come from a **pre-existing immutable manifest or static
  parse of the real runtime**, **never** from the same catalog. The audit **compares two
  sides it does not both author**; if a runtime inventory cannot be obtained
  independently, the check **fails** rather than falling back to catalog self-assertion
  (which would let a renamed/removed supervised process pass via a stale catalog copy).
  This keeps the guard a simple "no-protected-edit, no-side-effect-read, no-self-validation"
  rule. If the catalog and a referenced runtime disagree, the catalog is the bug (fix the
  catalog), never the runtime.

## Files in scope

- `scripts/**` — the catalog data file `(new)`, the map generator `(new)`, the overlap
  check `(new)`, and the single-source registration audit `(new)`. The planner picks
  the catalog format (data file vs module), the generator, and how the audit enumerates
  send sites.
- `docs/**` — the generated human-readable message map `(new)` and a short "how to add a
  new message class to the catalog" note.

## Files out of scope

- Any change to the runtime: the claim stores / dedup instances (#283/#267/#281), the
  delivery/submit arbiter (#232/#281), the supervised host (#205), wake/trigger
  reconcilers, or their escalation surfaces. This issue only catalogs and audits them.
- A new runtime message gateway / egress / shared claim authority (explicitly **not**
  built — the runtime is already unified per the prerequisites).
- `agent-orchestrator.yaml` (gitignored live config).
- Finding-routing's **internal classification logic** (#139/#140/#141/#142) — a separate
  subsystem. **However, any send site inside finding-routing is NOT exempt from the
  registration audit**: if it emits a worker-/orchestrator-visible message it must route
  through a catalogued helper with a `message_class_id` like every other sender. The
  audit covers **all** send sites; only the routing/classification semantics are out of
  scope here. So the map is not knowingly incomplete on the *message* surface.
- `packages/core/**`, `vendor/**`, AO upstream.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

```positive-outcome
asserts: given the real pack scripts on realistic input, the single-source audit reports a PASS when every orchestrator-originated send site has a catalogue entry, and reports a FAIL naming the offending site when a send site (a seeded new `ao send`) has no entry
input: realistic
```

- **Catalog completeness from an independent baseline.** A fixture asserts the baseline
  of message classes is enumerated from **real send-helper callsites + seeded raw sends +
  the named Background classes** (not the catalog's own universe), and that each maps 1:1
  to a catalog entry carrying `message_class_id`, triggering event, owning
  #205-supervised process, `recipient_key`, `intent_key`, mechanism,
  `delivery_idempotency_owner`, and `semantic_dedup_owner`.
- **A new class behind an existing helper is caught.** A fixture where a new semantic
  send is routed through an **already-registered** helper but carries **no** (or an
  uncatalogued) `message_class_id` **fails** the audit — the helper being registered does
  not excuse a missing class entry.
- **Reusing an existing `message_class_id` is caught.** A fixture where a **new** semantic
  send **reuses** an already-catalogued `message_class_id` at a divergent callsite
  (different helper / trigger / recipient shape) **fails** the audit — an id cannot be
  borrowed to lie about a new sender.
- **Recipient overlap spans abstraction levels.** A fixture where one entry's recipient
  is "head-owning worker" and another's is "specific session" that **resolve to the same
  concrete worker** (overlapping via the recipient alias table), sharing an `intent_key`
  with no `semantic_dedup_owner`, is **flagged** — exact recipient-key equality alone would
  have missed it.
- **Owner references resolve to real mechanisms.** A fixture proves a non-`none`
  `delivery_idempotency_owner` / `semantic_dedup_owner` that does **not** resolve to an
  allowlisted existing mechanism identifier (stale / mistyped / removed) **fails** the
  catalog check — no phantom protection.
- **Wrong-scope semantic owner is caught.** A fixture proves an overlap whose cited
  `semantic_dedup_owner` is a **real** mechanism but whose **declared coverage scope does
  not cover** the colliding normalized recipient/intent pair + class ids is **flagged**
  (owner exists ≠ owner covers this collision); and a coverage claim naming **claim-key
  fields the implementing mechanism does not have** fails the static binding.
- **Fail-closed on unanalyzable sends.** A fixture proves the audit **fails** (not passes)
  on a parse error / `Invoke-Expression` / `bash -c` / command-array / unresolved-source
  send construct unless it is in the reviewed allowlist; and that a **dynamically
  constructed `message_class_id`** fails unless allowlisted with a pinned resolved id.
- **Deterministic, bounded map.** A fixture proves regeneration is byte-stable under
  canonical ordering (no flaky diff) and that the committed map stays bounded (per-class
  rows + overlap summaries, not a pairwise dump).
- **No executing-import; static-parse / manifest only.** A fixture proves the
  audit/generator obtain values **only** by static parse or a pre-existing manifest and
  **never execute-import a runtime script** — so a script's top-level side effect can never
  run before the check; a needed value not statically available is declared in the catalog.
- **Protected-runtime path matrix is fixed and self-weaken-proof.** A fixture asserts the
  protected-runtime set is derived from the prerequisite issues' file inventory, that an
  edit to any protected path fails while an edit to a declared tool path passes, and that
  a diff attempting to **shrink or redefine the protected matrix itself** fails (the gated
  diff cannot author its own boundary).
- **Cross-abstraction recipient overlap is conservative.** A fixture proves an abstraction-
  level recipient pair (head-owning worker vs specific session on the same canonical
  PR/head/session-owner dimension) is **flagged** unless cleared by a `semantic_dedup_owner`
  or an evidenced override — fail toward flag, not silent miss.
- **Independent inventory is not self-sourced.** A fixture proves the #205 supervised-process
  inventory and owner/mechanism bindings used to validate the catalog come from a
  pre-existing manifest / static parse, and that the check **fails** (not catalog-self-asserts)
  when that independent source is unavailable.
- **Protected set tracks the current surface.** A fixture proves the protected-runtime set
  is computed from current send-helper callsites + #205 entrypoints + owner bindings (not
  only the historical issue file lists), so a current runtime file absent from the old
  inventory is still protected.
- **Audit roots are explicit and complete.** A fixture where a sender is reachable **only**
  through a non-helper-user root (a #205 reconciler entry / a CI-invoked script / a
  registered command entrypoint) is still detected; and a negative fixture where a real
  entrypoint (a new CI workflow / registered command / #205 entry) is **absent from the
  audit root set fails** the root-completeness check (roots validated against independent
  sources, not self-omitting).
- **Existing callsites bind without a protected-runtime edit.** A fixture proves an existing
  runtime callsite is bound to its `message_class_id` via a **catalog-declared callsite
  signature** (file/function/anchor + predicate hash), read-only, with **no edit to a
  protected-runtime file** — and that a literal id is required only at a **new** (non-frozen)
  helper boundary. The additive-only and literal-id rules do not contradict.
- **Allowlist entries drift-fail.** A fixture where an allowlisted dynamic send's source
  span changes (new raw send / changed resolved class) **fails** via source-hash drift until
  re-reviewed.
- **Trigger-predicate drift is caught even inside a stable anchor.** A fixture where the
  same `message_class_id` / helper / recipient / intent / **anchor** remain but the firing
  predicate **body changes** (e.g. "CI red after reconcile" → "CI red or timeout") **fails**
  the drift check via the predicate body-hash — the map cannot claim a stale firing
  condition.
- **Per-class claims are referenced by message-class entries, not entries themselves.** A
  fixture asserts the **message-class** entries (the CI-failure ping, the review-start, the
  journaled `ao send`) **reference** #283 / #267 / #281 in their owner fields, that the
  catalog defines no claim logic of its own, and — a negative fixture — that an **owner
  mechanism added as a standalone message-class entry with no reachable send path fails**
  the stale-entry check (an owner is not itself a message class).
- **Registration audit fails on an uncatalogued or indirect send.** Fixtures: a seeded
  raw send **outside** a registered helper (incl. an aliased / variable-built / sourced
  helper, not just a literal `ao send`) **fails** the audit and names the site; a
  catalog entry mapping to **no** reachable send path (stale) **fails**; a fully-routed,
  fully-catalogued tree passes. An allowlisted exclusion is explicit.
- **Overlap override requires evidence.** A fixture proves a manual overlap override
  missing rationale / reviewer / linked issue / affected ids / no-collision fixture is
  **rejected** — an override is not a bare flag.
- **Overlap is inferred, and delivery-idempotency does not satisfy it.** A fixture with
  two entries sharing `recipient_key` + overlapping `intent_key` and **no**
  `semantic_dedup_owner` is flagged — **even if** one declares a
  `delivery_idempotency_owner` (e.g. #281); an entry whose overlap *is* owned by a
  `semantic_dedup_owner` (e.g. CI-failure ping → #283) passes. A negative fixture proves
  delivery-idempotency alone (#281) does **not** clear an unsuppressed semantic overlap.
- **Map is committed and regeneration-checked.** A fixture asserts CI fails when the
  committed map differs from the freshly regenerated catalog output, and passes when
  they match.
- **Explicit host matrix + fail-fast off it.** The supported host is **Linux/WSL with
  Node + `pwsh` 7+**; a parity fixture asserts identical normalized audit output across
  those. **Any native-Windows execution — Windows PowerShell *and* native-Windows Node /
  `pwsh` 7 — fails fast with a clear unsupported-host error** (not a silent divergent
  local-green that disagrees with CI), since path/quoting/CRLF/glob semantics differ. A
  fixture asserts the refusal across native-Windows hosts, not only Windows PowerShell.
- **Draft-submit is audited like the `ao` commands.** A fixture with a seeded
  uncatalogued **draft-submit** side-effect (outside a registered helper / no
  `message_class_id`) **fails** the audit — the submit mechanism has the same coverage as
  `ao send` / `ao review send`.
- **Owning-process resolves to the supervisor.** A fixture proves a catalog entry whose
  owning-process is **not** in the #205 supervised inventory (renamed / removed /
  unsupervised) **fails** the check.
- **Intent taxonomy catches near-synonyms.** A fixture proves two entries with
  near-synonym `intent_key`s that overlap via the alias table to the same recipient, with
  no `semantic_dedup_owner`, are **flagged** — a colliding sender cannot pass by inventing
  a new-looking key.
- **No runtime change (no carve-out).** A fixture asserts a compliant diff edits **none**
  of the protected-runtime globs (catalog / map generator / overlap check / audit only),
  and that a diff editing **any** protected-runtime file — even to add an exported
  constant — **fails** the additive-only check. The tooling obtains values **only** by
  **static parse or a pre-existing immutable manifest** — it **never** executing-imports a
  runtime script (top-level code could run before any guard) — and any metadata not so
  available is declared in the catalog.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or AO upstream.
- No new or modified runtime claim/delivery/submit/supervisor behavior — additive
  catalog + generated doc + CI checks only.
- No new unsupervised process — the catalog/map/audit are build/CI-time artifacts, not
  a running side-process.
- No new repo secrets; the catalog stores non-sensitive message-class metadata only (no
  payloads, no session URLs, no credentials).
- No worker-terminal pane scraping.

## Verification

- Vitest/Pester fixtures for each acceptance bullet, following the existing pack test
  style (e.g. the `*-reconcile.test.ts` mechanical pattern) over synthetic catalog +
  seeded-script inputs — no live tmux.
- The single-source audit runs in CI over the pack scripts and fails on a seeded raw
  send outside a registered helper and on a registered helper with no entry; passes on
  the routed, catalogued tree.
- A committed-map regeneration-diff fixture fails when the committed map differs from the
  freshly regenerated catalog output.
- An overlap fixture proves a `delivery_idempotency_owner`-only collision is flagged and
  a `semantic_dedup_owner`-covered one passes.
- A cross-surface parity fixture compares normalized audit output on the supported
  surfaces (Node + `pwsh` 7+ on Linux/WSL).
- An additive-only fixture asserts a compliant diff edits no protected-runtime glob, and
  that any edit to a protected-runtime file (even an added export) fails the check.
- The real-tree **registration audit, overlap check, and committed-map regeneration
  diff** run in CI as **required, merge-blocking** checks — not merely local commands.
- `pwsh -NoProfile -File <audit>` and the map generator run clean on the real tree.

## Open dependencies / parked risks

- **Overlap inference is taxonomy-bounded (named residual).** Overlap is **inferred**
  from a **closed, reviewed `recipient_key` + `intent_key` taxonomy with an alias/overlap
  table** (not free text), and the registration audit forces every send through a
  catalogued helper — so a new colliding sender cannot pass by inventing a new-looking
  key or omitting a declaration. The narrow residual: assigning a genuinely new intent to
  the **wrong taxonomy node** (or failing to add an alias edge for a true synonym) is
  caught only by review of the small taxonomy change, not auto-inferred. This is
  acceptable because no live cross-type duplicate is open; the goal is legibility + a
  registration floor + inferred-overlap detection over a checked taxonomy, not a runtime
  guarantee.

## Decisions (design analysis)

- **Critical mechanics.** A declarative catalog keyed by message class; a generator that
  keeps the human map 1:1 with the catalog; an audit that enumerates real send sites and
  requires each to map to an entry; an overlap field that references the owning dedup
  instance.
- **World practice.** A **service/message catalog + lint** (like an API/endpoint
  inventory or a "every handler must be registered" CI guard) — the established cheap way
  to make scattered emitters legible without building a runtime broker.
- **Options (cost / risk / sufficiency).**
  - **(A — chosen) Catalog + generated map + overlap check + registration audit, over
    the existing unified runtime.** Cost: low. Risk: low (additive; no runtime change).
    Sufficient: delivers the user's literal ask (registry, map, duplicate check) and a
    registration floor; references shipped claims instead of rebuilding them.
  - **(B — rejected) A new single runtime egress + shared claim authority** (the earlier
    1100-line version of this draft). Cost: high. Risk: high — it **re-implements**
    #205/#232/#281/#283/#267 (already merged), duplicating tested machinery and inviting
    regressions, for a duplicate class that is no longer open. Rejected as redundant.
  - **(C — rejected) Documentation-only catalog, no audit.** Cost: lowest. Risk:
    insufficient — without the registration audit the catalog silently rots as new
    senders are added, recreating the legibility gap.
  Per the repo cost rule (cheapest sufficient executor) → **A**.
- **Scope correction.** The earlier version of this draft was written when the CI-red
  double-ping looked like an open bug; verification showed it is fixed (#283/PR #289),
  and that #205/#232/#281 already unify the runtime. So the scope was cut from
  "build a new egress" to "catalog + guard the existing one." The runtime-dedup
  guarantees stay where they already live.

## Decisions (GPT adversarial pass)

This is the **lean rewrite** of an earlier 1100-line version of this draft. That version
proposed a *new* single runtime egress + shared claim authority; verification later showed
the motivating CI-red double-ping was already fixed (#283/PR #289) and the runtime already
unified (#205 host, #232/#281 source-agnostic journaled delivery), so the new-egress design
was ~80% redundant with merged work. The scope was cut to **catalog + map + overlap +
audit over the existing runtime**, and re-run through the GPT loop from scratch — 13 passes,
every pass `STATE=completed_valid` / `VALIDATION=ok`.

- **Pass 1** (5): overlap was author-declared → inferred from canonical `recipient_key` +
  `intent_key`; split `delivery_idempotency_owner` vs `semantic_dedup_owner` (only the
  latter clears overlap); audit robust to indirect emitters (named helpers); supported-
  surface parity; committed-map regeneration (no circularity).
- **Pass 2** (6): keyed the catalog by **`message_class_id`** (a new class behind an
  existing helper is caught); independent baseline enumeration (not the catalog's own
  universe); owner refs resolve to real mechanisms; structured overlap override; explicit
  protected globs; merge-blocking CI.
- **Pass 3** (1): removed an additive-only self-contradiction — **no** runtime-file edits at
  all (static-parse / catalog-declared metadata).
- **Pass 4** (4): draft-submit gets an auditable signature; owning-process resolves to the
  #205 inventory; `intent_key` is a closed reviewed taxonomy + alias table; explicit
  unsupported-host refusal.
- **Pass 5** (2): alias table applies to `recipient_key` too (cross-abstraction targets);
  a reused `message_class_id` at a divergent callsite fails.
- **Pass 6** (5): `semantic_dedup_owner` declares a **coverage scope** (real-but-wrong-scope
  owner is caught); no executing-import side effects; explicit protected-path matrix;
  override evidence is concrete (not circular); host matrix complete.
- **Pass 7** (4): fail-closed static audit (unanalyzable construct → fail); literal/static
  `message_class_id`; deterministic + bounded map; owner-coverage bound statically with the
  behavioral proof a **named residual** owned by #283/#267/#281 (not re-validated here).
- **Pass 8** (2): protected boundary derived from the prerequisite inventory and **immutable
  to the gated diff**; cross-abstraction recipient overlap is conservative (fail toward
  flag).
- **Pass 9** (3): independent baselines come from a pre-existing manifest, **never** the
  same catalog (audit compares two sides it doesn't both author); trigger bound to a code
  anchor; owner mechanisms are referenced by message-class entries, never standalone
  entries.
- **Pass 10** (4): protected set tracks the **current** runtime surface; explicit audit root
  set; finding-routing's send sites are **not** exempt from the audit; allowlist entries
  drift-fail by source hash.
- **Pass 11** (2): trigger bound to a **predicate-body hash** (a logic change inside a stable
  anchor is caught); dropped the executing-import fallback entirely.
- **Pass 12** (2): resolved a contradiction between "literal `message_class_id`" and "no
  protected-runtime edit" — existing callsites bind via a **catalog-declared callsite
  signature** (no runtime edit), literal ids only for new helper APIs; audit root set
  validated for completeness against independent sources.
- **Pass 13** (0): **clean empty APPROVE** — genuine convergence (substantive summary
  enumerating the present mechanisms + correctly classified residuals), not a lazy pass.

**Considered and rejected — the new-runtime-egress design** (the prior 1100-line draft, and
GPT's recurring "build a gateway" framing): rejected as redundant re-implementation of
merged #205/#232/#281/#283/#267 for a duplicate class that is no longer open. **Considered —
splitting/narrowing further** (GPT passes 7/11/12): folded into the lean scope rather than
split, since the catalog + audit + overlap is already small and coherent.

**GPT loop: 13 passes; stopped because no-accepted-finding-in-last-pass; last-pass
accepted=0; final STATE=completed_valid VALIDATION=ok
pass=4ecc333b-fb3c-46f9-be68-a565bc87d7d0
sha=e1f73324b5f7920019124b57aa7857333908104d87e47fd60a3ccd0d8603bc50.** Genuine convergence
(clean empty APPROVE after 12 finding-bearing passes; no critical after the scope cut, no new
design class in the last passes). The normal architect Codex review covers the converged
draft as it now stands.
