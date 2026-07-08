# Journaled worker send: `ao send` argv cutover to AO 0.10.2

GitHub Issue: #640

## Prerequisite

- `docs/issues_drafts/89-worker-message-delivery-confirmed-consumption.md` (GitHub #373) — **already does:** establishes `journaled-worker-send.ps1` as the orchestrator→worker transport chokepoint with metadata-only journaling, mechanical payload temp files, and a fail-closed `ao send --file` capability preflight keyed to parsed `--help` text.
- `docs/issues_drafts/121-llm-turn-worker-nudge-per-cycle-gate.md` (GitHub #384) — **already does:** routes gated orchestrator-turn worker nudges through `invoke-gated-worker-nudge.ps1` → `journaled-worker-send.ps1` with claim-before-send; transport argv is out of scope there.
- `docs/issues_drafts/132-autonomous-gated-send-internal-capability-regression.md` (GitHub #428) — **already does:** restores sanctioned internal `ao send` on the autonomous surface when the parent-chain tokenizer recognizes `journaled-worker-send.ps1`; assumes a passing `--file` capability preflight — **this draft updates that preflight to the 0.10.2 contract without changing capability semantics.**
- `docs/issues_drafts/201-submit-reconcile-adoption-and-consumption-proof.md` (GitHub #602) — **already does:** adoption preflight proves the orchestrator worker-send route reaches `journaled-worker-send.ps1` via probe sends; probe argv must migrate with the transport.
- `docs/issues_drafts/217-worker-recovery-spawn-argv-ao-0-10-2.md` (GitHub #638) — **already does:** AO 0.10.2 `spawn` argv cutover; explicitly lists journaled-worker-send cutover as **out of scope** — **this draft is the complementary `send` argv gap (synthesis audit gap #1, operator deferral lifted 2026-07-06).**

**Prior-art verdict (draft-author recon 2026-07-06):** **EXTENDS / REFERENCES** — closes the AO 0.10.2 `ao send` contract gap on settled journaled-transport prior art (#373/#384/#428); not a parallel transport or dedup redesign.

**Pre-draft design gate (architect brief carry-forward — not re-derived):** AO 0.10.2 exposes only `ao send --message <string> --session <string>` (usage `ao send [flags]`); the 0.9 positional session target, `--file`, `--no-wait`, and the removed wait-limit CLI flag are gone. Cheapest sufficient executor: migrate argv and capability probes to inline `--message`/`--session`; retain the payload **file** as the journal record only (Message Store pattern); decide capability on parsed `--help` text never exit code (probe trap); never wrap `ao send` in an external wall-clock limiter command (known zombie-children lesson); preserve caller-facing `-NoWait`/wait-budget-seconds parameter surface while mapping removed CLI flags is planner-owned.

## Goal

With AO 0.10.2 installed, automated worker nudges resume end-to-end: `journaled-worker-send.ps1` and the adoption-preflight lib build an `ao send` argv the current daemon accepts (`--message` inline, `--session` target), capability preflight passes instead of refusing, and claim/journal/dedup machinery is unchanged.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

## Binding surface

- **AO 0.10.2 send contract (external, capture-backed):** `ao send` requires `--message <string>` and `--session <string>`; usage line is `ao send [flags]`; `-h/--help` only. Verified against `/usr/lib/agent-orchestrator/resources/daemon/ao send --help` on 2026-07-06 (architect probe). Removed vs 0.9: positional session target, `--file`, `--no-wait`, the wait-limit CLI flag, and usage `ao send [options]`.
- **Broken today (verified in worktree):** `scripts/journaled-worker-send.ps1` builds `@('send', $SessionId, '--file', $payloadFile)` plus optional `--no-wait` and wait-limit argv tokens; `Test-AoSendFileContract` matches `--file` in help and fail-closes with `transport_preflight_failed` / `ao_send_file_unavailable`. Adoption preflight duplicates the `--file` probe and send argv in `Invoke-AoSendProbeViaFile`. Static guard `scripts/check-ao-send-transport-contract.ps1` and committed evidence `docs/ao-send-transport-contract.txt` still assert the OLD contract.
- **Invariants (architect brief, preserved):** payload file remains the dispatch-journal record; message content hash / tuple-key claim / dispatch journal semantics unchanged; callers (`invoke-gated-worker-nudge.ps1`, CI-failure/green reconciles) keep their logic — only transport argv changes. **Never** wrap `ao send` in an external wall-clock limiter command.
- **Probe trap:** on 0.10.2, `ao send --help` for unknown subcommands can exit 0 while printing parent help — all capability probes must classify contract availability from **parsed help text**, not process exit code alone.
- **Operator adoption:** none beyond running on an AO 0.10.2 daemon (already the operator target for the 0.10 upgrade track).

```contract-evidence
binding-id: ao:datum:send-message-required
binding: ao send requires --message (message text to deliver)
producer: ao-0-10-cli
binding-type: unstructured
evidence: capture@ao-0-10-cli/send-help
token: --message

binding-id: ao:datum:send-session-required
binding: ao send requires --session (target session id)
producer: ao-0-10-cli
binding-type: unstructured
evidence: capture@ao-0-10-cli/send-help
token: --session

binding-id: ao:datum:send-usage-flags
binding: ao send usage line is ao send [flags] (not [options] with positional session)
producer: ao-0-10-cli
binding-type: unstructured
evidence: capture@ao-0-10-cli/send-help
token: ao send [flags]

binding-id: orchestrator-pack:transport-preflight:help-text-not-exitcode
binding-type: cli-behavior
binding: journaled-worker-send capability preflight decides contract availability from parsed ao send --help text, not from the help probe exit code alone
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
```

## Files in scope

- `scripts/journaled-worker-send.ps1` — transport argv, capability probe, doc comment, oversized-payload predicate, `-NoWait`/wait-budget-seconds mapping
- `scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1` — adoption probe send argv aligned with transport
- `scripts/worker-message-send-adoption-preflight.ps1` — wrapper entry (if argv/probe surface threads through)
- `scripts/check-ao-send-transport-contract.ps1` — live probe + `-ValidateCommitted` flip to NEW contract
- `docs/ao-send-transport-contract.txt` — committed evidence regenerated to 0.10.2 help output
- `scripts/check-ao-dead-argv-bypass.ps1` — send-shaped forbidden patterns only
- `scripts/worker-nudge-gate.test.ts` — bound transport/outcome expectations
- `scripts/worker-message-submit-reconcile.test.ts` — bound transport/outcome expectations
- `tests/external-output-references/captures/ao-0-10-cli/` — send-help capture + manifest entry (if required by contract-evidence guard)

## Files out of scope

- Delivery-confirmation rebuild (`ao events`-based confirm surfaces)
- Review-pipeline vocabulary migration (#625 / draft 212) and broader removed-verb families (`review run|list|send`, `report`, `events`) beyond **send-shaped** dead-argv patterns
- `ao report` protocol, orchestratorRules relocation, Worker-Recovery spawn argv (#217), diagnostics cleanup
- Gate/claim/dedup semantics (`invoke-gated-worker-nudge.ps1` claim/journal logic except unchanged call surface)
- Live `agent-orchestrator.yaml`, `scripts/ao` shim restoration, autonomous-guard admission matrix (#384/#428 capability semantics)

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/ao-send-transport-contract.txt
tests/**
```

## Acceptance criteria

1. **End-to-end transport on AO 0.10.2:** Representative journaled sends (gated nudge path and plain send) build `send --message <payload> --session <id>` (flag names per contract-evidence), invoke succeeds against a 0.10.2-shaped stub or live daemon, and exit without `transport_preflight_failed` / `ao_send_file_unavailable`.

```positive-outcome
asserts: on AO 0.10.2-shaped ao send, journaled-worker-send completes transport with inline --message and --session argv; capability preflight passes; no ao_send_file_unavailable refusal
input: realistic
```

2. **Capability preflight — new contract, still fail-closed:** Probes recognize `--message` and `--session` in parsed `ao send --help` text. When help lacks either flag (stubbed old or broken CLI), transport refuses with a fail-closed outcome and journal reason — decision uses **help text content**, not help exit code alone (probe-trap regression covered).

```producer-emission
producer: orchestrator-pack
datum: transport-preflight
expected: help-text-not-exitcode
proof-command: npx vitest run scripts/worker-message-submit-reconcile.test.ts -t "ao send help probe trap"
red-then-green: pre-draft transport matched --file in help text; after migration the vitest case `ao send help probe trap` (zero-exit help stub lacking --message/--session) must still refuse transport
```

3. **Message fidelity and quoting:** Multiline payloads and shell-significant characters (embedded newlines, leading dashes, spaces, paths) arrive at the worker session intact via `--message` process arguments (tests use realistic payloads, not only single-line ASCII).

4. **Oversized-payload fail-closed:** A payload-size predicate refuses transport before `ao send` when the inline message would exceed a planner-chosen threshold below Linux ARG_MAX (~2 MiB); refusal records a correlatable journal/dispatch outcome (distinct from preflight-missing-contract).

5. **Caller parameter surface compatibility:** `-NoWait` and the wait-budget-seconds parameter remain accepted on `journaled-worker-send.ps1` for existing callers (`invoke-gated-worker-nudge.ps1:315` passes `-NoWait`); mapping onto removed CLI flags is planner-owned and documented only if behavior changes.

6. **Adoption preflight alignment:** `Invoke-WorkerMessageSendAdoptionPreflight` probe sends use the same 0.10.2 argv shape as production transport; no split-brain between adoption probe and journaled send.

7. **Static guards and committed evidence:** `check-ao-send-transport-contract.ps1` passes in default and `-ValidateCommitted` modes asserting the NEW contract (`--message`, `--session`, `ao send [flags]` usage); `docs/ao-send-transport-contract.txt` regenerated; stale `--file` / `[options]` / `Issue #373`-only markers reconciled. `check-ao-dead-argv-bypass.ps1` forbids send-shaped dead argv (`send` with positional session id, `send ... --file`, `send`-scoped `--no-wait` and wait-limit CLI flag) without covering unrelated verb families owned by #625.

8. **Journal / dedup unchanged:** Claim token consumption, message-content-hash, dispatch-journal record shape, and payload-file-as-journal-record behavior are byte-for-byte unchanged aside from transport argv; automated nudge callers need no logic edits.

## Upgrade-safety check

- Pack-owned `scripts/**`, `docs/ao-send-transport-contract.txt`, and bound tests only; no `vendor/**`, `packages/core/**`, or AO core edits.
- Claim/journal/dedup invariants from #384/#373 preserved; only the mechanical `ao send` argv and contract guards move.
- No external wall-clock limiter wrapper around `ao send`.
- CI guards that grep changed prose/argv ship in the **same PR** as the argv change (guard-drift trap).

## Verification

- `pwsh -NoProfile -File scripts/check-ao-send-transport-contract.ps1`
- `pwsh -NoProfile -File scripts/check-ao-send-transport-contract.ps1 -ValidateCommitted`
- `pwsh -NoProfile -File scripts/check-ao-dead-argv-bypass.ps1`
- `npx vitest run scripts/worker-nudge-gate.test.ts`
- `npx vitest run scripts/worker-message-submit-reconcile.test.ts`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/218-journaled-worker-send-0102-argv-cutover.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/218-journaled-worker-send-0102-argv-cutover.md`
- `pwsh -NoProfile -File ./scripts/verify.ps1` green (or cite unrelated blockers)