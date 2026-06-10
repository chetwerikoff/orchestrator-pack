# Codex review can delegate to coworker on trusted paths (sandbox unblocked)

GitHub Issue: #258

## Prerequisite

None.

## Goal

When Codex runs a review on a **trusted** path, it must be able to spawn the
external `coworker` CLI (which needs subprocess exec **and** network) so the
reviewer can delegate bulk reads per the coworker policy. Two trusted paths
break this today:

- **Local PR code review** (`codex exec … review`, the local AO path) runs under
  `--sandbox read-only`, which forbids the spawn outright.
- **Architect / draft-spec review** (`codex review`) runs under the default
  `workspace-write` sandbox, which permits the spawn but **blocks network**, so
  `coworker` fails on DNS mid-review.

Unblock `coworker` on both trusted paths by granting the **minimum** sandbox
authority that lets it run, while keeping the reviewer's no-mutation contract.
The **untrusted** PR-review context (`codex-github-action` / `PR_REPO_ROOT`,
where the diff is attacker-controlled) keeps its existing `--sandbox read-only`
containment unchanged — removing it there would open a credential-exfiltration
channel, and trusted-side delegation is the only thing this issue needs.

```behavior-kind
action-producing
```

## Binding surface

- **PR-review path — trusted contexts only.** The live Codex PR-review
  invocation (the `codex exec … review` arg builder in
  `plugins/ao-codex-pr-reviewer/lib/run_review.ts`) MUST, in a
  **positively-identified trusted-local context** (per the fail-closed
  derivation below — not merely the absence of untrusted signals), grant the
  reviewer enough sandbox authority to spawn `coworker` (exec + outbound
  network). It MUST grant no more authority than
  that goal requires — the reviewer must not gain broad write authority over the
  host beyond its own workspace/temp, and a review run MUST leave the reviewed
  working tree unmodified.
- **PR-review path — untrusted contexts unchanged, fail-closed.** When the
  context is untrusted the invocation MUST keep its current `--sandbox read-only`
  containment. Trust derivation MUST be **fail-closed**: the coworker-capable
  (less-sandboxed) branch is taken **only** for a positively-identified
  trusted-local context. Any GitHub-Actions / CI signal, an explicit
  `codex-github-action` source, a set `PR_REPO_ROOT`, **or a missing / ambiguous
  source** MUST resolve to the sandboxed read-only branch — the default when
  trust cannot be positively established is untrusted, not trusted.
