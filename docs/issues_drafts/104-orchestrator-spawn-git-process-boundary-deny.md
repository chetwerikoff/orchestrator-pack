# Autonomous orchestrator must be denied spawn and tree-mutating git at the process boundary

GitHub Issue: #324

## Prerequisite

- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub **#318**,
  merged) — shipped the **process/execution-boundary deny** for the autonomous
  orchestrator: `scripts/ao` PATH shim (active only when
  `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`) routes `ao` through
  `scripts/ao-autonomous-guard.ps1`, which denies the raw `ao review run` verb
  (exit 93) and passes everything else through to `AO_REAL_BINARY`; the denied/gated
  capabilities are enumerated in `docs/autonomous-review-start-capabilities.json` and
  checked by `scripts/check-autonomous-review-start-capabilities.ps1`. **This draft
  re-uses that exact mechanism** — the same env-marker provenance, the same shim +
  guard + capability-inventory pattern, the same exit-code/redirect convention. It
  **adds** two more denied verb families (`ao spawn` / `ao spawn --claim-pr`, and
  tree-mutating `git`); it does **not** re-implement the boundary machinery.
- `docs/issues_drafts/34-review-layer-resilience-after-worker-respawn.md`
  (GitHub **#98**, merged) — shipped `ao spawn --claim-pr` (orphan recovery: claim a
  PR when its worker is gone) and the stale-reviewer-workspace guard. **Relation:**
  `--claim-pr` is the capability this draft denies *to the autonomous orchestrator
  surface* (operator and worker use are unchanged). This draft does not remove or
  alter the feature; it removes the orchestrator's access to it.
