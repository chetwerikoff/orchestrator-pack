# Spec contract-evidence: ground every upstream binding before sync

GitHub Issue: #366

## Prerequisite

- `docs/issues_drafts/75-rca-spec-discipline-against-misdirected-fixes.md`
  (GitHub #221, closed) — *already does:* requires a positive-outcome
  acceptance criterion whose input is external-tool output to be
  production-representative (capture-backed / sample-backed). This draft
  **generalizes that principle** from one criterion type to *every* binding the
  spec makes to an upstream datum — at draft-authoring time, not only inside a
  positive-outcome criterion.
- `docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md`
  (GitHub #223, closed) — *already does:* maintains per-state capture-backed
  reference fixtures and detects phantom fields at test-fixture time. The
  capture corpus this draft's `capture@` references point at **is the same
  capture-backed evidence #76 maintains**; this gate consumes it one layer
  earlier (authoring), it does not duplicate the fixture-time guard. This draft
  also **relies on #76's capture-generation discipline** for the genuineness of
  the captures its manifest references — it requires generated, not
  hand-authored, captures rather than re-deriving capture authenticity itself.
- `docs/issues_drafts/115-reviewer-coworker-contract-mapping-pass.md`
  (GitHub #362, open) — *forward relationship, out of scope here:* the
  reviewer-time re-verification of these `contract-evidence` rows against
  producer reality belongs in #362's contract-mapping pass (extended to also
  validate evidence rows), not in this draft. This draft owns the
  **authoring-time** layer only.

## Goal

Close the recurring failure class where a spec binds to an upstream datum — a
field, event, state, or CLI output of an external producer (`ao` / `gh` /
codex) — that does not exist, or does not carry the asserted value, and the gap
is caught only after the implementation faithfully encodes the fiction:
green tests on hand-shaped fixtures over a path that is structurally
unreachable in production. Recurrences: review-trigger head-binding (predicate
keyed to a head SHA `ao report` never stores), the CI-failure suppressor
reading `session.status` where the relevant state lives in
`reports[].reportState` (#342), the session-runtime liveness predicate bound to
a field `ao status` omits (#250), and worker-message delivery against an
unverified send/consumption shape (#347 / PR #351).

Add an **authoring-time contract-grounding step** to the `create-issue-draft`
skill: before a draft is synced, every binding it makes to an external
producer's datum carries inline evidence that the datum is real — either a
committed capture in which the datum appears with the asserted value, or an
explicit declaration that the **eventual implementing PR** will *create* the
datum, together with an acceptance criterion that verifies the **producer**
emits it. A mechanical,
fail-closed pre-sync check refuses the sync when a declared binding lacks valid
evidence (or the block is absent), while completeness — that no binding was
omitted — is established by the contract-grounding ask and review, not the
linter (see Binding surface).

```behavior-kind
action-producing
```

## Binding surface

- `create-issue-draft` gains a **contract-grounding authoring step**. For every
  upstream datum the draft's **Binding surface**, **Acceptance criteria**, or
  **Verification** depends on — any field / event / state / CLI output / flag,
  whether of an **external** producer the draft consumes **or** of a **repo-owned**
  producer the eventual implementing PR will add the datum to (the latter taking
  the `NEW` form) — the draft carries a row in its `contract-evidence` block.
  Repo-owned producers are not exempt: a datum the implementing PR will create is
  exactly what the `NEW` pathway must cover, so it is part of the binding surface.
- **The block is mandatory in every draft, and its absence fails the check.** A
  draft that makes no upstream binding must carry an explicit affirmative
  `contract-evidence: none` declaration rather than omitting the block — so an
  *omitted* binding becomes an affirmative, reviewable claim ("this draft binds
  to nothing external") that a reviewer can challenge, instead of silently
  passing the gate. The check does **not** attempt to heuristically detect
  whether unannotated prose references a producer (that pattern-match is
  unreliable and would narrow planner freedom with false positives); the
  mechanical teeth are block-presence + grounding of every *declared* row.
- **Completeness is not a mechanical guarantee — and the draft does not claim it
  is.** The check cannot prove that *no* upstream binding was omitted from a
  nonempty block (the partial-omission case), because that would require the
  rejected heuristic prose-scan. Completeness is instead established by the
  **contract-grounding ask** (which enumerates candidate bindings appearing in
  the draft's surfaces and flags any that lack a row), the **Codex architect
  review of the draft** (which independently checks reality + completeness — see
  below), and the post-code reviewer challenge (#362). The mechanical gate
  guarantees *declared bindings are grounded*; *all bindings are declared and
  real* is owned by the grounding ask + Codex draft review + #362, not the
  linter.
- Each `contract-evidence` entry asserts exactly one binding and carries
  **exactly one** of two evidence forms — there is no third option ("I believe
  it exists" is not admissible):
  - a reference to a committed capture, resolved through a **committed capture
    manifest** rather than a raw path. The manifest records, per capture, its
    **producer, source command, kind (structured/unstructured), repo-relative
    path, and tracked content hash**; a `contract-evidence` capture row
    references a manifest entry plus the datum's selector/value. This makes
    grounding checkable on facts the row cannot self-assert: the check rejects a
    row whose **declared producer does not match the manifest's** (so a
    `producer: ao` row cannot ground against a `gh`/codex/synthetic capture that
    merely happens to contain the selector — the subtle reopening of the failure
    class); rejects **token evidence whenever the capture parses as structured
    data of any kind — object, array, or scalar — or the manifest marks it
    structured** (so no JSON shape can be smuggled through as "unstructured
    text"); and inherits **confinement + integrity from the
    manifest** — every manifest path is git-tracked, inside the capture corpus,
    hash-verified, with no absolute path / `..` traversal / symlink escape.
    Manifest entries must **originate from a controlled capture-generation path**
    (the #76 corpus discipline) that records the generating source command, and
    the check verifies manifest integrity by **regenerating the manifest from the
    committed capture corpus and comparing** (offline, deterministic) — so a
    hand-edited manifest entry, even one carrying a plausible-but-fake source
    command, fails because it does not match the regenerated manifest. The
    gate's claim is therefore precise: it proves the asserted value exists in a
    producer-tagged, generated, committed capture whose manifest reproduces from
    the corpus — the genuineness and scrubbing of the underlying capture
    *content* is owned by the #76 capture discipline this builds on, not
    re-derived here (see Upgrade-safety for the residual this leaves).
    Structured captures require a **selector + expected value** (the check
    confirms the value *at that path*, not a substring anywhere in the file);
    bare-token evidence is admissible only for captures the manifest marks
    unstructured CLI text. A binding to a **CLI flag or command behavior** is
    *not* groundable by bare-token presence (a `--flag` string in help text does
    not prove the command accepts it or behaves as asserted — the command-accuracy
    failure class): such a binding requires a capture of the **actual invocation
    whose manifest entry carries a machine-readable exit status** (a required
    field for command/behavior captures) that the row asserts as successful,
    plus the behavior-specific output — not merely that the flag string appears
    (a failed command often emits help text or echoes the supplied flag, so a
    nonzero/failed exit must be rejected). Failure diagnostics **redact
    capture contents** so
    the check is never a local-file/secret oracle. The manifest schema is the
    planner's to design; the spec fixes only the facts it must record and the
    checks that consume them.
  - an explicit marker that **the eventual implementing PR will create the
    datum** (the spec/sync PR being authored now does not). `NEW` is
    admissible **only for a producer in a closed repo-owned producer registry**
    — a deterministically-classifiable emitter path/command the implementing PR
    can actually modify (the pack's own reports, reconcilers, scripts). A datum
    of an external producer this repo cannot change (`gh`, codex, AO product
    internals — including alias spellings like `gh-cli` / `codex-cli`) is **not**
    in the registry and **cannot** use `NEW`; it must carry capture evidence
    instead. The marker names the acceptance criterion that proves the producer
    emits it, and that criterion must carry a **machine-readable
    producer-emission assertion** (reusing the existing positive-outcome marker:
    producer + datum selector/token + expected value + the command or capture
    that proves emission) — so the check is decidable without parsing prose
    intent. A `NEW` whose named criterion only asserts a *consumer* reading the
    datum reopens the exact "consumer encodes a fiction nobody produces" hole
    (#342). A `NEW` row is **not an authoring-time existence proof** (the datum
    does not yet exist) — it is a machine-readable **obligation** that the
    authoring gate only requires to be well-formed, registry-valid, and
    **recorded in the issue body** (the durable queue artifact). Its
    *fulfillment* — that the producer actually emits the datum by code time — is
    **re-verified post-code by #362** (checkpoint 2: the reviewer confirms the
    producer-emission, e.g. via the named producer test, on the real diff). The
    standalone CI-enforcement lifecycle of `NEW` obligations (protected snapshot,
    privileged publication, tamper-resistant implementation-CI execution) is a
    separable build, **out of scope here** — folding it into a single authoring
    gate produced an unresolvable sync-only chicken-and-egg; the reviewer layer
    (#362) is the right enforcer. Until fulfilled-and-reviewed, a `NEW` row is a
    tracked promise, not evidence.
- The structured collection of candidate evidence is **delegated to a coworker
  contract-grounding ask**, modeled on the reviewer-side requirement-ledger
  pattern in #362: it maps each proposed binding to a producer-corpus location
  and returns `found` / `not_found` + evidence location. This output is
  **explicitly non-authoritative**: the architect independently re-validates
  every row against the cited artifact before committing it into the draft.
  Coworker performs the bulk corpus I/O; the existence verdict stays on the
  reasoning model. This is a **recipe documented in the skill**, not executable
  code in this draft's scope.
- A **mechanical pre-sync check** (extending the existing draft-discipline
  mechanical-check family that already validates `positive-outcome` and
  `parked-root`) validates `contract-evidence`: it is **fail-closed** and the
  `create-issue-draft` sync step refuses to run `gh issue create` / `gh issue
  edit` while it exits non-zero, exactly as the existing pre-sync checks gate
  sync today. The block's required semantic fields (binding, producer,
  evidence-form, and for structured captures a selector + expected value) are
  mandatory and machine-parseable. Each row carries a **canonical binding
  identity** (a normalized producer + datum identity, distinct from display text
  and selector spelling) so the check can decide when two rows describe the same
  upstream datum; **two rows with the same binding identity but conflicting
  evidence are rejected**. The identity derives normatively from
  `(canonical-producer, canonical-datum)`: the producer is mapped through the
  closed registry so alias spellings (`gh` / `gh-cli`) collapse to one canonical
  name, and the datum is reduced to a canonical form — its selector's canonical
  path form for structured captures, or the normalized asserted token for
  unstructured/token captures (so token-based bindings derive an identity too) —
  so two rows naming the same datum under different spellings get the *same* identity
  and their conflict is caught (AC #3g is testable against an alias-collision
  fixture). The exact normalization within that derivation, plus row grammar and
  escaping, are the planner's to choose; the spec fixes
  only *what must be present and decidable*, not *how it is spelled*. The
  authoritative block has **one canonical location**, and the check ignores any
  `contract-evidence` text appearing inside a code fence, blockquote, or example
  — so a draft cannot satisfy the gate with a `contract-evidence: none` or a row
  that lives only inside quoted/fenced example text.
- Coworker-unavailable degrades the *collection* step gracefully (the architect
  reads the producer corpus directly and still fills the block); the mechanical
  check is offline and always runs.
- The check's **fixture suite runs in CI** (pwsh 7+ on the Linux/WSL surface),
  so a later change that weakens the parser, path confinement, or `NEW`
  validation cannot merge silently — the gate protects more than just whoever
  happens to run `create-issue-draft` locally.
- **The Codex architect review of the draft independently verifies grounding —
  the reasoning counterpart to the mechanical check.** The existing draft-review
  step in `create-issue-draft` gains a contract-grounding focus area: the
  reviewer must, *separately from the linter*, check that **every** field /
  event / state / CLI output the spec binds to actually exists in its producer,
  corroborate each `contract-evidence` row against the cited capture, and flag
  any bound datum that is unproven **or any upstream reference that carries no
  row at all** (the completeness/semantic judgment the deterministic linter
  cannot make — see the absent-binding limitation above). The two are
  complementary: the linter guarantees declared rows are well-formed and their
  captures resolve; the Codex review judges whether the bindings are real and
  whether any are missing.
- **Adoption is incremental, not a flag day — via a one-time legacy list.**
  A committed list of the **pre-existing draft paths** is recorded once at
  adoption. The mandatory-block rule applies to any draft **not on that list**
  (every new draft, and any draft created after adoption); drafts on the list
  are grandfathered so the rule cannot brick maintenance of the existing corpus.
  Back-filling listed legacy drafts is not required by this issue. Growing the
  legacy list is a **reviewable action** — a reviewer challenges any addition of
  a *new* draft path to a list meant only for the pre-existing corpus; it is not
  claimed to be mechanically immutable (mechanical anti-tamper hardening of the
  list is a separable governance follow-up, see Files out of scope). This keeps
  contract-evidence consistent with the existing `positive-outcome` /
  `parked-root` pre-sync checks, which are likewise authoring-tool gates, not
  corpus-wide CI scans.
- **Scope is existence-at-authoring-time, not freshness.** A grounded
  `contract-evidence` row proves the datum existed with the asserted value *when
  the draft was authored*; it is **not** a guarantee that the producer still
  emits that shape at implementation or review time. Re-verifying these rows
  against producer reality at review time is owned by #362 and is out of scope
  here. Until #362's re-verification lands, reviewer approval must not treat an
  authoring-time row as a freshness proof.

### Operator adoption

None. This changes architect-side authoring tooling (`create-issue-draft`
skill) and a draft-discipline check; it introduces no live-YAML, listener,
environment, or restart obligation. The one-time legacy list is committed by
the implementing PR itself; no operator GitHub-side setup is required.

## Files in scope

- `.claude/skills/create-issue-draft/` — the contract-grounding authoring step,
  the `contract-evidence` block format, the coworker contract-grounding ask
  recipe, the mandatory re-validation rule, and the sync-gate wiring.
- `scripts/**` — the mechanical `contract-evidence` validation, extending the
  existing draft-discipline check family.
- Test fixtures for the new check (location at planner discretion).
- The **capture manifest** (its format, generation from the #76 capture path,
  and the integrity regenerate-and-compare check) and the **one-time legacy-path
  list**.
- `.github/workflows/**` — wiring the check's fixture suite and the
  manifest-integrity check into CI (extending or adding to the existing
  draft-discipline CI path).

## Files out of scope

- `docs/issues_drafts/115-reviewer-coworker-contract-mapping-pass.md` and the
  reviewer-side contract-mapping pass (#362) — the reviewer re-verification of
  `contract-evidence` rows is folded into #362 separately.
- `prompts/agent_rules.md` reviewer checklist — same reason (#362).
- **The standalone CI-enforcement lifecycle of `NEW` obligations** — protected
  snapshot, privileged publication, and tamper-resistant implementation-CI
  execution of the producer-emission test. The authoring gate only records the
  obligation in the issue body; fulfilling and re-verifying it post-code is
  #362's reviewer responsibility (a separable build, not this authoring gate —
  collapsing it into a single sync-only gate produced an unresolvable
  publication chicken-and-egg).
- **Mechanical anti-tamper hardening of the legacy-path list** (immutability /
  owner-gating so a PR cannot add a *new* draft path to dodge the gate). The
  list is a one-time legacy snapshot; abuse is caught by ordinary code review.
  Mechanically locking it against the PRs it governs is a separable governance
  build (it ran into a CODEOWNERS bootstrap-ordering problem), out of scope here.
- The raw capture files' authenticity/scrubbing discipline (owned by #76) and
  any AO / `gh` / codex product code. **The capture manifest is in scope** — its
  format, its generation from the #76 capture path, and the check's consumption
  of it are part of this issue; only the genuineness of the underlying capture
  *content* stays with #76.
- `.cursor/skills/create-issue-draft/` pointer — generated by
  `scripts/generate-skill-pointers.ps1`, never hand-edited.

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
.claude/skills/create-issue-draft/**
.github/workflows/**
tests/**
docs/**
```

The capture manifest, legacy-path list, and check fixtures must live within
these allowed roots (planner chooses where within them); they may not be added
outside, so the scope fence stays deterministic.

## Acceptance criteria

1. `create-issue-draft` documents a contract-grounding authoring step and the
   `contract-evidence` block format: each entry names the binding, the
   producer, and exactly one of the two evidence forms (committed capture — with
   a selector + expected value for structured captures — or `NEW` with a named
   producer-emission-verifying acceptance criterion), with the "no third option"
   rule and the mandatory-block / explicit-`none` rule stated explicitly.
2. The skill documents the **structured coworker contract-grounding ask** as the
   collection mechanism **and** mandates independent architect re-validation of
   every returned row, stating that the coworker `found` / `not_found` verdict
   is non-authoritative. The ask also **enumerates candidate bindings appearing
   in the draft's surfaces and flags any that carry no row**, so omitted bindings
   surface for architect + reviewer judgment (completeness is not the linter's
   job). The mechanical check **re-derives every existence claim
   from the committed manifest + capture independently of any coworker output**,
   so a row copied blindly from coworker that does not actually ground fails the
   check — the auditable artifact is the mechanical re-derivation, not a
   self-attested marker. Provable from the skill text plus the check failing a
   fixture whose row matches a coworker `found` verdict but no real capture.
3. The mechanical check rejects each violation class with a distinct, actionable
   message, and a well-formed grounded block passes. Provable by fixtures — one
   passing draft plus one fixture per class:
   a. for a **new or post-adoption draft** (one not on the legacy-path list —
      so AC #6's grandfathering does not apply), the `contract-evidence` block is
      absent from its one canonical location (neither a grounded block nor an
      explicit `none`), including a draft whose only `contract-evidence` text
      sits inside a code fence, blockquote, or example;
   b. a malformed entry (a required field missing or unparseable);
   c. a capture row referencing a manifest entry that does not exist, whose
      manifest path is untracked / git-ignored / hash-mismatched / escapes the
      capture corpus (absolute path, `..` traversal, symlink escape), or whose
      manifest entry carries no capture-generation provenance (hand-authored);
   d. a capture row whose **declared producer does not match the manifest's**;
   e. a structured-capture reference whose selector resolves to a value other
      than the asserted one; a **token** reference against a capture the manifest
      marks structured or that parses as structured data of **any** kind —
      object, array, **and** scalar (a fixture for each of the three); or, for an
      unstructured capture, an absent asserted token;
   f. a `NEW(produced-by AC#k)` marker that: names no acceptance criterion in
      the same draft; names one carrying no machine-readable producer-emission
      assertion (or one asserting only a consumer read); or targets a producer
      not in the closed repo-owned producer registry (`gh` / codex / AO product
      internals and their alias spellings);
   g. two rows with the same canonical binding identity but conflicting
      evidence (including semantically identical bindings spelled differently);
   h. a CLI flag/behavior binding whose manifest entry carries no machine-readable
      exit status, or whose recorded exit status is not the asserted successful
      one (e.g. a failed invocation that merely echoes the flag in its output).
   Failure diagnostics for capture checks redact file contents.
4. The check is wired as a **hard pre-sync gate** in `create-issue-draft`: the
   sync step refuses to create or edit the GitHub issue while the check exits
   non-zero, alongside the existing `positive-outcome` / `parked-root` checks.
   Provable from the skill's sync-gate text plus the check's non-zero exit on a
   violating fixture.
5. The check runs offline (no AO / network dependency), is invocable with
   pwsh 7+ on the Linux/WSL authoring surface, and resolves manifest capture
   paths that contain spaces using OS-separator-agnostic path handling.
6. Adoption is incremental via a one-time committed legacy-path list: the
   mandatory-block rule applies to any draft not on the list (new or
   post-adoption), and a listed legacy draft is grandfathered. Provable by a
   fixture: a new draft (absent from the list) is gated; a listed legacy draft
   without a block is not gated.
7. The `create-issue-draft` architect-review step (the Codex draft review)
   carries a **contract-grounding focus area**: the reviewer independently
   verifies that every field / event / state / CLI output the spec binds to
   exists in its producer, corroborates each `contract-evidence` row against its
   capture, and flags any unproven binding or any upstream reference with no row.
   Provable from the review focus-area text (in the skill / review prompt).
8. At the authoring gate, a `NEW` row is well-formed, names a producer in the
   closed repo-owned registry, carries a machine-readable producer-emission
   assertion, and is **recorded in the issue body** as a durable obligation.
   Provable from the synced issue body containing the `NEW` row's obligation.
   The authoring gate does **not** execute the producer test or own a
   tamper-resistant CI lifecycle for the obligation — fulfilling and
   re-verifying it post-code is #362's job (see Files out of scope).

```positive-outcome
asserts: a contract-evidence capture row whose cited manifest capture contains the asserted value at its selector is accepted by the check (capture-backed grounding), while a capture row whose capture lacks that value is rejected and blocks sync
input: external-tool-output
provenance: capture-backed
```

## Upgrade-safety check

- The check reads draft text and the filesystem only; it binds to **no** AO
  field or `ao status` shape, so an AO version bump cannot make it
  unsatisfiable (the failure mode it guards against).
- Coworker absence does not disable the gate: the mechanical check is
  independent of the coworker collection step.
- The `contract-evidence` block is additive draft structure; a draft with no
  upstream binding satisfies the gate with an explicit `contract-evidence: none`
  declaration (the check never passes vacuously on an absent block).
- Authoring-time grounding is an existence proof at authoring time only; it does
  not assert freshness and does not depend on #362 having landed. This draft is
  independently shippable, and #362's reviewer-time re-verification can land
  before, with, or after it.

**Known residual risks (accepted, bounded by design):**

- *Fabricated capture content.* The manifest integrity check (regenerate +
  compare) catches a hand-edited manifest, but a capture *file* that was
  hand-shaped yet passes #76's generation/scrubbing discipline is outside this
  gate's reach — fully closing it requires live re-capture against the producer,
  deliberately not adopted here (cost/flakiness). This residual is owned by #76's
  capture authenticity discipline.
- *`NEW` obligation not yet executed.* A `NEW` row is a tracked promise, not
  authoring-time evidence; if the producer-emission acceptance criterion is
  somehow not executed and review misses it, a repo-owned fictional datum could
  still slip. Closing this is the executable producer-emission AC (CI) plus
  #362's reviewer re-verification, not this authoring gate.

## Verification

- Run the new draft-discipline check against fixture drafts: a grounded draft
  (and a draft declaring `contract-evidence: none`) passes (exit 0); one fixture
  per violation class from AC #3 (absent block; malformed entry; missing capture
  file; structured-selector value mismatch and absent unstructured token;
  `NEW` naming no AC and `NEW` naming a consumer-only AC; conflicting duplicate
  rows) each exits non-zero with its distinct message.
- Include a fixture whose `capture@` path contains a space to prove
  OS-separator-agnostic resolution.
- Include a fixture proving capture-root confinement (via the manifest): an
  absolute path, a `..` traversal, a symlink escape, and an untracked/git-ignored
  or hash-mismatched manifest entry each exit non-zero, and a failed capture
  check's diagnostics contain no file contents.
- Include a producer-mismatch fixture (`producer: ao` row citing a manifest
  entry whose producer is `gh`) exiting non-zero, and a token-against-structured
  fixture (token evidence for a manifest-marked structured/JSON capture) exiting
  non-zero.
- Include a `NEW` fixture targeting an external producer (`gh`/codex, and an
  alias spelling) exiting non-zero, and a repo-owned registry `NEW` with a
  machine-readable producer-emission assertion passing.
- Include a generation-provenance fixture: a manifest entry with no recorded
  capture-generation source command exits non-zero.
- Include a duplicate-identity fixture: two rows with the same canonical binding
  identity (different selector spellings) but conflicting evidence exit non-zero.
- Include a legacy-list fixture: a new draft absent from the committed legacy
  list is gated; a listed legacy draft without a block is not gated.
- Include a CLI-behavior fixture: a flag binding whose manifest capture records a
  failed/nonzero exit (output merely echoing the flag) is rejected, while one
  recording the asserted successful exit with the behavior-specific output passes.
- Include an authoring-time `NEW` fixture: a well-formed `NEW` row naming a
  registry producer with a machine-readable producer-emission assertion passes
  the authoring gate and the obligation appears in the synced issue body.
- Include a fake-provenance fixture: a hand-edited manifest entry with a
  plausible source command fails the regenerate-and-compare integrity check.
- Include a fenced/quoted fixture: a draft whose only `contract-evidence: none`
  (or a row) appears inside a code fence, blockquote, or example is gated.
- Show the `create-issue-draft` sync gate invoking the check and refusing sync
  on a non-zero exit (mirroring the existing pre-sync check invocations).
- The fixture suite runs in CI (pwsh 7+, Linux/WSL surface) and fails the
  workflow on any violation-class regression.
- All check invocations succeed under pwsh 7+ on the Linux/WSL authoring surface
  with no AO running.

## Adversarial review log (discuss-with-gpt)

GPT loop: 5 passes; stopped because cap-5 (operator-set); last-pass accepted=5; final STATE=completed_valid VALIDATION=ok pass=c303dee9-aaa8-45b1-bff2-c2e0f64ecd7a sha=b4f8ca864beca9159a7fdbc7ea25a38059b8b58a4a8153f36862217e3b0908ee

- **Architect Codex-review cycle (after GPT, converged):** the pass-5 changes
  plus an operator-requested addition (Codex draft-review independently verifies
  every bound field/event/state/output) went through a multi-round architect
  Codex review to NO_FINDINGS. That cycle drove two scoping decisions: the
  `NEW`-obligation CI-enforcement lifecycle and the legacy-list anti-tamper
  hardening were both scoped OUT of this authoring gate (→ #362 / a separable
  follow-up) after each generated an unresolvable bootstrap chicken-and-egg;
  and tightened CLI-flag evidence (exit-status), capture↔producer matching,
  structured/token rejection, canonical binding identity, and
  completeness-ownership (mechanical linter grounds declared rows; the Codex
  draft review + grounding ask + #362 own completeness/reality).
- Pass 1 (NEEDS_ATTENTION, 6): mandatory block + explicit `none` (rejected
  heuristic prose-scan); NEW must assert producer side; selector+value for
  structured captures; duplicate-row rejection; WSL-scope + path-spaces;
  authoring-time ≠ freshness (→ #362).
- Pass 2 (BLOCKED, 5): capture-root confinement + redaction; git-tracked
  committed captures; NEW only for repo-owned producers; machine-readable
  producer-emission marker; checker fixture suite in CI.
- Pass 3 (NEEDS_ATTENTION, 4): adopted capture **manifest** (producer/command/
  kind/path/hash) — producer-match + structured/text anchoring + confinement;
  closed repo-owned producer registry; incremental adoption.
- Pass 4 (NEEDS_ATTENTION, 4): generation-provenance for manifest entries +
  precise claim; durable path+hash adoption baseline; mechanical re-derivation
  independent of coworker (rejected self-attested marker as ceremony); canonical
  binding identity for conflict detection.
- Pass 5 (NEEDS_ATTENTION, 5): immutable baseline + CI guard against bypass;
  manifest regenerate-and-compare integrity (fake source-command); manifest +
  baseline put explicitly in scope; NEW reframed as deferred obligation;
  canonical block location (ignore fenced/quoted). Residuals recorded:
  fabricated capture content (owned by #76) and unexecuted NEW obligation
  (owned by executable AC + #362).
