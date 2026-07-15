# Gate runner Wave 3.a

Issue #830 introduces the TypeScript gate-runner core without changing CI workflow ownership or attempting the bulk gate migration.

## Contract

Gate execution terminates as `PASS`, `FAIL`, or `SKIP`. Required evidence is classified as static source, capture schema, fixture, or live adoption. Missing or unreachable required evidence is never treated as a pass; it produces `SKIP` with diagnostics.

The declarative surface supports grep inventories, line/byte budgets, file-presence assertions, and static-source assertions. Bespoke checks remain custom modules behind the same result and evidence contract.

## Representative migration

Wave 3.a ports the AGENTS.md live-reference inventory, AGENTS.md size budget, moved-content presence/source assertions, and the vestigial fleet-child retirement check. Pre-delete outcomes and diagnostics are preserved under `scripts/gate-runner/goldens/`.

The former quote-only `orchestratorRules` check is retired rather than ported because it inspected legacy reference material without proving current AO behavior. That disposition is explicit in the golden capture and migration notes.

## Census and dispatch

The frozen pre-change census contains 283 enforcement surfaces: 117 standalone `scripts/check-*.ps1` files, 98 script-dispatch members in `scripts/verify.ps1`, 59 inline `verify.ps1` members, and 9 reusable-check behaviors. Structural discovery fails closed when members disappear or appear without a census update.

`scripts/verify.ps1` owns one gate-runner dispatch. CI workflow changes, broad gate ports, vendor surfaces, core runtime changes, and agent declaration changes remain outside this wave.
