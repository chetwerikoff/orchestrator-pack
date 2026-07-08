# Autonomous slug resolver must use sanctioned read-only git reads (no boundary widening)

GitHub Issue: #599

## Prerequisite

Merged work this draft builds on / references (prior-art reconnaissance):

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub #324, **closed**)
  — ships the autonomous process-boundary that **denies tree-mutating git** and
  classifies read-only vs mutating git; unknown subcommands fail closed (EXIT 93).
  This draft **preserves** that deny; it does **not** widen it.
- `docs/issues_drafts/146-autonomous-surface-spawn-budget.md` (GitHub #462, **closed**)
  — built the budgeted read-only git fast-path and **sanctioned the exact command
  `git config --get remote.origin.url`** as the read-only way to obtain the origin
  URL on the autonomous surface. `git remote …` was deliberately **not** added to
  the read-only allowlist.
- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub #431, **closed**)
  — established the local slug-resolution precedence `--repo` flag → `GH_REPO` env →
  git-derived slug for the checkout, "fail-closed only on concrete ambiguity."
- `docs/issues_drafts/128-autonomous-bash-env-interposer-eval-hidden-defense.md` (GitHub #406, **closed**)
  — ships the `BASH_ENV` surface bootstrap (`scripts/autonomous-orchestrator-surface-bootstrap.sh`)
  that arms the autonomous surface; the environment where slug resolution runs.

No open issue or un-synced draft covers this gap (surveyed open queue + local drafts;
#532 validates the runtime **binary/PATH** preflight, not the resolver's git argv).

## Goal

On the autonomous orchestrator surface, repository-slug resolution for pack `gh`
reads must succeed for the normal case (a pack checkout with an `origin` remote)
**without** relying on a git command the process boundary denies — and without
widening the tree-mutating-git deny of #324. The resolver's git reads must stay
inside the already-sanctioned read-only set, and a guard must keep them there so
the failure cannot silently return.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T2
```

## Binding surface

What this issue commits the repository to (contracts, not implementation):

- The slug resolver's git-derived origin lookup uses a git command that the
  autonomous boundary classifies **read-only** (currently the #462-sanctioned
  `git config --get remote.origin.url` shape), so it returns the origin slug on
  the autonomous surface instead of being denied (EXIT 93). The resolver keeps its
  existing precedence: explicit `--repo` → `GH_REPO` → git-derived slug.
- Every git invocation the resolver issues is classified read-only by the
  autonomous boundary. A mechanical guard/test enforces this so a future edit that
  reintroduces a boundary-denied command (e.g. `git remote get-url`) fails closed
  in CI — this is the class fix, not a one-command patch.
- **Defense-in-depth (secondary):** the surface bootstrap derives and exports
  `GH_REPO` for the pack checkout when it is unset, from the checkout's configured
  origin **without invoking a boundary-denied git command** (read the config datum
  directly), and never overwrites an already-set `GH_REPO`. Explicit `--repo`
  flags and any pre-set `GH_REPO` continue to win.
- The tree-mutating-git deny of #324 is unchanged: `git remote add/remove/rename/set-url/set-head/prune/update`
  and all other mutating forms remain denied. This issue adds **no** entry to the
  mutating→allowed direction.

- **Operator adoption** (touches `agent-orchestrator.yaml.example`): after merge the
  operator confirms the live orchestrator surface resolves the slug (a per-turn
  `gh` read no longer reports `could not resolve repository slug`); if the interim
  `GH_REPO` line was added to a machine-local env file as a stopgap, it may be kept
  or removed once the resolver fix is adopted (no restart required — `BASH_ENV`
  re-sources per non-interactive shell).

## Files in scope

- `scripts/lib/` — the slug resolver's git-derived origin lookup.
- `scripts/autonomous-orchestrator-surface-bootstrap.sh` — GH_REPO derivation (secondary).
- `agent-orchestrator.yaml.example` — document the `GH_REPO` orchestrator-env contract.
- Test/fixture files covering the resolver classification and the end-to-end surface case.

## Files out of scope

- `docs/autonomous-orchestrator-boundary.mjs`, `scripts/lib/Orchestrator-AutonomousBoundary.ps1`,
  `scripts/lib/autonomous-guard-fast-path.sh` — the read-only/mutating classifier
  sets are **not** edited (chosen design: do not widen the boundary). Touch these
  only if a future draft deliberately re-opens the #324/#462 allowlist decision.
- `packages/core/**`, `vendor/**`, `.ao/**`.
- The machine-local `coworker.env` / operator env files (gitignored; not a repo change).

```denylist
vendor/**
packages/core/**
.ao/**
docs/autonomous-orchestrator-boundary.mjs
scripts/lib/Orchestrator-AutonomousBoundary.ps1
scripts/lib/autonomous-guard-fast-path.sh
```

```allowed-roots
scripts/**
tests/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

- With the autonomous surface active (`AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`,
  pack `scripts/` first on PATH) and `GH_REPO` unset, the resolver returns the
  correct `owner/repo` slug for a pack checkout with an `origin` remote — no
  EXIT-93 deny, no `could not resolve repository slug` throw.

```positive-outcome
asserts: resolver returns chetwerikoff/orchestrator-pack on the autonomous surface with GH_REPO unset, using a boundary-read-only git command
input: realistic
```

- A mechanical guard/test asserts every git argv the resolver issues is classified
  read-only by the autonomous boundary; reintroducing a boundary-denied command in
  the resolver fails the guard (CI non-zero).
- Precedence preserved: explicit `--repo` and a pre-set `GH_REPO` still take priority
  over the git-derived slug (existing #431 order unchanged).
- Secondary: with `GH_REPO` unset, sourcing the surface bootstrap in a pack checkout
  exports `GH_REPO=<origin slug>` derived without a boundary-denied git command; a
  pre-set `GH_REPO` is left untouched.
- No new mutating-git allowance: `git remote set-url` / `add` / `remove` (and other
  mutating forms) remain denied (EXIT 93) on the surface.
- Credential safety across **every** origin-URL reader: both the resolver and the
  surface bootstrap derive only `owner/repo` and never log, print, or export the raw
  origin URL (it may embed a token). A test asserts this for **each** reader
  independently — the resolver returns/uses only the slug, and the bootstrap exports
  only the slug — and that neither emits anything containing the raw URL on
  stdout/stderr, on a fixture origin whose URL carries a token sentinel.

## Upgrade-safety check

- No edits to AO core, `vendor/**`, `.ao/**`, or the boundary classifier sets.
- No unsupported YAML: the `agent-orchestrator.yaml.example` change only documents an
  env key in the orchestrator `agentConfig.env` block.
- No new repo secrets. The origin URL may embed a credential; **every** component
  that reads it — the resolver **and** the surface bootstrap — extracts only
  `owner/repo` and must not log, print, export, or otherwise emit the raw URL.

## Verification

- Resolver unit/fixture test: autonomous-surface classification + `GH_REPO` unset →
  correct slug via the sanctioned read-only command; the same surface with the old
  `git remote get-url` shape denied (EXIT 93) demonstrates the regression the fix
  closes.
- Guard test: an argv-classification assertion over the resolver's git commands;
  a deliberately reintroduced denied command makes it fail.
- Precedence test: `--repo` and pre-set `GH_REPO` outrank the git-derived slug.
- Bootstrap test: sourcing in a fixture pack checkout with `GH_REPO` unset exports the
  derived slug without a denied git call; pre-set `GH_REPO` preserved.
- Credential-leak test (both readers): on a fixture whose `remote.origin.url` embeds
  a token sentinel, the resolver result and the bootstrap `GH_REPO` export contain
  only `owner/repo`, and neither reader's stdout/stderr contains the sentinel.
- End-to-end smoke: a pack `gh` read that resolves the slug succeeds on the surface
  (no `could not resolve repository slug`).

## Decisions (design analysis)

**Prior art.** The autonomous boundary (#324) is **deny-by-default**: read-only git
subcommands are an explicit allowlist; unknown subcommands (incl. `remote`) fail
closed at EXIT 93 (live-reproduced). #462 deliberately chose `git config --get
remote.origin.url` — **not** `git remote get-url` — as the sanctioned read-only way
to read the origin. The slug resolver (`scripts/lib/gh-repo-resolve.mjs`) instead
issues `git remote get-url origin`, which is **not** on the allowlist → denied →
`could not resolve repository slug`. So the defect is the resolver drifting off the
sanctioned command set, not a missing allowlist entry.

**Class, not case (element 5).** The resolver's git reads × surface classification:
`git rev-parse --show-toplevel` → allowed ✓; `git remote get-url origin` → **denied ✗**
(the bug); any future resolver git call → must be allowlisted. The class fix is a
guard that keeps **all** resolver git argv inside the read-only allowlist, so the
class (resolver → boundary-denied command) cannot recur — closing more than the one
reproduced command.

**Options (cost / risk / sufficiency — cheapest sufficient, not "best"):**
- **A — widen the boundary allowlist** to admit read-only `remote` (get-url/-v/show)
  + `ls-remote` across all three classifier mirrors. *Rejected:* re-opens a
  deliberate #324/#462 security decision, must be precise to keep mutating `remote`
  forms denied, and touches a deny-by-default security gate in 3 places — highest
  risk for no benefit this incident needs.
- **B — point the resolver at the sanctioned `git config --get remote.origin.url`**
  (+ argv-classification guard). *Chosen (primary):* no boundary change, aligns with
  #462's own sanctioned command, smallest surface, tests + guard as safety net.
  Minor known semantic gap vs `remote get-url` (does not apply `url.insteadOf`
  rewrites) — negligible for slug extraction.
- **C — `GH_REPO` fallback** exported by the bootstrap, short-circuiting git entirely.
  *Chosen (secondary, defense-in-depth):* cheap, already partially adopted operator-side;
  covers cwd-not-a-checkout edges. Not sufficient alone (leaves the resolver drift
  latent), so paired with B, not instead of it.

Recommendation: **B + C**, reject A. B fixes the failing path within the existing
security contract; C hardens the precedence tier above it; A is deferred unless a
future need genuinely requires general read-only `remote` on the surface.

**Contract evidence.** `none` — every assertion binds to **repo-owned** behavior,
not an external producer's data shape: the autonomous boundary's read-only/mutating
classification (tested by the boundary's own suite), the resolver's slug derivation,
and the bootstrap's `GH_REPO` export. These are proven by this draft's **Verification**
tests in-repo, not by golden external captures. (The git origin-URL parse is a stable,
fixture-controlled universal git contract, not the fragile "field the tool never
emits" class #366 targets; and the surface-only EXIT-93 deny is our guard's behavior,
not verifiable by a generic live re-run.)

```contract-evidence
none
```
