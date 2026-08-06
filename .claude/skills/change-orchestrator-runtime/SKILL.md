---
name: change-orchestrator-runtime
description: >-
  Change the registered concrete runtime adapter or its explicit operator-owned
  configuration while preserving runtime-neutral business logic. Use only when
  the user explicitly requests a runtime implementation change.
---

# Change registered runtime adapter

Use this skill only for an explicit request to change the concrete runtime
implementation, its registered selection, or a named operator-owned input.

## Contract

- Read `AGENTS.md`, the live task Issue, `scripts/runtime/contracts.ts`, and
  `scripts/runtime/registry.ts` before editing.
- Keep business logic dependent only on `RuntimeAdapter` and exact
  `{ runtime, id, generation }` identities.
- The registry owns concrete adapter selection. Do not import the concrete adapter
  into business logic.
- Do not add aliases, implicit discovery, dual execution, fallback transport,
  state conversion, a second selector, or a new daemon, queue, watcher, lease, or
  retry subsystem.
- Do not mutate user-machine configuration, managed sessions, services, caches,
  credentials, or generated state unless the direct user explicitly orders that
  exact host-side action.

## Procedure

1. Resolve the exact current repository, branch, Issue, PR head, and requested
   runtime change.
2. Inspect the current adapter contracts, registry, concrete implementation,
   callers, focused tests, and operator adoption documentation.
3. State the smallest change that preserves the neutral boundary and exact identity
   semantics.
4. Edit only declared paths. Keep operator-owned inputs explicit and validated.
5. Run focused adapter tests, deterministic lifecycle proofs, runtime-retirement
   scan, Node 22 typecheck and lint, repository verification, and required CI for
   the current head.
6. Update `docs/migration_notes.md` and the PR `## Operator adoption` section when
   an operator must recycle a process, update an explicit input, or verify a live
   binding after merge.
7. Read back the committed files and current PR head. Never claim the new runtime
   is active on a host without direct host-side evidence.

## Completion

Report the changed registration or input, exact verification performed, current
head SHA, operator action still required, and any check that could not be executed.
Do not merge unless the direct user orders it.
