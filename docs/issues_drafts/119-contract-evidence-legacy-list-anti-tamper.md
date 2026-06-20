# Mechanically guard the contract-evidence legacy-grandfather list against self-exemption

GitHub Issue: #377

## Prerequisite

- `docs/issues_drafts/117-spec-contract-evidence-grounding-gate.md`
  (GitHub #366, closed — merged via PR #367) — *already does:* ships
  `scripts/contract-evidence-legacy-drafts.json`, a one-time committed list of
  pre-#366 draft paths grandfathered from the mandatory `contract-evidence`
  block. #366 **explicitly deferred** mechanically hardening this list: *"Mechanical
  anti-tamper hardening of the legacy-path list (immutability / owner-gating so a
  PR cannot add a new draft path to dodge the gate) … is a separable governance
  build (it ran into a CODEOWNERS bootstrap-ordering problem), out of scope here."*
  This draft is that deferred build.

## Goal

The legacy-grandfather list is a **one-time snapshot** of drafts that existed
before the contract-evidence gate and are exempt from carrying the mandatory
block. Today nothing mechanical stops a PR from **adding a new draft's path to
that list** to dodge the gate — the abuse is caught only by human review. Add a
mechanical guard so an ordinary PR **cannot self-grandfather**: additions to the
list are refused unless owner-authorized, while removals (a legacy draft
graduating to full compliance) stay free because they only make the gate
stricter.

```behavior-kind
action-producing
```

## Binding surface

What the repo commits to:

- **Canonical governed surface.** The guarded artifact is the committed legacy
  list at its current shipped path `scripts/contract-evidence-legacy-drafts.json`.
  Deletion, rename, replacement-by-pointer, or config-redirection to a different
  location is itself a **guarded change** (the "mutable anchor" trap — a guard
  whose anchor can be moved by the very PR it governs is no guard). The governed
  surface also includes **the authoring gate's legacy-list resolution path** —
  the way the consumer locates/loads the list (`scripts/contract-evidence.mjs`'s
  resolution, not its unrelated logic): a change that redirects, disables, or
  adds a fallback to that resolution is a guarded change, so the list cannot be
  bypassed by leaving the JSON untouched while pointing the consumer elsewhere.
- **Trusted execution (the guard cannot grade its own attacker-controlled copy).**
  The guard runs from a **trusted base/target-branch version**, invoked from a
  **single pinned trusted entrypoint that does not depend on PR-head
  scripts/config**, and treats PR diff data as **input only**. Because the
  entrypoint is pinned and base-resolved, an attempt to retarget it via PR-head
  `package.json` scripts, shell wrappers, npm/task aliases, action inputs, or
  workflow path-filters is **inert** — the guard still runs the trusted version
  and still catches the change (the planner need not enumerate every possible
  retargeting file; it must prove the pinned path ignores them).
- **Governed surface = an explicit governed-file manifest.** The governed surface
  is **enumerated** (a committed manifest), comprising: the legacy list file + its
  resolution path, the guard's own logic and fixtures, the guard's CI/workflow
  wiring, and the exact files the pinned entrypoint actually depends on. The
  verdict is computed over the **full governed-surface diff**, not only the JSON
  list-file diff. **Any** modification to the governed surface requires the same
  non-PR-controlled owner authorization — **even when no path is added in the
  same diff**. This closes both the same-diff attack (add a path *and* doctor the
  guard at once) **and** the two-step attack (PR 1 weakens the guard with no path
  added; PR 2 adds the path under the weakened guard). The governed-file manifest
  is itself part of the governed surface (it cannot be silently shrunk), and its
  **dependency-closure is re-validated on every protective-machinery/manifest
  change** — so an owner-authorized guard update that adds a dependency but omits
  it from the manifest fails closure, leaving no ungoverned dependency for a later
  ordinary PR (the post-evolution two-step bypass is closed too).
  **Two distinct rules, no contradiction:** (a) changes to the **legacy list
  content** follow the add(→auth)/remove(→free) rule above; (b) changes to the
  **protective machinery** (guard logic/fixtures, wiring, resolution path,
  manifest, pinned entrypoint deps) require owner authorization. A legitimate
  path **removal** is rule (a) and passes freely; it is not a "governed-surface
  modification requiring auth" under rule (b).
- **Least-privilege authorization lookup.** The owner-authorization check runs in
  **trusted code with minimal read-only permissions**; privileged tokens are
  **not exposed to PR-head code** before the guard completes. The lookup cannot be
  run by, or have its result forged by, PR-controlled workflow code (credential
  leakage is a named failure class for this pack). This is **workflow-ordering
  falsifiable**, not a static assertion: a negative CI/dry-run check proves
  PR-head checkout/scripts cannot observe privileged auth material before the
  trusted guard step completes.
- A mechanical guard (CI and/or pre-sync — planner's choice of surface) decides
  on the **net change to the set of grandfathered paths**, computed over a
  **single canonical path contract shared with the consumer** (one repo-internal
  canonicalizer used by **both** the guard and the authoring gate's resolution, so
  they cannot disagree on path identity). Canonicalization is **byte-exact,
  case-sensitive, repo-relative POSIX normalization** — strip `./`, normalize
  separators, collapse exact-byte duplicates — with **no live-filesystem or
  symlink resolution, no case-folding, and no Unicode folding** (the pack is
  Linux-primary / case-sensitive FS, #39). Folding would be a hole, not a help: it
  would wrongly equate two distinct files, letting a new `docs/Foo.md` launder the
  exemption of a grandfathered `docs/foo.md` with no "added path" event. So
  case/Unicode variants are **distinct** entries — adding one when a variant is
  listed **is** an addition the guard catches; symlink/path-graph mutations cannot
  create equivalence because no filesystem resolution happens; an exact-byte
  malformed/duplicate entry fails. The comparison is over this byte-exact form, not
  raw text or order:
  - **Added path** (the abuse vector) → **fail**, unless the change carries valid
    **owner authorization** (below).
  - **Removed path** (a draft graduating to compliance) → **pass** freely.
  - **Reorder / reformat with an identical normalized path set** → **pass**.
- **Owner authorization must come from a non-PR-controlled trust root.** This is
  the security crux: an addition is accepted only when authorized by a signal the
  untrusted PR diff **cannot itself produce or modify** (e.g. a maintainer-owned
  out-of-band change, a GitHub-side CODEOWNERS/branch-protection approval, or an
  equivalent trusted root — the planner picks which). A **generic** approval
  (e.g. a plain CODEOWNERS/branch-protection sign-off) counts **only** when
  wrapped by trusted code that derives and checks the **exact normalized
  added-path set + base/head SHA**; a bare "owner approved" with no binding to the
  specific change does **not** satisfy the gate. Authorization material
  introduced or changed **by the same diff** that adds the path is **rejected**
  (no in-diff self-authorization: a marker file, mirrored label, or generated
  approval artifact committed in the same PR does not count). The cheapest
  sufficient shape is to accept additions **only** through a maintainer-owned
  path outside ordinary PRs; the draft fixes the *non-PR-controlled trust root*
  invariant, not the mechanism. **Authorization is scoped, not just visible:** it
  must bind to the **exact normalized added-path set and the base/head SHA** being
  evaluated; a stale, reused, or mismatched authorization (valid for a different
  path, or for a prior head) **fails** (visibility of a replayed signal is not
  acceptance). For a **no-add governed-surface change** (empty added-path set —
  e.g. a guard-logic, manifest, or workflow edit), authorization binds instead to
  the **changed governed-file set + base/head SHA**, so what was authorized is
  unambiguous. A PR that does **both** (adds a path **and** changes machinery)
  binds authorization to the **union** — the added-path set **and** the changed
  governed-file set, at the same base/head SHA.
- **Comparison base is bound.** The guard evaluates the net path-set change of
  the **PR head against its target-branch base** (the merge would-be state), not
  the working tree or a stale local diff, so an addition cannot slip in via a
  stale base. Stale-base / unresolvable-base behavior is fail-closed for **any
  gated change** — additions and governed-surface modifications alike (never
  silently pass).
- **Authoritative enforcement is a merge-blocking required check (fail-closed on
  no verdict).** The single authoritative enforcement surface is a **required,
  merge-blocking Linux CI check** that runs from the trusted base and emits a
  structured verdict (latest authoritative per base/head SHA); a **missing /
  skipped / cancelled**
  verdict (e.g. a workflow/path-filter mistake that never schedules the job)
  **fails the PR closed** — "no verdict" is never "pass". As a required check it
  runs on every PR and is therefore inherently an **availability gate** (an infra
  failure / cancellation that produces no verdict blocks *any* PR — that is the
  price of fail-closed, and is standard for any required check). For a PR that
  touches **none** of the governed surface it emits a **policy-pass** (a pass
  verdict, no policy-based rejection) — "no new gate over unrelated PRs" means **no
  policy rejection**, not "exempt from the required-check availability gate". The verdict is bound to the evaluated **base/head SHA**; if the
  **target base advances** after the verdict, a verdict computed against the
  superseded base is **not honored** — the check re-evaluates against the current
  merge base (the PR must be up to date), so a stale pass cannot ride a moved
  base. The planner may add a
  pre-sync / local run for convenience, but it is **not** the gate, and
  cross-platform (Windows) local execution is **out of scope** (the pack is
  Linux-primary, #39) — so the optional-surface bypass and OS-divergence are both
  removed.
- **Operator adoption.** Two repo-admin branch-protection settings a workflow
  cannot self-confer, named here so AC#13 is actually enforceable (not just
  asserted): (1) mark the check a **required status check** on its name (so a
  missing/failed verdict blocks merge); (2) enable **strict "require branches to
  be up to date before merging"** — without it GitHub keeps honoring a passing
  required check on the unchanged head SHA even after the target base advances, so
  the stale-base re-evaluation would not actually fire. **Adoption ordering:** the
  **operator/admin lands the guard-introducing PR** (fixture/e2e bootstrap — see
  "First-guard-commit bootstrap"), **then** applies both settings; from the first
  guard-bearing base, enforcement is live. The implementing PR ships
  the workflow + check; the **operator** applies both settings, and adoption is
  **verifiable** via `gh api repos/{owner}/{repo}/branches/{branch}/protection`
  (assert the check name is in `required_status_checks.contexts` and
  `required_status_checks.strict = true`). AC#13's "fails-closed" guarantee is
  **conditional on this adoption**: the PR proves the workflow's verdict behavior;
  the operator-adoption check proves the admin settings are live.
- **Structured verdict.** The verdict is not a bare pass/fail: it carries the
  added/removed paths, the base/head SHAs compared, the authorization-source
  type/id (for an authorized addition), and a reason — so an authorized addition
  leaves reviewable evidence of *what* was authorized by *which* trust root, and a
  replayed/stale signal is visible. This is a structured verdict, **not** a
  durable append-only audit store (that subsystem is out of scope — see Files out
  of scope).

This is a decision/governance mechanism, so it fixes the **whole class**, not the
one observed abuse. Boundary conditions (each gets a fixture in Verification):

1. **PR adds a path, no owner authorization** → fail with an actionable message.
2. **PR adds a path with valid non-PR-controlled owner authorization** → pass.
3. **PR adds a path AND introduces/modifies the authorization source in the same
   diff** (self-authorization) → **fail** — authorization must pre-exist in the
   trust root.
4. **PR removes a path** → pass.
5. **PR reorders / reformats, identical normalized path set** → pass.
6. **Malformed or duplicate-equivalent entry** (e.g. `./docs/x.md` vs
   `docs/x.md`) → fail.
7. **PR renames / moves / pointer-redirects the list file** to dodge the guard →
   fail **unless owner-authorized**: relocating the canonical governed datum is a
   governed-surface change (an ordinary PR can't move the anchor; an owner can).
8. **PR adds a path AND modifies the guard logic / workflow wiring / fixtures in
   the same change** → fail (unless owner-authorized): the guard runs from the
   trusted base, and its own code is governed surface — it cannot grade an
   attacker-controlled copy of itself.
9. **PR redirects / disables / adds a fallback to the consumer's legacy-list
   resolution** (leaving the JSON untouched) → fail: the resolution path is
   governed surface.
10. **Stale or unresolvable comparison base** → fail-closed for any gated change
   (additions and governed-surface modifications alike).
11. **The guard's own introduction commit** must be **landable** via the
   **operator/admin bootstrap path** (fixture/e2e mode, not self-graded as a live
   gate — see "First-guard-commit bootstrap"); the allowance is **one-time**, keyed
   to the **absence of the guard on the base**, with **no reusable "bootstrap
   mode"** flag: once the base contains the guard, ordinary later PRs that add a
   path must still fail (proven by fixture). The **initial
   governed-file manifest is validated against the real trusted-entrypoint
   dependency chain** at bootstrap — it cannot be self-defined to omit governed
   files (a self-serving narrow manifest is itself a bypass).

## Files in scope

- The guard logic and its fixtures (planner chooses files and surface).
- Wiring the guard into the existing PR-scope / CI guard path.

## Files out of scope

- `scripts/contract-evidence.mjs` and the #366 authoring gate — its **gating
  logic is not rewritten**; this guards the legacy list around it. **Exception:** a
  *minimal* change so the consumer **imports/adopts the one shared canonicalizer /
  resolution** is permitted (and required if the consumer does not already use
  it), since the shared-canonicalizer invariant is impossible otherwise — the
  implementation either proves the consumer already matches the shared contract or
  makes that minimal extraction.
- The reviewer-time re-verification of contract-evidence rows — its own draft
  (`docs/issues_drafts/118-contract-evidence-reverify-producer-reality-at-review.md`).
- A **durable, append-only audit store / dashboard** of guard verdicts. The
  structured verdict carries authorization evidence at decision time; persisting
  it as a queryable history is a separate build.
- **Exemption-laundering by reusing a grandfathered path** — deleting a
  grandfathered draft and creating *new content at the same already-listed path*
  to inherit its exemption **without a list addition**. This defeats the #366
  exemption *semantics* (the exemption is path-keyed, not content-keyed), not this
  list-tamper guard; closing it would require #366 to content-bind exemptions (a
  separate build). **Known residual**, deferred to a #366 follow-up — flagged here
  so it is not lost; this draft's byte-exact guard neither introduces nor closes it.
- A full **CODEOWNERS bootstrap / branch-protection subsystem.** If owner-gating
  the list mechanically resurfaces the CODEOWNERS chicken-and-egg #366 already
  hit, **scope that to a follow-up draft** rather than inflating this one — this
  draft is the additions-vs-removals diff guard plus a single owner-authorization
  hook, not a governance platform.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
tests/**
.github/**
docs/**
```

The **cross-PR enforcement** entrypoint (AC#13) is a **direct, base-resolved
invocation** — it must not route through PR-head `npm`/`package.json` indirection
(that would be a retargetable invocation path). The **producer-emission unit
proof** (AC#16) is a normal test and may run via the existing test runner
(`npm test`/vitest); it only *runs* the pre-existing root config, it does not
*edit* it, so no root file enters this PR's edit set and these allowed roots
suffice. Only if the planner were to **edit** a root config file would it need to
be added to the allowed roots and the governed-file manifest.

## Contract evidence

The implementing PR creates one repo-owned datum: the guard verdict on the
legacy-list change. It does not exist yet, so it is a `NEW` obligation proven by
the implementation. The guard's **input** is the **full governed-surface diff**
(the list file *and* its resolution path, the guard's own logic/fixtures, the
CI/workflow wiring, and the trusted invocation chain — see Binding surface), not
only the JSON list-file diff; the draft asserts no specific value of that diff
(the guard processes whatever the diff is), so there is no external-producer
value binding to ground. The legacy list's own file format is the already-shipped
#366 repo-owned contract named in Prerequisite.

```contract-evidence
binding-id: orchestrator-pack:legacy-list-guard-verdict:fail
binding: legacy-list change guard verdict — fail on an unauthorized addition (verdict is pass | fail)
producer: orchestrator-pack
evidence: NEW(produced-by AC#16)
```

## Acceptance criteria

1. A change that **adds** a path to the legacy list **without** owner
   authorization **fails** the guard with an actionable message.
2. A change that adds a path **with valid non-PR-controlled owner authorization**
   passes.
3. A change that **adds a path AND introduces/modifies the authorization source
   in the same diff** (self-authorization) **fails** — authorization must
   pre-exist in the trust root.
4. A change that **removes** a path **passes**.
5. A reorder / reformat with an **identical normalized path set passes** (set
   comparison over the shared canonical path contract, not raw text).
6. A **malformed or exact-byte-duplicate entry** (e.g. `./docs/x.md` vs
   `docs/x.md`) **fails**; canonicalization is **byte-exact and case-sensitive**
   (no case/Unicode folding, no FS/symlink resolution), so case/Unicode variants
   are distinct (cannot launder an exemption); the guard and consumer use the
   **same canonicalizer** and a fixture proves they agree on path identity.
7. A change that **renames / moves / pointer-redirects** the list file away from
   its canonical location **fails unless owner-authorized** (relocation is a
   governed-surface modification — same rule as AC#9 — not a permanent
   prohibition; an ordinary PR cannot relocate the anchor, an owner can).
8. The guard evaluates **PR head against target-branch base** from a **trusted
   base version of the guard**, invoked from a **pinned trusted path** that does
   not depend on PR-head scripts/config (PR diff is input only); a **stale or
   unresolvable base fails-closed for any gated change** — additions and
   governed-surface modifications alike (never a silent pass).
9. **Any modification to the governed surface** — enumerated in a **committed
   governed-file manifest** (legacy list + resolution path, guard logic/fixtures,
   CI/workflow wiring, the pinned entrypoint's actual dependencies) — **fails
   unless owner-authorized, even when no path is added in the same diff** (closes
   both the same-diff and the two-step weaken-then-add bypass). The manifest is
   itself governed (it cannot be silently shrunk). A PR-head attempt to retarget
   the pinned entrypoint (`package.json`/wrapper/alias/action-input) is **inert**:
   the guard still runs the trusted version.
10. The verdict is computed over the **full governed-surface diff**, not only the
   JSON list-file diff (a bypass change to a non-list governed file is not
   ignored).
11. The owner-authorization lookup runs in **trusted, least-privilege read-only
   code**; **workflow-ordering is falsifiable** — a negative CI/dry-run proves
   PR-head checkout/scripts cannot observe privileged auth material before the
   trusted guard step completes (no credential leakage, no PR-forged result).
12. An **authorized addition** emits a **structured verdict** carrying the
   added/removed paths, base/head SHAs, authorization-source type/id, and reason;
   authorization **binds to the exact normalized added-path set and base/head
   SHA**, and a **stale / reused / mismatched** authorization **fails**. A
   **generic** owner approval (plain CODEOWNERS/branch-protection sign-off) with
   no binding to the specific change **does not** satisfy the gate unless wrapped
   by trusted code that derives and checks the exact path-set + SHA.
13. Enforcement is a **merge-blocking required Linux CI check** (the required-check
   / branch-protection status is an **operator/admin configuration** — see
   Operator adoption — since a workflow cannot make itself required): a
   governed-surface change always produces a verdict (latest authoritative per
   base/head SHA), and a **missing / skipped / cancelled** verdict **fails the PR
   closed** (no verdict ≠ pass — an availability gate inherent to any required
   check). A PR touching **none** of the governed surface gets a **policy-pass**
   (a pass verdict, no policy-based rejection) — it is still subject to the
   required-check availability gate, but imposes no governed-surface policy on
   unrelated changes. A verdict is
   bound to the evaluated base/head SHA; if the **target base advances**, a verdict
   against the superseded base is **not honored** — enforced by the operator's
   strict **"require branches up to date"** branch protection (see Operator
   adoption), since the workflow's base-SHA binding alone does not invalidate a
   passing check on an unchanged head SHA. Pre-sync/local runs are not the gate.
14. The **shared canonicalizer/resolution** is genuinely shared: the
   implementation either proves the consumer already uses it or makes the minimal
   consumer extraction to do so (the canonicalizer invariant is not satisfiable by
   a duplicate copy).
15. The guard's own **bootstrap commit is landable** via the **operator/admin
   bootstrap path** (the guard-introducing PR runs in fixture/e2e mode, landed by
   the operator, not self-graded as a live gate — see "First-guard-commit
   bootstrap"); the allowance is **one-time**, keyed to the **absence of the guard
   on the base** (no reusable bootstrap-mode flag): once the base contains the
   guard, **every** later PR — including any that adds a path — takes the normal
   base-resolved path and **still fails** if unauthorized; and the **governed-file
   manifest is validated against the real dependency chain** — at bootstrap **and
   on every protective-machinery/manifest change** (an owner-authorized guard
   update that adds a dependency but omits it from the manifest fails closure, so
   no ungoverned dependency can be left for a later ordinary PR to exploit).
16. The guard emits a `fail` verdict (`legacy-list-guard-verdict`) on an
   unauthorized path addition — proven by a test that runs the **actual guard
   logic** over a real-diff fixture and asserts the emitted structured verdict
   (producer-emission below). (This is the unit proof of emission; it may use the
   normal test runner. The *cross-PR enforcement* path is the pinned trusted
   entrypoint of AC#13 — distinct from this proof.)

```positive-outcome
asserts: an unauthorized path addition to the legacy list is refused by the guard
input: external-tool-output
provenance: capture-backed
```

```producer-emission
producer: orchestrator-pack
datum: legacy-list-guard-verdict
expected: fail
proof-command: npm test -- legacy-list-guard
```

## Upgrade-safety check

- No edits to AO core, `packages/core/**`, or `vendor/**`.
- The guard governs **only the legacy list and the explicitly enumerated governed
  surface needed to protect it** (the governed-file manifest below); it adds no
  new gate over PRs that touch none of that surface, and it does not alter the
  #366 authoring check's behavior.
- No CODEOWNERS / branch-protection bootstrap is introduced here; if owner-gating
  requires it, that is a deferred follow-up.

## Verification

- One fixture per acceptance criterion (1–16). Normal path-change cases are
  backed by a real `git diff` capture against a defined base (no hand-shaped
  diffs — #76 discipline); failure-mode cases that are not a normal captured diff
  use a **runner-level** fixture (see below):
  - add-without-auth → fail; add-with-valid-external-auth → pass; remove → pass.
  - **self-authorization** (same diff adds the path AND its authorization
    source) → fail.
  - reorder/reformat with identical normalized set → pass.
  - malformed / duplicate-equivalent entry (`./docs/x.md` vs `docs/x.md`) → fail.
  - rename / move / pointer-redirect of the list file → fail.
  - **trusted-execution**: a PR that modifies the guard logic / workflow wiring /
    fixtures while adding a path → fail (the guard runs from the trusted base).
  - **two-step / standalone-modification**: a PR that modifies any governed-
    surface file with **no path added** → fail unless owner-authorized (closes the
    weaken-then-add bypass).
  - **full governed-surface diff**: a bypass change to a non-list governed file is
    not ignored by the verdict.
  - **transitive invocation chain (pinned-path inert)**: a PR that retargets the
    guard via `package.json` script / wrapper / alias / action input / path-filter
    is **inert** — the guard still runs the trusted version and still catches the
    change.
  - **governed-file manifest**: a PR that shrinks/edits the manifest itself →
    fail unless owner-authorized.
  - **consumer-redirection**: a PR that redirects/disables/fallbacks the legacy-
    list resolution with the JSON untouched → fail.
  - **shared canonicalizer (real consumer path)**: a fixture proving guard and
    consumer agree on **byte-exact case-sensitive** path identity (and that
    case/Unicode variants stay **distinct**) using the **actual**
    `scripts/contract-evidence.mjs` resolution, not a duplicate helper.
  - **privileged-token isolation (workflow-ordering)**: a CI/dry-run negative test
    proving PR-head checkout/scripts cannot observe privileged auth material
    before the trusted guard step completes.
  - **structured-verdict + scoped authorization**: an authorized addition emits
    added/removed paths, base/head SHAs, authorization-source type/id, reason;
    a **stale/reused/mismatched** authorization (wrong path or prior head) → fail;
    a **generic approval not bound** to the exact path-set + SHA → fail.
  - bootstrap commit → landable via the admin path against committed fixtures
    (guard absent from base ⇒ bootstrap predicate true; no live verdict claimed),
    **plus** a paired fixture proving that once the base contains the guard the
    bootstrap predicate is false and an ordinary later addition still fails (no
    reusable bootstrap mode).
  - **required-check / no-verdict fail-closed**: a governed-surface change with a
    missing/skipped/cancelled verdict → PR fails (no verdict ≠ pass).
  - **authoritative-verdict-per-SHA**: re-runs on one base/head SHA may create new
    check runs, but the **latest supersedes** — there is one authoritative verdict
    per base/head SHA, never contradictory authority.
  - **adoption verification** (operator step, not a unit test): `gh api …/branches/
    …/protection` shows the check in `required_status_checks.contexts` and
    `strict = true` — confirming AC#13's enforcement is live.
  - **manifest closure validation (continuous)**: dependency-chain completeness
    is validated at bootstrap **and on every protective-machinery / manifest
    change** — an owner-authorized guard update that adds a dependency but omits it
    from the manifest fails closure (closes the post-evolution two-step bypass
    where a later ordinary PR edits the ungoverned dependency).
  - **shared canonicalizer adoption**: the consumer uses the same canonicalizer
    instance (proven against the real `scripts/contract-evidence.mjs` path), not a
    duplicate copy.
- **Runner-level fixtures** (not captured diffs): force a stale / unresolvable
  comparison base and assert fail-closed for **any gated change** (additions and
  governed-surface modifications); force a missing/skipped guard verdict and
  assert the PR gate fails closed.
- The verdict producer-emission test runs the **actual guard** over the fixtures
  and asserts the emitted structured verdict value (not an aggregate test pass).

## Decisions (adversarial review)

GPT loop: 10 passes; stopped because cap-10; last-pass accepted=3; final
STATE=completed_valid VALIDATION=ok pass=5139c5bc-ff71-4f3b-b82d-05cf732a0b1f
sha=c68ce1b58d4ba4c9fe7150d9ad4139c6abb407dfe69100db3d8c2797052cc56f.
**The pass-10 consistency fixes (stale-base fail-closed wording → "any gated
change"; mixed addition+machinery → union authorization) were applied post-cap
and not re-reviewed by GPT** — clear consistency corrections, not new design.

Codex architect review (`review-architect-artifact.ps1`): **converged to
NO_FINDINGS** after iterating past the initial 5-iteration cap (operator asked to
run to convergence). Accepted across iterations: producer-proof decoupled from the
pinned enforcement entrypoint; required-check + strict "up-to-date" branch
protection named as **operator adoption** (a workflow can't self-confer them) with
`gh api` adoption verification; "exactly-one-verdict" →
authoritative-per-SHA/supersession; relocation made owner-authorizable (not
unconditional fail); AC#8 stale-base → any gated change; npm-proof/allowed-roots
contradiction removed (running the runner edits no root file); continuous manifest
dependency-closure validation on every machinery/manifest change (not just
bootstrap); the **first-guard-commit bootstrap specified** as a one-time
operator/admin fixture-mode landing keyed to the guard's absence from the base
(no reusable bootstrap-mode flag) — resolving the bootstrap chicken-and-egg;
unrelated-PR wording corrected to **policy-pass** (a required check is inherently
an availability gate, only the governed-surface *policy* is exempt for unrelated
PRs).

Key decisions across the loop (accept = revised; reject = left, with reason):
- **Accepted:** additions(→auth)/removals(→free) over a byte-exact, case-sensitive,
  no-FS-resolution canonicalizer shared with the consumer; non-PR-controlled
  owner authorization bound to the exact added-path set + base/head SHA (generic
  approval insufficient unless trust-bound); trusted execution from a pinned base
  entrypoint (PR-head retargeting inert); governed surface enumerated in a
  committed, self-governed manifest covering guard logic/fixtures/wiring/resolution
  /invocation-chain (closes same-diff **and** two-step bypass); least-privilege
  workflow-ordering-falsifiable credential isolation; structured verdict; a single
  **merge-blocking required Linux CI check** with **fail-closed on missing/stale
  verdict**; minimal consumer change permitted to adopt the shared canonicalizer.
- **Rejected / scoped out (anti-inflation, per operator mandate):** a full
  CODEOWNERS/branch-protection governance platform; a durable append-only audit
  store; **exemption-laundering by reusing a grandfathered path** — a #366
  exemption-*semantics* concern (path-keyed, not content-keyed), deferred to a
  **#366 follow-up** and documented as a known residual; case/Unicode folding was
  *removed* (it would enable laundering on a case-sensitive FS), not added.

**First-guard-commit bootstrap (specified, single one-time exception).** On the
initial PR the target base has neither the guard nor its manifest, so AC#8's
base-resolved execution and AC#15's continuous closure cannot yet run from base.
The resolution is an **operator/admin-landed bootstrap**, not an ordinary-PR
self-grade:
- The single PR that **introduces** the guard is landed by the **operator/admin**
  (the same actor who configures branch protection — see Operator adoption), with
  the guard run **only in fixture/e2e mode** against committed fixtures (it does
  **not** grade its own PR-head copy as the live gate — the self-grading
  prohibition holds because no live verdict is claimed for that PR).
- The exception is **exactly one commit**: the bootstrap is keyed to the absence
  of the guard on the base (no guard on base ⇒ admin bootstrap path). The **first
  base that contains the guard** flips enforcement on; **every** PR evaluated
  against a guard-bearing base takes the normal base-resolved path with no
  exception. There is **no reusable "bootstrap mode" flag** an ordinary later PR
  can set (an ordinary PR's base already contains the guard, so the bootstrap
  predicate is false for it).
- Adoption ordering is part of the operator step: land the guard PR (admin), then
  enable the required-check + strict branch protection (Operator adoption); from
  that point the durable invariants above bind every PR.
This keeps the one-time bootstrap a narrowly-scoped admin action rather than a
standing mechanism, so it does not become the reusable exception the two-step
bypass needs.
