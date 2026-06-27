# Regression: Split-ProcessCommandLineTokens return-shape breaks gated internal ao send

GitHub Issue: [#428](https://github.com/chetwerikoff/orchestrator-pack/issues/428)

## Prerequisite

- `121-llm-turn-worker-nudge-per-cycle-gate.md` → [#384](https://github.com/chetwerikoff/orchestrator-pack/issues/384) (CLOSED) — gated worker nudge transport: `invoke-gated-worker-nudge` → `journaled-worker-send` with claim token; raw orchestrator `ao send` denied on autonomous surface; internal `AO_JOURNALED_SEND_INTERNAL` one-time capability for sanctioned transport.
- PR [#385](https://github.com/chetwerikoff/orchestrator-pack/pull/385) — implementation landed #384.
- `128-autonomous-bash-env-interposer-eval-hidden-defense.md` → [#406](https://github.com/chetwerikoff/orchestrator-pack/issues/406) (CLOSED) — tracked bootstrap + interposer; provenance matrix requires gated send **not** classified as `autonomous_raw_worker_send_denied`.
- PR [#407](https://github.com/chetwerikoff/orchestrator-pack/pull/407) — implementation landed #406.
- **Incident (PR #427):** orchestrator could not deliver a CI-failure nudge to worker `opk-2` because `journaled-worker-send` refused transport at the `ao send --file` preflight.

**Prior-art recon verdict:** **Extends #384/#406** — regression in trusted-parent script-path extraction added with the #384 internal-capability consumer, not a new gate surface or bash-forwarder ancestry failure.

## Problem (empirically confirmed)

On the autonomous orchestrator surface (`AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`, `scripts/` first in `PATH`), the **sanctioned gated worker-message path** fails before transport:

```
invoke-gated-worker-nudge.ps1
  → journaled-worker-send.ps1
  → Test-AoSendFileContract
  → ao send --help
  → scripts/ao (bash forwarder; exec preserves ancestry)
  → ao-autonomous-guard.ps1
  → autonomous_raw_worker_send_denied (exit 93)
  → wrapper treats --file contract as unavailable
  → transport refused (exit 42)
```

**Reproduction:**

```bash
printf '%s' 'probe' |
  env AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1 \
      AO_TMUX_NAME=opk-orchestrator \
      PATH="$PWD/scripts:$PATH" \
  pwsh -NoProfile -File scripts/journaled-worker-send.ps1 \
      opk-2 -Source diagnostic -DryRun
```

**Observed:** `journaled-worker-send: ao send --file contract is unavailable; refusing transport` → exit **42**.

**Not the cause:** the bash `scripts/ao` forwarder does **not** break parent-chain ancestry — it uses `exec`, and the immediate parent of the guard process **does** contain `pwsh … -File …/journaled-worker-send.ps1`.

**Empirical state at failure (production repro):**

| Check | Result |
|---|---|
| Capability record on disk | found |
| `Test-ProcessIsDescendantOf` (issuer) | **true** |
| `Test-JournaledWorkerSendParentChainTrusted` | **false** |
| Parent cmdline contains `-File journaled-worker-send.ps1` | **yes** |
| `Get-ScriptPathsFromProcessCommandLine` path count | **0** |

### Recurrence diagnostic (fixture vs production)

| Layer | What passes today | What production does |
|---|---|---|
| Unit: `autonomous guard allows registered journaled transport internal capability` | `AO_JOURNALED_SEND_CAPABILITY_TEST_FIXTURE=1` bypasses `Test-JournaledWorkerSendParentChainTrusted` | Never sets fixture flag |
| Interposer gated-send allow matrix (#406) | Stub `ao` — does not hit real shim + guard consumption | Full `journaled-worker-send` preflight |
| **Missing** | No unit test for `Split-ProcessCommandLineTokens` return-shape contract | `Get-ScriptPathsFromProcessCommandLine` receives nested array → `-File` token invisible |

**Evidence class:** non-representative fixture / missing return-shape unit test — parent chain and descendant checks pass; trusted-path parser returns zero paths.

## Goal

Fix the **tokenizer return-shape regression** so `Get-ScriptPathsFromProcessCommandLine` recognizes `-File journaled-worker-send.ps1` in production parent cmdlines, restoring sanctioned internal `ao send` (help probe + `--file` delivery) on the autonomous surface while leaving **#384 capability semantics unchanged** (registration, TTL, consumption, guard admission).

```behavior-kind
action-producing
```

## Binding surface

- **Single defect class:** `Split-ProcessCommandLineTokens` returns a single pipeline object (`return ,@($tokens.ToArray())`). `Get-ScriptPathsFromProcessCommandLine` must honor that return-shape contract so `-File` / `-f` tokens and the following script path are visible to trusted-path recognition. Observable symptom: production parent cmdline contains `-File journaled-worker-send.ps1` but path extraction returns zero paths.
- **No security-boundary redesign.** Do **not** change capability registration, TTL, single-use consumption, guard admission rules, or open raw autonomous `ao send`. Do **not** add forwarder-trust extensions, argv-class admission, or non-consuming help probes.
- **Production-shaped proof:** fixtures use real `scripts/ao` bash forwarder and real `ao-autonomous-guard.ps1`; only the **downstream real `ao` binary** may be stubbed.
- **Misleading exit-42 diagnostic (`--file unavailable`):** **out of scope** for this issue — fixing consumption restores preflight; distinguishing capability-deny from genuine missing `--file` is a separate UX task.

### Root cause (5 Whys — terminal)

1. Transport refused exit **42** because `Test-AoSendFileContract` returned false.
2. Preflight false because `ao send --help` exited **93** with `autonomous_raw_worker_send_denied`.
3. Guard denied because `Test-ConsumeJournaledWorkerSendInternalCapability` returned false despite a registered capability in `AO_JOURNALED_SEND_INTERNAL`.
4. Consumption failed `Test-JournaledWorkerSendParentChainTrusted` even though parent cmdline contains `pwsh … -File …/journaled-worker-send.ps1` and `Test-ProcessIsDescendantOf` is **true**.
5. **Terminal:** the #384 consumer `Get-ScriptPathsFromProcessCommandLine` violated the `Split-ProcessCommandLineTokens` return-shape contract (nested array after consumer re-wrap), so `-File` was never found (`pathCount=0`) and trusted-parent check returned false despite valid parent cmdline and successful descendant check. Tests masked this via `AO_JOURNALED_SEND_CAPABILITY_TEST_FIXTURE=1`; no return-shape unit test existed.

### Fix direction

| Requirement | Detail |
|---|---|
| Parser contract | Restore correct `-File` extraction from production-shaped parent cmdlines (return-shape regression) |
| Tests | Direct unit regression + production-shaped integration (real shim + guard, no fixture bypass) |
| Security | Capability registration, TTL, consumption, guard admission **unchanged** |

```contract-evidence
binding-id: orchestrator-pack:journaled-send-script-path-from-cmdline:trusted
binding-type: cli-behavior
binding: Get-ScriptPathsFromProcessCommandLine extracts -File journaled-worker-send.ps1 from a production-shaped parent cmdline and Test-TrustedJournaledWorkerSendScriptPath accepts it
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
selector: journaled-send-script-path-from-cmdline
expected: trusted

binding-id: orchestrator-pack:autonomous-sanctioned-ao-send-help-probe:allow
binding-type: cli-behavior
binding: on autonomous surface, journaled-worker-send preflight ao send --help through real scripts/ao and guard returns help containing --file; not exit 93
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
selector: autonomous-sanctioned-ao-send-help-probe
expected: allow

binding-id: orchestrator-pack:autonomous-sanctioned-ao-send-file-delivery:allow
binding-type: cli-behavior
binding: on autonomous surface, journaled-worker-send ao send --file through real scripts/ao and guard succeeds when internal capability is consumed; only downstream ao is stubbed
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
selector: autonomous-sanctioned-ao-send-file-delivery
expected: allow

binding-id: orchestrator-pack:autonomous-raw-worker-send:deny
binding-type: cli-behavior
binding: on autonomous surface, raw forged expired replayed and leaked-sibling-token ao send shapes exit 93 autonomous_raw_worker_send_denied
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
selector: autonomous-raw-worker-send
expected: deny
```

## Files in scope

- `scripts/lib/Journaled-WorkerSendInternalCapability.ps1` — `Get-ScriptPathsFromProcessCommandLine` flattening fix.
- `scripts/lib/Orchestrator-AutonomousBoundary.ps1` — return-shape contract documentation only if needed (no behavior change to tokenizer unless required by unit test).
- `scripts/*.test.ts` — unit + production-shaped regressions.

## Files out of scope

- Capability registration / TTL / consumption semantics changes.
- Guard admission redesign, forwarder-trust, argv-class admission, help-probe bypass.
- Misleading `--file unavailable` diagnostic text (separate UX issue).
- `agent-orchestrator.yaml`, `packages/core/**`, `vendor/**`.
- Pre-PR / issue-only worker nudge addressing.

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `132-autonomous-gated-send-internal-capability-regression`.

```allowed-roots
scripts/**
```

## Acceptance criteria

1. **AC#1 — Unit: return-shape + trusted path extraction:** command line containing `pwsh … -File …/journaled-worker-send.ps1` is parsed so `Get-ScriptPathsFromProcessCommandLine` returns the script path and `Test-TrustedJournaledWorkerSendScriptPath` is **true**; includes regression covering the nested-array failure mode that produced `pathCount=0` in production.

```producer-emission
producer: orchestrator-pack
datum: journaled-send-script-path-from-cmdline
expected: trusted
proof-command: npx vitest run scripts/worker-nudge-gate.test.ts -t "Split-ProcessCommandLineTokens return-shape"
```

2. **AC#2 — Production-shaped help probe:** with `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`, `PATH="$PWD/scripts:$PATH"`, **without** `AO_JOURNALED_SEND_CAPABILITY_TEST_FIXTURE`, `journaled-worker-send -DryRun` preflight succeeds (exit **0**, not **42**); `ao send --help` traverses **real** `scripts/ao` and **real** `ao-autonomous-guard.ps1` and returns help containing `--file` (not exit **93**).

```producer-emission
producer: orchestrator-pack
datum: autonomous-sanctioned-ao-send-help-probe
expected: allow
proof-command: npx vitest run scripts/worker-nudge-gate.test.ts -t "production chain help probe"
```

3. **AC#3 — Production-shaped delivery:** `journaled-worker-send` (or `invoke-gated-worker-nudge` with valid claim token) performs `ao send --file` through **real** `scripts/ao` + **real** guard; **only** the downstream real `ao` binary is replaced by a stub; transport exits **0** — not **93** and not **42**.

```producer-emission
producer: orchestrator-pack
datum: autonomous-sanctioned-ao-send-file-delivery
expected: allow
proof-command: npx vitest run scripts/worker-nudge-gate.test.ts -t "production chain delivery"
```

4. **AC#4 — Negative matrix (unchanged security):** on autonomous surface, each case exits **93** `autonomous_raw_worker_send_denied`: raw `ao send <worker> <msg>`; raw `ao send --help` without valid consumed capability; forged unregistered token; TTL-expired token; replayed nonce; sibling `ao send <worker> --file <path>` with live registered but unconsumed token in env (outside transport's active child). Existing negatives in `worker-nudge-gate.test.ts` and `autonomous-orchestrator-interposer.test.ts` stay green.

```producer-emission
producer: orchestrator-pack
datum: autonomous-raw-worker-send
expected: deny
proof-command: npx vitest run scripts/worker-nudge-gate.test.ts scripts/autonomous-orchestrator-interposer.test.ts -t "internal capability deny"
```

5. **AC#5 — Regression suite:** `npx vitest run scripts/worker-nudge-gate.test.ts scripts/autonomous-orchestrator-interposer.test.ts` and `pwsh -NoProfile -File scripts/verify.ps1` pass; manual repro in **Problem** → dry-run exit **0**.

```positive-outcome
asserts: on autonomous surface with PATH prepend, journaled-worker-send dry-run preflight exits 0 and gated invoke-gated-worker-nudge transport reaches ao send --file through real scripts/ao and guard with downstream ao stubbed; raw orchestrator ao send remains exit 93
input: external-tool-output
provenance: capture-backed
```

## Scenario matrix

| Surface | Invocation | Capability | Chain | Expected |
|---|---|---|---|---|
| `SURFACE=1` | `ao send --help` (journaled preflight) | registered | pwsh → **real** `scripts/ao` → **real** guard | **allow** |
| `SURFACE=1` | `ao send <worker> --file` (gated) | registered, consumed | real shim + guard → **stub** ao | **allow** (exit **0**) |
| `SURFACE=1` | raw `ao send --help` | none | any | **deny 93** |
| `SURFACE=1` | raw `ao send <worker> <msg>` | none | any | **deny 93** |
| `SURFACE=1` | `ao send --file` | forged / expired / replayed | any | **deny 93** |
| `SURFACE=1` | sibling `ao send --file` | live token, outside child | any | **deny 93** |
| unset | `ao send …` | n/a | n/a | **no regression** |

## Upgrade-safety check

- One-line parser flattening fix + tests; no AO core / vendor edits.
- #384/#406 security contract unchanged.

## Verification

- Proof commands in AC#1–AC#4.
- AC#5 full suites + `verify.ps1`.
- Manual repro command → exit **0** after fix.

## Review provenance

- Prior-art: #384/#406, PR #427 incident.
- Root cause corrected post-review: parser return-shape in `Get-ScriptPathsFromProcessCommandLine`, not bash-forwarder ancestry.
- Scope narrowed: no capability-semantics or guard-admission redesign; `--file unavailable` diagnostic out of scope.
