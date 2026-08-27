# Node 22 TypeScript runtime adoption

Issue #900 makes Node 22 the only supported runtime for live TypeScript entrypoints in CI, operator commands, runtime adapters, plugin CLIs, and supervised children. The Node-below-22 compatibility loader, direct `tsx` launchers, and direct workspace runtime dependencies are removed.

## Canonical version contract

The toolchain-owned source is `scripts/toolchain/node-version.json`. It must contain:

```json
{
  "schemaVersion": 1,
  "nodeMajor": 22
}
```

`package.json` must independently declare `engines.node` as `22.x`. The canonical check reads both files, rejects missing or malformed data, rejects disagreement, and then verifies the installed runtime:

```bash
node --version
npm run check:node-major
```

Expected success resembles:

```text
Node.js 22.x.y satisfies scripts/toolchain/node-version.json (22) and package.json engines.node (22.x).
```

Representative failures are deterministic:

- `OPK_NODE_RUNTIME_VERSION_FILE_MISSING`
- `OPK_NODE_RUNTIME_VERSION_FILE_MALFORMED`
- `OPK_NODE_RUNTIME_ENGINE_DECLARATION_MALFORMED`
- `OPK_NODE_RUNTIME_DECLARATION_DRIFT`
- `OPK_NODE_RUNTIME_DECLARATION_UNSUPPORTED`
- `OPK_NODE_RUNTIME_UNSUPPORTED`
- `OPK_NODE_RUNTIME_MISSING` when the required Node runtime is absent

These failures occur before a TypeScript target or external effect runs. CI jobs and operator processes must inherit Node 22 through their configured environment; live entrypoints do not search a runner toolcache or rewrite `PATH` to hide an unsupported parent runtime.

The former legacy launcher helper is deleted. Current operator and runtime entrypoints invoke native Node 22 TypeScript directly with type stripping and the canonical declaration preflight.

Direct native TypeScript bins and supervised-child entrypoints must begin with a side-effect import of `scripts/toolchain/native-entrypoint-preflight.ts` before business modules. Type-only imports and other forms erased by Node type stripping do not satisfy the runtime policy. Root and workspace npm scripts that execute TypeScript must prove the canonical Node-major check succeeds before every target; reversed ordering, `||`, failure fallbacks, and plugin-local scripts without preflight fail closed. Workflow inspection parses the required YAML step structure with repository-owned code and no new install/runtime dependency, so quoted keys and flow-style `actions/setup-node` steps cannot hide Node 20 or a missing literal `with.node-version: 22/22.x`. The lockfile contains neither a direct nor stale `yaml` package entry. The tracked `AGENTS.md` worker rule applies the same Node 22-only contract to new or changed TypeScript entrypoints, npm scripts, tests, fixtures, and workflow jobs.

## Production-shaped runtime proof

Run the check and one real native TypeScript command from the exact shell, service account, or tmux environment used to start side processes:

```bash
npm run check:node-major
proof_path="${TMPDIR:-/tmp}/opk-node22-adoption-proof.json"
node --experimental-strip-types scripts/json-producers/sanctioned-worker-kill-record.ts add \
  --session-id node22-adoption-proof \
  --path "$proof_path"
cat "$proof_path"
rm -f "$proof_path"
```

Sanitize the captured evidence before attaching it to the PR. Retain the Node version, successful contract-check output, bridge exit status, and JSON shape. Remove usernames, home paths, remotes, tokens, and unrelated environment values. CI is not a substitute for this live-host proof.

## Plugin CLI proof

Plugin bins are native Node 22 TypeScript entrypoints. A non-destructive proof is:

```bash
node --experimental-strip-types plugins/task-declaration/bin/declare.ts --help
```

The command intentionally exits non-zero after printing usage because required business arguments are absent. It must reach the CLI usage path without a loader, `tsx`, or module-resolution error.

## Restart boundary

After installing Node 22 or changing `PATH`, restart every long-lived process that can launch pack TypeScript:

- the wake supervisor and all surviving children;
- managed pack sessions and service wrappers that launch pack TypeScript;
- operator shells, scheduled jobs, and tmux sessions used to start pack commands.

A process started before the `PATH` change can continue resolving an old Node binary even when a fresh interactive shell passes the check.

## Verification after restart

From the side-process environment, repeat:

```bash
npm run check:node-major
node --experimental-strip-types scripts/pack-review-runner.ts help
node --experimental-strip-types plugins/task-declaration/bin/declare.ts --help
```

Then exercise the production-shaped native TypeScript command above.

## Native module-resolution policy

Live TypeScript modules use explicit relative `.ts`, `.mts`, or `.cts` source specifiers. A relative `.js`/`.mjs`/`.cjs` specifier is valid only when that literal runtime file exists. Public workspace package `.js` subpaths are valid only when the package `exports` map explicitly points the subpath to TypeScript source. The policy guard rejects loader-dependent `.js` to `.ts` substitution.

## Rollback

Emergency rollback is one revert of the Issue #900 PR. The revert restores the prior compatibility loader, direct runtime launchers/dependencies, workflow runtime pins, compiler/import policy, and bridge branch together. Do not reconstruct only part of the old loader path, mix Node majors, or add emitted JavaScript artifacts.