- **Architect / draft-review path.** The `codex review` invocation in
  `scripts/review-architect-artifact.ps1` (architect-only, run locally on the
  operator's own artifacts — trusted) MUST run with a sandbox that permits
  outbound network so `coworker` can resolve and reach its API. Note the
  `codex review` subcommand exposes **no** `--sandbox` / bypass flag (those are
  `codex exec`-only); the network-permitting behavior MUST be achieved through
  the mechanism `codex review` does support — a config override (`-c`) — and
  with the **least** added authority that lets `coworker` reach the network
  (i.e. enable outbound network without granting host-wide write — e.g. a
  workspace-write-with-network setting rather than full-access). The planner
  confirms the exact config keys/values against the installed Codex CLI.
- The existing untrusted-context **environment strip** (omitting `GH_TOKEN` and
  related CI secrets from the spawned Codex child env on the PR-review path)
  MUST remain in force unchanged.
- Reviewer-facing docs and any skill/prompt snippet that shows the literal
  `codex exec … review` or `codex review` command MUST match the new behavior:
  document that trusted review is coworker-capable (network allowed) while the
  untrusted PR path stays `--sandbox read-only`, and show no command that an
  operator would copy that reintroduces the network/sandbox block on a trusted
  path.

## Files in scope

- `plugins/ao-codex-pr-reviewer/lib/**` — the PR-review-arg builder and any
  direct consumer that asserts the sandbox flag.
- `plugins/ao-codex-pr-reviewer/tests/**` — unit assertions on the built args.
- `plugins/ao-codex-pr-reviewer/README.md` — the sandbox/trust note.
- `scripts/review-architect-artifact.ps1` — the architect / draft-spec
  `codex review` invocation.
- `.claude/skills/**` and `prompts/**` — only the snippets that show the literal
  `codex review` / `codex exec … review` command, updated for consistency with
  the new behavior. Do not rewrite surrounding guidance.

## Files out of scope

- `scripts/patch-codex-review4.ps1` — Windows-only patch of the vendored AO
  built-in review chunk. The pack does not route PR review through that path
  (`agent-orchestrator.yaml` forbids the built-in Codex path), so it is
  unchanged here; it stays a legacy, **not** coworker-capable path. Note this in
  the README rather than adding a new routing guard.
- `agent-orchestrator.yaml` / `reactions`.
- Any change to the review prompt *content* (only the invocation command shape
  changes, not what the reviewer is asked to do).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

- For the **trusted** PR-review context, the args built for a live Codex review
  do not impose `--sandbox read-only`; they grant exec + outbound network so the
  reviewer process can spawn `coworker`.
- For the **untrusted** context, the built args still contain
  `--sandbox read-only`. Trust derivation is **fail-closed**: tests MUST cover
  not only the two happy-path inputs but also omitted/empty source, a
  `codex-local` source under a CI/Actions signal, and `PR_REPO_ROOT` variants —
  each of those resolves to the read-only branch, never the coworker-capable
  one.
- A trusted review run leaves the reviewed working tree unmodified across
  **tracked and untracked** checkout paths — provable by a before/after snapshot
  around a run. (This is a regression guard against the reviewer corrupting the
  checkout it reviews, not a hard write-capability boundary; capability-level
  write isolation on the trusted-local path is out of scope — the operator runs
  it on their own machine. See decision trail.)
- The `codex review` invocation in `scripts/review-architect-artifact.ps1`
  passes a sandbox setting that permits outbound network (via the config-
  override mechanism the subcommand supports, not a non-existent
  `codex review --sandbox` flag), so `coworker` can resolve its host during the
  review. The change is a valid invocation against the installed Codex CLI (the
  script still runs and emits its `NO_FINDINGS` / findings contract).
- The spawned Codex child env for the untrusted PR-review context still omits
  `GH_TOKEN` and the other secrets it omits today (env strip unchanged).
- The plugin README documents the trust split: trusted review is
  coworker-capable (network permitted), the untrusted PR path stays
  `--sandbox read-only` with the env strip, and the Windows patch path is legacy
  / not coworker-capable.
- Skill/prompt snippets that show the literal `codex review` /
  `codex exec … review` command reflect the new trusted-path behavior (no stale
  command that reblocks coworker on a trusted path).
- Existing unit tests that asserted the read-only sandbox flag are updated to
  assert the new trust-conditioned contract (trusted → coworker-capable,
  untrusted → read-only), and the plugin test suite passes.

```positive-outcome
asserts: in the trusted PR-review context the arg builder returns args that grant exec+network so the reviewer can spawn coworker (no `--sandbox read-only`), while the untrusted context still returns `--sandbox read-only`
input: realistic
```

## Upgrade-safety check

- No edits under `vendor/**`, `packages/core/**`, or `.ao/**`.
- No AO core or vendored-chunk edits; the change is confined to the pack's own
  `ao-codex-pr-reviewer` wrapper and the architect review script.
- No new repo secrets introduced.
- No `agent-orchestrator.yaml` schema changes.
- The untrusted PR-review containment (`--sandbox read-only` + env strip) is not
  weakened.

## Verification

- Run the plugin's test suite (the `ao-codex-pr-reviewer` package tests) and
  show the updated arg-builder tests passing with the trust-conditioned
  contract.
- Show that the arg builder returns coworker-capable (network-permitting) args
  for the trusted input and `--sandbox read-only` args for the untrusted
  (`codex-github-action` / `PR_REPO_ROOT`) input.
- Show a test (or fixture assertion) confirming the untrusted-context child env
  still omits `GH_TOKEN`, and an assertion that a trusted review run leaves the
  working tree unmodified.
- Show the `codex review` command line in `scripts/review-architect-artifact.ps1`
  carries the network-permitting sandbox override, and that the script still
  runs end-to-end (emits its verdict contract) against the installed Codex CLI.
- Live smoke (optional, operator): run a local `ao review` on a PR **and** a
  `scripts/review-architect-artifact.ps1` draft review, and confirm Codex can
  spawn `coworker` with no sandbox-denied / DNS error in either.

## Decision trail (adversarial Codex pass)

Adversarial review (`codex adversarial-review`, verdict `needs-attention`) raised
three findings; verdicts here (evaluate-don't-obey):

- **Full sandbox bypass grants more than exec+network** (high) — *accepted
  kernel, rejected remedy.* The original draft mandated full bypass
  (`--dangerously-bypass-approvals-and-sandbox` / `danger-full-access`) for all
  contexts; that also grants checkout-write + skips approvals, breaking the
  reviewer's read-only contract. Resolved by requiring the **minimum** authority
  that unblocks `coworker` plus a no-mutation criterion. Codex's prescriptive
  remedy (proxy/container/read-only mounts) rejected as planner-owned.
- **Env-strip is not the full credential boundary once the sandbox is gone**
  (high) — *accepted.* With no filesystem sandbox an untrusted PR could read
  `~/.ssh`, `~/.codex/auth.json`, `gh`/git creds — beyond the `GH_TOKEN` strip.
  Resolved by **not** removing the sandbox on the untrusted
  `codex-github-action` / `PR_REPO_ROOT` path (operator decision: trust-
  conditioned). Trusted-side delegation is all this issue needs.
- **No guard for the excluded AO patch path** (medium) — *partial.* Documented
  the Windows patch path as legacy / not coworker-capable in the README;
  rejected adding a new static routing guard as scope creep.

Second adversarial pass (`needs-attention`):

- **Trust detection is fail-open** (high) — *accepted.* Deriving *untrusted*
  from positive signals defaults the no-signal case to trusted (less sandbox).
  Resolved by requiring **fail-closed** trust derivation (any CI/Actions signal
  or ambiguous/missing source ⇒ read-only) plus tests for omitted/mislabeled
  source and `PR_REPO_ROOT` variants.
- **No-mutation check is observational, not a capability bound** (medium) —
  *partial.* Strengthened the criterion to a before/after snapshot over tracked
  **and** untracked paths; rejected the read-only-mount / container remedy as
  disproportionate for a trusted-local reviewer (cost rule) and recorded
  capability-level write isolation as an accepted out-of-scope residual.
