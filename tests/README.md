# orchestrator-pack tests

Polyglot contract tests for declaration, scope, parser, and script surfaces.
No Agent Orchestrator (AO) runtime is required.

## Layout

| Track | Runner | Location |
|-------|--------|----------|
| TypeScript plugins + `_shared` | [Vitest](https://vitest.dev/) | `plugins/<name>/tests/**/*.test.ts` |
| PowerShell scripts | [Pester](https://pester.dev/) | `tests/powershell/**/*.Tests.ps1` |

Shared contracts live in `plugins/_shared/lib/` and are consumed by future
plugins (#4–#6).

## Run all tests

From the repository root:

```powershell
.\scripts\test-all.ps1
```

This runs the Vitest track (`npm test`) and the Pester track. Either failure
causes a non-zero exit code.

First run installs Node dependencies via `npm ci --include=dev` when `node_modules/` is absent (dev deps are required for Vitest).

## Run a single plugin's TypeScript tests

```powershell
npm test -- plugins/_shared/tests
```

Or filter by name:

```powershell
npx vitest run plugins/_shared/tests/normalize.test.ts
```

When a plugin workspace exists (e.g. after #4):

```powershell
npm test --workspace=plugins/ao-task-declaration
```

## Run PowerShell tests only

```powershell
.\scripts\test-all.ps1 -SkipNpm
```

Or invoke Pester directly:

```powershell
Invoke-Pester -Path tests/powershell
```

## Add tests for a new plugin

1. Add `plugins/<plugin-name>/package.json` as an npm workspace member (root
   `package.json` uses `"workspaces": ["plugins/*"]`).
2. Create `plugins/<plugin-name>/tests/*.test.ts`.
3. Import shared helpers from `@orchestrator-pack/shared` or relative paths under
   `plugins/_shared/lib/`.
4. Run `.\scripts\test-all.ps1` before opening a PR.

## Add tests for a PowerShell script

1. Add `tests/powershell/<ScriptName>.Tests.ps1`.
2. Dot-source or invoke the script under test from the Pester `Describe` block.
3. Run `.\scripts\test-all.ps1` or `Invoke-Pester -Path tests/powershell`.

## Contract surfaces covered initially

- **Issue body parser** — fenced `denylist` (mandatory) and `allowed-roots`
  (optional) blocks per `docs/issues_drafts/00-architecture-decisions.md`.
- **Path normalization** — rejects `..`, drive letters, absolute paths, and
  backslashes.
- **Declaration schema** — validates committed snapshot JSON metadata.
- **Synthetic git fixtures** — `createSyntheticGitRepo()` for future
  scope-guard integration tests without AO.
- **Runner smoke** — Pester checks that `scripts/test-all.ps1` exists and
  exposes the expected parameters.

## Out of scope

- AO end-to-end or live `ao` session tests
- Changes under `vendor/**` or `packages/core/**`
- Real GitHub API calls in unit tests (use fixtures instead)
