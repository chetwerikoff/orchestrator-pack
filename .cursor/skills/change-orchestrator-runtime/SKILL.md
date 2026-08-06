---
name: change-orchestrator-runtime
description: >-
  Change the registered concrete runtime adapter or its explicit operator-owned
  configuration while preserving runtime-neutral business logic. Use only when
  the user explicitly requests a runtime implementation change.
---

# Change registered runtime adapter

1. Read `AGENTS.md`, the live task Issue, `scripts/runtime/contracts.ts`, and
   `scripts/runtime/registry.ts`.
2. Keep business logic dependent only on `RuntimeAdapter` and exact
   `{ runtime, id, generation }` identities.
3. Change only the concrete registration or explicit operator-owned input named by
   the task. Do not add aliases, implicit discovery, dual execution, fallback
   transport, state conversion, or a second selector.
4. Do not mutate user-machine configuration, managed sessions, services, caches,
   credentials, or generated state unless the direct user explicitly orders that
   exact host-side action.
5. Run the focused adapter and deterministic lifecycle tests, runtime-retirement
   scan, typecheck, policy lint, repository verification, and required current-head
   CI.
6. Document any real operator adoption in `docs/migration_notes.md` and the PR body.
   Never claim that a source change has taken effect on a live host without direct
   read-back evidence.
