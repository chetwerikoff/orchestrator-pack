# AO-free PR scope declarations

The AO-free declaration producer produces the only schema accepted by
`scripts/pr-scope-check.ts`. It reads the linked Issue's `denylist` and
`allowed-roots` fences, writes one artifact under `docs/declarations/`, and
does not use AO state or session metadata.

```bash
npm run check:node-major --silent && node --experimental-strip-types scripts/pr-scope-declaration.ts --issue 1210 --declared-paths scripts/pr-scope-check.ts,scripts/pr-scope-declaration.ts --declared-prefixes 'scripts/pr-scope-tests/**'
```

The resulting `docs/declarations/<issue>.pr-scope.json` is canonical JSON:
repository-relative paths use `/`, `.` segments are collapsed, `..` cannot
escape the repository, arrays are sorted, and duplicates are rejected.
Directory prefixes are explicit terminal `/**` entries. Only `declared_paths` may also
contain one `*` at the end of the final filename segment, after a nonempty
literal prefix (for example `scripts/fixture.*` or `.env.*`). The matching
filename must stay in that segment; bare `*`, `*.ts`, infix or multiple stars,
`?`, bracket/brace/extglob and multi-segment globs are unsupported. Artifact
`allowed_roots` and `denylist` keep their literal-or-terminal-directory-prefix
grammar; concrete changed paths cannot contain wildcard syntax. The artifact
may add denials or narrow roots, but cannot weaken the repository policy.
Root-level `.env.*` is not inside the pack's allowed-root ceiling, and matching
a pathname never authorizes committing secret-bearing content.

## Issue-author convention for declaration-required PRs

This document belongs to the **pack repository** (`chetwerikoff/orchestrator-pack`); a
reviewed target repository need not contain a local copy. For an ordinary Issue-linked PR requiring a declaration, the **unique valid
selected default** `docs/declarations/<N>.pr-scope.json` is in scope by
default as a generated-only control artifact. It needs **no** Files-in-scope
enumeration, Files-out-of-scope exception, or additional `allowed-roots` entry.
Files in scope and `allowed-roots` enumerate editable implementation files
only. Interpret generic Files-out-of-scope catch-alls such as "all other files"
or "all paths not listed" **after** implicitly including this default artifact;
those catch-alls do not specifically prohibit it. A one-editable-file limit
means one editable file plus the generated artifact, not one changed PR path in
total. A **specific** live-Issue prohibition of the selected exact path,
`docs/declarations/**` or `docs/**`, an intersecting Issue `denylist`, or
an AC literally capping **all changed PR paths** requires Issue-owner
correction; the default convention does not override it.

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
all other changed paths remain checked. That skip cannot cure a **specific** live-Issue prohibition of the selected
artifact, a literal total-PR-path cap, or a matching `denylist`: reviewers
report the conflict even when the current-head scope guard says PASS, and the
Issue owner corrects it. A generic unlisted-files catch-all is not a specific
prohibition. A properly selected default artifact is not a scope violation
because it is absent from Files in scope, editable `allowed_roots`, or an
editable-file count. Scope review uses the full live Issue and its acceptance criteria, the
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
