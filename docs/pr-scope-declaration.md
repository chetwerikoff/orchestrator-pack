# AO-free PR scope declarations

The AO-free declaration producer produces the only schema accepted by
`scripts/pr-scope-check.ts`. It writes declarations only for a selected target
whose authoritative PR-base/default workflow configuration enables the pack PR
scope guard; actual per-head CI execution is separate. It reads Issue fences and
writes under `docs/declarations/` only in configured guard-enabled mode.

```bash
npm run check:node-major --silent && node --experimental-strip-types scripts/pr-scope-declaration.ts --issue 1210 --declared-paths scripts/pr-scope-check.ts,scripts/pr-scope-declaration.ts --declared-prefixes 'scripts/pr-scope-tests/**'
```

The resulting `docs/declarations/<issue>.pr-scope.json` is canonical JSON:
repository-relative paths use `/`, `.` segments are collapsed, `..` cannot
escape the repository, arrays are sorted, and duplicates are rejected.
Directory prefixes are explicit terminal `/**` entries. Both `declared_paths`
and `denylist` may also contain exactly one `*` as the final character of
the final filename segment, after a nonempty literal prefix. For example,
`scripts/fixture.*` is valid in `declared_paths`, while `.env*`, `.env.*`,
and `secrets/key*` are valid in `denylist`. A denylist filename suffix
pattern only adds prohibitions; it never grants an editable path.
`allowed_roots` remains literal or terminal `/**` only: even `src/*.py`
or `scripts/foo*.test.ts` must be rejected, along with nested globstars like
`plugins/**/tests/*.test.ts`. Bare `*`, `*.ts`, infix or multiple
stars, `secrets/*.pem` (nonterminal filename star), leading `**/`,
`?`, bracket/brace/extglob, and stars in directory segments are unsupported
in every field. Concrete changed paths cannot contain wildcard syntax. The artifact
may add denials or narrow roots, but cannot weaken the repository policy.
Root-level `.env.*` is not inside the pack's allowed-root ceiling, and matching
a pathname never authorizes committing secret-bearing content.

## Issue-author convention for declaration-required PRs

This document belongs to the **pack repository** (`chetwerikoff/orchestrator-pack`); a
reviewed target repository need not contain a local copy. Applicability comes from
the selected target's authoritative existing PR base/default-branch workflow
configuration: an enabled workflow eligible for normal `pull_request` opened and
synchronize events must define an active `pr-scope-guard` job invoking the pack
scope runner/check. A same-named inert workflow is not sufficient. Actual CI
execution or pass/fail for a particular PR head is separate evidence and never
determines producer applicability.

For a configured guard-enabled target, the unique valid selected default
`docs/declarations/<N>.pr-scope.json` is in scope by default as a generated-only
control artifact. It needs no Files-in-scope enumeration, Files-out-of-scope
exception, or additional `allowed-roots` entry. Files in scope and `allowed-roots`
enumerate editable implementation files only. Generic Files-out-of-scope catch-alls
apply after implicitly including this default artifact; a one-editable-file limit
means one editable file plus the generated artifact. A specific live-Issue
prohibition of the selected exact path, `docs/declarations/**` or `docs/**`, an
intersecting `denylist`, or an AC literally capping all changed PR paths requires
Issue-owner correction; this convention does not override it.

The default `<N>.pr-scope.json` path is the authoring convention, not a new selector
constraint. The existing selector accepts one valid current-Issue `<N>.<suffix>`
candidate under `docs/declarations/`; a nondefault path needs explicit live-Issue
authorization. Authors/workers use the canonical producer and never hand-edit its
output. `source_revision` is informational, not proof of provenance or freshness.

For a confirmed guard-free target, the producer prints exactly
`no PR scope guard in <repo>; the Issue fences are the scope`, exits successfully,
and returns before Issue retrieval/parsing or any declaration read/write. Neither
reviewer reports declaration-only or imagined missing-guard-CI findings merely
because a declaration is absent, present, malformed, noncanonical, or outdated.
The complete live Issue and actual changed paths remain authoritative: changed
historical declaration/control paths are checked like every other changed path; an
untouched stale artifact alone is irrelevant. Unresolved configuration is
unverified, never inferred as guard-free.

In configured guard-enabled mode, `checkDeclarationPaths` skips only the selected
declaration before denylist/root checks; all other changed paths remain checked.
The skip cannot cure a specific Issue prohibition, literal total-PR-path cap, or
matching `denylist`. Review uses the full live Issue, current PR/head and diff,
candidate content, and observed current-head guard evidence if available. Missing
or invalid required selection fails closed. Existing bootstrap and markdown-only/
no-ceremony modes remain unchanged.

For configured guard-enabled targets, the required check obtains the PR diff from the verified merge base and PR head:

```text
git diff --name-status --find-renames <merge_base_sha> <head_sha>
```

Adds, modifications, and deletions check their affected path. Copies check the
destination; renames check both endpoints. Exactly one valid current-Issue
artifact is selected. Every other current-Issue file, malformed artifact,
unsupported/AO-era schema, wrong-Issue candidate, ambiguous candidate, or
uncertain diff fails closed. The remediation is a fresh declaration and a new
PR; no legacy projection or fallback is attempted.
