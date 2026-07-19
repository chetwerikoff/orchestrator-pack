# Node 22 TypeScript runtime adoption

Issue #900 makes Node 22 the only supported runtime for live TypeScript entrypoints in CI, operator commands, PowerShell bridges, plugin CLIs, and supervised children. The Node-below-22 compatibility loader, direct `tsx` launchers, and direct workspace runtime dependencies are removed.

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
- `OPK_NODE_RUNTIME_MISSING` from a PowerShell bridge when `node` is absent

These failures occur before a TypeScript target or external effect runs. CI jobs and operator processes must inherit Node 22 through their configured environment; the bridge does not search a runner toolcache or rewrite `PATH` to hide an unsupported parent runtime.

## Production-shaped bridge proof

Run the check and one real bridge from the exact shell, service account, or tmux environment used to start side processes:

```powershell
npm run check:node-major
$proofPath = Join-Path ([System.IO.Path]::GetTempPath()) 'opk-node22-adoption-proof.json'
pwsh -NoProfile -File ./scripts/record-sanctioned-worker-kill.ps1 `
  -SessionId 'node22-adoption-proof' `
  -Path $proofPath
Get-Content -Raw -LiteralPath $proofPath
Remove-Item -Force -LiteralPath $proofPath
```

Sanitize the captured evidence before attaching it to the PR. Retain the Node version, successful contract-check output, bridge exit status, and JSON shape. Remove usernames, home paths, remotes, tokens, and unrelated environment values. CI is not a substitute for this live-host proof.

## Plugin CLI proof

Plugin bins are native Node 22 TypeScript entrypoints. A non-destructive proof is:

```bash
node --experimental-strip-types plugins/ao-task-declaration/bin/declare.ts --help
```

The command intentionally exits non-zero after printing usage because required business arguments are absent. It must reach the CLI usage path without a loader, `tsx`, or module-resolution error.

## Restart boundary

After installing Node 22 or changing `PATH`, restart every long-lived process that can launch pack TypeScript:

- the wake supervisor and all surviving children;
- AO daemon/project sessions and service wrappers;
- operator shells, scheduled jobs, and tmux sessions used to start pack commands.

A process started before the `PATH` change can continue resolving an old Node binary even when a fresh interactive shell passes the check.

## Verification after restart

From the side-process environment, repeat:

```bash
npm run check:node-major
node --experimental-strip-types scripts/pack-review-runner.ts help
node --experimental-strip-types plugins/ao-task-declaration/bin/declare.ts --help
```

Then exercise the production-shaped PowerShell bridge above.

## Native module-resolution policy

Live TypeScript modules use explicit relative `.ts`, `.mts`, or `.cts` source specifiers. A relative `.js`/`.mjs`/`.cjs` specifier is valid only when that literal runtime file exists. Public workspace package `.js` subpaths are valid only when the package `exports` map explicitly points the subpath to TypeScript source. The policy guard rejects loader-dependent `.js` to `.ts` substitution.

## Rollback

Emergency rollback is one revert of the Issue #900 PR. The revert restores the prior compatibility loader, direct runtime launchers/dependencies, workflow runtime pins, compiler/import policy, and bridge branch together. Do not reconstruct only part of the old loader path, mix Node majors, or add emitted JavaScript artifacts.