# gh wrapper terminal resolution — mutual-recursion OOM (P0)

GitHub Issue: [#442](https://github.com/chetwerikoff/orchestrator-pack/issues/442)

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub [#431](https://github.com/chetwerikoff/orchestrator-pack/issues/431)) — already ships `scripts/gh` → `scripts/lib/gh-wrapper.mjs` on PATH; this draft fixes wrapper **chaining** that #431 does not address.

## Goal

**P0 / ship independently:** When AO's autonomous surface places two `gh` wrappers on PATH (`~/.ao/bin/gh` from Agent Orchestrator and pack `scripts/gh`), mutual recursion can spawn thousands of wrapper processes per minute, exhaust RAM (~9 GB/min observed), and take down the WSL host and orchestrator. The pack must resolve every internal "real gh" delegation to the **actual `gh` executable** (a native binary the OS can run directly — not a shell script or node entry that re-dispatches `gh` on PATH). A secondary fail-safe may bound pathological chains if an unknown future wrapper appears, but **terminality is the primary fix** — if delegation always reaches the real binary, the today's cycle cannot occur.

Verification note: bounded live repro showed process **burst** (e.g. 4→30 over a few seconds with `timeout`), not an unbounded loop held open in the lab fixture; the production OOM event (`~/.oom-monitor/timeline.log`: `bash`/`node` into the hundreds, `gh` spikes, RAM collapse) is the severity driver. Regression tests prove **bounded termination** under the two-wrapper fixture; they do not claim to reproduce full OOM in CI.

```behavior-kind
action-producing
```

## Binding surface

The pack commits to **identity-based terminal `gh` resolution** for every code path that delegates from `scripts/gh`, `scripts/lib/gh-wrapper.mjs`, and shared resolver helpers:

- Delegation target must be the real `gh` **executable** (native binary), verified by an identity check the planner chooses (e.g. ELF executable, not a text/shebang script that would re-enter wrapper dispatch). Path blocklists alone (skip `~/.ao/bin`, skip `scripts/`) are **insufficient** as the sole contract — AO can relocate wrappers; identity of the target is durable.
- Under any PATH ordering AO's autonomous surface produces (`~/.ao/bin` present, pack `scripts/` prepended via bootstrap, `GH_WRAPPER_ACTIVE` set or unset, `execFile`/`spawnSync` entry), pack-side delegation must not bounce between wrappers.
- A resettable-only env guard (`GH_WRAPPER_ACTIVE` and variants that get unset via `env -u`) is **not** sufficient as the sole defense — today's failure mode already bypasses it.
- Optional **defense-in-depth:** if identity resolution alone cannot be proven for every edge, a bounded fail-safe (cycle/hop detection) may abort with a diagnosable error — secondary to terminality, not a substitute.

**Known residual (document, do not block this PR):** After terminality, a call may still traverse AO `~/.ao/bin/gh` → pack `scripts/gh` → node wrapper → `/usr/bin/gh` (multiple spawns per logical `gh`). That is acceptable for P0; collapsing to a single hop is upstream AO / PATH-policy follow-up.

**Operator adoption:** gitignored `.ao/autonomous-real-binaries.json` `"gh":"/usr/bin/gh"` is a **stopgap** that breaks today's back-edge locally. This issue replaces reliance on that pin. Operators may remove the pin after verification.

**Out of scope for this issue:** extending REST inventory routes for AO `detectPR` argv — tracked separately in `docs/issues_drafts/137-gh-detectpr-rest-inventory-route.md` (scale optimization; recursion fix removes the acute GraphQL/quota hammer).

## Contract evidence

Terminal-resolution behavior is **repo-owned** (pack resolver + regression fixtures). Grounded by verification report (code reading, bounded repro, `~/.oom-monitor/timeline.log`). No external capture manifest entry yet.

```contract-evidence
none
```

## Design analysis (pre-draft gate)

### Critical mechanics

- **Two wrappers, one PATH:** AO `~/.ao/bin/gh` strips only its own dir, resolves `real_gh` via `command -v` on cleaned PATH (`~/.ao/bin/gh:5–20`), invokes `"$real_gh" "$@"` as child (`:149`, `:299`). Pack `scripts/gh` (`scripts/gh:8–13`) unsets `GH_WRAPPER_ACTIVE` and re-lookups `gh`, or `exec node gh-wrapper.mjs`. Pack passthrough (`gh-wrapper.mjs:40–55`) `spawnSync(resolveRealGhBinary(), …)`. Today's `resolveRealGhBinary()` (`gh-resolve-real-binary.mjs:66–78`) skips only pack `scripts/` and returns the next `gh` on PATH → `~/.ao/bin/gh` when both present (live: `resolved: /home/che/.ao/bin/gh`).
- **Quota / OOM amplifier:** Recursion spawned wrapper processes far faster than normal `detectPR` polling (~8 calls/min for four sessions vs GraphQL hourly limits). Quota exhaustion in the incident was a **symptom of the loop**, not steady-state detectPR load.

### How the industry handles shim chains

- Resolve to a **canonical real binary** once (git, gcloud, npm patterns).
- Identity checks (executable vs script shim) over path blocklists.
- Optional hop limits as defense-in-depth, not primary.

### Architecture sketch

```
Caller → scripts/gh → gh-wrapper.mjs → resolve terminal target
                                              │
                                              ├─ identity: native gh executable
                                              ├─ optional explicit absolute pin (non-shim)
                                              └─ optional bounded fail-safe (secondary)
```

### Options (cost / risk / sufficiency)

| Option | Summary | Cost | Risk | Sufficient? |
|--------|---------|------|------|-------------|
| A. Operator pin only (`.ao/autonomous-real-binaries.json`) | Stopgap | Zero code | High — gitignored, not portable | **No** |
| B. Identity-based terminal resolver in pack | Delegate only to real `gh` executable; wire through passthrough and REST `gh api` paths; regression test for two-wrapper PATH fixture | Low–medium | Low | **Yes** (P0) |
| C. PATH blocklist only (skip known wrapper dirs) | Fragile when AO moves | Low | Medium — silent break on relocation | **No alone** |
| D. Upstream AO `~/.ao/bin/gh` fix only | Out of pack scope | Medium upstream | Pack still exposed when only pack shim on PATH | **Insufficient alone** |

**Choice:** B (identity-based terminality); optional secondary bound; D as upstream follow-up.

### Class enumeration

| Entry | Must terminate at real executable |
|-------|-----------------------------------|
| AO `execGhObserved` → `gh` on PATH | yes |
| Worker shell under `BASH_ENV` bootstrap | yes |
| `scripts/gh` / `node gh-wrapper.mjs` | yes |
| Passthrough with guard set then unset | yes |
| REST route internal `gh api` delegation | yes |

PATH orderings: `~/.ao/bin` before `scripts/`; `scripts/` before `~/.ao/bin`; single wrapper present.

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `136-gh-wrapper-mutual-recursion-terminal-resolution`.

```allowed-roots
scripts/**
```

## Acceptance criteria

1. **Terminal identity (primary):** Pack resolver delegates only to the real `gh` executable (identity-based — not another shell/node wrapper). Automated tests cover fixture PATH orderings with both `~/.ao/bin` and pack `scripts/` present **without** relying on `.ao/autonomous-real-binaries.json`. Fixtures must exercise the **passthrough** code path (`route: null` → `resolveRealGhBinary`) — the path where mutual recursion occurred. Routed argv shapes (e.g. `pr list --head` with sole `--json number`) bypass the resolver and can pass while the defect remains (**green ≠ reachable**, cf. #342).

```positive-outcome
asserts: two-wrapper PATH regression fixture completes with bounded wrapper-related process growth across repeated invocations on passthrough argv (test-defined bound)
input: realistic
```

2. **No hang on passthrough smoke:** With the same fixture, smoke uses argv **guaranteed** to classify as passthrough (`route: null`) — e.g. AO `detectPR` multi-field form (`pr list --repo <slug> --head <branch> --json number,url,… --limit 1`) or any non-routable verb the planner chooses (e.g. `pr view`). Not routed-only shapes such as `pr list --head <branch> --json number --limit 1` alone. Invocation exits within a normal gh timeout with exit code 0 or a conventional gh error — not indefinite hang.

3. **Guard insufficiency covered:** Tests include the case where a resettable wrapper guard is set and later unset across the chain; terminality still holds without depending on that guard alone.

4. **Defense-in-depth (secondary):** If the planner adds a hop/cycle bound for unknown future wrappers, a synthetic two-wrapper fixture proves fail-closed termination within the chosen budget — proven by regression test only (no required runtime telemetry datum).

5. **#431 preserved:** Existing inventory REST routes from #431 remain covered; no regression in baseline `gh-wrapper` tests.

## Upgrade-safety check

- No Composio AO core / vendor edits.
- No new secrets.
- Upgrade-safe under `scripts/` + tests.

## Verification

- Extended `scripts/gh-wrapper` test suite (mutual-recursion fixture).
- `pwsh -NoProfile -File scripts/verify.ps1` passes.
- Manual bounded repro documented in PR uses **passthrough** argv (detectPR multi-field `--json` or equivalent `route: null` shape), e.g. `timeout 5 env PATH="$HOME/.ao/bin:$PWD/scripts:…" scripts/gh pr list --repo owner/repo --head test --json number,url --limit 1` — process count returns to baseline after exit.