- `docs/issues_drafts/33-orchestrator-session-launch-death-and-worktree-hygiene.md`
  (GitHub **#91**, merged) — shipped `scripts/orchestrator-worktree-preflight.ps1`,
  which removes stale `orchestrator/*` worktrees/branches **before `ao start`**.
  **Relation, not dependency:** #91 cleans up a collision that already happened at
  launch; this draft prevents the orchestrator from *creating* the collision at
  runtime. Complementary, no ordering dependency.
- `docs/issues_drafts/58-...` (GitHub **#163**), `70-orchestrator-event-driven-review-trigger.md`
  (GitHub **#207**), `69-orchestrator-review-send-reconcile.md` (GitHub **#202**) —
  each already **prose-forbids** the review/reconcile script paths from
  `ao spawn` / `--claim-pr` / worker-lifecycle actions. **Relation:** those bind the
  *script* surfaces by rule; this draft binds the *LLM-orchestrator turn* surface by
  a mechanical gate, because prose the model can read and still ignore has already
  failed in production (see Decisions → Prior art).

## Goal

Make it **mechanically impossible** for the autonomous LLM-orchestrator runtime to
launch a worker (`ao spawn`, including `ao spawn --claim-pr`) or to mutate the git
working tree / refs (branch, checkout/switch, worktree, reset, stash that moves the
tree, push) from its own turn. Today the orchestrator runs in operator-gated /
review-coordinator mode where it must never spawn or touch git, but that constraint
lives only in `orchestratorRules` prose — and a non-deterministic cheap model has
repeatedly disregarded it, running `ao spawn --claim-pr <PR>` plus
`git branch -m <worker-branch> …` in its own worktree, which parks a worker branch in
the orchestrator's checkout and blocks the assigned worker from spawning/restoring
(git allows a branch in only one worktree), killing that worker. The outcome must be:
the autonomous orchestrator surface has **no available path** to those verbs — a
direct or reworded invocation is denied, fail-closed, with a clear redirect — while
worker sessions, the human operator, and `ao`/`gh`'s own internal git calls are
entirely unaffected.

```behavior-kind
action-producing
```

## Binding surface

This issue commits the repository to the following contracts.

- **Worker-lifecycle verbs are unavailable to the autonomous orchestrator
  surface.** When the autonomous-orchestrator provenance marker is in effect
  (the same `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE` boundary #318 established), any
  `ao spawn` invocation — with or without `--claim-pr`, in any spelling (alias,
  wrapper script, relative/absolute path, reworded subcommand) — is denied before
  it reaches the real `ao`, with a non-zero exit and an explanatory message. There
  is **no** orchestrator-reachable path to a raw `ao spawn`.
- **Tree-mutating git is unavailable to the autonomous orchestrator surface — but
  pack-sanctioned internal git is not.** From the same surface, a **directly
  invoked** mutating git command (`branch`, `checkout`/`switch`, `worktree`,
  `reset`, tree-moving `stash`, `push`) is denied at the process boundary. A
  read-only git command (`status`, `log`, `rev-parse`, `diff`, `show`, …) is
  allowed. **`git fetch` is treated as mutating** (it updates `FETCH_HEAD` /
  remote-tracking refs and, with a refspec, local refs) — denied unless an
  observably non-mutating form (e.g. `--dry-run`) is used. Critically, git invoked
  **as a child of a narrowly enumerated pack-sanctioned path** — `ao review run`'s
  reviewer-workspace build and the named pack review/preflight scripts that must run
  internal git — MUST continue to work even though it inherits the orchestrator's
  environment. The carve-out is **not** "any child of `ao`/`gh`": a blanket `gh`
  carve-out is forbidden because `gh pr checkout` / `gh repo clone` / similar would
  reopen the exact direct-mutation route this gate closes. The boundary is *direct
  orchestrator git* vs *git as a subprocess of an enumerated sanctioned pack path*;
  the planner picks the detection mechanism (parent-process inspection against the
  sanctioned-path inventory, an explicit pass-through marker those specific paths
  set, or equivalent) and the sanctioned set is enumerated in the capability
  inventory, not inferred from the parent binary's name.
- **One choke point per verb family; enforcement above command-string parsing.**
  Like #318, the deny must hold at the **process/execution boundary** so no
  autonomous child process — including a wrapper, `npm`/`make`/task script, or a
  PATH-injected helper created after launch — can reach the raw verb. Pattern-
  matching one spelling is insufficient. The set of autonomous spawn/git
  capabilities must be **enumerated** (extending the existing
  `docs/autonomous-review-start-capabilities.json` inventory or an analogous one),
  and each capability either denied or, where the orchestrator legitimately needs
  it (read-only git, internal-tool git), explicitly classified as allowed/gated.
- **Fail-closed on ambiguity within the orchestrator surface.** When the marker
  says the surface is the autonomous orchestrator but provenance of a git call is
  ambiguous (cannot confirm it is a sanctioned-tool child), the call is **denied**,
  not waved through. A missing or spoofed pass-through marker does not grant access.
- **Workers and the human operator are untouched by construction.** The gate
  activates only under the orchestrator's provenance marker, which is set only in
  the orchestrator `agentConfig`. Worker sessions (which legitimately commit,
  branch, and push their own work) and the operator shell (no marker) see the real
  `ao` and the real `git` unchanged. No global PATH hijack keyed on a shared signal.
- **The shim must not hand the turn a discoverable route to the real binary.** The
  mechanism by which the shim locates the real `ao`/`git` MUST NOT be reachable from
  the orchestrator turn's own environment: the real-binary path is **not exported as
  a turn-visible env var** (no `AO_REAL_BINARY`/`GIT_REAL_BINARY` left in the turn's
  environment), and the real binaries are **not left on the turn's `PATH`** ahead of
  the shims. A direct `$AO_REAL_BINARY spawn` or a turn-readable absolute path
  defeats a PATH shim, so the resolution must happen out of band (e.g. the shim
  reads a config the turn cannot see, resolves at launch and drops the variable, or
  equivalent). See **Decisions → Threat model and residual** for the boundary's
  honest reach.
- **Operator adoption.** Going live requires the operator to extend the
  orchestrator `agentConfig` in `agent-orchestrator.yaml` the same way #318 did for
  `ao`: ensure the marker is set, `scripts/` is prepended to PATH so `git` (and the
  already-shimmed `ao`) resolve to the pack shims for the orchestrator session only,
  and the real-binary resolution is wired per the previous bullet (out of band, not
  as a turn-visible variable). Then `ao stop` / `ao start` the orchestrator and
  verify (see Verification). The example file `agent-orchestrator.yaml.example`
  documents the delta; the live `agent-orchestrator.yaml` is operator-applied.
  Adopting this for `git` may require revisiting #318's `AO_REAL_BINARY` exposure so
  the same no-discoverable-route rule holds for `ao spawn` too.

## Files in scope

- `scripts/` — the `git` process-boundary shim (new, mirroring `scripts/ao`) and its
  guard logic; extension of the existing `ao` guard to cover `spawn` / `--claim-pr`;
  the capability-inventory checker. The planner names the files.
- `docs/` — the autonomous-capability inventory (extend the existing JSON or add an
  analogous one) and any `.d.mts`/migration-note companions consistent with #318.
- `agent-orchestrator.yaml.example` — document the orchestrator `agentConfig` env /
  PATH delta needed to activate the git shim.
- `tests/fixtures/**` and the matching test files — deny/allow matrix fixtures.
- `docs/migration_notes.md` — operator go-live delta.

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**` — never edited.
- The `ao spawn` / `--claim-pr` feature itself (`#98` machinery) — unchanged; only
  the orchestrator's *access* is removed.
- `scripts/orchestrator-worktree-preflight.ps1` (#91) — unchanged.
- The review-start gate behavior from #318 — unchanged; this draft only adds verbs
  to the same mechanism.
- The live `agent-orchestrator.yaml` (gitignored, operator-owned).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
tests/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

- Under the autonomous-orchestrator provenance marker, `ao spawn` and
  `ao spawn --claim-pr <N>` are denied with a non-zero exit and a message naming the
  reason; the real `ao spawn` is not executed.
- Under the same marker, a directly invoked tree-mutating git command
  (`git branch -m …`, `git checkout …`, `git switch …`, `git worktree add …`,
  `git reset …`, `git push …`) is denied with a non-zero exit and a message; the real
  git mutation does not occur.
- Under the same marker, read-only git (`git status`, `git log`, `git rev-parse`, …)
  succeeds and returns real output.
- Under the same marker, `git worktree add` invoked **internally by `ao review run`**
  (reviewer-workspace build) succeeds — a claimed/sanctioned review run is not broken
  by the git gate.
- A reworded / turn-discoverable-path spawn or git-mutation attempt (alias, wrapper
  script, a binary path resolvable from the turn's own `PATH`/env, a helper script
  generated at runtime) from the orchestrator surface still does not reach the raw
  verb (boundary holds above command-string parsing). (A hard-coded external
  absolute path such as `/usr/bin/git` is the documented out-of-scope residual — see
  Decisions → Threat model and residual — not covered by this criterion.)
- A `gh`-mediated checkout/ref mutation from the orchestrator surface (e.g.
  `gh pr checkout`) is denied — the internal-git carve-out does not extend to `gh`,
  only to the enumerated pack paths.
- `git fetch` (without an observably non-mutating flag) from the orchestrator
  surface is denied; `git fetch --dry-run` (or the agreed non-mutating form) is
  allowed.
- The real-binary resolution leaves no turn-reachable bypass: with the marker set,
  there is no turn-visible env var holding the real `ao`/`git` path and the real
  binaries are not earlier on the turn `PATH` than the shims (a test asserts the
  resolution mechanism is out of band).
- With the marker **absent** (worker session, operator shell), `ao spawn`,
  `ao spawn --claim-pr`, and mutating git all execute normally against the real
  binaries — the gate does not fire.
- An ambiguous-provenance git call under the marker (cannot confirm sanctioned-tool
  parent; missing/spoofed pass-through marker) is denied, not allowed.
- The autonomous spawn/git capabilities are enumerated in a checked inventory, and a
  capability checker fails if a denied verb is reachable or an entry is missing.

```positive-outcome
asserts: under AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1, the git shim DENIES a direct `git branch -m a b` (non-zero exit, real branch unchanged) AND ALLOWS the `git worktree add` issued as a child of `ao review run`
input: external-tool-output
provenance: capture-backed
```

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- No AO YAML schema features beyond what #318 already uses (`agentConfig` env + PATH);
  a silently-ignored block (`reviewer:` class) is not relied upon.
- No new repo secrets. The orchestrator `agentConfig` delta carries only local
  paths (PATH ordering, out-of-band real-binary resolution), not credentials, and
  lives in operator-applied `agent-orchestrator.yaml` (the `.example` documents the
  shape only). Per the Binding-surface contract, the real-binary path is **not**
  exposed as a turn-visible `AO_REAL_BINARY`/`GIT_REAL_BINARY` env var in the marked
  surface — adopting `git` here means reworking #318's `AO_REAL_BINARY` exposure to
  the same out-of-band rule, not adding a second turn-visible escape variable.
- The shim must fail safe if the real binary cannot be resolved (clear error, no
  silent pass-through of a denied verb; read-only/allowed paths may still resolve the
  real binary as `scripts/ao` does today).

## Verification

- Deny/allow matrix tests (marker on/off × {ao spawn, ao spawn --claim-pr, mutating
  git, read-only git, ao-internal git}) pass, each asserting the observable outcome
  (exit code + real-binary side effect present/absent), per the table in
  **Decisions → Full-class enumeration**.
- A capture-backed fixture proves the `ao review run` internal `git worktree add`
  path still succeeds under the marker (the positive-outcome block).
- `scripts/verify.ps1` (or the pack's aggregate test runner) is green, including the
  new capability-inventory checker.
- Operator go-live: after applying the `agent-orchestrator.yaml` delta and
  `ao start`, the operator confirms from an orchestrator turn that `ao spawn` and
  `git checkout` are refused while `git status` and a sanctioned `ao review run`
  succeed; steps documented in `docs/migration_notes.md`.

## Decisions (design analysis)

### Prior art

The prior-art reconnaissance (coworker survey of all `docs/issues_drafts/**` +
architecture log + declarations, plus live `gh` queries) found: **no shipped or open
work implements a hard execution-boundary deny for spawn or git.** Every existing
spawn/git restriction (#163, #207, #202, #171, #28) is **soft prose** in
`orchestratorRules` / agent rules. #318 (merged) is the **only** hard
process-boundary deny and is scoped to `ao review run`; it shipped the reusable
mechanism this draft extends (`scripts/ao` shim + `ao-autonomous-guard.ps1` +
`autonomous-review-start-capabilities.json`, all gated by
`AO_AUTONOMOUS_ORCHESTRATOR_SURFACE`). #98 owns the `--claim-pr` feature being
abused; #91 owns post-hoc worktree hygiene. Verdict: **extends #318** — re-use the
boundary machinery, add the spawn/git verb families; do not rebuild and do not
duplicate #91's cleanup or #98's feature.

The production trigger: in operator-gated mode the orchestrator
([[orchestrator-operator-gated-spawn]]) must never spawn or touch git, yet it ran
`ao spawn --claim-pr 322` + `git branch -m feat/318 …` in its own worktree, parking
the worker branch and blocking the assigned worker
([[publish-delegation-clobbers-live-tree]] is the sibling "cheap delegate mutates a
live tree" class; this is the orchestrator-runtime instance). Prose did not hold —
hence a mechanical gate, the same lesson #318 captured for the review verb and
[[llm-turn-unclaimed-review-start-surface]] captured for the claim.

### Critical mechanics

- **Provenance is by env-marker scope, not caller classification.** The gate fires
  only when `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE` is set, which only the orchestrator
  `agentConfig` sets. This makes "workers/operator unaffected" true *by construction*
  rather than by trying to classify each caller — the same design #318 used.
- **The hard boundary condition: don't break `ao`/`gh` internal git.** A naive
  `scripts/git` shim that denies all mutating git under the marker would also deny
  the `git worktree add` that `ao review run` performs (a child process inheriting
  the marker), breaking review. The gate must distinguish *direct orchestrator git*
  from *git as a subprocess of a sanctioned tool* (parent-process inspection or a
  pass-through marker the sanctioned tools set). This is the make-or-break edge.
- **Read-only vs mutating git** must be separated so coordination reads
  (`status`/`log`/`rev-parse`) keep working; only tree/ref-mutating subcommands are
  denied.
- **Fail-closed direction is asymmetric to #318's spawn-vs-review case:** the gate
  fires only *inside* the marked surface, so failing closed there cannot break the
  operator. Within the surface, ambiguous git provenance denies.

### World / industry practice

This is **principle-of-least-privilege capability restriction** for an autonomous
agent: give the process only the verbs its role needs. Established lightweight forms:
restricted-shell / wrapper-shim PATH interposition (rbash, CI command wrappers),
agent-runtime command allow/deny hooks (Claude Code PreToolUse hooks, RTK guards),
and OS sandboxing (seccomp/AppArmor — overkill and OS-specific here). Repo-side git
hooks (pre-checkout/pre-push) are **rejected** as the primary mechanism: they are
bypassable (`--no-verify`, plumbing) and would also catch workers. The pack already
chose PATH-shim interposition for `ao` (#318); extending it to `git` is the
consistent, proven choice.

### Architecture sketch

```
orchestrator agentConfig (AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1, scripts/ on PATH)
        |
   turn runs `ao spawn ...` / `git checkout ...` / `git status`
        |
  scripts/ao  (existing)            scripts/git  (new, same pattern)
        |                                   |
  ao-autonomous-guard.ps1            git-autonomous-guard.ps1
   - deny: review run (existing)      - deny: mutating git (direct), incl. fetch
   - deny: spawn / --claim-pr (NEW)   - allow: read-only git
   - pass: everything else            - allow: git child-of-ENUMERATED-pack-path
        |                                   |              (NOT any child of gh)
  real ao (out-of-band resolve)      real git (out-of-band resolve)
        |
  (ao review run -> reviewer workspace -> git worktree add)  <-- must still pass

Real-binary path is resolved out of band — not a turn-visible env var, not on the
turn PATH ahead of the shims (closes the absolute-path / $*_REAL_BINARY bypass).
```

Worker / operator: no marker, no `scripts/` interposition for these verbs → real
`ao`/`git` directly.

### Full-class enumeration (decision matrix — fix the class, not the case)

Dimensions: **surface** × **verb**. The build must satisfy every cell, handed to
Acceptance criteria as fixtures ([[fix-the-class-not-the-case]]).

| Surface (marker)                | `ao spawn` / `--claim-pr` | mutating git incl. `fetch` (direct) | git as child of **enumerated** pack path | `gh`-mediated git mutation² | read-only git | other `ao`/`gh` |
|---------------------------------|---------------------------|-------------------------------------|------------------------------------------|------------------------------|---------------|-----------------|
| orchestrator autonomous (set)   | **DENY** (exit ≠0)        | **DENY**                            | **ALLOW**                                | **DENY**                     | ALLOW         | ALLOW¹          |
| worker session (unset)          | ALLOW                     | ALLOW                               | ALLOW                                    | ALLOW                        | ALLOW         | ALLOW           |
| human operator (unset)          | ALLOW                     | ALLOW                               | ALLOW                                    | ALLOW                        | ALLOW         | ALLOW           |
| ambiguous provenance (set)      | DENY                      | **DENY**                            | n/a                                      | DENY                         | ALLOW         | —               |

¹ `ao review run` from the orchestrator stays gated by #318's claimed-entry-point
rule — unchanged here.
² `gh pr checkout` / `gh repo clone` and other `gh` flows that mutate a checkout or
refs do **not** get the internal-git carve-out; the git they invoke is denied just
like direct orchestrator git (the carve-out is the enumerated pack paths only).

The sibling cells sharing the root cause are the entire **orchestrator-autonomous**
row's mutating verbs: they all stem from "cheap model ignores prose," so all are
closed by the one boundary, not just the two reproduced commands
(`ao spawn --claim-pr` + `git branch -m`).

### Threat model and residual

The chosen mechanism is a **cooperative process-boundary** control, the same class
#318 uses. It removes the denied verbs from the orchestrator surface's *normal and
discoverable* paths — the command the model naturally types, reworded spellings,
re-pathed wrappers, and runtime-generated helpers — and, by resolving the real
binary out of band (no turn-visible `*_REAL_BINARY`, real binaries not on the turn
PATH), it removes the obvious absolute-path escape Codex flagged. It is **not** a
kernel sandbox: a process that already knows a real binary's absolute path
(`/usr/bin/git` is well-known) can still exec it directly. Closing that last gap
requires OS-level sandboxing (seccomp/AppArmor/namespaces) or running the
orchestrator under a restricted account — **out of scope here** and tracked as a
known residual, because the production failure this draft fixes is a *cooperative*
cheap model running its **normal** `ao spawn` / `git branch` commands, not an
adversary probing for `/usr/bin/git`. The spec hardens the boundary to the limit of
the PATH-shim class and states the residual honestly rather than implying the gate
is airtight. (If the residual proves exploited in practice, the follow-up is an
OS-sandbox draft, not more of this mechanism.)

### Options considered

1. **Extend #318's shim mechanism: add spawn/--claim-pr to the `ao` guard + a
   parallel `scripts/git` shim with the sanctioned-child carve-out (CHOSEN).**
   Cost: low–medium — the `ao spawn` deny is a few lines in the existing guard; the
   `git` shim mirrors `scripts/ao` but adds parent-process boundary detection.
   Risk: low — proven pattern, scoped by construction; the one real risk
   (breaking `ao`-internal git) is explicitly a tested acceptance criterion.
   Sufficiency: full — closes the whole orchestrator-autonomous mutating-verb row.
   **Cheapest sufficient executor with acceptable risk** given tests + Codex review.
2. **Reuse the shim for `ao`, but gate git via an AO per-session capability flag /
   runtime permission boundary instead of a `git` shim.** Cost: high / unknown —
   depends on AO 0.9.x exposing a per-session command-deny surface; the pack has
   already hit "YAML block silently ignored" (`reviewer:`), so betting on an
   unverified AO feature is risky. Risk: high (may not exist; can't break AO core).
   Rejected: not demonstrably available, and would touch behavior the pack does not
   own.
3. **Repo-side git hooks (pre-checkout/pre-push) + keep prose for spawn.** Cost:
   low. Risk: high — hooks are bypassable (`--no-verify`, plumbing) so the gate is
   not fail-closed, and they fire for *all* sessions (would block workers' legitimate
   git). Rejected: insufficient (bypassable) and wrong blast radius.
4. **(Status quo) strengthen `orchestratorRules` prose only.** Cost: ~0. Risk:
   proven to fail — the cheap orchestrator model already disregarded the existing
   prohibition in production. Rejected: this draft exists *because* prose failed.

### Decomposition note

Considered splitting spawn-deny and git-deny into two drafts. Kept as **one** build:
both verb families share the env-marker provenance, the shim+guard+inventory
scaffolding, the exit-code/redirect convention, and — most importantly — both must
land together to close the feedback loop (the reproduced incident used
`ao spawn --claim-pr` **and** `git branch -m`; denying only one leaves the collision
reachable via the other). Splitting would duplicate scaffolding and ship a half-fix.
If implementation surface proves too large for one PR, the natural cut is to land the
`ao spawn` guard extension first (it reuses #318 almost verbatim) and the `git` shim
as an immediate follow-up — but the default is one PR.
