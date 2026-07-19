# Node 22 TypeScript runtime adoption

Issue #900 makes Node 22 the only supported runtime for the repository-owned native TypeScript toolchain and PowerShell-to-TypeScript bridge. The retired Node-below-22 compatibility loader and its version-dependent bridge branch are gone.

`package.json` `engines.node` is the canonical version declaration. The earlier plan expected #840 to add a separate `.nvmrc` or `.node-version`, but #840 was superseded by the #906/#907 estate cut and no canonical version file landed. This PR therefore does not introduce a second declaration that can drift.

## Before adoption

Install Node 22 on the operator host and make sure the same `PATH` is inherited by the shell or service account that starts pack side processes. From the trusted pack checkout, run:

```bash
node --version
npm run check:node-major
```

Expected success resembles:

```text
Node.js 22.x.y satisfies package.json engines.node (22.x).
```

An unsupported host fails before a TypeScript target runs, with `OPK_NODE_RUNTIME_UNSUPPORTED`. Missing or malformed declarations use `OPK_NODE_RUNTIME_DECLARATION_*`; an absent executable from a PowerShell bridge uses `OPK_NODE_RUNTIME_MISSING`.

## Production-shaped bridge proof

Run the check and one real bridge from the same shell and environment used to start side processes:

```powershell
npm run check:node-major
$proofPath = Join-Path ([System.IO.Path]::GetTempPath()) 'opk-node22-adoption-proof.json'
pwsh -NoProfile -File ./scripts/record-sanctioned-worker-kill.ps1 `
  -SessionId 'node22-adoption-proof' `
  -Path $proofPath
Get-Content -Raw -LiteralPath $proofPath
Remove-Item -Force -LiteralPath $proofPath
```

Sanitize the captured evidence before attaching it to the PR. Retain the Node version, successful contract-check output, bridge exit status, and JSON shape; remove usernames, home paths, repository remotes, and unrelated environment values. CI evidence is not a substitute for this live-host proof.

## Restart boundary

After the Node 22 `PATH` is installed, restart every long-lived process that can launch pack TypeScript:

- the wake supervisor and all surviving children;
- AO daemon/project sessions or service wrappers that inherited the old `PATH`;
- operator shells, scheduled jobs, and tmux sessions used to start pack commands.

A process started before the `PATH` change can continue resolving an old Node binary even when a fresh interactive shell passes the check.

## Verification after restart

From the side-process environment, repeat:

```bash
npm run check:node-major
node --experimental-strip-types scripts/pack-review-runner.ts help
```

Then exercise the production-shaped PowerShell bridge above. Do not claim adoption complete from GitHub Actions alone.

## Frozen legacy launcher debt

The post-#907 tree still contains pre-existing `tsx` launchers and plugin-local `tsx` dependencies outside Issue #900's allowed toolchain roots. This PR does not pretend those unrelated review/scope-guard surfaces were migrated. The launch inventory freezes each existing line by exact path, line, and evidence, freezes each existing runtime dependency by package manifest, rejects additions or movement, and requires stale entries to be removed when an owning migration retires the debt.

For repository-owned toolchain entrypoints and `Invoke-TypeScriptCli.ps1`, there is one supported production path: Node 22 native type stripping. New custom loaders, `tsx`, `ts-node`, unpreflighted direct `.ts` launches, and Node-major machinery branches fail the policy guard.

## Rollback

Emergency rollback is one revert of the Issue #900 PR. That revert restores the deleted compatibility loader, the Node-major branch in `Invoke-TypeScriptCli.ps1`, the prior compiler policy, and the former npm launch contract together. Do not reconstruct a partial loader path by hand, add a new runtime dependency, or commit emitted JavaScript artifacts.
