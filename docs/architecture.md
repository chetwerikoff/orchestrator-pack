# Architecture

## Principle

`orchestrator-pack` is an upgrade-safe extension layer around upstream Agent
Orchestrator. AO owns project/session lifecycle primitives. Pack behavior is implemented
through tracked worker rules, prompts, local stores, scripts, plugins, and CI; upstream AO
core is never patched.

## Sources of truth

- GitHub Issues: live task queue and acceptance contract.
- GitHub PR and commit checks: current head, mergeability, review artifacts, and CI.
- `AGENTS.md`: worker policy.
- supported AO 0.10.3 ProjectConfig fields: live AO configuration.
- pack worker-report/status stores: worker lifecycle and handoff.
- `docs/pack-review-runbook.md`: complete current pack-review contract.
- pack review-run store and current GitHub head/status: current review evidence.

`agent-orchestrator.yaml.example` is a legacy-import example / migration fixture, not a
live policy source.

## Extension layers

- **Worker policy:** tracked `AGENTS.md`; recycle affected worker sessions after merge.
- **Review:** `scripts/pack-review-runner.ts` with
  `scripts/invoke-pack-review.ps1`; selected by `PACK_REVIEWER`.
- **Binding and state:** local pack stores under the wake-supervisor state root.
- **Scripts:** TypeScript/Node for new implementations; PowerShell remains only where
  already established or specifically justified.
- **Plugins and prompts:** reusable contracts outside AO core.
- **CI:** validates repository and runtime invariants; documentation wording is not a
  runtime contract.

## Review paths

PR review is pack-owned. AO review HTTP API, `ao review submit`, and project reviewer
configuration remain available upstream in AO 0.10.3, but this pack does not use them as
invocation, status, delivery, fallback, dual-write, or merge-authority paths.

The complete current architecture and operator procedure is
[`pack-review-runbook.md`](pack-review-runbook.md). This document intentionally does not
repeat trigger semantics, exact-head rules, delivery ordering, resume behavior, reviewer
switching, binding resolution, or merge authority.

The AO Reviews Board and daemon producer documents are historical prototypes. Their code
may remain for compatibility tests, but their state is not current pack-review evidence.

## Worker status and handoff

Workers report through pack-owned worker-report/status stores. GitHub remains PR/head
truth. AO session data may confirm identity, role, and liveness, but does not replace the
durable pack PR ↔ session binding cache.

## Safety invariants

- no upstream core modification;
- no trusted control code sourced from the reviewed worktree;
- fail-closed ambiguous or corrupt state;
- no AO-managed worker merge;
- no automatic merge;
- live pack review does not invoke AO Reviews;
- current-head evidence is required for decisions.
