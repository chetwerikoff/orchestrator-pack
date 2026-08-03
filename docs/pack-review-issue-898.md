# Pack-review authority, carry-over, cap, triage, and budget (Issue #898)

This document records the shipped operator and implementation contract for Issue #898. The live source of truth is the pack-owned runner and the authority record under the review-run store; historical captures and prose do not independently authorize a clean review or merge.

## Operator configuration

The resolver default remains ten minutes:

```text
AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS absent or empty -> 600000
```

The live operator configuration is:

```text
AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS=2400000
```

`2400000` is an override, not the built-in default. The resolver accepts only canonical positive decimal integers for this variable and caps it at `2147183000`. The runner overhead is `300000` ms. Its whole-second timeout is the ceiling of `(effectiveBudgetMs + 300000) / 1000`, so the default yields 900 seconds and the live override yields 2700 seconds. `600001` yields 901 seconds rather than 900. An explicit runner timeout must be canonical, must fit the Node timer ceiling, and must not be lower than the derived value.

The existing sibling-variable behavior is intentionally unchanged. Without explicit overrides, the soft deadline is 510000 ms for the default and 2040000 ms for the live override. The default test budget remains capped at 120000 ms. The existing timeout retry maximum parser is unchanged.

A fallback attempt plus one fresh retry can spend approximately twenty minutes before repeated-timeout escalation. Under the live override, the corresponding path can spend approximately eighty minutes. A `timed_out / timeout_no_verdict` head consumes no review-cycle slot unless authoritative findings are attached.

## Conflict-only clean carry-over

A prior clean verdict for `H0` is never enough to publish a whole-head clean verdict for a conflict-resolved `H1`.

The carry-over helper requires an exact two-parent merge commit whose first parent is `H0` and second parent is the pinned main commit `M`. It replays the merge in a temporary index, captures stage-1/2/3 blob identities and modes for every conflict, rejects unsupported object shapes, grafts only the resolved `H1` conflict blobs into the replay, and requires the resulting tree to equal the exact `H1` tree.

A conflict-free exact replay may use direct carry-over. An actual conflict produces a length-framed `merge-resolution-bundle/v2`, containing the complete resolved bytes and object identities. The configured reviewer must return clean with zero findings while bound to exact `H1` and the exact bundle digest. Only then can an authority-selected `schemaVersion: 1`, `terminalContractVersion: 2`, `terminalSource: merge_composite` row support clean publication.

Any parent mismatch, unrelated edit, replay drift, missing object, binary/LFS/symlink/gitlink/submodule shape, malformed bundle, digest mismatch, or focused-review finding refuses carry-over and falls back to the normal full-head review path.

## Single authority and transition order

The review-run store lock `<storeRoot>/.store-lock` is the only lock domain. The per-PR commit point is:

```text
<storeRoot>/authority/pr-<PR>.json
```

Immutable terminal, bundle, and evidence records may be staged before commit. They have no authority until the per-PR document atomically points to them and advances `transitionSeq`. A compare-and-swap mismatch reloads/refuses rather than overwriting newer state. Differing bytes for the same create-once immutable key fail as `authority_conflict`.

The transition order is:

```text
head_observed
-> claim_acquired
-> review_or_bundle_staged
-> terminal_and_cap_committed
-> evidence_selected
-> triage_committed
-> external_published
```

A new head invalidates exact-head evidence, triage, and publication, but it does not erase cycle consumption. Findings for an exact head outrank a later clean candidate for the same head. Outward publication must be bound to the current authority terminal and current head.

## Review-cycle cap adoption

Issue #1063 remains authoritative:

| Tier | Distinct eligible terminal heads |
|---|---:|
| T1 | 1 |
| T2 | 2 |
| T3 | 4 |

A newly opened cycle or a valid audited `ACK_RESET` freezes the current `1/2/4` value and records `capMapVersion: issue-1063-1-2-4`.

A valid already-open cycle keeps its exact positive persisted cap, frozen tier, consumed-head set, and at-cap latch until clean close, merge, or valid reset. Import labels it `capMapVersion: legacy-frozen` and `frozenMapOrigin: persisted-open-cycle`. Restart, upgrade, head advance, retry, and evidence regeneration are not migration boundaries and do not rewrite that cycle. Historical rows are never bulk-normalized.

At cap, a later head remains `at_cap_continuation_required`; a normal review start is denied. `ACK_RESET` must name the prior cycle ID and prior at-cap hash and include actor, reason, timestamp, and nonce. The newly opened reset cycle then adopts live `1/2/4`.

Eligible exact-head verdict terminals consume at most one slot per head. In-flight, stale/superseded, reaper-killed, zero-finding failed/cancelled, malformed/no-verdict execution failures, and timeout-only rows do not consume a slot.

## Automatic versus architect triage authority

The automatic primary-path registry contains exactly one row:

```text
scope-denylist-current-head/v1
producer: scripts/merge-triage-evidence.ts
predicate: exact-current-head changed paths intersect the bound Issue denylist
```

The expected evidence key binds repository, PR, cycle, current head, at-cap hash, registry version, producer executable digest, immutable Issue snapshot digest, changed-path capture digest, and input digest. Callers cannot choose an evidence ID. Exactly one immutable row matching the complete tuple must be selected by the authority document.

A trusted current-head denylist intersection can produce automatic `BLOCK`. A trusted no-intersection result with semantic findings produces `PENDING_ARCHITECT`. Missing, stale, malformed, forged, ambiguous, or failed evidence produces `PENDING_OPERATOR`. Every at-cap head shift derives a new tuple and requires fresh evidence before automatic triage.

Finding text, copied producer fields, a caller-supplied ID, `block_marker`, and text-derived scope/denylist candidates never produce automatic `BLOCK`. They route to trusted production and/or `PENDING_ARCHITECT`. Token/provenance-bound architect adjudication remains separate and can persist explicit `BLOCK | DEFER` against the exact current-head finding snapshot.

## Verification

Focused verification:

```text
npx vitest run scripts/pack-review-carryover.test.ts
npx vitest run scripts/pack-review-state.test.ts
npx vitest run scripts/merge-triage-evidence.test.ts
npx vitest run scripts/pack-review-runner-issue-898.test.ts
```

Repository floors remain:

```text
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

The final diff must remain inside Issue #898 `allowed-roots` and must not touch denied roots, workflows, kernel timer primitives, core/vendor code, reviewer model/prompt policy, or retired machinery.
