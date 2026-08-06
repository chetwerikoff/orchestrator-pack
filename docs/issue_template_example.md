# First AO scoped task

Prove task declaration and scope guarding in this repository.

## Goal

Add a small, scoped change under declared paths only.

## Binding surface

Declared paths are recorded by `pack-declare`, not in this issue body.

## Denylist

```denylist
vendor/**
packages/core/**
.orchestrator-pack/**
```

## Allowed roots

Optional upper bound on paths that `pack-declare` may include.

```allowed-roots
src/**
docs/**
scripts/**
.github/workflows/**
```

## Acceptance criteria

- [ ] Run `pack-declare --issue <n>` and commit the snapshot under
      `docs/declarations/`.
- [ ] Scope-guard blocks edits outside the declared snapshot.
- [ ] PR links back to this issue with `Closes #<n>`.

## Verification

```powershell
npm ci --include=dev
npx pack-declare --issue <n> --declared-paths src/example.ts
node --experimental-strip-types plugins/scope-guard/bin/scope-check.ts --issue <n> --mode worktree
```
