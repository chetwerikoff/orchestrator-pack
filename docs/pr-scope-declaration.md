# AO-free PR scope declarations

The AO-free declaration producer produces the only schema accepted by
`scripts/pr-scope-check.ps1`. It reads the linked Issue's `denylist` and
`allowed-roots` fences, writes one artifact under `docs/declarations/`, and
does not use AO state or session metadata.

```bash
npm run check:node-major --silent && node --experimental-strip-types scripts/pr-scope-declaration.ts --issue 1210 --declared-paths scripts/pr-scope-check.ts,scripts/pr-scope-declaration.ts --declared-prefixes 'scripts/pr-scope-tests/**'
```

The resulting `docs/declarations/<issue>.pr-scope.json` is canonical JSON:
repository-relative paths use `/`, `.` segments are collapsed, `..` cannot
escape the repository, arrays are sorted, and duplicates are rejected.
Directory prefixes are explicit terminal `/**` entries. The artifact may add
denials or narrow roots, but cannot weaken the repository policy.

## Issue-author convention for declaration-required PRs

This document belongs to the **pack repository** (`chetwerikoff/orchestrator-pack`); a
reviewed target repository need not contain a local copy. For an ordinary Issue-linked
PR that requires a declaration, the Issue author explicitly lists the default
`docs/declarations/<N>.pr-scope.json` for that Issue number in **Files in scope** as
a *generated-only control artifact* and excepts that exact file in **Files out of
scope**, including under any broad `docs/**` exclusion. Keep it separate from
editable implementation files: only those editable paths belong in
`allowed-roots`, and the Issue `denylist` must not match the artifact. An
implementation one-file limit means **one editable implementation file plus the
generated control artifact**, not one changed PR path in total. An existing
explicit artifact prohibition, intersecting Issue denylist, or literal total-diff
path limit requires an Issue-owner amendment; this convention does not silently
override a live Issue.

The **default** `<N>.pr-scope.json` path is the authoring convention, not a new
selector constraint. The existing `selectDeclarationArtifact` also accepts a
unique valid current-Issue `<N>.<suffix>` candidate under `docs/declarations/`;
the producer supports `--output` there. A nondefault selected path needs
explicit authorization in the live Issue, but is not rejected by the guard
merely for having another suffix. Authors/workers use the canonical
`scripts/pr-scope-declaration.ts` generator and never hand-edit its output.
Validation cannot distinguish byte-identical hand-written valid JSON from
generator output; `source_revision` is informational, not a provenance or
freshness witness.

The unchanged `scripts/pr-scope-check.ts::checkDeclarationPaths` skips the
single selected declaration **before** changed-path denylist and root checks;
all other changed paths remain checked. That skip cannot cure a contradictory
live-Issue Files out of scope rule, total-path acceptance criterion, or
`denylist` matching the selected artifact: reviewers report the conflict even
when the current-head scope guard says PASS, and the Issue owner corrects it.
A properly permitted selected default control artifact is not a scope
violation solely for omission from editable `allowed-roots` or an editable-file
count. Scope review uses the full live Issue and its acceptance criteria, the
actual current PR/head and diff, exact declaration candidate path/content, and
observed current-head scope-guard evidence if available. An injected legacy
snapshot, a generator claim, or `source_revision` proves neither v1 selection
nor a guard PASS. Missing/invalid selection fails closed in declaration-required
mode; the existing narrowly bound `scope-guard-bootstrap/v1` declaration-free
live-Issue mode and Issue-linked markdown-only/no-ceremony boundary remain
unchanged.

The required check obtains the PR diff from the verified merge base and PR head:

```text
git diff --name-status --find-renames <merge_base_sha> <head_sha>
```

Adds, modifications, and deletions check their affected path. Copies check the
destination; renames check both endpoints. Exactly one valid current-Issue
artifact is selected. Every other current-Issue file, malformed artifact,
unsupported/AO-era schema, wrong-Issue candidate, ambiguous candidate, or
uncertain diff fails closed. The remediation is a fresh declaration and a new
PR; no legacy projection or fallback is attempted.
