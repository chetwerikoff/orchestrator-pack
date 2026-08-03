# Runtime boundary

The pack runtime boundary is defined in `scripts/runtime/contracts.ts`. It contains
runtime-neutral inputs and closed results only. Adapter selection is a static
composition root in `scripts/orca-runtime/composition-root.ts`:

- default adapter: `orca`;
- optional explicit setting: `OPK_RUNTIME_ADAPTER=orca`;
- unknown or unavailable adapters fail before an operation can produce effects;
- one selected factory is instantiated; there is no auto-detection, fallback,
  dual execution, hot switching, or cross-runtime adoption.

The Orca implementation lives in `scripts/orca-runtime/**`. Native CLI arguments,
terminal handles, response fields, errors, and native cursors are parsed there.
`scripts/lib/orca-cli.ts` remains temporarily as a compatibility facade for the
working smoke path while Issue #1248 migrates callers to the shared interface.

## Shared semantics

- Worker identity: opaque `id` plus opaque `generation`.
- Provenance: `internal` or `external`; external discovery grants no ownership.
- Liveness: exactly `busy | idle | gone | unknown`, bounded by the caller-provided
  observation window.
- Dispatch: exactly `dispatched | send_failed | dispatch_unknown`, one attempt.
- Bounded output: lines, opaque observation token, and a caller-visible `changed`
  conclusion. Restart invalidates prior-generation tokens.
- Unsupported native response drift fails closed with `unsupported`.

A deterministic adapter can satisfy the same `RuntimeAdapter` contract in caller
tests. Adding a future production adapter requires only its implementation, a
static composition-root entry, focused contract tests, and documentation.
