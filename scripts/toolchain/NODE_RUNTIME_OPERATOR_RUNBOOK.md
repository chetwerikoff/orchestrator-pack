# Single-major Node/npm runtime adoption

The pack supports exactly one Node major and one npm major at a time. The only
runtime-major authority is `scripts/toolchain/node-version.json`; live runtime
gates, tests, policy, and operator guidance derive from that declaration instead
of owning a numeric major.

## Canonical version contract

The toolchain-owned declaration must contain schema version 1 plus positive
integer `nodeMajor` and `npmMajor` fields. `package.json.engines.node`,
`package.json.engines.npm`, the mise Node selection, and workflow Node
selection are declarative mirrors and must stay aligned with that authority.

Verify the active tools before installing or running pack code:

```bash
node --version
npm --version
node scripts/toolchain/check-node-major.mjs
node scripts/toolchain/check-npm-major.mjs
```

The canonical checks reject missing or malformed authority data, mirror drift,
and an installed runtime whose major differs from the declaration. Those
failures occur before TypeScript business modules or external effects run.

## Native TypeScript policy

Current operator and runtime entrypoints invoke native Node TypeScript with
`--experimental-strip-types` and the canonical declaration preflight. Direct
native TypeScript bins and supervised-child entrypoints begin with the
side-effect import of
`scripts/toolchain/native-entrypoint-preflight.ts` before business modules.

Root and workspace npm scripts that execute TypeScript must prove the canonical
Node-major preflight succeeds before every target. Reversed ordering, failure
fallbacks, custom loaders, `tsx`, and `ts-node` are not supported runtime
routes. Workflow `actions/setup-node` declarations are checked against the
same authority-bound mirror contract.

## Production-shaped runtime proof

Run the canonical check and one real native TypeScript command from the exact
shell, service account, or tmux environment used to launch pack processes:

```bash
node --version
node scripts/toolchain/check-node-major.mjs
proof_path="${TMPDIR:-/tmp}/opk-runtime-adoption-proof.json"
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/json-producers/sanctioned-worker-kill-record.ts -- \
  add --session-id runtime-adoption-proof --path "$proof_path"
cat "$proof_path"
rm -f "$proof_path"
```

Verify npm separately in an environment intended to install or run repository
npm commands:

```bash
npm --version
node scripts/toolchain/check-npm-major.mjs
```

Sanitize captured evidence before attaching it to a PR. Retain runtime versions,
canonical-check results, command exit status, and required JSON shape; remove
usernames, home paths, remotes, tokens, and unrelated environment values.

## Plugin CLI proof

A non-destructive native TypeScript plugin proof is:

```bash
node --experimental-strip-types plugins/task-declaration/bin/declare.ts --help
```

The command may exit non-zero because required business arguments are absent. It
must reach the CLI usage path without runtime-admission, loader, or
module-resolution failure.

## Restart boundary

After changing the supported runtime or executable `PATH`, restart every
long-lived process that can launch pack TypeScript:

- the wake supervisor and all surviving children;
- managed pack sessions and service wrappers;
- operator shells, scheduled jobs, and tmux/Orca panes used to start pack commands.

A process started before the `PATH` change can retain an old executable even
when a fresh shell passes the canonical check. Where existing status surfaces
record PID/start identity, capture them before restart and prove those old
identities are gone afterward.

## Verification after restart

From each supported fresh launcher environment, repeat:

```bash
node --version
node scripts/toolchain/check-node-major.mjs
node --experimental-strip-types scripts/pack-review-runner.ts help
node --experimental-strip-types plugins/task-declaration/bin/declare.ts --help
```

Then exercise the production-shaped command above. Do not infer a per-process
Node version when the existing status surface does not expose one.

## Native module-resolution policy

Live TypeScript modules use explicit relative `.ts`, `.mts`, or `.cts`
source specifiers. A relative `.js`, `.mjs`, or `.cjs` specifier is valid
only when that literal runtime file exists. Public workspace package JavaScript
subpaths are valid only when the package exports map explicitly points the
subpath to TypeScript source. The policy guard rejects loader-dependent
JavaScript-to-TypeScript substitution.

## Rollback

Repository rollback is one revert of the runtime migration PR together with the
coordinated restoration of any required-check name changed by that migration.
Operational rollback must restore the executable/PATH selection expected by the
reverted canonical declaration before restarting long-lived pack processes.
After restart, rerun the direct Node-major check and a real native TypeScript
command from each supported launcher environment. Do not operate a mixed-major
fleet or add a fallback runtime path.
