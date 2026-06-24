# Autonomous review worktree git: scoped authorization for claimed AO-owned worktree add

GitHub Issue: #429

## Prerequisite

- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub **#318**, closed) — autonomous review-start must traverse the claimed entry point. Armed manual/raw bypass (opk-rev-923) is **sibling** investigation memo `docs/investigations/opk-rev-923-armed-review-start-process-boundary-bypass.md` — not a build queue item.
- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub **#324**, closed, PR **#327**) — git shim + `Orchestrator-AutonomousBoundary.ps1`.
- `docs/issues_drafts/129-review-start-claim-liveness-reaper.md` (GitHub **#417**, open, PR **#427**) — claim lifecycle. **Hard sequencing:** PR **#427** must be merged to `main` before worker spawn (verify via GitHub at launch time). Lifecycle implementation is **out of scope**; #417 no-regression only.

**Prior-art recon verdict:** **Extends #324 only** — scoped git authorization for **claimed automated** AO-owned `git worktree add` via launch-bound credential (not parent-chain depth alone).

## Incident anchor

- **opk-rev-922** (PR #425): claimed-path `autonomous_mutating_git_denied` on `git worktree add`; orchestrator-turn claim acquired. No saved `/proc` chain.
- **923 / 925:** not proof of claimed topology (**923** → sibling investigation memo). **924 / 926** out of scope.

**Historical hypothesis (922 only, not part of fix contract):** ancestor-index scan may have contributed; E2E + launch credential contract is authoritative for the fix.

## Goal (four obligations)

1. **Claimed armed AO-owned `git worktree add` passes** via isolated E2E smoke (real AO workspace setup), not unit fixtures alone.
2. **Authorization bound** to claimed launch ownership + permitted argv shape + hardened canonical workspace path rules (see Binding surface).
3. **Direct / spoofed / armed manual-or-bare paths** do not gain worktree allow from this fix.
4. **Crash-safe isolated E2E smoke** + **#417 no-regression** after #427 on `main`.

```behavior-kind
action-producing
```

## Binding surface

- **In scope:** `git worktree add --detach` after `Invoke-OrchestratorClaimedReviewRun` acquired claim and spawned `ao review run` with `AO_CLAIMED_REVIEW_RUN_BYPASS=1`.
- **Credential contract (planner wire format flexible):** binds `(projectId, prNumber, headSha, launchIntent)`; single-use + short TTL + replay rejection; target SHA in argv matches claimed `headSha`; argv matches permitted `worktree add --detach` form. **Do not require** pre-signing AO-generated `opk-rev-N` unless known pre-launch without AO core changes.
- **Canonical workspace path hardening (mandatory):** git-shim MUST verify the **actual** target path:
  - resolves under the **canonical project state root** for the bound `projectId` (no `projectId` substitution);
  - lies under `code-reviews/workspaces/` for that root after **normalization** (collapse `.` / `..`, resolve symlinks/junctions where platform supports it — fail-closed on ambiguous escape);
  - **target workspace path must not pre-exist at authorization time**, except for explicitly defined idempotent/recovery behavior the planner documents;
  - rejects path traversal, symlink escape, and namespace swap attacks against the bound credential.
- **TOCTOU / launch fencing:** path absence check and credential **consumption** MUST occur within the **same fenced launch attempt** (atomic with minted credential lifecycle). If another process creates the target directory between check and `git worktree add`, the attempt **fail-closed** (deny + do not leave credential reusable).
- **Threat boundary:** credential not mintable through normal autonomous-turn capabilities; not accepted without valid claimed launch ownership. Does **not** claim protection against same-user `/proc` read or known absolute binary — #324 cooperative residual.
- **E2E smoke isolation + crash-safety (AC#1).** MUST:
  - use a **fresh fixture state root per run** (dedicated project id / isolated AO state directory);
  - run **serial / exclusive** — no parallel E2E on the same fixture state;
  - use a **disposable git repository** (or worktree) for the armed `git branch -m` negative check — not production pack root;
  - use a **noop** review command;
  - snapshot production review-run / claim stores **before** smoke;
  - **cleanup in `finally`**: fixture session, run record, workspace, disposable git repo;
  - **in the same `finally`**, assert production stores match pre-smoke snapshot — **even when smoke fails early** (detect production pollution before teardown completes);
  - **failed cleanup fails the test** and prints **bounded recovery instructions** (paths to remove, no secrets);
  - no real GitHub PR required if fixture session reproduces AO workspace setup.
- **Redacted capture** under `tests/external-output-references/**`; no secrets in argv/audit/capture.
- **Security regression:** fix MUST NOT arm manual/bare/spoofed worktree paths.

## Files in scope

- `scripts/` — git boundary / guard, claimed broker integration, isolated E2E smoke harness.
- `docs/` — capability inventory extensions.
- `tests/external-output-references/**` — redacted captures.

## Files out of scope

- `invoke-manual-review-run.ps1`; **`scripts/ao` process-boundary / manual-bare enforcement** (owned by investigation memo) — edits to `scripts/ao` **only for claimed credential plumbing are allowed if strictly required** for launch-bound credential mint/consumption; no manual-bare policy changes;
- claim lifecycle (#417); AO core; `vendor/**`, `packages/core/**`, `.ao/**`.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
tests/external-output-references/**
```

## Scenario matrix

| launch / entry | surface | condition | current | required after fix |
|----------------|---------|-----------|---------|-------------------|
| claimed AO launch | armed | valid launch-bound credential + new workspace path | DENY | ALLOW |
| claimed AO launch | armed | invalid / replayed / mismatched launch binding | DENY | DENY |
| claimed AO launch | armed | path escape / wrong projectId / pre-existing dir / TOCTOU race | DENY | DENY |
| direct / spoofed / armed manual-bare | armed | `worktree add` or mutating git | DENY | DENY |
| reconcile / wake | unarmed | `worktree add` (legacy) | ALLOW | ALLOW (unchanged) |

## Acceptance criteria

1. **Producer-emission — isolated crash-safe E2E smoke (AC#1):**
   - fresh fixture state root per run; serial/exclusive execution;
   - armed claimed entrypoint → real `ao review run` → new workspace under hardened canonical prefix → noop command;
   - disposable git repo for armed `git branch -m` deny check;
   - pre-smoke production snapshot; **`finally`** asserts production unchanged **even on early smoke failure**, then teardown;
   - failed cleanup → test fail + bounded recovery instructions;
   - negative fixtures: `..` / symlink escape / wrong `projectId` / pre-existing dir / TOCTOU race → deny.

```producer-emission
producer: orchestrator-pack
datum: autonomous-review-worktree-e2e-smoke
expected: allow
proof-command: npx vitest run scripts/autonomous-review-worktree-e2e-smoke.test.ts
```

Planner may colocate in `scripts/autonomous-orchestrator-boundary.test.ts` **only if** the test creates isolated AO state and runs a real `ao review run` (not a unit parent-chain stub). Prefer a dedicated E2E test file when in doubt.

2. **Producer-emission — path hardening unit fixtures (AC#2):** traversal, symlink/junction escape, `projectId` mismatch, pre-existing workspace dir, TOCTOU race — deny; valid new workspace allow.

```producer-emission
producer: orchestrator-pack
datum: autonomous-review-worktree-path-hardening
expected: deny-on-escape
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t worktree-path-hardening
```

3. **Producer-emission — launch-bound unit chain (AC#3):** production-representative parent chain + credential allows permitted `worktree add --detach` (supporting only).

```producer-emission
producer: orchestrator-pack
datum: autonomous-review-worktree-production-chain
expected: allow
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t production-chain
```

4. **Producer-emission — #324 positive-outcome regression (AC#4).**

```producer-emission
producer: orchestrator-pack
datum: github-324-positive-outcome
expected: allow
proof-command: npx vitest run scripts/autonomous-orchestrator-boundary.test.ts -t "positive-outcome"
```

5. **Security regression (AC#5):** `4cf7474` spoof deny; no worktree allow via manual/bare/spoofed path.
6. **Redacted capture (AC#6):** from isolated smoke.
7. **#417 no-regression (AC#7):** after #427 on `main`.

```positive-outcome
asserts: serial isolated E2E smoke with fresh fixture root completes AO reviewer workspace setup under hardened canonical path rules, asserts production state unchanged in finally even on failure, cleans up, and denies branch -m on disposable git repo in same armed environment
input: realistic
```

```contract-evidence
binding-id: orchestrator-pack:autonomous-review-worktree-e2e-smoke:allow
binding-type: cli-behavior
binding: crash-safe isolated E2E smoke with fresh fixture root, serial execution, finally production-state assertion and cleanup
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:autonomous-review-worktree-path-hardening:deny-on-escape
binding-type: cli-behavior
binding: path traversal symlink projectId mismatch pre-existing workspace and TOCTOU race attempts are denied; valid new workspace allowed
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:autonomous-review-worktree-production-chain:allow
binding-type: cli-behavior
binding: launch-bound credential with production-representative chain allows permitted worktree add detach
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:github-324-positive-outcome:allow
binding-type: cli-behavior
binding: #324 positive-outcome regression stays green
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Upgrade-safety check

- **PR #427 must be merged to `main` before worker spawn** (verify via GitHub at launch time).
- E2E MUST NOT mutate production dashboard state; failed cleanup is a test failure.

## Verification

- AC#1–7. Planner chooses wire format; contract requires launch-bound credential + path hardening — not depth-only bump, not ancestor-walk alone.

## Related

- `docs/investigations/opk-rev-923-armed-review-start-process-boundary-bypass.md` — RCA memo (opk-rev-923); independent.
